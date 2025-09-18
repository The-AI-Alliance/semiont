import { ExternalCheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

/**
 * Check handler for external inference services (Claude, OpenAI, etc.)
 */
const checkExternalInference = async (context: ExternalCheckHandlerContext): Promise<CheckHandlerResult> => {
  const { service } = context;
  
  // Get service-specific configuration
  const serviceConfig = service.config as any;
  const inferenceType = serviceConfig.type; // 'claude' or 'openai'
  
  // Validate inference type is configured
  if (!inferenceType) {
    return {
      success: false,
      error: 'Inference service type not configured. Set "type" to "claude" or "openai" in service configuration.',
      status: 'unknown',
      metadata: {
        serviceType: 'inference',
        hint: 'Add "type": "claude" or "type": "openai" to your service configuration'
      }
    };
  }
  
  // Validate known inference types
  const supportedTypes = ['claude', 'openai'];
  if (!supportedTypes.includes(inferenceType)) {
    return {
      success: false,
      error: `Unsupported inference type: "${inferenceType}". Supported types: ${supportedTypes.join(', ')}`,
      status: 'unknown',
      metadata: {
        serviceType: 'inference',
        inferenceType,
        supportedTypes
      }
    };
  }
  
  let status: 'running' | 'stopped' | 'unhealthy' | 'unknown' = 'unknown';
  let health: any = undefined;
  
  // Get API configuration
  const endpoint = serviceConfig.endpoint;
  const model = serviceConfig.model;
  
  if (!endpoint) {
    return {
      success: false,
      error: 'No endpoint configured for inference service',
      status: 'unknown',
      metadata: {
        serviceType: 'inference',
        inferenceType,
      }
    };
  }
  
  // Perform health check based on inference type
  try {
    const startTime = Date.now();
    let responsePreview: string | undefined;
    
    if (inferenceType === 'claude') {
      // Claude health check using SDK
      const apiKey = serviceConfig.apiKey || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error('Claude API key not configured. Set ANTHROPIC_API_KEY environment variable or apiKey in service config.');
      }
      
      const client = new Anthropic({
        apiKey,
        baseURL: endpoint,
      });
      
      // Make a minimal API call to verify connectivity
      const response = await client.messages.create({
        model: model || 'claude-3-haiku-20240307',
        max_tokens: 10,
        messages: [
          {
            role: 'user',
            content: 'Respond with "OK" if operational.'
          }
        ]
      });
      
      responsePreview = response.content[0]?.type === 'text' 
        ? response.content[0].text.substring(0, 50)
        : undefined;
        
      status = 'running';
      
    } else if (inferenceType === 'openai') {
      // OpenAI health check using SDK
      const apiKey = serviceConfig.apiKey || process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error('OpenAI API key not configured. Set OPENAI_API_KEY environment variable or apiKey in service config.');
      }
      
      const client = new OpenAI({
        apiKey,
        baseURL: endpoint,
        organization: serviceConfig.organization || process.env.OPENAI_ORG_ID,
      });
      
      // Make a minimal API call to verify connectivity
      const response = await client.chat.completions.create({
        model: model || 'gpt-3.5-turbo',
        messages: [
          {
            role: 'user',
            content: 'Respond with "OK" if operational.'
          }
        ],
        max_tokens: 10,
        temperature: 0.7,
      });
      
      responsePreview = response.choices[0]?.message?.content?.substring(0, 50);
      status = 'running';
    }
    
    const responseTime = Date.now() - startTime;
    
    // Build health response
    health = {
      endpoint,
      healthy: true,
      responseTime,
      details: {
        status: 'healthy',
        inferenceType,
        model: model,
        responseTime: `${responseTime}ms`,
        responsePreview
      }
    };
    
  } catch (error: any) {
    status = 'unhealthy';
    const errorMessage = error?.message || 'Health check failed';
    
    // Check specific error types
    if (error?.status === 401 || error?.status === 403 || errorMessage.includes('API key') || errorMessage.includes('Authentication')) {
      status = 'stopped'; // Consider it stopped if auth fails
    } else if (error?.status === 429) {
      // Rate limited but API is working
      status = 'running';
      health = {
        endpoint,
        healthy: true,
        warning: 'Rate limited but operational',
      };
    } else {
      health = {
        endpoint,
        healthy: false,
        details: { 
          error: errorMessage,
          inferenceType,
          hint: inferenceType === 'claude' 
            ? 'Ensure ANTHROPIC_API_KEY is set and valid'
            : 'Ensure OPENAI_API_KEY is set and valid',
          errorCode: error?.status,
          errorType: error?.error?.type,
        }
      };
    }
  }
  
  return {
    success: true,
    status,
    health,
    platformResources: endpoint ? {
      platform: 'external',
      data: { 
        endpoint,
        provider: inferenceType
      }
    } : undefined,
    metadata: {
      serviceType: 'inference',
      inferenceType,
      endpoint,
      model: model,
      stateVerified: true
    }
  };
};

/**
 * Descriptor for external inference check handler
 */
export const inferenceCheckDescriptor: HandlerDescriptor<ExternalCheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  platform: 'external',
  serviceType: 'inference',
  handler: checkExternalInference
};