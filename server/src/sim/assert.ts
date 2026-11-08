import { isDeepStrictEqual } from 'node:util';

/**
 * Collects the assertions of one story. Each check prints PASS or FAIL with the expected and
 * the actual value, so a failure can be read without opening the code.
 */
export class Checker {
  passed = 0;
  failed = 0;

  equal(label: string, actual: unknown, expected: unknown): void {
    const ok = isDeepStrictEqual(actual, expected);
    if (ok) {
      this.passed++;
      console.log(`  PASS  ${label}  (${show(actual)})`);
    } else {
      this.failed++;
      console.log(`  FAIL  ${label}`);
      console.log(`          expected: ${show(expected)}`);
      console.log(`          actual:   ${show(actual)}`);
    }
  }
}

const show = (v: unknown): string => {
  const text = v === undefined ? 'undefined' : JSON.stringify(v);
  return text.length > 160 ? `${text.slice(0, 160)}...` : text;
};

import type { Client } from './client';

/** One failure story: a name for the CLI, a one-line summary, and the script itself. */
export interface Story {
  name: string;
  summary: string;
  run(api: Client, check: Checker): Promise<void>;
}
