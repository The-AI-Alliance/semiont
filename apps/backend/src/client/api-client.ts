// Type-Safe API Client Generator
// This generates a fully typed API client from our route definitions

// Import route types for reference (used in type exports at the bottom)
import type {
  RequestBody,
  RequestParams,
  ResponseType,
  Routes,
  Methods
} from '../types/routes';

// HTTP method types
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

// Base fetch configuration
interface FetchConfig {
  baseUrl?: string;
  defaultHeaders?: Record<string, string>;
}

// Request options for API calls
interface RequestOptions {
  params?: Record<string, any>;
  body?: Record<string, any>;
  headers?: Record<string, string>;
}

// API client class
export class TypedAPIClient {
  private baseUrl: string;
  private defaultHeaders: Record<string, string>;

  constructor(config: FetchConfig = {}) {
    this.baseUrl = config.baseUrl || '';
    this.defaultHeaders = config.defaultHeaders || {
      'Content-Type': 'application/json',
    };
  }

  // Generic API call method
  private async call(
    route: string,
    method: HttpMethod,
    options: RequestOptions = {}
  ): Promise<any> {
    const { params, body, headers = {} } = options;
    
    // Build URL with parameters
    let url = `${this.baseUrl}${route}`;
    if (params && method === 'GET') {
      // Replace path parameters
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) {
          url = url.replace(`:${key}?`, String(value)).replace(`:${key}`, String(value));
        }
      });
      // Remove optional parameters that weren't provided
      url = url.replace(/\/:[^/?]+\?/g, '');
    }

    // Prepare request options
    const requestOptions: RequestInit = {
      method,
      headers: {
        ...this.defaultHeaders,
        ...headers,
      },
    };

    // Add body for non-GET requests
    if (body && method !== 'GET') {
      requestOptions.body = JSON.stringify(body);
    }

    // Make the request
    const response = await fetch(url, requestOptions);
    
    if (!response.ok) {
      const errorText = await response.text();
      let errorData;
      try {
        errorData = JSON.parse(errorText);
      } catch {
        errorData = { error: errorText };
      }
      throw new APIError(response.status, errorData);
    }

    return response.json();
  }

  // Typed API methods
  async get(route: string, options: RequestOptions = {}): Promise<any> {
    return this.call(route, 'GET', options);
  }

  async post(route: string, options: RequestOptions = {}): Promise<any> {
    return this.call(route, 'POST', options);
  }

  async put(route: string, options: RequestOptions = {}): Promise<any> {
    return this.call(route, 'PUT', options);
  }

  async delete(route: string, options: RequestOptions = {}): Promise<any> {
    return this.call(route, 'DELETE', options);
  }

  // Set authorization header
  setAuthToken(token: string) {
    this.defaultHeaders['Authorization'] = `Bearer ${token}`;
  }

  // Remove authorization header
  clearAuthToken() {
    delete this.defaultHeaders['Authorization'];
  }
}

// API Error class
export class APIError extends Error {
  constructor(
    public status: number,
    public data: any,
    message?: string
  ) {
    super(message || `API Error: ${status}`);
    this.name = 'APIError';
  }
}

// Pre-configured API client instance
export const apiClient = new TypedAPIClient({
  baseUrl: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000',
});

// Convenience methods that match our specific API routes with proper typing
export const api = {
  // Hello endpoints
  hello: {
    greeting: (name?: string): Promise<{
      message: string;
      timestamp: string;
      platform: string;
    }> => 
      apiClient.get('/api/hello/:name?', { params: { name } }),
  },

  status: (): Promise<{
    status: string;
    version: string;
    features: {
      semanticContent: string;
      collaboration: string;
      rbac: string;
    };
    message: string;
  }> => 
    apiClient.get('/api/status'),

  // Auth endpoints
  auth: {
    google: (access_token: string): Promise<{
      success: boolean;
      user: {
        id: string;
        email: string;
        name: string | null;
        image: string | null;
        domain: string;
      };
      token: string;
      isNewUser: boolean;
    }> =>
      apiClient.post('/api/auth/google', { body: { access_token } }),
    
    me: (): Promise<{
      id: string;
      email: string;
      name: string | null;
      image: string | null;
      domain: string;
      provider: string;
    }> =>
      apiClient.get('/api/auth/me'),
    
    logout: (): Promise<{
      success: boolean;
      message: string;
    }> =>
      apiClient.post('/api/auth/logout'),
  },

  // Health endpoints
  health: (): Promise<{
    status: string;
    message: string;
    version: string;
    timestamp: string;
    database: string;
    environment: string;
  }> =>
    apiClient.get('/api/health'),
};

// Export types for use in frontend (these re-export the imported types)
export type {
  RequestBody,
  RequestParams, 
  ResponseType,
  Routes,
  Methods,
};