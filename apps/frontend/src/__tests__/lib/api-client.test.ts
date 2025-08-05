import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TypedAPIClient, APIError, apiClient, apiService } from '@/lib/api-client';

// Import server to control MSW during these tests
import { server } from '@/mocks/server';

// Import root config system (SEMIONT_ENV=test is set by scripts/test.ts)
const { config } = require('semiont-config');

// Extract test configuration values from root config
const TEST_CONFIG = {
  API_BASE_URL: `http://${config.app.backend.host}:${config.app.backend.port}`,
  API_HOST: `${config.app.backend.host}:${config.app.backend.port}`,
};

// Mock fetch globally - need to restore original fetch for MSW bypass
const originalFetch = global.fetch;
const mockFetch = vi.fn();

// Disable MSW for these tests since we're testing the HTTP layer directly
beforeEach(() => {
  server.close();
  global.fetch = mockFetch;
});

afterEach(() => {
  vi.clearAllMocks();
  global.fetch = originalFetch;
  server.listen({ onUnhandledRequest: 'warn' });
});

// Mock environment variables
const originalEnv = process.env;

// Helper to create a proper Response mock
const createMockResponse = (data: any, ok = true, status = 200) => ({
  ok,
  status,
  json: vi.fn().mockResolvedValue(data),
  text: vi.fn().mockResolvedValue(JSON.stringify(data)),
  clone: vi.fn().mockReturnThis(),
  headers: new Headers(),
  url: '',
  statusText: ok ? 'OK' : 'Error',
  type: 'basic' as ResponseType,
  redirected: false,
  body: null,
  bodyUsed: false,
  arrayBuffer: vi.fn(),
  blob: vi.fn(),
  formData: vi.fn()
});

describe('APIError', () => {
  it('should create APIError with status and data', () => {
    const error = new APIError(404, { message: 'Not found' });
    
    expect(error.status).toBe(404);
    expect(error.data).toEqual({ message: 'Not found' });
    expect(error.message).toBe('API Error: 404');
    expect(error.name).toBe('APIError');
  });

  it('should create APIError with custom message', () => {
    const error = new APIError(500, { error: 'Server error' }, 'Custom error message');
    
    expect(error.status).toBe(500);
    expect(error.data).toEqual({ error: 'Server error' });
    expect(error.message).toBe('Custom error message');
    expect(error.name).toBe('APIError');
  });

  it('should extend Error class properly', () => {
    const error = new APIError(400, { error: 'Bad request' });
    
    expect(error instanceof Error).toBe(true);
    expect(error instanceof APIError).toBe(true);
  });
});

describe('TypedAPIClient', () => {
  let client: TypedAPIClient;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, NEXT_PUBLIC_API_URL: TEST_CONFIG.API_BASE_URL };
    client = new TypedAPIClient();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('constructor', () => {
    it('should initialize with correct baseUrl and headers', () => {
      expect(client['baseUrl']).toBe(TEST_CONFIG.API_BASE_URL);
      expect(client['defaultHeaders']).toEqual({
        'Content-Type': 'application/json'
      });
    });
  });

  describe('HTTP methods', () => {
    beforeEach(() => {
      mockFetch.mockResolvedValue(createMockResponse({ success: true }));
    });

    describe('GET requests', () => {
      it('should make GET request with correct URL and headers', async () => {
        await client.get('/api/test');

        expect(mockFetch).toHaveBeenCalledWith(`${TEST_CONFIG.API_BASE_URL}/api/test`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json'
          }
        });
      });

      it('should handle path parameters', async () => {
        await client.get('/api/users/:id', { params: { id: '123' } });

        expect(mockFetch).toHaveBeenCalledWith(`${TEST_CONFIG.API_BASE_URL}/api/users/123`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json'
          }
        });
      });

      it('should handle optional path parameters', async () => {
        await client.get('/api/hello/:name?', { params: { name: 'world' } });

        expect(mockFetch).toHaveBeenCalledWith(`${TEST_CONFIG.API_BASE_URL}/api/hello/world`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json'
          }
        });
      });

      it('should remove optional parameters when not provided', async () => {
        await client.get('/api/hello/:name?', { params: {} });

        expect(mockFetch).toHaveBeenCalledWith(`${TEST_CONFIG.API_BASE_URL}/api/hello`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json'
          }
        });
      });

      it('should handle custom headers', async () => {
        await client.get('/api/test', { headers: { 'Custom-Header': 'value' } });

        expect(mockFetch).toHaveBeenCalledWith(`${TEST_CONFIG.API_BASE_URL}/api/test`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'Custom-Header': 'value'
          }
        });
      });
    });

    describe('POST requests', () => {
      it('should make POST request with body', async () => {
        const body = { name: 'test' };
        await client.post('/api/test', { body });

        expect(mockFetch).toHaveBeenCalledWith(`${TEST_CONFIG.API_BASE_URL}/api/test`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
        });
      });

      it('should not include body for GET request even if provided', async () => {
        const body = { name: 'test' };
        await client.get('/api/test', { body });

        expect(mockFetch).toHaveBeenCalledWith(`${TEST_CONFIG.API_BASE_URL}/api/test`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json'
          }
          // No body property
        });
      });
    });

    describe('PATCH requests', () => {
      it('should make PATCH request with body and parameters', async () => {
        const body = { name: 'updated' };
        await client.patch('/api/users/:id', { params: { id: '123' }, body });

        expect(mockFetch).toHaveBeenCalledWith(`${TEST_CONFIG.API_BASE_URL}/api/users/123`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
        });
      });
    });

    describe('DELETE requests', () => {
      it('should make DELETE request with parameters', async () => {
        await client.delete('/api/users/:id', { params: { id: '123' } });

        expect(mockFetch).toHaveBeenCalledWith(`${TEST_CONFIG.API_BASE_URL}/api/users/123`, {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json'
          }
        });
      });
    });
  });

  describe('error handling', () => {
    it('should throw APIError when response is not ok', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ error: 'Not found' }, false, 404));

      await expect(client.get('/api/test')).rejects.toThrow(APIError);
      
      try {
        await client.get('/api/test');
      } catch (error) {
        expect(error).toBeInstanceOf(APIError);
        expect((error as APIError).status).toBe(404);
        expect((error as APIError).data).toEqual({ error: 'Not found' });
      }
    });

    it('should handle non-JSON error responses', async () => {
      const errorResponse = createMockResponse({}, false, 500);
      errorResponse.text = vi.fn().mockResolvedValue('Internal Server Error');
      mockFetch.mockResolvedValue(errorResponse);

      try {
        await client.get('/api/test');
      } catch (error) {
        expect(error).toBeInstanceOf(APIError);
        expect((error as APIError).status).toBe(500);
        expect((error as APIError).data).toEqual({ error: 'Internal Server Error' });
      }
    });

    it('should handle malformed JSON error responses', async () => {
      const errorResponse = createMockResponse({}, false, 400);
      errorResponse.text = vi.fn().mockResolvedValue('invalid json {');
      mockFetch.mockResolvedValue(errorResponse);

      try {
        await client.get('/api/test');
      } catch (error) {
        expect(error).toBeInstanceOf(APIError);
        expect((error as APIError).status).toBe(400);
        expect((error as APIError).data).toEqual({ error: 'invalid json {' });
      }
    });
  });

  describe('authentication', () => {
    it('should set authorization header', () => {
      client.setAuthToken('test-token');
      expect(client['defaultHeaders']['Authorization']).toBe('Bearer test-token');
    });

    it('should clear authorization header', () => {
      client.setAuthToken('test-token');
      client.clearAuthToken();
      expect(client['defaultHeaders']['Authorization']).toBeUndefined();
    });

    it('should include auth header in requests', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ success: true }));

      client.setAuthToken('test-token');
      await client.get('/api/test');

      expect(mockFetch).toHaveBeenCalledWith(`${TEST_CONFIG.API_BASE_URL}/api/test`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-token'
        }
      });
    });
  });

  describe('parameter replacement edge cases', () => {
    it('should handle multiple parameters', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ success: true }));

      await client.get('/api/:type/:id/details', { 
        params: { type: 'user', id: '123' } 
      });

      expect(mockFetch).toHaveBeenCalledWith(`${TEST_CONFIG.API_BASE_URL}/api/user/123/details`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      });
    });

    it('should handle undefined parameters', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ success: true }));

      await client.get('/api/users/:id?/posts/:postId?', { 
        params: { id: '123', postId: undefined } 
      });

      expect(mockFetch).toHaveBeenCalledWith(`${TEST_CONFIG.API_BASE_URL}/api/users/123/posts`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      });
    });

    it('should convert non-string parameters to strings', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ success: true }));

      await client.get('/api/items/:id', { 
        params: { id: 123 } 
      });

      expect(mockFetch).toHaveBeenCalledWith(`${TEST_CONFIG.API_BASE_URL}/api/items/123`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      });
    });
  });
});

describe('apiClient instance', () => {
  it('should be an instance of TypedAPIClient', () => {
    expect(apiClient).toBeInstanceOf(TypedAPIClient);
  });
});

describe('apiService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue(createMockResponse({ success: true }));
    // Keep the URL consistent with test expectations
    process.env = { ...originalEnv, NEXT_PUBLIC_API_URL: TEST_CONFIG.API_BASE_URL };
  });

  describe('hello endpoints', () => {
    it('should call greeting endpoint without name parameter', async () => {
      await apiService.hello.greeting();

      expect(mockFetch).toHaveBeenCalledWith(`${TEST_CONFIG.API_BASE_URL}/api/hello`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      });
    });

    it('should call greeting endpoint with name parameter', async () => {
      await apiService.hello.greeting('world');

      expect(mockFetch).toHaveBeenCalledWith(`${TEST_CONFIG.API_BASE_URL}/api/hello/world`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      });
    });
  });

  describe('status endpoint', () => {
    it('should call status endpoint', async () => {
      await apiService.status();

      expect(mockFetch).toHaveBeenCalledWith(`${TEST_CONFIG.API_BASE_URL}/api/status`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      });
    });
  });

  describe('auth endpoints', () => {
    it('should call Google auth endpoint', async () => {
      await apiService.auth.google('test-token');

      expect(mockFetch).toHaveBeenCalledWith(`${TEST_CONFIG.API_BASE_URL}/api/auth/google`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ access_token: 'test-token' })
      });
    });

    it('should call me endpoint', async () => {
      await apiService.auth.me();

      expect(mockFetch).toHaveBeenCalledWith(`${TEST_CONFIG.API_BASE_URL}/api/auth/me`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      });
    });

    it('should call logout endpoint', async () => {
      await apiService.auth.logout();

      expect(mockFetch).toHaveBeenCalledWith(`${TEST_CONFIG.API_BASE_URL}/api/auth/logout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });
    });
  });

  describe('health endpoint', () => {
    it('should call health endpoint', async () => {
      await apiService.health();

      expect(mockFetch).toHaveBeenCalledWith(`${TEST_CONFIG.API_BASE_URL}/api/health`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      });
    });
  });

  describe('admin endpoints', () => {
    describe('users', () => {
      it('should call list users endpoint', async () => {
        await apiService.admin.users.list();

        expect(mockFetch).toHaveBeenCalledWith(`${TEST_CONFIG.API_BASE_URL}/api/admin/users`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json'
          }
        });
      });

      it('should call users stats endpoint', async () => {
        await apiService.admin.users.stats();

        expect(mockFetch).toHaveBeenCalledWith(`${TEST_CONFIG.API_BASE_URL}/api/admin/users/stats`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json'
          }
        });
      });

      it('should call update user endpoint with all fields', async () => {
        const updateData = { isAdmin: true, isActive: false, name: 'Updated Name' };
        await apiService.admin.users.update('123', updateData);

        expect(mockFetch).toHaveBeenCalledWith(`${TEST_CONFIG.API_BASE_URL}/api/admin/users/123`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(updateData)
        });
      });

      it('should call update user endpoint with partial fields', async () => {
        await apiService.admin.users.update('123', { isAdmin: true });

        expect(mockFetch).toHaveBeenCalledWith(`${TEST_CONFIG.API_BASE_URL}/api/admin/users/123`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ isAdmin: true })
        });
      });

      it('should call delete user endpoint', async () => {
        await apiService.admin.users.delete('123');

        expect(mockFetch).toHaveBeenCalledWith(`${TEST_CONFIG.API_BASE_URL}/api/admin/users/123`, {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json'
          }
        });
      });
    });

    describe('oauth', () => {
      it('should call oauth config endpoint', async () => {
        await apiService.admin.oauth.config();

        expect(mockFetch).toHaveBeenCalledWith(`${TEST_CONFIG.API_BASE_URL}/api/admin/oauth/config`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json'
          }
        });
      });
    });
  });

  describe('error propagation', () => {
    it('should propagate APIError from TypedAPIClient', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ error: 'User not found' }, false, 404));

      await expect(apiService.admin.users.delete('nonexistent')).rejects.toThrow(APIError);
      
      try {
        await apiService.admin.users.delete('nonexistent');
      } catch (error) {
        expect(error).toBeInstanceOf(APIError);
        expect((error as APIError).status).toBe(404);
        expect((error as APIError).data).toEqual({ error: 'User not found' });
      }
    });
  });
});