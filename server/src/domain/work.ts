import { withTx, withWriteTx, type Tx } from '../db';
import { loadConfig, settingsAt } from '../config';
import { iso } from '../time';
import { expireCommand } from './commands';
import { makeCtx, markDirty } from './context';
import { expireIfStale } from './gateway';
import { requireGateway, saveGateway } from './gatewayStore';
import { failBatchAttempt, processBatch } from './batches';
import { recomputeDirty } from './sensorStore';

// Background work (DESIGN §9). Items are processed one by one in due-time order, each
// at its own due time, so every transition is effective when it was due, never at
// the time of the clock jump.

type DueItem = { kind: 'command' | 'batch' | 'stale'; id: string; due: number };

/** Ties go: command timeout, then batch, then stale (the order of this list). */
async function earliestDue(tx: Tx, now: number): Promise<DueItem | null> {
  const settings = settingsAt(await loadConfig(tx), now);
  const candidates: DueItem[] = [];

  const command = await tx.query(
    `SELECT g.id, c.issued_at + $2 * interval '1 millisecond' AS due
       FROM gateways g JOIN commands c ON c.gateway_id = g.id
        AND c.seq = (SELECT MAX(seq) FROM commands WHERE gateway_id = g.id)
      WHERE g.command_state IN ('stop_pending', 'resume_pending') AND c.acked_at IS NULL
        AND g.status <> 'retired' AND c.issued_at + $2 * interval '1 millisecond' <= $1
      ORDER BY due LIMIT 1`,
    [iso(now), settings.commandTimeoutMs],
  );
  if (command.rows[0]) candidates.push({ kind: 'command', id: command.rows[0].id, due: command.rows[0].due.getTime() });

  const batch = await tx.query(
    `SELECT id, COALESCE(next_attempt_at, received_at) AS due FROM batches
      WHERE status IN ('received', 'retrying') AND COALESCE(next_attempt_at, received_at) <= $1
      ORDER BY due LIMIT 1`,
    [iso(now)],
  );
  if (batch.rows[0]) candidates.push({ kind: 'batch', id: batch.rows[0].id, due: batch.rows[0].due.getTime() });

  const stale = await tx.query(
    `SELECT id, last_qualifying_at + $2 * interval '1 millisecond' AS due FROM gateways
      WHERE status = 'connected' AND last_qualifying_at + $2 * interval '1 millisecond' <= $1
      ORDER BY due LIMIT 1`,
    [iso(now), settings.staleAfterMs],
  );
  if (stale.rows[0]) candidates.push({ kind: 'stale', id: stale.rows[0].id, due: stale.rows[0].due.getTime() });

  // sort is stable, so equal due times keep the tie order above
  return candidates.sort((a, b) => a.due - b.due)[0] ?? null;
}

async function processItem(tx: Tx, item: DueItem): Promise<void> {
  const ctx = await makeCtx(tx, item.due);
  if (item.kind === 'batch') {
    await processBatch(ctx, item.id);
  } else {
    const g = await requireGateway(tx, item.id);
    if (item.kind === 'command') await expireCommand(ctx, g);
    else await expireIfStale(ctx, g);
    await saveGateway(tx, g);
  }
  await recomputeDirty(ctx);
}

/** Do every piece of work that is due at `now`. */
export async function runDueWork(now: number): Promise<void> {
  for (;;) {
    const item = await withTx((tx) => earliestDue(tx, now));
    if (!item) break;
    try {
      await withWriteTx((tx) => processItem(tx, item));
    } catch (err) {
      if (item.kind !== 'batch') throw err;
      // Processing itself failed: that is a failed attempt, not a stuck batch.
      console.error(`processing batch ${item.id} failed`, err);
      await withWriteTx(async (tx) => {
        const ctx = await makeCtx(tx, item.due);
        await failBatchAttempt(ctx, item.id);
        await recomputeDirty(ctx); // the 5th failure quarantines it, which resolves its outcomes
      });
    }
  }
  await recomputeDueSensors(now);
}

/** Sensors whose own timers (day ends, waits, windows, deadlines) have come due. */
async function recomputeDueSensors(now: number): Promise<void> {
  await withWriteTx(async (tx) => {
    const ctx = await makeCtx(tx, now);
    const { rows } = await tx.query(
      "SELECT id FROM sensors WHERE next_check_at <= $1 AND lifecycle <> 'decommissioned'",
      [iso(now)],
    );
    markDirty(ctx, rows.map((r) => r.id as string));
    await recomputeDirty(ctx);
  });
}
