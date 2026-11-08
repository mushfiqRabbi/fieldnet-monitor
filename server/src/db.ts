import { Pool, PoolClient } from 'pg';

export type Tx = PoolClient;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://fieldnet:fieldnet@localhost:5432/fieldnet',
  max: 10,
});

// All state changes go through one lock, so requests, operator actions and the
// worker never interleave. See docs/DESIGN.md §1.
const WRITE_LOCK = 42;

/** Run fn in a transaction that holds the global write lock. */
export async function withWriteTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [WRITE_LOCK]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Run fn in a plain transaction (no global lock). */
export async function withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
