import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isArray, isObject, isString } from '@semiont/core';
import { ControlSchemas, isControlMethod } from './control-schemas';
import type { ControlErrorData, ControlMethod } from './control-types.gen';

// protocol/specs/src/control/request-cases.json: each line a client may send semiont control,
// and the launcher's answer. Desktop refuses a request's params exactly when the launcher
// answers it -32602, and with the same control code and fields. The validator is run directly,
// not through the client: the client states its own apiVersion, so it never sends the
// unsupported version a case does.
const CASES = new URL('../../../protocol/specs/src/control/request-cases.json', import.meta.url);

/** JSON-RPC's code for refused params. */
const INVALID_PARAMS = -32602;

interface RequestCase {
  name: string;
  method: ControlMethod;
  params: Record<string, unknown>;
  answer: unknown;
}

/** A refusal as the cases state one: its control code, and the pointers its data names, sorted. */
interface Refusal {
  code: unknown;
  fields: string[] | undefined;
  supported: unknown;
}

/** Each case whose line is a request of a control method with object params. */
function requestCases(): RequestCase[] {
  const file: unknown = JSON.parse(readFileSync(CASES, 'utf8'));
  if (!isObject(file)) throw new Error('control/request-cases.json is not an object');
  const entries = file['cases'];
  if (!isArray(entries)) throw new Error('control/request-cases.json states no cases');
  return entries.flatMap((entry) => {
    if (!isObject(entry) || !('answer' in entry)) throw new Error('a case of control/request-cases.json states no answer');
    const { name, line, answer } = entry;
    if (!isString(name) || !isString(line)) throw new Error('a case of control/request-cases.json states no name and line');
    const request = parsed(line);
    if (!isObject(request)) return [];
    const { method, params } = request;
    if (!isControlMethod(method) || !isObject(params)) return [];
    return [{ name, method, params, answer }];
  });
}

/** The line as JSON, or null when it is none. */
function parsed(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return null;
  }
}

/** The refusal a case's answer states, or null when its answer is not one. */
function statedRefusal(answer: unknown): Refusal | null {
  if (!isObject(answer)) return null;
  const error = answer['error'];
  if (!isObject(error) || error['code'] !== INVALID_PARAMS) return null;
  const data = error['data'];
  if (!isObject(data)) throw new Error('a -32602 answer states no error data');
  return { code: data['code'], fields: sortedPointers(data['fields']), supported: data['supported'] };
}

function sortedPointers(fields: unknown): string[] | undefined {
  if (fields === undefined) return undefined;
  if (!isArray(fields) || !fields.every(isString)) throw new Error("a refusal's fields are not JSON pointers");
  return [...fields].sort();
}

function refusalOf(data: ControlErrorData): Refusal {
  return {
    code: data.code,
    fields: data.fields === undefined ? undefined : data.fields.map(({ field }) => field).sort(),
    supported: data.supported,
  };
}

const schemas = new ControlSchemas();
const cases = requestCases();

describe('control/request-cases.json', () => {
  it('holds requests Desktop refuses and requests it sends', () => {
    expect(cases.some(({ answer }) => statedRefusal(answer) !== null)).toBe(true);
    expect(cases.some(({ answer }) => statedRefusal(answer) === null)).toBe(true);
  });

  it.each(cases)('$name', ({ method, params, answer }) => {
    const refusal = schemas.refuseParams(method, params);
    expect(refusal === null ? null : refusalOf(refusal.data)).toEqual(statedRefusal(answer));
  });
});
