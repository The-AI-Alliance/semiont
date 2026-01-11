/**
 * Basic Inference Example
 *
 * This example demonstrates:
 * - Text generation
 * - Entity detection
 * - Streaming responses
 * - Using different providers
 */

import {
  generateText,
  generateStream,
  detectEntities,
  PromptTemplate
} from '@semiont/inference';

async function main() {
  // 1. Simple text generation
  console.log('🤖 Generating text...\n');

  const result = await generateText({
    prompt: 'Explain photosynthesis in simple terms',
    model: 'claude-sonnet-4',
    maxTokens: 200,
    temperature: 0.7,
    provider: 'anthropic'
  });

  console.log('Response:', result.text);
  console.log('Tokens used:', result.usage);

  // 2. Entity detection
  console.log('\n🔍 Detecting entities...\n');

  const text = 'Marie Curie worked at the University of Paris and won the Nobel Prize in 1903.';
  const entities = await detectEntities({
    text,
    entityTypes: ['Person', 'Organization', 'Date', 'Award'],
    provider: 'anthropic'
  });

  console.log('Found entities:');
  entities.forEach(entity => {
    console.log(`  - ${entity.type}: "${entity.text}" at [${entity.start}:${entity.end}]`);
  });

  // 3. Using prompt templates
  console.log('\n📝 Using prompt template...\n');

  const template = new PromptTemplate({
    template: 'Write a {length} summary about {topic} for a {audience} audience.',
    variables: ['length', 'topic', 'audience']
  });

  const prompt = template.render({
    length: 'brief',
    topic: 'quantum computing',
    audience: 'high school'
  });

  const summary = await generateText({
    prompt,
    provider: 'anthropic',
    maxTokens: 300
  });

  console.log('Generated summary:', summary.text);

  // 4. Streaming generation
  console.log('\n🌊 Streaming response...\n');

  const stream = await generateStream({
    prompt: 'Write a haiku about programming',
    model: 'claude-sonnet-4',
    provider: 'anthropic'
  });

  process.stdout.write('Haiku: ');
  for await (const chunk of stream) {
    process.stdout.write(chunk.text);
  }
  console.log('\n');

  // 5. Error handling example
  console.log('⚠️ Demonstrating error handling...\n');

  try {
    await generateText({
      prompt: 'Test prompt',
      provider: 'anthropic',
      maxTokens: 1000000 // Too many tokens
    });
  } catch (error) {
    if (error.name === 'TokenLimitError') {
      console.log('Caught token limit error:', error.message);
    }
  }

  console.log('\n✨ Example complete');
}

// Note: Set environment variables before running:
// export ANTHROPIC_API_KEY=your-key-here

main().catch(console.error);