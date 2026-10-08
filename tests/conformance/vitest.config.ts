import { defineConfig } from 'vitest/config';
import { ARCHIVIST_COMMAND, DISPATCHER_COMMAND, GATEWAY_COMMAND, SDK_DRIVERS } from './harness/paths';

// Every file boots its own processes, issuer, Archivist and broker on ports of
// its own, so files run in parallel; the cases inside a file share them and
// run in order.
export default defineConfig({
  test: {
    pool: 'forks',
    maxWorkers: 4,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'gateway',
          include: ['gateway/**/*.test.ts', 'harness/**/*.test.ts'],
          provide: { gatewayCommand: GATEWAY_COMMAND },
          globalSetup: ['harness/global-setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'dispatcher',
          include: ['dispatcher/**/*.test.ts'],
          provide: { gatewayCommand: GATEWAY_COMMAND, dispatcherCommand: DISPATCHER_COMMAND },
          globalSetup: ['harness/global-setup.ts', 'harness/dispatcher-setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'archivist',
          include: ['archivist/**/*.test.ts'],
          provide: { gatewayCommand: GATEWAY_COMMAND, archivistCommand: ARCHIVIST_COMMAND },
          globalSetup: ['harness/global-setup.ts', 'harness/archivist-setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'sdk',
          include: ['sdk/**/*.test.ts'],
          provide: { gatewayCommand: GATEWAY_COMMAND, sdkDrivers: SDK_DRIVERS },
          globalSetup: ['harness/global-setup.ts', 'harness/sdk-setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'worker',
          include: ['worker/**/*.test.ts'],
          provide: { gatewayCommand: GATEWAY_COMMAND, sdkDrivers: SDK_DRIVERS },
          globalSetup: ['harness/global-setup.ts', 'harness/worker-setup.ts'],
        },
      },
    ],
  },
});
