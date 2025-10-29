/**
 * Simple unit tests for API resourceation endpoint
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';

interface ApiDocResponse {
  name: string;
  version: string;
  description: string;
  endpoints: {
    public: unknown;
    [key: string]: unknown;
  };
}

describe('API Resourceation Endpoint Unit Tests', () => {
  let app: Hono;

  beforeEach(() => {
    app = new Hono();
    
    // Add the API resourceation endpoint
    app.get('/api', (c) => {
      const acceptHeader = c.req.header('Accept') || '';
      const userAgent = c.req.header('User-Agent') || '';
      
      // Simple logic test - if browser request, return HTML indicator
      if (acceptHeader.includes('text/html') || userAgent.includes('Mozilla')) {
        return c.html('<html><title>API Docs</title></html>');
      }
      
      // For API clients, return JSON
      return c.json({
        name: "Semiont API",
        version: "0.1.0",
        description: "REST API for the Semiont Semantic Knowledge Platform",
        endpoints: {
          public: {
            "GET /api": {
              description: "This API resourceation",
              response: "API resourceation object"
            }
          }
        }
      });
    });
  });

  it('should return JSON resourceation for API clients', async () => {
    const req = new Request('http://localhost/api', {
      headers: { 'Accept': 'application/json' }
    });
    
    const res = await app.fetch(req);
    const data = await res.json() as ApiDocResponse;
    
    expect(res.status).toBe(200);
    expect(data.name).toBe('Semiont API');
    expect(data.version).toBe('0.1.0');
    expect(data.description).toContain('Semiont Semantic Knowledge Platform');
    expect(data.endpoints).toBeDefined();
    expect(data.endpoints.public).toBeDefined();
  });

  it('should return HTML resourceation for browser requests', async () => {
    const req = new Request('http://localhost/api', {
      headers: { 
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (compatible browser)'
      }
    });
    
    const res = await app.fetch(req);
    const html = await res.text();
    
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('<html>');
    expect(html).toContain('<title>API Docs</title>');
  });

  it('should handle requests without specific Accept header', async () => {
    const req = new Request('http://localhost/api');
    
    const res = await app.fetch(req);
    const data = await res.json() as ApiDocResponse;
    
    expect(res.status).toBe(200);
    expect(data.name).toBe('Semiont API');
  });

  it('should detect Mozilla user agent and return HTML', async () => {
    const req = new Request('http://localhost/api', {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    const res = await app.fetch(req);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('<html>');
  });

  it('should provide comprehensive API endpoint information', async () => {
    const req = new Request('http://localhost/api', {
      headers: { 'Accept': 'application/json' }
    });
    
    const res = await app.fetch(req);
    const data = await res.json() as ApiDocResponse;
    
    // Verify structure of resourceation
    expect(data).toHaveProperty('name');
    expect(data).toHaveProperty('version');
    expect(data).toHaveProperty('description');
    expect(data).toHaveProperty('endpoints');
    
    // Verify endpoints structure
    expect(data.endpoints).toHaveProperty('public');
    expect(data.endpoints.public).toHaveProperty('GET /api');
  });
});