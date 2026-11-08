# FieldNet Monitor — design

This is the working blueprint. `DECISIONS.md` is the short version for reviewers.
The brief is the source of truth for every rule; this file says **where** each rule
lives and **how** it is computed.

## 1. Stack and processes

| Part | Choice |
|---|---|
| API | Node 22, Express 4, TypeScript (strict), `zod` for bodies |
| DB | PostgreSQL 16 through `pg` with plain SQL (no ORM). Migrations are `server/migrations/*.sql`, applied on start |
| Background work | A DB-backed "due work" loop: `runDueWork(now)` in `src/domain/work.ts` |
| Frontend | Next.js (App Router) + TypeScript + Tailwind |
| Tests | Vitest + Supertest against a real Postgres |
| Simulator | TypeScript CLI in `server/src/sim/`, talks HTTP to a test-mode API |

`docker compose up` runs four services: `db`, `api`, `worker`, `web`.

* `api` serves every endpoint. `TEST_MODE` defaults to `1` in compose, so the test
  endpoints exist (graders test against them).
* `worker` calls `runDueWork(clock.now())` every second **only when `TEST_MODE` is not
  `1`**. In test mode it idles, because the brief says background work runs only inside
  `/test/clock` and `/test/drain`.

### Single writer
Every state-changing operation runs inside `withWriteTx(fn)`: one transaction that first
takes `pg_advisory_xact_lock(42)`. So requests, operator actions and the worker never
interleave. Throughput is not a goal here; correctness is. The only exception is the
**insert** part of `PUT /gw/v1/batches/{id}`, which just stores the batch (unique key
gives idempotency) so it can answer 202 fast.

## 2. Time

* `src/clock.ts` is the only place that reads the wall clock. `clock.now()` returns
  the test clock when `TEST_MODE=1` and it has been set, otherwise `Date.now()`.
* The test clock is persisted in `system_state` (`key='clock'`). `POST /test/reset`
  clears it, so the first `/test/clock` after a reset may set any time. After that it
  may only move forward (backwards → 409).
* Before the first `/test/clock` in test mode, `now()` is the wall clock.
* Engine code works in **epoch milliseconds** (`number`). DB code converts at the edge.
  API output is ISO 8601 UTC via `toISOString()`.
* A device timestamp more than 5 minutes after the request's received time is invalid:
  for heartbeat / cycle / ack bodies → 422 `invalid_timestamp`; for a reading → that
  reading is quarantined (`future_timestamp`).

### Effective time of each kind of change
| Change | effective_at |
|---|---|
| Gateway → connected by qualifying evidence | the evidence event time (cycle `finished_at`, batch's latest accepted `taken_at`) |
| connected → stale | `last_qualifying_at + staleAfter` |
| → disconnected | the auth failure's event time (`sent_at` / `finished_at`) |
| Operator actions, coverage assignment, config change | server clock |
| Command ack transitions | `acked_at`, but never earlier than the command's `issued_at` |
| Command timeout | `issued_at + commandTimeout` |
| Sensor lifecycle | as the brief's "Effective at" column |

Gateway transition times are clamped to be **≥ the gateway's previous transition time**
on that axis, so the gateway history is always ordered.

`recorded_at` is always `clock.now()`.

## 3. Data model (Postgres)

See `server/migrations/001_init.sql`. Main tables:

* `gateways` — current gateway state (status, command_state, coverage_class,
  last_heartbeat_at, last_qualifying_at, disconnected_since, last_auth_failure_at,
  auth_failure_streak_start, collecting_after_stop, token_hash).
* `gateway_state_log` — append-only `(gateway_id, effective_at, status, command_state,
  coverage_class)`. One row per change of status or command state. **This is the
  coverage history the sensor engine reads.**
* `sensors` — current sensor projection + `history` (jsonb list of the lifecycle
  transitions we currently believe) + `next_check_at`.
* `sensor_gateways` — current assignment. `sensor_assignment_log` — append-only
  `(sensor_id, effective_at, gateway_ids[])`.
* `heartbeats`, `cycles`, `cycle_results`, `batches`, `readings`,
  `quarantined_readings`, `commands` — raw evidence, never deleted.
* `timeline` — append-only audit log for gateways, sensors and batches.
* `config_versions` — thresholds with an `effective_at` (versioned config).
* `system_state` — test clock and pending fault count.

## 4. Gateways (`src/domain/gateway.ts`)

Forward-only state machine (the brief: "gateway status is not recomputed backwards").

### Status
* **Qualifying evidence** (event time `e`, processing time `now`):
  * A cycle with `session: "ok"` and at least one non-ignored `readings`/`no_readings`
    result, at `finished_at`.
  * A batch that ends `processed`/`partially_processed` with ≥ 1 accepted reading, at
    its latest accepted `taken_at`.
  * Effects:
    * `new` → `connected` at `e`.
    * `stale` → `connected` at `e` only if `e >= now - staleAfter`. Otherwise it is
      "older, late evidence" and **updates nothing** (not even `last_qualifying_at`).
    * `disconnected` → `connected` at `e` only if `e > disconnected_since`. A re-sent
      old batch has `e` before the failure, so it does not reconnect.
    * `suspended`: status unchanged.
    * `last_qualifying_at = max(last_qualifying_at, e)` in every case except the stale
      "updates nothing" case.
    * If `e > auth_failure_streak_start`, clear the streak.
  * After connecting, if `e + staleAfter <= now` the stale timer is already due. The
    next `runDueWork` (or the same request's post-step) moves it to `stale`, effective
    `e + staleAfter`.
* **Auth failure** (heartbeat or cycle with `session: "auth_failed"`, event time `e`):
  * `last_auth_failure_at = max(...)`. If no streak is open (`auth_failure_streak_start`
    is null), it starts at `e`.
  * `new`/`connected`/`stale` → `disconnected` at `e`; `disconnected_since = e`.
  * Already `disconnected`: keep the first `disconnected_since`.
  * `suspended`: only the fields above update.
* **Stale timer**: `connected` and `last_qualifying_at + staleAfter <= t` → `stale`.
* **Operator** (`POST /api/v1/gateways/{id}/actions`):
  * `suspend` (reason required, 422 if missing): from anything except `retired`
    (`retired` or already `suspended` → 409).
  * `unsuspend`: only from `suspended`, else 409. New status, in this order:
    `disconnected` if `last_auth_failure_at > last_qualifying_at` (or there is an auth
    failure and never qualifying evidence) with `disconnected_since = streak start`;
    `new` if never any qualifying evidence; `connected` if `last_qualifying_at >=
    now - staleAfter`; else `stale`.
  * `mark_spare`: only from `new` and only when the gateway covers no sensors, else 409.
  * `retire`: from anything except `retired` (409). Terminal: gateway requests get 403.
  * `stop` / `resume`: see below. Any action on a retired gateway → 409.
* Assigning a sensor to a `spare` gateway → `new` (server time, rule `sensor_assigned`).
* `disconnected_since` is shown only while status is `disconnected` (else null).

### Commands
* `commands(id uuid, gateway_id, seq, type, issued_at, acked_at, ack_received_at,
  ack_applied)`. `seq` is per gateway. The latest command (max seq) is the desired state.
* `stop`: 409 if command_state is `stop_pending` or `stopped`. Otherwise a new stop
  command → `stop_pending`. (From `stop_failed` it is a re-issue.)
* `resume`: 409 if command_state is `running`. Otherwise a new resume command →
  `resume_pending`. (From `resume_pending`/`resume_failed` it is a re-issue.)
* Timeout: latest command unacked and `issued_at + commandTimeout <= t` while state is
  `stop_pending`/`resume_pending` → `stop_failed`/`resume_failed` at `issued_at + timeout`.
* Ack (`POST /gw/v1/commands/{id}/ack`): 404 if the id is unknown or not this
  gateway's. Already acked → 204, nothing else. Otherwise store `acked_at`, then:
  * If it is the latest command and the state is its pending/failed state → `stopped`
    / `running` (`ack_applied = true`, timeline kind `ack`).
  * Else (superseded) → timeline kind `ack`, rule `ack_superseded`, no state change.
* `GET /gw/v1/commands` → the latest command if it is unacked, else `[]`.

### collecting_after_stop
* A **stop period** starts at the `acked_at` of a stop with `ack_applied` and ends at the
  `acked_at` of the next resume with `ack_applied` (open-ended if none yet).
* When a batch is accepted, for its accepted readings whose `taken_at` is inside any stop
  period of that gateway: add one timeline entry (kind `flag`, rule
  `collecting_after_stop`, evidence = reading ids). If the period is the gateway's
  current open period, set `collecting_after_stop = true`.
* An applied resume ack sets it back to false (kind `flag` entry).

### Coverage class (`src/domain/coverage.ts`)
| status | command_state | class |
|---|---|---|
| connected | running, stop_pending, stop_failed | available |
| connected | stopped, resume_pending, resume_failed | stopped |
| new, stale, disconnected, spare | any | recoverable |
| suspended, retired | any | dead |

`spare` is not in the brief's table. A spare gateway covers nothing, so it doesn't
matter; we call it `recoverable` (a working box held in reserve).

Whenever status or command state changes: append a `gateway_state_log` row (same
effective_at), and if the class changed, a timeline entry (axis `coverage_class`). Then
**recompute every sensor currently assigned to that gateway**.

## 5. Request order (brief: gateway first, then coverage, then evidence)
`POST /gw/v1/cycles`, inside `withWriteTx`:
1. Auth (401/403), validate (422), idempotency (`cycles` PK `(gateway_id, cycle_id)` +
   canonical body hash → 200 no-op or 409 `cycle_conflict`).
2. Split results into covered / ignored (not currently assigned to this gateway,
   including unknown sensor ids) → `ignored` in the response.
3. Update the gateway (qualifying evidence or auth failure).
4. Recompute coverage (log + class).
5. Store `cycle_results` (auth_failed → every outcome stored as `could_not_read`;
   `timeout` stored as `timed_out`).
6. Recompute the sensors in the cycle and the sensors of the gateway.

Heartbeats follow the same steps (no sensor evidence).

## 6. Batches (`src/domain/batches.ts`)
* `PUT /gw/v1/batches/{id}`: validate the outer shape only (`sensor_id` string,
  `readings` array of objects) → else 422. Insert with status `received`,
  `received_at = now`. Identical repeat (same gateway, same canonical body) → 200.
  Different body or other gateway → 409 `batch_conflict`. Unknown sensor is **not**
  404: the batch is accepted (202) and quarantined in processing (`unknown_sensor`), as
  the brief's batch section says.
* A batch is **due** at `received_at` (status `received`) or `next_attempt_at`
  (`retrying`).
* `processBatch(batch, t)` (t = due time = processed time):
  1. If `system_state.faults > 0`: decrement it; this attempt fails. `attempts += 1`.
     If `attempts >= 5` → `quarantined` (`processing_failed`, every reading listed with
     that reason). Else `retrying`, `next_attempt_at = t + 2^(attempts-1) min`.
  2. Unknown sensor → `quarantined`, every reading `unknown_sensor`.
  3. Each reading: missing field → `missing_field`; `value` not a finite number →
     `invalid_value`; wrong unit (temperature `C`, rain `mm`, wind `m/s`) →
     `wrong_unit`; `taken_at` not ISO → `invalid_timestamp`; `taken_at > received_at +
     5 min` → `future_timestamp`.
  4. Reading id already stored (`readings` PK): same content (sensor, taken_at, value,
     unit) → ignored (not counted, not quarantined); different → `conflicting_duplicate`.
     Same id twice inside one batch: first wins, same rule for the second.
  5. Status: no invalid → `processed`; some invalid and ≥ 1 accepted →
     `partially_processed`; every reading invalid (and there was ≥ 1) → `quarantined`.
     An empty `readings` list → `processed` with 0 accepted.
  6. All of this is one transaction, so a retried batch never double-counts.
  7. If ≥ 1 accepted: qualifying evidence for the gateway at the max accepted
     `taken_at`; collecting_after_stop check; recompute the sensor.
* `GET /api/v1/batches/{id}` → `{processing, attempts, accepted_count, quarantined}`.
  `attempts` counts processing attempts made (successful one included).

## 7. Sensor engine (`src/domain/sensorEngine.ts`) — the core

**A pure function.** `replaySensor(input) → result`. No DB, no clock. It replays the
sensor from registration to `input.now` using everything we know now. Everything else
(live updates, timers, late data, corrections, test clock jumps) is "call replay again
and compare".

### Input
* `sensor {id, type, registeredAt}`, `now`.
* `assignments`: `[{effectiveAt, gatewayIds}]` sorted (initially none = `[]`).
* `gatewayLogs`: per gateway, `[{effectiveAt, coverageClass}]` sorted. A gateway's class
  before its first row is `dead`.
* `outcomes`: `[{gatewayId, cycleId, finishedAt, outcome, batchId}]` for this sensor
  (`outcome` already normalised: readings | no_readings | could_not_read | timed_out).
* `batches`: map batchId → `{status, gatewayId, arrived: true}` for batches referenced by
  outcomes or holding readings for this sensor. A referenced id missing from the map has
  not arrived.
* `readings`: accepted readings for this sensor `[{readingId, batchId, gatewayId, takenAt}]`.
* `decommission`: `{at, reason} | null`.
* `config`: `[{effectiveAt, settings}]` sorted; the first row applies from the beginning.

### Derived helpers
* `gatewayClassAt(g, t)`: class from the last log row with `effectiveAt <= t`.
* `assignedAt(t)`: gateway ids from the last assignment row with `effectiveAt <= t`.
* `coverageAt(t)`: best of `gatewayClassAt(g, t)` for g in `assignedAt(t)` with order
  available > stopped > recoverable; `none` if empty or all dead.
* Coverage change points = every assignment time and every log time of any gateway that
  appears in any assignment. Only points where `coverageAt` actually changes matter.
* **Outcome resolution** (as of `now`), for a `readings` outcome with a batch:
  * batch `processed`/`partially_processed` → resolved, stays `readings`;
  * batch `quarantined` → resolved as `could_not_read`;
  * batch not arrived and `now >= finishedAt + batchDeadline` → resolved as
    `could_not_read`;
  * otherwise (not arrived before the deadline, or arrived but `received`/`retrying`)
    → **unresolved**.
* **Day classification** (UTC day `d`, complete when `now >= d+1 00:00`), first match:
  1. reading day: an accepted reading with `takenAt` in `d`;
  2. unresolved: an unresolved readings outcome with `finishedAt` in `d`;
  3. quiet: a `no_readings` outcome with `finishedAt` in `d` from gateway `g` with
     `gatewayClassAt(g, finishedAt) == available`;
  4. unchecked.

### Replay loop
State: `lifecycle, reason, since, quiet, cycles, timer, deferredDormant, blocked`.
`timer = {kind: 'dormant_wait'|'sampling_window', remainingMs, runningSince|null,
windowStart}`. Start: `pending` since `registeredAt`, counters 0, coverage `none`.

Events with time `t ≤ now`, processed in time order; **at the same instant in this
order**: decommission → coverage change → readings → day boundary → timer end.

1. **Decommission** at `t`: → `decommissioned` (reason = operator text, rule
   `operator_decommission`). Stop the replay; nothing changes after.
2. **Coverage change** to `c` at `t`:
   * `c == none`: if lifecycle is `active`, `dormant` or `sampling` → `retired`
     (`no_live_coverage`). `pending`, `decommissioned` and `retired` (either reason)
     stay. Clear the timer.
   * from `none` to anything else: `retired(no_live_coverage)` → `pending` (rule
     `coverage_restored`), quiet = 0, cycles = 0.
   * leaving `available`: pause the timer (`remainingMs -= t - runningSince`,
     `runningSince = null`).
   * entering `available`: resume the timer (`runningSince = t`). If `active` and
     `deferredDormant` and quiet ≥ threshold → `dormant` at `t` (see 4).
3. **Reading** taken at `t` (accepted; any coverage except `none`):
   * `pending` → `active` (rule `first_reading`); `dormant` / `retired(no_readings)` →
     `active` (rule `reading_wake`); `sampling` → `active` (rule `reading_in_window`).
     Entering active: quiet = 0, cycles = 0, timer cleared.
   * `active`: quiet = 0, `deferredDormant = false`, `blocked = false`.
   * coverage `none` (pending or retired(no_live_coverage)): no lifecycle change.
4. **Day boundary** at `t` (00:00 UTC, completes day `d = t - 1 day`), only matters while
   `active` and not `blocked`:
   * reading day → quiet = 0.
   * unresolved → `blocked = true` (quiet counting stops until a reading resets it or a
     later replay sees the day resolved). Brief: "any evaluation that depends on an
     unresolved day waits".
   * quiet day → quiet += 1. If quiet ≥ `quietDaysBeforeDormant`: if `coverageAt(t)` is
     available → `dormant` at `t` (rule `quiet_days`), else `deferredDormant = true`
     (lifecycle is "unchanged" while coverage is not available; it fires when coverage
     becomes available again).
   * unchecked → nothing.
   * Entering `dormant`: timer = dormant_wait with `remainingMs = dormantWait`, running
     iff coverage is available.
5. **Timer end** at `t = runningSince + remainingMs`:
   * dormant_wait → `sampling` (rule `dormant_wait_elapsed`), timer = sampling_window,
     `remainingMs = samplingWindow`, `windowStart = t`.
   * sampling_window: "checked" = some `no_readings` outcome with `finishedAt` in
     `[windowStart, t)` from a gateway with class available at `finishedAt`.
     * checked: cycles += 1. If cycles ≥ `samplingCyclesBeforeRetired` → `retired`
       (`no_readings`, rule `sampling_retired`), timer cleared. Else → `dormant` (rule
       `sampling_window_checked`), new dormant_wait.
     * not checked → `sampling` again (rule `sampling_window_restart`, a transition
       entry from sampling to sampling), new window starting at `t`, cycles unchanged.

Counters: quiet resets on every reading day and on entering pending; cycles reset on
entering active or pending (brief).

### Output
* `transitions`: `[{from, to, reason, effectiveAt, rule, evidenceIds}]` (evidence ids:
  the reading id for reading rules; empty for timers).
* Current: `lifecycle, lifecycleReason, lifecycleSince` (the last transition's
  `effectiveAt`, or `registeredAt`), `quietCheckedDays, samplingCyclesDone`.
* `nextEvaluationAt`: while dormant/sampling with a running timer → `runningSince +
  remainingMs`; paused or any other lifecycle → null.
* `coverage, coverageSince` = `coverageAt(now)` and when it started.
* `collection, collectionSince` (see below).
* `nextCheckAt`: the earliest time after `now` when time passing alone could change the
  result: min(next 00:00 UTC, running timer end, unresolved batch deadlines,
  collection expiry `finishedAt + 24h` of outcomes that currently count, future
  `takenAt` of readings). Null for decommissioned.

### Latest collection (at time `t`)
* For each gateway `g` assigned at `t` with class available at `t`: its latest outcome
  for this sensor with `finishedAt <= t` and `finishedAt > t - 24h`. Accepted readings
  from a batch that no outcome mentions count as a `readings` outcome from the batch's
  gateway at the reading's `takenAt`. A resolved-as-could_not_read outcome counts as
  `could_not_read`; an unresolved readings outcome counts as `readings`.
* Pick by precedence readings > no_readings > could_not_read > timed_out.
* None → `collection_stopped` if `coverageAt(t)` is `stopped`, else `not_checked`.
* `collectionSince`: walk back over candidate change points (outcome times, their +24h,
  coverage changes) to find when the current value started.

## 8. Persisting a replay (`src/domain/sensorStore.ts`)
`recomputeSensor(tx, sensorId, now, cause)`:
1. Skip if the stored lifecycle is `decommissioned` (frozen).
2. Load inputs, call `replaySensor`.
3. Compare `result.transitions` (H′) with stored `sensors.history` (H) by
   `(from, to, reason, effectiveAt, rule)`:
   * H′ equals H → no lifecycle entry.
   * H is a prefix of H′ → append each new transition as a timeline `transition` entry
     (decommission uses kind `action`). This is normal forward progress, including
     several transitions in one clock jump, each at its own effective time.
   * Otherwise → append **one** `correction` entry: `from` = H's current state, `to` =
     H′'s current state, `effective_at` = the first differing transition's time,
     `evidence_ids` = the cause's evidence ids, `detail = {replaced: H[k..],
     transitions: H′[k..]}`. Old entries are never touched.
4. If coverage or collection changed vs the stored value → a `transition` entry on axis
   `coverage` / `collection` at `coverageSince` / `collectionSince`. (Intermediate flips
   inside one clock jump are collapsed; documented compromise.)
5. Save the projection (lifecycle, reason, since, counters, nextEvaluationAt, coverage,
   collection, history = H′, next_check_at).

## 9. Due work (`src/domain/work.ts`)
`runDueWork(now)`:
1. Loop: find the earliest due item `≤ now` among
   * batches `received` (due `received_at`) / `retrying` (due `next_attempt_at`);
   * gateways `connected` (due `last_qualifying_at + staleAfter`);
   * gateways with a pending command (due `issued_at + commandTimeout`).

   Ties: command timeout, then batch, then stale. Process it at its due time `t` in its
   own `withWriteTx` (affected sensors are recomputed inside it). Repeat.
2. Recompute every non-decommissioned sensor with `next_check_at <= now`.

The sensor engine replays to `now`, so sensor timers (day ends, waits, windows,
deadlines) need no queue: each comes out at its own effective time.

## 10. Timeline
`timeline(entity_type, entity_id, seq, kind, axis, from_value, to_value, effective_at,
recorded_at, rule, evidence_ids, detail)`. `seq` is per entity, from 1. `kind` ∈
transition | correction | action | ack | flag | rule_change. API returns `{seq, kind,
axis, from, to, effective_at, recorded_at, rule, evidence_ids}` plus `detail` when
present (reason, correction transitions).

Axes: gateway `status`, `command_state`, `coverage_class`, `flags`; sensor `lifecycle`,
`coverage`, `collection`; batch `processing`.

## 11. Config (`src/config.ts`)
Defaults from the brief. Stored as `config_versions(effective_at, settings)`, and the
engine reads `settingsAt(t)`. No API yet (ready for a change request; `rule_change` kind).

## 12. Errors
`{"error": "<code>", "detail": "<text>"}`. 422 `validation_error` / `invalid_timestamp`,
404 `not_found`, 409 `conflict` / `cycle_conflict` / `batch_conflict` /
`illegal_action` / `duplicate_id` / `clock_backwards`, 401 `unauthorized`, 403
`gateway_retired`. Malformed JSON → 422.

## 13. Console API (beyond the fixed API) — see `docs/console-api.md`
`GET /api/v1/gateways?status=`, `GET /api/v1/sensors?lifecycle=&coverage=&collection=`,
`GET /api/v1/summary`. List responses carry `server_now` so the UI computes "held for"
against the server clock (which is the test clock in test mode).
