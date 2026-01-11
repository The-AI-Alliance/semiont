# @semiont/inference

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+inference%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=inference)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=inference)
[![npm version](https://img.shields.io/npm/v/@semiont/inference.svg)](https://www.npmjs.com/package/@semiont/inference)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/inference.svg)](https://www.npmjs.com/package/@semiont/inference)
[![License](https://img.shields.io/npm/l/@semiont/inference.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

AI inference for entity extraction, text generation, and resource creation.

## Philosophy

This package is named `inference` rather than `ai-inference` to align with Semiont's core tenet: humans and AI agents have equal opportunity to work behind similar interfaces. The abstraction remains open for future human-agent parity.

## Installation

```bash
npm install @semiont/inference
```

## Quick Start

```typescript
import { extractEntities, generateText } from '@semiont/inference';
import type { EnvironmentConfig } from '@semiont/core';

const config: EnvironmentConfig = {
  services: {
    inference: {
      type: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      apiKey: '${ANTHROPIC_API_KEY}'  // Supports environment variable expansion
    }
  }
};

// Extract entities with character offsets
const entities = await extractEntities(
  'Paris is the capital of France.',
  ['Location'],
  config
);

// Generate text
const text = await generateText(
  'Explain quantum computing in simple terms',
  config
);
```

## API Reference

From [src/index.ts](src/index.ts):

### Entity Extraction

**`extractEntities(text, entityTypes, config, includeDescriptiveReferences?)`**

Extract entity references from text with precise character offsets.

**Parameters:**
- `text: string` - Text to analyze
- `entityTypes: string[] | { type: string; examples?: string[] }[]` - Entity types to detect
- `config: EnvironmentConfig` - Configuration
- `includeDescriptiveReferences?: boolean` - Include anaphoric/cataphoric references (default: false)

**Returns:** `Promise<ExtractedEntity[]>`

```typescript
interface ExtractedEntity {
  exact: string;           // Actual text span from input
  entityType: string;     // Detected entity type
  startOffset: number;    // Character position where entity starts (0-indexed)
  endOffset: number;      // Character position where entity ends
  prefix?: string;        // Up to 32 chars before entity (for disambiguation)
  suffix?: string;        // Up to 32 chars after entity (for disambiguation)
}
```

**Implementation Details:**

From [src/entity-extractor.ts:101-102](src/entity-extractor.ts):
- Uses 4000 max_tokens to handle many entities without truncation
- Uses temperature 0.3 for consistent extraction

From [src/entity-extractor.ts:131-135](src/entity-extractor.ts):
- Throws error if response is truncated (stop_reason === 'max_tokens')
- Validates all character offsets after AI response

From [src/entity-extractor.ts:147-199](src/entity-extractor.ts):
- Corrects misaligned offsets using prefix/suffix context matching
- Filters invalid entities (negative offsets, out-of-bounds, mismatches)

**Anaphoric/Cataphoric Reference Support:**

From [src/entity-extractor.ts:48-75](src/entity-extractor.ts):

When `includeDescriptiveReferences` is true, includes:
- Direct mentions (names, proper nouns)
- Definite descriptions: "the Nobel laureate", "the tech giant"
- Role-based references: "the CEO", "the physicist"
- Epithets with context: "the Cupertino-based company"

Excludes:
- Simple pronouns: he, she, it, they
- Generic determiners: this, that, these, those
- Possessives without substance: his, her, their

### Text Generation

**`generateText(prompt, config, maxTokens?, temperature?)`**

Simple text generation with configurable parameters.

**Parameters:**
- `prompt: string` - The prompt
- `config: EnvironmentConfig` - Configuration
- `maxTokens?: number` - Maximum tokens (default: 500)
- `temperature?: number` - Sampling temperature (default: 0.7)

**Returns:** `Promise<string>`

From [src/factory.ts:78-100](src/factory.ts):
- Uses Anthropic Messages API
- Extracts text content from first text block in response
- Throws error if no text content in response

**`generateResourceFromTopic(topic, entityTypes, config, options?)`**

Generate markdown resource content about a topic.

**Parameters:**
- `topic: string` - Topic to write about
- `entityTypes: string[]` - Entity types to focus on
- `config: EnvironmentConfig` - Configuration
- `userPrompt?: string` - Additional context
- `locale?: string` - Language locale (e.g., 'es', 'fr')
- `context?: GenerationContext` - Source document context
- `temperature?: number` - Sampling temperature (default: 0.7)
- `maxTokens?: number` - Maximum tokens (default: 500)

**Returns:** `Promise<{ title: string; content: string }>`

From [src/factory.ts:186-189](src/factory.ts):
- Returns topic as title (not extracted from generated content)
- Returns generated markdown as content

From [src/factory.ts:136-138](src/factory.ts):
- Supports non-English languages using locale parameter
- Converts locale to language name (e.g., 'es' → 'Spanish')

From [src/factory.ts:166-182](src/factory.ts):
- Automatically strips markdown code fences from response if present
- Handles ```markdown, ```md, and ``` formats

**`generateResourceSummary(resourceName, content, entityTypes, config)`**

Generate a 2-3 sentence summary of a resource.

**Parameters:**
- `resourceName: string` - Name of the resource
- `content: string` - Content to summarize (truncated to 2000 chars)
- `entityTypes: string[]` - Entity types mentioned
- `config: EnvironmentConfig` - Configuration

**Returns:** `Promise<string>`

From [src/factory.ts:216-219](src/factory.ts):
- Truncates content to first 2000 characters to stay within limits
- Uses temperature 0.7, max_tokens 150

**`generateReferenceSuggestions(referenceTitle, config, entityType?, currentContent?)`**

Generate 3 actionable next steps or related topics.

**Parameters:**
- `referenceTitle: string` - Title of the reference
- `config: EnvironmentConfig` - Configuration
- `entityType?: string` - Optional entity type
- `currentContent?: string` - Optional current content for context

**Returns:** `Promise<string[] | null>`

From [src/factory.ts:246-249](src/factory.ts):
- Returns array of 3 suggestions or null on parse error
- Uses temperature 0.8 for creative suggestions

### Client Factory

**`getInferenceClient(config)`**

Get the singleton Anthropic client instance.

**Returns:** `Promise<Anthropic>`

From [src/factory.ts:10-51](src/factory.ts):
- Singleton pattern - creates client once, caches for reuse
- Supports environment variable expansion in API keys (e.g., '${ANTHROPIC_API_KEY}')
- Configurable baseURL with fallback to https://api.anthropic.com

**`getInferenceModel(config)`**

Get the configured model name.

**Returns:** `string`

## Configuration

From [src/factory.ts:22-48](src/factory.ts):

```typescript
config.services.inference = {
  type: 'anthropic',      // Provider type
  model: string,          // Model name (e.g., 'claude-3-5-sonnet-20241022')
  apiKey: string,         // API key or ${ENV_VAR} pattern
  endpoint?: string,      // Custom endpoint (optional)
  baseURL?: string        // Fallback endpoint (optional)
}
```

### Environment Variable Expansion

From [src/factory.ts:27-36](src/factory.ts):

API keys support ${VAR_NAME} syntax:

```typescript
config.services.inference = {
  apiKey: '${ANTHROPIC_API_KEY}'  // Expands to process.env.ANTHROPIC_API_KEY
}
```

Pattern: starts with '${' and ends with '}'
Throws error if environment variable is not set.

## Dependencies

From [package.json](package.json):

- `@anthropic-ai/sdk` ^0.63.0 - Anthropic API client
- `@semiont/api-client` * - Types and utilities
- `@semiont/core` * - Environment configuration

## License

Apache-2.0
