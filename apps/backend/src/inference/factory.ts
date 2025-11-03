import Anthropic from '@anthropic-ai/sdk';
import { getLocaleEnglishName } from '@semiont/api-client';
import type { EnvironmentConfig } from '@semiont/core';

function getLanguageName(locale: string): string {
  return getLocaleEnglishName(locale) || locale;
}

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
    apiKey = process.env[envVarName];
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

/**
 * Generate resource content using inference
 */
export async function generateResourceFromTopic(
  topic: string,
  entityTypes: string[],
  config: EnvironmentConfig,
  userPrompt?: string,
  locale?: string
): Promise<{ title: string; content: string }> {
  console.log('generateResourceFromTopic called with:', {
    topic: topic.substring(0, 100),
    entityTypes,
    hasUserPrompt: !!userPrompt,
    locale
  });

  const inferenceConfig = config.services.inference;
  const provider = inferenceConfig?.type || 'anthropic';
  console.log('Using provider:', provider, 'with model:', inferenceConfig?.model);

  // Determine language instruction
  const languageInstruction = locale && locale !== 'en'
    ? `\n\nIMPORTANT: Write the entire resource in ${getLanguageName(locale)}. Both the title and all content must be in ${getLanguageName(locale)}.`
    : '';

  // Provider-agnostic base requirements
  const basePrompt = `Generate a concise, informative resource about "${topic}".
${entityTypes.length > 0 ? `Focus on these entity types: ${entityTypes.join(', ')}.` : ''}
${userPrompt ? `Additional context: ${userPrompt}` : ''}${languageInstruction}

Requirements:
- Create a clear, descriptive title
- Write 2-3 paragraphs of substantive content
- Be factual and informative
- Use markdown formatting`;

  // Provider-specific formatting instructions
  let prompt: string;
  let parseResponse: (response: string) => { title: string; content: string };

  switch (provider) {
    case 'anthropic':
      // Claude handles JSON output very reliably
      prompt = `${basePrompt}

Return ONLY valid JSON with no markdown formatting, no code fences, no additional text.
Output exactly this structure:
{
  "title": "Your descriptive title here",
  "content": "Your markdown-formatted content here\\nWith multiple paragraphs"
}

IMPORTANT: Return raw JSON only. Do not wrap in \`\`\`json or any other markdown.`;

      parseResponse = (response: string) => {
        try {
          // Strip markdown code fences if present
          let jsonStr = response.trim();
          if (jsonStr.startsWith('```json')) {
            jsonStr = jsonStr.slice(7); // Remove ```json
            const endIndex = jsonStr.lastIndexOf('```');
            if (endIndex !== -1) {
              jsonStr = jsonStr.slice(0, endIndex);
            }
          } else if (jsonStr.startsWith('```')) {
            jsonStr = jsonStr.slice(3); // Remove ```
            const endIndex = jsonStr.lastIndexOf('```');
            if (endIndex !== -1) {
              jsonStr = jsonStr.slice(0, endIndex);
            }
          }

          const parsed = JSON.parse(jsonStr.trim());
          if (!parsed.title || !parsed.content) {
            throw new Error('Missing title or content in JSON response');
          }
          return {
            title: parsed.title.trim(),
            content: parsed.content.trim()
          };
        } catch (e: any) {
          throw new Error(`Failed to parse Claude JSON response: ${e.message}. Got: ${response.slice(0, 200)}...`);
        }
      };
      break;

    case 'openai':
      // OpenAI also handles JSON well, especially with response_format parameter
      // For now, use same as Claude, but we can customize later
      prompt = `${basePrompt}

Return your response as valid JSON with this exact structure:
{
  "title": "Your descriptive title here",
  "content": "Your markdown-formatted content here\\nWith multiple paragraphs"
}`;

      parseResponse = (response: string) => {
        try {
          const parsed = JSON.parse(response);
          return {
            title: parsed.title?.trim() || topic,
            content: parsed.content?.trim() || response
          };
        } catch (e) {
          // OpenAI might not always return perfect JSON, fallback to text parsing
          const titleMatch = response.match(/["\']?title["\']?\s*:\s*["\']([^"\']+)["\']?/i);
          const contentMatch = response.match(/["\']?content["\']?\s*:\s*["\']?([\s\S]+)/i);
          return {
            title: titleMatch?.[1]?.trim() || topic,
            content: contentMatch?.[1]?.trim() || response
          };
        }
      };
      break;

    default:
      // Generic fallback using simple markers
      prompt = `${basePrompt}

Format your response as:
TITLE: [your title here]
CONTENT:
[your content here]`;

      parseResponse = (response: string) => {
        const titleMatch = response.match(/^TITLE:\s*(.+)$/m);
        const contentMatch = response.match(/^CONTENT:\s*([\s\S]+)$/m);

        if (!titleMatch || !contentMatch || !titleMatch[1] || !contentMatch[1]) {
          throw new Error(`Failed to parse response with TITLE/CONTENT markers. Got: ${response.slice(0, 200)}...`);
        }

        return {
          title: titleMatch[1].trim(),
          content: contentMatch[1].trim()
        };
      };
  }

  console.log('Sending prompt to inference (length:', prompt.length, 'chars)');
  const response = await generateText(prompt, config, 500, 0.7);
  console.log('Got raw response (length:', response.length, 'chars)');

  const result = parseResponse(response);
  console.log('Parsed result:', {
    hasTitle: !!result.title,
    titleLength: result.title?.length,
    hasContent: !!result.content,
    contentLength: result.content?.length
  });

  return result;
}

/**
 * Generate an intelligent summary for a resource
 */
export async function generateResourceSummary(
  resourceName: string,
  content: string,
  entityTypes: string[],
  config: EnvironmentConfig
): Promise<string> {
  // Truncate content if too long
  const truncatedContent = content.length > 2000
    ? content.substring(0, 2000) + '...'
    : content;

  const prompt = `Create a brief, intelligent summary of this resource titled "${resourceName}".
${entityTypes.length > 0 ? `Key entity types: ${entityTypes.join(', ')}` : ''}

Resource content:
${truncatedContent}

Write a 2-3 sentence summary that captures the key points and would help someone understand what this resource contains.`;

  return await generateText(prompt, config, 150, 0.5);
}

/**
 * Generate smart suggestions for a reference
 */
export async function generateReferenceSuggestions(
  referenceTitle: string,
  config: EnvironmentConfig,
  entityType?: string,
  currentContent?: string
): Promise<string[] | null> {
  const prompt = `For a reference titled "${referenceTitle}"${entityType ? ` (type: ${entityType})` : ''}${currentContent ? ` with current stub: "${currentContent}"` : ''}, suggest 3 specific, actionable next steps or related topics to explore.

Format as a simple list, one suggestion per line.`;

  const response = await generateText(prompt, config, 200, 0.8);
  if (!response) {
    return null;
  }

  // Parse into array of suggestions
  return response
    .split('\n')
    .map(line => line.replace(/^[-*•]\s*/, '').trim())
    .filter(line => line.length > 0)
    .slice(0, 3);
}