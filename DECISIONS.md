# Decisions

Backend: Node 22 + Express + TypeScript + PostgreSQL (`pg`, plain SQL). The employer agreed
to Express in place of Django/DRF; every rule and endpoint of the brief is unchanged. The
longer blueprint is `docs/DESIGN.md`.

## State and time

* **Evidence is append-only** (heartbeats, cycles, batches, readings, commands, assignment
  and gateway state logs), and so is `timeline`. Current state is a projection on
  `gateways` / `sensors`.
* **Gateways are a forward-only state machine**, never recomputed backwards (brief). Each
  change of status or command state writes a `gateway_state_log` row with its coverage
  class: that log is the coverage history.
* **Sensors are a pure replay.** `replaySensor(input)` takes all evidence, the coverage
  history, operator actions and versioned config, and replays the sensor from registration
  to `now`, with no DB or clock. Live updates, timers, late data and clock jumps all replay
  again and compare with the stored history.
* **Clocks.** `clock.ts` is the only clock reader. Entries carry `effective_at` (event, due
  or server time, per the brief) and `recorded_at`.
* **One writer.** Every change runs in a transaction holding one advisory lock; only the
  `PUT /gw/v1/batches` insert skips it, to answer 202 at once.

## Where each rule lives (`server/src/domain/`)

| Rule | File |
|---|---|
| Gateway status, operator actions; stop/resume, acks, `collecting_after_stop` | `gateway.ts`, `commands.ts` |
| Coverage class, state log; cycles; batches, retries, duplicates | `coverage.ts`, `cycles.ts`, `batches.ts` |
| Sensor days, quiet counts, waits, windows, collection | `sensorEngine.ts`, `sensorEngineHelpers.ts` |
| History diff and corrections; due work and test clock | `sensorStore.ts`, `work.ts` |

## Retries, late data, corrections

* **Background work is a DB-backed due-work loop.** `runDueWork(now)` takes the earliest due
  item (batch, retry, stale timer, command timeout), handles it at its due time, repeats,
  then replays sensors whose `next_check_at` passed. The `worker` runs it every second in
  live mode; in test mode only the test endpoints do.
* **Retries:** attempt k waits 2^(k-1) min; the 5th failure quarantines (`processing_failed`).
  One attempt is one transaction, so nothing double-counts. First processed reading id wins.
* **Idempotency:** cycles and batches are keyed by id plus a hash of the canonical body;
  an identical repeat is 200, a different one 409. Acks are idempotent.
* **Corrections:** new history H′ vs stored H. Equal: nothing. H a prefix of H′: append the
  new transitions. Otherwise one `correction` entry with old and new state, replaced and
  recomputed transitions and the causing evidence ids. `lifecycle_since` comes from H′.

## Interpretations

1. **The worked example needs G to stay connected.** One cycle a day makes G `stale` every
   night (12-hour rule), pausing S's timers. We apply the rules as written; the end-to-end
   test keeps G connected with a cycle every 8 hours for a second sensor.
2. Quiet days and window checks need the gateway `available` at `finished_at`. A 14th quiet
   day while coverage is not available keeps S `active` until coverage returns.
3. An unresolved day stops quiet counting; a sampling window whose span holds an unresolved
   readings outcome waits, then is evaluated effective at the window end.
4. "Without it arriving": a batch that arrived in time but is still `received`/`retrying`
   keeps its day unresolved past 24 h. One that arrives after `finished_at + 24h` did not
   arrive in time: the day stays `could_not_read` until the batch ends (readings then
   correct it as late data).
5. **A sensor's first assignment counts from the epoch** for the lifecycle replay, like a
   gateway's first log row: devices report after the fact, so evidence dated before the
   PUT still finds coverage. Later changes keep server time; the coverage axis shows the
   PUT time; an unassigned sensor stays `pending`/`none`.
6. While coverage is `none`, readings change no lifecycle. `retired (no_readings)` stays
   when coverage drops to `none`; only active/dormant/sampling retire (`no_live_coverage`).
7. `spare` is not in the coverage table; a spare gateway covers nothing: `recoverable`.
8. Stop is 409 only in `stop_pending`/`stopped`, resume only in `running`, so other states
   re-issue. A stop period uses recorded `acked_at` values, superseded acks included: from
   a stop's ack to the ack of the next resume by seq. A superseded ack never changes state.
9. A stale gateway ignores evidence older than 12 hours entirely, even `last_qualifying_at`.
10. A cycle result for a sensor the gateway does not cover is `ignored`, not 404. A batch for
    an unknown sensor is 202, then quarantined (`unknown_sensor`).
11. Gateway transitions are never earlier than its previous change. A decommissioned sensor
    is frozen. An ack is effective at `acked_at` (≥ `issued_at`).
12. Timelines return a bare JSON array: the brief names no wrapper there, unlike `commands`.

## Trade-offs

* No 503/Retry-After load shedding; every write is idempotent, so retries are safe.
* A replay is O(sensor history); production would snapshot per day.
* Coverage/collection flips inside one clock jump are recorded as the net change.
* The single write lock trades throughput for provable ordering.
* Console filters are simple; no pagination, no UI tests.

## What I know is wrong or weak

* Default `docker compose up` runs `TEST_MODE=1`, so the worker idles; use `TEST_MODE=0`
  for live mode.
* Config is versioned, but no API changes it, so `rule_change` entries are never written.
* In live mode a batch's processed time is its due time, up to a second early.
* Late batches for a decommissioned sensor are stored but not shown on its timeline.
* A reading taken after a held window end wakes the sensor at once; when the batch resolves,
  the replay inserts the window result first, so that history is recorded as a correction.
