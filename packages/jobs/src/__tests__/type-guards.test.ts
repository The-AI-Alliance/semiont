/**
 * Unit tests for job type guards
 */

import { describe, test, expect } from 'vitest';
import {
  isPendingJob,
  isRunningJob,
  isCompleteJob,
  isFailedJob,
  isCancelledJob,
  type PendingJob,
  type RunningJob,
  type CompleteJob,
  type FailedJob,
  type CancelledJob,
  type DetectionParams,
  type DetectionProgress,
  type DetectionResult,
} from '../types';
import { jobId, entityType, userId, resourceId } from '@semiont/core';

// Helper functions to create test jobs
function createPendingJob(): PendingJob<DetectionParams> {
  return {
    status: 'pending',
    metadata: {
      id: jobId('test-pending'),
      type: 'reference-annotation',
      userId: userId('user-1'),
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3,
    },
    params: {
      resourceId: resourceId('res-1'),
      entityTypes: [entityType('Person')],
    },
  };
}

function createRunningJob(): RunningJob<DetectionParams, DetectionProgress> {
  return {
    status: 'running',
    metadata: {
      id: jobId('test-running'),
      type: 'reference-annotation',
      userId: userId('user-1'),
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3,
    },
    params: {
      resourceId: resourceId('res-1'),
      entityTypes: [entityType('Person')],
    },
    startedAt: new Date().toISOString(),
    progress: {
      totalEntityTypes: 1,
      processedEntityTypes: 0,
      entitiesFound: 0,
      entitiesEmitted: 0,
    },
  };
}

function createCompleteJob(): CompleteJob<DetectionParams, DetectionResult> {
  return {
    status: 'complete',
    metadata: {
      id: jobId('test-complete'),
      type: 'reference-annotation',
      userId: userId('user-1'),
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3,
    },
    params: {
      resourceId: resourceId('res-1'),
      entityTypes: [entityType('Person')],
    },
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    result: {
      totalFound: 5,
      totalEmitted: 5,
      errors: 0,
    },
  };
}

function createFailedJob(): FailedJob<DetectionParams> {
  return {
    status: 'failed',
    metadata: {
      id: jobId('test-failed'),
      type: 'reference-annotation',
      userId: userId('user-1'),
      created: new Date().toISOString(),
      retryCount: 3,
      maxRetries: 3,
    },
    params: {
      resourceId: resourceId('res-1'),
      entityTypes: [entityType('Person')],
    },
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    error: 'Test error message',
  };
}

function createCancelledJob(): CancelledJob<DetectionParams> {
  return {
    status: 'cancelled',
    metadata: {
      id: jobId('test-cancelled'),
      type: 'reference-annotation',
      userId: userId('user-1'),
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3,
    },
    params: {
      resourceId: resourceId('res-1'),
      entityTypes: [entityType('Person')],
    },
    completedAt: new Date().toISOString(),
  };
}

describe('Job Type Guards', () => {
  describe('isPendingJob()', () => {
    test('should return true for pending job', () => {
      const job = createPendingJob();
      expect(isPendingJob(job)).toBe(true);
    });

    test('should return false for running job', () => {
      const job = createRunningJob();
      expect(isPendingJob(job)).toBe(false);
    });

    test('should return false for complete job', () => {
      const job = createCompleteJob();
      expect(isPendingJob(job)).toBe(false);
    });

    test('should return false for failed job', () => {
      const job = createFailedJob();
      expect(isPendingJob(job)).toBe(false);
    });

    test('should return false for cancelled job', () => {
      const job = createCancelledJob();
      expect(isPendingJob(job)).toBe(false);
    });

    test('should narrow type to PendingJob', () => {
      const job = createPendingJob();

      if (isPendingJob(job)) {
        // TypeScript should know this is a PendingJob
        expect(job.status).toBe('pending');
        expect(job.params).toBeDefined();
        // These fields should NOT exist on PendingJob
        expect((job as any).startedAt).toBeUndefined();
        expect((job as any).progress).toBeUndefined();
        expect((job as any).result).toBeUndefined();
        expect((job as any).error).toBeUndefined();
      }
    });
  });

  describe('isRunningJob()', () => {
    test('should return true for running job', () => {
      const job = createRunningJob();
      expect(isRunningJob(job)).toBe(true);
    });

    test('should return false for pending job', () => {
      const job = createPendingJob();
      expect(isRunningJob(job)).toBe(false);
    });

    test('should return false for complete job', () => {
      const job = createCompleteJob();
      expect(isRunningJob(job)).toBe(false);
    });

    test('should narrow type to RunningJob', () => {
      const job = createRunningJob();

      if (isRunningJob(job)) {
        // TypeScript should know this is a RunningJob
        expect(job.status).toBe('running');
        expect(job.startedAt).toBeDefined();
        expect(job.progress).toBeDefined();
        // These fields should NOT exist on RunningJob
        expect((job as any).completedAt).toBeUndefined();
        expect((job as any).result).toBeUndefined();
        expect((job as any).error).toBeUndefined();
      }
    });
  });

  describe('isCompleteJob()', () => {
    test('should return true for complete job', () => {
      const job = createCompleteJob();
      expect(isCompleteJob(job)).toBe(true);
    });

    test('should return false for pending job', () => {
      const job = createPendingJob();
      expect(isCompleteJob(job)).toBe(false);
    });

    test('should return false for running job', () => {
      const job = createRunningJob();
      expect(isCompleteJob(job)).toBe(false);
    });

    test('should return false for failed job', () => {
      const job = createFailedJob();
      expect(isCompleteJob(job)).toBe(false);
    });

    test('should narrow type to CompleteJob', () => {
      const job = createCompleteJob();

      if (isCompleteJob(job)) {
        // TypeScript should know this is a CompleteJob
        expect(job.status).toBe('complete');
        expect(job.startedAt).toBeDefined();
        expect(job.completedAt).toBeDefined();
        expect(job.result).toBeDefined();
        // These fields should NOT exist on CompleteJob
        expect((job as any).progress).toBeUndefined();
        expect((job as any).error).toBeUndefined();
      }
    });
  });

  describe('isFailedJob()', () => {
    test('should return true for failed job', () => {
      const job = createFailedJob();
      expect(isFailedJob(job)).toBe(true);
    });

    test('should return false for pending job', () => {
      const job = createPendingJob();
      expect(isFailedJob(job)).toBe(false);
    });

    test('should return false for complete job', () => {
      const job = createCompleteJob();
      expect(isFailedJob(job)).toBe(false);
    });

    test('should narrow type to FailedJob', () => {
      const job = createFailedJob();

      if (isFailedJob(job)) {
        // TypeScript should know this is a FailedJob
        expect(job.status).toBe('failed');
        expect(job.completedAt).toBeDefined();
        expect(job.error).toBeDefined();
        expect(job.error).toBe('Test error message');
        // These fields should NOT exist on FailedJob
        expect((job as any).progress).toBeUndefined();
        expect((job as any).result).toBeUndefined();
      }
    });
  });

  describe('isCancelledJob()', () => {
    test('should return true for cancelled job', () => {
      const job = createCancelledJob();
      expect(isCancelledJob(job)).toBe(true);
    });

    test('should return false for pending job', () => {
      const job = createPendingJob();
      expect(isCancelledJob(job)).toBe(false);
    });

    test('should return false for complete job', () => {
      const job = createCompleteJob();
      expect(isCancelledJob(job)).toBe(false);
    });

    test('should return false for failed job', () => {
      const job = createFailedJob();
      expect(isCancelledJob(job)).toBe(false);
    });

    test('should narrow type to CancelledJob', () => {
      const job = createCancelledJob();

      if (isCancelledJob(job)) {
        // TypeScript should know this is a CancelledJob
        expect(job.status).toBe('cancelled');
        expect(job.completedAt).toBeDefined();
        // These fields should NOT exist on CancelledJob
        expect((job as any).progress).toBeUndefined();
        expect((job as any).result).toBeUndefined();
        expect((job as any).error).toBeUndefined();
      }
    });

    test('should handle cancelled job without startedAt', () => {
      const job = createCancelledJob();

      if (isCancelledJob(job)) {
        // Job was cancelled before it started running
        expect(job.startedAt).toBeUndefined();
      }
    });

    test('should handle cancelled job with startedAt', () => {
      const job: CancelledJob<DetectionParams> = {
        ...createCancelledJob(),
        startedAt: new Date().toISOString(),
      };

      if (isCancelledJob(job)) {
        // Job was cancelled while running
        expect(job.startedAt).toBeDefined();
      }
    });
  });

  describe('Type guard combinations', () => {
    test('should work with switch statement pattern', () => {
      const jobs = [
        createPendingJob(),
        createRunningJob(),
        createCompleteJob(),
        createFailedJob(),
        createCancelledJob(),
      ];

      for (const job of jobs) {
        switch (job.status) {
          case 'pending':
            expect(isPendingJob(job)).toBe(true);
            break;
          case 'running':
            expect(isRunningJob(job)).toBe(true);
            break;
          case 'complete':
            expect(isCompleteJob(job)).toBe(true);
            break;
          case 'failed':
            expect(isFailedJob(job)).toBe(true);
            break;
          case 'cancelled':
            expect(isCancelledJob(job)).toBe(true);
            break;
        }
      }
    });

    test('should enable exhaustive checking', () => {
      const job = createPendingJob();

      // This pattern allows TypeScript to ensure all cases are covered
      if (isPendingJob(job)) {
        expect(job.status).toBe('pending');
      } else if (isRunningJob(job)) {
        // TypeScript correctly narrows to never here because we know job is pending
        // This branch will never execute, but demonstrates exhaustive checking
        throw new Error('Unexpected: job is running');
      } else if (isCompleteJob(job)) {
        throw new Error('Unexpected: job is complete');
      } else if (isFailedJob(job)) {
        throw new Error('Unexpected: job is failed');
      } else if (isCancelledJob(job)) {
        throw new Error('Unexpected: job is cancelled');
      } else {
        // TypeScript would error here if we missed a case
        // This demonstrates exhaustive checking pattern
        throw new Error('Unexpected: unhandled job status');
      }
    });
  });
});
