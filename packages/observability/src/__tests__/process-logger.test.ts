/**
 * Tests for `createProcessLogger`.
 *
 * Output is captured by stubbing `winston.transports.Console.prototype.log`,
 * which receives the fully formatted record — the whole format chain has run by
 * then, so this observes exactly what the process would have printed. Stubbing
 * `process.stdout.write` does NOT work here: under Vitest the global `console`
 * is a custom instance whose internal stream is not `process.stdout`, so the
 * transport's write never reaches such a spy.
 *
 * A real `BasicTracerProvider` is installed for the file so that
 * `getLogTraceContext` (which the trace-context format calls) can return a
 * valid span context. Under the default no-op tracer it returns `undefined`,
 * which is the case the "outside a span" test pins.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import winston from 'winston';

import { createProcessLogger } from '../process-logger';
import { withSpan } from '../index';

const spanExporter = new InMemorySpanExporter();
let tracerProvider: BasicTracerProvider;

/** Where winston puts the formatted line it hands a transport. */
const MESSAGE = Symbol.for('message');

let captured: unknown[] = [];

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  trace.setGlobalTracerProvider(tracerProvider);
});

afterAll(async () => {
  await tracerProvider.shutdown();
});

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  captured = [];
  vi.spyOn(winston.transports.Console.prototype, 'log').mockImplementation(
    (...args: unknown[]) => {
      const [info, next] = args;
      captured.push(info);
      // winston hands the transport a continuation; not calling it leaves the
      // logger's stream waiting.
      if (typeof next === 'function') next();
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

/**
 * Winston pipes records to transports through a stream, so a record has not
 * reached the transport the instant `logger.info` returns. Yield the macrotask
 * queue before asserting.
 */
async function drain(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * The formatted line winston stored on the record. Read via `Reflect.get`
 * because the key is a symbol, which an index signature cannot express.
 */
function lines(): string[] {
  return captured.map((info) => {
    if (typeof info !== 'object' || info === null) return '';
    return String(Reflect.get(info, MESSAGE));
  });
}

describe('createProcessLogger — json format (default)', () => {
  it('emits one parseable JSON line carrying component, level, and message', async () => {
    delete process.env.LOG_FORMAT;
    const logger = createProcessLogger('gateway');

    logger.info('started');
    await drain();

    const [line] = lines();
    expect(line).toBeDefined();
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.component).toBe('gateway');
    expect(parsed.level).toBe('info');
    expect(parsed.message).toBe('started');
    expect(parsed.timestamp).toBeTypeOf('string');
  });

  it('merges caller metadata into the line', async () => {
    const logger = createProcessLogger('worker');

    logger.info('claimed', { jobId: 'job-1', attempt: 2 });
    await drain();

    const parsed = JSON.parse(lines()[0]) as Record<string, unknown>;
    expect(parsed.jobId).toBe('job-1');
    expect(parsed.attempt).toBe(2);
  });

  it('omits trace fields when no span is active', async () => {
    const logger = createProcessLogger('smelter');

    logger.info('idle');
    await drain();

    const parsed = JSON.parse(lines()[0]) as Record<string, unknown>;
    expect(parsed.trace_id).toBeUndefined();
    expect(parsed.span_id).toBeUndefined();
  });

  it('stamps trace_id and span_id from the active span', async () => {
    const logger = createProcessLogger('worker');

    await withSpan('unit.logged-work', async () => {
      logger.info('inside span');
      await drain();
    });

    const parsed = JSON.parse(lines()[0]) as Record<string, unknown>;
    expect(parsed.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(parsed.span_id).toMatch(/^[0-9a-f]{16}$/);

    // The stamped ids must be the span's own, not an unrelated context.
    const span = spanExporter.getFinishedSpans().find((s) => s.name === 'unit.logged-work');
    expect(parsed.trace_id).toBe(span!.spanContext().traceId);
    expect(parsed.span_id).toBe(span!.spanContext().spanId);
  });
});

describe('createProcessLogger — simple format', () => {
  it('renders the human-readable line with component and upper-cased level', async () => {
    process.env.LOG_FORMAT = 'simple';
    const logger = createProcessLogger('smelter');

    logger.warn('slow batch');
    await drain();

    const [line] = lines();
    expect(line).toContain('[WARN]');
    expect(line).toContain('[smelter]');
    expect(line).toContain('slow batch');
    // Not JSON in this branch.
    expect(() => JSON.parse(line)).toThrow();
  });

  it('appends metadata as JSON when the caller passes any', async () => {
    process.env.LOG_FORMAT = 'simple';
    const logger = createProcessLogger('worker');

    logger.info('claimed', { jobId: 'job-7' });
    await drain();

    expect(lines()[0]).toContain('"jobId":"job-7"');
  });
});

describe('createProcessLogger — LOG_LEVEL', () => {
  it('suppresses debug at the default info level', async () => {
    delete process.env.LOG_LEVEL;
    const logger = createProcessLogger('gateway');

    logger.debug('verbose detail');
    await drain();

    expect(lines()).toHaveLength(0);
  });

  it('emits debug once LOG_LEVEL asks for it', async () => {
    process.env.LOG_LEVEL = 'debug';
    const logger = createProcessLogger('gateway');

    logger.debug('verbose detail');
    await drain();

    const parsed = JSON.parse(lines()[0]) as Record<string, unknown>;
    expect(parsed.level).toBe('debug');
    expect(parsed.message).toBe('verbose detail');
  });
});
