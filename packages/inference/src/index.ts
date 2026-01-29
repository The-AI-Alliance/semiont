// Factory and inference clients (AI primitives only)
export {
  getInferenceClient,
  getInferenceModel,
  createInferenceClient,
  type InferenceClientConfig,
  type InferenceClientType,
} from './factory';

export { type InferenceClient, type InferenceResponse } from './interface';
export { AnthropicInferenceClient } from './implementations/anthropic';
export { MockInferenceClient } from './implementations/mock';
