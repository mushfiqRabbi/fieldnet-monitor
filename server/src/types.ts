// Shared domain types. String values are the exact strings the API returns.

export type GatewayStatus =
  | 'new' | 'spare' | 'connected' | 'stale' | 'disconnected' | 'suspended' | 'retired';
export type CommandState =
  | 'running' | 'stop_pending' | 'stopped' | 'stop_failed' | 'resume_pending' | 'resume_failed';
export type GatewayCoverageClass = 'available' | 'stopped' | 'recoverable' | 'dead';
export type SensorCoverage = 'available' | 'stopped' | 'recoverable' | 'none';
export type Lifecycle = 'pending' | 'active' | 'dormant' | 'sampling' | 'retired' | 'decommissioned';
export type Collection =
  | 'readings' | 'no_readings' | 'could_not_read' | 'timed_out' | 'not_checked' | 'collection_stopped';
export type BatchStatus = 'received' | 'processed' | 'partially_processed' | 'retrying' | 'quarantined';
export type SensorType = 'temperature' | 'rain' | 'wind';
export type CommandType = 'stop' | 'resume';
/** Cycle outcome as stored (API `timeout` is stored as `timed_out`). */
export type Outcome = 'readings' | 'no_readings' | 'could_not_read' | 'timed_out';
export type TimelineKind = 'transition' | 'correction' | 'action' | 'ack' | 'flag' | 'rule_change';

export const UNIT_BY_TYPE: Record<SensorType, string> = { temperature: 'C', rain: 'mm', wind: 'm/s' };

/** Thresholds. Durations are milliseconds. */
export interface Settings {
  quietDaysBeforeDormant: number;
  dormantWaitMs: number;
  samplingWindowMs: number;
  samplingCyclesBeforeRetired: number;
  staleAfterMs: number;
  commandTimeoutMs: number;
  batchDeadlineMs: number;
}

export interface ConfigVersion {
  effectiveAt: number;
  settings: Settings;
}

// ---------------------------------------------------------------------------
// Sensor engine contract (src/domain/sensorEngine.ts). All times are epoch ms.
// ---------------------------------------------------------------------------

export interface ReplayInput {
  sensor: { id: string; type: SensorType; registeredAt: number };
  now: number;
  /** Sorted by effectiveAt. Before the first row the sensor has no gateways. */
  assignments: { effectiveAt: number; gatewayIds: string[] }[];
  /** Per gateway, sorted by effectiveAt. Before its first row a gateway is `dead`. */
  gatewayLogs: Record<string, { effectiveAt: number; coverageClass: GatewayCoverageClass }[]>;
  /** This sensor's cycle results, any order. */
  outcomes: {
    gatewayId: string;
    cycleId: string;
    finishedAt: number;
    outcome: Outcome;
    batchId: string | null;
  }[];
  /** Batches that arrived and are referenced by outcomes or hold readings for this sensor. */
  batches: Record<string, { status: BatchStatus; gatewayId: string }>;
  /** Accepted readings for this sensor, any order. */
  readings: { readingId: string; batchId: string; gatewayId: string; takenAt: number }[];
  decommission: { at: number; reason: string } | null;
  /** Sorted by effectiveAt; the first row applies from the beginning of time. */
  config: ConfigVersion[];
}

export interface LifecycleTransition {
  from: Lifecycle;
  to: Lifecycle;
  /** Reason of the `to` state: no_readings / no_live_coverage / operator text / null. */
  reason: string | null;
  effectiveAt: number;
  rule: string;
  evidenceIds: string[];
}

export interface ReplayResult {
  transitions: LifecycleTransition[];
  lifecycle: Lifecycle;
  lifecycleReason: string | null;
  lifecycleSince: number;
  quietCheckedDays: number;
  samplingCyclesDone: number;
  nextEvaluationAt: number | null;
  coverage: SensorCoverage;
  coverageSince: number;
  collection: Collection;
  collectionSince: number;
  /** Earliest time after `now` when time passing alone could change the result. */
  nextCheckAt: number | null;
}
