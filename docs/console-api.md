# Console API

The operator console uses the fixed operator/state API from the brief plus three list
endpoints. All times are ISO 8601 UTC. Errors are `{"error": "<code>", "detail": "<text>"}`.

## Shapes

### Gateway
```json
{
  "gateway_id": "gw-1",
  "name": "Hilltop",
  "status": "connected",
  "status_since": "2026-01-01T12:00:00.000Z",
  "command_state": "running",
  "coverage_class": "available",
  "last_heartbeat_at": "2026-01-01T12:00:00.000Z",
  "last_qualifying_at": "2026-01-01T12:00:00.000Z",
  "disconnected_since": null,
  "flags": [],
  "sensor_ids": ["s-1"]
}
```
`sensor_ids` appears in list responses and `GET /api/v1/gateways/{id}` (extra field).

### Sensor
```json
{
  "sensor_id": "s-1",
  "type": "temperature",
  "lifecycle": "dormant",
  "lifecycle_reason": null,
  "lifecycle_since": "2026-01-15T00:00:00.000Z",
  "collection": "no_readings",
  "coverage": "available",
  "quiet_checked_days": 14,
  "sampling_cycles_done": 0,
  "next_evaluation_at": "2026-01-29T00:00:00.000Z",
  "gateway_ids": ["gw-1"]
}
```
`next_evaluation_at` is `null` when no wait/window is running: either the lifecycle has
none, or it is **paused** because coverage is not `available`. The UI tells these apart
with `lifecycle` + `coverage`.

### Timeline entry
```json
{
  "seq": 3, "kind": "transition", "axis": "lifecycle",
  "from": "active", "to": "dormant",
  "effective_at": "...", "recorded_at": "...",
  "rule": "quiet_days", "evidence_ids": [],
  "detail": null
}
```
`detail` holds extra data: the operator's `reason` for actions; for `correction`
entries `{replaced: [...], transitions: [...]}`.

## Endpoints

| Method & path | Purpose |
|---|---|
| `GET /api/v1/gateways?status=connected` | `{"server_now", "items": [Gateway]}`. `status` filter optional |
| `GET /api/v1/gateways/{id}` | Gateway |
| `GET /api/v1/gateways/{id}/timeline` | `{"entries": [TimelineEntry]}` oldest first |
| `POST /api/v1/gateways` `{gateway_id, name}` | 201 `{"token"}` |
| `POST /api/v1/gateways/{id}/actions` `{action, reason}` | `suspend` (reason required), `unsuspend`, `mark_spare`, `retire`, `stop`, `resume` → Gateway |
| `GET /api/v1/sensors?lifecycle=&coverage=&collection=` | `{"server_now", "items": [Sensor]}`. Filters optional |
| `GET /api/v1/sensors/{id}` | Sensor |
| `GET /api/v1/sensors/{id}/timeline` | `{"entries": [TimelineEntry]}` |
| `POST /api/v1/sensors` `{sensor_id, type}` | 201 Sensor |
| `PUT /api/v1/sensors/{id}/coverage` `{gateway_ids}` | Sensor |
| `POST /api/v1/sensors/{id}/actions` `{action: "decommission", reason}` | Sensor |
| `GET /api/v1/batches/{id}` | `{processing, attempts, accepted_count, quarantined: [{reading_id, reason}]}` |
| `GET /api/v1/summary` | Situation counts, below |

### Summary
```json
{
  "server_now": "...",
  "gateways": {"by_status": {"connected": 3, "stale": 1}, "by_coverage_class": {...}, "flagged": 1},
  "sensors": {"by_lifecycle": {...}, "by_coverage": {...}, "by_collection": {...}}
}
```
Every known value is present in each `by_*` map, with 0 when there are none.

`server_now` is the server clock (the test clock in test mode). The UI uses it, not the
browser clock, for "held for 2h".
