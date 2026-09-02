// Factory and inference clients (AI primitives only)
export {
  createInferenceClient,
  type InferenceClientConfig,
  type InferenceClientType,
} from './factory';

export { StructuredReadError, type ElementSchema, type InferenceClient, type InferenceLimits, type InferenceResponse, type StructuredResponse } from './interface';
export { AnthropicInferenceClient } from './implementations/anthropic';
export { OllamaInferenceClient } from './implementations/ollama';
export { MockInferenceClient } from './implementations/mock';
