# Inference API Reference

## Overview

The `@semiont/inference` package provides AI/ML primitives for text generation, entity detection, and prompt management with support for multiple LLM providers.

## Core Functions

### generateText

Generate text using an LLM provider.

```typescript
import { generateText } from '@semiont/inference';

const result = await generateText({
  prompt: 'Explain quantum computing',
  model: 'claude-sonnet-4',
  maxTokens: 1000,
  temperature: 0.7,
  provider: 'anthropic'
});

console.log(result.text);
console.log(result.usage); // Token usage statistics
```

### generateStream

Stream text generation for real-time output.

```typescript
import { generateStream } from '@semiont/inference';

const stream = await generateStream({
  prompt: 'Write a story about...',
  model: 'claude-sonnet-4',
  provider: 'anthropic'
});

for await (const chunk of stream) {
  process.stdout.write(chunk.text);
}
```

### detectEntities

Extract entities from text.

```typescript
import { detectEntities } from '@semiont/inference';

const entities = await detectEntities({
  text: 'John Smith works at OpenAI in San Francisco.',
  entityTypes: ['Person', 'Organization', 'Location'],
  provider: 'anthropic'
});

// Returns:
// [
//   { type: 'Person', text: 'John Smith', start: 0, end: 10 },
//   { type: 'Organization', text: 'OpenAI', start: 20, end: 26 },
//   { type: 'Location', text: 'San Francisco', start: 30, end: 43 }
// ]
```

## Provider Configuration

### Anthropic (Claude)

```typescript
import { AnthropicProvider } from '@semiont/inference/providers';

const provider = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: 'claude-sonnet-4-20250514',
  maxTokens: 8192,
  endpoint: 'https://api.anthropic.com'
});
```

### OpenAI

```typescript
import { OpenAIProvider } from '@semiont/inference/providers';

const provider = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4',
  maxTokens: 8192,
  endpoint: 'https://api.openai.com/v1'
});
```

### Local Models (Ollama)

```typescript
import { OllamaProvider } from '@semiont/inference/providers';

const provider = new OllamaProvider({
  model: 'llama2',
  maxTokens: 4096,
  endpoint: 'http://localhost:11434'
});
```

## Prompt Management

### Prompt Templates

```typescript
import { PromptTemplate } from '@semiont/inference';

const template = new PromptTemplate({
  template: 'Summarize the following text in {style} style: {text}',
  variables: ['style', 'text']
});

const prompt = template.render({
  style: 'academic',
  text: 'Long document content...'
});
```

### System Prompts

```typescript
const result = await generateText({
  systemPrompt: 'You are a helpful assistant specialized in biology.',
  prompt: 'What is photosynthesis?',
  provider: 'anthropic'
});
```

## Advanced Features

### Token Counting

```typescript
import { countTokens } from '@semiont/inference';

const count = await countTokens({
  text: 'Your text here',
  model: 'claude-sonnet-4'
});

console.log(`Token count: ${count}`);
```

### Response Parsing

```typescript
import { parseJSON } from '@semiont/inference';

const result = await generateText({
  prompt: 'Generate a JSON object with name and age fields',
  responseFormat: 'json',
  provider: 'openai'
});

const data = parseJSON(result.text);
```

### Retry Logic

```typescript
import { withRetry } from '@semiont/inference';

const result = await withRetry(
  () => generateText({ prompt, provider }),
  {
    maxAttempts: 3,
    backoff: 'exponential',
    onRetry: (attempt, error) => {
      console.log(`Retry attempt ${attempt}: ${error.message}`);
    }
  }
);
```

## Context Management

### Building Context

```typescript
import { ContextBuilder } from '@semiont/inference';

const builder = new ContextBuilder();

builder
  .addDocument('doc1', 'Document content...')
  .addAnnotation('anno1', { text: 'Important note' })
  .addMetadata({ author: 'John Doe' });

const context = builder.build();
const contextPrompt = builder.toPrompt();
```

### Context Window Management

```typescript
import { truncateToWindow } from '@semiont/inference';

const truncated = truncateToWindow({
  text: veryLongText,
  maxTokens: 4000,
  model: 'claude-sonnet-4',
  strategy: 'tail' // 'head', 'tail', or 'middle'
});
```

## Error Handling

```typescript
import { InferenceError, RateLimitError, TokenLimitError } from '@semiont/inference';

try {
  const result = await generateText({ prompt, provider });
} catch (error) {
  if (error instanceof RateLimitError) {
    // Handle rate limiting
    await sleep(error.retryAfter);
  } else if (error instanceof TokenLimitError) {
    // Handle token limit exceeded
    const truncated = truncatePrompt(prompt);
  } else if (error instanceof InferenceError) {
    // Handle general inference errors
    console.error('Inference failed:', error.message);
  }
}
```

## Configuration

### Global Configuration

```typescript
import { setDefaultProvider, setDefaultModel } from '@semiont/inference';

setDefaultProvider('anthropic');
setDefaultModel('claude-sonnet-4');

// Now these defaults are used if not specified
const result = await generateText({ prompt: 'Hello' });
```

### Environment Variables

```env
# Provider API Keys
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...

# Default Configuration
DEFAULT_INFERENCE_PROVIDER=anthropic
DEFAULT_INFERENCE_MODEL=claude-sonnet-4
DEFAULT_MAX_TOKENS=8192
```