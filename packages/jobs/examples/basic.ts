/**
 * Basic Job Queue Example - Custom Job Types
 *
 * This example demonstrates:
 * - Defining custom job types using discriminated unions
 * - Creating jobs with type-safe parameters
 * - Implementing a worker with custom job handling
 * - Processing jobs with progress tracking
 *
 * NOTE: This shows how to extend the job system with your own job types.
 * The built-in job types (DetectionJob, GenerationJob, etc.) follow the same pattern.
 */

import { JobQueue, JobWorker, getJobQueue, initializeJobQueue } from '@semiont/jobs';
import type { JobMetadata, PendingJob, RunningJob, CompleteJob } from '@semiont/jobs';
import { nanoid } from 'nanoid';

// ============================================================================
// Define Custom Job Type - Following the Discriminated Union Pattern
// ============================================================================

// 1. Define custom job parameters (what work to do)
interface DataProcessingParams {
  itemCount: number;
  items: string[];
  batchSize: number;
}

// 2. Define custom progress type (tracking during execution)
interface DataProcessingProgress {
  percentage: number;
  message: string;
  currentItem: number;
  totalItems: number;
  successCount: number;
  errorCount: number;
}

// 3. Define custom result type (outcome of the work)
interface DataProcessingResult {
  processedCount: number;
  successCount: number;
  errorCount: number;
  duration: number;
}

// 4. Create discriminated union for all states of this job type
// Note: In production, you would add this to the AnyJob union in types.ts
type DataProcessingJob =
  | PendingJob<DataProcessingParams>
  | RunningJob<DataProcessingParams, DataProcessingProgress>
  | CompleteJob<DataProcessingParams, DataProcessingResult>;

// ============================================================================
// Custom Worker Implementation
// ============================================================================

class DataProcessingWorker extends JobWorker {
  protected getWorkerName(): string {
    return 'DataProcessingWorker';
  }

  protected canProcessJob(job: any): boolean {
    // Check if this is our custom job type
    return job.metadata?.type === 'data-processing';
  }

  protected async executeJob(job: any): Promise<void> {
    // Type guard: ensure job is running
    if (job.status !== 'running') {
      throw new Error('Job must be in running state');
    }

    const dataJob = job as RunningJob<DataProcessingParams, DataProcessingProgress>;
    const { items, batchSize } = dataJob.params;
    const total = items.length;
    const startTime = Date.now();

    console.log(`\n[DataProcessingWorker] Processing ${total} items in batches of ${batchSize}...`);

    let successCount = 0;
    let errorCount = 0;

    // Process items
    for (let i = 0; i < total; i++) {
      const item = items[i];

      try {
        await this.processItem(item);
        successCount++;
      } catch (error) {
        errorCount++;
        console.error(`  ❌ Failed item ${i + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }

      // Update progress every 5 items (immutable pattern)
      if ((i + 1) % 5 === 0 || i === total - 1) {
        const updatedJob: RunningJob<DataProcessingParams, DataProcessingProgress> = {
          ...dataJob,
          progress: {
            percentage: Math.round(((i + 1) / total) * 100),
            message: `Processing item ${i + 1} of ${total}`,
            currentItem: i + 1,
            totalItems: total,
            successCount,
            errorCount,
          },
        };

        await this.updateJobProgress(updatedJob);

        console.log(
          `  📊 Progress: ${updatedJob.progress.percentage}% (${successCount} success, ${errorCount} errors)`
        );
      }
    }

    const duration = Date.now() - startTime;
    console.log(`\n✅ Processing complete: ${successCount}/${total} items succeeded in ${duration}ms`);

    // Note: In a real implementation, you would return the result here
    // and the base class would handle the transition to CompleteJob
    // For this example, we just log it
  }

  private async processItem(item: string): Promise<void> {
    // Simulate work with random duration
    const duration = 50 + Math.random() * 150;
    await new Promise((resolve) => setTimeout(resolve, duration));

    // Simulate occasional errors (10% failure rate)
    if (Math.random() < 0.1) {
      throw new Error(`Failed to process: ${item}`);
    }
  }
}

// ============================================================================
// Helper Function to Create Custom Jobs
// ============================================================================

function createDataProcessingJob(items: string[]): PendingJob<DataProcessingParams> {
  return {
    status: 'pending',
    metadata: {
      id: `job-${nanoid()}` as any, // In production, use jobId() from @semiont/api-client
      type: 'data-processing' as any, // Custom type
      userId: `user-${Date.now()}` as any, // In production, use userId() from @semiont/core
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3,
    },
    params: {
      itemCount: items.length,
      items,
      batchSize: 10,
    },
  };
}

// ============================================================================
// Main Example
// ============================================================================

async function main() {
  console.log('🚀 @semiont/jobs - Custom Job Type Example\n');
  console.log('This example shows how to define and use custom job types');
  console.log('following the discriminated union pattern.\n');

  // 1. Initialize job queue
  await initializeJobQueue({ dataDir: './data/jobs' });
  console.log('✅ Job queue initialized\n');

  const queue = getJobQueue();

  // 2. Create a custom data processing job
  const items = Array.from({ length: 50 }, (_, i) => `item-${String(i + 1).padStart(3, '0')}`);
  const job = createDataProcessingJob(items);

  await queue.createJob(job);
  console.log(`✅ Created job: ${job.metadata.id}`);
  console.log(`   Items: ${job.params.itemCount}`);
  console.log(`   Batch size: ${job.params.batchSize}\n`);

  // 3. Check queue statistics
  const statsBefore = await queue.getStats();
  console.log('📊 Queue statistics:', statsBefore, '\n');

  // 4. Create and start worker
  const worker = new DataProcessingWorker(queue);
  console.log('🔧 Starting worker...');

  // Start worker (non-blocking)
  worker.start().catch(console.error);

  // 5. Monitor job progress
  let lastProgress = -1;
  const monitorInterval = setInterval(async () => {
    const currentJob = await queue.getJob(job.metadata.id);

    if (!currentJob) {
      console.log('⚠️  Job not found');
      clearInterval(monitorInterval);
      return;
    }

    // Type-safe progress access using discriminated union
    if (currentJob.status === 'running') {
      const progress = (currentJob as RunningJob<DataProcessingParams, DataProcessingProgress>).progress;

      if (progress.percentage !== lastProgress) {
        console.log(
          `\n📈 Job Progress: ${progress.percentage}%`,
          `\n   Status: ${progress.message}`,
          `\n   Success: ${progress.successCount}, Errors: ${progress.errorCount}`
        );
        lastProgress = progress.percentage;
      }
    }

    if (currentJob.status === 'complete' || currentJob.status === 'failed') {
      clearInterval(monitorInterval);
    }
  }, 1000);

  // 6. Wait for job completion
  await new Promise((resolve) => setTimeout(resolve, 15000)); // Max 15 seconds

  // 7. Stop worker
  console.log('\n⏹️  Stopping worker...');
  await worker.stop();

  // 8. Check final job status
  const completedJob = await queue.getJob(job.metadata.id);

  if (!completedJob) {
    console.log('⚠️  Job not found');
    return;
  }

  console.log(`\n📋 Final job status: ${completedJob.status}\n`);

  // Type-safe result access - only available on complete jobs
  if (completedJob.status === 'complete') {
    const result = (completedJob as CompleteJob<DataProcessingParams, DataProcessingResult>).result;
    console.log('✅ Result:');
    console.log(`   Processed: ${result.processedCount} items`);
    console.log(`   Success: ${result.successCount}`);
    console.log(`   Errors: ${result.errorCount}`);
    console.log(`   Duration: ${result.duration}ms`);
  }

  // Type-safe error access - only available on failed jobs
  if (completedJob.status === 'failed') {
    console.log('❌ Error:', (completedJob as any).error);
  }

  // 9. Clean up old jobs
  const deleted = await queue.cleanupOldJobs(24); // 24 hour retention
  console.log(`\n🧹 Cleaned up ${deleted} old jobs`);

  const statsAfter = await queue.getStats();
  console.log('📊 Final queue statistics:', statsAfter);

  console.log('\n✨ Example complete\n');
  console.log('Key Takeaways:');
  console.log('  • Custom job types follow the same discriminated union pattern');
  console.log('  • Separate Params, Progress, and Result interfaces');
  console.log('  • Type guards enable safe access to status-specific fields');
  console.log('  • Immutable pattern for progress updates');
  console.log('  • TypeScript prevents invalid state access at compile time');
}

main().catch(console.error);
