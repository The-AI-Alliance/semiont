#!/usr/bin/env node
/**
 * lint:state-unit-cases — specs/src/client/state-units.json, the cases every
 * SDK runs against its state units, says only what its runners can read.
 *
 * Each SDK's runner reads the table as its `$comment` states it, and a case
 * a runner cannot read fails there late, in one SDK, or passes for the wrong
 * reason. So this fails on:
 *
 * - a case of a unit specs/src/client/surface.json's `stateUnits` does not
 *   name, a case named twice, or a key a case does not have;
 * - a transport, a unit's making, or a step of a form the table does not
 *   define, or that names a unit the case did not make;
 * - a member a step reads or calls that the unit's row of `stateUnits` does
 *   not list;
 * - a channel the bus registry does not declare; a request, a reply or a
 *   queued response on a channel that is not an operation's; a reply that is
 *   not the result or the failure of the request it answers; a frame heard on
 *   a channel the case does not listen to;
 * - a duration that names no timing of specs/src/client/timing.json, or comes
 *   to less than nothing;
 * - a search answered or its queries checked in a case that is not a search
 *   pipeline's;
 * - a motivation `MarkJobParams` tells apart that no case of the mark unit
 *   delegates a job of;
 * - a fixture that does not exist, or one no case uses;
 * - a case with no step that checks anything: it drives, and asserts nothing.
 *
 * What a case says the units do is each SDK's runner's to hold.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TABLE = 'specs/src/client/state-units.json';
const read = (path) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));

const table = read(TABLE);
const surface = read('specs/src/client/surface.json');
const registry = read('specs/src/bus/registry.json');
const timing = new Map(read('specs/src/client/timing.json').timing.map((entry) => [entry.name, entry.value]));

const failures = [];
const fail = (message) => failures.push(message);

const rows = new Map((surface.stateUnits ?? []).map((row) => [row.unit, new Set(row.members.map((member) => member.member))]));
const channels = new Set(registry.channels.map((entry) => entry.channel));
const operations = new Map(registry.operations.map((operation) => [operation.request, operation]));

/** What each unit is made from: every argument it takes, and whether each must be given. */
const MADE = {
  match: {},
  beckon: {},
  hoverDwell: { delayMs: 'duration' },
  gather: { resourceId: 'string' },
  mark: { resourceId: 'string' },
  yield: { locale: 'string' },
  search: { debounceMs: 'duration?', initialQuery: 'string?' },
  sessionSignals: {},
};
const ANSWERS = ['refuses', 'never', 'jobs'];
const CHECKS = ['expect', 'sent', 'nothingSent', 'heard', 'ended', 'busDestroyed', 'searched'];
/** Steps of a search pipeline's case alone: only it searches with the case's search. */
const SEARCHING = ['answerSearch', 'searched'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const used = new Set();

/** Every `{"$fixture": name}` in `value` names a fixture. */
function fixtures(value, where) {
  if (Array.isArray(value)) return value.forEach((item) => fixtures(item, where));
  if (!isObject(value)) return;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === '$fixture') {
    if (!(value.$fixture in (table.fixtures ?? {}))) fail(`${where}: names the fixture ${value.$fixture}, which the table does not have`);
    used.add(value.$fixture);
    return;
  }
  for (const key of keys) fixtures(value[key], where);
}

function duration(value, where) {
  if (Number.isInteger(value)) {
    if (value < 0) fail(`${where}: a duration of ${value} ms is less than nothing`);
    return;
  }
  if (!isObject(value) || Object.keys(value).some((key) => !['timing', 'times', 'plusMs'].includes(key))) {
    fail(`${where}: a duration is milliseconds, or {"timing", "times"?, "plusMs"?}`);
    return;
  }
  const base = timing.get(value.timing);
  if (typeof base !== 'number' || !value.timing.endsWith('Ms')) {
    fail(`${where}: ${value.timing} is no duration of specs/src/client/timing.json`);
    return;
  }
  const times = value.times ?? 1;
  const plus = value.plusMs ?? 0;
  if (typeof times !== 'number' || times <= 0 || !Number.isInteger(plus)) fail(`${where}: \`times\` is a number above nothing and \`plusMs\` a whole number`);
  else if (base * times + plus < 0) fail(`${where}: comes to ${base * times + plus} ms, less than nothing`);
}

function channel(name, where) {
  if (!channels.has(name)) fail(`${where}: ${name} is no channel of the bus registry`);
}

function request(name, where) {
  if (!operations.has(name)) fail(`${where}: ${name} is no operation's request in the bus registry`);
}

const caseNames = new Set();
for (const [index, c] of (table.cases ?? []).entries()) {
  const where = `${TABLE}: cases[${index}] (${c.unit}: ${c.case})`;
  const strays = Object.keys(c).filter((key) => !['unit', 'case', 'transport', 'made', 'listen', 'steps'].includes(key));
  if (strays.length > 0) fail(`${where} states ${strays.join(', ')}, which a case does not have`);
  const members = rows.get(c.unit);
  if (!members) fail(`${where}: ${c.unit} is no row of \`stateUnits\` in specs/src/client/surface.json`);
  if (typeof c.case !== 'string' || c.case === '') fail(`${where} does not say what it is (\`case\`)`);
  if (caseNames.has(`${c.unit}: ${c.case}`)) fail(`${where} is named twice`);
  caseNames.add(`${c.unit}: ${c.case}`);

  // The transport.
  const transport = c.transport;
  if (!isObject(transport) || !ANSWERS.includes(transport.answers)) fail(`${where}: \`transport.answers\` is one of ${ANSWERS.join(', ')}`);
  for (const key of Object.keys(transport ?? {})) {
    if (!['answers', 'replies', 'delayMs'].includes(key)) fail(`${where}: the transport states ${key}, which a transport does not have`);
  }
  if (transport?.delayMs !== undefined) duration(transport.delayMs, `${where}: transport.delayMs`);
  for (const [operation, responses] of Object.entries(transport?.replies ?? {})) {
    request(operation, `${where}: transport.replies`);
    if (!Array.isArray(responses)) fail(`${where}: transport.replies.${operation} is a list of responses`);
  }

  // The units it makes.
  const made = c.made;
  if (!isObject(made) || Object.keys(made).length === 0) fail(`${where} makes no unit (\`made\`)`);
  const takes = MADE[c.unit];
  for (const [name, args] of Object.entries(made ?? {})) {
    if (!takes || !isObject(args)) {
      fail(`${where}: made.${name} is not how this table makes a ${c.unit} unit`);
      continue;
    }
    for (const [arg, kind] of Object.entries(takes)) {
      if (!kind.endsWith('?') && args[arg] === undefined) fail(`${where}: made.${name} does not give ${arg}, which a ${c.unit} unit is made from`);
    }
    for (const [arg, value] of Object.entries(args)) {
      const kind = takes[arg];
      if (kind === undefined) fail(`${where}: made.${name} gives ${arg}, which a ${c.unit} unit is not made from`);
      else if (kind.startsWith('duration')) duration(value, `${where}: made.${name}.${arg}`);
      else if (typeof value !== 'string') fail(`${where}: made.${name}.${arg} is a string`);
    }
  }
  const unitNamed = (name, step) => {
    if (!(name in (made ?? {}))) fail(`${step} names ${name}, a unit the case did not make`);
  };
  const memberOf = (member, step) => {
    if (members && !members.has(member)) fail(`${step} names ${member}, which the ${c.unit} row of \`stateUnits\` does not list`);
  };

  const listened = new Set(c.listen ?? []);
  for (const name of listened) channel(name, `${where}: listen`);

  // The steps.
  if (!Array.isArray(c.steps) || c.steps.length === 0) {
    fail(`${where} has no steps`);
    continue;
  }
  let checks = 0;
  for (const [at, step] of c.steps.entries()) {
    const said = `${where}: steps[${at}]`;
    if (step === 'settle') continue;
    if (!isObject(step)) {
      fail(`${said} is neither "settle" nor a step`);
      continue;
    }
    const kinds = Object.keys(step).filter((key) => [...CHECKS, 'say', 'deliver', 'answer', 'queueReply', 'invoke', 'pass', 'dispose', 'answerSearch'].includes(key));
    if (kinds.length !== 1) {
      fail(`${said} is ${kinds.length === 0 ? 'no step this table defines' : `several steps at once (${kinds.join(', ')})`}`);
      continue;
    }
    const [kind] = kinds;
    if (CHECKS.includes(kind)) checks++;
    const allowed = {
      say: ['payload', 'correlationId'],
      deliver: ['payload', 'correlationId'],
      answer: ['nth', 'reply', 'payload'],
      queueReply: ['response'],
      invoke: ['of', 'args'],
      sent: ['payloads', 'count'],
      answerSearch: ['results'],
    }[kind] ?? [];
    const extra = Object.keys(step).filter((key) => key !== kind && !allowed.includes(key));
    if (extra.length > 0) fail(`${said}: a ${kind} step does not state ${extra.join(', ')}`);
    fixtures(step, said);
    if (SEARCHING.includes(kind) && c.unit !== 'search') fail(`${said}: only a search pipeline's case has a search to ${kind === 'searched' ? 'ask' : 'answer'}`);

    switch (kind) {
      case 'say':
      case 'deliver':
        channel(step[kind], said);
        if (!isObject(step.payload)) fail(`${said}: a ${kind} step gives the frame's payload`);
        if (step.correlationId !== undefined && typeof step.correlationId !== 'string') fail(`${said}: a correlation id is a string`);
        break;
      case 'answer': {
        request(step.answer, said);
        const operation = operations.get(step.answer);
        if (operation && step.reply !== operation.result && step.reply !== operation.failure) fail(`${said}: ${step.answer} is answered on ${operation.result} or ${operation.failure}, not ${step.reply}`);
        if (!Number.isInteger(step.nth) || step.nth < 0) fail(`${said}: \`nth\` counts from 0`);
        if (!isObject(step.payload)) fail(`${said}: an answer gives the reply's payload`);
        break;
      }
      case 'queueReply':
        request(step.queueReply, said);
        if (!('response' in step)) fail(`${said}: a queued reply gives its response, or null`);
        break;
      case 'invoke':
        unitNamed(step.of, said);
        memberOf(step.invoke, said);
        if (!isObject(step.args)) fail(`${said}: an invoke gives its arguments, by name`);
        break;
      case 'pass':
        duration(step.pass, said);
        break;
      case 'dispose':
        unitNamed(step.dispose, said);
        break;
      case 'expect':
      case 'ended':
        if (!isObject(step[kind])) {
          fail(`${said}: ${kind} names units`);
          break;
        }
        for (const [name, held] of Object.entries(step[kind])) {
          unitNamed(name, said);
          for (const member of kind === 'expect' ? Object.keys(held ?? {}) : held ?? []) memberOf(member, said);
        }
        break;
      case 'sent':
        request(step.sent, said);
        if ((step.payloads === undefined) === (step.count === undefined)) fail(`${said}: a sent step gives the requests' payloads or their count`);
        if (step.count !== undefined && (!Number.isInteger(step.count) || step.count < 0)) fail(`${said}: a count is a whole number`);
        if (step.payloads !== undefined && !Array.isArray(step.payloads)) fail(`${said}: payloads is a list`);
        break;
      case 'nothingSent':
        if (step.nothingSent !== true) fail(`${said}: nothingSent is true, or no step`);
        break;
      case 'busDestroyed':
        if (typeof step.busDestroyed !== 'boolean') fail(`${said}: busDestroyed is true or false`);
        break;
      case 'answerSearch':
        if (!Number.isInteger(step.answerSearch) || step.answerSearch < 0) fail(`${said}: \`answerSearch\` counts the queries asked from 0`);
        if (step.results !== null && !(Array.isArray(step.results))) fail(`${said}: an answer's results are a list, or null for one still on its way`);
        break;
      case 'searched':
        if (!Array.isArray(step.searched) || step.searched.some((query) => typeof query !== 'string')) fail(`${said}: searched lists the queries asked, each a string`);
        break;
      case 'heard':
        if (!Array.isArray(step.heard)) {
          fail(`${said}: heard is a list of frames`);
          break;
        }
        for (const frame of step.heard) {
          const strays = Object.keys(frame).filter((key) => !['channel', 'payload', 'correlationId'].includes(key));
          if (strays.length > 0) fail(`${said}: a frame heard does not state ${strays.join(', ')}`);
          if (!listened.has(frame.channel)) fail(`${said}: ${frame.channel} is heard, and the case does not listen to it`);
          const id = frame.correlationId;
          if (isObject(id)) {
            request(id.sent, said);
            if (!Number.isInteger(id.nth) || id.nth < 0) fail(`${said}: a request's correlation id is {"sent", "nth"}`);
          } else if (id !== undefined && typeof id !== 'string') {
            fail(`${said}: a correlation id is a string, or {"sent", "nth"}`);
          }
        }
        break;
    }
  }
  if (checks === 0) fail(`${where} checks nothing: it drives its units and states nothing they did`);
}

// The mark unit reads a job's motivation off its parameters, whichever member of
// MarkJobParams they are: its cases delegate a job of every motivation the spec tells apart.
const toldApart = Object.keys(read('specs/src/components/schemas/MarkJobParams.json').discriminator?.mapping ?? {});
if (toldApart.length === 0) fail('specs/src/components/schemas/MarkJobParams.json tells its members apart by no mapping this lint can read');
const delegated = new Set(
  (table.cases ?? [])
    .filter((c) => c.unit === 'mark')
    .flatMap((c) => c.steps ?? [])
    .filter((step) => isObject(step) && step.say === 'mark:delegate-request')
    .map((step) => step.payload?.params?.motivation),
);
const undelegated = toldApart.filter((motivation) => !delegated.has(motivation));
if (undelegated.length > 0) fail(`${TABLE}: no case of the mark unit delegates a job of ${undelegated.join(', ')}, which MarkJobParams tells apart`);

// A fixture may be made of another.
for (const [name, value] of Object.entries(table.fixtures ?? {})) fixtures(value, `${TABLE}: fixtures.${name}`);
for (const name of Object.keys(table.fixtures ?? {})) {
  if (!used.has(name)) fail(`${TABLE}: the fixture ${name} is used by no case`);
}
const strays = Object.keys(table).filter((key) => !['$comment', 'fixtures', 'cases'].includes(key));
if (strays.length > 0) fail(`${TABLE} states ${strays.join(', ')}, which the table does not have`);

if (failures.length > 0) {
  console.error(`✗ lint:state-unit-cases — ${failures.length} problem${failures.length === 1 ? '' : 's'}`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
const counted = [...rows.keys()].map((unit) => `${(table.cases ?? []).filter((c) => c.unit === unit).length} ${unit}`).join(', ');
console.log(`✓ lint:state-unit-cases — ${table.cases.length} cases (${counted}), each read as the table defines it`);
