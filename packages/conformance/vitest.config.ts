import { defineConfig } from 'vitest/config';
import { readImplementations } from './harness/implementations';

// What the suites test: the implementations file the run names after vitest's
// own arguments, `-- --implementations <file>` (harness/implementations.ts).
const implementations = readImplementations(process.argv);

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
          provide: { gatewayCommand: implementations.gateway },
          globalSetup: ['harness/global-setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'dispatcher',
          include: ['dispatcher/**/*.test.ts'],
          provide: { gatewayCommand: implementations.gateway, dispatcherCommand: implementations.dispatcher },
          globalSetup: ['harness/global-setup.ts', 'harness/dispatcher-setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'archivist',
          include: ['archivist/**/*.test.ts'],
          provide: { gatewayCommand: implementations.gateway, archivistCommand: implementations.archivist },
          globalSetup: ['harness/global-setup.ts', 'harness/archivist-setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'sdk',
          include: ['sdk/**/*.test.ts'],
          provide: { gatewayCommand: implementations.gateway, sdkDrivers: implementations.sdks },
          globalSetup: ['harness/global-setup.ts', 'harness/sdk-setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'worker',
          include: ['worker/**/*.test.ts'],
          provide: { gatewayCommand: implementations.gateway, sdkDrivers: implementations.sdks },
          globalSetup: ['harness/global-setup.ts', 'harness/worker-setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'worker-service',
          include: ['worker-service/**/*.test.ts'],
          provide: { gatewayCommand: implementations.gateway, workerServices: implementations.workerServices },
          globalSetup: ['harness/global-setup.ts', 'harness/worker-service-setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'weaver',
          include: ['weaver/**/*.test.ts'],
          provide: { gatewayCommand: implementations.gateway, archivistCommand: implementations.archivist, weaverServices: implementations.weaverServices },
          globalSetup: ['harness/global-setup.ts', 'harness/archivist-setup.ts', 'harness/weaver-setup.ts'],
          // One file at a time: the files share one graph database, which a
          // rebuild of the whole graph clears, and a Weaver's health port is a
          // constant, so two cannot run at once.
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: 'smelter',
          include: ['smelter/**/*.test.ts'],
          provide: { gatewayCommand: implementations.gateway, archivistCommand: implementations.archivist, smelterServices: implementations.smelterServices },
          globalSetup: ['harness/global-setup.ts', 'harness/archivist-setup.ts', 'harness/smelter-setup.ts'],
          // One file at a time: the files share one vector database, whose
          // index each file clears, and a Smelter's health port is a constant,
          // so two cannot run at once.
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: 'librarian',
          include: ['librarian/**/*.test.ts'],
          provide: {
            gatewayCommand: implementations.gateway,
            archivistCommand: implementations.archivist,
            weaverServices: implementations.weaverServices,
            smelterServices: implementations.smelterServices,
            librarianServices: implementations.librarianServices,
          },
          globalSetup: ['harness/global-setup.ts', 'harness/archivist-setup.ts', 'harness/librarian-setup.ts'],
          // One file at a time: the files share one graph database and one
          // vector database, each cleared when a file's world is made, and
          // the health ports of a Weaver and a Smelter are constants, so two
          // worlds cannot run at once.
          fileParallelism: false,
        },
      },
    ],
  },
});
