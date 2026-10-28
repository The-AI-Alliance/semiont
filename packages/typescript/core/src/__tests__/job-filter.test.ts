import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jobMatchesFilter, type FilterableJob } from '../job-filter';
import type { components } from '../types';

// The Dispatcher answers the same question in Rust, and each SDK's taking side
// in its own language. The shared table holds them all to one answer.
describe('whether a job matches a filter agrees with the shared table', () => {
  const table: { cases: { why: string; filter: components['schemas']['JobFilter']; job: FilterableJob; matches: boolean }[] } =
    JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../specs/src/jobs/filter-cases.json'), 'utf8'));

  it('has cases that match and cases that do not', () => {
    expect(table.cases.some((c) => c.matches)).toBe(true);
    expect(table.cases.some((c) => !c.matches)).toBe(true);
  });

  it.each(table.cases)('$why', ({ filter, job, matches }) => {
    expect(jobMatchesFilter(filter, job)).toBe(matches);
  });
});
