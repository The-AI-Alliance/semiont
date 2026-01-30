/**
 * Basic Inference Example
 *
 * This example demonstrates the AI primitives provided by @semiont/inference:
 * - getInferenceClient: Get the Anthropic client singleton
 * - getInferenceModel: Get the configured model name
 * - generateText: Simple text generation
 *
 * For application-specific AI logic (entity extraction, resource generation,
 * motivation prompts/parsers), see @semiont/make-meaning examples.
 */

import { generateText, getInferenceClient } from '@semiont/inference';
import type { EnvironmentConfig } from '@semiont/core';

// Example configuration
const config: EnvironmentConfig = {
  services: {
    inference: {
      type: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      apiKey: '${ANTHROPIC_API_KEY}', // Expands from environment variable
    },
  },
};

async function main() {
  // 1. Simple text generation (the core primitive)
  console.log('🤖 Generating text with generateText()...\n');

  const result = await generateText(
    'Explain photosynthesis in simple terms',
    config,
    200,  // maxTokens
    0.7   // temperature
  );

  console.log('Response:', result);
  console.log('Length:', result.length, 'characters\n');

  // 2. Direct client access with metadata (advanced use)
  console.log('🔧 Using getInferenceClient() with metadata...\n');

  const client = await getInferenceClient(config);

  const response = await client.generateTextWithMetadata(
    'Write a haiku about programming',
    100,
    0.7
  );

  console.log('Haiku:', response.text);
  console.log('Stop reason:', response.stopReason);

  console.log('\n✨ Example complete');
  console.log('\n💡 For application-specific AI features, see @semiont/make-meaning:');
  console.log('   - Entity extraction: extractEntities()');
  console.log('   - Resource generation: generateResourceFromTopic()');
  console.log('   - Motivation prompts: MotivationPrompts');
  console.log('   - Response parsers: MotivationParsers');
}

// Note: Set environment variables before running:
// export ANTHROPIC_API_KEY=your-key-here

main().catch(console.error);
