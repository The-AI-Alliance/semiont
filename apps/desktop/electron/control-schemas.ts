import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020';
import { isObject, isString } from '@semiont/core';
import {
  CONTROL_API_VERSION,
  CONTROL_ERROR_DATA_SCHEMA,
  CONTROL_METHOD_SCHEMAS,
  CONTROL_NOTIFICATION_SCHEMAS,
  CONTROL_SCHEMAS,
  type ControlErrorCode,
  type ControlErrorData,
  type ControlFieldFault,
  type ControlLauncherNotifications,
  type ControlMethod,
} from './control-types.gen';
import type { ControlNoticeOf } from '../src/lib/launcher-bridge';

// Every control message, held to protocol/specs/src/control's schemas as the launcher holds
// them (packages/go/launcher/control_validate.go): a request's params before it is sent, and
// each result, error and notification the launcher sends.

/** What holding a value to a schema found. */
export type Checked<T> = { holds: true; value: T } | { holds: false; faults: ControlFieldFault[] };

/** Params the launcher refuses: the message and the error data it refuses them with. */
export interface ParamsRefusal {
  message: string;
  data: ControlErrorData;
}

const INVALID_PARAMS: ControlErrorCode = 'control.invalid-params';
const UNSUPPORTED_API_VERSION: ControlErrorCode = 'control.unsupported-api-version';

/** The keywords at which the launcher's validator (santhosh-tekuri/jsonschema) stops a schema
 *  when one fails, in the order it tries them: nothing else of that schema is tried at that
 *  value. Ajv goes on, so the faults Ajv adds past one are not the launcher's. */
const STOPPING_KEYWORDS = ['type', 'const', 'enum'];

export function isControlMethod(name: unknown): name is ControlMethod {
  return isString(name) && Object.hasOwn(CONTROL_METHOD_SCHEMAS, name);
}

export function isLauncherNotification(name: string): name is keyof ControlLauncherNotifications {
  return Object.hasOwn(CONTROL_NOTIFICATION_SCHEMAS, name);
}

/** A schema's URL, as the launcher's controlSchemaURL makes it: the schemas state no $id, and
 *  their relative $refs resolve against this. */
function schemaURL(path: string): string {
  return `file:///${path}`;
}

/** Each schema a control message is held to. */
function messageSchemaPaths(): string[] {
  return [
    CONTROL_ERROR_DATA_SCHEMA,
    ...Object.values(CONTROL_METHOD_SCHEMAS).flatMap(({ params, result }) => [params, result]),
    ...Object.values(CONTROL_NOTIFICATION_SCHEMAS),
  ];
}

export class ControlSchemas {
  private readonly ajv: Ajv2020;

  /** Compiles every schema a control message is held to; one that does not compile throws. */
  constructor() {
    this.ajv = new Ajv2020({
      strict: true,
      allErrors: true,
      // RequestId.json's type is ["string", "integer"], a union strict mode refuses unless allowed.
      allowUnionTypes: true,
      // Target.json's oneOf branches require members only Target's own properties name, and Ajv
      // compiles those branches before those properties.
      strictRequired: false,
    });
    for (const [path, schema] of Object.entries(CONTROL_SCHEMAS)) {
      if (!isObject(schema)) throw new Error(`${path} is not a schema object`);
      this.ajv.addSchema(schema, schemaURL(path));
    }
    for (const path of messageSchemaPaths()) this.validator(path);
  }

  /** How the launcher refuses `params` of `method`, or null when it takes them: checkParams's
   *  checks, in its order. */
  refuseParams(method: ControlMethod, params: unknown): ParamsRefusal | null {
    if (!isObject(params)) return invalidParams(method, [{ field: '', message: 'is not an object' }]);
    const stated = params['apiVersion'];
    if (isString(stated) && stated !== CONTROL_API_VERSION) {
      return {
        message: `this client speaks ${CONTROL_API_VERSION}, not ${stated}`,
        data: { code: UNSUPPORTED_API_VERSION, retryable: false, supported: [CONTROL_API_VERSION] },
      };
    }
    const checked = this.check(CONTROL_METHOD_SCHEMAS[method].params, params);
    return checked.holds ? null : invalidParams(method, checked.faults);
  }

  /** `params` held to the schema of the launcher notification `method`. */
  notice<N extends keyof ControlLauncherNotifications>(method: N, params: unknown): Checked<ControlNoticeOf<N>> {
    const checked = this.check<ControlLauncherNotifications[N]>(CONTROL_NOTIFICATION_SCHEMAS[method], params);
    if (!checked.holds) return checked;
    return { holds: true, value: { method, params: checked.value } };
  }

  /** `value` held to the schema at `path`, one of protocol/specs/src/control's; `T` is the
   *  type control-types.gen.ts generates from that schema. */
  check<T>(path: string, value: unknown): Checked<T> {
    const validate = this.validator<T>(path);
    if (validate(value)) return { holds: true, value };
    const errors = validate.errors;
    if (errors === null || errors === undefined) throw new Error(`Ajv refused a value against ${path} and named no fault`);
    return { holds: false, faults: schemaFaults(errors) };
  }

  private validator<T>(path: string): ValidateFunction<T> {
    const validate = this.ajv.getSchema<T>(schemaURL(path));
    if (validate === undefined) throw new Error(`no control schema is registered at ${path}`);
    if ('$async' in validate) throw new Error(`the control schema at ${path} is asynchronous`);
    return validate;
  }
}

function invalidParams(method: ControlMethod, faults: ControlFieldFault[]): ParamsRefusal {
  return {
    message: `${method}'s params: ${describeFaults(faults)}`,
    data: { code: INVALID_PARAMS, retryable: false, fields: faults },
  };
}

/** Faults as one line, as the launcher says them in a message. */
export function describeFaults(faults: readonly ControlFieldFault[]): string {
  return faults.map(({ field, message }) => `${field === '' ? '(the whole)' : field} ${message}`).join('; ');
}

/** control_validate.go's schemaFaults over Ajv's flat list: each fault the launcher's validator
 *  reports, where it is. A failed oneOf is one fault at its value, not its branches' faults. */
function schemaFaults(errors: readonly ErrorObject[]): ControlFieldFault[] {
  const scopes = errors.flatMap((by) => {
    const prefix = hidingPrefix(by, errors);
    return prefix === null ? [] : [{ by, prefix }];
  });
  const faults = errors
    .filter((error) => !scopes.some(({ by, prefix }) =>
      by !== error && error.schemaPath.startsWith(prefix) && within(error.instancePath, by.instancePath)))
    .flatMap(fieldFaults);
  if (faults.length > 0) return faults;
  return [{ field: '', message: errors.map(ajvMessage).join('; ') }];
}

/** The schema path under which `error` hides every other error at or below its value: a
 *  failed oneOf hides its branches', and a schema's first failing stopping keyword hides the
 *  rest of that schema's. Null when it hides none. */
function hidingPrefix(error: ErrorObject, errors: readonly ErrorObject[]): string | null {
  if (error.keyword === 'oneOf') return `${error.schemaPath}/`;
  const rank = STOPPING_KEYWORDS.indexOf(error.keyword);
  if (rank < 0) return null;
  const schema = error.schemaPath.slice(0, -`/${error.keyword}`.length);
  const stoppedBefore = errors.some((other) =>
    other.instancePath === error.instancePath
    && STOPPING_KEYWORDS.slice(0, rank).some((keyword) => other.schemaPath === `${schema}/${keyword}`));
  return stoppedBefore ? null : `${schema}/`;
}

function within(pointer: string, at: string): boolean {
  return pointer === at || pointer.startsWith(`${at}/`);
}

function fieldFaults(error: ErrorObject): ControlFieldFault[] {
  switch (error.keyword) {
    case 'additionalProperties':
      return [{ field: `${error.instancePath}/${pointerToken(param(error, 'additionalProperty'))}`, message: ajvMessage(error) }];
    case 'required':
      return [{ field: `${error.instancePath}/${pointerToken(param(error, 'missingProperty'))}`, message: ajvMessage(error) }];
    case 'oneOf':
    case 'type':
    case 'const':
    case 'enum':
    case 'pattern':
    case 'minimum':
    case 'minLength':
    case 'not':
      return [{ field: error.instancePath, message: ajvMessage(error) }];
    default:
      throw new Error(`Ajv refused by ${error.keyword}, a keyword no control schema uses (control_census_test.go)`);
  }
}

function param(error: ErrorObject, name: string): string {
  const value: unknown = error.params[name];
  if (!isString(value)) throw new Error(`Ajv's ${error.keyword} fault at ${error.schemaPath} names no ${name}`);
  return value;
}

function ajvMessage(error: ErrorObject): string {
  if (error.message === undefined) throw new Error(`Ajv gave its ${error.keyword} fault at ${error.schemaPath} no message`);
  return error.message;
}

/** A member name as a JSON pointer token (RFC 6901). */
function pointerToken(name: string): string {
  return name.replaceAll('~', '~0').replaceAll('/', '~1');
}
