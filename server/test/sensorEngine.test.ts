// Unit tests for the pure sensor engine. No database. Day n is Date.UTC(2026,0,1) + n * DAY.
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/config';
import { DAY, HOUR, MINUTE } from '../src/time';
import { replaySensor } from '../src/domain/sensorEngine';
import type {
  BatchStatus, ConfigVersion, GatewayCoverageClass, Outcome, ReplayInput, ReplayResult, Settings,
} from '../src/types';

const DAY0 = Date.UTC(2026, 0, 1);
/** Day n, at hh:mm UTC. */
const D = (n: number, h = 0, m = 0) => DAY0 + n * DAY + h * HOUR + m * MINUTE;

/** Builds a ReplayInput the way the brief tells its stories. */
class Scenario {
  registeredAt = D(0);
  assignments: ReplayInput['assignments'] = [];
  gatewayLogs: ReplayInput['gatewayLogs'] = {};
  outcomes: ReplayInput['outcomes'] = [];
  batches: ReplayInput['batches'] = {};
  readings: ReplayInput['readings'] = [];
  decommission: ReplayInput['decommission'] = null;
  config: ConfigVersion[] = [{ effectiveAt: 0, settings: DEFAULT_SETTINGS }];
  private n = 0;

  assign(at: number, ...gatewayIds: string[]) {
    this.assignments.push({ effectiveAt: at, gatewayIds });
    return this;
  }

  /** Coverage class history of a gateway: [time, class] rows. */
  gateway(id: string, ...rows: [number, GatewayCoverageClass][]) {
    this.gatewayLogs[id] = rows.map(([effectiveAt, coverageClass]) => ({ effectiveAt, coverageClass }));
    return this;
  }

  /** A cycle result for the sensor (not a readings outcome; use readingsCycle for that). */
  cycle(gatewayId: string, finishedAt: number, outcome: Exclude<Outcome, 'readings'>) {
    this.outcomes.push({ gatewayId, cycleId: `c${this.n++}`, finishedAt, outcome, batchId: null });
    return this;
  }

  /**
   * A readings outcome. `batch` says what the batch is: a status, or 'missing' if it never
   * arrives. The batch arrives at `receivedAt` (default: with the cycle).
   */
  readingsCycle(
    gatewayId: string, finishedAt: number, batchId: string, batch: BatchStatus | 'missing', receivedAt = finishedAt,
  ) {
    this.outcomes.push({ gatewayId, cycleId: `c${this.n++}`, finishedAt, outcome: 'readings', batchId });
    if (batch !== 'missing') this.batches[batchId] = { status: batch, gatewayId, receivedAt };
    return this;
  }

  /** An accepted reading inside a processed batch. */
  reading(gatewayId: string, takenAt: number, readingId: string, batchId = `batch-${readingId}`) {
    this.batches[batchId] = { status: 'processed', gatewayId, receivedAt: this.batches[batchId]?.receivedAt ?? takenAt };
    this.readings.push({ readingId, batchId, gatewayId, takenAt });
    return this;
  }

  decommissioned(at: number, reason: string) {
    this.decommission = { at, reason };
    return this;
  }

  /** Replay as the server would at `now`: evidence dated after `now` has not happened yet. */
  at(now: number): ReplayResult {
    return this.replay(now, true);
  }

  /** Replay with every piece of evidence given, even dated after `now`. */
  replay(now: number, onlyKnownAt = false): ReplayResult {
    return replaySensor(this.input(now, onlyKnownAt));
  }

  input(now: number, onlyKnownAt = false): ReplayInput {
    const known = <T>(rows: T[], time: (r: T) => number) => (onlyKnownAt ? rows.filter((r) => time(r) <= now) : rows);
    return {
      sensor: { id: 'S', type: 'temperature', registeredAt: this.registeredAt },
      now,
      assignments: this.assignments,
      gatewayLogs: this.gatewayLogs,
      outcomes: known(this.outcomes, (o) => o.finishedAt),
      batches: this.batches,
      readings: known(this.readings, (r) => r.takenAt),
      decommission: this.decommission,
      config: this.config,
    };
  }
}

const settings = (over: Partial<Settings>): Settings => ({ ...DEFAULT_SETTINGS, ...over });

/**
 * The brief's worked example: S is covered only by G, which is connected and running from
 * day 0 12:00. G reports a reading at day 0 12:00, then no_readings every day at 12:00.
 */
function workedExample(lastCycleDay = 60): Scenario {
  const s = new Scenario()
    .assign(D(0), 'G')
    .gateway('G', [D(0), 'recoverable'], [D(0, 12), 'available'])
    .readingsCycle('G', D(0, 12), 'b0', 'processed')
    .reading('G', D(0, 12), 'r0', 'b0');
  for (let n = 1; n <= lastCycleDay; n++) s.cycle('G', D(n, 12), 'no_readings');
  return s;
}

/** The fields most tests care about. */
function view(r: ReplayResult) {
  return {
    lifecycle: r.lifecycle,
    reason: r.lifecycleReason,
    since: r.lifecycleSince,
    quiet: r.quietCheckedDays,
    cycles: r.samplingCyclesDone,
    next: r.nextEvaluationAt,
    coverage: r.coverage,
    collection: r.collection,
  };
}

describe('worked example (brief)', () => {
  const s = workedExample();

  it('is active from the first reading, day 0 12:00', () => {
    const r = s.at(D(0, 12, 1));
    expect(view(r)).toEqual({
      lifecycle: 'active', reason: null, since: D(0, 12), quiet: 0, cycles: 0, next: null,
      coverage: 'available', collection: 'readings',
    });
    expect(r.transitions).toEqual([
      { from: 'pending', to: 'active', reason: null, effectiveAt: D(0, 12), rule: 'first_reading', evidenceIds: ['r0'] },
    ]);
  });

  it('is pending before the first reading', () => {
    const r = s.at(D(0, 11));
    expect(r.lifecycle).toBe('pending');
    expect(r.lifecycleSince).toBe(D(0));
    expect(r.transitions).toEqual([]);
    expect(r.coverage).toBe('recoverable');
    expect(r.collection).toBe('not_checked');
  });

  it('counts quiet_checked_days 1..14 as each day completes', () => {
    // The reading day itself does not count: day 1 00:00 completes day 0 (a reading day).
    expect(s.at(D(1)).quietCheckedDays).toBe(0);
    for (let k = 1; k <= 14; k++) {
      // Day k+1 00:00 completes day k, the k-th quiet day.
      const justBefore = s.at(D(k + 1) - 1);
      const justAfter = s.at(D(k + 1));
      expect(justBefore.quietCheckedDays).toBe(k - 1);
      if (k < 14) {
        expect(justAfter.quietCheckedDays).toBe(k);
        expect(justAfter.lifecycle).toBe('active');
      }
    }
  });

  it('goes dormant at day 15 00:00, with the wait ending day 29 00:00', () => {
    expect(s.at(D(15) - 1).lifecycle).toBe('active');
    const r = s.at(D(15));
    expect(view(r)).toMatchObject({
      lifecycle: 'dormant', reason: null, since: D(15), quiet: 14, cycles: 0, next: D(29),
    });
    expect(r.nextEvaluationAt).toBe(D(29));
  });

  it('stays dormant until day 29, where sampling starts and the window ends day 32', () => {
    expect(view(s.at(D(28, 23, 59)))).toMatchObject({ lifecycle: 'dormant', next: D(29) });
    const r = s.at(D(29));
    expect(view(r)).toMatchObject({ lifecycle: 'sampling', since: D(29), cycles: 0, next: D(32) });
    expect(s.at(D(31, 12)).lifecycle).toBe('sampling');
  });

  it('is dormant again at day 32 with one sampling cycle done', () => {
    const r = s.at(D(32));
    expect(view(r)).toMatchObject({ lifecycle: 'dormant', since: D(32), cycles: 1, next: D(46) });
  });

  it('samples again at day 46 and is retired (no_readings) at day 49', () => {
    expect(view(s.at(D(46)))).toMatchObject({ lifecycle: 'sampling', cycles: 1, next: D(49) });
    const r = s.at(D(49));
    expect(view(r)).toMatchObject({
      lifecycle: 'retired', reason: 'no_readings', since: D(49), cycles: 2, next: null,
    });
    expect(s.at(D(59)).lifecycle).toBe('retired');
  });

  it('records the full transition list', () => {
    const r = s.at(D(59));
    expect(r.transitions).toEqual([
      { from: 'pending', to: 'active', reason: null, effectiveAt: D(0, 12), rule: 'first_reading', evidenceIds: ['r0'] },
      { from: 'active', to: 'dormant', reason: null, effectiveAt: D(15), rule: 'quiet_days', evidenceIds: [] },
      { from: 'dormant', to: 'sampling', reason: null, effectiveAt: D(29), rule: 'dormant_wait_elapsed', evidenceIds: [] },
      { from: 'sampling', to: 'dormant', reason: null, effectiveAt: D(32), rule: 'sampling_window_checked', evidenceIds: [] },
      { from: 'dormant', to: 'sampling', reason: null, effectiveAt: D(46), rule: 'dormant_wait_elapsed', evidenceIds: [] },
      { from: 'sampling', to: 'retired', reason: 'no_readings', effectiveAt: D(49), rule: 'sampling_retired', evidenceIds: [] },
    ]);
  });

  it('gives the same transitions whether replayed in one jump or step by step', () => {
    const jump = s.at(D(59)).transitions;
    for (let n = 1; n <= 59; n++) {
      const partial = s.at(D(n, 12)).transitions;
      expect(jump.slice(0, partial.length)).toEqual(partial);
    }
  });

  it('is deterministic and does not touch its input', () => {
    const input = s.input(D(59));
    const before = JSON.stringify(input);
    const a = replaySensor(input);
    const b = replaySensor(input);
    expect(a).toEqual(b);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('reports coverage and collection from the cycles', () => {
    const r = s.at(D(20, 13));
    expect(r.coverage).toBe('available');
    expect(r.coverageSince).toBe(D(0, 12));
    expect(r.collection).toBe('no_readings');
    expect(r.collectionSince).toBe(D(1, 12)); // continuous no_readings since the first one
  });
});

describe('variation: disconnection mid-window', () => {
  // G reports auth_failed on day 30 12:00 (stored as could_not_read) and is good again on
  // day 37 12:00 (a cycle with no_readings).
  const build = () => {
    const s = new Scenario()
      .assign(D(0), 'G')
      .gateway('G', [D(0), 'recoverable'], [D(0, 12), 'available'], [D(30, 12), 'recoverable'], [D(37, 12), 'available'])
      .readingsCycle('G', D(0, 12), 'b0', 'processed')
      .reading('G', D(0, 12), 'r0', 'b0');
    for (let n = 1; n <= 29; n++) s.cycle('G', D(n, 12), 'no_readings');
    s.cycle('G', D(30, 12), 'could_not_read');
    for (let n = 37; n <= 50; n++) s.cycle('G', D(n, 12), 'no_readings');
    return s;
  };
  const s = build();

  it('pauses the window with 36 hours left', () => {
    expect(view(s.at(D(30, 11)))).toMatchObject({ lifecycle: 'sampling', next: D(32), collection: 'no_readings' });
    const r = s.at(D(30, 12));
    expect(view(r)).toMatchObject({ lifecycle: 'sampling', next: null, coverage: 'recoverable' });
  });

  it('shows not_checked and no next evaluation while paused', () => {
    for (const t of [D(30, 13), D(31), D(34), D(37, 11)]) {
      const r = s.at(t);
      expect(r.lifecycle).toBe('sampling');
      expect(r.nextEvaluationAt).toBeNull();
      expect(r.collection).toBe('not_checked');
      expect(r.coverage).toBe('recoverable');
    }
    expect(s.at(D(33)).transitions.map((t) => t.rule)).toEqual([
      'first_reading', 'quiet_days', 'dormant_wait_elapsed',
    ]);
  });

  it('resumes on day 37 12:00 and the window ends day 39 00:00', () => {
    expect(view(s.at(D(37, 12)))).toMatchObject({ lifecycle: 'sampling', next: D(39), coverage: 'available' });
    expect(s.at(D(38, 23, 59)).lifecycle).toBe('sampling');
    const r = s.at(D(39));
    expect(view(r)).toMatchObject({ lifecycle: 'dormant', cycles: 1, since: D(39), next: D(53) });
    expect(r.transitions.at(-1)).toMatchObject({ rule: 'sampling_window_checked', effectiveAt: D(39) });
  });
});

describe('variation: a late reading', () => {
  it('replay at day 20 with a reading taken on day 9 stays active', () => {
    const s = workedExample(30).reading('G', D(9, 8), 'late');
    const r = s.at(D(20));
    expect(view(r)).toMatchObject({ lifecycle: 'active', since: D(0, 12), quiet: 10, cycles: 0, next: null });
    expect(r.transitions).toEqual([
      { from: 'pending', to: 'active', reason: null, effectiveAt: D(0, 12), rule: 'first_reading', evidenceIds: ['r0'] },
    ]);
  });

  it('without that reading the sensor went dormant on day 15', () => {
    const r = workedExample(30).at(D(19));
    expect(view(r)).toMatchObject({ lifecycle: 'dormant', since: D(15), quiet: 14 });
    expect(r.transitions.at(-1)).toMatchObject({ from: 'active', to: 'dormant', effectiveAt: D(15) });
  });

  it('a late reading on day 2 recomputes later timers: still dormant, since day 17', () => {
    // Day 40 replay: reading on day 2 moves the dormancy from day 15 to day 17.
    const s = workedExample(45).reading('G', D(2, 8), 'late');
    const r = s.at(D(40));
    expect(r.transitions.map((t) => [t.to, t.effectiveAt])).toEqual([
      ['active', D(0, 12)], ['dormant', D(17)], ['sampling', D(31)], ['dormant', D(34)],
    ]);
    expect(r.lifecycle).toBe('dormant');
  });
});

describe('variation: an unresolved day', () => {
  // Day 14: G reports readings but the batch never arrives.
  const build = () => {
    const s = new Scenario()
      .assign(D(0), 'G')
      .gateway('G', [D(0), 'recoverable'], [D(0, 12), 'available'])
      .readingsCycle('G', D(0, 12), 'b0', 'processed')
      .reading('G', D(0, 12), 'r0', 'b0');
    for (let n = 1; n <= 13; n++) s.cycle('G', D(n, 12), 'no_readings');
    s.readingsCycle('G', D(14, 12), 'lost', 'missing');
    for (let n = 15; n <= 20; n++) s.cycle('G', D(n, 12), 'no_readings');
    return s;
  };
  const s = build();

  it('day 15 00:00: blocked, still active, quiet 13', () => {
    expect(view(s.at(D(15)))).toMatchObject({ lifecycle: 'active', quiet: 13 });
    expect(s.at(D(15, 11, 59)).lifecycle).toBe('active');
  });

  it('day 15 12:00: the day resolves as unchecked, quiet stays 13', () => {
    expect(view(s.at(D(15, 12)))).toMatchObject({ lifecycle: 'active', quiet: 13 });
  });

  it('day 16 00:00: dormant after another quiet day', () => {
    const r = s.at(D(16));
    expect(view(r)).toMatchObject({ lifecycle: 'dormant', since: D(16), quiet: 14 });
    expect(r.transitions.at(-1)).toMatchObject({ rule: 'quiet_days', effectiveAt: D(16) });
  });

  it('is the same when replayed long after (jump from day 0 to day 29)', () => {
    expect(s.at(D(29, 12)).transitions.map((t) => [t.to, t.effectiveAt])).toEqual([
      ['active', D(0, 12)], ['dormant', D(16)],
    ]);
  });

  it('a batch stuck in retrying blocks the days after it, even past the deadline', () => {
    const t = new Scenario().assign(D(0), 'G').gateway('G', [D(0), 'available'])
      .readingsCycle('G', D(0, 12), 'b0', 'processed').reading('G', D(0, 12), 'r0', 'b0');
    for (let n = 1; n <= 13; n++) t.cycle('G', D(n, 12), 'no_readings');
    t.readingsCycle('G', D(14, 12), 'stuck', 'retrying');
    for (let n = 15; n <= 25; n++) t.cycle('G', D(n, 12), 'no_readings');
    expect(view(t.at(D(25)))).toMatchObject({ lifecycle: 'active', quiet: 13 });
  });
});

describe('coverage', () => {
  it('removing the assignment retires an active sensor with no_live_coverage', () => {
    const s = workedExample(10).assign(D(3, 6)); // replaced by the empty set
    const r = s.at(D(4));
    expect(view(r)).toMatchObject({ lifecycle: 'retired', reason: 'no_live_coverage', since: D(3, 6), coverage: 'none' });
    expect(r.transitions.at(-1)).toEqual({
      from: 'active', to: 'retired', reason: 'no_live_coverage', effectiveAt: D(3, 6), rule: 'no_live_coverage', evidenceIds: [],
    });
    expect(r.collection).toBe('not_checked');
    expect(r.nextEvaluationAt).toBeNull();
    expect(r.coverageSince).toBe(D(3, 6));
  });

  it('a gateway turning dead (suspended) retires dormant and sampling sensors too', () => {
    const dormant = workedExample(40).gateway('G', [D(0), 'recoverable'], [D(0, 12), 'available'], [D(20), 'dead']);
    expect(view(dormant.at(D(21)))).toMatchObject({ lifecycle: 'retired', reason: 'no_live_coverage', since: D(20) });
    const sampling = workedExample(40).gateway('G', [D(0), 'recoverable'], [D(0, 12), 'available'], [D(30), 'dead']);
    expect(view(sampling.at(D(31)))).toMatchObject({ lifecycle: 'retired', reason: 'no_live_coverage', since: D(30) });
  });

  it('a pending sensor stays pending under none, and readings under none change nothing', () => {
    const s = new Scenario().gateway('G', [D(0), 'dead']).assign(D(0), 'G').reading('G', D(1, 12), 'r1');
    const r = s.at(D(3));
    expect(view(r)).toMatchObject({ lifecycle: 'pending', coverage: 'none', collection: 'not_checked' });
    expect(r.transitions).toEqual([]);
  });

  it('a sensor with no assignment at all is pending with no coverage', () => {
    const r = new Scenario().at(D(5));
    expect(view(r)).toMatchObject({ lifecycle: 'pending', coverage: 'none', since: D(0), quiet: 0 });
  });

  it('reassigning moves a retired (no_live_coverage) sensor to pending and resets counters', () => {
    const s = workedExample(30).assign(D(5) /* replaced by the empty set */).assign(D(8, 6), 'G');
    const r = s.at(D(9));
    expect(r.transitions.map((t) => [t.from, t.to, t.reason, t.rule, t.effectiveAt])).toEqual([
      ['pending', 'active', null, 'first_reading', D(0, 12)],
      ['active', 'retired', 'no_live_coverage', 'no_live_coverage', D(5)],
      ['retired', 'pending', null, 'coverage_restored', D(8, 6)],
    ]);
    expect(view(r)).toMatchObject({ lifecycle: 'pending', since: D(8, 6), quiet: 0, cycles: 0, coverage: 'available' });
  });

  it('after coverage_restored a new reading makes it active again', () => {
    const s = workedExample(30).assign(D(5)).assign(D(8, 6), 'G').reading('G', D(10, 3), 'r-new');
    const r = s.at(D(10, 4));
    expect(r.transitions.at(-1)).toMatchObject({ from: 'pending', to: 'active', rule: 'first_reading', evidenceIds: ['r-new'] });
    expect(r.quietCheckedDays).toBe(0);
  });

  it('a covering gateway leaving suspended restores a retired sensor', () => {
    const s = workedExample(30)
      .gateway('G', [D(0), 'recoverable'], [D(0, 12), 'available'], [D(5), 'dead'], [D(8), 'recoverable']);
    const r = s.at(D(9));
    expect(r.transitions.map((t) => t.rule)).toEqual(['first_reading', 'no_live_coverage', 'coverage_restored']);
    expect(r.lifecycle).toBe('pending');
    expect(r.coverage).toBe('recoverable');
  });

  it('retired (no_readings) stays retired (no_readings) when coverage becomes none', () => {
    const s = workedExample(60).gateway('G', [D(0), 'recoverable'], [D(0, 12), 'available'], [D(52), 'dead']);
    const r = s.at(D(55));
    expect(view(r)).toMatchObject({ lifecycle: 'retired', reason: 'no_readings', since: D(49), coverage: 'none' });
    expect(r.transitions).toHaveLength(6);
  });

  it('retired (no_readings) stays retired (no_readings) when coverage returns', () => {
    const s = workedExample(60)
      .gateway('G', [D(0), 'recoverable'], [D(0, 12), 'available'], [D(52), 'dead'], [D(54), 'available']);
    const r = s.at(D(55));
    expect(view(r)).toMatchObject({ lifecycle: 'retired', reason: 'no_readings', coverage: 'available' });
  });

  it('a retired (no_readings) sensor wakes on a reading', () => {
    const s = workedExample(60).reading('G', D(52, 3), 'wake');
    const r = s.at(D(53));
    expect(r.transitions.at(-1)).toMatchObject({
      from: 'retired', to: 'active', rule: 'reading_wake', effectiveAt: D(52, 3), evidenceIds: ['wake'],
    });
    expect(view(r)).toMatchObject({ lifecycle: 'active', cycles: 0, quiet: 0 });
  });

  it('the best gateway class wins: available > stopped > recoverable', () => {
    const s = new Scenario().assign(D(0), 'A', 'B', 'C')
      .gateway('A', [D(0), 'recoverable'], [D(7), 'dead'])
      .gateway('B', [D(0), 'stopped'], [D(5), 'dead'])
      .gateway('C', [D(0), 'dead'], [D(2), 'available'], [D(4), 'dead']);
    expect(s.at(D(1)).coverage).toBe('stopped');
    expect(s.at(D(3)).coverage).toBe('available');
    expect(s.at(D(4, 12)).coverage).toBe('stopped');
    expect(s.at(D(6)).coverage).toBe('recoverable');
    expect(s.at(D(8)).coverage).toBe('none');
  });
});

describe('stopped coverage', () => {
  // G is stopped from day 20 12:00 and available again from day 30 12:00.
  const build = () => workedExample(45)
    .gateway('G', [D(0), 'recoverable'], [D(0, 12), 'available'], [D(20, 12), 'stopped'], [D(30, 12), 'available']);
  const s = build();

  it('pauses the dormant wait and shows collection_stopped', () => {
    const r = s.at(D(25));
    expect(view(r)).toMatchObject({ lifecycle: 'dormant', next: null, coverage: 'stopped', collection: 'collection_stopped' });
    expect(r.coverageSince).toBe(D(20, 12));
  });

  it('resumes the wait with the remaining available time', () => {
    // Dormant from day 15; ran 5.5 days; 8.5 days left; resumes day 30 12:00 -> day 39 00:00.
    expect(view(s.at(D(30, 12)))).toMatchObject({ lifecycle: 'dormant', next: D(39), coverage: 'available' });
    expect(s.at(D(38, 23, 59)).lifecycle).toBe('dormant');
    expect(s.at(D(39)).lifecycle).toBe('sampling');
  });

  it('a reading from a stopped gateway still wakes a dormant sensor', () => {
    const woken = build().reading('G', D(25, 9), 'stopped-reading');
    const r = woken.at(D(26));
    expect(r.transitions.at(-1)).toMatchObject({
      from: 'dormant', to: 'active', rule: 'reading_wake', effectiveAt: D(25, 9), evidenceIds: ['stopped-reading'],
    });
    expect(view(r)).toMatchObject({ lifecycle: 'active', coverage: 'stopped', collection: 'collection_stopped' });
  });

  it('active quiet counting is not stopped by coverage loss but the dormant move waits (deferred)', () => {
    // see "deferred dormant" below; here just check quiet days still add up while stopped
    const t = workedExample(10)
      .gateway('G', [D(0), 'recoverable'], [D(0, 12), 'available'], [D(5, 13), 'stopped']);
    // days 1..5 have no_readings (available at 12:00); days 6..9 are silent (unchecked) -> quiet stays 5.
    t.outcomes = t.outcomes.filter((o) => o.finishedAt <= D(5, 12));
    expect(t.at(D(9)).quietCheckedDays).toBe(5);
  });
});

describe('deferred dormant', () => {
  // The 14th quiet day (day 14) completes at day 15 00:00 while G is stopped (day 14 18:00 to day 17 06:00).
  const build = () => {
    const s = new Scenario()
      .assign(D(0), 'G')
      .gateway('G', [D(0), 'available'], [D(14, 18), 'stopped'], [D(17, 6), 'available'])
      .readingsCycle('G', D(0, 12), 'b0', 'processed')
      .reading('G', D(0, 12), 'r0', 'b0');
    for (let n = 1; n <= 14; n++) s.cycle('G', D(n, 12), 'no_readings');
    return s;
  };

  it('stays active while coverage is not available, then goes dormant at that time', () => {
    const s = build();
    const stopped = s.at(D(16, 12));
    expect(view(stopped)).toMatchObject({ lifecycle: 'active', quiet: 14, coverage: 'stopped', next: null });
    expect(s.at(D(17, 5, 59)).lifecycle).toBe('active');
    const r = s.at(D(17, 6));
    expect(view(r)).toMatchObject({ lifecycle: 'dormant', since: D(17, 6), quiet: 14, next: D(31, 6) });
    expect(r.transitions.at(-1)).toMatchObject({ from: 'active', to: 'dormant', rule: 'quiet_days', effectiveAt: D(17, 6) });
  });

  it('a reading while waiting cancels the deferral', () => {
    const s = build().reading('G', D(16, 3), 'during-stop');
    const r = s.at(D(18));
    expect(view(r)).toMatchObject({ lifecycle: 'active', quiet: 0 });
    expect(r.transitions.map((t) => t.rule)).toEqual(['first_reading']);
  });

  it('goes dormant immediately when coverage is lost and regained on the same quiet-day boundary', () => {
    // Coverage returns at exactly day 15 00:00 (the boundary): coverage first, then the day boundary.
    const s = build().gateway('G', [D(0), 'available'], [D(14, 18), 'stopped'], [D(15), 'available']);
    expect(s.at(D(15))).toMatchObject({ lifecycle: 'dormant', lifecycleSince: D(15) });
  });
});

describe('sampling window without checks', () => {
  // G stops reporting after day 14, so the first window sees no no_readings at all.
  const build = () => {
    const s = new Scenario()
      .assign(D(0), 'G')
      .gateway('G', [D(0), 'available'])
      .readingsCycle('G', D(0, 12), 'b0', 'processed')
      .reading('G', D(0, 12), 'r0', 'b0');
    for (let n = 1; n <= 14; n++) s.cycle('G', D(n, 12), 'no_readings');
    return s;
  };

  it('restarts the window without counting a cycle', () => {
    const r = build().at(D(32));
    expect(r.transitions.at(-1)).toEqual({
      from: 'sampling', to: 'sampling', reason: null, effectiveAt: D(32), rule: 'sampling_window_restart', evidenceIds: [],
    });
    expect(view(r)).toMatchObject({ lifecycle: 'sampling', since: D(32), cycles: 0, next: D(35) });
  });

  it('a check inside the second window ends it as dormant with cycles 1', () => {
    const s = build().cycle('G', D(33, 12), 'no_readings');
    const r = s.at(D(35));
    expect(view(r)).toMatchObject({ lifecycle: 'dormant', since: D(35), cycles: 1, next: D(49) });
    expect(r.transitions.map((t) => t.rule).slice(-2)).toEqual(['sampling_window_restart', 'sampling_window_checked']);
  });

  it('could_not_read and timed_out outcomes are not checks', () => {
    const s = build().cycle('G', D(30, 12), 'could_not_read').cycle('G', D(31, 12), 'timed_out');
    expect(s.at(D(32)).transitions.at(-1)?.rule).toBe('sampling_window_restart');
  });

  it('a reading inside the window wakes the sensor at its taken_at', () => {
    const s = build().reading('G', D(30, 7), 'in-window');
    const r = s.at(D(32));
    expect(r.transitions.at(-1)).toMatchObject({
      from: 'sampling', to: 'active', rule: 'reading_in_window', effectiveAt: D(30, 7), evidenceIds: ['in-window'],
    });
    expect(view(r)).toMatchObject({ lifecycle: 'active', cycles: 0, quiet: 0, next: null });
  });

  it('retires only after two counted cycles', () => {
    const s = build();
    for (let n = 29; n <= 60; n++) s.cycle('G', D(n, 12), 'no_readings');
    const r = s.at(D(60));
    expect(r.transitions.map((t) => t.rule)).toEqual([
      'first_reading', 'quiet_days', 'dormant_wait_elapsed', 'sampling_window_checked',
      'dormant_wait_elapsed', 'sampling_retired',
    ]);
  });
});

describe('decommission', () => {
  it('is terminal, keeps the operator reason and ignores later evidence', () => {
    const s = workedExample(30).decommissioned(D(5, 12), 'water damage').reading('G', D(6, 8), 'later');
    const r = s.at(D(40));
    expect(r.transitions.at(-1)).toEqual({
      from: 'active', to: 'decommissioned', reason: 'water damage', effectiveAt: D(5, 12),
      rule: 'operator_decommission', evidenceIds: [],
    });
    expect(r.transitions).toHaveLength(2);
    expect(view(r)).toMatchObject({
      lifecycle: 'decommissioned', reason: 'water damage', since: D(5, 12), next: null,
    });
    expect(r.nextCheckAt).toBeNull();
  });

  it('works from pending and from retired', () => {
    expect(new Scenario().decommissioned(D(1), 'gone').at(D(2))).toMatchObject({
      lifecycle: 'decommissioned', lifecycleReason: 'gone',
    });
    const retired = workedExample(60).decommissioned(D(55), 'scrapped').at(D(56));
    expect(retired.transitions.at(-1)).toMatchObject({ from: 'retired', to: 'decommissioned' });
  });

  it('is not applied before its time', () => {
    const r = workedExample(10).decommissioned(D(20), 'later').at(D(5));
    expect(r.lifecycle).toBe('active');
  });

  it('stops the dormant timer', () => {
    const r = workedExample(40).decommissioned(D(20), 'x').at(D(30));
    expect(r.nextEvaluationAt).toBeNull();
    expect(r.lifecycle).toBe('decommissioned');
  });
});

describe('batches: quarantined, late', () => {
  const base = () => {
    const s = new Scenario().assign(D(0), 'G').gateway('G', [D(0), 'available'])
      .readingsCycle('G', D(0, 12), 'b0', 'processed').reading('G', D(0, 12), 'r0', 'b0');
    for (let n = 1; n <= 13; n++) s.cycle('G', D(n, 12), 'no_readings');
    return s;
  };

  it('a quarantined batch turns the readings outcome into could_not_read (an unchecked day)', () => {
    const s = base().readingsCycle('G', D(14, 12), 'bq', 'quarantined');
    for (let n = 15; n <= 16; n++) s.cycle('G', D(n, 12), 'no_readings');
    // Day 14 is unchecked, not unresolved: nothing waits, nothing counts.
    expect(view(s.at(D(15)))).toMatchObject({ lifecycle: 'active', quiet: 13 });
    expect(view(s.at(D(14, 13)))).toMatchObject({ collection: 'could_not_read' });
    expect(view(s.at(D(16)))).toMatchObject({ lifecycle: 'dormant', since: D(16) });
  });

  it('a batch processed late, with a reading, makes day 14 a reading day', () => {
    const s = base().readingsCycle('G', D(14, 12), 'bl', 'processed').reading('G', D(14, 11, 55), 'late', 'bl');
    for (let n = 15; n <= 20; n++) s.cycle('G', D(n, 12), 'no_readings');
    const r = s.at(D(17));
    expect(view(r)).toMatchObject({ lifecycle: 'active', quiet: 2 });
    expect(r.transitions).toHaveLength(1); // never went dormant
    expect(view(s.at(D(15)))).toMatchObject({ lifecycle: 'active', quiet: 0 });
  });

  it('a readings outcome with a processed batch and no readings is just unchecked', () => {
    const s = base().readingsCycle('G', D(14, 12), 'bp', 'partially_processed');
    expect(view(s.at(D(15)))).toMatchObject({ lifecycle: 'active', quiet: 13 });
  });
});

describe('latest collection', () => {
  const twoGateways = () => new Scenario().assign(D(0), 'G1', 'G2')
    .gateway('G1', [D(0), 'available']).gateway('G2', [D(0), 'available']);

  it('picks readings > no_readings > could_not_read > timed_out across gateways', () => {
    const cases: [Exclude<Outcome, 'readings'>, Exclude<Outcome, 'readings'>, string][] = [
      ['no_readings', 'could_not_read', 'no_readings'],
      ['could_not_read', 'timed_out', 'could_not_read'],
      ['timed_out', 'timed_out', 'timed_out'],
      ['timed_out', 'no_readings', 'no_readings'],
    ];
    for (const [a, b, expected] of cases) {
      const s = twoGateways().cycle('G1', D(1, 10), a).cycle('G2', D(1, 11), b);
      expect(s.at(D(1, 12)).collection).toBe(expected);
    }
    const withReadings = twoGateways().cycle('G1', D(1, 10), 'no_readings')
      .readingsCycle('G2', D(1, 9), 'bx', 'processed').reading('G2', D(1, 9), 'rx', 'bx');
    expect(withReadings.at(D(1, 12)).collection).toBe('readings');
  });

  it('uses each gateway\'s MOST RECENT outcome only', () => {
    const s = twoGateways().cycle('G1', D(1, 10), 'no_readings').cycle('G1', D(1, 11), 'timed_out');
    expect(s.at(D(1, 12)).collection).toBe('timed_out');
  });

  it('ignores outcomes older than 24 hours', () => {
    const s = twoGateways().cycle('G1', D(1, 10), 'no_readings');
    expect(s.at(D(2, 9, 59)).collection).toBe('no_readings');
    expect(s.at(D(2, 10)).collection).toBe('no_readings'); // exactly 24h still counts
    const expired = s.at(D(2, 10) + 1);
    expect(expired.collection).toBe('not_checked');
    expect(expired.collectionSince).toBe(D(2, 10) + 1);
  });

  it('an old outcome does not hide: the newer one of the same gateway decides, and it can expire alone', () => {
    const s = twoGateways().cycle('G1', D(1, 10), 'no_readings').cycle('G1', D(1, 20), 'could_not_read');
    expect(s.at(D(2, 12)).collection).toBe('could_not_read');
    expect(s.at(D(2, 20) + 1).collection).toBe('not_checked');
  });

  it('only counts gateways whose class is available', () => {
    const s = new Scenario().assign(D(0), 'G1', 'G2')
      .gateway('G1', [D(0), 'available'], [D(2), 'stopped'])
      .gateway('G2', [D(0), 'recoverable'])
      .cycle('G1', D(1, 10), 'no_readings').cycle('G2', D(1, 10), 'no_readings');
    expect(s.at(D(1, 12)).collection).toBe('no_readings');
    const r = s.at(D(2, 1));
    expect(r.coverage).toBe('stopped');
    expect(r.collection).toBe('collection_stopped');
  });

  it('distinguishes collection_stopped from not_checked', () => {
    const stopped = new Scenario().assign(D(0), 'G').gateway('G', [D(0), 'stopped']);
    expect(stopped.at(D(1)).collection).toBe('collection_stopped');
    const recoverable = new Scenario().assign(D(0), 'G').gateway('G', [D(0), 'recoverable']);
    expect(recoverable.at(D(1)).collection).toBe('not_checked');
    const mixed = new Scenario().assign(D(0), 'A', 'B')
      .gateway('A', [D(0), 'stopped']).gateway('B', [D(0), 'recoverable']);
    expect(mixed.at(D(1)).collection).toBe('collection_stopped');
    const none = new Scenario().assign(D(0), 'G').gateway('G', [D(0), 'dead']);
    expect(none.at(D(1)).collection).toBe('not_checked');
  });

  it('counts a reading from a batch that no cycle mentions as a readings outcome at taken_at', () => {
    const s = new Scenario().assign(D(0), 'G').gateway('G', [D(0), 'available'])
      .reading('G', D(3, 5), 'orphan');
    expect(s.at(D(3, 4)).collection).toBe('not_checked');
    const r = s.at(D(3, 6));
    expect(r.collection).toBe('readings');
    expect(r.collectionSince).toBe(D(3, 5));
    expect(s.at(D(4, 5) + 1).collection).toBe('not_checked');
  });

  it('a readings outcome whose batch is quarantined counts as could_not_read', () => {
    const s = new Scenario().assign(D(0), 'G').gateway('G', [D(0), 'available'])
      .readingsCycle('G', D(1, 10), 'bq', 'quarantined');
    expect(s.at(D(1, 11)).collection).toBe('could_not_read');
  });

  it('a readings outcome whose batch is not yet resolved still shows readings, then could_not_read after the deadline', () => {
    const s = new Scenario().assign(D(0), 'G').gateway('G', [D(0), 'available'])
      .readingsCycle('G', D(1, 10), 'gone', 'missing');
    expect(s.at(D(2, 9)).collection).toBe('readings');
    expect(s.at(D(2, 10) + 1).collection).toBe('not_checked'); // resolved as could_not_read AND older than 24h
    const received = new Scenario().assign(D(0), 'G').gateway('G', [D(0), 'available'])
      .readingsCycle('G', D(1, 10), 'slow', 'received');
    expect(received.at(D(1, 12)).collection).toBe('readings');
  });

  it('collectionSince stays at the start of an unbroken run of the same value', () => {
    const s = twoGateways().cycle('G1', D(3, 12), 'no_readings').cycle('G1', D(4, 12), 'no_readings');
    expect(s.at(D(4, 13)).collectionSince).toBe(D(3, 12));
  });

  it('collectionSince for a never-checked sensor is its registration time', () => {
    const r = twoGateways().at(D(2));
    expect(r.collection).toBe('not_checked');
    expect(r.collectionSince).toBe(D(0));
  });

  it('collectionSince moves when coverage changes the value', () => {
    const s = new Scenario().assign(D(0), 'G').gateway('G', [D(0), 'available'], [D(2), 'stopped']);
    const r = s.at(D(3));
    expect(r.collection).toBe('collection_stopped');
    expect(r.collectionSince).toBe(D(2));
  });
});

describe('configuration versions', () => {
  it('quietDaysBeforeDormant 3 from the start gives dormant after 3 quiet days', () => {
    const s = workedExample(20);
    s.config = [{ effectiveAt: 0, settings: settings({ quietDaysBeforeDormant: 3 }) }];
    expect(view(s.at(D(4) - 1))).toMatchObject({ lifecycle: 'active', quiet: 2 });
    const r = s.at(D(4));
    expect(view(r)).toMatchObject({ lifecycle: 'dormant', since: D(4), quiet: 3, next: D(18) });
  });

  it('uses the settings in force when each wait starts, not later changes', () => {
    const s = workedExample(60);
    s.config = [
      { effectiveAt: 0, settings: DEFAULT_SETTINGS },
      { effectiveAt: D(10), settings: settings({ dormantWaitMs: 2 * DAY }) },
      { effectiveAt: D(20), settings: settings({ dormantWaitMs: 30 * DAY, samplingWindowMs: 24 * HOUR }) },
    ];
    // Dormant starts day 15 with the day-10 setting: a 2 day wait, then sampling at day 17.
    // The sampling window starts at day 17 with the default 72h; the day-20 change cannot touch it.
    const r = s.at(D(25));
    expect(r.transitions.map((t) => [t.to, t.effectiveAt])).toEqual([
      ['active', D(0, 12)], ['dormant', D(15)], ['sampling', D(17)], ['dormant', D(20)],
    ]);
    // The second dormant wait began at day 20, so it uses the new 30 day wait; then a 24h window.
    expect(r.nextEvaluationAt).toBe(D(50));
    expect(s.at(D(50)).nextEvaluationAt).toBe(D(51));
  });

  it('a lower sampling_cycles threshold retires after the first window', () => {
    const s = workedExample(40);
    s.config = [{ effectiveAt: 0, settings: settings({ samplingCyclesBeforeRetired: 1 }) }];
    const r = s.at(D(33));
    expect(r.transitions.at(-1)).toMatchObject({ to: 'retired', reason: 'no_readings', effectiveAt: D(32) });
  });
});

describe('same-instant ordering and what counts as a quiet day', () => {
  it('decommission beats a reading at the same instant', () => {
    const s = new Scenario().assign(D(0), 'G').gateway('G', [D(0), 'available'])
      .reading('G', D(2, 6), 'r').decommissioned(D(2, 6), 'removed');
    const r = s.at(D(3));
    expect(r.transitions.map((t) => t.rule)).toEqual(['operator_decommission']);
    expect(r.lifecycle).toBe('decommissioned');
  });

  it('loss of coverage beats a reading at the same instant', () => {
    const s = workedExample(10).gateway('G', [D(0), 'recoverable'], [D(0, 12), 'available'], [D(5, 9), 'dead'])
      .reading('G', D(5, 9), 'late-r');
    const r = s.at(D(6));
    expect(r.lifecycle).toBe('retired');
    expect(r.lifecycleReason).toBe('no_live_coverage');
    expect(r.transitions.map((t) => t.rule)).toEqual(['first_reading', 'no_live_coverage']);
  });

  it('coverage gained at the same instant as a reading is applied first, so the reading counts', () => {
    const s = new Scenario().assign(D(1), 'G').gateway('G', [D(0), 'dead'], [D(1), 'recoverable']).reading('G', D(1), 'r');
    expect(s.at(D(1, 1)).lifecycle).toBe('active');
  });

  it('a reading beats the dormant wait ending at the same instant', () => {
    const s = workedExample(40).reading('G', D(29), 'at-the-bell');
    const r = s.at(D(30));
    expect(r.transitions.slice(-1)[0]).toMatchObject({ from: 'dormant', to: 'active', rule: 'reading_wake', effectiveAt: D(29) });
    expect(r.transitions.map((t) => t.rule)).not.toContain('dormant_wait_elapsed');
  });

  it('a reading beats the sampling window ending at the same instant', () => {
    const s = workedExample(40).reading('G', D(32), 'at-the-bell');
    const r = s.at(D(33));
    expect(r.transitions.slice(-1)[0]).toMatchObject({ from: 'sampling', to: 'active', rule: 'reading_in_window' });
  });

  it('a reading at 00:00 sharp supersedes the day that just completed', () => {
    // Day 14 would be the 14th quiet day, completing at day 15 00:00; a reading taken at that
    // very instant is applied first and resets the count, so the sensor never goes dormant.
    const s = workedExample(20).reading('G', D(15), 'midnight');
    const r = s.at(D(15, 1));
    expect(view(r)).toMatchObject({ lifecycle: 'active', quiet: 0 });
    expect(r.transitions).toHaveLength(1);
  });

  it('a no_readings from a gateway that was not available at finished_at is not a quiet day', () => {
    // G is only connected from day 5 12:00; the earlier no_readings (e.g. late evidence) do not count.
    const s = new Scenario().assign(D(0), 'G')
      .gateway('G', [D(0), 'recoverable'], [D(5, 12), 'available'])
      .reading('G', D(0, 12), 'r0');
    for (let n = 1; n <= 8; n++) s.cycle('G', D(n, 12), 'no_readings');
    // Days 1-4 are unchecked (no_readings while recoverable). Day 5 12:00 onward is available.
    // Quiet: day 5 (cycle at exactly 12:00, class available), 6, 7 => 3 by day 8 00:00.
    expect(s.at(D(8)).quietCheckedDays).toBe(3);
    expect(s.at(D(5)).quietCheckedDays).toBe(0);
  });

  it('a stopped or dead gateway no_readings does not count as a window check', () => {
    const s = workedExample(14)
      .gateway('G', [D(0), 'recoverable'], [D(0, 12), 'available'], [D(15, 6), 'stopped']);
    s.cycle('G', D(29, 12), 'no_readings').cycle('G', D(30, 12), 'no_readings'); // while stopped
    // Dormant from day 15 00:00; the wait pauses at day 15 06:00 and never finishes.
    const r = s.at(D(40));
    expect(r.lifecycle).toBe('dormant');
    expect(r.nextEvaluationAt).toBeNull();
    expect(r.collection).toBe('collection_stopped');
  });
});

describe('nextCheckAt', () => {
  it('is the next 00:00 UTC for a plainly active sensor', () => {
    const r = workedExample(5).at(D(2, 13));
    expect(r.nextCheckAt).toBe(D(3));
  });

  it('is the 24h expiry of a counting outcome when that comes first', () => {
    const s = new Scenario().assign(D(0), 'G').gateway('G', [D(0), 'available']).cycle('G', D(2, 6), 'no_readings');
    expect(s.at(D(2, 7)).nextCheckAt).toBe(D(3)); // midnight comes before the expiry at day 3 06:00
    expect(s.at(D(3, 1)).nextCheckAt).toBe(D(3, 6) + 1); // now the expiry (just after 24h) is first
  });

  it('is the timer end when that comes before midnight', () => {
    const s = workedExample(40);
    s.config = [{ effectiveAt: 0, settings: settings({ dormantWaitMs: 36 * HOUR }) }];
    const r = s.at(D(16, 6));
    expect(r.lifecycle).toBe('dormant');
    expect(r.nextEvaluationAt).toBe(D(16, 12));
    expect(r.nextCheckAt).toBe(D(16, 12));
  });

  it('is the batch deadline of an unresolved outcome when that comes first', () => {
    const s = new Scenario().assign(D(0), 'G').gateway('G', [D(0), 'available'])
      .readingsCycle('G', D(2, 23), 'lost', 'missing');
    expect(s.at(D(3, 6)).nextCheckAt).toBe(D(3, 23));
    const after = s.at(D(3, 23));
    expect(after.nextCheckAt).toBe(D(3, 23) + 1); // the deadline has passed; next, that outcome expires
  });

  it('includes evidence dated slightly in the future', () => {
    const s = new Scenario().assign(D(0), 'G').gateway('G', [D(0), 'available']).reading('G', D(2, 6, 3), 'soon');
    expect(s.replay(D(2, 6)).nextCheckAt).toBe(D(2, 6, 3));
  });

  it('is null for a decommissioned sensor', () => {
    expect(workedExample(3).decommissioned(D(2), 'x').at(D(3)).nextCheckAt).toBeNull();
  });
});

describe('edge cases', () => {
  it('does nothing before the first midnight', () => {
    const s = new Scenario().assign(D(0), 'G').gateway('G', [D(0), 'available']);
    const r = s.at(D(0, 5));
    expect(r.transitions).toEqual([]);
    expect(r.nextCheckAt).toBe(D(1));
  });

  it('multiple readings in one day keep an active sensor at quiet 0 that day', () => {
    const s = workedExample(3).reading('G', D(2, 1), 'a').reading('G', D(2, 2), 'b');
    expect(s.at(D(2, 3)).quietCheckedDays).toBe(0);
    expect(s.at(D(3)).quietCheckedDays).toBe(0);
    expect(s.at(D(4)).quietCheckedDays).toBe(1);
  });

  it('unchecked days neither count nor reset', () => {
    const s = new Scenario().assign(D(0), 'G').gateway('G', [D(0), 'available']).reading('G', D(0, 12), 'r0');
    s.cycle('G', D(1, 12), 'no_readings').cycle('G', D(2, 12), 'no_readings')
      .cycle('G', D(3, 12), 'could_not_read').cycle('G', D(4, 12), 'timed_out')
      /* day 5: silence */.cycle('G', D(6, 12), 'no_readings');
    expect(s.at(D(3)).quietCheckedDays).toBe(2);
    expect(s.at(D(7)).quietCheckedDays).toBe(3);
  });

  it('a quarantined or unresolved readings outcome does not erase a quiet outcome of another gateway on a reading day', () => {
    // reading day beats everything
    const s = new Scenario().assign(D(0), 'G1', 'G2').gateway('G1', [D(0), 'available']).gateway('G2', [D(0), 'available'])
      .reading('G1', D(0, 12), 'r0')
      .cycle('G1', D(1, 12), 'no_readings').readingsCycle('G2', D(1, 13), 'lost', 'missing')
      .reading('G1', D(1, 14), 'r1');
    expect(view(s.at(D(2, 1)))).toMatchObject({ lifecycle: 'active', quiet: 0 });
  });

  it('an unresolved readings outcome beats a quiet outcome from another gateway (day waits)', () => {
    const s = new Scenario().assign(D(0), 'G1', 'G2')
      .gateway('G1', [D(0), 'available']).gateway('G2', [D(0), 'available']).reading('G1', D(0, 12), 'r0');
    s.cycle('G1', D(1, 12), 'no_readings').readingsCycle('G2', D(1, 13), 'lost', 'missing');
    // Day 1 completes at day 2 00:00 while the batch is still within its deadline.
    expect(s.at(D(2, 1)).quietCheckedDays).toBe(0);
    // After the deadline it is unchecked-or-quiet: it resolves as could_not_read, and the
    // no_readings from G1 then makes day 1 a quiet day.
    expect(s.at(D(2, 14)).quietCheckedDays).toBe(1);
  });

  it('survives gateways that have no log (dead) and unknown assignments', () => {
    const s = new Scenario().assign(D(0), 'ghost');
    expect(s.at(D(3)).coverage).toBe('none');
  });

  it('each lifecycle-change rule name is one of the spec names', () => {
    const rules = new Set(workedExample(60).at(D(60)).transitions.map((t) => t.rule));
    for (const rule of rules) {
      expect([
        'first_reading', 'reading_wake', 'reading_in_window', 'quiet_days', 'dormant_wait_elapsed',
        'sampling_window_checked', 'sampling_retired', 'sampling_window_restart', 'no_live_coverage',
        'coverage_restored', 'operator_decommission',
      ]).toContain(rule);
    }
  });
});

describe('evidence dated before the first assignment', () => {
  // Registered and assigned at day 0 12:05; the gateway's evidence is dated a few minutes earlier.
  const build = () => new Scenario()
    .assign(D(0, 12, 5), 'G')
    .gateway('G', [0, 'recoverable'], [D(0, 12), 'available'])
    .readingsCycle('G', D(0, 12), 'b0', 'processed')
    .reading('G', D(0, 11, 55), 'early', 'b0');

  it('a reading taken before the PUT still wakes the sensor, at its taken_at', () => {
    const s = build();
    s.registeredAt = D(0, 12, 5);
    const r = s.at(D(0, 12, 10));
    expect(view(r)).toMatchObject({ lifecycle: 'active', since: D(0, 11, 55), coverage: 'available', collection: 'readings' });
    expect(r.transitions).toEqual([
      { from: 'pending', to: 'active', reason: null, effectiveAt: D(0, 11, 55), rule: 'first_reading', evidenceIds: ['early'] },
    ]);
  });

  it('the coverage axis still starts at the PUT (server time)', () => {
    const s = build();
    s.registeredAt = D(0, 12, 5);
    expect(s.at(D(0, 12, 10)).coverageSince).toBe(D(0, 12, 5));
  });

  it('only the first assignment counts from the epoch: a later one keeps its server time', () => {
    const s = new Scenario()
      .assign(D(0), 'G').assign(D(5)).assign(D(8), 'G')
      .gateway('G', [0, 'available'])
      .reading('G', D(7), 'while-unassigned');
    const r = s.at(D(9));
    expect(r.transitions).toEqual([]); // the reading at day 7 had no coverage: stays pending
    expect(view(r)).toMatchObject({ lifecycle: 'pending', coverage: 'available' });
  });

  it('an empty assignment before the first real one carries nothing', () => {
    const s = new Scenario().assign(D(1)).assign(D(2), 'G').gateway('G', [0, 'available']).reading('G', D(1, 12), 'r');
    expect(s.at(D(3)).lifecycle).toBe('active');
  });
});

describe('a sampling window with an unresolved readings outcome', () => {
  // The worked example, but on day 31 G reports readings whose batch has arrived and is not
  // processed yet. The day-29 window ends at day 32 00:00.
  const build = (batch: BatchStatus | 'missing') => {
    const s = workedExample(30).readingsCycle('G', D(31, 12), 'b31', batch);
    for (let n = 32; n <= 40; n++) s.cycle('G', D(n, 12), 'no_readings');
    return s;
  };
  const beforeEnd = build('received').at(D(31, 23));

  it('waits at the window end: still sampling, no transition, cycles unchanged', () => {
    const r = build('received').at(D(32, 6));
    expect(view(r)).toMatchObject({ lifecycle: 'sampling', since: D(29), cycles: 0 });
    expect(r.transitions).toEqual(beforeEnd.transitions);
  });

  it('a batch that never arrives: waits until the deadline, which wakes it, then dormant at the window end', () => {
    const waiting = build('missing').at(D(32, 6));
    expect(waiting.lifecycle).toBe('sampling');
    expect(waiting.nextCheckAt).toBe(D(32, 12));
    const r = build('missing').at(D(32, 12));
    expect(view(r)).toMatchObject({ lifecycle: 'dormant', since: D(32), cycles: 1, next: D(46) });
  });

  it('processed with a reading inside the window: active at taken_at, history only grows (no correction)', () => {
    const s = build('processed').reading('G', D(31, 11, 58), 'r31', 'b31');
    const r = s.at(D(32, 7));
    expect(view(r)).toMatchObject({ lifecycle: 'active', since: D(31, 11, 58) });
    expect(r.transitions.slice(0, beforeEnd.transitions.length)).toEqual(beforeEnd.transitions);
    expect(r.transitions.at(-1)).toMatchObject({ from: 'sampling', to: 'active', rule: 'reading_in_window' });
  });

  it('quarantined: dormant at the window end (day 32 00:00) with cycles 1', () => {
    const r = build('quarantined').at(D(32, 7));
    expect(view(r)).toMatchObject({ lifecycle: 'dormant', since: D(32), cycles: 1 });
    expect(r.transitions.at(-1)).toMatchObject({ rule: 'sampling_window_checked', effectiveAt: D(32) });
    expect(r.transitions.slice(0, beforeEnd.transitions.length)).toEqual(beforeEnd.transitions);
  });

  it('a window restart (no check) waits too', () => {
    const s = new Scenario().assign(D(0), 'G').gateway('G', [D(0), 'available'])
      .readingsCycle('G', D(0, 12), 'b0', 'processed').reading('G', D(0, 12), 'r0', 'b0');
    for (let n = 1; n <= 14; n++) s.cycle('G', D(n, 12), 'no_readings');
    s.readingsCycle('G', D(30, 12), 'b30', 'retrying');
    expect(view(s.at(D(33)))).toMatchObject({ lifecycle: 'sampling', since: D(29) });
    s.batches.b30.status = 'quarantined';
    expect(s.at(D(33)).transitions.at(-1)).toMatchObject({ rule: 'sampling_window_restart', effectiveAt: D(32) });
  });
});

describe('a batch that arrives after its deadline', () => {
  const base = () => {
    const s = new Scenario().assign(D(0), 'G').gateway('G', [D(0), 'available'])
      .readingsCycle('G', D(0, 12), 'b0', 'processed').reading('G', D(0, 12), 'r0', 'b0');
    for (let n = 1; n <= 13; n++) s.cycle('G', D(n, 12), 'no_readings');
    return s;
  };

  it('the day resolved at the deadline stays resolved while the late batch is only received', () => {
    // Day 14's batch arrives on day 16 06:00, after its deadline (day 15 12:00).
    const s = base().readingsCycle('G', D(14, 12), 'late', 'received', D(16, 6));
    for (let n = 15; n <= 20; n++) s.cycle('G', D(n, 12), 'no_readings');
    expect(view(s.at(D(16)))).toMatchObject({ lifecycle: 'dormant', since: D(16) });
    // Received but not processed yet: day 14 does not become unresolved again.
    const r = s.at(D(16, 7));
    expect(view(r)).toMatchObject({ lifecycle: 'dormant', since: D(16) });
    expect(r.transitions).toEqual(s.at(D(16)).transitions);
  });

  it('one that arrived in time but is still retrying stays unresolved past the deadline', () => {
    const s = base().readingsCycle('G', D(14, 12), 'slow', 'retrying', D(14, 13));
    for (let n = 15; n <= 20; n++) s.cycle('G', D(n, 12), 'no_readings');
    expect(view(s.at(D(17)))).toMatchObject({ lifecycle: 'active', quiet: 13 });
  });
});
