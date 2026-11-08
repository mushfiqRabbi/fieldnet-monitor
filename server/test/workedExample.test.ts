import { describe, expect, it } from 'vitest';
import {
  DAY, HOUR, T0, addGateway, addSensor, api, cover, cycle, gateway, iso, putBatch, reading, sensor, setClock,
  timeline, useCleanDatabase,
} from './helpers';

// The brief's worked example and its three variations, played through the HTTP API only.
//
// The brief says G is "connected and running" and reports S once a day at 12:00. By the 12-hour stale
// rule one cycle a day is not enough to stay connected (G would be stale from 00:00 to 12:00 every night,
// which pauses S's timers). So G also covers S2 and sends a cycle for S2 every 8 hours (04:00 and 20:00).
// S itself is reported only in the 12:00 cycle, exactly as the example says.

useCleanDatabase();

const DAY0 = T0 - 12 * HOUR; // day 0, 00:00 UTC
/** Day n at the given hour (day n means 00:00 UTC on the n-th day after day 0). */
const at = (day: number, hour = 0) => DAY0 + day * DAY + hour * HOUR;

/** Reset, put the clock at day 0 00:00, and register G, S and S2. Returns G's token. */
async function startRun(): Promise<string> {
  await api().post('/test/reset').expect(200);
  await setClock(at(0));
  const token = await addGateway('G');
  await addSensor('S');
  await addSensor('S2');
  await cover('S', ['G']).expect(200);
  await cover('S2', ['G']).expect(200);
  return token;
}

/** Cycle events carry their own time, so move the clock first, then send. */
async function s2Cycle(token: string, day: number, hour: number) {
  await setClock(at(day, hour));
  const res = await cycle(token, `s2-${day}-${hour}`, at(day, hour), [{ sensor_id: 'S2', outcome: 'no_readings' }]);
  expect(res.status).toBe(202);
  expect(res.body).toEqual({ ignored: [] });
}

async function sReport(token: string, day: number, session = 'ok') {
  await setClock(at(day, 12));
  const res = await cycle(token, `s-${day}`, at(day, 12), [{ sensor_id: 'S', outcome: 'no_readings' }], session);
  expect(res.status).toBe(202);
}

/** One normal day: S2 at 04:00, S at 12:00, S2 at 20:00. `after` runs after each piece of evidence. */
async function playDay(token: string, day: number, after: (hour: number) => Promise<void> = async () => {}) {
  await s2Cycle(token, day, 4);
  await after(4);
  await sReport(token, day);
  await after(12);
  await s2Cycle(token, day, 20);
  await after(20);
}

/** Day 0: S2 at 04:00, then the first reading of S at 12:00 (batch processed at 12:01), S2 at 20:00. */
async function playDay0(token: string) {
  await s2Cycle(token, 0, 4);
  await setClock(at(0, 12));
  await putBatch(token, 'b0', 'S', [reading('r0', at(0, 12))]).expect(202);
  const res = await cycle(token, 's-0', at(0, 12), [{ sensor_id: 'S', outcome: 'readings', batch_id: 'b0' }]);
  expect(res.status).toBe(202);
  expect(await sensor('S')).toMatchObject({ lifecycle: 'pending' }); // the batch is not processed yet
  await setClock(at(0, 12) + 60_000); // processed at 12:01
  await s2Cycle(token, 0, 20);
}

/** What S should say at (any time during) day d, for the main run. */
function mainRunState(d: number) {
  const s = (lifecycle: string, since: number, quiet: number, cycles: number, next: number | null, reason: string | null = null) => ({
    lifecycle, lifecycle_reason: reason, lifecycle_since: iso(since), quiet_checked_days: quiet,
    sampling_cycles_done: cycles, next_evaluation_at: next === null ? null : iso(next),
  });
  if (d <= 14) return s('active', at(0, 12), d - 1, 0, null);
  if (d <= 28) return s('dormant', at(15), 14, 0, at(29));
  if (d <= 31) return s('sampling', at(29), 14, 0, at(32));
  if (d <= 45) return s('dormant', at(32), 14, 1, at(46));
  if (d <= 48) return s('sampling', at(46), 14, 1, at(49));
  return s('retired', at(49), 14, 2, null, 'no_readings');
}

/** The lifecycle entries of S as [kind, from, to, rule, effective_at]. */
async function lifecycleEntries() {
  const entries = (await timeline('sensors', 'S')).filter((e) => e.axis === 'lifecycle');
  return entries.map((e) => [e.kind, e.from, e.to, e.rule, e.effective_at]);
}

describe('worked example, day 0 to day 49', () => {
  it('follows the brief row by row, with G connected the whole time', async () => {
    const token = await startRun();
    await playDay0(token);
    expect(await sensor('S')).toMatchObject({
      lifecycle: 'active', lifecycle_since: iso(at(0, 12)), quiet_checked_days: 0, coverage: 'available', collection: 'readings',
    });
    expect((await api().get('/api/v1/batches/b0')).body).toMatchObject({ processing: 'processed', accepted_count: 1 });

    for (let d = 1; d <= 48; d++) {
      // Midnight: day d-1 has just completed.
      await setClock(at(d));
      const expected = mainRunState(d);
      const midnight = await sensor('S');
      expect(midnight, `day ${d} 00:00`).toMatchObject({
        ...expected, coverage: 'available', collection: d === 1 ? 'readings' : 'no_readings',
      });
      expect((await gateway('G')).status, `G at day ${d} 00:00`).toBe('connected');

      await playDay(token, d, async (hour) => {
        expect(await sensor('S'), `day ${d} ${hour}:00`).toMatchObject({ ...expected, coverage: 'available' });
        expect((await gateway('G')).status, `G at day ${d} ${hour}:00`).toBe('connected');
      });
      // After S's 12:00 report its collection is no_readings (the day-0 readings outcome is gone by then).
      expect((await sensor('S')).collection).toBe('no_readings');
    }

    // Day 49, 00:00: the second window ends with checks and no reading.
    await setClock(at(49));
    expect(await sensor('S')).toMatchObject({ ...mainRunState(49), coverage: 'available' });
    expect((await sensor('S')).lifecycle_reason).toBe('no_readings');
    // Nothing brings it back by itself.
    await sReport(token, 49);
    expect(await sensor('S')).toMatchObject({ lifecycle: 'retired', lifecycle_reason: 'no_readings' });

    // Every transition is recorded once, at the brief's time, with no corrections.
    expect(await lifecycleEntries()).toEqual([
      ['transition', 'pending', 'active', 'first_reading', iso(at(0, 12))],
      ['transition', 'active', 'dormant', 'quiet_days', iso(at(15))],
      ['transition', 'dormant', 'sampling', 'dormant_wait_elapsed', iso(at(29))],
      ['transition', 'sampling', 'dormant', 'sampling_window_checked', iso(at(32))],
      ['transition', 'dormant', 'sampling', 'dormant_wait_elapsed', iso(at(46))],
      ['transition', 'sampling', 'retired', 'sampling_retired', iso(at(49))],
    ]);
  });

  it('records the brief times even when the clock jumps over them', async () => {
    const token = await startRun();
    await playDay0(token);
    for (let d = 1; d <= 13; d++) await playDay(token, d);
    // Day 14 is the last day G reports. Its 20:00 cycle keeps G connected until day 15, 08:00.
    await playDay(token, 14);
    expect(await sensor('S')).toMatchObject({ lifecycle: 'active', quiet_checked_days: 13 });

    await setClock(at(20)); // one jump, five days past the transition
    expect(await sensor('S')).toMatchObject({
      lifecycle: 'dormant', lifecycle_since: iso(at(15)), quiet_checked_days: 14,
      coverage: 'recoverable', collection: 'not_checked', next_evaluation_at: null,
    });
    const lifecycle = await lifecycleEntries();
    expect(lifecycle.at(-1)).toEqual(['transition', 'active', 'dormant', 'quiet_days', iso(at(15))]);

    // G went stale 12 hours after its last evidence (day 14, 20:00), at its own due time, not at the jump.
    expect(await gateway('G')).toMatchObject({ status: 'stale', status_since: iso(at(15, 8)) });
    const gatewayStatus = (await timeline('gateways', 'G')).filter((e) => e.axis === 'status').at(-1);
    expect(gatewayStatus).toMatchObject({ from: 'connected', to: 'stale', effective_at: iso(at(15, 8)) });

    // Day 20, 12:00: a good cycle. The dormant wait had run 8 hours (day 15 00:00 to 08:00), so
    // 14 days minus 8 hours remain and it resumes now.
    await sReport(token, 20);
    expect(await sensor('S')).toMatchObject({
      lifecycle: 'dormant', coverage: 'available', collection: 'no_readings', next_evaluation_at: iso(at(34, 4)),
    });
    expect(await gateway('G')).toMatchObject({ status: 'connected', status_since: iso(at(20, 12)) });
  });

  it('defers dormant when G goes stale at the very instant day 14 completes (coverage change goes first)', async () => {
    const token = await startRun();
    await playDay0(token);
    for (let d = 1; d <= 13; d++) await playDay(token, d);
    await s2Cycle(token, 14, 4);
    await sReport(token, 14); // G's last evidence: day 14, 12:00, so it goes stale at day 15, 00:00
    await setClock(at(20));
    expect(await gateway('G')).toMatchObject({ status: 'stale', status_since: iso(at(15)) });
    // At 00:00 the coverage loss fires before the day boundary, so the sensor cannot go dormant yet.
    expect(await sensor('S')).toMatchObject({ lifecycle: 'active', coverage: 'recoverable', next_evaluation_at: null });
    // G is back at day 20, 12:00: the deferred move happens at that time.
    await sReport(token, 20);
    expect(await sensor('S')).toMatchObject({ lifecycle: 'dormant', lifecycle_since: iso(at(20, 12)) });
  });
});

describe('variation: disconnection mid-window', () => {
  it('pauses the window with 36 hours left and ends it on day 39, 00:00', async () => {
    const token = await startRun();
    await playDay0(token);
    for (let d = 1; d <= 29; d++) await playDay(token, d);
    expect(await sensor('S')).toMatchObject({ lifecycle: 'sampling', lifecycle_since: iso(at(29)), next_evaluation_at: iso(at(32)) });

    // Day 30: the 04:00 cycle is fine, then at 12:00 G reports auth_failed.
    await s2Cycle(token, 30, 4);
    await sReport(token, 30, 'auth_failed');
    expect(await gateway('G')).toMatchObject({ status: 'disconnected', disconnected_since: iso(at(30, 12)) });

    const paused = async (label: string) => {
      expect(await sensor('S'), label).toMatchObject({
        lifecycle: 'sampling', lifecycle_since: iso(at(29)), next_evaluation_at: null,
        collection: 'not_checked', coverage: 'recoverable', sampling_cycles_done: 0,
      });
    };
    await paused('right after the failure');
    // A week with no evidence at all (the clock steps through it, nothing is sent).
    for (let d = 31; d <= 36; d++) {
      await setClock(at(d));
      await paused(`day ${d} 00:00`);
      await setClock(at(d, 12));
      await paused(`day ${d} 12:00`);
    }
    await setClock(at(37, 11));
    await paused('day 37 11:00');
    expect((await gateway('G')).status).toBe('disconnected');

    // Day 37, 12:00: a good cycle. G is connected again and the window resumes with 36 hours left.
    await sReport(token, 37);
    expect(await gateway('G')).toMatchObject({ status: 'connected', disconnected_since: null });
    expect(await sensor('S')).toMatchObject({
      lifecycle: 'sampling', coverage: 'available', collection: 'no_readings', next_evaluation_at: iso(at(39)),
    });

    // Keep G alive until the window ends on day 39, 00:00.
    await s2Cycle(token, 37, 20);
    await s2Cycle(token, 38, 4);
    await sReport(token, 38);
    await s2Cycle(token, 38, 20);
    expect(await sensor('S')).toMatchObject({ lifecycle: 'sampling', next_evaluation_at: iso(at(39)) });
    await setClock(at(39));
    expect(await sensor('S')).toMatchObject({
      lifecycle: 'dormant', lifecycle_since: iso(at(39)), sampling_cycles_done: 1, next_evaluation_at: iso(at(53)),
    });
    const lifecycle = await lifecycleEntries();
    expect(lifecycle.at(-1)).toEqual(['transition', 'sampling', 'dormant', 'sampling_window_checked', iso(at(39))]);
    // S stayed sampling throughout: no lifecycle entry between day 29 and day 39.
    expect(lifecycle.map((e) => e[4]).filter((t) => t > iso(at(29)) && t < iso(at(39)))).toEqual([]);
  });
});

describe('variation: a late reading', () => {
  it('is active again with quiet_checked_days 10 after a day-9 reading arrives on day 20', async () => {
    const token = await startRun();
    await playDay0(token);
    for (let d = 1; d <= 19; d++) await playDay(token, d);
    await s2Cycle(token, 20, 4);
    await sReport(token, 20);
    const lastQualifying = (await gateway('G')).last_qualifying_at;
    expect(await sensor('S')).toMatchObject({ lifecycle: 'dormant', lifecycle_since: iso(at(15)), quiet_checked_days: 14 });

    // Day 20: G uploads a batch holding a reading taken on day 9.
    await putBatch(token, 'late', 'S', [reading('late-r', at(9, 12))]).expect(202);
    await api().post('/test/drain').expect(200);

    expect(await sensor('S')).toMatchObject({
      lifecycle: 'active', lifecycle_reason: null, lifecycle_since: iso(at(0, 12)), quiet_checked_days: 10,
      sampling_cycles_done: 0, next_evaluation_at: null,
    });
    // A late batch is older than what G already reported, so it does not move last_qualifying_at.
    expect(await gateway('G')).toMatchObject({ status: 'connected', last_qualifying_at: lastQualifying });

    const entries = (await timeline('sensors', 'S')).filter((e) => e.axis === 'lifecycle');
    expect(entries.map((e) => [e.kind, e.from, e.to])).toEqual([
      ['transition', 'pending', 'active'],
      ['transition', 'active', 'dormant'], // the day-15 entry is never edited
      ['correction', 'dormant', 'active'],
    ]);
    expect(entries[1]).toMatchObject({ rule: 'quiet_days', effective_at: iso(at(15)), evidence_ids: [] });
    expect(entries[2].evidence_ids).toEqual(['late-r']);
    expect(entries[2].effective_at).toBe(iso(at(15))); // where the recomputed history first differs

    // The recompute moved the later timers: days 10-23 are 14 quiet days, so dormant on day 24, 00:00.
    await s2Cycle(token, 20, 20);
    for (let d = 21; d <= 23; d++) await playDay(token, d);
    expect(await sensor('S')).toMatchObject({ lifecycle: 'active', quiet_checked_days: 13 });
    await setClock(at(24));
    expect(await sensor('S')).toMatchObject({
      lifecycle: 'dormant', lifecycle_since: iso(at(24)), quiet_checked_days: 14, next_evaluation_at: iso(at(38)),
    });
  });
});

describe('variation: an unresolved day', () => {
  it('waits for the batch that never arrives, then goes dormant on day 16, 00:00', async () => {
    const token = await startRun();
    await playDay0(token);
    for (let d = 1; d <= 13; d++) await playDay(token, d);

    // Day 14: G reports readings for S, but the batch never arrives.
    await s2Cycle(token, 14, 4);
    await setClock(at(14, 12));
    const res = await cycle(token, 's-14', at(14, 12), [{ sensor_id: 'S', outcome: 'readings', batch_id: 'never' }]);
    expect(res.status).toBe(202);
    await s2Cycle(token, 14, 20);
    expect(await sensor('S')).toMatchObject({ lifecycle: 'active', quiet_checked_days: 13 });

    // Day 15, 00:00: day 14 completes but is unresolved, so nothing is evaluated.
    await setClock(at(15));
    expect(await sensor('S')).toMatchObject({ lifecycle: 'active', lifecycle_since: iso(at(0, 12)), quiet_checked_days: 13 });
    await s2Cycle(token, 15, 4);
    expect(await sensor('S')).toMatchObject({ lifecycle: 'active', quiet_checked_days: 13 });

    // Day 15, 12:00: the batch deadline (24 hours after the cycle) passes. Day 14 is now unchecked.
    // It is not a quiet day, so S is still active.
    await setClock(at(15, 12));
    expect(await sensor('S')).toMatchObject({ lifecycle: 'active', quiet_checked_days: 13 });
    await sReport(token, 15);
    await s2Cycle(token, 15, 20);
    expect(await sensor('S')).toMatchObject({ lifecycle: 'active', quiet_checked_days: 13 });

    // Day 16, 00:00: day 15 completes as a quiet day, the 14th, so S goes dormant.
    await setClock(at(16));
    expect(await sensor('S')).toMatchObject({
      lifecycle: 'dormant', lifecycle_since: iso(at(16)), quiet_checked_days: 14, next_evaluation_at: iso(at(30)),
    });
    const lifecycle = await lifecycleEntries();
    expect(lifecycle).toEqual([
      ['transition', 'pending', 'active', 'first_reading', iso(at(0, 12))],
      ['transition', 'active', 'dormant', 'quiet_days', iso(at(16))],
    ]);
  });
});
