// Factory for creating inference client instances based on configuration

import type { Logger } from '@semiont/core';
import { InferenceClient } from './interface.js';
import { AnthropicInferenceClient } from './implementations/anthropic.js';
import { OllamaInferenceClient } from './implementations/ollama.js';

export type InferenceClientType = 'anthropic' | 'ollama';

export interface InferenceClientConfig {
  type: InferenceClientType;
  apiKey?: string;
  model: string;
  endpoint?: string;
  baseURL?: string;
}

export function createInferenceClient(config: InferenceClientConfig, logger?: Logger): InferenceClient {
  switch (config.type) {
    case 'anthropic': {
      if (!config.apiKey || config.apiKey.trim() === '') {
        throw new Error('apiKey is required for Anthropic inference client');
      }
      return new AnthropicInferenceClient(
        config.apiKey,
        config.model,
        config.endpoint || config.baseURL,
        logger
      );
    }

    case 'ollama': {
      return new OllamaInferenceClient(
        config.model,
        config.endpoint || config.baseURL,
        logger
      );
    }

    default:
      throw new Error(`Unsupported inference client type: ${config.type}`);
  }
}
