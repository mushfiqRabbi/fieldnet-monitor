import { pool } from './db';

// The only place that reads the wall clock. In test mode the clock is set by
// POST /test/clock and persisted in system_state, so a restart keeps it.

export const TEST_MODE = process.env.TEST_MODE === '1';

let testNow: number | null = null;

export function now(): number {
  if (TEST_MODE && testNow !== null) return testNow;
  return Date.now();
}

/** True once /test/clock has been called since the last reset. */
export function isTestClockSet(): boolean {
  return testNow !== null;
}

export async function loadClock(): Promise<void> {
  if (!TEST_MODE) return;
  const { rows } = await pool.query("SELECT value FROM system_state WHERE key = 'clock'");
  testNow = rows.length > 0 ? Number(rows[0].value) : null;
}

/** Callers check "forward only" before calling this. */
export async function setTestClock(t: number, tx: { query: typeof pool.query }): Promise<void> {
  await tx.query(
    `INSERT INTO system_state (key, value) VALUES ('clock', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(t)],
  );
  testNow = t;
}

export function resetTestClock(): void {
  testNow = null;
}
