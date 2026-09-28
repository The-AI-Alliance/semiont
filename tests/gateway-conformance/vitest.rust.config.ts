/**
 * TEMPORARY (RUST-GATEWAY D10): the suite against the Rust gateway. The port
 * claimed its cases phase by phase; since P3 it claims the whole suite, so
 * this differs from vitest.config.ts only in the command it provides. At the
 * cutover GATEWAY_COMMAND names the Rust binary and this file is deleted.
 */
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';
import base from './vitest.config';
import { REPO_ROOT } from './harness/paths';

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    provide: { gatewayCommand: [join(REPO_ROOT, 'apps/gateway-rs/target/release/semiont-gateway')] },
  },
});
