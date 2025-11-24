import { ExternalCheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';
import type { InferenceServiceConfig } from '@semiont/core';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

/**
 * Check handler for external inference services (Claude, OpenAI, etc.)
 */
const checkExternalInference = async (context: ExternalCheckHandlerContext): Promise<CheckHandlerResult> => {
  const { service } = context;

  // Get service-specific configuration with type narrowing
  const serviceConfig = service.config as InferenceServiceConfig;
  const inferenceType = serviceConfig.type; // 'anthropic' or 'openai'
  
  // Validate inference type is configured
  if (!inferenceType) {
    return {
      success: false,
      error: 'Inference service type not configured. Set "type" to "anthropic" or "openai" in service configuration.',
      status: 'unknown',
      metadata: {
        serviceType: 'inference',
        hint: 'Add "type": "anthropic" or "type": "openai" to your service configuration'
      }
    };
  }
  
  // Validate known inference types
  const supportedTypes = ['anthropic', 'openai'];
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
  
  if (!model) {
    return {
      success: false,
      error: 'No model configured for inference service',
      status: 'unknown',
      metadata: {
        serviceType: 'inference',
        inferenceType,
        hint: 'Add "model" to your service configuration (e.g., "claude-3-haiku-20240307" for Claude or "gpt-3.5-turbo" for OpenAI)'
      }
    };
  }
  
  // Perform health check based on inference type
  try {
    const startTime = Date.now();
    let responsePreview: string | undefined;
    
    if (inferenceType === 'anthropic') {
      // Anthropic health check using SDK
      let apiKey: string | undefined = serviceConfig.apiKey;

      // Handle environment variable reference from config file
      if (apiKey && apiKey.startsWith('${') && apiKey.endsWith('}')) {
        const envVarName = apiKey.slice(2, -1);
        apiKey = process.env[envVarName];
      }

      if (!apiKey) {
        throw new Error('Anthropic API key not configured. Set apiKey in service config.');
      }
      
      const client = new Anthropic({
        apiKey,
        baseURL: endpoint,
      });
      
      // Make a minimal API call to verify connectivity
      const response = await client.messages.create({
        model: model,
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
      let apiKey: string | undefined = serviceConfig.apiKey;

      // Handle environment variable reference from config file
      if (apiKey && apiKey.startsWith('${') && apiKey.endsWith('}')) {
        const envVarName = apiKey.slice(2, -1);
        apiKey = process.env[envVarName];
      }

      if (!apiKey) {
        throw new Error('OpenAI API key not configured. Set apiKey in service config.');
      }
      
      const client = new OpenAI({
        apiKey,
        baseURL: endpoint,
        organization: serviceConfig.organization || process.env.OPENAI_ORG_ID,
      });
      
      // Make a minimal API call to verify connectivity
      const response = await client.chat.completions.create({
        model: model,
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
    
    // Extract more error details from SDK errors
    let errorCode = error?.status;
    let errorType = error?.error?.type || error?.type;
    let errorDetails = error?.error?.message || error?.details;
    
    // For Anthropic SDK errors
    if (error?.response) {
      errorCode = error.response.status;
      if (error.response.data) {
        errorType = error.response.data.error?.type;
        errorDetails = error.response.data.error?.message;
      }
    }
    
    // Check specific error types
    if (errorCode === 401 || errorCode === 403 || errorMessage.includes('API key') || errorMessage.includes('Authentication')) {
      status = 'stopped'; // Consider it stopped if auth fails
      health = {
        endpoint,
        healthy: false,
        details: { 
          error: errorMessage,
          inferenceType,
          hint: `API key authentication failed. Ensure ${inferenceType === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'} is set and valid`,
          errorCode,
          errorType,
          errorDetails,
          model: model,
        }
      };
    } else if (errorCode === 429) {
      // Rate limited but API is working
      status = 'running';
      health = {
        endpoint,
        healthy: true,
        warning: 'Rate limited but operational',
        details: {
          status: 'rate_limited',
          inferenceType,
          model: model,
        }
      };
    } else if (errorCode === 404 || errorMessage.includes('model_not_found')) {
      // Model doesn't exist
      status = 'stopped';
      health = {
        endpoint,
        healthy: false,
        details: { 
          error: `Model "${model}" not found or not accessible`,
          inferenceType,
          hint: `Check if the model "${model}" is valid and accessible with your API key`,
          errorCode,
          errorType,
          errorDetails,
        }
      };
    } else {
      health = {
        endpoint,
        healthy: false,
        details: { 
          error: errorMessage,
          inferenceType,
          hint: 'Ensure apiKey is set and valid',
          errorCode,
          errorType,
          errorDetails,
          model: model,
          endpoint,
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