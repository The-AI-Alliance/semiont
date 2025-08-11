# CLI Test Suite

This test suite verifies that the Semiont CLI uses **filesystem-based environment discovery** instead of hardcoded validation, ensuring maximum flexibility for users.

## Key Behaviors Tested

### ✅ Filesystem Authority
- **Users can create `config/environments/foo.json`** and use `-e foo` 
- **The filesystem is the single source of truth** for valid environments
- **No hardcoded environment restrictions** prevent custom configurations

### ✅ Dynamic Discovery
- Environment validation discovers files dynamically from `config/environments/`
- Help text shows all available environments from filesystem
- CLI accepts any well-formed JSON environment configuration

### ✅ Error Handling
- Helpful error messages when environments are missing
- Clear guidance on how to fix configuration issues
- Proper JSON syntax error reporting

### ✅ Backward Compatibility  
- Standard environments (local, production, etc.) work if present
- Mixed standard and custom environments are supported
- No breaking changes to existing workflows

## Test Files

### `environment-validation.test.ts`
Core filesystem discovery functionality:
- `getAvailableEnvironments()` scans the filesystem
- `isValidEnvironment()` validates against discovered files
- `loadEnvironmentConfig()` parses configurations correctly

### `filesystem-authority.test.ts` 
**Proves filesystem authority over hardcoded lists:**
- Creating `foo.json` makes `-e foo` valid
- Custom environment names work (dashes, underscores, etc.)
- Filesystem changes immediately affect validation

### `cli-validation.test.ts`
CLI integration and error messages:
- Dynamic environment lists in help text
- Proper error messages for missing environments
- Configuration loading with complete environment structures

### `dynamic-environments.test.ts`
Core dynamic discovery scenarios:
- Custom environments are discovered and usable
- Non-JSON files are ignored
- Empty config directories are handled gracefully

## Running Tests

```bash
# Run all tests
npm test

# Run specific test file
npx vitest run __tests__/filesystem-authority.test.ts

# Watch mode for development
npm run test
```

## What This Proves

These tests establish **durable guarantees** that:

1. **Users have full control** over valid environments via filesystem
2. **No hardcoded restrictions** limit environment naming or configuration
3. **Dynamic discovery** means environments can be added/removed without code changes
4. **Error messages are helpful** and guide users to solutions
5. **The CLI respects user intent** rather than imposing artificial constraints

This ensures the CLI remains flexible and user-focused as requirements evolve.