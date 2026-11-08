-- FieldNet Monitor schema. Evidence tables are append-only; projections live on
-- gateways / sensors. See docs/DESIGN.md.

CREATE TABLE gateways (
  id                        text PRIMARY KEY,
  name                      text NOT NULL,
  token_hash                text NOT NULL UNIQUE,
  status                    text NOT NULL,
  status_since              timestamptz NOT NULL,
  command_state             text NOT NULL,
  command_state_since       timestamptz NOT NULL,
  coverage_class            text NOT NULL,
  last_heartbeat_at         timestamptz,
  last_qualifying_at        timestamptz,
  disconnected_since        timestamptz,
  last_auth_failure_at      timestamptz,
  auth_failure_streak_start timestamptz,
  collecting_after_stop     boolean NOT NULL DEFAULT false,
  created_at                timestamptz NOT NULL
);

-- Coverage history: one row per change of status or command state.
CREATE TABLE gateway_state_log (
  id             bigserial PRIMARY KEY,
  gateway_id     text NOT NULL REFERENCES gateways(id),
  effective_at   timestamptz NOT NULL,
  status         text NOT NULL,
  command_state  text NOT NULL,
  coverage_class text NOT NULL
);
CREATE INDEX gateway_state_log_gw ON gateway_state_log (gateway_id, effective_at, id);

CREATE TABLE sensors (
  id                   text PRIMARY KEY,
  type                 text NOT NULL,
  registered_at        timestamptz NOT NULL,
  lifecycle            text NOT NULL,
  lifecycle_reason     text,
  lifecycle_since      timestamptz NOT NULL,
  collection           text NOT NULL,
  collection_since     timestamptz,
  coverage             text NOT NULL,
  coverage_since       timestamptz,
  quiet_checked_days   integer NOT NULL DEFAULT 0,
  sampling_cycles_done integer NOT NULL DEFAULT 0,
  next_evaluation_at   timestamptz,
  next_check_at        timestamptz,
  history              jsonb NOT NULL DEFAULT '[]'::jsonb,
  decommissioned_at    timestamptz,
  decommission_reason  text
);
CREATE INDEX sensors_next_check ON sensors (next_check_at);

CREATE TABLE sensor_gateways (
  sensor_id  text NOT NULL REFERENCES sensors(id),
  gateway_id text NOT NULL REFERENCES gateways(id),
  PRIMARY KEY (sensor_id, gateway_id)
);
CREATE INDEX sensor_gateways_gw ON sensor_gateways (gateway_id);

CREATE TABLE sensor_assignment_log (
  id           bigserial PRIMARY KEY,
  sensor_id    text NOT NULL REFERENCES sensors(id),
  effective_at timestamptz NOT NULL,
  gateway_ids  text[] NOT NULL
);
CREATE INDEX sensor_assignment_log_s ON sensor_assignment_log (sensor_id, effective_at, id);

CREATE TABLE heartbeats (
  id          bigserial PRIMARY KEY,
  gateway_id  text NOT NULL REFERENCES gateways(id),
  sent_at     timestamptz NOT NULL,
  session     text NOT NULL,
  received_at timestamptz NOT NULL
);

CREATE TABLE cycles (
  gateway_id  text NOT NULL REFERENCES gateways(id),
  cycle_id    text NOT NULL,
  body_hash   text NOT NULL,
  started_at  timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  session     text NOT NULL,
  received_at timestamptz NOT NULL,
  PRIMARY KEY (gateway_id, cycle_id)
);

-- One row per covered result. outcome is normalised:
-- readings | no_readings | could_not_read | timed_out
CREATE TABLE cycle_results (
  id          bigserial PRIMARY KEY,
  gateway_id  text NOT NULL,
  cycle_id    text NOT NULL,
  sensor_id   text NOT NULL REFERENCES sensors(id),
  outcome     text NOT NULL,
  batch_id    text,
  finished_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  FOREIGN KEY (gateway_id, cycle_id) REFERENCES cycles(gateway_id, cycle_id)
);
CREATE INDEX cycle_results_sensor ON cycle_results (sensor_id, finished_at);
CREATE INDEX cycle_results_batch ON cycle_results (batch_id);

CREATE TABLE batches (
  id                text PRIMARY KEY,
  gateway_id        text NOT NULL REFERENCES gateways(id),
  sensor_id         text NOT NULL,          -- as sent; may be unknown
  body              jsonb NOT NULL,
  body_hash         text NOT NULL,
  received_at       timestamptz NOT NULL,
  status            text NOT NULL,          -- received | processed | partially_processed | retrying | quarantined
  attempts          integer NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz,
  processed_at      timestamptz,
  accepted_count    integer NOT NULL DEFAULT 0,
  quarantine_reason text
);
CREATE INDEX batches_due ON batches (status, received_at, next_attempt_at);
CREATE INDEX batches_sensor ON batches (sensor_id);

CREATE TABLE readings (
  reading_id  text PRIMARY KEY,
  batch_id    text NOT NULL REFERENCES batches(id),
  gateway_id  text NOT NULL,
  sensor_id   text NOT NULL,
  taken_at    timestamptz NOT NULL,
  value       double precision NOT NULL,
  unit        text NOT NULL,
  accepted_at timestamptz NOT NULL
);
CREATE INDEX readings_sensor ON readings (sensor_id, taken_at);
CREATE INDEX readings_gateway ON readings (gateway_id, taken_at);

CREATE TABLE quarantined_readings (
  id         bigserial PRIMARY KEY,
  batch_id   text NOT NULL REFERENCES batches(id),
  reading_id text,
  reason     text NOT NULL
);
CREATE INDEX quarantined_readings_batch ON quarantined_readings (batch_id);

CREATE TABLE commands (
  id              uuid PRIMARY KEY,
  gateway_id      text NOT NULL REFERENCES gateways(id),
  seq             integer NOT NULL,
  type            text NOT NULL,            -- stop | resume
  issued_at       timestamptz NOT NULL,
  acked_at        timestamptz,
  ack_received_at timestamptz,
  ack_applied     boolean NOT NULL DEFAULT false,
  UNIQUE (gateway_id, seq)
);

CREATE TABLE timeline (
  id           bigserial PRIMARY KEY,
  entity_type  text NOT NULL,               -- gateway | sensor | batch
  entity_id    text NOT NULL,
  seq          integer NOT NULL,
  kind         text NOT NULL,               -- transition | correction | action | ack | flag | rule_change
  axis         text,
  from_value   text,
  to_value     text,
  effective_at timestamptz NOT NULL,
  recorded_at  timestamptz NOT NULL,
  rule         text NOT NULL,
  evidence_ids text[] NOT NULL DEFAULT '{}',
  detail       jsonb,
  UNIQUE (entity_type, entity_id, seq)
);

CREATE TABLE config_versions (
  id           bigserial PRIMARY KEY,
  effective_at timestamptz NOT NULL,
  settings     jsonb NOT NULL,
  recorded_at  timestamptz NOT NULL
);

CREATE TABLE system_state (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);
