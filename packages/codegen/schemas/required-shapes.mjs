// required-shapes.mjs — what each component schema requires of a value: the
// kinds of value it may be, the values and the form it may take, the members
// it must and may carry and what each member must be. The table every SDK
// holds a reply to before it reads it.
//
//   packages/codegen/schemas/generate-required-ts.mjs     → packages/typescript/core/src/generated/required-schemas.ts
//   packages/codegen/schemas/generate-required-go.mjs     → packages/go/sdk/internal/required/schemas_gen.json
//   packages/codegen/schemas/generate-required.mjs        → packages/rust/sdk/src/required-schemas.json and
//                                                           packages/kotlin/sdk/src/codegen/required-schemas.json
//   packages/codegen/schemas/generate-required-python.mjs → packages/python/sdk/src/semiont/_required_table.py
//
// Each SDK walks a payload by this table before it decodes it, so every SDK
// finds the same first FAULT in it, names it the same way, and refuses it.
// The table states whatever the schemas state that some SDK's decoding
// refuses, so a payload the table passes is one every SDK decodes. Two
// things a schema states no SDK's decoding refuses, and the table leaves
// them out: a `format` (a date-time or a URI is text in every SDK) and
// `uniqueItems`. What a decoding refuses that no schema states (a number past
// what its integer type holds, and 1.0 where an integer is required, below)
// it refuses as a fault at the payload itself. A schema that states anything
// else this file does not know how to state fails the generators, so the
// table cannot fall behind the schemas unseen.
//
// A KIND is one of object, array, string, integer, number, boolean, null. An
// integer is a number with no fractional part, as JSON Schema has it: 1.5 is
// no integer and 1.0 is one, so a value that states 1.0 where an integer is
// required passes the table, and is then refused by an SDK whose decoding
// reads an integer only from a number written without a fraction. A number
// is any number, an integer among them.
//
// A SHAPE is what a value must be, and each of its parts holds where it
// applies:
//
//   - `ref`: the value is the component of that name, and is what it is;
//   - `kinds`: the kinds the value may be. A shape that states none allows
//     any;
//   - `enum`: the value is one of these. A number is one of them where it is
//     equal to one in value (1.0 is 1);
//   - `pattern`: a text is of this form: a series of steps, each a set of
//     code points (`of`, ranges from and to, both included) the text's next
//     code points are in, at least `min` of them and at most `max` (no `max`:
//     any number), the steps taking the whole text between them. It is the
//     schema's pattern, which is anchored at both ends and read as ECMA-262
//     reads it (`.` is any code point but a line terminator, `\s` is
//     ECMA-262's white space and line terminators), spelled out so that no
//     SDK reads it by a regular-expression engine of its own;
//   - `minLength`, `maxLength`: the fewest and most code points a text has;
//   - `minimum`, `maximum`: the least and greatest a number is, each
//     allowed;
//   - `minItems`, `maxItems`: the fewest and most items an array has;
//   - `required`: an object carries each of these members. One may hold null
//     only where its shape in `members` allows null, and a member with no
//     shape there allows anything;
//   - `members`: what an object's member must be, where the object has it
//     and it is not null;
//   - `closed`: an object carries no member but these (the schema's
//     `additionalProperties: false`, or its `maxProperties: 0`);
//   - `items`: what each item of an array must be;
//   - `values`: what each value of a map must be;
//   - `oneOf`: the value is one of these variants (the spec's `oneOf` or
//     `anyOf`), and is what that one is. The variants whose kinds allow the
//     value's kind are the ones it may be, and a `discriminator` the value
//     states names the one it is;
//   - `allOf`: the value is what each of these is.
//
// A shape of an object's member, an array's item, a map's value or a
// composite's part that can be wrong in no way is left out, and so is a
// union none of whose variants can: what is left is what a value can be
// wrong in. A component that can be wrong in no way is the empty shape.
//
// A READER of the table names the first fault of a value by its WAY (the
// names of the members it is within, and its own, joined by dots; the empty
// way is the value itself) and its REASON, `lacks` or `malformed`. It walks a
// shape so:
//
//   1. a value whose kind the shape's kinds do not allow is malformed;
//   2. a value that is none of the shape's `enum` is malformed;
//   3. a text not of the shape's pattern, or with fewer or more code points
//      than it allows, a number below or above what it allows, and an array
//      with fewer or more items than it allows, is malformed;
//   4. of an object, each required member in the order the schema states
//      them: one it does not carry, or that holds null where null is not
//      allowed, it lacks;
//   5. then each member the shape describes, in the order the table states
//      them (by name), that the object has and is not null: its faults. An
//      optional member that holds null is no fault, whatever its shape: every
//      SDK's decoding reads it as absent;
//   6. then, of a closed shape, a member the object carries that the shape
//      does not name is malformed, the first of them by the order of their
//      names' code points;
//   7. then each value of a map, by its keys' order: its faults, at the map's
//      way;
//   8. of an array, each item in its order: its faults, at the array's way;
//   9. of a union, the variant its discriminator names, or else each variant
//      whose kinds allow the value's: the value has no fault when one of them
//      has none, and the first one's fault when each has one; a value no
//      variant allows is malformed;
//  10. then each part of a composite in its order: its faults.
//
// An array's positions and a map's keys are not said: they are the value's,
// not its schema's. So an item or a map's value that is null where null is
// not allowed is malformed at the array's or the map's way: it is not a
// member. Names are ordered by their code points, in the table and by every
// reader.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { translated } from './openapi-schema.mjs';

const KINDS = ['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'];

/** What a schema may state: what the table states of it, and what it leaves out because no SDK's decoding refuses it. */
const STATED = ['type', 'enum', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'properties', 'required', 'additionalProperties', 'maxProperties', 'items', 'oneOf', 'anyOf', 'allOf', '$ref', 'discriminator'];
const LEFT_OUT = ['format', 'uniqueItems'];
/** What says something of a schema to a reader, and nothing of a value. */
const ANNOTATIONS = ['description', 'title', 'example', 'examples', 'default', '$comment', 'deprecated', 'readOnly', 'writeOnly'];

/** The greatest code point. */
const LAST = 0x10ffff;
/** ECMA-262's white space and line terminators: `\s`. */
const WHITE_SPACE = [[0x09, 0x0d], [0x20, 0x20], [0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a], [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000], [0xfeff, 0xfeff]];
/** ECMA-262's line terminators, which `.` is none of. */
const LINE_TERMINATORS = [[0x0a, 0x0a], [0x0d, 0x0d], [0x2028, 0x2029]];
const DIGITS = [[0x30, 0x39]];
const WORD = [[0x30, 0x39], [0x41, 0x5a], [0x5f, 0x5f], [0x61, 0x7a]];

/** `ranges` sorted, with those that touch or overlap made one. */
function merged(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [from, to] of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}

/** Every code point `ranges` leave out. */
function complement(ranges) {
  const out = [];
  let next = 0;
  for (const [from, to] of merged(ranges)) {
    if (from > next) out.push([next, from - 1]);
    next = to + 1;
  }
  if (next <= LAST) out.push([next, LAST]);
  return out;
}

/** The order of two names by their code points. */
export function byCodePoint(a, b) {
  const x = [...a].map((c) => c.codePointAt(0));
  const y = [...b].map((c) => c.codePointAt(0));
  for (let at = 0; at < Math.min(x.length, y.length); at += 1) if (x[at] !== y[at]) return x[at] - y[at];
  return x.length - y.length;
}

/**
 * A schema's `pattern` as the steps a text of its form takes, or `undefined`
 * when it is not one this can spell out: anchored at both ends, a series of
 * single characters, character sets (`[...]`, `[^...]`), `.`, `\s`, `\S`, `\d`,
 * `\D`, `\w` and `\W`, each with no quantifier or with `?`, `*`, `+`, `{n}`,
 * `{n,}` or `{n,m}`.
 */
function stepsOf(pattern) {
  if (!pattern.startsWith('^') || !pattern.endsWith('$') || pattern.endsWith('\\$')) return undefined;
  const body = [...pattern.slice(1, -1)];
  const steps = [];
  let at = 0;
  const escaped = (c) => {
    switch (c) {
      case 's': return WHITE_SPACE;
      case 'S': return complement(WHITE_SPACE);
      case 'd': return DIGITS;
      case 'D': return complement(DIGITS);
      case 'w': return WORD;
      case 'W': return complement(WORD);
      default: return /[\\^$.|?*+()[\]{}\/:-]/.test(c) ? [[c.codePointAt(0), c.codePointAt(0)]] : undefined;
    }
  };
  while (at < body.length) {
    const c = body[at];
    let of;
    if (c === '[') {
      at += 1;
      const negated = body[at] === '^';
      if (negated) at += 1;
      const ranges = [];
      while (at < body.length && body[at] !== ']') {
        let from = body[at];
        if (from === '[') return undefined;
        if (from === '\\') {
          at += 1;
          if (!/[\\\]\[^\-.]/.test(body[at] ?? '')) return undefined;
          from = body[at];
        }
        if (body[at + 1] === '-' && body[at + 2] !== undefined && body[at + 2] !== ']') {
          const to = body[at + 2];
          if (to === '\\' || to === '[') return undefined;
          ranges.push([from.codePointAt(0), to.codePointAt(0)]);
          at += 3;
        } else {
          ranges.push([from.codePointAt(0), from.codePointAt(0)]);
          at += 1;
        }
      }
      if (body[at] !== ']' || ranges.length === 0) return undefined;
      at += 1;
      of = negated ? complement(ranges) : merged(ranges);
    } else if (c === '.') {
      at += 1;
      of = complement(LINE_TERMINATORS);
    } else if (c === '\\') {
      of = escaped(body[at + 1] ?? '');
      if (of === undefined) return undefined;
      at += 2;
    } else if ('^$|?*+(){}]'.includes(c)) {
      return undefined;
    } else {
      at += 1;
      of = [[c.codePointAt(0), c.codePointAt(0)]];
    }
    let min = 1;
    let max = 1;
    const q = body[at];
    if (q === '?') [min, max, at] = [0, 1, at + 1];
    else if (q === '*') [min, max, at] = [0, undefined, at + 1];
    else if (q === '+') [min, max, at] = [1, undefined, at + 1];
    else if (q === '{') {
      const close = body.indexOf('}', at);
      const bounds = close === -1 ? null : body.slice(at + 1, close).join('').match(/^(\d+)(,(\d*))?$/);
      if (bounds === null) return undefined;
      min = Number(bounds[1]);
      max = bounds[2] === undefined ? min : bounds[3] === '' ? undefined : Number(bounds[3]);
      at = close + 1;
    }
    if (body[at] !== undefined && '?*+{'.includes(body[at])) return undefined;
    steps.push(max === undefined ? { of, min } : { of, min, max });
  }
  return steps;
}

/** Whether `kinds` allow a value of `kind`: a number allows an integer. */
const allows = (kinds, kind) => kinds.has(kind) || (kind === 'integer' && kinds.has('number'));

/** `kinds` in the order KINDS states them, without an integer a number already allows. */
const ordered = (kinds) => KINDS.filter((kind) => kinds.has(kind) && !(kind === 'integer' && kinds.has('number')));

/** Whether `kinds` allow every value. */
const anyKind = (kinds) => KINDS.every((kind) => allows(kinds, kind));

/** The kind of a value stated in a schema (an `enum`'s). */
function kindOfValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/**
 * Every component schema the spec names (protocol/specs/src/openapi.json), each with
 * the shape it requires of a value. `refuse` is called with what makes the
 * schemas unreadable as shapes, and does not return.
 */
export function readRequiredShapes(root, refuse) {
  const specs = resolve(root, 'protocol/specs/src');
  const index = JSON.parse(readFileSync(resolve(specs, 'openapi.json'), 'utf8')).components.schemas;

  /** Each component's file, and the component each file is. */
  const fileOf = new Map();
  const nameOf = new Map();
  for (const [name, { $ref }] of Object.entries(index)) {
    if (typeof $ref !== 'string') refuse(`components.schemas.${name} refers to no file`);
    const file = resolve(specs, $ref);
    fileOf.set(name, file);
    nameOf.set(file, name);
  }
  // Read as JSON Schema, translated where every generator translates the spec's components.
  const schemaOf = new Map([...fileOf].map(([name, file]) => [name, translated(JSON.parse(readFileSync(file, 'utf8')))]));

  /** The component a reference in `file` names. */
  function referred(file, ref) {
    const name = nameOf.get(resolve(dirname(file), ref));
    if (name === undefined) refuse(`${file}: ${ref} names no component of protocol/specs/src/openapi.json`);
    return name;
  }

  /** The kinds of value `schema` (written in `file`) allows. */
  const kindsOfComponent = new Map();
  function kindsOf(schema, file) {
    if (schema.$ref !== undefined) {
      const name = referred(file, schema.$ref);
      if (!kindsOfComponent.has(name)) {
        // A component that refers to itself before it says its kind may be any.
        kindsOfComponent.set(name, new Set(KINDS));
        kindsOfComponent.set(name, kindsOf(schemaOf.get(name), fileOf.get(name)));
      }
      return kindsOfComponent.get(name);
    }
    if (schema.type !== undefined) return new Set(Array.isArray(schema.type) ? schema.type : [schema.type]);
    if (schema.allOf !== undefined) {
      let kinds = new Set(KINDS);
      for (const part of schema.allOf) {
        const allowed = kindsOf(part, file);
        kinds = new Set(KINDS.filter((kind) => allows(kinds, kind) && allows(allowed, kind)));
      }
      return kinds;
    }
    if (schema.oneOf !== undefined || schema.anyOf !== undefined) {
      return new Set((schema.oneOf ?? schema.anyOf).flatMap((variant) => [...kindsOf(variant, file)]));
    }
    if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) return new Set(['object']);
    if (schema.items !== undefined) return new Set(['array']);
    if (schema.enum !== undefined) return new Set(schema.enum.map(kindOfValue));
    return new Set(KINDS);
  }

  /** `schema`, written in `file`, as a shape, before what can be wrong in no way is left out. */
  function shapeOf(schema, file) {
    for (const key of Object.keys(schema)) {
      if (!STATED.includes(key) && !LEFT_OUT.includes(key) && !ANNOTATIONS.includes(key)) {
        refuse(`${file}: a schema states \`${key}\`, which the table does not know how to state`);
      }
    }
    if (schema.$ref !== undefined) return { ref: referred(file, schema.$ref) };
    const own = Object.keys(schema).filter((key) => STATED.includes(key) && key !== 'allOf' && key !== 'discriminator');
    // `allOf` around one schema only describes it.
    if (schema.allOf?.length === 1 && own.length === 0) return shapeOf(schema.allOf[0], file);
    const shape = {};
    const kinds = kindsOf(schema, file);
    if (!anyKind(kinds)) shape.kinds = ordered(kinds);
    if (schema.enum !== undefined) {
      if (!Array.isArray(schema.enum) || schema.enum.length === 0) refuse(`${file}: an enum states no values`);
      for (const value of schema.enum) {
        if (value !== null && typeof value === 'object') refuse(`${file}: an enum states ${JSON.stringify(value)}, and the table states only text, numbers, booleans and null`);
      }
      if (kinds.has('null') && !schema.enum.includes(null)) refuse(`${file}: an enum beside a type that allows null, which states no null among its values`);
      shape.enum = schema.enum;
    }
    if (schema.pattern !== undefined) {
      const steps = stepsOf(schema.pattern);
      if (steps === undefined) refuse(`${file}: the pattern ${schema.pattern} is not one the table can spell out`);
      shape.pattern = steps;
    }
    for (const bound of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
      if (schema[bound] === undefined) continue;
      if (!Number.isInteger(schema[bound]) || schema[bound] < 0) refuse(`${file}: \`${bound}\` is ${JSON.stringify(schema[bound])}, which is no count`);
      shape[bound] = schema[bound];
    }
    for (const bound of ['minimum', 'maximum']) {
      if (schema[bound] === undefined) continue;
      if (typeof schema[bound] !== 'number') refuse(`${file}: \`${bound}\` is ${JSON.stringify(schema[bound])}, which is no number`);
      shape[bound] = schema[bound];
    }
    if (schema.required !== undefined && schema.required.length > 0) shape.required = schema.required;
    // In the order every reader walks them, so each names the same member first.
    const names = Object.keys(schema.properties ?? {}).sort(byCodePoint);
    const members = names.map((name) => [name, shapeOf(schema.properties[name], file)]);
    if (members.length > 0) shape.members = Object.fromEntries(members);
    if (schema.maxProperties !== undefined) {
      if (schema.maxProperties !== 0 || names.length > 0) refuse(`${file}: \`maxProperties\` is ${schema.maxProperties} beside ${names.length} properties, and the table states only an object that carries none`);
      shape.closed = [];
    }
    if (schema.additionalProperties === false) shape.closed = names;
    if (schema.items !== undefined) shape.items = shapeOf(schema.items, file);
    if (typeof schema.additionalProperties === 'object') shape.values = shapeOf(schema.additionalProperties, file);
    const variants = schema.oneOf ?? schema.anyOf;
    if (variants !== undefined) {
      shape.oneOf = variants.map((variant) => shapeOf(variant, file));
      if (schema.discriminator !== undefined) {
        const { propertyName, mapping } = schema.discriminator;
        if (mapping === undefined) refuse(`${file}: a discriminator states no mapping`);
        const named = variants.map((variant) => (variant.$ref === undefined ? undefined : referred(file, variant.$ref)));
        const indexed = Object.entries(mapping).map(([value, ref]) => {
          const at = named.indexOf(referred(file, ref));
          if (at === -1) refuse(`${file}: the discriminator maps ${JSON.stringify(value)} to ${ref}, which is none of its variants`);
          return [value, at];
        });
        shape.discriminator = { property: propertyName, mapping: Object.fromEntries(indexed) };
      }
    }
    if (schema.allOf !== undefined) {
      shape.allOf = schema.allOf.map((part) => shapeOf(part, file));
      // A part closed to what the other parts name would refuse what they require: closed is stated where the parts meet, or nowhere.
      if (schema.allOf.length > 1 && schema.allOf.some((part) => closedSchema(part, file))) refuse(`${file}: a part of an allOf is closed, which would refuse the other parts' members`);
    }
    return shape;
  }

  /** Whether `schema`, written in `file`, is closed to members it does not name. */
  function closedSchema(schema, file) {
    if (schema.$ref !== undefined) {
      const name = referred(file, schema.$ref);
      return closedSchema(schemaOf.get(name), fileOf.get(name));
    }
    return schema.additionalProperties === false || schema.maxProperties === 0 || (schema.allOf ?? []).some((part) => closedSchema(part, file));
  }

  const unpruned = new Map([...schemaOf].map(([name, schema]) => [name, shapeOf(schema, fileOf.get(name))]));

  // Which components can be wrong: what a component refers to is read as
  // wrong in no way until it is found to be, and found again until nothing
  // more is.
  const canFaultComponent = new Map([...unpruned.keys()].map((name) => [name, false]));
  function canFault(shape) {
    if (shape.ref !== undefined) return canFaultComponent.get(shape.ref);
    return (
      shape.kinds !== undefined ||
      shape.enum !== undefined ||
      shape.pattern !== undefined ||
      ['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems'].some((bound) => shape[bound] !== undefined) ||
      shape.closed !== undefined ||
      shape.required !== undefined ||
      Object.values(shape.members ?? {}).some(canFault) ||
      (shape.items !== undefined && canFault(shape.items)) ||
      (shape.values !== undefined && canFault(shape.values)) ||
      (shape.oneOf ?? []).some(canFault) ||
      (shape.allOf ?? []).some(canFault)
    );
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, shape] of unpruned) {
      if (!canFaultComponent.get(name) && canFault(shape)) {
        canFaultComponent.set(name, true);
        changed = true;
      }
    }
  }

  /** `shape` with what can be wrong in no way left out. */
  function pruned(shape) {
    if (shape.ref !== undefined) return canFault(shape) ? shape : {};
    const kept = {};
    for (const part of ['kinds', 'enum', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'required']) {
      if (shape[part] !== undefined) kept[part] = shape[part];
    }
    const members = Object.entries(shape.members ?? {}).filter(([, member]) => canFault(member));
    if (members.length > 0) kept.members = Object.fromEntries(members.map(([name, member]) => [name, pruned(member)]));
    if (shape.closed !== undefined) kept.closed = shape.closed;
    if (shape.items !== undefined && canFault(shape.items)) kept.items = pruned(shape.items);
    if (shape.values !== undefined && canFault(shape.values)) kept.values = pruned(shape.values);
    if ((shape.oneOf ?? []).some(canFault)) {
      kept.oneOf = shape.oneOf.map(pruned);
      if (shape.discriminator !== undefined) kept.discriminator = shape.discriminator;
    }
    const parts = (shape.allOf ?? []).filter(canFault);
    if (parts.length > 0) kept.allOf = parts.map(pruned);
    return kept;
  }

  const names = [...unpruned.keys()].sort();
  return { names, shapes: new Map(names.map((name) => [name, pruned(unpruned.get(name))])), inline: (schema, file) => pruned(shapeOf(schema, file)) };
}
