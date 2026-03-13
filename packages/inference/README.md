# @semiont/inference

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+inference%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=inference)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=inference)
[![npm version](https://img.shields.io/npm/v/@semiont/inference.svg)](https://www.npmjs.com/package/@semiont/inference)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/inference.svg)](https://www.npmjs.com/package/@semiont/inference)
[![License](https://img.shields.io/npm/l/@semiont/inference.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

**AI primitives for text generation and client management.**

This package provides the **core AI primitives** for the Semiont platform:
- Inference client implementations (Anthropic, Ollama)
- Simple text generation interface
- Environment variable expansion for API keys
- Provider abstraction via `InferenceClient` interface

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

// Anthropic
const config: EnvironmentConfig = {
  services: {
    inference: {
      type: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      apiKey: '${ANTHROPIC_API_KEY}'  // Supports environment variable expansion
    }
  }
};

// Ollama (no API key required)
const ollamaConfig: EnvironmentConfig = {
  services: {
    inference: {
      type: 'ollama',
      model: 'gemma2:9b',
      endpoint: 'http://localhost:11434'
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

**Implementation** ([src/factory.ts](src/factory.ts)):
- Routes to provider-specific client (Anthropic Messages API or Ollama `/api/generate`)
- Extracts text content from response
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

**`getInferenceClient(config): Promise<InferenceClient>`**

Get an inference client instance based on configuration.

**Parameters:**
- `config: EnvironmentConfig` - Configuration

**Returns:** `Promise<InferenceClient>` - Provider-specific client implementing the `InferenceClient` interface

**Implementation** ([src/factory.ts](src/factory.ts)):
- Creates `AnthropicInferenceClient` or `OllamaInferenceClient` based on `config.services.inference.type`
- Supports environment variable expansion in API keys (e.g., `'${ANTHROPIC_API_KEY}'`)
- Ollama defaults to `http://localhost:11434`, no API key required

**Example:**
```typescript
const client = await getInferenceClient(config);
const response = await client.generateTextWithMetadata(
  'Hello',
  100,
  0.7
);
console.log(response.text);
```

**`getInferenceModel(config): string`**

Get the configured model name.

**Parameters:**
- `config: EnvironmentConfig` - Configuration

**Returns:** `string` - Model name (e.g., `'claude-3-5-sonnet-20241022'` or `'gemma2:9b'`)

**Example:**
```typescript
const model = getInferenceModel(config);
console.log(`Using model: ${model}`);
```

## Configuration

From [src/factory.ts](src/factory.ts):

```typescript
// Anthropic
config.services.inference = {
  type: 'anthropic',      // Provider type
  model: string,          // Model name (e.g., 'claude-3-5-sonnet-20241022')
  apiKey: string,         // API key or ${ENV_VAR} pattern
  endpoint?: string,      // Custom endpoint (optional)
  baseURL?: string        // Fallback endpoint (optional)
}

// Ollama
config.services.inference = {
  type: 'ollama',         // Provider type
  model: string,          // Model name (e.g., 'gemma2:9b', 'llama3.1:8b', 'mistral')
  endpoint?: string,      // Ollama server URL (default: http://localhost:11434)
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
│  - InferenceClient interface                │
│  - getInferenceClient() factory             │
│  - getInferenceModel()                      │
└──────────┬───────────────────┬──────────────┘
           │                   │
┌──────────▼──────────┐ ┌─────▼──────────────┐
│  AnthropicInference │ │  OllamaInference   │
│  Client             │ │  Client            │
│  (@anthropic-ai/sdk)│ │  (native HTTP API) │
└─────────────────────┘ └────────────────────┘
```

**Key Principles:**
- **@semiont/inference**: Provider abstraction, client management, core text generation
- **@semiont/make-meaning**: Semantic processing, prompt engineering, response parsing
- **Clean separation**: Adding a new provider only affects @semiont/inference

## Supported Providers

| Provider | Type | API Key | Models |
|----------|------|---------|--------|
| Anthropic | `anthropic` | Required (`ANTHROPIC_API_KEY`) | Claude family |
| Ollama | `ollama` | Not required | gemma2:9b, llama3.1:8b, mistral, etc. |

### Adding a New Provider

1. Implement `InferenceClient` interface in `src/implementations/`
2. Add type to `InferenceClientType` union in `src/factory.ts`
3. Add case in `createInferenceClient()` switch
4. Application code in `@semiont/make-meaning` requires no changes

## Dependencies

From [package.json](package.json):

- `@anthropic-ai/sdk` ^0.63.0 - Anthropic API client
- `@semiont/core` * - Environment configuration

Ollama uses native HTTP (`fetch`) with no SDK dependency.

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
