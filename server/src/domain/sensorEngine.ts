// Pure replay of one sensor's lifecycle. See docs/DESIGN.md section 7.
//
// The sensor is replayed from registration to `input.now` using everything known now.
// Live updates, timers, late data and corrections are all "replay again and compare".
// No database, no clock, no I/O: the same input always gives the same result.

import { settingsAt } from '../config';
import { DAY, dayStart, nextDayStart } from '../time';
import type {
  Lifecycle, LifecycleTransition, ReplayInput, ReplayResult, SensorCoverage,
} from '../types';
import {
  buildContext, classifyDay, collectionAt, collectionSince, coverageAt, hasCheckBetween,
  hasUnresolvedBetween, timeDrivenChecksAfterNow, type Ctx,
} from './sensorEngineHelpers';

/** A dormant wait or a sampling window, measured in available time. */
interface Timer {
  kind: 'dormant_wait' | 'sampling_window';
  /** Available time still to run, as of `runningSince` (or in total while paused). */
  remainingMs: number;
  /** When the timer last started running; null while paused. */
  runningSince: number | null;
  /** Sampling windows only: when the current window opened. */
  windowStart: number;
  /**
   * Sampling windows only: the window ended at this time, but its result waits for an
   * unresolved readings outcome inside it (brief: "waits until the day resolves").
   */
  endedAt: number | null;
}

interface State {
  lifecycle: Lifecycle;
  reason: string | null;
  since: number;
  quiet: number;
  cycles: number;
  timer: Timer | null;
  coverage: SensorCoverage;
  /** The quiet-day threshold was reached while coverage was not available (brief: waits for it). */
  deferredDormant: boolean;
  /** A completed day is unresolved, so quiet counting waits (brief: "waits until the day resolves"). */
  blocked: boolean;
  /** Start of the UTC day of the latest reading seen; older days are superseded by it. */
  lastReadingDay: number;
  /** First 00:00 UTC still to be evaluated; only used while active. */
  nextBoundary: number;
}

// Same-instant order (brief): decommission, loss of coverage, readings, then timers.
type EventKind = 'decommission' | 'coverage' | 'reading' | 'day_boundary' | 'timer_end';
const PRIORITY: Record<EventKind, number> = {
  decommission: 0, coverage: 1, reading: 2, day_boundary: 3, timer_end: 4,
};
interface NextEvent { at: number; kind: EventKind }

export function replaySensor(input: ReplayInput): ReplayResult {
  const ctx = buildContext(input);
  const { now } = ctx;
  const st: State = {
    lifecycle: 'pending', reason: null, since: input.sensor.registeredAt, quiet: 0, cycles: 0,
    timer: null, coverage: 'none', deferredDormant: false, blocked: false,
    lastReadingDay: -Infinity, nextBoundary: Infinity,
  };
  const transitions: LifecycleTransition[] = [];
  const decommission = input.decommission && input.decommission.at <= now ? input.decommission : null;
  let coverageIdx = 0;
  let readingIdx = 0;

  const move = (to: Lifecycle, reason: string | null, at: number, rule: string, evidenceIds: string[] = []) => {
    transitions.push({ from: st.lifecycle, to, reason, effectiveAt: at, rule, evidenceIds });
    st.lifecycle = to;
    st.reason = reason;
    st.since = at;
  };

  const enterActive = (at: number, rule: string, readingId: string) => {
    move('active', null, at, rule, [readingId]);
    st.quiet = 0;
    st.cycles = 0;
    st.timer = null;
    st.deferredDormant = false;
    st.blocked = false;
    st.nextBoundary = nextDayStart(at); // the reading's own day is evaluated when it completes
  };

  const enterDormant = (at: number, rule: string) => {
    move('dormant', null, at, rule);
    st.deferredDormant = false;
    st.timer = {
      kind: 'dormant_wait', remainingMs: Math.max(1, settingsAt(input.config, at).dormantWaitMs),
      runningSince: st.coverage === 'available' ? at : null, windowStart: at, endedAt: null,
    };
  };

  const startWindow = (at: number) => {
    st.timer = {
      kind: 'sampling_window', remainingMs: Math.max(1, settingsAt(input.config, at).samplingWindowMs), // >= 1ms: the loop must advance
      runningSince: st.coverage === 'available' ? at : null, windowStart: at, endedAt: null,
    };
  };

  // --- event handlers -----------------------------------------------------

  const onCoverageChange = (at: number, next: SensorCoverage) => {
    const prev = st.coverage;
    st.coverage = next;
    if (next === 'none') {
      // Brief, Coverage table: pending and decommissioned stay; anything else retires at once.
      if (st.lifecycle === 'active' || st.lifecycle === 'dormant' || st.lifecycle === 'sampling') {
        move('retired', 'no_live_coverage', at, 'no_live_coverage');
      }
      st.timer = null;
      st.deferredDormant = false;
      st.blocked = false;
      return;
    }
    if (prev === 'none' && st.lifecycle === 'retired' && st.reason === 'no_live_coverage') {
      move('pending', null, at, 'coverage_restored');
      st.quiet = 0;
      st.cycles = 0;
    }
    const waiting = st.timer !== null && st.timer.endedAt !== null; // already ended: nothing to pause
    if (prev === 'available' && next !== 'available' && st.timer && !waiting && st.timer.runningSince !== null) {
      st.timer.remainingMs -= at - st.timer.runningSince; // pause
      st.timer.runningSince = null;
    }
    if (prev !== 'available' && next === 'available') {
      if (st.timer && !waiting && st.timer.runningSince === null) st.timer.runningSince = at; // resume
      if (st.lifecycle === 'active' && st.deferredDormant && !st.blocked
        && st.quiet >= settingsAt(input.config, at).quietDaysBeforeDormant) {
        enterDormant(at, 'quiet_days');
      }
    }
  };

  const onReading = (at: number, readingId: string) => {
    st.lastReadingDay = dayStart(at);
    // No lifecycle change without coverage: pending stays pending, retired stays retired.
    if (st.coverage === 'none') return;
    switch (st.lifecycle) {
      case 'pending': return enterActive(at, 'first_reading', readingId);
      case 'dormant':
      case 'retired': return enterActive(at, 'reading_wake', readingId);
      case 'sampling': return enterActive(at, 'reading_in_window', readingId);
      case 'active':
        st.quiet = 0;
        st.deferredDormant = false;
        st.blocked = false;
        return;
      default: return; // decommissioned: the replay has already stopped
    }
  };

  /** Midnight at `at` completes the day before it. Only an active sensor counts days. */
  const onDayBoundary = (at: number) => {
    st.nextBoundary = at + DAY;
    if (st.blocked) return;
    const day = at - DAY;
    if (day < st.lastReadingDay) return; // a reading at this very instant supersedes that day
    switch (classifyDay(ctx, day)) {
      case 'reading': st.quiet = 0; return;
      case 'unresolved': st.blocked = true; return;
      case 'unchecked': return;
      case 'quiet':
        st.quiet += 1;
        if (st.quiet >= settingsAt(input.config, at).quietDaysBeforeDormant) {
          if (st.coverage === 'available') enterDormant(at, 'quiet_days');
          else st.deferredDormant = true; // lifecycle is unchanged while coverage is not available
        }
    }
  };

  const onTimerEnd = (at: number) => {
    const timer = st.timer as Timer;
    if (timer.kind === 'dormant_wait') {
      move('sampling', null, at, 'dormant_wait_elapsed');
      startWindow(at);
      return;
    }
    if (hasUnresolvedBetween(ctx, timer.windowStart, at)) {
      // The result depends on a batch not resolved yet. Hold it; once the batch resolves, a
      // later replay evaluates the window here, effective at its end.
      timer.endedAt = at;
      return;
    }
    const checked = hasCheckBetween(ctx, timer.windowStart, at);
    if (!checked) {
      // The window saw no check: it does not count as a cycle.
      move('sampling', null, at, 'sampling_window_restart');
      startWindow(at);
      return;
    }
    st.cycles += 1;
    if (st.cycles >= settingsAt(input.config, at).samplingCyclesBeforeRetired) {
      move('retired', 'no_readings', at, 'sampling_retired');
      st.timer = null;
    } else {
      enterDormant(at, 'sampling_window_checked');
    }
  };

  // --- event loop ---------------------------------------------------------

  const nextEvent = (): NextEvent | null => {
    const candidates: NextEvent[] = [];
    if (decommission) candidates.push({ at: decommission.at, kind: 'decommission' });
    if (coverageIdx < ctx.coverageChanges.length) {
      candidates.push({ at: ctx.coverageChanges[coverageIdx].at, kind: 'coverage' });
    }
    if (readingIdx < ctx.readings.length) {
      candidates.push({ at: ctx.readings[readingIdx].takenAt, kind: 'reading' });
    }
    if (st.lifecycle === 'active') candidates.push({ at: st.nextBoundary, kind: 'day_boundary' });
    if (st.timer && st.timer.runningSince !== null && st.timer.endedAt === null) {
      candidates.push({ at: st.timer.runningSince + Math.max(st.timer.remainingMs, 0), kind: 'timer_end' });
    }
    let best: NextEvent | null = null;
    for (const c of candidates) {
      if (c.at > now) continue;
      if (!best || c.at < best.at || (c.at === best.at && PRIORITY[c.kind] < PRIORITY[best.kind])) best = c;
    }
    return best;
  };

  for (let ev = nextEvent(); ev; ev = nextEvent()) {
    if (ev.kind === 'decommission') {
      move('decommissioned', decommission!.reason, ev.at, 'operator_decommission');
      st.timer = null;
      break; // terminal: nothing changes after
    }
    if (ev.kind === 'coverage') {
      const change = ctx.coverageChanges[coverageIdx++];
      onCoverageChange(change.at, change.coverage);
    } else if (ev.kind === 'reading') {
      const reading = ctx.readings[readingIdx++];
      onReading(reading.takenAt, reading.readingId);
    } else if (ev.kind === 'day_boundary') {
      onDayBoundary(ev.at);
    } else {
      onTimerEnd(ev.at);
    }
  }

  return summarize(ctx, st, transitions);
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

function summarize(ctx: Ctx, st: State, transitions: LifecycleTransition[]): ReplayResult {
  const { now } = ctx;
  const decommissioned = st.lifecycle === 'decommissioned';
  // A window waiting on an unresolved batch shows the time it ended.
  const timerEnd = st.timer && st.timer.endedAt !== null ? st.timer.endedAt
    : st.timer && st.timer.runningSince !== null ? st.timer.runningSince + Math.max(st.timer.remainingMs, 0)
    : null;

  // The server time at which the current wait or window ends; null while paused.
  const nextEvaluationAt = timerEnd !== null && (st.lifecycle === 'dormant' || st.lifecycle === 'sampling')
    ? timerEnd
    : null;

  // Earliest time after `now` when time passing alone could change the result.
  const checks = [nextDayStart(now), ...timeDrivenChecksAfterNow(ctx)];
  if (timerEnd !== null && timerEnd > now) checks.push(timerEnd);
  const nextCheckAt = decommissioned ? null : Math.min(...checks);

  const coverage = coverageAt(ctx, now);
  const lastCoverageChange = [...ctx.recordedCoverageChanges].reverse().find((c) => c.at <= now);

  return {
    transitions,
    lifecycle: st.lifecycle,
    lifecycleReason: st.reason,
    lifecycleSince: st.since,
    quietCheckedDays: st.quiet,
    samplingCyclesDone: st.cycles,
    nextEvaluationAt,
    coverage,
    coverageSince: lastCoverageChange ? lastCoverageChange.at : ctx.input.sensor.registeredAt,
    collection: collectionAt(ctx, now),
    collectionSince: collectionSince(ctx, ctx.input.sensor.registeredAt),
    nextCheckAt,
  };
}
