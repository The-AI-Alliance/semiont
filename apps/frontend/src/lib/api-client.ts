import { useQuery, useMutation } from '@tanstack/react-query';
import type { StoredEvent } from '@semiont/core-types';

// Local type definitions to replace api-contracts imports
interface StatusResponse {
  status: string;
  version: string;
  features: {
    semanticContent: string;
    collaboration: string;
    rbac: string;
  };
  message: string;
  authenticatedAs?: string;
}

interface AuthResponse {
  success: boolean;
  user: {
    id: string;
    email: string;
    name: string | null;
    image: string | null;
    domain: string;
    isAdmin: boolean;
  };
  token: string;
  isNewUser: boolean;
}

interface UserResponse {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  domain: string;
  provider: string;
  isAdmin: boolean;
  isActive: boolean;
  termsAcceptedAt: string | null;
  lastLogin: string | null;
  createdAt: string;
}

interface LogoutResponse {
  success: boolean;
  message: string;
}

interface HealthResponse {
  status: string;
  message: string;
  version: string;
  timestamp: string;
  database: 'connected' | 'disconnected' | 'unknown';
  environment: string;
}

interface ErrorResponse {
  error: string;
  code?: string;
  details?: any;
}

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
  entityTypes?: string[];
  archived?: boolean;
  createdAt: string;
  updatedAt: string;
  highlights?: Selection[];
  references?: Selection[];
  
  // Provenance tracking
  creationMethod?: 'reference' | 'upload' | 'ui' | 'api' | 'clone';
  contentChecksum?: string;
  sourceSelectionId?: string;
  sourceDocumentId?: string;
  createdBy?: string;
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
  description: string;
  statistics: {
    documentCount: number;
    selectionCount: number;
    highlightCount: number;
    referenceCount: number;
    entityTypes: Record<string, number>;
  };
  entityTypeDescriptions: Array<{
    type: string;
    count: number;
    description: string;
  }>;
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
    // During build time or testing, return a placeholder URL
    if (typeof window === 'undefined' || process.env.NODE_ENV === 'test') {
      if (process.env.NODE_ENV !== 'test') {
        console.warn('NEXT_PUBLIC_API_URL not set during build, using placeholder');
      }
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
    const queryParams: Record<string, any> = {};
    
    if (params) {
      // Process parameters - separate path params from query params
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) {
          // Check if this is a path parameter (format :paramName in route)
          const pathParamPattern = new RegExp(`:${key}\\??(?=/|$)`);
          if (pathParamPattern.test(url)) {
            // Replace path parameter
            url = url.replace(`:${key}?`, String(value)).replace(`:${key}`, String(value));
          } else {
            // Collect as query parameter
            queryParams[key] = value;
          }
        }
      });
      // Remove optional parameters that weren't provided
      url = url.replace(/\/:[^/?]+\?/g, '');
    }
    
    // Add query parameters to URL
    if (Object.keys(queryParams).length > 0) {
      const searchParams = new URLSearchParams();
      Object.entries(queryParams).forEach(([key, value]) => {
        // Handle boolean and number values properly
        if (typeof value === 'boolean' || typeof value === 'number') {
          searchParams.append(key, String(value));
        } else if (value !== null && value !== undefined) {
          searchParams.append(key, String(value));
        }
      });
      url += '?' + searchParams.toString();
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

    // Handle 204 No Content responses
    if (response.status === 204) {
      return { success: true };
    }

    // Handle empty responses
    const contentLength = response.headers.get('content-length');
    if (contentLength === '0') {
      return { success: true };
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

  // Legacy methods - no longer needed with React Query auth integration
  // Kept for backwards compatibility with non-query code
  setAuthToken(token: string) {
    this.defaultHeaders['Authorization'] = `Bearer ${token}`;
  }

  clearAuthToken() {
    delete this.defaultHeaders['Authorization'];
  }

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
    const value = instance[prop as keyof TypedAPIClient];
    // Bind methods to preserve `this` context
    if (typeof value === 'function') {
      return value.bind(instance);
    }
    return value;
  },
});

// API Service Interface - defines the shape of direct API calls
interface APIService {
  status: () => Promise<StatusResponse>;

  auth: {
    google: (access_token: string) => Promise<AuthResponse>;
    me: () => Promise<UserResponse>;
    logout: () => Promise<LogoutResponse>;
  };

  health: () => Promise<HealthResponse>;

  documents: {
    create: (data: {
      name: string;
      content: string;
      contentType?: string;
      entityTypes?: string[];
      creationMethod?: 'reference' | 'upload' | 'ui' | 'api';
      sourceSelectionId?: string;
      sourceDocumentId?: string;
    }) => Promise<DocumentResponse>;
    get: (id: string) => Promise<DocumentResponse>;
    update: (id: string, data: { name?: string; entityTypes?: string[]; metadata?: any; archived?: boolean }) => Promise<DocumentResponse>;
    clone: (id: string) => Promise<{ token: string; expiresAt: string; sourceDocument: any }>;
    getReferencedBy: (id: string) => Promise<{ referencedBy: SelectionResponse[] }>;
    detectSelections: (id: string, entityTypes: string[]) => Promise<{ message: string; detectionsStarted: number }>;
    getByToken: (token: string) => Promise<{ sourceDocument: any; expiresAt: string }>;
    createFromToken: (data: { token: string; name: string; content: string; archiveOriginal?: boolean }) => Promise<DocumentResponse>;
    delete: (id: string) => Promise<{ success: boolean }>;
    list: (params?: {
      limit?: number;
      offset?: number;
      contentType?: string;
      archived?: boolean;
      entityType?: string;
      search?: string;
    }) => Promise<DocumentsResponse>;
    search: (query: string, limit?: number) => Promise<DocumentsResponse>;
    schemaDescription: () => Promise<SchemaDescriptionResponse>;
    llmContext: (id: string, selectionId?: string) => Promise<LLMContextResponse>;
    discoverContext: (text: string) => Promise<DiscoverContextResponse>;
    getEvents: (id: string, params?: { type?: string; userId?: string; limit?: number }) => Promise<{ events: StoredEvent[]; total: number; documentId: string }>;
  };

  selections: {
    create: (data: {
      documentId: string;
      text: string;
      position: { start: number; end: number };
      type?: 'provisional' | 'highlight' | 'reference';
      entityTypes?: string[];
      referenceTags?: string[];
      resolvedDocumentId?: string | null;
    }) => Promise<SelectionResponse>;
    get: (id: string) => Promise<SelectionResponse>;
    update: (id: string, data: Partial<Selection>) => Promise<SelectionResponse>;
    delete: (id: string) => Promise<{ success: boolean }>;
    list: (params?: {
      documentId?: string;
      type?: string;
      limit?: number;
      offset?: number;
    }) => Promise<SelectionsResponse>;
    saveAsHighlight: (data: {
      documentId: string;
      text: string;
      position: { start: number; end: number };
    }) => Promise<SelectionResponse>;
    resolveToDocument: (data: {
      selectionId: string;
      targetDocumentId: string;
      referenceType?: string;
    }) => Promise<SelectionResponse>;
    createDocument: (data: {
      selectionId: string;
      name: string;
      content: string;
      referenceType?: string;
    }) => Promise<DocumentResponse>;
    generateDocument: (
      selectionId: string,
      data?: {
        entityTypes?: string[];
        prompt?: string;
      }
    ) => Promise<any>;
    getHighlights: (documentId: string) => Promise<SelectionsResponse>;
    getReferences: (documentId: string) => Promise<SelectionsResponse>;
  };

  entityTypes: {
    list: () => Promise<{ entityTypes: string[] }>;
  };

  referenceTypes: {
    list: () => Promise<{ referenceTypes: string[] }>;
  };

  admin: {
    users: {
      list: () => Promise<AdminUsersResponse>;
      stats: () => Promise<AdminUserStatsResponse>;
      update: (id: string, data: { isAdmin?: boolean; isActive?: boolean; name?: string }) => Promise<AdminUserUpdateResponse>;
      delete: (id: string) => Promise<AdminUserDeleteResponse>;
    };
    oauth: {
      config: () => Promise<OAuthConfigResponse>;
    };
  };
}

// Type-safe convenience methods
export const apiService: APIService = {
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
    create: (data: {
      name: string;
      content: string;
      contentType?: string;
      entityTypes?: string[];  // Entity types can be set at creation time
      // Only context fields - backend calculates checksum, sets createdBy/createdAt
      creationMethod?: 'reference' | 'upload' | 'ui' | 'api';  // Defaults to 'api' on backend
      sourceSelectionId?: string;  // For reference-created documents
      sourceDocumentId?: string;  // For reference-created documents
    }): Promise<DocumentResponse> =>
      apiClient.post('/api/documents', { body: data }),
    
    get: (id: string): Promise<DocumentResponse> =>
      apiClient.get('/api/documents/:id', { params: { id } }),
    
    update: (id: string, data: { name?: string; entityTypes?: string[]; metadata?: any; archived?: boolean }): Promise<DocumentResponse> =>
      apiClient.patch('/api/documents/:id', { params: { id }, body: data }),
    
    clone: (id: string): Promise<{ token: string; expiresAt: string; sourceDocument: any }> =>
      apiClient.post('/api/documents/:id/clone', { params: { id }, body: {} }),
    
    getReferencedBy: (id: string): Promise<{ referencedBy: SelectionResponse[] }> =>
      apiClient.get('/api/documents/:id/referenced-by', { params: { id } }),
    
    detectSelections: (id: string, entityTypes: string[]): Promise<{ message: string; detectionsStarted: number }> =>
      apiClient.post('/api/documents/:id/detect-selections', { 
        params: { id }, 
        body: { entityTypes } 
      }),
    
    getByToken: (token: string): Promise<{ sourceDocument: any; expiresAt: string }> =>
      apiClient.get('/api/documents/token/:token', { params: { token } }),
    
    createFromToken: (data: { token: string; name: string; content: string; archiveOriginal?: boolean }): Promise<DocumentResponse> =>
      apiClient.post('/api/documents/create-from-token', { body: data }),
    
    delete: (id: string): Promise<{ success: boolean }> =>
      apiClient.delete('/api/documents/:id', { params: { id } }),
    
    list: (params?: {
      limit?: number;
      offset?: number;
      contentType?: string;
      archived?: boolean;
      entityType?: string;
      search?: string;
    }): Promise<DocumentsResponse> => {
      if (params) {
        return apiClient.get('/api/documents', { params });
      }
      return apiClient.get('/api/documents');
    },
    
    search: (query: string, limit?: number): Promise<DocumentsResponse> => {
      console.log('[API] Searching documents with query:', query, 'limit:', limit);
      return apiClient.get('/api/documents', { params: { search: query, limit } });
    },
    
    schemaDescription: (): Promise<SchemaDescriptionResponse> =>
      apiClient.get('/api/documents/schema-description'),
    
    llmContext: (id: string, selectionId?: string): Promise<LLMContextResponse> =>
      apiClient.post('/api/documents/:id/llm-context', { 
        params: { id }, 
        body: { selectionId } 
      }),
    
    discoverContext: (text: string): Promise<DiscoverContextResponse> =>
      apiClient.post('/api/documents/discover-context', { body: { text } }),

    getEvents: (id: string, params?: { type?: string; userId?: string; limit?: number }): Promise<{ events: StoredEvent[]; total: number; documentId: string }> =>
      apiClient.get('/api/documents/:id/events', { params: { id, ...params } }),
  },

  // Selection endpoints
  selections: {
    create: (data: { 
      documentId: string; 
      text: string; 
      position: { start: number; end: number };
      type?: 'provisional' | 'highlight' | 'reference';
      entityTypes?: string[];
      referenceTags?: string[];
      resolvedDocumentId?: string | null;
    }): Promise<SelectionResponse> => {
      const body: any = {
        documentId: data.documentId,
        selectionType: {
          type: 'text_span',
          offset: data.position.start,
          length: data.position.end - data.position.start,
          text: data.text
        },
        entityTypes: data.entityTypes,
        referenceTags: data.referenceTags
      };
      
      // Only include resolvedDocumentId if it's explicitly provided
      // This preserves the distinction between undefined (not sent) and null (sent as null)
      if ('resolvedDocumentId' in data) {
        body.resolvedDocumentId = data.resolvedDocumentId;
      }
      
      return apiClient.post('/api/selections', { body });
    },
    
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
      // Create selection (automatically saved as highlight when no resolvedDocumentId)
      const highlight = await apiClient.post('/api/selections', { 
        body: { 
          documentId: data.documentId,
          selectionType: {
            type: 'text_span',
            offset: data.position.start,
            length: data.position.end - data.position.start,
            text: data.text
          }
        } 
      });
      
      return highlight;
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
    
    generateDocument: (
      selectionId: string,
      data?: {
        entityTypes?: string[];
        prompt?: string;
      }
    ): Promise<any> =>
      apiClient.post('/api/selections/:id/generate-document', {
        params: { id: selectionId },
        body: data || {}
      }),
    
    getHighlights: (documentId: string): Promise<SelectionsResponse> =>
      apiClient.get('/api/documents/:documentId/highlights', { params: { documentId } }),
    
    getReferences: (documentId: string): Promise<SelectionsResponse> =>
      apiClient.get('/api/documents/:documentId/references', { params: { documentId } }),
  },

  // Entity types endpoint
  entityTypes: {
    list: (): Promise<{ entityTypes: string[] }> =>
      apiClient.get('/api/entity-types'),
  },

  // Reference types endpoint
  referenceTypes: {
    list: (): Promise<{ referenceTypes: string[] }> =>
      apiClient.get('/api/reference-types'),
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

// React Query Hooks Interface - defines available React Query hooks
interface ReactQueryAPI {
  auth: {
    google: {
      useMutation: () => any;
    };
    me: {
      useQuery: () => any;
    };
    logout: {
      useMutation: () => any;
    };
  };

  health: {
    useQuery: () => any;
  };

  admin: {
    users: {
      list: {
        useQuery: (options?: { enabled?: boolean }) => any;
      };
      stats: {
        useQuery: (options?: { enabled?: boolean }) => any;
      };
      update: {
        useMutation: () => any;
      };
      delete: {
        useMutation: () => any;
      };
    };
    oauth: {
      config: {
        useQuery: (options?: { enabled?: boolean }) => any;
      };
    };
  };

  entityTypes: {
    list: {
      useQuery: (options?: { enabled?: boolean }) => any;
    };
  };

  referenceTypes: {
    list: {
      useQuery: (options?: { enabled?: boolean }) => any;
    };
  };
}

// React Query hooks with type safety
// Use `api` for React Query hooks (useQuery/useMutation)
// Use `apiService` for direct API calls
export const api: ReactQueryAPI = {
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
        useQuery: (options?: { enabled?: boolean }) => {
          return useQuery({
            queryKey: ['admin.users.list'],
            queryFn: () => apiService.admin.users.list(),
            ...options,
          });
        }
      },
      stats: {
        useQuery: (options?: { enabled?: boolean }) => {
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
        useQuery: (options?: { enabled?: boolean }) => {
          return useQuery({
            queryKey: ['admin.oauth.config'],
            queryFn: () => apiService.admin.oauth.config(),
            ...options,
          });
        }
      }
    }
  },

  entityTypes: {
    list: {
      useQuery: (options?: { enabled?: boolean }) => {
        return useQuery({
          queryKey: ['/api/entity-types'],
          ...options,
        });
      }
    }
  },

  referenceTypes: {
    list: {
      useQuery: (options?: { enabled?: boolean }) => {
        return useQuery({
          queryKey: ['/api/reference-types'],
          ...options,
        });
      }
    }
  }
};

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