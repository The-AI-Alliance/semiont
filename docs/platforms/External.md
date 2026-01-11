# External Platform

Platform for third-party services not managed by Semiont CLI.

## Overview

The External platform represents services managed outside Semiont CLI - external APIs, managed services, or third-party providers.

**Platform Type**: `external`

## Configuration

**Example from** [local.json](../../apps/cli/templates/environments/local.json):

```json
{
  "inference": {
    "platform": {
      "type": "external"
    },
    "type": "anthropic",
    "model": "claude-sonnet-4-20250514",
    "endpoint": "https://api.anthropic.com",
    "apiKey": "${ANTHROPIC_API_KEY}"
  },
  "graph": {
    "platform": {
      "type": "external"
    },
    "type": "neo4j",
    "uri": "${NEO4J_URI}",
    "username": "${NEO4J_USERNAME}",
    "password": "${NEO4J_PASSWORD}"
  }
}
```

## Supported Services

Based on handler files in [apps/cli/src/platforms/external/handlers/](../../apps/cli/src/platforms/external/handlers/):
- **inference** - LLM APIs (Anthropic, OpenAI)
- **graph** - Managed graph databases (Neo4j Aura, AWS Neptune)

## Implementation

**Handlers**: [apps/cli/src/platforms/external/handlers/](../../apps/cli/src/platforms/external/handlers/)

- [inference-check.ts](../../apps/cli/src/platforms/external/handlers/inference-check.ts) - Check LLM API connectivity
- [graph-check.ts](../../apps/cli/src/platforms/external/handlers/graph-check.ts) - Check graph database connectivity

## Behavior

External services support `check` command only - no start/stop lifecycle management.

## Related Documentation

- [CLI Platform Implementation](../../apps/cli/src/platforms/external/) - External handlers source code
- [Inference Package](../../packages/inference/) - LLM integration and API documentation
- [Graph Package](../../packages/graph/) - Graph database abstraction and providers
