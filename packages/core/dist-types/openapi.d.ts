/**
 * Spec validation — `@semiont/core/openapi`.
 *
 * The validators are GENERATED from `specs/openapi.json`
 * (`scripts/spec/generate-validators.mjs`), the same bundle `types.ts` and
 * `sdk-go/client_gen.go` come from. One authority, four artifacts.
 *
 * Compiled at BUILD time, deliberately. Ajv's `addSchema` does not compile;
 * runtime setups defer it to the first validation, so a schema Ajv cannot
 * compile becomes a 500 on every request through it — how a `discriminator`
 * on AnnotationBody broke `POST /bus/emit` (PR #1189). Here that is a build
 * failure naming the schema.
 *
 * A subpath, never the `.` barrel: the generated validators are ~1.9 MB bundled,
 * and every browser consumer imports the barrel.
 */
import type { ErrorObject } from 'ajv';
import * as generated from './generated/openapi-validators.cjs';
export declare const validators: typeof generated;
/**
 * Ajv's error list as one human-readable line, for a 4xx body.
 *
 * Presentation only — it restates no part of the spec, so it is hand-written
 * rather than generated.
 */
export declare function formatErrors(errors: ErrorObject[] | null | undefined): string;
