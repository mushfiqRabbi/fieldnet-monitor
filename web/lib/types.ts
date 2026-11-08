// Shapes of docs/console-api.md. Values are the exact strings the API returns.

export const GATEWAY_STATUSES = [
  "new",
  "spare",
  "connected",
  "stale",
  "disconnected",
  "suspended",
  "retired",
] as const;
export type GatewayStatus = (typeof GATEWAY_STATUSES)[number];

export const COMMAND_STATES = [
  "running",
  "stop_pending",
  "stopped",
  "stop_failed",
  "resume_pending",
  "resume_failed",
] as const;
export type CommandState = (typeof COMMAND_STATES)[number];

export const GATEWAY_COVERAGE_CLASSES = ["available", "stopped", "recoverable", "dead"] as const;
export type GatewayCoverageClass = (typeof GATEWAY_COVERAGE_CLASSES)[number];

export const SENSOR_COVERAGES = ["available", "stopped", "recoverable", "none"] as const;
export type SensorCoverage = (typeof SENSOR_COVERAGES)[number];

export const LIFECYCLES = [
  "pending",
  "active",
  "dormant",
  "sampling",
  "retired",
  "decommissioned",
] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];

export const COLLECTIONS = [
  "readings",
  "no_readings",
  "could_not_read",
  "timed_out",
  "not_checked",
  "collection_stopped",
] as const;
export type Collection = (typeof COLLECTIONS)[number];

export type GatewayFlag = "collecting_after_stop";

export interface Gateway {
  gateway_id: string;
  name: string;
  status: GatewayStatus;
  status_since: string | null;
  command_state: CommandState;
  coverage_class: GatewayCoverageClass;
  last_heartbeat_at: string | null;
  last_qualifying_at: string | null;
  disconnected_since: string | null;
  flags: string[];
  sensor_ids: string[];
}

export interface Sensor {
  sensor_id: string;
  type: string;
  lifecycle: Lifecycle;
  lifecycle_reason: string | null;
  lifecycle_since: string | null;
  collection: Collection;
  coverage: SensorCoverage;
  quiet_checked_days: number;
  sampling_cycles_done: number;
  next_evaluation_at: string | null;
  gateway_ids: string[];
}

export type TimelineKind = "transition" | "correction" | "action" | "ack" | "flag" | "rule_change";

export interface TimelineEntry {
  seq: number;
  kind: TimelineKind | string;
  axis: string | null;
  from: unknown;
  to: unknown;
  effective_at: string | null;
  recorded_at: string | null;
  rule: string | null;
  evidence_ids: string[];
  detail: unknown;
}

export interface ListResponse<T> {
  server_now: string;
  items: T[];
}

export interface TimelineResponse {
  entries: TimelineEntry[];
}

export interface Summary {
  server_now: string;
  gateways: {
    by_status: Record<string, number>;
    by_coverage_class: Record<string, number>;
    flagged: number;
  };
  sensors: {
    by_lifecycle: Record<string, number>;
    by_coverage: Record<string, number>;
    by_collection: Record<string, number>;
  };
}

export type GatewayAction =
  | "suspend"
  | "unsuspend"
  | "mark_spare"
  | "retire"
  | "stop"
  | "resume";

export interface ApiErrorBody {
  error: string;
  detail: string;
}
