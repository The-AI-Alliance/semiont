#!/usr/bin/env node
/**
 * The areas a push changed, as the jobs of ci.yml read them.
 *
 * FILTERS is the JSON of dorny/paths-filter's outputs: each filter's name to
 * "true" or "false", and `changes`, the list of the names that matched. EVENT
 * is the workflow's event. Each area but `all` is written to GITHUB_OUTPUT as
 * true when its filter matched, when `all` matched (the workflows, the CI
 * scripts, the spec), or when the run is not a pull request: a push to main
 * and a dispatch run everything, as the canary and the operator ask.
 */
import { appendFileSync } from 'node:fs';

const filters = JSON.parse(process.env.FILTERS);
const everything = process.env.EVENT !== 'pull_request' || filters.all === 'true';

const areas = Object.keys(filters).filter((name) => name !== 'changes' && name !== 'all');
if (areas.length === 0) {
  console.error('changed-areas: FILTERS names no area: the changes job has lost its filters');
  process.exit(1);
}
const lines = areas.map((area) => `${area}=${everything || filters[area] === 'true'}`);
appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
console.log(everything ? `every area runs (${process.env.EVENT}${filters.all === 'true' ? ', all matched' : ''})` : lines.join('\n'));
