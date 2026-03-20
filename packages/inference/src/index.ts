// Factory and inference clients (AI primitives only)
export {
  createInferenceClient,
  type InferenceClientConfig,
  type InferenceClientType,
} from './factory';

export { type InferenceClient, type InferenceResponse } from './interface';
export { AnthropicInferenceClient } from './implementations/anthropic';
export { OllamaInferenceClient } from './implementations/ollama';
export { MockInferenceClient } from './implementations/mock';
