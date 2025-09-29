import { describe, it, expect, beforeEach, vi } from 'vitest';
import { apiService } from '../api-client';

describe('API Client', () => {
  describe('Document Operations', () => {
    beforeEach(() => {
      // Mock fetch globally
      global.fetch = vi.fn();
    });

    it('should use PATCH method for document updates', async () => {
      const mockResponse = {
        ok: true,
        headers: new Headers(),
        json: async () => ({
          success: true,
          document: { id: 'test-id', name: 'Test Doc', entityTypes: ['person'] }
        }),
      };

      (global.fetch as any).mockResolvedValueOnce(mockResponse);

      const result = await apiService.documents.update('test-id', {
        entityTypes: ['person', 'organization'],
      });

      // Verify fetch was called with PATCH method
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/documents/test-id'),
        expect.objectContaining({
          method: 'PATCH',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({
            entityTypes: ['person', 'organization'],
          }),
        })
      );

      expect(result.document.id).toBe('test-id');
    });

    it('should handle document update errors properly', async () => {
      const mockResponse = {
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ error: 'Document not found' }),
      };

      (global.fetch as any).mockResolvedValueOnce(mockResponse);

      await expect(
        apiService.documents.update('invalid-id', {
          entityTypes: ['person'],
        })
      ).rejects.toThrow('API Error: 404');
    });

    it('should properly construct URL with document ID', async () => {
      const mockResponse = {
        ok: true,
        headers: new Headers(),
        json: async () => ({ success: true, document: {} }),
      };

      (global.fetch as any).mockResolvedValueOnce(mockResponse);

      await apiService.documents.update('doc-123-456', {
        archived: true,
      });

      // Verify the URL was constructed correctly
      const calledUrl = (global.fetch as any).mock.calls[0][0];
      expect(calledUrl).toContain('/api/documents/doc-123-456');
      expect(calledUrl).not.toContain(':id');
    });

    it('should support all update fields', async () => {
      const mockResponse = {
        ok: true,
        headers: new Headers(),
        json: async () => ({ success: true, document: {} }),
      };

      (global.fetch as any).mockResolvedValueOnce(mockResponse);

      const updateData = {
        name: 'Updated Name',
        entityTypes: ['person', 'organization'],
        metadata: { key: 'value' },
        archived: true,
      };

      await apiService.documents.update('test-id', updateData);

      // Verify all fields were sent in the body
      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify(updateData),
        })
      );
    });
  });

  describe('API Method Consistency', () => {
    it('should use consistent HTTP methods across operations', () => {
      // This test documents the expected HTTP methods for each operation
      const methodExpectations = {
        create: 'POST',
        get: 'GET',
        update: 'PATCH', // NOT PUT - this was the bug!
        delete: 'DELETE',
        list: 'GET',
        search: 'GET',
      };

      // These tests ensure we don't accidentally change methods
      expect(apiService.documents.create.toString()).toContain('post');
      expect(apiService.documents.get.toString()).toContain('get');
      expect(apiService.documents.update.toString()).toContain('patch');
      expect(apiService.documents.delete.toString()).toContain('delete');
      expect(apiService.documents.list.toString()).toContain('get');
      expect(apiService.documents.search.toString()).toContain('get');
    });
  });
});