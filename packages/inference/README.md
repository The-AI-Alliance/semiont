# @semiont/inference

AI inference capabilities for entity extraction, text generation, and resource creation.

## Philosophy

This package is named `inference` rather than `ai-inference` because one of Semiont's core tenets is to put humans and AI agents on similar footing. Humans and AI agents have equal opportunity to work behind similar interfaces.

## Installation

```bash
npm install @semiont/inference
```

## Quick Start

```typescript
import {
  getInferenceClient,
  extractEntities,
  generateText,
  generateResourceFromTopic,
} from '@semiont/inference';
import type { EnvironmentConfig } from '@semiont/core';

const config: EnvironmentConfig = {
  services: {
    inference: {
      type: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      apiKey: process.env.ANTHROPIC_API_KEY,
    }
  }
};

// Extract entities from text
const entities = await extractEntities(
  'Paris is the capital of France. The Eiffel Tower was built in 1889.',
  ['Location', 'Date'],
  config
);
// Returns: [
//   { exact: 'Paris', entityType: 'Location', startOffset: 0, endOffset: 5 },
//   { exact: 'France', entityType: 'Location', startOffset: 29, endOffset: 35 },
//   { exact: '1889', entityType: 'Date', startOffset: 67, endOffset: 71 }
// ]

// Generate text
const response = await generateText(
  'Explain quantum computing in simple terms',
  config
);

// Generate a resource from a topic
const resource = await generateResourceFromTopic(
  'quantum computing',
  ['Concept', 'Technology'],
  config
);
// Returns: { title: 'Quantum Computing', content: '# Quantum Computing...' }
```

## API

### Entity Extraction

**`extractEntities(exact, entityTypes, config, includeDescriptiveReferences?)`**

Extract entities from text with character offsets.

```typescript
interface ExtractedEntity {
  exact: string;           // The actual text span
  entityType: string;     // The detected entity type
  startOffset: number;    // Character offset where entity starts
  endOffset: number;      // Character offset where entity ends
  prefix?: string;        // Text immediately before entity
  suffix?: string;        // Text immediately after entity
}
```

### Text Generation

**`generateText(prompt, config, maxTokens?, temperature?)`**

Simple text generation with configurable parameters.

**`generateResourceFromTopic(topic, entityTypes, config, options?)`**

Generate a markdown resource about a topic with customizable prompts, locale, and context.

**`generateResourceSummary(resourceName, content, entityTypes, config)`**

Create a 2-3 sentence summary of a resource.

**`generateReferenceSuggestions(referenceTitle, config, entityType?, currentContent?)`**

Generate 3 actionable next steps or related topics.

### Inference Client

**`getInferenceClient(config)`**

Get the singleton Anthropic client with environment variable expansion support.

**`getInferenceModel(config)`**

Get the configured model name.

## Configuration

The package expects this structure in `EnvironmentConfig`:

```typescript
config.services.inference = {
  type: 'anthropic',      // Provider type
  model: string,          // Model name
  apiKey: string,         // Can use ${ENV_VAR} pattern
  endpoint?: string,      // Custom endpoint (optional)
  baseURL?: string        // Fallback endpoint
}
```

### Environment Variable Expansion

API keys support environment variable expansion:

```typescript
config.services.inference = {
  type: 'anthropic',
  model: 'claude-3-5-sonnet-20241022',
  apiKey: '${ANTHROPIC_API_KEY}'  // Expands to process.env.ANTHROPIC_API_KEY
}
```

## Dependencies

- `@anthropic-ai/sdk` - Anthropic API client
- `@semiont/api-client` - Types and utilities
- `@semiont/core` - Environment configuration

## License

Apache-2.0
