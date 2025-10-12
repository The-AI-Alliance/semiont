import { createRoute, z } from '@hono/zod-openapi';
import { streamSSE } from 'hono/streaming';
import { HTTPException } from 'hono/http-exception';
import type { AnnotationsRouterType } from '../shared';
import { AnnotationQueryService } from '../../../services/annotation-queries';
import { getJobQueue } from '../../../jobs/job-queue';
import type { GenerationJob } from '../../../jobs/types';
import { nanoid } from 'nanoid';
import { getExactText, compareAnnotationIds } from '@semiont/core-types';

interface GenerationProgress {
  status: 'started' | 'fetching' | 'generating' | 'creating' | 'complete' | 'error';
  referenceId: string;
  documentName?: string;
  documentId?: string;
  sourceDocumentId?: string;
  percentage: number;
  message?: string;
}

/**
 * SSE endpoint for real-time document generation progress updates
 */
export const generateDocumentStreamRoute = createRoute({
  method: 'post',
  path: '/api/annotations/{id}/generate-document-stream',
  summary: 'Generate Document from Reference (SSE)',
  description: 'Stream real-time document generation progress via Server-Sent Events',
  tags: ['Selections', 'Documents', 'Real-time', 'AI'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().describe('Reference/annotation ID'),
    }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            documentId: z.string().describe('Document ID containing the reference'),
            title: z.string().optional().describe('Custom title for generated document'),
            prompt: z.string().optional().describe('Custom prompt for content generation'),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'SSE stream opened successfully',
      content: {
        'text/event-stream': {
          schema: z.object({
            event: z.string(),
            data: z.string(),
            id: z.string().optional(),
          }),
        },
      },
    },
    401: {
      description: 'Authentication required',
    },
    404: {
      description: 'Reference not found',
    },
  },
});

export function registerGenerateDocumentStream(router: AnnotationsRouterType) {
  router.openapi(generateDocumentStreamRoute, async (c) => {
    const { id: referenceId } = c.req.valid('param');
    const body = c.req.valid('json');

    // User will be available from auth middleware
    const user = c.get('user');
    if (!user) {
      throw new HTTPException(401, { message: 'Authentication required' });
    }

    console.log(`[GenerateDocument] Starting generation for reference ${referenceId} in document ${body.documentId}`);

    // Validate reference exists using Layer 3
    const projection = await AnnotationQueryService.getDocumentAnnotations(body.documentId);

    // Debug: log what references exist
    console.log(`[GenerateDocument] Found ${projection.references.length} references in document`);
    projection.references.forEach((r: any, i: number) => {
      console.log(`  [${i}] id: ${r.id}`);
    });

    // Compare by ID portion (handle both URI and simple ID formats)
    const reference = projection.references.find((r: any) =>
      compareAnnotationIds(r.id, referenceId)
    );

    if (!reference) {
      throw new HTTPException(404, { message: `Reference ${referenceId} not found in document ${body.documentId}` });
    }

    // Create a generation job (this decouples event emission from HTTP client)
    const jobQueue = getJobQueue();
    const job: GenerationJob = {
      id: `job-${nanoid()}`,
      type: 'generation',
      status: 'pending',
      userId: user.id,
      referenceId,
      sourceDocumentId: body.documentId,
      title: body.title,
      prompt: body.prompt,
      entityTypes: reference.body.entityTypes,
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3
    };

    await jobQueue.createJob(job);
    console.log(`[GenerateDocument] Created job ${job.id} for reference ${referenceId}`);

    // Determine document name for progress messages
    const documentName = body.title || getExactText(reference.target.selector) || 'New Document';

    // Stream the job's progress to the client
    return streamSSE(c, async (stream) => {
      try {
        // Send initial started event
        await stream.writeSSE({
          data: JSON.stringify({
            status: 'started',
            referenceId,
            documentName,
            percentage: 0,
            message: 'Starting...'
          } as GenerationProgress),
          event: 'generation-started',
          id: String(Date.now())
        });

        let lastStatus = job.status;
        let lastProgress = JSON.stringify(job.progress);

        // Poll job status and stream updates to client
        // The job worker processes independently - if client disconnects, job continues
        while (true) {
          const currentJob = await jobQueue.getJob(job.id);

          if (!currentJob) {
            throw new Error('Job was deleted');
          }

          const currentProgress = JSON.stringify(currentJob.progress);

          // Send progress updates when job state changes
          if (currentJob.status !== lastStatus || currentProgress !== lastProgress) {
            if (currentJob.status === 'running' && currentJob.type === 'generation') {
              const generationJob = currentJob as GenerationJob;
              const progress = generationJob.progress;

              if (progress) {
                // Map job progress stages to SSE status
                const statusMap: Record<typeof progress.stage, GenerationProgress['status']> = {
                  'fetching': 'fetching',
                  'generating': 'generating',
                  'creating': 'creating',
                  'linking': 'creating'
                };

                try {
                  await stream.writeSSE({
                    data: JSON.stringify({
                      status: statusMap[progress.stage],
                      referenceId,
                      documentName,
                      percentage: progress.percentage,
                      message: progress.message || `${progress.stage}...`
                    } as GenerationProgress),
                    event: 'generation-progress',
                    id: String(Date.now())
                  });
                } catch (sseError) {
                  console.warn(`[GenerateDocument] Client disconnected, but job ${job.id} will continue processing`);
                  break; // Client disconnected, stop streaming (job continues)
                }
              }
            }

            lastStatus = currentJob.status;
            lastProgress = currentProgress;
          }

          // Check if job completed
          if (currentJob.status === 'complete') {
            const result = (currentJob as GenerationJob).result;
            await stream.writeSSE({
              data: JSON.stringify({
                status: 'complete',
                referenceId,
                documentName: result?.documentName || documentName,
                documentId: result?.documentId,
                sourceDocumentId: body.documentId,
                percentage: 100,
                message: 'Draft document created! Ready for review.'
              } as GenerationProgress),
              event: 'generation-complete',
              id: String(Date.now())
            });
            break;
          }

          if (currentJob.status === 'failed') {
            await stream.writeSSE({
              data: JSON.stringify({
                status: 'error',
                referenceId,
                percentage: 0,
                message: currentJob.error || 'Generation failed'
              } as GenerationProgress),
              event: 'generation-error',
              id: String(Date.now())
            });
            break;
          }

          // Poll every 500ms
          await new Promise(resolve => setTimeout(resolve, 500));
        }

      } catch (error) {
        // Send error event
        try {
          await stream.writeSSE({
            data: JSON.stringify({
              status: 'error',
              referenceId,
              percentage: 0,
              message: error instanceof Error ? error.message : 'Generation failed'
            } as GenerationProgress),
            event: 'generation-error',
            id: String(Date.now())
          });
        } catch (sseError) {
          // Client already disconnected
          console.warn(`[GenerateDocument] Could not send error to client (disconnected), but job ${job.id} status is preserved`);
        }
      }
    });
  });
}