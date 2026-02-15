# Architecture Compliance Auditing System

Automated TypeScript AST analysis for enforcing React Hooks architecture patterns across the Semiont codebase.

## Overview

This system provides zero-configuration compliance auditing that:
- **Discovers symbols automatically** - No manual inventory maintenance
- **Analyzes React patterns** - Detects violations of hooks dependency rules
- **Generates compliance reports** - Markdown tables with actionable findings
- **Runs in <5 seconds** - Fast enough for CI/CD integration

## Quick Start

### React-UI Package
```bash
cd packages/react-ui
./scripts/generate-compliance-report.sh
# Outputs: REACT-UI-COMPLIANCE.md
```

### Frontend Application
```bash
cd apps/frontend
./scripts/generate-compliance-report.sh
# Outputs: FRONTEND-COMPLIANCE.md
```

## Architecture

```
scripts/compliance/          # Shared core scripts (workspace-agnostic)
├── discover-symbols.ts      # TypeScript AST analysis
├── batch-audit.ts           # Multi-file compliance checker
├── audit-dependency-arrays.ts  # React hooks pattern validator
└── docs/
    └── TENETS-REACT-UI.md   # React UI architecture rules

packages/react-ui/scripts/   # React-UI thin wrapper
└── generate-compliance-report.sh

apps/frontend/scripts/       # Frontend thin wrapper
└── generate-compliance-report.sh
```

### Design Principles

1. **DRY**: Core logic lives in `scripts/compliance/`, thin wrappers in workspaces
2. **Parameter-driven**: Scripts accept paths, never hardcode workspace assumptions
3. **stdout by default**: Core scripts write to stdout, wrappers redirect to files
4. **Zero manual maintenance**: Automatically discovers all symbols via AST analysis

## Core Scripts

### discover-symbols.ts

**Purpose**: Crawl TypeScript/TSX files and extract all exported symbols via AST analysis.

**Usage**:
```bash
npx tsx scripts/compliance/discover-symbols.ts <src-dir> <output-json>
```

**What it discovers**:
- React components (`function ComponentName`, `export function ComponentName`)
- Custom hooks (`function useCustomHook`, `export function useCustomHook`)
- TypeScript interfaces (`interface FooProps`, `export interface FooProps`)
- Utility functions (`function utilityFn`, `export function utilityFn`)

**Output format** (`symbols.json`):
```json
[
  {
    "file": "src/components/MyComponent.tsx",
    "name": "MyComponent",
    "type": "component"
  },
  {
    "file": "src/hooks/useCustomHook.ts",
    "name": "useCustomHook",
    "type": "hook"
  }
]
```

**Exclusions**: Test files (`*.test.ts`, `*.test.tsx`, `__tests__/**`)

### batch-audit.ts

**Purpose**: Run compliance checks across all discovered symbols.

**Usage**:
```bash
npx tsx scripts/compliance/batch-audit.ts <src-dir> <symbols-json>
```

**Dual-mode input**:
- **JSON mode**: Reads `symbols.json` from `discover-symbols.ts`
- **Markdown mode**: Can also parse legacy hand-maintained markdown inventories

**Checks performed**:
1. EventBus dependency violations (global singleton in deps)
2. Callback prop dependency violations (unstable references)
3. Inline handler violations (arrow functions in `useEventSubscriptions`)

**Output**: Markdown table written to stdout

### audit-dependency-arrays.ts

**Purpose**: Deep AST analysis of React hooks dependency arrays.

**What it checks**:
- ✅ `eventBus` never appears in dependency arrays (it's a global singleton)
- ✅ Callback props use the ref pattern (stored in `useRef`, synced with `useEffect`)
- ✅ No inline arrow functions in `useEventSubscriptions` (must be extracted to `useCallback`)

**Ref pattern detection**:
The auditor recognizes this pattern as compliant:
```typescript
const onCallbackRef = useRef(onCallback);
useEffect(() => {
  onCallbackRef.current = onCallback;
});

const handler = useCallback(() => {
  onCallbackRef.current();
}, []); // ✅ onCallback NOT in deps - it's in a ref
```

## Workspace Wrappers

Thin shell scripts that call shared core with workspace-specific paths.

### Example: packages/react-ui/scripts/generate-compliance-report.sh
```bash
#!/bin/bash
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SRC_DIR="$REPO_ROOT/packages/react-ui/src"

# Shared compliance scripts
DISCOVER="$REPO_ROOT/scripts/compliance/discover-symbols.ts"
AUDIT="$REPO_ROOT/scripts/compliance/batch-audit.ts"

# Discover symbols
npx tsx "$DISCOVER" "$SRC_DIR" symbols.json

# Audit and generate report
npx tsx "$AUDIT" "$SRC_DIR" symbols.json > ../../REACT-UI-COMPLIANCE.md
```

## Compliance Report Format

Generated reports use this structure:

```markdown
# React UI Compliance Report

## Summary
- Total symbols analyzed: 311
- Passing (✅): 306
- Warnings (⚠️): 0
- Failing (❌): 0
- Compliance rate: 98%

## Violation Breakdown
- eventBus in deps violations: 0
- Callback prop in deps violations: 0
- Inline handler violations: 0

## Detailed Analysis
| Path | Symbol | Type | Callbacks in deps? | Inline handlers? | Status |
|------|--------|------|--------------------|------------------|--------|
| src/components/MyComponent.tsx | MyComponent | component | ✅ No | ✅ No | ✅ |
| src/hooks/useCustomHook.ts | useCustomHook | hook | ❌ Yes | N/A | ⚠️ |
```

## Architecture Tenets

The compliance system enforces these rules (see [TENETS-REACT-UI.md](docs/TENETS-REACT-UI.md)):

### 1. EventBus Singleton Rule
```typescript
// ❌ WRONG - eventBus in dependency array
const handler = useCallback(() => {
  eventBus.emit('foo', data);
}, [eventBus]); // NEVER include eventBus in deps

// ✅ CORRECT - eventBus omitted from deps
const handler = useCallback(() => {
  eventBus.emit('foo', data);
}, []); // eventBus is global singleton - never in deps
```

### 2. Callback Prop Ref Pattern
```typescript
// ❌ WRONG - callback prop in dependency array
useEffect(() => {
  onCallback();
}, [onCallback]); // Causes re-renders on every parent update

// ✅ CORRECT - ref pattern
const onCallbackRef = useRef(onCallback);
useEffect(() => {
  onCallbackRef.current = onCallback;
});

useEffect(() => {
  onCallbackRef.current();
}, []); // Stable reference
```

### 3. No Inline Handlers in useEventSubscriptions
```typescript
// ❌ WRONG - inline arrow function
useEventSubscriptions({
  'foo:event': (data) => { handleFoo(data); }
});

// ✅ CORRECT - extracted to useCallback
const handleFooEvent = useCallback((data) => {
  handleFoo(data);
}, [handleFoo]);

useEventSubscriptions({
  'foo:event': handleFooEvent
});
```

## CI/CD Integration

### Example: GitHub Actions
```yaml
name: Architecture Compliance
on: [push, pull_request]

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3

      # Audit React-UI
      - name: React-UI Compliance
        run: |
          cd packages/react-ui
          ./scripts/generate-compliance-report.sh
          if grep -q "Failing (❌): [1-9]" ../../REACT-UI-COMPLIANCE.md; then
            echo "::error::React-UI compliance violations detected"
            exit 1
          fi

      # Audit Frontend
      - name: Frontend Compliance
        run: |
          cd apps/frontend
          ./scripts/generate-compliance-report.sh
          if grep -q "Failing (❌): [1-9]" ../../FRONTEND-COMPLIANCE.md; then
            echo "::error::Frontend compliance violations detected"
            exit 1
          fi
```

## Performance

Typical execution times (MacBook Pro M1):
- React-UI (311 symbols): ~2.1 seconds
- Frontend (90 symbols): ~1.5 seconds
- **Total dual-workspace audit**: ~3.6 seconds

Fast enough for:
- ✅ Pre-commit hooks
- ✅ CI/CD pipelines
- ✅ Watch mode during development

## Extending the System

### Adding a New Workspace

1. Create thin wrapper script in workspace:
```bash
# apps/my-app/scripts/generate-compliance-report.sh
#!/bin/bash
set -e
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SRC_DIR="$REPO_ROOT/apps/my-app/src"
SYMBOLS_FILE="$REPO_ROOT/apps/my-app/scripts/symbols.json"
REPORT_FILE="$REPO_ROOT/MY-APP-COMPLIANCE.md"

# Shared compliance scripts
DISCOVER="$REPO_ROOT/scripts/compliance/discover-symbols.ts"
AUDIT="$REPO_ROOT/scripts/compliance/batch-audit.ts"

echo "🔍 Discovering symbols in $SRC_DIR..."
npx tsx "$DISCOVER" "$SRC_DIR" "$SYMBOLS_FILE"

echo "🔬 Running compliance audit..."
npx tsx "$AUDIT" "$SRC_DIR" "$SYMBOLS_FILE" > "$REPORT_FILE"

echo "📊 Compliance report generated: $REPORT_FILE"
```

2. Make executable and update `.gitignore`:
```bash
chmod +x apps/my-app/scripts/generate-compliance-report.sh
echo "MY-APP-COMPLIANCE.md" >> .gitignore
echo "apps/my-app/scripts/symbols.json" >> .gitignore
```

### Adding New Compliance Rules

1. Edit `scripts/compliance/audit-dependency-arrays.ts`
2. Add detection logic in the AST analysis section
3. Update output in the reporting section
4. Document the new rule in `docs/ARCHITECTURE-TENETS.md`

## Troubleshooting

### "No symbols discovered"
- Check that `src/` directory exists and contains `.ts`/`.tsx` files
- Verify files aren't excluded (test files are automatically skipped)

### "False positive violations"
- Check if you're using a known compliant pattern (e.g., ref pattern for callbacks)
- The auditor recognizes ref patterns - ensure you're using the exact pattern shown above

### "Report shows 0% compliance"
- Ensure source directory path is correct (should be absolute path)
- Check that TypeScript can parse the files (run `tsc --noEmit` to verify)

### "Script fails with 'command not found'"
- Ensure you're running from workspace root (where `package.json` exists)
- Install dependencies: `npm install`

## Maintenance

### What to Update When:

**Never update manually**:
- ❌ `symbols.json` (auto-generated)
- ❌ `*-COMPLIANCE.md` (auto-generated)

**Update when adding new rules**:
- ✅ `scripts/compliance/audit-dependency-arrays.ts` (detection logic)
- ✅ `scripts/compliance/docs/TENETS-REACT-UI.md` (documentation)

**Update when adding new workspaces**:
- ✅ Add thin wrapper script in workspace
- ✅ Update `.gitignore` with new generated files

## References

- [TENETS-REACT-UI.md](docs/TENETS-REACT-UI.md) - Complete rules and patterns for React UI
- [React Hooks Rules](https://react.dev/reference/react/hooks#rules-of-hooks) - Official React documentation
- [ts-morph](https://ts-morph.com/) - TypeScript AST manipulation library
