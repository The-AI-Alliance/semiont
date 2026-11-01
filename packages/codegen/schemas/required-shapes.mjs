// required-shapes.mjs — what each component schema requires of a value: the
// kinds of value it may be, the members it must carry and what each member
// must be. The table every SDK holds a reply to before it reads it.
//
//   packages/codegen/schemas/generate-required-ts.mjs     → packages/typescript/core/src/generated/required-schemas.ts
//   packages/codegen/schemas/generate-required-go.mjs     → packages/go/sdk/internal/required/schemas_gen.json
//   packages/codegen/schemas/generate-required.mjs        → protocol/specs/src/client/required.json, which Rust's
//                                                           build and Kotlin's generator read
//   packages/codegen/schemas/generate-required-python.mjs → packages/python/sdk/src/semiont/_required_table.py
//
// Each SDK walks a payload by this table before it decodes it, so every SDK
// finds the same first FAULT in it, names it the same way, and refuses it.
// Whatever an SDK's decoding refuses beyond what the table states (a value
// no enumeration names, an id of the wrong form), it refuses as a fault at
// the payload itself.
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
//   - `required`: an object carries each of these members. One may hold null
//     only where its shape in `members` allows null, and a member with no
//     shape there allows anything;
//   - `members`: what an object's member must be, where the object has it
//     and it is not null;
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
//   2. of an object, each required member in the order the schema states
//      them: one it does not carry, or that holds null where null is not
//      allowed, it lacks;
//   3. then each member the shape describes, in the order the table states
//      them (by name), that the object has and is not null: its faults. An
//      optional member that holds null is no fault, whatever its shape: every
//      SDK's decoding reads it as absent;
//   4. then each value of a map, by its keys' order: its faults, at the map's
//      way;
//   5. of an array, each item in its order: its faults, at the array's way;
//   6. of a union, the variant its discriminator names, or else each variant
//      whose kinds allow the value's: the value has no fault when one of them
//      has none, and the first one's fault when each has one; a value no
//      variant allows is malformed;
//   7. then each part of a composite in its order: its faults.
//
// An array's positions and a map's keys are not said: they are the value's,
// not its schema's. So an item or a map's value that is null where null is
// not allowed is malformed at the array's or the map's way: it is not a
// member.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { translated } from './openapi-schema.mjs';

const KINDS = ['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'];

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
    if (schema.$ref !== undefined) return { ref: referred(file, schema.$ref) };
    const own = Object.keys(schema).filter((key) => ['type', 'enum', 'properties', 'required', 'additionalProperties', 'items', 'oneOf', 'anyOf'].includes(key));
    // `allOf` around one schema only describes it.
    if (schema.allOf?.length === 1 && own.length === 0) return shapeOf(schema.allOf[0], file);
    const shape = {};
    const kinds = kindsOf(schema, file);
    if (!anyKind(kinds)) shape.kinds = ordered(kinds);
    if (schema.required !== undefined && schema.required.length > 0) shape.required = schema.required;
    // In the order every reader walks them, so each names the same member first.
    const members = Object.keys(schema.properties ?? {})
      .sort()
      .map((name) => [name, shapeOf(schema.properties[name], file)]);
    if (members.length > 0) shape.members = Object.fromEntries(members);
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
    if (schema.allOf !== undefined) shape.allOf = schema.allOf.map((part) => shapeOf(part, file));
    return shape;
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
    if (shape.kinds !== undefined) kept.kinds = shape.kinds;
    if (shape.required !== undefined) kept.required = shape.required;
    const members = Object.entries(shape.members ?? {}).filter(([, member]) => canFault(member));
    if (members.length > 0) kept.members = Object.fromEntries(members.map(([name, member]) => [name, pruned(member)]));
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
  return { names, shapes: new Map(names.map((name) => [name, pruned(unpruned.get(name))])) };
}
