import Anthropic from '@anthropic-ai/sdk';
import { WatsonXAI } from '@ibm-cloud/watsonx-ai';
import { IamAuthenticator } from 'ibm-cloud-sdk-core';
import { getInferenceConfig as getInferenceConfigFromEnv} from '../config/environment-loader';

// Unified inference client type - using the actual class type
type WatsonXAIClient = InstanceType<typeof WatsonXAI>;
type InferenceClient = Anthropic | WatsonXAIClient;

// Singleton instance
let inferenceClient: InferenceClient | null = null;

/**
 * Get or create the inference client
 * Following the singleton pattern from graph factory
 */
export async function getInferenceClient(): Promise<InferenceClient> {
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

  const providerType = config.type || 'anthropic';

  if (!config.apiKey) {
    throw new Error(`API key is required for ${providerType} inference provider`);
  }

  switch (providerType) {
    case 'anthropic':
      inferenceClient = new Anthropic({
        apiKey: config.apiKey,
        baseURL: config.endpoint || 'https://api.anthropic.com',
      });
      break;

    case 'watsonx':
      if (!config.endpoint) {
        throw new Error('WatsonX requires endpoint to be configured');
      }
      inferenceClient = WatsonXAI.newInstance({
        version: config.version || '2024-05-31',
        serviceUrl: config.endpoint,
        authenticator: new IamAuthenticator({
          apikey: config.apiKey,
        }),
      });
      break;

    case 'openai':
      // OpenAI uses Anthropic SDK for now (as per current implementation)
      inferenceClient = new Anthropic({
        apiKey: config.apiKey,
        baseURL: config.endpoint,
      });
      break;

    default:
      throw new Error(`Unsupported inference provider type: ${providerType}`);
  }

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

  const config = getInferenceConfigFromEnv();
  const providerType = config.type || 'anthropic';
  const client = await getInferenceClient();
  const model = getInferenceModel();

  switch (providerType) {
    case 'anthropic':
    case 'openai': {
      // Anthropic SDK (also used for OpenAI compatibility)
      const anthropicClient = client as Anthropic;
      const response = await anthropicClient.messages.create({
        model,
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

    case 'watsonx': {
      // WatsonX SDK
      const watsonxClient = client as WatsonXAIClient;
      const params: any = {
        input: prompt,
        modelId: model,
        parameters: {
          max_new_tokens: maxTokens,
          temperature
        }
      };

      // Add projectId or spaceId from config
      if (config.projectId) {
        params.projectId = config.projectId;
      } else if (config.spaceId) {
        params.spaceId = config.spaceId;
      } else {
        throw new Error('WatsonX requires either projectId or spaceId in configuration');
      }

      const response = await watsonxClient.generateText(params);

      console.log('Inference response received from WatsonX');

      const generatedText = response.result?.results?.[0]?.generated_text;

      if (!generatedText) {
        console.error('No generated text in WatsonX response:', response.result);
        throw new Error('No text content in inference response');
      }

      console.log('Returning text content of length:', generatedText.length);
      return generatedText;
    }

    default:
      throw new Error(`Unsupported provider type: ${providerType}`);
  }
}

/**
 * Generate document content using inference
 */
export async function generateDocumentFromTopic(
  topic: string,
  entityTypes: string[],
  userPrompt?: string
): Promise<{ title: string; content: string }> {
  console.log('generateDocumentFromTopic called with:', {
    topic: topic.substring(0, 100),
    entityTypes,
    hasUserPrompt: !!userPrompt
  });

  const config = getInferenceConfigFromEnv();
  const provider = config?.type || 'anthropic';
  console.log('Using provider:', provider, 'with model:', config?.model);

  // Provider-agnostic base requirements
  const basePrompt = `Generate a concise, informative document about "${topic}".
${entityTypes.length > 0 ? `Focus on these entity types: ${entityTypes.join(', ')}.` : ''}
${userPrompt ? `Additional context: ${userPrompt}` : ''}

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

    case 'watsonx':
      // WatsonX requires explicit JSON formatting instructions
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
            jsonStr = jsonStr.slice(7);
            const endIndex = jsonStr.lastIndexOf('```');
            if (endIndex !== -1) {
              jsonStr = jsonStr.slice(0, endIndex);
            }
          } else if (jsonStr.startsWith('```')) {
            jsonStr = jsonStr.slice(3);
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
          throw new Error(`Failed to parse WatsonX JSON response: ${e.message}. Got: ${response.slice(0, 200)}...`);
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