#!/usr/bin/env node
/**
 * Adds to a pull request the labels of the files it changes: the app, image,
 * test suite, SDK or part of the spec each is in (scripts/lint/path-labels.mjs). A
 * renamed file gives the labels of both its paths.
 *
 * It only adds. A label already on the pull request, put there by hand or by
 * Dependabot, stays, and so does one whose files a later push no longer
 * changes. A label the repository does not have, as an image's before the merge
 * that adds it, is skipped and named: the add-labels call would make it, and
 * the next sync would delete it.
 *
 * Usage: label-pull-request.mjs <owner/repository> <number>. gh reads its
 * token from GH_TOKEN.
 */
import { execFileSync } from 'node:child_process';
import { pathLabel } from '../../scripts/lint/path-labels.mjs';

const [repository, number] = process.argv.slice(2);
if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !/^\d+$/.test(number ?? '')) {
  console.error('usage: label-pull-request.mjs <owner/repository> <pull request number>');
  process.exit(1);
}

const api = (args, input) => execFileSync('gh', ['api', ...args], { encoding: 'utf8', input });
const lines = (text) => text.split('\n').filter((line) => line !== '');

const paths = lines(api([`repos/${repository}/pulls/${number}/files`, '--paginate', '--jq', '.[] | .filename, (.previous_filename // empty)']));
const given = [...new Set(paths.map(pathLabel).filter((label) => label !== null))].sort();
const existing = new Set(lines(api([`repos/${repository}/labels`, '--paginate', '--jq', '.[].name'])));
const adding = given.filter((label) => existing.has(label));
const skipped = given.filter((label) => !existing.has(label));

if (adding.length > 0) api([`repos/${repository}/issues/${number}/labels`, '--method', 'POST', '--input', '-'], JSON.stringify({ labels: adding }));
console.log(`#${number}: ${paths.length} paths give ${adding.join(', ') || 'no label'}${skipped.length > 0 ? `; skipped, as the repository has no such label: ${skipped.join(', ')}` : ''}`);
