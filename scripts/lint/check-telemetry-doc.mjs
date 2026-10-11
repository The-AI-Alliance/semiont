#!/usr/bin/env node
/**
 * lint:telemetry-doc — the operator's observability page lists exactly the
 * metrics and the spans Semiont exports, and says of each what its statement
 * says.
 *
 * docs/operator/administration/OBSERVABILITY.md restates, by hand, what a
 * stack exports. A metric or a span with no row is one an operator cannot
 * look up, and a row with none promises one that never arrives. What is
 * exported is stated in three places, and the page is held to all three:
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
 * A metric's rows are those of the page's "Metrics" section that open with a
 * `semiont.…` name in backticks. A span's are those of "What gets traced"
 * that open with a name in backticks, written as the tables write one
 * (`bus.emit:{channel}`). Each row is under a header that names its columns.
 * Of metrics and of spans alike:
 *
 * 1. Every one the three state has one row, and every row is one of them.
 * 2. A row's kind is its statement's. For a metric that is its Type: the
 *    table's `instrument`, or, for one only the package creates, the
 *    instrument it creates. For a span it is its Kind: the table's `kind`,
 *    or the `SpanKind` the package makes it with.
 * 3. Of one a table lists, the row's Attributes names in backticks every
 *    attribute key the table lists, and nothing else in backticks there but a
 *    value the table lists for one of them.
 * 4. Where the page's table has a When column, a row's is the table's `when`.
 *    A row whose statement gives none (a row of the SDKs' table, or one only
 *    the package creates) is in a table with no such column.
 * 5. Everything the package creates is readable here. An instrument has a
 *    literal `semiont.…` name, and one whose name a table lists is of the
 *    table's kind. A span is handed to `withSpan` under a literal name, or a
 *    template whose interpolations are names, each written `{name}` in the
 *    span's name, with its `kind: SpanKind.…` stated in the call.
 *
 * Not held: the attributes of a metric or a span only the package creates,
 * which of the page's tables a row is in (the page says who exports a thing
 * by the table it is in), and what a row says in prose.
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

/**
 * What is stated of each metric, and of each span, by name: `where` it is
 * stated; its `kind`, which for a metric is its instrument; the `attributes`
 * a table lists for it, each a key and the values it may have; and `when` it
 * is exported, where a table says. The last two are `undefined` for what
 * only the package creates.
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
          metrics.set(first.text, { where: PACKAGE, kind: instrument, attributes: undefined, when: undefined });
        } else if (metrics.get(first.text).kind !== instrument) {
          const stated = metrics.get(first.text);
          fail(`${at(node)} creates ${first.text} as a ${instrument}; ${stated.where} states a ${stated.kind}`);
        }
      }
      if (ts.isIdentifier(callee) && callee.text === 'withSpan') {
        made += 1;
        const name = node.arguments[0] === undefined ? undefined : spanName(node.arguments[0]);
        const kind = spanKind(node.arguments[2]);
        if (name === undefined) fail(`${at(node)} makes a span under a name this gate cannot read: a literal, or a template whose interpolations are names`);
        else if (kind === undefined) fail(`${at(node)} makes the span ${name} and states no kind this gate can read (kind: SpanKind.…)`);
        else if (!spans.has(name)) spans.set(name, { where: PACKAGE, kind, attributes: undefined, when: undefined });
        else if (spans.get(name).kind !== kind) fail(`${at(node)} makes the span ${name} as ${kind}; ${spans.get(name).where} states ${spans.get(name).kind}`);
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

/**
 * Hold a section's rows to what is `stated` of them (rules 1 to 4). `what`
 * is the word for one, `column` the column its kind is in, and `does` what
 * making one is called.
 */
function hold(heading, named, stated, { what, column, does }) {
  const found = rows(heading, named);
  if (found.length === 0) fail(`${PAGE} has no ${what} row under "${heading}": the check has lost what it reads`);
  const seen = new Set();
  for (const row of found) {
    const where = `${PAGE}:${row.number}`;
    if (seen.has(row.name)) fail(`${where} is a second row for the ${what} ${row.name}: one row each`);
    seen.add(row.name);
    const statement = stated.get(row.name);
    if (statement === undefined) {
      fail(`${where} is a row for the ${what} ${row.name}, which nothing ${does}s: neither table of specs/ lists it and ${PACKAGE} does not ${does} it`);
      continue;
    }
    const kind = row.column(column);
    if (kind !== statement.kind) fail(`${where} says the ${what} ${row.name} is ${JSON.stringify(kind)}; ${statement.where} states ${JSON.stringify(statement.kind)}`);
    const when = row.column('When');
    if (when !== undefined && statement.when === undefined) fail(`${where} gives the ${what} ${row.name} a When, and ${statement.where} states none`);
    else if (when !== undefined && when !== statement.when) fail(`${where} gives the ${what} ${row.name} the When ${JSON.stringify(when)}; ${statement.where} states ${JSON.stringify(statement.when)}`);
    if (statement.attributes === undefined) continue;
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

hold('Metrics', (name) => name.startsWith('semiont.'), metrics, { what: 'metric', column: 'Type', does: 'create' });
hold('What gets traced', () => true, spans, { what: 'span', column: 'Kind', does: 'make' });

if (failures.length > 0) {
  console.error(`✗ lint:telemetry-doc — ${failures.length} problem(s):`);
  for (const failure of failures) console.error(`    ${failure}`);
  process.exit(1);
}
console.log(`✓ lint:telemetry-doc — ${metrics.size} metrics and ${spans.size} spans, each with its row in ${PAGE}, and every row one of them`);
