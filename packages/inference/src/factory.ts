import Anthropic from '@anthropic-ai/sdk';
import type { EnvironmentConfig } from '@semiont/core';

// Singleton instance
let inferenceClient: Anthropic | null = null;

/**
 * Get or create the inference client
 * Following the singleton pattern from graph factory
 */
export async function getInferenceClient(config: EnvironmentConfig): Promise<Anthropic> {
  if (inferenceClient) {
    return inferenceClient;
  }

  const inferenceConfig = config.services.inference;
  if (!inferenceConfig) {
    throw new Error('services.inference is required in environment config');
  }

  // Expand environment variables in apiKey
  let apiKey = inferenceConfig.apiKey;
  if (apiKey?.startsWith('${') && apiKey.endsWith('}')) {
    const envVarName = apiKey.slice(2, -1);
    const envValue = process.env[envVarName];
    if (!envValue) {
      throw new Error(`Environment variable ${envVarName} is not set`);
    }
    apiKey = envValue;
  }

  console.log('Inference config loaded:', {
    type: inferenceConfig.type,
    model: inferenceConfig.model,
    endpoint: inferenceConfig.endpoint,
    hasApiKey: !!apiKey
  });

  inferenceClient = new Anthropic({
    apiKey: apiKey,
    baseURL: inferenceConfig.endpoint || inferenceConfig.baseURL || 'https://api.anthropic.com',
  });

  console.log(`Initialized ${inferenceConfig.type} inference client with model ${inferenceConfig.model}`);
  return inferenceClient;
}

/**
 * Get the configured model name
 */
export function getInferenceModel(config: EnvironmentConfig): string {
  const inferenceConfig = config.services.inference;
  if (!inferenceConfig?.model) {
    throw new Error('Inference model not configured! Set it in your environment configuration.');
  }
  return inferenceConfig.model;
}

/**
 * Helper function to make a simple inference call
 */
export async function generateText(
  prompt: string,
  config: EnvironmentConfig,
  maxTokens: number = 500,
  temperature: number = 0.7
): Promise<string> {
  console.log('generateText called with prompt length:', prompt.length, 'maxTokens:', maxTokens, 'temp:', temperature);

  const client = await getInferenceClient(config);

  const response = await client.messages.create({
    model: getInferenceModel(config),
    max_tokens: maxTokens,
    temperature,
    messages: [
      {
        role: 'user',
        content: prompt
      }
    ]
  });

  console.log('Inference response received, content blocks:', response.content.length);

  const textContent = response.content.find(c => c.type === 'text');

  if (!textContent || textContent.type !== 'text') {
    console.error('No text content in response:', response.content);
    throw new Error('No text content in inference response');
  }

  console.log('Returning text content of length:', textContent.text.length);
  return textContent.text;

}