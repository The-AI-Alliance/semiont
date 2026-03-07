# @semiont/inference

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+inference%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=inference)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=inference)
[![npm version](https://img.shields.io/npm/v/@semiont/inference.svg)](https://www.npmjs.com/package/@semiont/inference)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/inference.svg)](https://www.npmjs.com/package/@semiont/inference)
[![License](https://img.shields.io/npm/l/@semiont/inference.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

**AI primitives for text generation and client management.**

This package provides the **core AI primitives** for the Semiont platform:
- Anthropic client singleton management
- Simple text generation interface
- Environment variable expansion for API keys
- Provider abstraction for future extensibility

For **application-specific AI logic** (entity extraction, resource generation, motivation prompts/parsers), see [@semiont/make-meaning](../make-meaning/).

## Architecture Context

**Infrastructure Ownership**: In production applications, inference client instances are **created and managed by [@semiont/make-meaning](../make-meaning/)'s `startMakeMeaning()` function**, which serves as the single orchestration point for all infrastructure components (EventStore, GraphDB, RepStore, InferenceClient, JobQueue, Workers).

The API shown below can be used directly for **testing, CLI tools, or standalone scripts**. For backend integration, access the inference client through the `makeMeaning` context object.

## Philosophy

This package is named `inference` rather than `ai-inference` to align with Semiont's core tenet: humans and AI agents have equal opportunity to work behind similar interfaces. The abstraction remains open for future human-agent parity.

**Package Responsibility**: AI primitives only. No application logic, no prompt engineering, no response parsing. Those belong in `@semiont/make-meaning`.

## Installation

```bash
npm install @semiont/inference
```

## Quick Start

```typescript
import { generateText, getInferenceClient, getInferenceModel } from '@semiont/inference';
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

// Generate text using the primitive
const text = await generateText(
  'Explain quantum computing in simple terms',
  config,
  500,   // maxTokens
  0.7    // temperature
);

console.log(text);
```

## API Reference

### Core Primitives

**`generateText(prompt, config, maxTokens?, temperature?): Promise<string>`**

Simple text generation primitive.

**Parameters:**
- `prompt: string` - The prompt
- `config: EnvironmentConfig` - Configuration
- `maxTokens?: number` - Maximum tokens (default: 500)
- `temperature?: number` - Sampling temperature (default: 0.7)

**Returns:** `Promise<string>` - Generated text

**Implementation** ([src/factory.ts:68-102](src/factory.ts#L68-L102)):
- Uses Anthropic Messages API
- Extracts text content from first text block in response
- Throws error if no text content in response

**Example:**
```typescript
const result = await generateText(
  'Write a haiku about programming',
  config,
  100,
  0.8
);
```

**`getInferenceClient(config): Promise<Anthropic>`**

Get the singleton Anthropic client instance.

**Parameters:**
- `config: EnvironmentConfig` - Configuration

**Returns:** `Promise<Anthropic>` - Anthropic client

**Implementation** ([src/factory.ts:17-52](src/factory.ts#L17-L52)):
- Singleton pattern - creates client once, caches for reuse
- Supports environment variable expansion in API keys (e.g., '${ANTHROPIC_API_KEY}')
- Configurable baseURL with fallback to https://api.anthropic.com

**Example:**
```typescript
const client = await getInferenceClient(config);
const response = await client.messages.create({
  model: 'claude-3-5-sonnet-20241022',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'Hello' }]
});
```

**`getInferenceModel(config): string`**

Get the configured model name.

**Parameters:**
- `config: EnvironmentConfig` - Configuration

**Returns:** `string` - Model name (e.g., 'claude-3-5-sonnet-20241022')

**Example:**
```typescript
const model = getInferenceModel(config);
console.log(`Using model: ${model}`);
```

## Configuration

From [src/factory.ts:22-48](src/factory.ts#L22-L48):

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

From [src/factory.ts:27-36](src/factory.ts#L27-L36):

API keys support ${VAR_NAME} syntax:

```typescript
config.services.inference = {
  apiKey: '${ANTHROPIC_API_KEY}'  // Expands to process.env.ANTHROPIC_API_KEY
}
```

**Pattern:** starts with '${' and ends with '}'
**Behavior:** Throws error if environment variable is not set

## Application-Specific AI Logic

This package provides **primitives only**. For application-specific features, use [@semiont/make-meaning](../make-meaning/):

**Entity Extraction:**
```typescript
import { extractEntities } from '@semiont/make-meaning';

const entities = await extractEntities(
  'Marie Curie worked at the University of Paris.',
  ['Person', 'Organization'],
  config
);
```

**Resource Generation:**
```typescript
import { generateResourceFromTopic } from '@semiont/make-meaning';

const { title, content } = await generateResourceFromTopic(
  'Quantum Computing',
  ['Technology', 'Physics'],
  config
);
```

**Motivation Prompts & Parsers:**
```typescript
import { MotivationPrompts, MotivationParsers } from '@semiont/make-meaning';

// Build prompt for comment detection
const prompt = MotivationPrompts.buildCommentPrompt(content, instructions);

// Call generateText from @semiont/inference
const response = await generateText(prompt, config);

// Parse response
const comments = MotivationParsers.parseComments(response, content);
```

**Orchestrated Detection:**
```typescript
import { AnnotationDetection } from '@semiont/make-meaning';

const comments = await AnnotationDetection.detectComments(resourceId, config);
const highlights = await AnnotationDetection.detectHighlights(resourceId, config);
```

## Architecture

```
┌─────────────────────────────────────────────┐
│      @semiont/make-meaning                  │
│  (Application-specific AI logic)            │
│  - Entity extraction with validation        │
│  - Resource generation with templates       │
│  - Motivation prompts (comment/highlight)   │
│  - Response parsers with offset correction  │
│  - Orchestrated detection pipelines         │
└──────────────────┬──────────────────────────┘
                   │ uses
┌──────────────────▼──────────────────────────┐
│      @semiont/inference                     │
│  (AI primitives only)                       │
│  - getInferenceClient()                     │
│  - getInferenceModel()                      │
│  - generateText()                           │
└──────────────────┬──────────────────────────┘
                   │ uses
┌──────────────────▼──────────────────────────┐
│      @anthropic-ai/sdk                      │
│  (Anthropic Messages API)                   │
└─────────────────────────────────────────────┘
```

**Key Principles:**
- **@semiont/inference**: Provider abstraction, client management, core text generation
- **@semiont/make-meaning**: Semantic processing, prompt engineering, response parsing
- **Clean separation**: Adding OpenAI support only affects @semiont/inference

## Provider Extensibility

The package is designed for future provider support:

1. Update `getInferenceClient()` to support `config.services.inference.type`
2. Add provider-specific client initialization
3. Update `generateText()` to handle different API formats
4. Application code in `@semiont/make-meaning` remains unchanged

**Current Support:** Anthropic (Claude) via `@anthropic-ai/sdk`
**Future:** OpenAI, Google Vertex AI, local models, etc.

## Dependencies

From [package.json](package.json):

- `@anthropic-ai/sdk` ^0.63.0 - Anthropic API client
- `@semiont/core` * - Environment configuration

**Note:** No dependency on `@semiont/api-client` - primitives have minimal dependencies

## Testing

```bash
npm test                # Run tests
npm run test:watch      # Watch mode
npm run test:coverage   # Coverage report
```

## Examples

See [examples/basic.ts](examples/basic.ts) for usage examples.

## License

Apache-2.0
