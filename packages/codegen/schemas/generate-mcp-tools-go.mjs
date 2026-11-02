#!/usr/bin/env node
// generate-mcp-tools-go.mjs — the tools `semiont mcp` serves, from the table
// that curates them (packages/go/launcher/verbs/mcp-tools.json) and the
// spec's components it names.
//
//   packages/go/launcher/verbs/mcp_tools_gen.go   every tool, with its input
//                                                   and output schema, and
//                                                   every SDK method no tool
//                                                   calls, with its reason
//
// A tool's schemas restate nothing: each argument and each member of a result
// is a component, or a member of one, as the spec writes it, and the schema is
// made self-contained (openapi-schema.mjs): what it reaches under `$defs`,
// `nullable` translated. What is the tool's own — `kb`, an option such as
// `withText`, a result's wrapping — the table states as a schema of its own
// (`own`), and nothing else is. A member whose name starts with `_` is the
// gateway's to stamp (docs/protocol/EVENT-BUS.md) and is refused as an
// argument. A form this generator does not render is refused by name, rather
// than rendered as a guess.
//
// The tool table holds whether each SDK method is called; TestMCPToolsCensus,
// in the launcher, holds the table to specs/src/client/surface.json both ways.
//
// --check diffs without writing (the CI drift gate).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeOrCheck } from '../lib/committed-source.mjs';
import { component, selfContained } from './openapi-schema.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TABLE = 'packages/go/launcher/verbs/mcp-tools.json';
const OUT = resolve(ROOT, 'packages/go/launcher/verbs/mcp_tools_gen.go');
const CHECK = process.argv.includes('--check');

function refuse(where, message) {
  console.error(`✗ ${TABLE}: ${where}: ${message}`);
  process.exit(1);
}

function only(where, entry, keys) {
  for (const key of Object.keys(entry)) {
    if (!keys.includes(key)) refuse(where, `\`${key}\` is not a key this generator renders`);
  }
}

/** The schema of `member` as `name` writes it, refused when it has none or it is the gateway's. */
function memberOf(where, name, member) {
  if (member.startsWith('_')) refuse(where, `${name}.${member} is the gateway's to stamp, never a caller's`);
  const written = component(ROOT, name);
  const schema = written.properties?.[member];
  if (!schema) refuse(where, `${name} has no member ${member}`);
  return { schema, required: (written.required ?? []).includes(member) };
}

/** A schema the table names: a component, a member of one, a list of either, or the tool's own. */
function named(where, entry) {
  if (entry.own) return entry.own;
  if (entry.schema) return { $ref: `./${entry.schema}.json` };
  if (entry.listOf) {
    const items =
      typeof entry.listOf === 'string'
        ? { $ref: `./${entry.listOf}.json` }
        : memberOf(where, entry.listOf.from, entry.listOf.member).schema;
    return { type: 'array', items };
  }
  if (entry.from) return memberOf(where, entry.from, entry.member).schema;
  refuse(where, 'names no schema: it needs `own`, `schema`, `listOf`, or `from` and `member`');
}

/** An argument's name, schema and whether the call must state it. */
function argument(tool, entry) {
  const where = `${tool}'s argument ${entry.name ?? entry.member}`;
  only(where, entry, ['name', 'from', 'member', 'schema', 'listOf', 'own', 'required', 'optional']);
  if (entry.from && !entry.listOf) {
    if (entry.name) refuse(where, 'a member of a component is named as the component names it');
    if (entry.required !== undefined) refuse(where, 'a member of a component is required as the component requires it');
    const { schema, required } = memberOf(where, entry.from, entry.member);
    if (entry.optional !== undefined) {
      if (!required) refuse(where, `\`optional\` where ${entry.from} already leaves ${entry.member} optional`);
      return { name: entry.member, schema, required: false };
    }
    return { name: entry.member, schema, required };
  }
  if (!entry.name) refuse(where, 'needs a `name`');
  if (typeof entry.required !== 'boolean') refuse(where, 'needs `required`, true or false');
  return { name: entry.name, schema: named(where, entry), required: entry.required };
}

/** An object of the members given, each required or not, and nothing else. */
function object(members) {
  const properties = {};
  const required = [];
  for (const { name, schema, required: must } of members) {
    if (name in properties) refuse(name, 'is named twice');
    properties[name] = schema;
    if (must) required.push(name);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

/** `kb`: the MCP layer's own argument, on every tool that addresses a knowledge base. */
const KB = {
  name: 'kb',
  required: false,
  schema: {
    type: 'string',
    description:
      'The knowledge base the call is for, by the key knowledge_bases gives it: `local`, or `codespace:<owner>/<name>`. It may be left out when exactly one knowledge base is signed in.',
  },
};

/** A tool's output schema: the component it answers, or an object of the members it states. */
function output(tool, result) {
  if (result === undefined) return undefined;
  if (result.component) {
    only(`${tool}'s result`, result, ['component']);
    const written = component(ROOT, result.component);
    if (written.type !== 'object') refuse(`${tool}'s result`, `${result.component} is not an object, which a tool's structured result must be`);
    return selfContained(ROOT, written);
  }
  const members = Object.entries(result).map(([name, entry]) => {
    const where = `${tool}'s result member ${name}`;
    only(where, entry, ['required', 'schema', 'from', 'member', 'listOf', 'own']);
    if (typeof entry.required !== 'boolean') refuse(where, 'needs `required`, true or false');
    return { name, schema: named(where, entry), required: entry.required };
  });
  return selfContained(ROOT, object(members));
}

const table = JSON.parse(readFileSync(resolve(ROOT, TABLE), 'utf8'));
only('the table', table, ['$comment', 'tools', 'leftOut']);

const tools = table.tools.map((tool) => {
  only(tool.name, tool, ['name', 'title', 'description', 'calls', 'readOnly', 'destructive', 'arguments', 'result']);
  for (const key of ['name', 'title', 'description']) {
    if (typeof tool[key] !== 'string' || tool[key] === '') refuse(tool.name ?? 'a tool', `needs a \`${key}\``);
  }
  if (!Array.isArray(tool.calls)) refuse(tool.name, 'needs `calls`, the SDK methods it calls');
  const members = tool.arguments.map((entry) => argument(tool.name, entry));
  // A tool that calls no SDK method addresses no knowledge base.
  if (tool.calls.length > 0) members.unshift(KB);
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    calls: tool.calls,
    readOnly: tool.readOnly === true,
    destructive: tool.destructive === true,
    input: selfContained(ROOT, object(members)),
    ...(tool.result === undefined ? {} : { output: output(tool.name, tool.result) }),
  };
});

const leftOut = Object.fromEntries(Object.keys(table.leftOut).sort().map((method) => [method, table.leftOut[method]]));
const document = JSON.stringify({ tools, leftOut });

const text = `// Code generated from ${TABLE} and specs/src/components/schemas — DO NOT EDIT.
//
// Regenerate: node packages/codegen/schemas/generate-mcp-tools-go.mjs

package verbs

// mcpToolsDocument: every tool semiont mcp serves, in the order tools/list
// gives them, each with its input and output schema, and every method of the
// SDK's surface no tool calls, with its reason.
const mcpToolsDocument = ${JSON.stringify(document)}
`;

writeOrCheck(ROOT, OUT, text, CHECK);
