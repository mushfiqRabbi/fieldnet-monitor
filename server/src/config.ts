import type { ConfigVersion, Settings } from './types';
import { DAY, HOUR, MINUTE } from './time';
import type { Tx } from './db';

export const DEFAULT_SETTINGS: Settings = {
  quietDaysBeforeDormant: 14,
  dormantWaitMs: 14 * DAY,
  samplingWindowMs: 72 * HOUR,
  samplingCyclesBeforeRetired: 2,
  staleAfterMs: 12 * HOUR,
  commandTimeoutMs: 10 * MINUTE,
  batchDeadlineMs: 24 * HOUR,
};

/** The settings in force at time t. `versions` is sorted by effectiveAt. */
export function settingsAt(versions: ConfigVersion[], t: number): Settings {
  let current = versions.length > 0 ? versions[0].settings : DEFAULT_SETTINGS;
  for (const v of versions) {
    if (v.effectiveAt <= t) current = v.settings;
    else break;
  }
  return current;
}

/** All config versions; defaults when none are stored. */
export async function loadConfig(tx: Tx): Promise<ConfigVersion[]> {
  const { rows } = await tx.query(
    'SELECT effective_at, settings FROM config_versions ORDER BY effective_at, id',
  );
  if (rows.length === 0) return [{ effectiveAt: 0, settings: DEFAULT_SETTINGS }];
  return rows.map((r) => ({
    effectiveAt: r.effective_at.getTime(),
    settings: { ...DEFAULT_SETTINGS, ...r.settings },
  }));
}
