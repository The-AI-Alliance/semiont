/**
 * The two role names the `bearerAuth` scheme declares, read out of the spec's
 * own text so the suite does not restate them: `semiont-service` and
 * `semiont-worker` appear there, and a rename there fails here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SPEC_SOURCE } from './paths';

const root = JSON.parse(readFileSync(join(SPEC_SOURCE, 'openapi.json'), 'utf8')) as {
  components: { securitySchemes: { bearerAuth: { description: string } } };
};
const description = root.components.securitySchemes.bearerAuth.description;

function declared(role: string): string {
  if (!description.includes(`\`${role}\``)) throw new Error(`the bearerAuth scheme no longer declares the role ${role}`);
  return role;
}

export const SERVICE_ROLE = declared('semiont-service');
export const WORKER_ROLE = declared('semiont-worker');
