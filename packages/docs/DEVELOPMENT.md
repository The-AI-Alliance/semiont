# Package Development Guide

## Philosophy

- **Clean, direct code** - Fix problems directly, no aliasing or compatibility layers
- **Separation of concerns** - Each package has a focused responsibility
- **Event-driven architecture** - All state changes flow through events
- **Content-addressed storage** - Resources stored by checksum for deduplication

## Development Setup

```bash
# Build all packages
npm run build

# Run all tests
npm test

# Type check all packages
npm run typecheck

# Build specific package
cd packages/your-package && npm run build

# Watch mode for development
npm run build:watch
```

## Creating a New Package

```bash
# 1. Create directory structure
mkdir -p packages/your-package/src packages/your-package/__tests__

# 2. Create package.json (see existing packages for template)

# 3. Add tsconfig.json, tsup.config.ts

# 4. Implement in src/index.ts

# 5. Add tests in __tests__/

# 6. Build and test
cd packages/your-package
npm run build
npm test
```

## Package Structure

```text
packages/your-package/
├── src/
│   ├── index.ts          # Public API exports
│   └── *.ts              # Implementation
├── __tests__/
│   └── *.test.ts
├── dist/                 # Built output (gitignored)
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── README.md
```

## Guidelines

- **Package names**: `@semiont/kebab-case`
- **Exports**: Always export from `src/index.ts`
- **Dependencies**: Use workspace dependencies for `@semiont/*` packages (`"@semiont/core": "*"`)
- **Testing**: Use Vitest, mock external dependencies
- **Documentation**: JSDoc on public APIs, README with examples