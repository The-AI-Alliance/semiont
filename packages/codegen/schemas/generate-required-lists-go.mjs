#!/usr/bin/env node
// Generate how each type of the Go SDK's package api writes a list its schema
// requires that Go holds as nil:
//
//   packages/go/sdk/api/required_lists_gen.go
//
// A nil slice is Go's empty list, and encoding/json writes it as null, which a
// member its schema requires may not be. So each type that holds such a list,
// among its own members or within the objects they hold, gets a MarshalJSON
// that writes each one Go holds as nil as [], on a copy: the caller's value
// is left as it was. It is the type's own encoding, so whatever encodes it
// writes the same: the client's own bus, the wire and a caller's json.Marshal.
//
// Which lists are required is the schemas', read by required-shapes.mjs. A
// schema's allOf is read as one object, as oapi-codegen writes it one struct.
// The Go name of each member is read off the struct oapi-codegen wrote of the
// schema (api/client_gen.go), by the name its json tag writes. A list this
// generator cannot place, a struct it cannot read and a type that has a
// MarshalJSON of its own fail it and its `--check`. The output is committed;
// `--check` compares without writing (the CI drift gate).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRequiredShapes } from './required-shapes.mjs';
import { writeOrCheck } from '../lib/committed-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const GENERATED = resolve(ROOT, 'packages/go/sdk/api/client_gen.go');
const OUT = resolve(ROOT, 'packages/go/sdk/api/required_lists_gen.go');
const CHECK = process.argv.includes('--check');

function refuse(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const { names, shapes } = readRequiredShapes(ROOT, refuse);

// ── Which lists each schema requires ─────────────────────────────────────

/** Whether `shape` is a list and nothing else. */
const isList = (shape) => shape.ref === undefined && JSON.stringify(shape.kinds) === '["array"]';

/** Whether `shape` is an object written in place, whose members Go holds in a struct of no name. */
const isObjectInPlace = (shape) => shape.ref === undefined && (shape.members !== undefined || shape.required !== undefined || shape.allOf !== undefined);

/** What an object requires and what each of its members is, its allOf's parts read into it. */
function membersOf(shape, where) {
  const required = new Set(shape.required);
  const members = new Map(Object.entries(shape.members ?? {}));
  for (const part of shape.allOf ?? []) {
    const merged = membersOf(part.ref === undefined ? part : shapes.get(part.ref), where);
    for (const name of merged.required) required.add(name);
    for (const [name, member] of merged.members) {
      const stated = members.get(name);
      if (stated === undefined) {
        members.set(name, member);
      } else if (JSON.stringify(stated) !== JSON.stringify(member) && [stated, member].some((shape) => isList(shape) || holdsList(shape))) {
        refuse(`${where}: its allOf states its member ${name} two ways, one of them a list or holding one, and Go holds it in one field`);
      }
    }
  }
  return { required, members };
}

/** Whether a list is required anywhere within `shape` where a type of its own does not hold it. */
function holdsList(shape) {
  if (shape.ref !== undefined) return false;
  const { required, members } = membersOf(shape, '');
  for (const [name, member] of members) {
    if ((required.has(name) && isList(member)) || holdsList(member)) return true;
  }
  return [shape.items, shape.values, ...(shape.oneOf ?? [])].some((part) => part !== undefined && holdsList(part));
}

/**
 * The lists an object requires, by the member that holds each: a member that
 * is one (`list`), and one whose object (`object`) or whose items (`items`)
 * hold some, each as this reads that object. Null where it holds none.
 */
function listsOf(shape, where) {
  if ((shape.oneOf ?? []).some(holdsList) || (shape.values !== undefined && holdsList(shape.values))) {
    refuse(`${where}: a list it requires is within a union or a map, which this generator does not write`);
  }
  const { required, members } = membersOf(shape, where);
  const lists = new Map();
  for (const [name, member] of members) {
    const at = `${where}.${name}`;
    if (member.ref !== undefined && required.has(name) && JSON.stringify(shapes.get(member.ref).kinds) === '["array"]') {
      refuse(`${at} is the list ${member.ref}, which this generator does not write`);
    }
    if (member.items !== undefined && !isObjectInPlace(member.items) && holdsList(member.items)) {
      refuse(`${at}: a list it requires is within a list's lists, which this generator does not write`);
    }
    if (!isObjectInPlace(member) && [member.values, ...(member.oneOf ?? [])].some((part) => part !== undefined && holdsList(part))) {
      refuse(`${at}: a list it requires is within a union or a map, which this generator does not write`);
    }
    const held = {
      list: required.has(name) && isList(member),
      object: isObjectInPlace(member) ? listsOf(member, at) : null,
      items: member.items !== undefined && isObjectInPlace(member.items) ? listsOf(member.items, `${at}[]`) : null,
    };
    if (held.list || held.object !== null || held.items !== null) lists.set(name, held);
  }
  return lists.size > 0 ? lists : null;
}

// ── The structs oapi-codegen wrote ────────────────────────────────────────

const lines = readFileSync(GENERATED, 'utf8').split('\n');
const marshalers = new Set(lines.map((line) => /^func \(\w+ \*?(\w+)\) MarshalJSON\(\)/.exec(line)?.[1]).filter((name) => name !== undefined));

/**
 * The fields of the struct whose body begins at line `start`, `depth` tabs in,
 * each by the name its json tag writes: its Go name, its type, whether it is
 * omitted when empty, and for a struct of no name, how the struct is held
 * (`holds`: '', '*', '[]' or '*[]') and its own fields.
 */
function structAt(start, depth, where) {
  const indent = '\t'.repeat(depth);
  const outer = '\t'.repeat(depth - 1);
  const fields = new Map();
  const add = (tag, field) => {
    const [name, ...options] = tag.split(',');
    fields.set(name, { ...field, omitempty: options.includes('omitempty'), order: fields.size });
  };
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.startsWith(`${indent}//`)) continue;
    if (depth === 1 && line === '}') return { fields, end: i };
    const closed = new RegExp(`^${outer}\\} \`json:"([^"]*)"\`$`).exec(line);
    if (closed !== null && depth > 1) return { fields, end: i, tag: closed[1] };
    const opened = new RegExp(`^${indent}(\\w+) ([*\\[\\]]*)struct \\{$`).exec(line);
    if (opened !== null) {
      const inner = structAt(i + 1, depth + 1, `${where}.${opened[1]}`);
      add(inner.tag, { go: opened[1], type: `${opened[2]}struct`, holds: opened[2], fields: inner.fields });
      i = inner.end;
      continue;
    }
    const field = new RegExp(`^${indent}(\\w+) +(\\S+) +\`json:"([^"]*)"\`$`).exec(line);
    if (field !== null) {
      add(field[3], { go: field[1], type: field[2] });
      continue;
    }
    refuse(`${GENERATED}:${i + 1}: a line of ${where} this generator cannot read: ${line.trim()}`);
  }
  refuse(`${GENERATED}: ${where} does not end`);
}

// ── The Go each type is written with ──────────────────────────────────────

const KEYWORDS = ['break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var'];
const INDICES = ['i', 'j', 'k'];
/** The names a method body here takes, which no copy may be named. */
const TAKEN = [...KEYWORDS, ...INDICES, 'v', 'written', 'json', 'slices', 'listOf', 'append', 'cap', 'copy', 'len', 'make', 'new', 'nil'];
let cloned = false;

/** The name of the copy of what `path` (the Go names of the fields it is within, and its own) holds. */
function copyOf(path, where) {
  const name = path[0].toLowerCase() + path.slice(1);
  if (TAKEN.includes(name)) refuse(`${where}: its copy would be named ${name}, which Go or this file already takes`);
  return name;
}

/**
 * The statements that write each list `lists` names in the struct value
 * `value`, whose fields are `fields`, as the empty list where Go holds it as
 * nil. `path` is what a copy within it is named after, `loops` how many loops
 * it is within, and `pad` the indentation of each statement.
 */
function statements(value, path, lists, fields, loops, where, pad) {
  const held = [...lists].map(([name, wanted]) => {
    const field = fields.get(name);
    if (field === undefined) refuse(`${where} has no field whose json tag writes ${name}`);
    return { name, wanted, field };
  });
  held.sort((a, b) => a.field.order - b.field.order);
  const out = [];
  for (const { name, wanted, field } of held) {
    const at = `${where}.${name}`;
    const member = `${value}.${field.go}`;
    const within = `${path}${field.go}`;
    if (wanted.list) {
      if (field.omitempty || !field.type.startsWith('[]')) refuse(`${at} is a list its schema requires, and Go holds it as ${field.type}${field.omitempty ? ', omitted when empty' : ''}`);
      out.push(`${pad}${member} = listOf(${member})`);
    }
    if (wanted.items !== null) {
      if (field.fields === undefined || !['[]', '*[]'].includes(field.holds)) refuse(`${at}: lists its items' schema requires are held in Go's ${field.type}`);
      if (loops === INDICES.length) refuse(`${at}: its lists are within more lists than this generator writes loops for`);
      const copy = copyOf(within, at);
      const index = INDICES[loops];
      const inPlace = field.holds === '[]';
      const inner = inPlace ? pad : `${pad}\t`;
      const each = statements(`${copy}[${index}]`, within, wanted.items, field.fields, loops + 1, `${at}[]`, `${inner}\t`);
      const loop = [`${inner}${copy} := slices.Clone(${inPlace ? member : `*${member}`})`, `${inner}for ${index} := range ${copy} {`, ...each, `${inner}}`, `${inner}${member} = ${inPlace ? copy : `&${copy}`}`];
      out.push(...(inPlace ? loop : [`${pad}if ${member} != nil {`, ...loop, `${pad}}`]));
      cloned = true;
    }
    if (wanted.object !== null) {
      if (field.fields === undefined || !['', '*'].includes(field.holds)) refuse(`${at}: lists its schema requires are held in Go's ${field.type}`);
      if (field.holds === '') {
        out.push(...statements(member, within, wanted.object, field.fields, loops, at, pad));
      } else {
        const copy = copyOf(within, at);
        out.push(
          `${pad}if ${member} != nil {`,
          `${pad}\t${copy} := *${member}`,
          ...statements(copy, within, wanted.object, field.fields, loops, at, `${pad}\t`),
          `${pad}\t${member} = &${copy}`,
          `${pad}}`,
        );
      }
    }
  }
  return out;
}

const methods = [];
for (const name of names) {
  const lists = listsOf(shapes.get(name), name);
  if (lists === null) continue;
  if (marshalers.has(name)) refuse(`${name} holds a list its schema requires, and package api writes it with a MarshalJSON of its own`);
  const start = lines.indexOf(`type ${name} struct {`);
  if (start === -1) refuse(`${name} holds a list its schema requires, and package api writes no struct of that name`);
  const { fields } = structAt(start + 1, 1, name);
  methods.push(`// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v ${name}) MarshalJSON() ([]byte, error) {
	type written ${name}
${statements('v', '', lists, fields, 0, name, '\t').join('\n')}
	return json.Marshal(written(v))
}
`);
}

const imports = cloned ? '(\n\t"encoding/json"\n\t"slices"\n)' : '"encoding/json"';
const text = `// Code generated from the component schemas of protocol/specs/src/openapi.json and api/client_gen.go — DO NOT EDIT.
//
// Regenerate: node packages/codegen/schemas/generate-required-lists-go.mjs

package api

import ${imports}

// listOf is list, or the empty list where Go holds list as nil. Go takes both
// for the empty list; encoding/json writes the one as [] and the other as
// null, which a member its schema requires may not be.
func listOf[S ~[]E, E any](list S) S {
	if list == nil {
		return S{}
	}
	return list
}

${methods.join('\n')}`;

writeOrCheck(ROOT, OUT, text, CHECK);
