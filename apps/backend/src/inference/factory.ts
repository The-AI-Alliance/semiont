import Anthropic from '@anthropic-ai/sdk';
import { getInferenceConfig as getInferenceConfigFromEnv } from '../config/environment-loader';
import { getLocaleEnglishName } from '@semiont/core';

function getLanguageName(locale: string): string {
  return getLocaleEnglishName(locale) || locale;
}

// Singleton instance
let inferenceClient: Anthropic | null = null;

/**
 * Get or create the inference client
 * Following the singleton pattern from graph factory
 */
export async function getInferenceClient(): Promise<Anthropic> {
  if (inferenceClient) {
    return inferenceClient;
  }

  const config = getInferenceConfigFromEnv();

  console.log('Inference config loaded:', {
    type: config.type,
    model: config.model,
    endpoint: config.endpoint,
    hasApiKey: !!config.apiKey
  });

  inferenceClient = new Anthropic({
    apiKey: config.apiKey,
    baseURL: config.endpoint || 'https://api.anthropic.com',
  });

  console.log(`Initialized ${config.type} inference client with model ${config.model}`);
  return inferenceClient;
}

/**
 * Get the configured model name
 */
export function getInferenceModel(): string {
  const config = getInferenceConfigFromEnv();
  if (!config?.model) {
    throw new Error('Inference model not configured! Set it in your environment configuration.');
  }
  return config.model;
}

/**
 * Helper function to make a simple inference call
 */
export async function generateText(
  prompt: string,
  maxTokens: number = 500,
  temperature: number = 0.7
): Promise<string> {
  console.log('generateText called with prompt length:', prompt.length, 'maxTokens:', maxTokens, 'temp:', temperature);

  const client = await getInferenceClient();

  const response = await client.messages.create({
    model: getInferenceModel(),
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
 * Generate document content using inference
 */
export async function generateDocumentFromTopic(
  topic: string,
  entityTypes: string[],
  userPrompt?: string,
  locale?: string
): Promise<{ title: string; content: string }> {
  console.log('generateDocumentFromTopic called with:', {
    topic: topic.substring(0, 100),
    entityTypes,
    hasUserPrompt: !!userPrompt,
    locale
  });

  const config = getInferenceConfigFromEnv();
  const provider = config?.type || 'anthropic';
  console.log('Using provider:', provider, 'with model:', config?.model);

  // Determine language instruction
  const languageInstruction = locale && locale !== 'en'
    ? `\n\nIMPORTANT: Write the entire document in ${getLanguageName(locale)}. Both the title and all content must be in ${getLanguageName(locale)}.`
    : '';

  // Provider-agnostic base requirements
  const basePrompt = `Generate a concise, informative document about "${topic}".
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
  const response = await generateText(prompt, 500, 0.7);
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
 * Generate an intelligent summary for a document
 */
export async function generateDocumentSummary(
  documentName: string,
  content: string,
  entityTypes: string[]
): Promise<string> {
  // Truncate content if too long
  const truncatedContent = content.length > 2000
    ? content.substring(0, 2000) + '...'
    : content;

  const prompt = `Create a brief, intelligent summary of this document titled "${documentName}".
${entityTypes.length > 0 ? `Key entity types: ${entityTypes.join(', ')}` : ''}

Document content:
${truncatedContent}

Write a 2-3 sentence summary that captures the key points and would help someone understand what this document contains.`;

  return await generateText(prompt, 150, 0.5);
}

/**
 * Generate smart suggestions for a reference
 */
export async function generateReferenceSuggestions(
  referenceTitle: string,
  entityType?: string,
  currentContent?: string
): Promise<string[] | null> {
  const prompt = `For a reference titled "${referenceTitle}"${entityType ? ` (type: ${entityType})` : ''}${currentContent ? ` with current stub: "${currentContent}"` : ''}, suggest 3 specific, actionable next steps or related topics to explore.

Format as a simple list, one suggestion per line.`;

  const response = await generateText(prompt, 200, 0.8);
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