# Mock Platform

Testing platform with simulated service behavior.

## Overview

The Mock platform provides simulated services for testing without real dependencies.

**Platform Type**: `mock`

## Implementation

**Handlers**: [apps/cli/src/platforms/mock/handlers/](../../apps/cli/src/platforms/mock/handlers/)

- [default-start.ts](../../apps/cli/src/platforms/mock/handlers/default-start.ts) - Instant simulated start
- [default-check.ts](../../apps/cli/src/platforms/mock/handlers/default-check.ts) - Always returns healthy

## Behavior

Mock services start instantly and always report as healthy. No real processes are spawned.

## Related Documentation

- [CLI Platform Implementation](../../apps/cli/src/platforms/mock/) - Mock handlers source code
- [Adding Platforms Guide](../../apps/cli/docs/ADDING_PLATFORMS.md) - How to extend platform support
