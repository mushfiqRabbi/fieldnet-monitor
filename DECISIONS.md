# Decisions

Backend: Node 22 + Express + TypeScript + PostgreSQL (`pg`, plain SQL). The employer agreed
to Express in place of Django/DRF; every rule and endpoint of the brief is unchanged. The
longer blueprint is `docs/DESIGN.md`.

## How state and time are modelled

* **Evidence is append-only** (`heartbeats`, `cycles`, `cycle_results`, `batches`,
  `readings`, `commands`, `sensor_assignment_log`, `gateway_state_log`). Current state is a
  projection on `gateways` / `sensors`. The `timeline` table is append-only too.
* **Gateways are a forward-only state machine** (`domain/gateway.ts`, `domain/commands.ts`),
  as the brief says: gateway status is never recomputed backwards. Every change of status or
  command state also writes a `gateway_state_log` row with its derived coverage class.
  That log is the **coverage history**.
* **Sensors are a pure replay** (`domain/sensorEngine.ts`). `replaySensor(input)` takes all
  evidence, the coverage history, operator actions and the versioned config, and replays the
  sensor from registration to `now`. It never touches the DB or the clock. Live updates, timers,
  late data and test-clock jumps all go through the same path: replay again, then compare with
  the history we hold (`domain/sensorStore.ts`).
* **Clocks.** `clock.ts` is the only reader of the wall clock; in test mode it returns the test
  clock. Engine code uses epoch ms. Each change carries `effective_at` (when it happened by the
  brief's rules: event time, due time or server time, per the brief's clock table) and
  `recorded_at` (server clock when we wrote it).
* **One writer at a time.** Every state change runs in a transaction holding one Postgres
  advisory lock, so requests, operator actions and background work never interleave. The only
  exception is the insert in `PUT /gw/v1/batches`, so it can answer 202 at once.

## Where each rule lives

| Rule | File |
|---|---|
| Gateway status, operator actions, unsuspend derivation | `domain/gateway.ts` |
| Stop/resume, acks, timeouts, `collecting_after_stop` | `domain/commands.ts` |
| Coverage class, state log, which sensors to recompute | `domain/coverage.ts` |
| Cycle ingestion, idempotency, ignored sensors | `domain/cycles.ts` |
| Batch validation, retries, quarantine, duplicate readings | `domain/batches.ts` |
| Sensor days, quiet counts, waits, windows, collection | `domain/sensorEngine.ts` + `sensorEngineHelpers.ts` |
| History diff, transitions vs correction entries | `domain/sensorStore.ts` |
| Background work and the test clock | `domain/work.ts`, `routes/testApi.ts` |

## Background work, retries, late data, corrections

* **Background work is a DB-backed due-work loop**, not a job queue. `runDueWork(now)` finds
  the earliest due item ≤ now (batch to process, retry, stale timer, command timeout),
  handles it **at its due time**, and repeats. Then it replays the sensors whose `next_check_at`
  has passed. The `worker` service calls it every second in live mode. In test mode only
  `/test/clock` and `/test/drain` call it, so every transition gets its own due time, never the
  jump time. Sensor timers need no queue, because the replay produces them.
* **Retries:** a failed attempt k waits 2^(k-1) minutes; the 5th failure quarantines the batch
  with `processing_failed`. One attempt is one transaction, so a retried batch never
  double-counts. Reading ids are globally unique: first processed wins, same content is ignored,
  different content is quarantined as `conflicting_duplicate`.
* **Idempotency:** cycles are keyed by (gateway, cycle_id) and batches by batch_id, with a hash
  of the canonical JSON body. An identical repeat is 200 and changes nothing; a different body
  is 409. Acks are idempotent.
* **Corrections:** after each replay we compare the new transition list H′ with the stored H.
  Equal: nothing. H is a prefix of H′: append the new transitions (normal progress). Otherwise:
  **one** `correction` entry with the old and new current state, the replaced and the
  recomputed transitions, and the evidence ids that caused it. Old entries are never edited;
  `lifecycle_since` comes from the last transition of H′.

## Interpretations

1. **The worked example needs G to stay connected.** With one cycle a day at 12:00, the brief's
   12-hour rule makes G `stale` from 00:00 to 12:00 every night. Its coverage becomes
   `recoverable` and S's timers pause, so the example's dates would not hold. The brief also
   counts 36 hours from day 29 00:00 to day 30 12:00, which only works if G was available all
   along. We apply the rules as written. Our end-to-end test keeps G connected the realistic
   way: G sends a cycle every 8 hours for a second sensor, and reports S at 12:00 as in the
   example.
2. Quiet days and window checks need the reporting gateway to be `available` at the outcome's
   `finished_at`. If the 14th quiet day completes while coverage is not available, the sensor
   stays `active` ("lifecycle unchanged") and goes dormant the moment coverage is available again.
3. An unresolved day stops quiet counting until a later replay sees it resolved, or until a
   reading resets the count. A batch that has arrived but is still `received`/`retrying` stays
   unresolved; one that has not arrived resolves as `could_not_read` at `finished_at + 24h`.
4. While coverage is `none`, readings are kept but change no lifecycle (the coverage table lists
   "readings still wake it" only for `stopped`/`recoverable`). `retired (no_readings)` stays as
   it is when coverage drops to `none`; only `active`/`dormant`/`sampling` retire with
   `no_live_coverage`.
5. `spare` is not in the coverage table; a spare gateway covers nothing, so we call it `recoverable`.
6. Commands: `stop` is 409 only in `stop_pending`/`stopped`, `resume` only in `running` (as
   written). So stop from `stop_failed` and resume from `resume_pending`/`resume_failed` re-issue
   the command (new seq, new timeout). A stop period starts only at an ack that changed the state.
7. A stale gateway ignores qualifying evidence older than 12 hours entirely ("updates
   nothing"), including `last_qualifying_at`. "Within the last 12 hours" is strict.
8. A cycle result for a sensor the gateway does not cover, including an unknown id, is listed
   in `ignored` (not 404). A batch for an unknown sensor is accepted (202) and then quarantined
   (`unknown_sensor`), as the batch section says.
9. Gateway transition times are never earlier than the gateway's previous change, so its
   history stays ordered when device clocks disagree. A decommissioned sensor is frozen: later
   evidence is stored but never replayed.
10. `effective_at` for an ack is `acked_at` (clamped to ≥ `issued_at`). For a heartbeat, the
    auth-failure time is `sent_at`. `last_heartbeat_at` is the received time (brief).

## Trade-offs (documented compromises)

* **No 503/Retry-After load shedding.** Every write is idempotent, so a client retry is safe.
* **A sensor replay is O(its history).** It is fine for this scale. In production I would
  snapshot the replay state per day and replay only from the earliest affected snapshot.
* **The timeline collapses coverage/collection flips.** If coverage or collection changes
  several times inside one clock jump, we record the net change, effective when the current
  value began. Lifecycle transitions are never collapsed.
* **The single global write lock** trades throughput for simple, provable ordering.
* Console filters are only the simple ones (status / lifecycle / coverage / collection). No
  pagination, no UI tests.

## What I know is wrong or weak

* Config is versioned (`config_versions`, read per moment by the engine), but there is no API
  to change it yet, so `rule_change` entries are never written.
* A batch processed by the worker in live mode uses its due time as its processed time, which
  can be up to a second earlier than the real time.
* Batches that arrive late for a decommissioned sensor are stored but never shown on its timeline.
