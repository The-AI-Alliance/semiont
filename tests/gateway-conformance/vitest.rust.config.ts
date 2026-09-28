/**
 * TEMPORARY (RUST-GATEWAY D10): the suite against the Rust gateway, for the
 * cases the port has claimed so far. The claims grow each phase to the whole
 * suite; at the cutover GATEWAY_COMMAND names the Rust binary and this file
 * is deleted.
 */
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';
import base from './vitest.config';
import { REPO_ROOT } from './harness/paths';

/** Each claimed file, with the cases claimed in it, by a part of their names. */
const CLAIMED: Record<string, readonly string[]> = {
  'harness/otlp.test.ts': ['reads a protobuf export as it reads the same export sent as JSON'],
  'cases/boot.test.ts': [
    'refuses to serve with no JWT_SECRET,',
    'refuses to serve with a JWT_SECRET key shorter than 32 characters,',
    'refuses to serve with no service-account client id,',
    'refuses to serve with no service-account secret,',
    'refuses to serve with no knowledge-base domain,',
    'refuses to serve with no Archivist address,',
    'refuses to serve with no issuer,',
    'refuses to serve with no subject claim,',
    'refuses to serve with a field the document does not declare,',
    'refuses to serve with a log format the document does not declare,',
    'refuses to serve with no configuration document in HOME,',
    'refuses to serve with a NATS plane with no servers,',
    'signs with the first key of JWT_SECRET',
    'serves nothing until the broker has confirmed',
  ],
  'cases/tokens.test.ts': [
    'credentials (',
    'a knowledge base that names people by another claim',
    'an issuer that cannot be reached',
    'issuer key rotation',
  ],
  'cases/content.test.ts': ['content ('],
  'cases/spec-derived.test.ts': [
    'a protected operation refuses a request with no credential',
    'a protected operation refuses a credential it cannot verify',
    'a method the spec does not declare on a path it does',
    'a path the spec does not declare is a 404',
    'a public operation answers without a credential',
  ],
  'cases/edge.test.ts': [
    'allows any origin, and never credentials',
    'the resource metadata names this knowledge base',
    'the challenge on a 401 points at the resource metadata',
    'the status names the gateway and who is asking',
    'the gateway hosts no documentation UI',
    'the OpenAPI document names this build',
  ],
  'cases/environment.test.ts': ['simple writes <timestamp> [<LEVEL>] <message>'],
};

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: Object.keys(CLAIMED),
    testNamePattern: new RegExp(Object.values(CLAIMED).flat().map(escape).join('|')),
    provide: { gatewayCommand: [join(REPO_ROOT, 'apps/gateway-rs/target/release/semiont-gateway')] },
  },
});
