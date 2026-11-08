import * as clock from '../clock';
import { iso } from '../time';
import type { TimelineKind } from '../types';
import type { Db } from './context';

export type EntityType = 'gateway' | 'sensor' | 'batch';

export interface NewTimelineEntry {
  entityType: EntityType;
  entityId: string;
  kind: TimelineKind;
  axis: string | null;
  from: string | null;
  to: string | null;
  effectiveAt: number;
  rule: string;
  evidenceIds?: string[];
  detail?: unknown;
}

/**
 * Append-only. `seq` counts per entity from 1 (callers hold the global write lock,
 * so two appends never race). `recorded_at` is the server clock now; `effective_at`
 * is when the change took effect.
 */
export async function appendTimeline(db: Db, e: NewTimelineEntry): Promise<void> {
  await db.query(
    `INSERT INTO timeline
       (entity_type, entity_id, seq, kind, axis, from_value, to_value,
        effective_at, recorded_at, rule, evidence_ids, detail)
     VALUES ($1, $2,
       (SELECT COALESCE(MAX(seq), 0) + 1 FROM timeline WHERE entity_type = $1 AND entity_id = $2),
       $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      e.entityType, e.entityId, e.kind, e.axis, e.from, e.to,
      iso(e.effectiveAt), iso(clock.now()), e.rule, e.evidenceIds ?? [],
      e.detail === undefined ? null : JSON.stringify(e.detail),
    ],
  );
}

/** Entries oldest first, in the shape the API returns. */
export async function readTimeline(db: Db, entityType: EntityType, entityId: string) {
  const { rows } = await db.query(
    `SELECT seq, kind, axis, from_value, to_value, effective_at, recorded_at, rule, evidence_ids, detail
       FROM timeline WHERE entity_type = $1 AND entity_id = $2 ORDER BY seq`,
    [entityType, entityId],
  );
  return rows.map((r) => ({
    seq: r.seq as number,
    kind: r.kind as TimelineKind,
    axis: r.axis as string | null,
    from: r.from_value as string | null,
    to: r.to_value as string | null,
    effective_at: iso(r.effective_at.getTime()),
    recorded_at: iso(r.recorded_at.getTime()),
    rule: r.rule as string,
    evidence_ids: r.evidence_ids as string[],
    detail: r.detail as unknown,
  }));
}
