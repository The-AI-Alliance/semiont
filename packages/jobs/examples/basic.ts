/**
 * Basic Job Queue Example
 *
 * This example demonstrates:
 * - Creating a job queue
 * - Creating jobs
 * - Implementing a worker
 * - Processing jobs with progress tracking
 */

import { JobQueue, JobWorker } from '@semiont/jobs';
import type { Job } from '@semiont/jobs';

// Define a custom job type
interface DataProcessingJob extends Job {
  type: 'data-processing';
  itemCount: number;
  items: string[];
}

// Implement a custom worker
class DataProcessingWorker extends JobWorker {
  getWorkerName(): string {
    return 'data-processor';
  }

  canProcessJob(job: Job): boolean {
    return job.type === 'data-processing';
  }

  async executeJob(job: DataProcessingJob): Promise<void> {
    const { items } = job;
    const total = items.length;

    console.log(`Processing ${total} items...`);

    for (let i = 0; i < total; i++) {
      // Simulate processing
      await this.processItem(items[i]);

      // Update progress
      await this.updateJobProgress({
        percentage: Math.round((i + 1) / total * 100),
        message: `Processing item ${i + 1} of ${total}`,
        currentItem: i + 1,
        totalItems: total
      });

      // Log progress
      if ((i + 1) % 10 === 0) {
        console.log(`  Processed ${i + 1}/${total} items`);
      }
    }

    console.log('✅ All items processed');
  }

  private async processItem(item: string): Promise<void> {
    // Simulate work
    await new Promise(resolve => setTimeout(resolve, 100));

    // Simulate occasional errors (for retry demonstration)
    if (Math.random() < 0.1) {
      throw new Error(`Failed to process item: ${item}`);
    }
  }
}

async function main() {
  // 1. Initialize job queue
  const queue = new JobQueue({
    dataDir: './data/jobs',
    maxRetries: 3,
    retentionPeriod: 24 * 60 * 60 * 1000
  });

  await queue.initialize();
  console.log('✅ Job queue initialized');

  // 2. Create a job
  const items = Array.from({ length: 50 }, (_, i) => `item-${i + 1}`);

  const job = await queue.createJob<DataProcessingJob>({
    type: 'data-processing',
    userId: 'user-123',
    itemCount: items.length,
    items,
    maxRetries: 3
  });

  console.log(`✅ Created job: ${job.id}`);

  // 3. Check queue statistics
  const statsBefore = await queue.getStats();
  console.log('\n📊 Queue statistics:', statsBefore);

  // 4. Create and start worker
  const worker = new DataProcessingWorker({
    queue,
    pollInterval: 500,  // Check every 500ms
    errorBackoff: 2000  // Back off 2s on errors
  });

  console.log('\n🚀 Starting worker...');

  // Start worker (non-blocking)
  const workerPromise = worker.start();

  // 5. Monitor job progress
  let lastProgress = 0;
  const monitorInterval = setInterval(async () => {
    const currentJob = await queue.getJob(job.id);
    if (currentJob) {
      const progress = currentJob.progress?.percentage || 0;
      if (progress !== lastProgress) {
        console.log(`📈 Progress: ${progress}% - ${currentJob.progress?.message || ''}`);
        lastProgress = progress;
      }

      if (currentJob.status === 'complete' || currentJob.status === 'failed') {
        clearInterval(monitorInterval);
      }
    }
  }, 1000);

  // 6. Wait for job completion
  await new Promise(resolve => setTimeout(resolve, 10000)); // Max 10 seconds

  // 7. Stop worker
  console.log('\n⏹️ Stopping worker...');
  await worker.stop();

  // 8. Check final job status
  const completedJob = await queue.getJob(job.id);
  console.log(`\n📋 Final job status: ${completedJob?.status}`);

  if (completedJob?.result) {
    console.log('Result:', completedJob.result);
  }

  if (completedJob?.error) {
    console.log('Error:', completedJob.error);
  }

  // 9. Clean up old jobs
  await queue.cleanupOldJobs();

  const statsAfter = await queue.getStats();
  console.log('\n📊 Final queue statistics:', statsAfter);

  console.log('\n✨ Example complete');
}

main().catch(console.error);