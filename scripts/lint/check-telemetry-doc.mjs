#!/usr/bin/env node
/**
 * lint:telemetry-doc — the operator's observability page lists exactly the
 * metrics Semiont exports, says of each what its statement says, and lists
 * no span that nothing makes.
 *
 * docs/operator/administration/OBSERVABILITY.md restates, by hand, what a
 * stack exports. A metric with no row is a series an operator cannot look up,
 * and a row with no metric promises one that never arrives. What is exported
 * is stated in three places, and the page is held to all three:
 *
 * - specs/src/service-telemetry/telemetry.json: what the gateway, the
 *   dispatcher, the Archivist and the Worker service export. Each is held to
 *   it from outside by its own conformance suite.
 * - specs/src/sdk-telemetry/telemetry.json: what an SDK's transports export,
 *   in any language.
 * - packages/observability/src: what the Node services (the Librarian, the
 *   Smelter and the Weaver) create. No table of specs/ lists those services,
 *   so what they create is read from the one package that creates it. A
 *   counter or a histogram is created at its first recording, so no running
 *   process lists them all: the source is read, with the TypeScript compiler.
 *
 * METRICS: the rows of the page's Metrics section, a row being a table row
 * that opens with a `semiont.…` name in backticks, under a header that names
 * its columns.
 *
 * 1. Every metric of the three has one row, and every row is a metric of one
 *    of the three.
 * 2. A row's Type is the instrument its statement gives: the table's
 *    `instrument`, or, for one only the package creates, the kind of
 *    instrument it creates.
 * 3. Of a metric a table lists, the row's Attributes names in backticks every
 *    attribute key the table lists, and nothing else in backticks there but a
 *    value the table lists for one of them. Where a table has a When column,
 *    the row's is the table's `when`.
 * 4. Every instrument the package creates has a literal `semiont.…` name, so
 *    that this gate reads it, and one whose name a table lists is of the
 *    table's kind.
 *
 * Not held: the attributes of a metric only the package creates, and what a
 * row says in prose.
 *
 * SPANS: the rows of the table under "What gets traced", a row being one
 * that opens with a span's name in backticks, written as the tables write it
 * (`bus.emit:{channel}`).
 *
 * 5. Every row is a span one of the three states, and its Kind is that
 *    span's. A span the package makes is one it hands `withSpan` by a name
 *    this gate can read, an interpolation written `{name}`.
 *
 * Not demanded of spans: a row for every span. The page lists some of what
 * the tables state, and the run says how many have no row.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PAGE = 'docs/operator/administration/OBSERVABILITY.md';
const TABLES = ['specs/src/service-telemetry/telemetry.json', 'specs/src/sdk-telemetry/telemetry.json'];
const PACKAGE = 'packages/observability/src';

/** The instrument each of the API's creating calls makes, in the tables' words. */
const CREATES = {
  createCounter: 'counter',
  createObservableCounter: 'counter',
  createUpDownCounter: 'up-down counter',
  createObservableUpDownCounter: 'up-down counter',
  createHistogram: 'histogram',
  createGauge: 'gauge',
  createObservableGauge: 'gauge',
};

const failures = [];
const fail = (message) => failures.push(message);
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

// ── what is stated ───────────────────────────────────────────────────────

/** metric → { where, instrument, attributes: [{ key, values }] | undefined, when } */
const metrics = new Map();
/** span → { where, kind } */
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
      else if (kind === 'metrics') into.set(row.name, { where: table, instrument: row.instrument, attributes: row.attributes ?? [], when: row.when });
      else into.set(row.name, { where: table, kind: row.kind });
    }
  }
}

function sources(directory) {
  return readdirSync(join(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

/** A span's name as the tables write one: a template's literal text, with each interpolation as `{name}`. */
function spanName(argument) {
  if (ts.isStringLiteralLike(argument)) return argument.text;
  if (!ts.isTemplateExpression(argument)) return undefined;
  let name = argument.head.text;
  for (const span of argument.templateSpans) {
    if (!ts.isIdentifier(span.expression)) return undefined;
    name += `{${span.expression.text}}` + span.literal.text;
  }
  return name;
}

/** The kind an options argument states: `kind: SpanKind.CONSUMER` is `consumer`. */
function spanKind(options) {
  if (options === undefined || !ts.isObjectLiteralExpression(options)) return undefined;
  for (const property of options.properties) {
    if (ts.isPropertyAssignment(property) && property.name.getText() === 'kind' && ts.isPropertyAccessExpression(property.initializer)) {
      return property.initializer.name.text.toLowerCase();
    }
  }
  return undefined;
}

let created = 0;
let made = 0;
for (const file of sources(PACKAGE)) {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  const at = (node) => `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && Object.hasOwn(CREATES, callee.name.text)) {
        created += 1;
        const instrument = CREATES[callee.name.text];
        const [first] = node.arguments;
        if (first === undefined || !ts.isStringLiteralLike(first) || !first.text.startsWith('semiont.')) {
          fail(`${at(node)} creates an instrument under a name this gate cannot read: give it a literal 'semiont.…' name`);
        } else if (!metrics.has(first.text)) {
          metrics.set(first.text, { where: PACKAGE, instrument, attributes: undefined, when: undefined });
        } else if (metrics.get(first.text).instrument !== instrument) {
          const stated = metrics.get(first.text);
          fail(`${at(node)} creates ${first.text} as a ${instrument}; ${stated.where} states a ${stated.instrument}`);
        }
      }
      if (ts.isIdentifier(callee) && callee.text === 'withSpan') {
        made += 1;
        const name = node.arguments[0] === undefined ? undefined : spanName(node.arguments[0]);
        const kind = spanKind(node.arguments[2]);
        if (name === undefined) fail(`${at(node)} makes a span under a name this gate cannot read: a literal, or a template whose interpolations are names`);
        else if (kind === undefined) fail(`${at(node)} makes the span ${name} and states no kind this gate can read (kind: SpanKind.…)`);
        else if (!spans.has(name)) spans.set(name, { where: PACKAGE, kind });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
if (created === 0) fail(`${PACKAGE} creates no instrument: the check has lost what it reads`);
if (made === 0) fail(`${PACKAGE} makes no span: the check has lost what it reads`);

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

// Rules 1 to 3.
const metricRows = rows('Metrics', (name) => name.startsWith('semiont.'));
if (metricRows.length === 0) fail(`${PAGE} has no metric row: the check has lost what it reads`);
const seen = new Set();
for (const row of metricRows) {
  const where = `${PAGE}:${row.number}`;
  if (seen.has(row.name)) fail(`${where} is a second row for ${row.name}: one row each`);
  seen.add(row.name);
  const stated = metrics.get(row.name);
  if (stated === undefined) {
    fail(`${where} is a row for ${row.name}, which nothing creates: neither table of specs/ lists it and ${PACKAGE} does not create it`);
    continue;
  }
  const type = row.column('Type');
  if (type !== stated.instrument) fail(`${where} says ${row.name} is ${JSON.stringify(type)}; ${stated.where} states a ${stated.instrument}`);
  if (stated.attributes === undefined) continue;
  const attributes = row.column('Attributes');
  if (attributes === undefined) {
    fail(`${where}: the table ${row.name} is in has no Attributes column`);
    continue;
  }
  const said = backticked(attributes);
  const keys = stated.attributes.map((attribute) => attribute.key);
  const values = stated.attributes.flatMap((attribute) => attribute.values ?? []);
  for (const key of keys) {
    if (!said.includes(key)) fail(`${where} does not name the attribute \`${key}\`, which ${stated.where} lists for ${row.name}`);
  }
  for (const word of said) {
    if (!keys.includes(word) && !values.includes(word)) {
      fail(`${where} names \`${word}\` among the attributes of ${row.name}; ${stated.where} lists no such key and no such value`);
    }
  }
  const when = row.column('When');
  if (when !== undefined && when !== stated.when) fail(`${where} gives ${row.name} the When ${JSON.stringify(when)}; ${stated.where} states ${JSON.stringify(stated.when)}`);
}
for (const [name, stated] of metrics) {
  if (!seen.has(name)) fail(`${PAGE} has no row for ${name}, which ${stated.where} states: add one to its Metrics section`);
}

// Rule 5.
const spanRows = rows('What gets traced', () => true);
if (spanRows.length === 0) fail(`${PAGE} has no span row: the check has lost what it reads`);
const listed = new Set();
for (const row of spanRows) {
  const where = `${PAGE}:${row.number}`;
  listed.add(row.name);
  const stated = spans.get(row.name);
  if (stated === undefined) {
    fail(`${where} is a row for the span ${row.name}, which nothing makes: neither table of specs/ lists it and ${PACKAGE} does not make it`);
    continue;
  }
  const kind = row.column('Kind');
  if (kind !== stated.kind) fail(`${where} says the span ${row.name} is ${JSON.stringify(kind)}; ${stated.where} states ${stated.kind}`);
}
const unlisted = [...spans.keys()].filter((name) => !listed.has(name));

if (failures.length > 0) {
  console.error(`✗ lint:telemetry-doc — ${failures.length} problem(s):`);
  for (const failure of failures) console.error(`    ${failure}`);
  process.exit(1);
}
console.log(
  `✓ lint:telemetry-doc — ${metrics.size} metrics, each with its row in ${PAGE} and every row a metric; ${spanRows.length} span rows, each a span of its kind, and ${unlisted.length} of ${spans.size} spans with no row`,
);
