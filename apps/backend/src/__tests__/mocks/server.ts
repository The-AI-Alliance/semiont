/**
 * MSW server setup for backend tests
 */

import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { beforeAll, afterEach, afterAll } from 'vitest';

// Mock handlers for external services
export const handlers = [
  // Mock Docker/Podman info endpoint (used by Testcontainers)
  http.get('http://localhost/info', () => {
    return HttpResponse.json({
      ID: 'mock-docker-engine',
      Containers: 0,
      ContainersRunning: 0,
      ContainersPaused: 0,
      ContainersStopped: 0,
      Images: 1,
      ServerVersion: '20.10.0',
      KernelVersion: '5.4.0',
      OperatingSystem: 'Mock OS',
      Architecture: 'x86_64'
    });
  }),

  // Mock Docker image inspection endpoint  
  http.get('http://localhost/images/:imageName/json', () => {
    return HttpResponse.json({
      Id: 'sha256:mock-image-id',
      RepoTags: ['postgres:15-alpine'],
      Config: {
        ExposedPorts: {
          '5432/tcp': {}
        }
      }
    });
  }),

  // Mock Google OAuth userinfo endpoint (v2)
  http.get('https://www.googleapis.com/oauth2/v2/userinfo', ({ request }) => {
    const url = new URL(request.url);
    const accessToken = url.searchParams.get('access_token');
    
    if (accessToken === 'invalid-token') {
      return new HttpResponse(null, { status: 401 });
    }
    
    if (accessToken === 'unverified-token' || accessToken === 'unverified-email-token') {
      return HttpResponse.json({
        id: 'google-456',
        email: 'unverified@example.com',
        verified_email: false,
        name: 'Unverified User',
        given_name: 'Unverified',
        family_name: 'User',
        picture: 'https://example.com/photo.jpg',
        locale: 'en'
      });
    }
    
    return HttpResponse.json({
      id: 'google-123',
      email: 'test@example.com',
      verified_email: true,
      name: 'Test User',
      given_name: 'Test',
      family_name: 'User',
      picture: 'https://example.com/photo.jpg',
      locale: 'en'
    });
  }),

  // Mock Google token endpoint
  http.post('https://oauth2.googleapis.com/token', () => {
    return HttpResponse.json({
      access_token: 'mock-access-token',
      token_type: 'Bearer',
      expires_in: 3599,
      refresh_token: 'mock-refresh-token',
      scope: 'openid email profile'
    });
  }),
];

export const server = setupServer(...handlers);

// Start server before all tests
export function setupMSW() {
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());
}