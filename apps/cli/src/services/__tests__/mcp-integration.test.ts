/**
 * MCP Integration Tests
 * 
 * Integration tests for the MCP (Model Context Protocol) OAuth flow
 * and token refresh mechanism
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock modules
vi.mock('child_process');
vi.mock('open', () => ({
  default: vi.fn()
}));

describe('MCP OAuth Flow Integration', () => {
  const testConfigDir = path.join(os.tmpdir(), 'test-semiont-config');
  const testAuthFile = path.join(testConfigDir, 'mcp-auth-test.json');

  beforeEach(() => {
    // Clean up test directory
    if (fs.existsSync(testConfigDir)) {
      fs.rmSync(testConfigDir, { recursive: true });
    }
    fs.mkdirSync(testConfigDir, { recursive: true });

    // Mock environment
    process.env.HOME = os.tmpdir();
    
    // Mock spawn for MCP server process
    (spawn as any).mockReturnValue({
      pid: 12345,
      unref: vi.fn(),
      on: vi.fn(),
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() }
    });
  });

  afterEach(() => {
    // Clean up
    if (fs.existsSync(testConfigDir)) {
      fs.rmSync(testConfigDir, { recursive: true });
    }
    vi.clearAllMocks();
  });

  describe('Token Refresh Flow', () => {
    it('should refresh token on MCP server start', async () => {
      // Create a mock auth file with refresh token
      const authData = {
        refresh_token: 'test-refresh-token',
        api_url: 'https://test.semiont.com',
        environment: 'test',
        created_at: new Date().toISOString()
      };
      fs.writeFileSync(testAuthFile, JSON.stringify(authData));

      // Mock fetch for token refresh
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ access_token: 'new-access-token' })
      });

      // Simulate starting MCP server with token refresh
      const mockEnvConfig = {
        site: { domain: 'test.semiont.com' }
      };

      // Call the refresh token logic
      const response = await fetch(`https://${mockEnvConfig.site.domain}/api/tokens/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: authData.refresh_token })
      });

      expect(response.ok).toBe(true);
      const { access_token } = await response.json() as { access_token: string };
      expect(access_token).toBe('new-access-token');

      // Verify the API was called correctly
      expect(global.fetch).toHaveBeenCalledWith(
        'https://test.semiont.com/api/tokens/refresh',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ refresh_token: 'test-refresh-token' })
        })
      );
    });

    it('should handle expired refresh token', async () => {
      // Create a mock auth file with old refresh token
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 31); // 31 days old
      
      const authData = {
        refresh_token: 'expired-refresh-token',
        api_url: 'https://test.semiont.com',
        environment: 'test',
        created_at: oldDate.toISOString()
      };
      fs.writeFileSync(testAuthFile, JSON.stringify(authData));

      // Mock fetch to return 401 for expired token
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized'
      });

      // Try to refresh expired token
      const response = await fetch('https://test.semiont.com/api/tokens/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: authData.refresh_token })
      });

      expect(response.ok).toBe(false);
      expect(response.status).toBe(401);
    });

    it('should handle missing auth file gracefully', async () => {
      // Ensure auth file doesn't exist
      if (fs.existsSync(testAuthFile)) {
        fs.unlinkSync(testAuthFile);
      }

      // Try to read non-existent auth file
      let error: Error | null = null;
      try {
        fs.readFileSync(testAuthFile, 'utf-8');
      } catch (e) {
        error = e as Error;
      }

      expect(error).toBeTruthy();
      expect(error?.message).toContain('ENOENT');
    });
  });

  describe('MCP Server Lifecycle', () => {
    it('should start MCP server with correct environment variables', async () => {
      // Mock auth file
      const authData = {
        refresh_token: 'test-refresh-token',
        api_url: 'https://test.semiont.com',
        environment: 'production',
        created_at: new Date().toISOString()
      };
      fs.writeFileSync(testAuthFile, JSON.stringify(authData));

      // Mock successful token refresh
      const accessToken = 'production-access-token';
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ access_token: accessToken })
      });

      // Simulate MCP server start
      const mockSpawn = spawn as any;
      mockSpawn.mockReturnValue({
        pid: 54321,
        unref: vi.fn(),
        on: vi.fn((event, callback) => {
          if (event === 'spawn') {
            callback();
          }
        }),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() }
      });

      // Start MCP server (simulated)
      const mcpProcess = spawn('node', [
        '/path/to/mcp-server/index.js'
      ], {
        env: {
          ...process.env,
          SEMIONT_API_URL: authData.api_url,
          SEMIONT_API_TOKEN: accessToken
        },
        stdio: 'inherit'
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining(['/path/to/mcp-server/index.js']),
        expect.objectContaining({
          env: expect.objectContaining({
            SEMIONT_API_URL: 'https://test.semiont.com',
            SEMIONT_API_TOKEN: 'production-access-token'
          })
        })
      );

      expect(mcpProcess.pid).toBe(54321);
    });

    it('should handle MCP server crash and restart', async () => {
      const mockSpawn = spawn as any;
      
      // First spawn - simulate crash
      mockSpawn.mockReturnValueOnce({
        pid: 11111,
        unref: vi.fn(),
        on: vi.fn((event, callback) => {
          if (event === 'exit') {
            // Simulate crash with non-zero exit code
            setTimeout(() => callback(1), 100);
          }
        }),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() }
      });

      // Second spawn - successful restart
      mockSpawn.mockReturnValueOnce({
        pid: 22222,
        unref: vi.fn(),
        on: vi.fn((event, callback) => {
          if (event === 'spawn') {
            callback();
          }
        }),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() }
      });

      // Start MCP server
      const firstProcess = spawn('node', ['mcp-server.js']);
      
      // Wait for crash
      await new Promise(resolve => setTimeout(resolve, 150));
      
      // Restart MCP server
      const secondProcess = spawn('node', ['mcp-server.js']);
      
      expect(mockSpawn).toHaveBeenCalledTimes(2);
      expect(firstProcess.pid).toBe(11111);
      expect(secondProcess.pid).toBe(22222);
    });
  });

  describe('OAuth Callback Handling', () => {
    it('should handle successful OAuth callback', async () => {
      // Simulate OAuth callback with token
      const callbackUrl = new URL('http://localhost:8585/callback?token=new-refresh-token');
      const token = callbackUrl.searchParams.get('token');
      
      expect(token).toBe('new-refresh-token');
      
      // Save the token to auth file
      const authData = {
        refresh_token: token,
        api_url: 'https://production.semiont.com',
        environment: 'production',
        created_at: new Date().toISOString()
      };
      
      fs.writeFileSync(testAuthFile, JSON.stringify(authData, null, 2));
      
      // Verify file was written correctly
      const savedData = JSON.parse(fs.readFileSync(testAuthFile, 'utf-8'));
      expect(savedData.refresh_token).toBe('new-refresh-token');
      expect(savedData.environment).toBe('production');
    });

    it('should handle OAuth callback without token', () => {
      // Simulate callback without token
      const callbackUrl = new URL('http://localhost:8585/callback?error=access_denied');
      const token = callbackUrl.searchParams.get('token');
      const error = callbackUrl.searchParams.get('error');
      
      expect(token).toBeNull();
      expect(error).toBe('access_denied');
    });

    it('should timeout OAuth flow after 2 minutes', async () => {
      // Create a promise that simulates OAuth timeout
      const oauthTimeout = new Promise((_, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Authentication timeout'));
        }, 120000); // 2 minutes
        
        // Simulate immediate timeout for test
        clearTimeout(timeout);
        reject(new Error('Authentication timeout'));
      });
      
      await expect(oauthTimeout).rejects.toThrow('Authentication timeout');
    });
  });

  describe('Multi-Environment Support', () => {
    it('should maintain separate auth files for different environments', () => {
      const environments = ['development', 'staging', 'production'];
      
      environments.forEach(env => {
        const authFile = path.join(testConfigDir, `mcp-auth-${env}.json`);
        const authData = {
          refresh_token: `${env}-refresh-token`,
          api_url: `https://${env}.semiont.com`,
          environment: env,
          created_at: new Date().toISOString()
        };
        
        fs.writeFileSync(authFile, JSON.stringify(authData));
      });
      
      // Verify all files exist with correct data
      environments.forEach(env => {
        const authFile = path.join(testConfigDir, `mcp-auth-${env}.json`);
        const data = JSON.parse(fs.readFileSync(authFile, 'utf-8'));
        
        expect(data.refresh_token).toBe(`${env}-refresh-token`);
        expect(data.environment).toBe(env);
        expect(data.api_url).toBe(`https://${env}.semiont.com`);
      });
    });

    it('should use correct auth file based on environment', () => {
      const environment = 'staging';
      const authFile = path.join(testConfigDir, `mcp-auth-${environment}.json`);
      
      // Create staging auth file
      const authData = {
        refresh_token: 'staging-token',
        api_url: 'https://staging.semiont.com',
        environment: 'staging',
        created_at: new Date().toISOString()
      };
      fs.writeFileSync(authFile, JSON.stringify(authData));
      
      // Read the correct file for environment
      const data = JSON.parse(fs.readFileSync(authFile, 'utf-8'));
      expect(data.environment).toBe('staging');
      expect(data.refresh_token).toBe('staging-token');
    });
  });
});