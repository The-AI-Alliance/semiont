import { ExternalCheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';

/**
 * Check handler for external inference services (Claude, OpenAI, etc.)
 */
const checkExternalInference = async (context: ExternalCheckHandlerContext): Promise<CheckHandlerResult> => {
  const { service } = context;
  const requirements = service.getRequirements();
  
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
  
  // Get API configuration from service
  let endpoint: string | undefined;
  let headers: Record<string, string> | undefined;
  let testRequest: any | undefined;
  
  // Use service methods if available
  if ('getEndpoint' in service && typeof service.getEndpoint === 'function') {
    endpoint = service.getEndpoint();
  }
  
  if ('getFullHeaders' in service && typeof service.getFullHeaders === 'function') {
    headers = service.getFullHeaders();
  } else if ('getApiHeaders' in service && typeof service.getApiHeaders === 'function') {
    headers = service.getApiHeaders();
  }
  
  if ('getTestRequest' in service && typeof service.getTestRequest === 'function') {
    testRequest = service.getTestRequest();
  }
  
  // Fallback to config if methods not available
  if (!endpoint) {
    endpoint = serviceConfig.endpoint;
  }
  
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
    const healthPath = requirements.network?.healthCheckPath || '/health';
    const healthUrl = `${endpoint}${healthPath}`;
    
    // Prepare test request based on service type
    let requestBody: any;
    let requestHeaders = headers || {};
    
    if (inferenceType === 'claude') {
      // Claude-specific test
      requestBody = testRequest || {
        model: serviceConfig.model || 'claude-3-haiku-20240307',
        max_tokens: 10,
        messages: [
          {
            role: 'user',
            content: 'Respond with "OK" if operational.'
          }
        ]
      };
      
      if (!requestHeaders['x-api-key'] && !requestHeaders['X-API-Key']) {
        const apiKey = serviceConfig.apiKey || process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
          throw new Error('Claude API key not configured. Set ANTHROPIC_API_KEY environment variable or apiKey in service config.');
        }
        requestHeaders['x-api-key'] = apiKey;
        requestHeaders['anthropic-version'] = '2023-06-01';
      }
    } else if (inferenceType === 'openai') {
      // OpenAI-specific test
      requestBody = testRequest || {
        model: serviceConfig.model || 'gpt-3.5-turbo',
        messages: [
          {
            role: 'user',
            content: 'Respond with "OK" if operational.'
          }
        ],
        max_tokens: 10,
        temperature: 0.7,
      };
      
      if (!requestHeaders['Authorization']) {
        const apiKey = serviceConfig.apiKey || process.env.OPENAI_API_KEY;
        if (!apiKey) {
          throw new Error('OpenAI API key not configured. Set OPENAI_API_KEY environment variable or apiKey in service config.');
        }
        requestHeaders['Authorization'] = `Bearer ${apiKey}`;
      }
      
      // Add organization header if configured
      if (serviceConfig.organization || process.env.OPENAI_ORG_ID) {
        requestHeaders['OpenAI-Organization'] = serviceConfig.organization || process.env.OPENAI_ORG_ID;
      }
    }
    
    // Always set content type
    requestHeaders['Content-Type'] = 'application/json';
    
    // Make the health check request
    const startTime = Date.now();
    const response = await fetch(healthUrl, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(10000) // 10 second timeout for inference APIs
    });
    const responseTime = Date.now() - startTime;
    
    // Parse response
    let responseData: any = null;
    try {
      responseData = await response.json();
    } catch (e) {
      // Response might not be JSON
    }
    
    // Determine health status
    const isHealthy = response.ok && response.status < 400;
    status = isHealthy ? 'running' : 'unhealthy';
    
    // Check for specific error conditions
    if (!isHealthy) {
      if (response.status === 401 || response.status === 403) {
        throw new Error(`Authentication failed (${response.status}): Invalid or missing API key`);
      } else if (response.status === 429) {
        // Rate limited but API is working
        status = 'running';
        health = {
          endpoint: healthUrl,
          statusCode: response.status,
          healthy: true,
          warning: 'Rate limited but operational',
          responseTime,
        };
      } else {
        throw new Error(`API returned error ${response.status}: ${responseData?.error?.message || response.statusText}`);
      }
    } else {
      // Successful response
      health = {
        endpoint: healthUrl,
        statusCode: response.status,
        healthy: true,
        responseTime,
        details: {
          status: 'healthy',
          inferenceType,
          model: serviceConfig.model,
          responseTime: `${responseTime}ms`
        }
      };
      
      // Add response details if available
      if (responseData) {
        if (inferenceType === 'claude' && responseData.content) {
          health.details.responsePreview = responseData.content[0]?.text?.substring(0, 50);
        } else if (inferenceType === 'openai' && responseData.choices) {
          health.details.responsePreview = responseData.choices[0]?.message?.content?.substring(0, 50);
        }
      }
    }
  } catch (error) {
    status = 'unhealthy';
    const errorMessage = error instanceof Error ? error.message : 'Health check failed';
    
    // Check if it's an auth error
    if (errorMessage.includes('API key') || errorMessage.includes('Authentication')) {
      status = 'stopped'; // Consider it stopped if auth fails
    }
    
    health = {
      endpoint: endpoint,
      healthy: false,
      details: { 
        error: errorMessage,
        inferenceType,
        hint: inferenceType === 'claude' 
          ? 'Ensure ANTHROPIC_API_KEY is set in environment or configuration'
          : inferenceType === 'openai'
          ? 'Ensure OPENAI_API_KEY is set in environment or configuration'
          : 'Check API key configuration'
      }
    };
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
      model: serviceConfig.model,
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