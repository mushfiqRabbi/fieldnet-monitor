import type { Pool } from 'pg';
import { loadConfig, settingsAt } from '../config';
import type { Tx } from '../db';
import type { Settings } from '../types';

/** Anything that can run a query: the pool or a transaction. */
export type Db = Pick<Pool, 'query'>;

/**
 * What one write operation carries: its transaction, the time it acts at, the
 * thresholds in force then, the evidence it is about, and the sensors it touched
 * (recomputed once at the end, after the gateway has been updated).
 */
export interface Ctx {
  tx: Tx;
  now: number;
  settings: Settings;
  evidenceIds: string[];
  dirtySensors: Set<string>;
}

export async function makeCtx(tx: Tx, now: number, evidenceIds: string[] = []): Promise<Ctx> {
  const settings = settingsAt(await loadConfig(tx), now);
  return { tx, now, settings, evidenceIds, dirtySensors: new Set() };
}

export function markDirty(ctx: Ctx, sensorIds: Iterable<string>): void {
  for (const id of sensorIds) ctx.dirtySensors.add(id);
}
