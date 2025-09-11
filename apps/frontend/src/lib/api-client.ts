import { useQuery, useMutation } from '@tanstack/react-query';
// Import shared API types
import type {
  StatusResponse,
  AuthResponse,
  UserResponse,
  LogoutResponse,
  HealthResponse,
  ErrorResponse
} from '@semiont/api-types';

// Admin API types
interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  domain: string;
  provider: string;
  isAdmin: boolean;
  isActive: boolean;
  lastLogin: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AdminUsersResponse {
  success: boolean;
  users: AdminUser[];
}

interface AdminUserStatsResponse {
  success: boolean;
  stats: {
    total: number;
    active: number;
    admins: number;
    recent: number;
  };
}

interface AdminUserUpdateResponse {
  success: boolean;
  user: AdminUser;
}

interface AdminUserDeleteResponse {
  success: boolean;
  message: string;
}

interface OAuthProvider {
  name: string;
  clientId?: string;
  isConfigured: boolean;
  scopes?: string[];
}

interface OAuthConfigResponse {
  success: boolean;
  providers: OAuthProvider[];
  allowedDomains: string[];
}

// Document and Selection types
interface Document {
  id: string;
  name: string;
  content: string;
  contentType: string;
  createdAt: string;
  updatedAt: string;
  highlights?: Selection[];
  references?: Selection[];
}

interface Selection {
  id: string;
  documentId: string;
  text: string;
  position: {
    start: number;
    end: number;
  };
  type: 'provisional' | 'highlight' | 'reference';
  referencedDocumentId?: string;
  entityType?: string;
  referenceType?: string;
  createdAt: string;
  updatedAt: string;
}

interface DocumentsResponse {
  success: boolean;
  documents: Document[];
  total: number;
}

interface DocumentResponse {
  success: boolean;
  document: Document;
}

interface SelectionsResponse {
  success: boolean;
  selections: Selection[];
  total: number;
}

interface SelectionResponse {
  success: boolean;
  selection: Selection;
}

interface SchemaDescriptionResponse {
  success: boolean;
  description: string;
}

interface LLMContextResponse {
  success: boolean;
  context: any;
}

interface DiscoverContextResponse {
  success: boolean;
  context: any;
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

// Request options for API calls
interface RequestOptions {
  params?: Record<string, any>;
  body?: Record<string, any>;
  headers?: Record<string, string>;
}

// Validate required environment variables - now called lazily
const validateApiUrl = () => {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  if (!apiUrl || apiUrl === 'undefined') {
    // During build time, return a placeholder URL
    if (typeof window === 'undefined') {
      console.warn('NEXT_PUBLIC_API_URL not set during build, using placeholder');
      return 'http://localhost:4000';
    }
    throw new Error('NEXT_PUBLIC_API_URL environment variable is not set. This should be configured during Docker build.');
  }
  return apiUrl;
};

// Type-safe API client class
export class TypedAPIClient {
  private baseUrl: string;
  private defaultHeaders: Record<string, string>;

  constructor(baseUrl?: string) {
    // Allow injection of baseUrl for testing, otherwise validate lazily
    this.baseUrl = baseUrl || validateApiUrl();
    this.defaultHeaders = {
      'Content-Type': 'application/json',
    };
  }

  // Generic API call method
  private async call(
    route: string,
    method: string,
    options: RequestOptions = {}
  ): Promise<any> {
    const { params, body, headers = {} } = options;
    
    // Build URL with parameters
    let url = `${this.baseUrl}${route}`;
    if (params) {
      // Replace path parameters for all methods
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

  async patch(route: string, options: RequestOptions = {}): Promise<any> {
    return this.call(route, 'PATCH', options);
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

  // Get current authorization header
  getAuthToken(): string | undefined {
    return this.defaultHeaders['Authorization'];
  }

  // Set authorization header directly (with Bearer prefix already included)
  setAuthHeader(header: string) {
    this.defaultHeaders['Authorization'] = header;
  }
}

// Lazy-loaded API client manager - exported for testing
export class LazyTypedAPIClient {
  private static instance: TypedAPIClient | null = null;
  
  static getInstance(): TypedAPIClient {
    if (!this.instance) {
      this.instance = new TypedAPIClient();
    }
    return this.instance;
  }
  
  // For testing - allow injection of custom client
  static setInstance(client: TypedAPIClient): void {
    this.instance = client;
  }
  
  // For testing - reset to force re-initialization
  static reset(): void {
    this.instance = null;
  }
}

// Export a proxy that lazily initializes the client only when accessed
export const apiClient = new Proxy({} as TypedAPIClient, {
  get(target, prop: string | symbol) {
    const instance = LazyTypedAPIClient.getInstance();
    return (instance as any)[prop];
  },
});

// Type-safe convenience methods
export const apiService = {
  status: (): Promise<StatusResponse> => 
    apiClient.get('/api/status'),

  // Auth endpoints
  auth: {
    google: (access_token: string): Promise<AuthResponse> =>
      apiClient.post('/api/tokens/google', { body: { access_token } }),
    
    me: (): Promise<UserResponse> =>
      apiClient.get('/api/users/me'),
    
    logout: (): Promise<LogoutResponse> =>
      apiClient.post('/api/users/logout'),
  },

  // Health endpoints
  health: (): Promise<HealthResponse> =>
    apiClient.get('/api/health'),

  // Document endpoints
  documents: {
    create: (data: { name: string; content: string; contentType?: string }): Promise<DocumentResponse> =>
      apiClient.post('/api/documents', { body: data }),
    
    get: (id: string): Promise<DocumentResponse> =>
      apiClient.get('/api/documents/:id', { params: { id } }),
    
    update: (id: string, data: { name?: string; content?: string; contentType?: string }): Promise<DocumentResponse> =>
      apiClient.patch('/api/documents/:id', { params: { id }, body: data }),
    
    delete: (id: string): Promise<{ success: boolean }> =>
      apiClient.delete('/api/documents/:id', { params: { id } }),
    
    list: (params?: { limit?: number; offset?: number; contentType?: string }): Promise<DocumentsResponse> => {
      if (params) {
        return apiClient.get('/api/documents', { params });
      }
      return apiClient.get('/api/documents');
    },
    
    search: (query: string, limit?: number): Promise<DocumentsResponse> =>
      apiClient.get('/api/documents/search', { params: { q: query, limit } }),
    
    schemaDescription: (): Promise<SchemaDescriptionResponse> =>
      apiClient.get('/api/documents/schema-description'),
    
    llmContext: (id: string, selectionId?: string): Promise<LLMContextResponse> =>
      apiClient.post('/api/documents/:id/llm-context', { 
        params: { id }, 
        body: { selectionId } 
      }),
    
    discoverContext: (text: string): Promise<DiscoverContextResponse> =>
      apiClient.post('/api/documents/discover-context', { body: { text } }),
  },

  // Selection endpoints
  selections: {
    create: (data: { 
      documentId: string; 
      text: string; 
      position: { start: number; end: number };
      type?: 'provisional' | 'highlight' | 'reference';
    }): Promise<SelectionResponse> =>
      apiClient.post('/api/selections', { 
        body: {
          documentId: data.documentId,
          selectionType: {
            type: 'text_span',
            offset: data.position.start,
            length: data.position.end - data.position.start,
            text: data.text
          }
        }
      }),
    
    get: (id: string): Promise<SelectionResponse> =>
      apiClient.get('/api/selections/:id', { params: { id } }),
    
    update: (id: string, data: Partial<Selection>): Promise<SelectionResponse> =>
      apiClient.patch('/api/selections/:id', { params: { id }, body: data }),
    
    delete: (id: string): Promise<{ success: boolean }> =>
      apiClient.delete('/api/selections/:id', { params: { id } }),
    
    list: (params?: { 
      documentId?: string; 
      type?: string; 
      limit?: number; 
      offset?: number; 
    }): Promise<SelectionsResponse> => {
      if (params) {
        return apiClient.get('/api/selections', { params });
      }
      return apiClient.get('/api/selections');
    },
    
    saveAsHighlight: async (data: {
      documentId: string;
      text: string;
      position: { start: number; end: number };
    }): Promise<SelectionResponse> => {
      // First create the selection
      const selection = await apiClient.post('/api/selections', { 
        body: { 
          documentId: data.documentId,
          selectionType: {
            type: 'text_span',
            offset: data.position.start,
            length: data.position.end - data.position.start,
            text: data.text
          },
          saved: true
        } 
      });
      
      return selection;
    },
    
    resolveToDocument: (data: {
      selectionId: string;
      targetDocumentId: string;
      referenceType?: string;
    }): Promise<SelectionResponse> =>
      apiClient.put('/api/selections/:id/resolve', { 
        params: { id: data.selectionId },
        body: { 
          documentId: data.targetDocumentId,
          referenceType: data.referenceType 
        }
      }),
    
    createDocument: (data: {
      selectionId: string;
      name: string;
      content: string;
      referenceType?: string;
    }): Promise<DocumentResponse> =>
      apiClient.post('/api/selections/create-document', { body: data }),
    
    generateDocument: (data: {
      selectionId: string;
      prompt?: string;
      name?: string;
      referenceType?: string;
    }): Promise<DocumentResponse> =>
      apiClient.post('/api/selections/generate-document', { body: data }),
    
    getHighlights: (documentId: string): Promise<SelectionsResponse> =>
      apiClient.get('/api/documents/:id/highlights', { params: { id: documentId } }),
    
    getReferences: (documentId: string): Promise<SelectionsResponse> =>
      apiClient.get('/api/documents/:id/references', { params: { id: documentId } }),
  },

  // Admin endpoints
  admin: {
    users: {
      list: (): Promise<AdminUsersResponse> =>
        apiClient.get('/api/admin/users'),
      
      stats: (): Promise<AdminUserStatsResponse> =>
        apiClient.get('/api/admin/users/stats'),
      
      update: (id: string, data: { isAdmin?: boolean; isActive?: boolean; name?: string }): Promise<AdminUserUpdateResponse> =>
        apiClient.patch('/api/admin/users/:id', { 
          params: { id }, 
          body: data 
        }),
      
      delete: (id: string): Promise<AdminUserDeleteResponse> =>
        apiClient.delete('/api/admin/users/:id', { params: { id } }),
    },
    
    oauth: {
      config: (): Promise<OAuthConfigResponse> =>
        apiClient.get('/api/admin/oauth/config'),
    },
  },
};

// React Query hooks with type safety
export const api = {
  auth: {
    google: {
      useMutation: () => {
        return useMutation({
          mutationFn: (input: { access_token: string }) => 
            apiService.auth.google(input.access_token),
        });
      }
    },
    me: {
      useQuery: () => {
        return useQuery({
          queryKey: ['auth.me'],
          queryFn: () => apiService.auth.me(),
        });
      }
    },
    logout: {
      useMutation: () => {
        return useMutation({
          mutationFn: () => apiService.auth.logout(),
        });
      }
    }
  },

  health: {
    useQuery: () => {
      return useQuery({
        queryKey: ['health'],
        queryFn: () => apiService.health(),
      });
    }
  },

  admin: {
    users: {
      list: {
        useQuery: (options?: any) => {
          return useQuery({
            queryKey: ['admin.users.list'],
            queryFn: () => apiService.admin.users.list(),
            ...options,
          });
        }
      },
      stats: {
        useQuery: (options?: any) => {
          return useQuery({
            queryKey: ['admin.users.stats'],
            queryFn: () => apiService.admin.users.stats(),
            ...options,
          });
        }
      },
      update: {
        useMutation: () => {
          return useMutation({
            mutationFn: (input: { id: string; data: { isAdmin?: boolean; isActive?: boolean; name?: string } }) =>
              apiService.admin.users.update(input.id, input.data),
          });
        }
      },
      delete: {
        useMutation: () => {
          return useMutation({
            mutationFn: (input: { id: string }) =>
              apiService.admin.users.delete(input.id),
          });
        }
      }
    },
    
    oauth: {
      config: {
        useQuery: (options?: any) => {
          return useQuery({
            queryKey: ['admin.oauth.config'],
            queryFn: () => apiService.admin.oauth.config(),
            ...options,
          });
        }
      }
    }
  }
};

// Export the API client
export const client = apiService;

// Export types for use in components
export type { 
  AdminUser, 
  AdminUsersResponse, 
  AdminUserStatsResponse, 
  OAuthProvider, 
  OAuthConfigResponse,
  Document,
  Selection,
  DocumentsResponse,
  DocumentResponse,
  SelectionsResponse,
  SelectionResponse,
  SchemaDescriptionResponse,
  LLMContextResponse,
  DiscoverContextResponse
};