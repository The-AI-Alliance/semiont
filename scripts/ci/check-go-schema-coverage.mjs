#!/usr/bin/env node
// check-go-schema-coverage.mjs — an INDEPENDENT oracle for the generated Go
// client: every schema in the OpenAPI components must have a Go type.
//
// Why this exists, precisely: the drift gate next to it regenerates with the
// same command and diffs the result. That is a SELF-CONSISTENCY check — if
// the generation command itself drops schemas, both sides drop the same ones
// and the gate reports green forever. oapi-codegen does exactly that: it
// prunes components unreachable from an HTTP path by default, which silently
// leaves the bus payload schemas out of client_gen.go while every check
// passes. The Go compiler cannot notice either — an unused type that does
// not exist references nothing.
//
// A generator's characteristic failure is ABSENCE, and absence is only
// visible against an independent count. Hence: spec says N, Go must have N.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SPEC = resolve(ROOT, 'specs/openapi.json');
const CLIENT = resolve(ROOT, 'packages/sdk-go/client_gen.go');

const spec = JSON.parse(readFileSync(SPEC, 'utf8'));
const go = readFileSync(CLIENT, 'utf8');

const schemas = Object.keys(spec.components?.schemas ?? {});
if (schemas.length === 0) {
  console.error('::error::no component schemas found in the spec — is it bundled?');
  process.exit(1);
}

// oapi-codegen emits `type <Name> …` for each schema. Names are used verbatim
// (the spec already uses Go-friendly PascalCase); a schema whose name needs
// mangling would show up here as missing, which is the right outcome — it
// means the assumption does not hold and someone must look.
const missing = schemas.filter((name) => !new RegExp(`^type ${name}\\b`, 'm').test(go));

if (missing.length > 0) {
  console.error(`::error::packages/sdk-go/client_gen.go is missing ${missing.length} of ${schemas.length} schemas.`);
  console.error('');
  console.error('  Missing types:');
  for (const name of missing.slice(0, 25)) console.error(`    ${name}`);
  if (missing.length > 25) console.error(`    …and ${missing.length - 25} more`);
  console.error('');
  console.error('  The generator prunes schemas unreachable from an HTTP path unless');
  console.error('  `skip-prune` is in its -generate list. Regenerate:');
  console.error('');
  console.error('    cd packages/sdk-go && go generate ./...');
  console.error('');
  process.exit(1);
}

console.log(`sdk-go covers all ${schemas.length} component schemas`);
