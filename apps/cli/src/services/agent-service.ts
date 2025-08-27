/**
 * Agent Service - Refactored with Requirements Pattern
 * 
 * AI Agent service that can run as a serverless function or container.
 * Declares requirements for AI/ML workloads.
 */

import { BaseService } from './base-service.js';
import { ServiceRequirements, RequirementPresets, mergeRequirements } from '../lib/service-requirements.js';

export class AgentService extends BaseService {
  
  // =====================================================================
  // Service Requirements
  // =====================================================================
  
  override getRequirements(): ServiceRequirements {
    // Start with serverless preset
    const baseRequirements = RequirementPresets.serverlessFunction();
    
    // Define agent-specific requirements
    const agentRequirements: ServiceRequirements = {
      network: {
        ports: this.config.port ? [this.config.port] : undefined,
        protocol: 'tcp',
        needsLoadBalancer: false,
        healthCheckPath: '/health'
      },
      dependencies: {
        services: ['backend'],
        external: [
          {
            name: 'OpenAI API',
            url: 'https://api.openai.com',
            required: this.config.provider === 'openai',
            healthCheck: 'https://api.openai.com/v1/models'
          },
          {
            name: 'Anthropic API', 
            url: 'https://api.anthropic.com',
            required: this.config.provider === 'anthropic',
            healthCheck: 'https://api.anthropic.com/v1/messages'
          }
        ]
      },
      resources: {
        memory: this.config.memory || '2Gi',
        cpu: this.config.cpu || '1',
        gpus: this.config.gpus || 0,
        ephemeralStorage: '10Gi'
      },
      security: {
        secrets: this.getRequiredSecrets(),
        readOnlyRootFilesystem: false,
        allowPrivilegeEscalation: false
      },
      environment: {
        AI_PROVIDER: this.config.provider || 'openai',
        MODEL_NAME: this.config.model || 'gpt-4',
        MAX_TOKENS: (this.config.maxTokens || 4000).toString(),
        TEMPERATURE: (this.config.temperature || 0.7).toString(),
        AGENT_MODE: this.config.mode || 'assistant'
      },
      annotations: {
        'serverless': 'true',
        'compute/gpu': this.config.gpus ? 'required' : 'optional',
        'scaling/min': '0',
        'scaling/max': '10',
        'timeout': '300'
      }
    };
    
    // Merge preset with specific requirements
    return mergeRequirements(baseRequirements, agentRequirements);
  }
  
  private getRequiredSecrets(): string[] {
    const secrets: string[] = [];
    
    switch (this.config.provider) {
      case 'openai':
        secrets.push('OPENAI_API_KEY');
        break;
      case 'anthropic':
        secrets.push('ANTHROPIC_API_KEY');
        break;
      case 'huggingface':
        secrets.push('HUGGINGFACE_API_KEY');
        break;
      case 'local':
        // Local models don't need API keys
        break;
      default:
        secrets.push('AI_API_KEY');
    }
    
    // Add vector database credentials if configured
    if (this.config.vectorDb) {
      switch (this.config.vectorDb) {
        case 'pinecone':
          secrets.push('PINECONE_API_KEY', 'PINECONE_ENVIRONMENT');
          break;
        case 'weaviate':
          secrets.push('WEAVIATE_API_KEY', 'WEAVIATE_URL');
          break;
        case 'qdrant':
          secrets.push('QDRANT_API_KEY', 'QDRANT_URL');
          break;
      }
    }
    
    return secrets;
  }
  
  // =====================================================================
  // Service-specific configuration
  // =====================================================================
  
  override getPort(): number {
    // Agents might not have a port if they're event-driven
    return this.config.port || 0;
  }
  
  override getHealthEndpoint(): string {
    return '/health';
  }
  
  override getCommand(): string {
    return this.config.command || 'python agent.py';
  }
  
  override getImage(): string {
    // Different images based on provider
    if (this.config.image) {
      return this.config.image;
    }
    
    switch (this.config.provider) {
      case 'openai':
      case 'anthropic':
        return 'semiont/agent-api:latest';
      case 'huggingface':
        return 'semiont/agent-transformers:latest';
      case 'local':
        return 'semiont/agent-llama:latest';
      default:
        return 'semiont/agent:latest';
    }
  }
  
  override getEnvironmentVariables(): Record<string, string> {
    const baseEnv = super.getEnvironmentVariables();
    const requirements = this.getRequirements();
    
    return {
      ...baseEnv,
      ...(requirements.environment || {}),
      // Add API endpoints
      BACKEND_URL: this.getBackendUrl(),
      // Add model configuration
      CONTEXT_WINDOW: (this.config.contextWindow || 8000).toString(),
      EMBEDDING_MODEL: this.config.embeddingModel || 'text-embedding-ada-002',
      // Add feature flags
      ENABLE_MEMORY: (this.config.enableMemory || false).toString(),
      ENABLE_TOOLS: (this.config.enableTools || false).toString(),
      ENABLE_WEB_SEARCH: (this.config.enableWebSearch || false).toString()
    };
  }
  
  // =====================================================================
  // Agent-specific methods
  // =====================================================================
  
  private getBackendUrl(): string {
    if (this.config.backendUrl) {
      return this.config.backendUrl;
    }
    
    // Determine backend URL based on platform
    switch (this.platform) {
      case 'process':
        return 'http://localhost:3001';
      case 'container':
        return 'http://semiont-backend:3001';
      case 'aws':
        return `https://api-${this.systemConfig.environment}.semiont.com`;
      case 'external':
        return this.config.externalBackendUrl || '';
      default:
        return 'http://localhost:3001';
    }
  }
  
  /**
   * Check if this agent needs GPU resources
   */
  public needsGPU(): boolean {
    return this.config.provider === 'local' || 
           this.config.gpus > 0 ||
           this.config.model?.includes('llama') ||
           this.config.model?.includes('mistral');
  }
  
  /**
   * Get the AI model configuration
   */
  public getModelConfig(): Record<string, any> {
    return {
      provider: this.config.provider || 'openai',
      model: this.config.model || 'gpt-4',
      maxTokens: this.config.maxTokens || 4000,
      temperature: this.config.temperature || 0.7,
      topP: this.config.topP || 1,
      frequencyPenalty: this.config.frequencyPenalty || 0,
      presencePenalty: this.config.presencePenalty || 0,
      contextWindow: this.config.contextWindow || 8000
    };
  }
  
  /**
   * Get vector database configuration if enabled
   */
  public getVectorDbConfig(): Record<string, any> | undefined {
    if (!this.config.vectorDb) {
      return undefined;
    }
    
    return {
      provider: this.config.vectorDb,
      indexName: this.config.vectorIndexName || 'semiont-agents',
      dimension: this.config.vectorDimension || 1536,
      metric: this.config.vectorMetric || 'cosine'
    };
  }
}