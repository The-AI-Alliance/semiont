/**
 * Generate Document Stream Route - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - Validates request body with validateRequestBody middleware
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 * - SSE streaming response (no response validation per SSE-VALIDATION-CONSIDERATIONS.md)
 */

import { streamSSE } from 'hono/streaming';
import { HTTPException } from 'hono/http-exception';
import type { AnnotationsRouterType } from '../shared';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/api-client';
import { getGraphDatabase } from '../../../graph/factory';

type GenerateDocumentStreamRequest = components['schemas']['GenerateDocumentStreamRequest'];

// Job state storage (in-memory for now)
const jobs = new Map<string, {
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: number;
  documentId?: string;
  error?: string;
}>();

export function registerGenerateDocumentStream(router: AnnotationsRouterType) {
  /**
   * POST /api/annotations/:id/generate-document-stream
   *
   * Generate a document from an annotation with streaming progress updates
   * Requires authentication
   * Validates request body against GenerateDocumentStreamRequest schema
   * Returns SSE stream with progress updates
   */
  router.post('/api/annotations/:id/generate-document-stream',
    validateRequestBody('GenerateDocumentStreamRequest'),
    async (c) => {
      const { id } = c.req.param();
      const body = c.get('validatedBody') as GenerateDocumentStreamRequest;
      const user = c.get('user');

      // Verify annotation exists
      const graphDb = await getGraphDatabase();
      const annotation = await graphDb.getAnnotation(id);
      if (!annotation) {
        throw new HTTPException(404, { message: 'Annotation not found' });
      }

      // Create job
      const jobId = `job-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      jobs.set(jobId, {
        status: 'pending',
        progress: 0,
      });

      // Start async generation (don't await - let it run in background)
      generateDocumentAsync(jobId, id, body, user.id).catch(error => {
        console.error('[GenerateDocumentStream] Job failed:', error);
        const job = jobs.get(jobId);
        if (job) {
          job.status = 'failed';
          job.error = error.message || 'Unknown error';
        }
      });

      // Stream progress updates
      return streamSSE(c, async (stream) => {
        let lastProgress = 0;
        const pollInterval = setInterval(async () => {
          const job = jobs.get(jobId);
          if (!job) {
            clearInterval(pollInterval);
            await stream.writeSSE({
              data: JSON.stringify({ error: 'Job not found' }),
              event: 'error',
            });
            await stream.close();
            return;
          }

          // Send progress update if changed
          if (job.progress !== lastProgress) {
            await stream.writeSSE({
              data: JSON.stringify({
                jobId,
                status: job.status,
                progress: job.progress,
              }),
              event: 'progress',
            });
            lastProgress = job.progress;
          }

          // Send completion event
          if (job.status === 'completed') {
            clearInterval(pollInterval);
            await stream.writeSSE({
              data: JSON.stringify({
                jobId,
                documentId: job.documentId,
              }),
              event: 'completed',
            });
            await stream.close();
            jobs.delete(jobId);
            return;
          }

          // Send error event
          if (job.status === 'failed') {
            clearInterval(pollInterval);
            await stream.writeSSE({
              data: JSON.stringify({
                jobId,
                error: job.error || 'Unknown error',
              }),
              event: 'error',
            });
            await stream.close();
            jobs.delete(jobId);
            return;
          }
        }, 500); // Poll every 500ms

        // Cleanup on connection close
        stream.onAbort(() => {
          clearInterval(pollInterval);
        });
      });
    }
  );
}

/**
 * Background job to generate document from annotation
 */
async function generateDocumentAsync(
  jobId: string,
  annotationId: string,
  request: GenerateDocumentStreamRequest,
  _userId: string
): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;

  try {
    job.status = 'running';
    job.progress = 10;

    const graphDb = await getGraphDatabase();

    // Get annotation
    const annotation = await graphDb.getAnnotation(annotationId);
    if (!annotation) {
      throw new Error('Annotation not found');
    }
    job.progress = 20;

    // Get source document for context
    const sourceDoc = await graphDb.getDocument(request.documentId);
    if (!sourceDoc) {
      throw new Error('Source document not found');
    }
    job.progress = 30;

    // Here would be LLM generation logic
    // For now, simulate with delays
    await new Promise(resolve => setTimeout(resolve, 1000));
    job.progress = 50;

    await new Promise(resolve => setTimeout(resolve, 1000));
    job.progress = 70;

    // Create generated document
    const generatedDocId = `doc-generated-${Date.now()}`;

    job.progress = 90;

    // Save document (simplified - real implementation would use document creation flow)
    // This would normally go through the create document route
    // In production, would use _content to create the document
    job.progress = 100;
    job.status = 'completed';
    job.documentId = generatedDocId;

  } catch (error) {
    console.error('[generateDocumentAsync] Error:', error);
    job.status = 'failed';
    job.error = error instanceof Error ? error.message : 'Unknown error';
  }
}
