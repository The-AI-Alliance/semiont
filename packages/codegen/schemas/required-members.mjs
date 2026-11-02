// required-members.mjs — what each component schema requires of a value, as
// far as its members go: the table Go's and TypeScript's reply checks are
// generated from.
//
//   packages/codegen/schemas/generate-required-go.mjs  → packages/go/sdk/internal/required/schemas_gen.json
//   packages/codegen/schemas/generate-required-ts.mjs  → packages/typescript/core/src/generated/required-schemas.ts
//
// Rust, Python and Kotlin decode a reply as the type their generators write
// of its schema, and that decoding refuses a reply that lacks a member the
// schema requires, wherever the member is. Go's decoding fills a missing
// member with its zero value, and TypeScript does not decode at all; so each
// holds a reply to this table as it reads it.
//
// A SHAPE is what a value must carry, and each of its parts holds where it
// applies:
//
//   - `ref`: the value is the component of that name, and carries what it
//     requires;
//   - `required`: an object carries each of these members, and holds null in
//     none but those `nullable` names;
//   - `members`: what an object's member carries, where the object has it and
//     it is not null;
//   - `items`: what each item of an array carries;
//   - `values`: what each value of a map carries;
//   - `oneOf`: the value is one of these variants (the spec's `oneOf` or
//     `anyOf`), and carries what that one requires. The variants of its kind
//     (`kinds`: object, array, string, number, boolean, null) are the ones it
//     may be, and a `discriminator` the value states names the one it is. It
//     lacks a member when every variant it may be lacks one. A value of no
//     variant's kind lacks nothing here: a value of the wrong kind is not a
//     missing member;
//   - `allOf`: the value carries what each of these requires.
//
// A shape of an object's member, an array's item, a map's value or a
// composite's part that can lack nothing is left out, and so is a union none
// of whose variants can: what is left is what a value can lack. A component
// that can lack nothing is the empty shape.
//
// A READER of the table walks an object's required members in the order the
// schema states them, then its `members` in the order the table states them
// (by name), then a map's values by their keys' order; and names the first
// member a value lacks by its WAY: the names of the members it is within, and
// its own, joined by dots. An array's positions and a map's keys are not said:
// they are the value's, not its schema's.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { translated } from './openapi-schema.mjs';

const KINDS = ['object', 'array', 'string', 'number', 'boolean', 'null'];

/**
 * Every component schema the spec names (specs/src/openapi.json), each with
 * the shape it requires of a value. `refuse` is called with what makes the
 * schemas unreadable as shapes, and does not return.
 */
export function readRequiredMembers(root, refuse) {
  const specs = resolve(root, 'specs/src');
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
    if (name === undefined) refuse(`${file}: ${ref} names no component of specs/src/openapi.json`);
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
    let kinds;
    if (schema.type !== undefined) {
      kinds = new Set((Array.isArray(schema.type) ? schema.type : [schema.type]).map((type) => (type === 'integer' ? 'number' : type)));
    } else if (schema.allOf !== undefined) {
      kinds = new Set(KINDS);
      for (const part of schema.allOf) {
        const allowed = kindsOf(part, file);
        kinds = new Set([...kinds].filter((kind) => allowed.has(kind)));
      }
    } else if (schema.oneOf !== undefined || schema.anyOf !== undefined) {
      kinds = new Set((schema.oneOf ?? schema.anyOf).flatMap((variant) => [...kindsOf(variant, file)]));
    } else if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) {
      kinds = new Set(['object']);
    } else if (schema.items !== undefined) {
      kinds = new Set(['array']);
    } else if (schema.enum !== undefined) {
      kinds = new Set(schema.enum.map((value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'object' ? 'object' : typeof value)));
    } else {
      kinds = new Set(KINDS);
    }
    return kinds;
  }

  /** Whether `schema` allows null: one that says so, or says nothing of a value's kind. */
  const acceptsNull = (schema, file) => kindsOf(schema, file).has('null');

  /** `schema`, written in `file`, as a shape, before what can lack nothing is left out. */
  function shapeOf(schema, file) {
    if (schema.$ref !== undefined) return { ref: referred(file, schema.$ref) };
    const own = Object.keys(schema).filter((key) => ['properties', 'required', 'additionalProperties', 'items', 'oneOf', 'anyOf'].includes(key));
    // `allOf` around one schema only describes it.
    if (schema.allOf?.length === 1 && own.length === 0) return shapeOf(schema.allOf[0], file);
    const shape = {};
    const properties = schema.properties ?? {};
    if (schema.required !== undefined && schema.required.length > 0) {
      shape.required = schema.required;
      const nullable = schema.required.filter((name) => properties[name] === undefined || acceptsNull(properties[name], file));
      if (nullable.length > 0) shape.nullable = nullable;
    }
    // In the order every reader walks them, so each names the same member first.
    const members = Object.keys(properties)
      .sort()
      .map((name) => [name, shapeOf(properties[name], file)]);
    if (members.length > 0) shape.members = Object.fromEntries(members);
    if (schema.items !== undefined) shape.items = shapeOf(schema.items, file);
    if (typeof schema.additionalProperties === 'object') shape.values = shapeOf(schema.additionalProperties, file);
    const variants = schema.oneOf ?? schema.anyOf;
    if (variants !== undefined) {
      shape.oneOf = variants.map((variant) => ({ kinds: KINDS.filter((kind) => kindsOf(variant, file).has(kind)), shape: shapeOf(variant, file) }));
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

  // Which components can lack anything: what a component refers to is read
  // as lacking nothing until it is found to, and found again until nothing
  // more is.
  const canLackComponent = new Map([...unpruned.keys()].map((name) => [name, false]));
  function canLack(shape) {
    if (shape.ref !== undefined) return canLackComponent.get(shape.ref);
    return (
      shape.required !== undefined ||
      Object.values(shape.members ?? {}).some(canLack) ||
      (shape.items !== undefined && canLack(shape.items)) ||
      (shape.values !== undefined && canLack(shape.values)) ||
      (shape.oneOf ?? []).some((variant) => canLack(variant.shape)) ||
      (shape.allOf ?? []).some(canLack)
    );
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, shape] of unpruned) {
      if (!canLackComponent.get(name) && canLack(shape)) {
        canLackComponent.set(name, true);
        changed = true;
      }
    }
  }

  /** `shape` with what can lack nothing left out. */
  function pruned(shape) {
    if (shape.ref !== undefined) return shape;
    const kept = {};
    if (shape.required !== undefined) kept.required = shape.required;
    if (shape.nullable !== undefined) kept.nullable = shape.nullable;
    const members = Object.entries(shape.members ?? {}).filter(([, member]) => canLack(member));
    if (members.length > 0) kept.members = Object.fromEntries(members.map(([name, member]) => [name, pruned(member)]));
    if (shape.items !== undefined && canLack(shape.items)) kept.items = pruned(shape.items);
    if (shape.values !== undefined && canLack(shape.values)) kept.values = pruned(shape.values);
    if ((shape.oneOf ?? []).some((variant) => canLack(variant.shape))) {
      kept.oneOf = shape.oneOf.map((variant) => ({ kinds: variant.kinds, shape: canLack(variant.shape) ? pruned(variant.shape) : {} }));
      if (shape.discriminator !== undefined) kept.discriminator = shape.discriminator;
    }
    const parts = (shape.allOf ?? []).filter(canLack);
    if (parts.length > 0) kept.allOf = parts.map(pruned);
    return kept;
  }

  const names = [...unpruned.keys()].sort();
  return { names, shapes: new Map(names.map((name) => [name, pruned(unpruned.get(name))])) };
}
