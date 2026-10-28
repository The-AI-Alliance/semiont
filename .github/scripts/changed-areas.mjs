#!/usr/bin/env node
/**
 * The areas a push changed, and the tier the run is in, as the jobs of ci.yml
 * read them.
 *
 * FILTERS is the JSON of dorny/paths-filter's outputs: each filter's name to
 * "true" or "false", and `changes`, the list of the names that matched. EVENT
 * is the workflow's event.
 *
 * A pull request, and a push (a merged pull request, mapped against the commit
 * before it), run in tier `change`: each area is true when its filter matched,
 * and every area is when `all` matched (the workflows, the CI scripts, the
 * spec). Any other event runs in tier `full`, with every area true: the nightly
 * schedule, a dispatch, and a release's call, whose event is the release's
 * dispatch. A job that runs at night and for a release alone reads the tier.
 */
import { appendFileSync } from 'node:fs';

const filters = JSON.parse(process.env.FILTERS);
const event = process.env.EVENT;
const tier = event === 'pull_request' || event === 'push' ? 'change' : 'full';
const everything = tier === 'full' || filters.all === 'true';

const areas = Object.keys(filters).filter((name) => name !== 'changes' && name !== 'all');
if (areas.length === 0) {
  console.error('changed-areas: FILTERS names no area: the changes job has lost its filters');
  process.exit(1);
}
const lines = [...areas.map((area) => `${area}=${everything || filters[area] === 'true'}`), `tier=${tier}`];
appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
console.log(everything ? `tier ${tier}: every area runs (${event}${filters.all === 'true' ? ', all matched' : ''})` : lines.join('\n'));
