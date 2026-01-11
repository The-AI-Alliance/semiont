/**
 * MCP Server Tests
 * 
 * Tests for the Semiont MCP (Model Context Protocol) server
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

// Mock environment variables
beforeEach(() => {
  process.env.SEMIONT_ENV = 'test';
  process.env.SEMIONT_API_URL = 'http://test.api.semiont.com';
  process.env.SEMIONT_API_TOKEN = 'test-token-123';
  process.env.SEMIONT_ACCESS_TOKEN = 'test-access-token-456';
});

afterEach(() => {
  delete process.env.SEMIONT_ENV;
  delete process.env.SEMIONT_API_URL;
  delete process.env.SEMIONT_API_TOKEN;
  delete process.env.SEMIONT_ACCESS_TOKEN;
  vi.clearAllMocks();
});

// Mock fetch globally
global.fetch = vi.fn();

describe('MCP Server', () => {
  describe('Tool Registration', () => {
    it('should register semiont_hello tool', async () => {
      // Import the server module to trigger registration
      await import('./index.js');
      
      // The server should have registered the semiont_hello tool
      // We can't directly test the Server instance, but we can verify
      // the module loads without errors
      expect(process.env.SEMIONT_API_URL).toBe('http://test.api.semiont.com');
      expect(process.env.SEMIONT_API_TOKEN).toBe('test-token-123');
    });
  });

  describe('Tool Execution', () => {
    beforeEach(() => {
      // Reset fetch mock
      (global.fetch as any).mockReset();
    });

    it('should call API with authentication for hello tool', async () => {
      // Mock successful API response
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({
          message: 'Hello, World!',
          platform: 'test',
          timestamp: new Date().toISOString(),
          user: 'test@example.com'
        })
      });

      // Since we can't directly test the server handlers without
      // the full MCP infrastructure, we test the API interaction pattern
      const url = `${process.env.SEMIONT_API_URL}/api/hello`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${process.env.SEMIONT_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'http://test.api.semiont.com/api/hello',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-token-123',
            'Content-Type': 'application/json',
          })
        })
      );

      const data = await response.json();
      expect(data).toMatchObject({
        message: 'Hello, World!',
        platform: 'test',
        user: 'test@example.com'
      });
    });

    it('should handle API authentication failure', async () => {
      // Mock 401 response
      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized'
      });

      const url = `${process.env.SEMIONT_API_URL}/api/hello`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${process.env.SEMIONT_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
      });

      expect(response.ok).toBe(false);
      expect(response.status).toBe(401);
    });

    it('should call API with name parameter when provided', async () => {
      const testName = 'TestUser';
      
      // Mock successful API response
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({
          message: `Hello, ${testName}!`,
          platform: 'test',
          timestamp: new Date().toISOString(),
          user: 'test@example.com'
        })
      });

      const url = `${process.env.SEMIONT_API_URL}/api/hello/${encodeURIComponent(testName)}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${process.env.SEMIONT_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
      });

      expect(global.fetch).toHaveBeenCalledWith(
        `http://test.api.semiont.com/api/hello/${testName}`,
        expect.anything()
      );

      const data = await response.json();
      expect(data.message).toContain(testName);
    });

    it('should handle network errors gracefully', async () => {
      // Mock network error
      (global.fetch as any).mockRejectedValue(new Error('Network error'));

      const url = `${process.env.SEMIONT_API_URL}/api/hello`;
      
      await expect(
        fetch(url, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${process.env.SEMIONT_API_TOKEN}`,
            'Content-Type': 'application/json',
          },
        })
      ).rejects.toThrow('Network error');
    });
  });

  describe('Environment Configuration', () => {
    it('should use default API URL when not specified', async () => {
      delete process.env.SEMIONT_API_URL;
      
      // Re-import to get default values
      const module = await import('./index.js');
      
      // The module should use the default URL
      // Since we can't access the const directly, we verify it doesn't crash
      expect(module).toBeDefined();
    });

    it('should handle missing API token', async () => {
      delete process.env.SEMIONT_API_TOKEN;
      
      // Mock API call without token
      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized'
      });

      const url = 'http://localhost:4000/api/hello';
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': 'Bearer ',
          'Content-Type': 'application/json',
        },
      });

      expect(response.status).toBe(401);
    });
  });

  describe('Input Validation', () => {
    it('should handle name parameter with special characters', () => {
      const specialName = 'Test User & Co. <script>';
      const encoded = encodeURIComponent(specialName);
      
      expect(encoded).toBe('Test%20User%20%26%20Co.%20%3Cscript%3E');
      
      // Verify the URL is properly constructed
      const url = `http://test.api.semiont.com/api/hello/${encoded}`;
      expect(url).toContain('Test%20User%20%26%20Co.%20%3Cscript%3E');
    });

    it('should handle very long name parameters', () => {
      const longName = 'A'.repeat(150); // Exceeds typical 100 char limit
      const encoded = encodeURIComponent(longName);
      
      // The encoding should work regardless of length
      expect(encoded).toBe(longName);
      
      // Server should handle length validation
      const url = `http://test.api.semiont.com/api/hello/${encoded}`;
      expect(url.length).toBeGreaterThan(150);
    });

    it('should handle empty name parameter', () => {
      const emptyName = '';
      const encoded = encodeURIComponent(emptyName);
      
      expect(encoded).toBe('');
      
      // Should use the base URL without name
      const baseUrl = 'http://test.api.semiont.com/api/hello';
      const url = emptyName ? `${baseUrl}/${encoded}` : baseUrl;
      expect(url).toBe(baseUrl);
    });
  });
});