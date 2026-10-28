/**
 * Whether a failed request is worth another attempt is one table,
 * specs/src/retry/cases.json, run here through `RETRY_RULES` and
 * `retryAfterMs`. Every SDK that carries these rules runs the same table: a
 * mirror across implementations, gated by one table rather than generated.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { RETRY_RULES } from '../retry-rules';
import { retryAfterMs } from '../retry';

interface RuleCase {
  why: string;
  rule: string;
  status?: number;
  method?: string;
  retries: boolean;
}

interface RetryAfterCase {
  why: string;
  header: string | null;
  ms: number | null;
}

const TABLE = join(dirname(fileURLToPath(import.meta.url)), '../../../../specs/src/retry/cases.json');
const { rules, retryAfter } = JSON.parse(readFileSync(TABLE, 'utf-8')) as {
  rules: RuleCase[];
  retryAfter: RetryAfterCase[];
};

const isRuleName = (name: string): name is keyof typeof RETRY_RULES => Object.hasOwn(RETRY_RULES, name);

describe('retry — core agrees with the shared table', () => {
  it('the table asks every named rule, both ways: a rule with no row, or only one answer, is not held', () => {
    for (const name of Object.keys(RETRY_RULES)) {
      const answers = new Set(rules.filter((c) => c.rule === name).map((c) => c.retries));
      expect([...answers].sort(), `rule "${name}"`).toEqual([false, true]);
    }
    expect(retryAfter.length).toBeGreaterThan(0);
  });

  it.each(rules)('$rule: $why', (c) => {
    if (!isRuleName(c.rule)) throw new Error(`the table names a rule core does not have: ${c.rule}`);
    expect(RETRY_RULES[c.rule].retryable({ status: c.status, method: c.method })).toBe(c.retries);
  });

  it.each(retryAfter)('Retry-After: $why', (c) => {
    expect(retryAfterMs(c.header)).toBe(c.ms ?? undefined);
  });
});
