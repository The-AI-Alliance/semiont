# @semiont/browser

[![npm version](https://img.shields.io/npm/v/@semiont/browser.svg)](https://www.npmjs.com/package/@semiont/browser)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/browser.svg)](https://www.npmjs.com/package/@semiont/browser)
[![License](https://img.shields.io/npm/l/@semiont/browser.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

Pre-built Semiont Browser as a Vite SPA with a zero-dependency Node.js static file server. This package contains the compiled Browser application ready to run with Node.js.

## Running Semiont

Most people should **not** install this package directly. A Semiont stack is run with the `semiont`
launcher — a single static binary that pulls the published container images:

```bash
brew install the-ai-alliance/semiont/semiont

cd /path/to/your-knowledge-base
semiont start
```

This package is what the `semiont-browser` container image runs inside. To run just the browser
against an already-running knowledge base, use the published image directly:

```bash
docker run --publish 3000:3000 -it ghcr.io/the-ai-alliance/semiont-browser:latest
```

## Direct usage

```bash
npm install @semiont/browser
PORT=3000 node node_modules/@semiont/browser/server.js
```

The SPA is backend-agnostic: it connects to knowledge bases chosen in the browser at runtime, so the
only environment variable it needs is `PORT`.

## Links

- [Semiont GitHub](https://github.com/The-AI-Alliance/semiont)
- [Semiont launcher](https://github.com/The-AI-Alliance/semiont/tree/main/apps/launcher)
- [Documentation](https://github.com/The-AI-Alliance/semiont#readme)
