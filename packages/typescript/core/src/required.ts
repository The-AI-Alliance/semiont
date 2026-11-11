/**
 * The first fault of a value as one of the spec's component schemas: a member
 * it lacks, or one that is not what its schema allows.
 *
 * Every SDK holds a reply to what its schema requires before it reads it, and
 * names the first fault it finds the same way, by the same table: what each
 * schema requires is generated from the spec (`generated/required-schemas.ts`,
 * by the rules of packages/codegen/schemas/required-shapes.mjs, which every SDK's table is
 * written by). This SDK does not decode a reply: it refuses one with a fault,
 * as every other SDK refuses it, and reads the rest as its schema's type,
 * without each member the table reads as absent (`recognized`).
 */

import { byCodePoint } from './by-code-point';
import { REQUIRED_SCHEMAS } from './generated/required-schemas';
import type { components } from './types';

/** A component schema of the spec, by its name. */
type SchemaName = keyof components['schemas'];

/** The kind of a JSON value, as a schema names it. An integer is a number with no fractional part. */
type Kind = 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'null';

/** One step of a pattern: at least `min` of a text's next code points, and at most `max` (none: any number), each in one of the ranges `of`. */
interface Step {
  readonly of: readonly (readonly [number, number])[];
  readonly min: number;
  readonly max?: number;
}

/** What a value must be: packages/codegen/schemas/required-shapes.mjs states what each part means. */
export interface Shape {
  readonly ref?: SchemaName;
  readonly kinds?: readonly Kind[];
  /** Of an object's member, the texts it is read as: one that holds a text none of them is no fault, and is left out of what is read. */
  readonly recognized?: readonly string[];
  readonly enum?: readonly (string | number | boolean)[];
  readonly pattern?: readonly Step[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly required?: readonly string[];
  readonly members?: { readonly [name: string]: Shape };
  /** The only members an object may carry; none, where it may carry any. */
  readonly closed?: readonly string[];
  readonly items?: Shape;
  readonly values?: Shape;
  readonly oneOf?: readonly Shape[];
  readonly discriminator?: { readonly property: string; readonly mapping: { readonly [value: string]: number } };
  readonly allOf?: readonly Shape[];
}

/**
 * The first thing wrong with a value: the way to the member it is at (the
 * names of the members it is within, and its own, joined by dots; the empty
 * way is the value itself), and why. `lacks`: the value does not carry the
 * member, or the member holds null where it may not. `malformed`: the member
 * is not what its schema allows (of another kind, another value, form or
 * size), or is one a closed object does not name.
 */
export interface Fault {
  readonly member: string;
  readonly reason: 'lacks' | 'malformed';
}

/**
 * The members a reader leaves out of what it reads, by the object that holds
 * them: each holding a text none of its shape's `recognized` texts.
 */
type LeftOut = Map<object, Set<string>>;

function leaveOut(leftOut: LeftOut, object: object, name: string): void {
  const names = leftOut.get(object);
  if (names === undefined) leftOut.set(object, new Set([name]));
  else names.add(name);
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

/** Whether `kinds` allow `value`: none allow any, and an integer is a number with no fractional part. */
function allows(kinds: readonly Kind[] | undefined, value: unknown): boolean {
  if (kinds === undefined) return true;
  const kind = kindOf(value);
  if (kind === undefined) return false;
  return kinds.includes(kind) || (kinds.includes('integer') && Number.isInteger(value));
}

/** `shape`, or the component it refers to. */
function resolved(shape: Shape): Shape {
  return shape.ref === undefined ? shape : resolved(REQUIRED_SCHEMAS[shape.ref]);
}

/** The way to `name` within the member at `way`: their names joined by a dot; `name` alone within the value itself. */
export const within = (way: string, name: string): string => (way === '' ? name : `${way}.${name}`);

/** Whether `count` is at least `least` and at most `most`, where each is stated. */
const counted = (least: number | undefined, count: number, most: number | undefined): boolean =>
  (least === undefined || count >= least) && (most === undefined || count <= most);

/**
 * Whether the code points from `at` are of `steps`: the first step takes as
 * many of them as it may, and gives them back one by one until the steps
 * after it take the rest.
 */
function matches(steps: readonly Step[], points: readonly number[], at: number): boolean {
  const [first, ...rest] = steps;
  if (first === undefined) return at === points.length;
  let taken = 0;
  while (
    at + taken < points.length &&
    (first.max === undefined || taken < first.max) &&
    first.of.some(([from, to]) => from <= points[at + taken]! && points[at + taken]! <= to)
  ) {
    taken += 1;
  }
  for (; taken >= first.min; taken -= 1) if (matches(rest, points, at + taken)) return true;
  return false;
}

/**
 * Whether `value` is one of `shape`'s values, a text is of its pattern and
 * has as many code points as it allows, a number is within its bounds, and an
 * array has as many items as it allows.
 */
function isAsStated(shape: Shape, value: unknown): boolean {
  if (shape.enum !== undefined && !shape.enum.some((one) => one === value)) return false;
  if (typeof value === 'string') {
    const points = Array.from(value, (point) => point.codePointAt(0)!);
    return counted(shape.minLength, points.length, shape.maxLength) && (shape.pattern === undefined || matches(shape.pattern, points, 0));
  }
  if (typeof value === 'number') return counted(shape.minimum, value, shape.maximum);
  if (Array.isArray(value)) return counted(shape.minItems, value.length, shape.maxItems);
  return true;
}

/** The first fault `value` has as a value of `shape`, from `way`; each member to leave out of what is read is added to `leftOut`. */
function faultAt(shape: Shape, value: unknown, way: string, leftOut: LeftOut): Fault | undefined {
  const own = resolved(shape);
  if (!allows(own.kinds, value) || !isAsStated(own, value)) return { member: way, reason: 'malformed' };
  if (isObject(value)) {
    const fault = faultOfMembers(own, value, way, leftOut);
    if (fault !== undefined) return fault;
  }
  if (Array.isArray(value) && own.items !== undefined) {
    for (const item of value) {
      const fault = faultAt(own.items, item, way, leftOut);
      if (fault !== undefined) return fault;
    }
  }
  if (own.oneOf !== undefined) {
    const fault = faultOfOneOf(own.oneOf, own.discriminator, value, way, leftOut);
    if (fault !== undefined) return fault;
  }
  if (own.allOf !== undefined) {
    for (const part of own.allOf) {
      const fault = faultAt(part, value, way, leftOut);
      if (fault !== undefined) return fault;
    }
  }
  return undefined;
}

/** The first fault of an object in the members `shape` requires, in what its members are, in the members it may not carry, and in its values. */
function faultOfMembers(shape: Shape, object: Record<string, unknown>, way: string, leftOut: LeftOut): Fault | undefined {
  for (const name of shape.required ?? []) {
    const held = object[name];
    const member = shape.members?.[name];
    // A member that is undefined is one JSON does not carry.
    if (held === undefined || (held === null && member !== undefined && !allows(resolved(member).kinds, null))) {
      return { member: within(way, name), reason: 'lacks' };
    }
  }
  for (const [name, member] of Object.entries(shape.members ?? {})) {
    const held = object[name];
    if (held === undefined || held === null) continue;
    const { recognized } = resolved(member);
    if (recognized !== undefined && typeof held === 'string' && !recognized.includes(held)) {
      leaveOut(leftOut, object, name);
      continue;
    }
    const fault = faultAt(member, held, within(way, name), leftOut);
    if (fault !== undefined) return fault;
  }
  const { closed } = shape;
  if (closed !== undefined) {
    const unnamed = Object.keys(object).filter((name) => object[name] !== undefined && !closed.includes(name)).sort(byCodePoint)[0];
    if (unnamed !== undefined) return { member: within(way, unnamed), reason: 'malformed' };
  }
  if (shape.values !== undefined) {
    for (const key of Object.keys(object).sort(byCodePoint)) {
      const fault = faultAt(shape.values, object[key], way, leftOut);
      if (fault !== undefined) return fault;
    }
  }
  return undefined;
}

/**
 * The fault `value` has as one of a union's `variants`: the variant its
 * discriminator names, or else each variant whose kinds allow it. None when
 * one of them has none, whose members to leave out are added to `leftOut`;
 * the first one's when each has one; and a value no variant allows is
 * malformed.
 */
function faultOfOneOf(variants: readonly Shape[], discriminator: Shape['discriminator'], value: unknown, way: string, leftOut: LeftOut): Fault | undefined {
  let candidates = variants.filter((variant) => allows(resolved(variant).kinds, value));
  if (isObject(value) && discriminator !== undefined) {
    const named = value[discriminator.property];
    const at = typeof named === 'string' && Object.hasOwn(discriminator.mapping, named) ? discriminator.mapping[named] : undefined;
    const variant = at === undefined ? undefined : variants[at];
    if (variant !== undefined) candidates = [variant];
  }
  if (candidates.length === 0) return { member: way, reason: 'malformed' };
  let first: Fault | undefined;
  for (const candidate of candidates) {
    const tried: LeftOut = new Map();
    const fault = faultAt(candidate, value, way, tried);
    if (fault === undefined) {
      for (const [object, names] of tried) for (const name of names) leaveOut(leftOut, object, name);
      return undefined;
    }
    if (first === undefined) first = fault;
  }
  return first;
}

/** `value` as its reader reads it: each object within it without the members `leftOut` names of it. */
function without(value: unknown, leftOut: LeftOut): unknown {
  if (Array.isArray(value)) return value.map((item) => without(item, leftOut));
  if (!isObject(value)) return value;
  const names = leftOut.get(value);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([name]) => names === undefined || !names.has(name))
      .map(([name, held]) => [name, without(held, leftOut)]),
  );
}

/** A value as its reader reads it (`read`), or its first fault. */
export type Reading = { readonly read: unknown } | { readonly fault: Fault };

/** The first fault `value` has as a `schema`, by the rules every SDK reads the table by; nothing, when it has none. */
export function faultOf(schema: SchemaName, value: unknown): Fault | undefined {
  return faultAt(REQUIRED_SCHEMAS[schema], value, '', new Map());
}

/**
 * `value` as a value of `shape`, read by the rules every SDK reads the table
 * by: its first fault, as `faultOf` finds it, or what is read of it, which
 * carries no member the table reads as absent (a failure's code that is none
 * of CommandError's recognized codes).
 */
export function readOfShape(shape: Shape, value: unknown): Reading {
  const leftOut: LeftOut = new Map();
  const fault = faultAt(shape, value, '', leftOut);
  if (fault !== undefined) return { fault };
  return { read: leftOut.size === 0 ? value : without(value, leftOut) };
}

/** What every SDK says of `fault`, as it refuses what has it: `it has no \`member\``, `its \`member\` is malformed`, or `it is malformed`. */
export function said(fault: Fault): string {
  if (fault.reason === 'lacks') return `it has no \`${fault.member}\``;
  return fault.member === '' ? 'it is malformed' : `its \`${fault.member}\` is malformed`;
}
