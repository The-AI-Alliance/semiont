import { useQuery, useMutation } from '@tanstack/react-query';
// Import shared API types
import type {
  HelloResponse,
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
  // Hello endpoints
  hello: {
    greeting: (name?: string): Promise<HelloResponse> => 
      apiClient.get('/api/hello/:name?', { params: { name } }),
  },

  status: (): Promise<StatusResponse> => 
    apiClient.get('/api/status'),

  // Auth endpoints
  auth: {
    google: (access_token: string): Promise<AuthResponse> =>
      apiClient.post('/api/auth/google', { body: { access_token } }),
    
    me: (): Promise<UserResponse> =>
      apiClient.get('/api/auth/me'),
    
    logout: (): Promise<LogoutResponse> =>
      apiClient.post('/api/auth/logout'),
  },

  // Health endpoints
  health: (): Promise<HealthResponse> =>
    apiClient.get('/api/health'),

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
  hello: {
    greeting: {
      useQuery: (input: { name?: string }) => {
        return useQuery({
          queryKey: ['hello.greeting', input.name],
          queryFn: () => apiService.hello.greeting(input.name),
          enabled: !!input.name,
        });
      }
    },
    getStatus: {
      useQuery: () => {
        return useQuery({
          queryKey: ['hello.getStatus'],
          queryFn: () => apiService.status(),
        });
      }
    }
  },
  
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
        useQuery: () => {
          return useQuery({
            queryKey: ['admin.users.list'],
            queryFn: () => apiService.admin.users.list(),
          });
        }
      },
      stats: {
        useQuery: () => {
          return useQuery({
            queryKey: ['admin.users.stats'],
            queryFn: () => apiService.admin.users.stats(),
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
        useQuery: () => {
          return useQuery({
            queryKey: ['admin.oauth.config'],
            queryFn: () => apiService.admin.oauth.config(),
          });
        }
      }
    }
  }
};

// Export the API client
export const client = apiService;

// Export types for use in components
export type { AdminUser, AdminUsersResponse, AdminUserStatsResponse, OAuthProvider, OAuthConfigResponse };