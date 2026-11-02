/**
 * What a value lacks to be one of the spec's component schemas, as far as its
 * members go.
 *
 * Rust, Python and Kotlin decode a reply as the type their generators write of
 * its schema, and that decoding refuses a reply that lacks a member the schema
 * requires, wherever the member is. This SDK does not decode: it holds every
 * reply it reads to what its schema requires instead, and refuses one that
 * lacks a member, as they do. What each schema requires is generated from the
 * spec (`generated/required-schemas.ts`, by the rules of
 * packages/codegen/schemas/required-members.mjs, which Go's table is read by too). It is
 * not a validator of the schemas: a member of the wrong kind is no member
 * missing.
 */

import { REQUIRED_SCHEMAS } from './generated/required-schemas';
import type { components } from './types';

/** A component schema of the spec, by its name. */
type SchemaName = keyof components['schemas'];

/** The kind of a JSON value, as a schema names it. */
type Kind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

/** One of the shapes a union may be, and the kinds of value it is. */
interface Variant {
  readonly kinds: readonly Kind[];
  readonly shape: Shape;
}

/** What a value must carry, as far as its members go: packages/codegen/schemas/required-members.mjs states what each part means. */
export interface Shape {
  readonly ref?: SchemaName;
  readonly required?: readonly string[];
  readonly nullable?: readonly string[];
  readonly members?: { readonly [name: string]: Shape };
  readonly items?: Shape;
  readonly values?: Shape;
  readonly oneOf?: readonly Variant[];
  readonly discriminator?: { readonly property: string; readonly mapping: { readonly [value: string]: number } };
  readonly allOf?: readonly Shape[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The kind of a value JSON carries; none for what JSON never carries. */
function kindOf(value: unknown): Kind | undefined {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'object':
      return 'object';
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return undefined;
  }
}

const within = (way: string, name: string): string => (way === '' ? name : `${way}.${name}`);

/** The way to the first member `value` lacks to be of `shape`, from `way`. */
function lacking(shape: Shape, value: unknown, way: string): string | undefined {
  if (shape.ref !== undefined) return lacking(REQUIRED_SCHEMAS[shape.ref], value, way);
  if (isObject(value)) {
    const lacks = lackingMembers(shape, value, way);
    if (lacks !== undefined) return lacks;
  }
  if (Array.isArray(value) && shape.items !== undefined) {
    for (const item of value) {
      const lacks = lacking(shape.items, item, way);
      if (lacks !== undefined) return lacks;
    }
  }
  if (shape.oneOf !== undefined) {
    const lacks = lackingOneOf(shape.oneOf, shape.discriminator, value, way);
    if (lacks !== undefined) return lacks;
  }
  if (shape.allOf !== undefined) {
    for (const part of shape.allOf) {
      const lacks = lacking(part, value, way);
      if (lacks !== undefined) return lacks;
    }
  }
  return undefined;
}

/** What an object lacks of the members `shape` requires, and of what its members and its values require. */
function lackingMembers(shape: Shape, object: Record<string, unknown>, way: string): string | undefined {
  if (shape.required !== undefined) {
    for (const name of shape.required) {
      const held = object[name];
      // A member that is undefined is one JSON does not carry.
      if (held === undefined || (held === null && !(shape.nullable !== undefined && shape.nullable.includes(name)))) {
        return within(way, name);
      }
    }
  }
  if (shape.members !== undefined) {
    for (const [name, member] of Object.entries(shape.members)) {
      const held = object[name];
      if (held === undefined || held === null) continue;
      const lacks = lacking(member, held, within(way, name));
      if (lacks !== undefined) return lacks;
    }
  }
  if (shape.values !== undefined) {
    for (const key of Object.keys(object).sort()) {
      const lacks = lacking(shape.values, object[key], way);
      if (lacks !== undefined) return lacks;
    }
  }
  return undefined;
}

/**
 * What `value` lacks to be one of a union's `variants`: what the variant its
 * discriminator names lacks, or, naming none, what the first of the variants
 * of its kind lacks when each of them lacks something. A value of no
 * variant's kind lacks nothing here.
 */
function lackingOneOf(variants: readonly Variant[], discriminator: Shape['discriminator'], value: unknown, way: string): string | undefined {
  const kind = kindOf(value);
  let candidates = variants.filter((variant) => kind !== undefined && variant.kinds.includes(kind));
  if (isObject(value) && discriminator !== undefined) {
    const named = value[discriminator.property];
    const at = typeof named === 'string' && Object.hasOwn(discriminator.mapping, named) ? discriminator.mapping[named] : undefined;
    const variant = at === undefined ? undefined : variants[at];
    if (variant !== undefined) candidates = [variant];
  }
  let first: string | undefined;
  for (const candidate of candidates) {
    const lacks = lacking(candidate.shape, value, way);
    if (lacks === undefined) return undefined;
    if (first === undefined) first = lacks;
  }
  return first;
}

/**
 * The way to the first member `value` lacks to be a `schema`: the names of the
 * members it is within, and its own, joined by dots, as every SDK names it. A
 * member lacks when it is missing, or holds null where it may not. An array's
 * positions and a map's keys are not said. Nothing, when it lacks none.
 */
export function memberLacking(schema: SchemaName, value: unknown): string | undefined {
  return lacking(REQUIRED_SCHEMAS[schema], value, '');
}

/** The way to the first member `value` lacks to be of `shape`, named as `memberLacking` names it. */
export function lackingOf(shape: Shape, value: unknown): string | undefined {
  return lacking(shape, value, '');
}
