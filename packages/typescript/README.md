# TypeScript

The client side: the SDK and what it stands on. The Browser ([images/browser](../../images/browser/README.md)) is built on these.

| Package | Published | Coverage | What it is |
|---|---|---|---|
| [@semiont/sdk](./sdk/README.md) | [![npm](https://img.shields.io/npm/v/@semiont/sdk)](https://www.npmjs.com/package/@semiont/sdk) | [![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=typescript-sdk)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=typescript-sdk) | The TypeScript SDK: `SemiontClient` and its verb namespaces, `SemiontSession` and `SemiontBrowser`, state units, and the cache behind live queries |
| [@semiont/react-ui](./react-ui/README.md) | [![npm](https://img.shields.io/npm/v/@semiont/react-ui)](https://www.npmjs.com/package/@semiont/react-ui) | [![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=typescript-react-ui)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=typescript-react-ui) | React components and hooks over the SDK: the resource viewer, the annotation components, and the `useStateUnit` and `useObservable` adapters |
| [@semiont/http-transport](./http-transport/README.md) | [![npm](https://img.shields.io/npm/v/@semiont/http-transport)](https://www.npmjs.com/package/@semiont/http-transport) | [![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=typescript-http-transport)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=typescript-http-transport) | How the SDK reaches a knowledge base over HTTP: `HttpTransport` and `HttpContentTransport`. The SDK depends on it |
| [@semiont/core](./core/README.md) | [![npm](https://img.shields.io/npm/v/@semiont/core)](https://www.npmjs.com/package/@semiont/core) | [![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=typescript-core)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=typescript-core) | What every TypeScript package stands on: the protocol's types, generated from the spec, the ids, the event bus, and the contracts a transport implements |
| [@semiont/observability](./observability/README.md) | [![npm](https://img.shields.io/npm/v/@semiont/observability)](https://www.npmjs.com/package/@semiont/observability) | [![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=typescript-observability)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=typescript-observability) | Tracing and metrics for the TypeScript transport, on OpenTelemetry. It does nothing until a process is given somewhere to export to |

## Where things are

- The packages are npm workspaces of the repository's root, which installs and builds them all (`npm ci`, `npm run build:packages`).
- [`tsconfig.base.json`](./tsconfig.base.json) is what each package's `tsconfig.json` extends, and [`vitest.shared.config.ts`](./vitest.shared.config.ts) what each package's suite, and the Browser's, merges.
- Each package measures its coverage with `npm run test:coverage`, which CI uploads under the flag `typescript-<name>`.

The other languages, and which SDK a program installs, are in [packages/](../README.md).
