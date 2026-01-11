# Codecov Settings Documentation

This document describes the Codecov configuration for the Semiont repository.

## GitHub Branch Protection Settings

To enforce coverage requirements, configure the following in GitHub:

### Required Status Checks

1. Go to Settings → Branches
2. Add/edit rule for `main` branch
3. Enable "Require status checks to pass before merging"
4. Add these status checks:
   - `codecov/project` - Overall project coverage
   - `codecov/patch` - Coverage for changed code
   - `Package Tests / Test <package_name>` - Individual package tests

### Coverage Requirements

From `codecov.yml`:

- **Project Coverage Target**: 70% minimum
  - Allows 1% drop without failing

- **Patch Coverage Target**: 80% minimum for new code
  - Allows 5% threshold flexibility

- **Per-Component Coverage**: Tracked individually for each package

## Local Testing

To test coverage locally:

```bash
# For a specific package
cd packages/<package-name>
npm run test:coverage

# View coverage report
open coverage/index.html
```

## Codecov Dashboard

View detailed coverage reports at:
https://app.codecov.io/gh/The-AI-Alliance/semiont

## Troubleshooting

### Coverage Not Uploading

1. Check that `CODECOV_TOKEN` is set in GitHub Secrets
2. Verify the workflow runs successfully
3. Check Codecov dashboard for upload errors

### Coverage Drops

1. Review the patch coverage in PR comments
2. Add tests for uncovered code
3. Check if legitimate exclusions should be added to codecov.yml

## Coverage Exclusions

The following are excluded from coverage:
- Test files (`*.test.ts`, `*.spec.ts`)
- Configuration files (`*.config.ts`)
- Generated files (`types.ts` in api-client)
- Build artifacts (`dist/`, `build/`)
- Examples and demos