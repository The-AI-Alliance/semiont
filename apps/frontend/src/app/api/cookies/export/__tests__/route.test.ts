import { server } from '@/mocks/server.js'
import { http, HttpResponse } from 'msw'

describe('/api/cookies/export', () => {
  describe('GET /api/cookies/export', () => {
    it('should export cookie data for authenticated user', async () => {
      // Make request with auth header
      const response = await fetch('http://localhost:3001/api/cookies/export', {
        headers: {
          'Authorization': 'Bearer mock-token'
        }
      });

      expect(response.status).toBe(200);
      
      // Check headers for file download
      expect(response.headers.get('Content-Type')).toBe('application/json');
      expect(response.headers.get('Content-Disposition')).toMatch(/attachment; filename="cookie-data-export-\d+\.json"/);
      
      // Check response body
      const text = await response.text();
      const data = JSON.parse(text);
      
      expect(data).toMatchObject({
        exportDate: expect.any(String),
        userId: 'user123',
        consent: expect.objectContaining({
          necessary: true,
          analytics: false,
          marketing: false,
          preferences: true
        }),
        userRights: expect.arrayContaining([
          expect.stringContaining('access'),
          expect.stringContaining('correct'),
          expect.stringContaining('delete'),
          expect.stringContaining('portability')
        ])
      });
    });

    it('should return 401 for unauthenticated user', async () => {
      // Make request without auth header
      const response = await fetch('http://localhost:3001/api/cookies/export');
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.success).toBe(false);
      expect(data.error).toBe('Unauthorized');
    });

    it('should handle server errors gracefully', async () => {
      // Override handler to return error
      server.use(
        http.get('*/api/cookies/export', () => {
          return HttpResponse.json(
            { success: false, error: 'Internal server error' },
            { status: 500 }
          );
        })
      );

      const response = await fetch('http://localhost:3001/api/cookies/export', {
        headers: {
          'Authorization': 'Bearer mock-token'
        }
      });
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toBe('Internal server error');
    });

    it('should include proper data retention policy', async () => {
      const response = await fetch('http://localhost:3001/api/cookies/export', {
        headers: {
          'Authorization': 'Bearer mock-token'
        }
      });

      const text = await response.text();
      const data = JSON.parse(text);

      expect(data.dataRetentionPolicy).toContain('2 years');
      expect(data.dataRetentionPolicy).toContain('retained');
      expect(data.dataRetentionPolicy).toContain('withdrawn');
    });

    it('should generate unique filenames', async () => {
      // Make two requests
      const response1 = await fetch('http://localhost:3001/api/cookies/export', {
        headers: { 'Authorization': 'Bearer mock-token' }
      });
      
      // Wait a bit to ensure different timestamp
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const response2 = await fetch('http://localhost:3001/api/cookies/export', {
        headers: { 'Authorization': 'Bearer mock-token' }
      });

      const filename1 = response1.headers.get('Content-Disposition');
      const filename2 = response2.headers.get('Content-Disposition');

      expect(filename1).not.toBe(filename2);
      expect(filename1).toMatch(/cookie-data-export-\d+\.json/);
      expect(filename2).toMatch(/cookie-data-export-\d+\.json/);
    });

    it('should format export data as pretty JSON', async () => {
      const response = await fetch('http://localhost:3001/api/cookies/export', {
        headers: {
          'Authorization': 'Bearer mock-token'
        }
      });

      const responseText = await response.text();

      // Check that JSON is formatted with indentation
      expect(responseText).toContain('  '); // Should have spaces for indentation
      expect(responseText).toContain('\n'); // Should have newlines
      
      // Verify it's valid JSON
      expect(() => JSON.parse(responseText)).not.toThrow();
    });

    it('should include timestamp in ISO format', async () => {
      const response = await fetch('http://localhost:3001/api/cookies/export', {
        headers: {
          'Authorization': 'Bearer mock-token'
        }
      });

      const text = await response.text();
      const data = JSON.parse(text);

      // Check ISO format (should be parseable by Date constructor)
      expect(() => new Date(data.exportDate)).not.toThrow();
      expect(() => new Date(data.consent.timestamp)).not.toThrow();
      
      // Check format matches ISO string pattern
      expect(data.exportDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
    });

    it('should handle network errors gracefully', async () => {
      // Override handler to simulate network error
      server.use(
        http.get('*/api/cookies/export', () => {
          return HttpResponse.error();
        })
      );

      await expect(
        fetch('http://localhost:3001/api/cookies/export', {
          headers: { 'Authorization': 'Bearer mock-token' }
        })
      ).rejects.toThrow();
    });
  });
});