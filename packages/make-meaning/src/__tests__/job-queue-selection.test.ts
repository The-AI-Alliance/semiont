/**
 * Driver selection in the house shape (JOB-QUEUE-DRIVER P2): stated in
 * config, never inferred. `[services.jobs] type` picks the driver; an absent
 * section means 'fs' until P3 retires that driver and flips the default; a
 * jetstream selection without an address refuses LOUDLY at construction —
 * never a silent fallback. Placeholders are the config loader's to resolve,
 * once, at load (SECRET-DELIVERY P1).
 */
import { describe, test, expect, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { EventBus } from '@semiont/core';
import { FsJobQueue, JetStreamJobQueue } from '@semiont/jobs';
import { jobQueueFor } from '../service';

// The options each JetStream queue was built with. The real class, recording.
const built = vi.hoisted(() => [] as unknown[]);
vi.mock('@semiont/jobs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@semiont/jobs')>();
  class RecordingJetStreamJobQueue extends actual.JetStreamJobQueue {
    constructor(...args: ConstructorParameters<typeof actual.JetStreamJobQueue>) {
      super(...args);
      built.push(args[0]);
    }
  }
  return { ...actual, JetStreamJobQueue: RecordingJetStreamJobQueue };
});

// jobQueueFor now takes only the KB NAME; the fs driver builds its SemiontState
// from it, which requires XDG_STATE_HOME (no fabricated default). Point it into
// temp space so the fs cases resolve a real jobsDir.
process.env.XDG_STATE_HOME = path.join(os.tmpdir(), 'jq-select-state');

const KB = 'jq-select-kb';

const mockLogger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  child: vi.fn(() => mockLogger)
};

describe('jobQueueFor — driver selection (JOB-QUEUE-DRIVER P2)', () => {
  test("an absent [services.jobs] section selects the fs driver (today's behavior, until P3)", async () => {
    const q = jobQueueFor(undefined, KB, mockLogger, new EventBus());
    expect(q).toBeInstanceOf(FsJobQueue);
  });

  test("type 'fs' selects the fs driver explicitly", async () => {
    const q = jobQueueFor({ type: 'fs' }, KB, mockLogger, new EventBus());
    expect(q).toBeInstanceOf(FsJobQueue);
  });

  test('the fs driver without a KB name refuses loudly (only the fs driver needs one)', () => {
    // The jetstream driver takes no name; a jetstream service (the deployed
    // dispatcher) passes `undefined` and boots. The fs driver DOES need one for
    // its jobsDir, so absence fails here rather than silently.
    expect(() => jobQueueFor({ type: 'fs' }, undefined, mockLogger, new EventBus()))
      .toThrow(/\[kb\] name/);
  });

  test('the jetstream driver takes no name — a jetstream service needs no [kb] name', () => {
    const q = jobQueueFor({ type: 'jetstream', servers: '127.0.0.1:4222' }, undefined, mockLogger, new EventBus());
    expect(q).toBeInstanceOf(JetStreamJobQueue);
  });

  test("type 'jetstream' selects the JetStream driver with its address", async () => {
    const q = jobQueueFor({ type: 'jetstream', servers: '127.0.0.1:4222' }, KB, mockLogger, new EventBus());
    expect(q).toBeInstanceOf(JetStreamJobQueue);
  });

  test("type 'jetstream' without servers refuses loudly, naming the field", async () => {
    expect(() => jobQueueFor({ type: 'jetstream' }, KB, mockLogger, new EventBus()))
      .toThrow(/services\.jobs\.servers/);
  });

  // The config loader resolved every ${VAR} before this config existed; what
  // still contains `${…}` is the value (SECRET-DELIVERY F4).
  test('servers, user and password reach the driver exactly as given', async () => {
    built.length = 0;
    jobQueueFor(
      { type: 'jetstream', servers: 'nats-${a}:4222', user: 'u${b}', password: 'p${c}' },
      KB, mockLogger, new EventBus(),
    );
    expect(built).toEqual([{ servers: 'nats-${a}:4222', user: 'u${b}', pass: 'p${c}' }]);
  });
});
