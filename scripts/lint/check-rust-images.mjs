#!/usr/bin/env node
/**
 * lint:rust-images — the Rust service images share one builder stage.
 *
 * A Rust service's image is the apps/<service>/Dockerfile whose builder stage
 * is `FROM rust:`. Each keeps its own runtime stage, which is where the image
 * states its facts (its port, health route, user, environment and command),
 * and every one carries the same builder stage, which builds every service's
 * binary. An image built after, or beside, another then reuses that stage
 * instead of compiling the workspace again.
 *
 * 1. The builder stages, from `FROM rust:` to the next FROM, are the same text.
 * 2. The stage builds (`-p`) and keeps (`cp target/release/`) exactly the
 *    binaries the images copy out of it (`COPY --from=builder /<binary>`).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const failures = [];
const fail = (message) => failures.push(message);

/** Each Rust service's Dockerfile: its builder stage, and the binaries it copies from it. */
const images = readdirSync(join(ROOT, 'apps'))
  .map((app) => `apps/${app}/Dockerfile`)
  .filter((path) => existsSync(join(ROOT, path)))
  .map((path) => ({ path, lines: readFileSync(join(ROOT, path), 'utf8').split('\n') }))
  .filter(({ lines }) => lines.some((l) => /^FROM rust:/.test(l)))
  .map(({ path, lines }) => {
    const start = lines.findIndex((l) => /^FROM rust:/.test(l));
    const end = lines.findIndex((l, i) => i > start && /^FROM /.test(l));
    if (end < 0) fail(`${path}: its builder stage is not followed by a runtime stage`);
    const copied = lines.flatMap((l) => [...l.matchAll(/^COPY --from=builder \/([a-z][a-z0-9-]*) /g)].map((m) => m[1]));
    return { path, builder: lines.slice(start, end < 0 ? lines.length : end).join('\n'), copied };
  });

if (images.length === 0) fail('no apps/<service>/Dockerfile has a `FROM rust:` builder stage');

const [first, ...rest] = images;
for (const image of rest) {
  if (image.builder !== first.builder) fail(`${image.path}'s builder stage differs from ${first.path}'s; the Rust images share one`);
}

if (first) {
  const wanted = new Set(images.flatMap((i) => i.copied));
  const built = new Set([...first.builder.matchAll(/-p ([a-z][a-z0-9-]*)/g)].map((m) => m[1]));
  const kept = new Set([...first.builder.matchAll(/target\/release\/([a-z][a-z0-9-]*)/g)].map((m) => m[1]));
  for (const binary of wanted) {
    if (!built.has(binary)) fail(`an image copies ${binary} from the builder stage, which does not build it (-p ${binary})`);
    if (!kept.has(binary)) fail(`an image copies ${binary} from the builder stage, which does not keep it (cp target/release/${binary})`);
  }
  for (const binary of new Set([...built, ...kept])) {
    if (!wanted.has(binary)) fail(`the builder stage builds ${binary}, and no image copies it`);
  }
}

if (failures.length > 0) {
  console.error(`❌ lint:rust-images — ${failures.length} problem(s):`);
  for (const f of failures) console.error(`   ${f}`);
  process.exit(1);
}
console.log(`✅ lint:rust-images — ${images.map((i) => i.path).join(' and ')} share one builder stage, which builds ${[...new Set(images.flatMap((i) => i.copied))].join(' and ')}`);
