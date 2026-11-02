#!/usr/bin/env node
/**
 * lint:telemetry-doc — the operator's observability page lists exactly the
 * metrics and the spans Semiont exports, and says of each what its statement
 * says.
 *
 * docs/operator/administration/OBSERVABILITY.md restates, by hand, what a
 * stack exports. A metric or a span with no row is one an operator cannot
 * look up, and a row with none promises one that never arrives. What is
 * exported is stated in two tables, and the page is held to both:
 *
 * - specs/src/service-telemetry/telemetry.json: what each service exports.
 *   Each is held to it from outside by its own conformance suite.
 * - specs/src/sdk-telemetry/telemetry.json: what an SDK's transports export,
 *   in any language.
 *
 * A metric's rows are those of the page's "Metrics" section that open with a
 * `semiont.…` name in backticks. A span's are those of "What gets traced"
 * that open with a name in backticks, written as the tables write one
 * (`bus.emit:{channel}`). Each row is under a header that names its columns.
 * Of metrics and of spans alike:
 *
 * 1. Every one the tables state has one row, and every row is one of them.
 * 2. A row's kind is its table's. For a metric that is its Type, the table's
 *    `instrument`. For a span it is its Kind, the table's `kind`.
 * 3. The row's Attributes names in backticks every attribute key the table
 *    lists, and nothing else in backticks there but a value the table lists
 *    for one of them.
 * 4. Where the page's table has a When column, a row's is the table's `when`.
 *    A row whose table gives none (a row of the SDKs' table) is in a table
 *    with no such column.
 *
 * Not held: which of the page's tables a row is in (the page says who exports
 * a thing by the table it is in), and what a row says in prose.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const PAGE = 'docs/operator/administration/OBSERVABILITY.md';
const TABLES = ['specs/src/service-telemetry/telemetry.json', 'specs/src/sdk-telemetry/telemetry.json'];

const failures = [];
const fail = (message) => failures.push(message);
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

// ── what is stated ───────────────────────────────────────────────────────

/**
 * What is stated of each metric, and of each span, by name: `where` it is
 * stated; its `kind`, which for a metric is its instrument; the `attributes`
 * its table lists for it, each a key and the values it may have; and `when`
 * it is exported, which the services' table says and the SDKs' does not.
 */
const metrics = new Map();
const spans = new Map();

for (const table of TABLES) {
  const stated = JSON.parse(read(table));
  for (const [kind, into] of [['metrics', metrics], ['spans', spans]]) {
    const rows = stated[kind];
    if (!Array.isArray(rows) || rows.length === 0) {
      fail(`${table} lists no ${kind}: the check has lost what it reads`);
      continue;
    }
    for (const row of rows) {
      if (typeof row?.name !== 'string' || row.name === '') fail(`${table}: one of its ${kind} has no name`);
      else if (into.has(row.name)) fail(`${row.name} is stated by ${into.get(row.name).where} and by ${table}: one statement each`);
      else if (!Array.isArray(row.attributes)) fail(`${table}: ${row.name} lists no attributes, not even none`);
      else into.set(row.name, { where: table, kind: kind === 'metrics' ? row.instrument : row.kind, attributes: row.attributes, when: row.when });
    }
  }
}

// ── what the page says ───────────────────────────────────────────────────

const page = read(PAGE).split('\n');

/** The lines of the section a `## ` heading opens, each with its line number. */
function section(heading) {
  const start = page.indexOf(`## ${heading}`);
  if (start < 0) {
    fail(`${PAGE} has no "## ${heading}" section: the check has lost what it reads`);
    return [];
  }
  const after = page.findIndex((line, index) => index > start && line.startsWith('## '));
  return page.slice(start + 1, after < 0 ? page.length : after).map((line, index) => ({ line, number: start + 2 + index }));
}

const cells = (line) => line.split('|').slice(1, -1).map((cell) => cell.trim());
const backticked = (cell) => [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]);

/**
 * The rows of a section's tables whose first cell is one backticked name
 * `named` takes: each with its cells by column name, from the header above it.
 */
function rows(heading, named) {
  const found = [];
  let header;
  for (const { line, number } of section(heading)) {
    if (!line.startsWith('|')) {
      header = undefined;
      continue;
    }
    const row = cells(line);
    if (row.every((cell) => /^:?-+:?$/.test(cell))) continue;
    const name = /^`([^`]+)`$/.exec(row[0])?.[1];
    if (name === undefined || !named(name)) {
      header = row;
      continue;
    }
    if (header === undefined) {
      fail(`${PAGE}:${number} is a row with no header above it`);
      continue;
    }
    const titles = header;
    found.push({ name, number, column: (title) => (titles.includes(title) ? row[titles.indexOf(title)] : undefined) });
  }
  return found;
}

/**
 * Hold a section's rows to what is `stated` of them (rules 1 to 4). `what`
 * is the word for one, and `column` the column its kind is in.
 */
function hold(heading, named, stated, { what, column }) {
  const found = rows(heading, named);
  if (found.length === 0) fail(`${PAGE} has no ${what} row under "${heading}": the check has lost what it reads`);
  const seen = new Set();
  for (const row of found) {
    const where = `${PAGE}:${row.number}`;
    if (seen.has(row.name)) fail(`${where} is a second row for the ${what} ${row.name}: one row each`);
    seen.add(row.name);
    const statement = stated.get(row.name);
    if (statement === undefined) {
      fail(`${where} is a row for the ${what} ${row.name}, which nothing exports: neither table of specs/ lists it`);
      continue;
    }
    const kind = row.column(column);
    if (kind !== statement.kind) fail(`${where} says the ${what} ${row.name} is ${JSON.stringify(kind)}; ${statement.where} states ${JSON.stringify(statement.kind)}`);
    const when = row.column('When');
    if (when !== undefined && statement.when === undefined) fail(`${where} gives the ${what} ${row.name} a When, and ${statement.where} states none`);
    else if (when !== undefined && when !== statement.when) fail(`${where} gives the ${what} ${row.name} the When ${JSON.stringify(when)}; ${statement.where} states ${JSON.stringify(statement.when)}`);
    const attributes = row.column('Attributes');
    if (attributes === undefined) {
      fail(`${where}: the table the ${what} ${row.name} is in has no Attributes column`);
      continue;
    }
    const said = backticked(attributes);
    const keys = statement.attributes.map((attribute) => attribute.key);
    const values = statement.attributes.flatMap((attribute) => attribute.values ?? []);
    for (const key of keys) {
      if (!said.includes(key)) fail(`${where} does not name the attribute \`${key}\`, which ${statement.where} lists for the ${what} ${row.name}`);
    }
    for (const word of said) {
      if (!keys.includes(word) && !values.includes(word)) {
        fail(`${where} names \`${word}\` among the attributes of the ${what} ${row.name}; ${statement.where} lists no such key and no such value`);
      }
    }
  }
  for (const [name, statement] of stated) {
    if (!seen.has(name)) fail(`${PAGE} has no row for the ${what} ${name}, which ${statement.where} states: add one under "${heading}"`);
  }
}

hold('Metrics', (name) => name.startsWith('semiont.'), metrics, { what: 'metric', column: 'Type' });
hold('What gets traced', () => true, spans, { what: 'span', column: 'Kind' });

if (failures.length > 0) {
  console.error(`✗ lint:telemetry-doc — ${failures.length} problem(s):`);
  for (const failure of failures) console.error(`    ${failure}`);
  process.exit(1);
}
console.log(`✓ lint:telemetry-doc — ${metrics.size} metrics and ${spans.size} spans, each with its row in ${PAGE}, and every row one of them`);
