# Inference Service

AI/ML inference service for LLM-powered features in Semiont.

## Overview

The Inference service provides LLM capabilities for document generation, entity detection, and context discovery. It abstracts away the underlying LLM provider (Anthropic Claude, OpenAI, local models) with a unified interface.

**Service Type**: `external`

**Primary Use Cases**:
- Document generation from annotated selections
- Entity detection and extraction
- Contextual document summarization
- Streaming text generation

## Architecture

### External Service Integration

The Inference service is configured as an `external` platform type, meaning it delegates to third-party LLM APIs:

- **Anthropic Claude**: Primary provider (claude-sonnet-4)
- **OpenAI**: Alternative provider support
- **Local Models**: Via compatible APIs (Ollama, vLLM)

### Configuration

Configured in environment files (e.g., `environments/local.json`):

```json
{
  "inference": {
    "platform": {
      "type": "external"
    },
    "type": "anthropic",
    "model": "claude-sonnet-4-20250514",
    "maxTokens": 8192,
    "endpoint": "https://api.anthropic.com",
    "apiKey": "${ANTHROPIC_API_KEY}"
  }
}
```

**Environment Variables**:
- `ANTHROPIC_API_KEY` - API key for Anthropic Claude
- `OPENAI_API_KEY` - API key for OpenAI (if using OpenAI provider)

## Key Features

### 1. Document Generation

Generate new documents from annotated text selections with graph context:

**API Endpoint**: `POST /resources/{resourceId}/annotations/{annotationId}/generate-resource-stream` (SSE streaming)

**Flow**:
1. User selects text and creates annotation
2. System extracts graph context (related documents, entities)
3. LLM generates document content using annotation + context
4. New document created and linked via annotation


### 2. Entity Detection

Automatically detect entities in resource content:

**API Endpoint**: `POST /resources/{id}/detect-annotations-stream` (SSE streaming)

**Capabilities**:
- Named entity recognition (Person, Organization, Location, etc.)
- Custom entity type detection
- Confidence scoring
- Multi-language support
- Real-time progress updates via Server-Sent Events

### 3. Context Discovery

Extract relevant context from documents for LLM consumption:

**API Endpoint**: `POST /resources/{resourceId}/annotations/{annotationId}/llm-context`

**Context Includes**:
- Document content and metadata
- Related annotations and entities
- Backlinks and references
- Graph neighborhood

## Integration Points

### Backend Integration

**Generation Worker**: [apps/backend/src/jobs/generation-worker.ts](../../apps/backend/src/jobs/generation-worker.ts)
- Handles async document generation jobs
- Streams LLM output
- Creates and links generated documents

**Detection Routes**: [apps/backend/src/routes/resources/](../../apps/backend/src/routes/resources/)
- Entity detection streaming endpoints
- Server-Sent Events support
- Error handling and retries

### Frontend Integration

**Generation UI**: [apps/frontend/src/components/](../../apps/frontend/src/components/)
- Selection-to-document workflow
- Streaming text display
- Progress indicators

## Provider Configuration

### Anthropic Claude

Default provider with streaming support:

```typescript
{
  type: 'anthropic',
  model: 'claude-sonnet-4-20250514',
  maxTokens: 8192,
  endpoint: 'https://api.anthropic.com'
}
```

### OpenAI

Alternative provider:

```typescript
{
  type: 'openai',
  model: 'gpt-4',
  maxTokens: 8192,
  endpoint: 'https://api.openai.com/v1'
}
```

### Local Models

Via Ollama or compatible API:

```typescript
{
  type: 'ollama',
  model: 'llama2',
  maxTokens: 4096,
  endpoint: 'http://localhost:11434'
}
```

## Performance Considerations

### Token Limits

- **Claude Sonnet 4**: 8192 output tokens
- **Context Window**: Manage large documents with chunking
- **Rate Limiting**: Respect provider API limits

### Streaming

All generation endpoints support streaming for better UX:
- Immediate feedback to users
- Progressive rendering
- Early error detection

### Cost Optimization

- Cache frequently used context
- Batch entity detection when possible
- Use appropriate models for task complexity

## Security

### API Key Management

- Store keys in environment variables
- Use AWS Secrets Manager in production
- Rotate keys regularly

### Input Validation

- Sanitize user input before LLM prompts
- Limit input length
- Validate entity types

### Output Safety

- Filter sensitive information from generated content
- Validate generated JSON structures
- Rate limit per-user generation

## CLI Management

The Inference service is managed via the Semiont CLI:

```bash
# Check inference service status
semiont check --service inference --environment local

# No start/stop needed (external service)
# Configuration validated on backend startup
```

## Related Documentation

- [Backend README](../../apps/backend/README.md) - API implementation
- [CLI Service Implementation](../../apps/cli/src/services/inference-service.ts) - CLI integration
- [Architecture](../ARCHITECTURE.md) - Overall system design

---

**Service Type**: External (LLM Provider)
**Primary Provider**: Anthropic Claude
**Streaming**: Supported
