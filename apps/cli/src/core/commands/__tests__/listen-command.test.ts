/**
 * Listen Command Tests
 *
 * Tests schema validation and stream setup.
 * Simulates signal delivery via SIGINT to verify cleanup.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ListenOptionsSchema, runListen, type ListenOptions } from '../listen.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { mockStream, mockSse, mockLoadCachedClient } = vi.hoisted(() => {
  const mockStream = { close: vi.fn() };
  const mockSse = {
    globalEvents: vi.fn(),
    resourceEvents: vi.fn(),
  };
  const mockLoadCachedClient = vi.fn();
  return { mockStream, mockSse, mockLoadCachedClient };
});

vi.mock('../../api-client-factory.js', () => ({
  resolveBusUrl: vi.fn(() => 'http://localhost:4000'),
  loadCachedClient: mockLoadCachedClient,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOptions(overrides: Partial<ListenOptions> = {}): ListenOptions {
  return {
    verbose: false,
    dryRun: false,
    quiet: true,
    output: 'json',
    forceDiscovery: false,
    preflight: false,
    args: [],
    bus: undefined,
    ...overrides,
  };
}

// ── Schema tests ──────────────────────────────────────────────────────────────

describe('ListenOptionsSchema', () => {
  it('accepts no args (global listen)', () => {
    const r = ListenOptionsSchema.safeParse({ args: [] });
    expect(r.success).toBe(true);
  });

  it('accepts "resource <id>"', () => {
    const r = ListenOptionsSchema.safeParse({ args: ['resource', 'doc-1'] });
    expect(r.success).toBe(true);
  });

  it('rejects unknown subcommand', () => {
    const r = ListenOptionsSchema.safeParse({ args: ['unknown'] });
    expect(r.success).toBe(false);
  });

  it('rejects "resource" without resourceId', () => {
    const r = ListenOptionsSchema.safeParse({ args: ['resource'] });
    expect(r.success).toBe(false);
  });
});

// ── runListen tests ───────────────────────────────────────────────────────────

describe('runListen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadCachedClient.mockReturnValue({ client: { sse: mockSse }, token: 'mock-token' });
    mockSse.globalEvents.mockReturnValue(mockStream);
    mockSse.resourceEvents.mockReturnValue(mockStream);
  });

  it('opens globalEvents for no-args listen and resolves on SIGINT', async () => {
    // Emit SIGINT after a tick to unblock the command
    setImmediate(() => process.emit('SIGINT', 'SIGINT'));

    const result = await runListen(makeOptions());
    expect(result.command).toBe('listen');
    expect(mockSse.globalEvents).toHaveBeenCalledOnce();
    expect(mockStream.close).toHaveBeenCalledOnce();
  });

  it('opens resourceEvents for "resource <id>" and resolves on SIGINT', async () => {
    setImmediate(() => process.emit('SIGINT', 'SIGINT'));

    const result = await runListen(makeOptions({ args: ['resource', 'urn:semiont:resource:doc-1'] }));
    expect(result.command).toBe('listen');
    expect(mockSse.resourceEvents).toHaveBeenCalledOnce();
    expect(mockStream.close).toHaveBeenCalledOnce();
  });

  it('sets entity=global for global listen', async () => {
    setImmediate(() => process.emit('SIGINT', 'SIGINT'));
    const result = await runListen(makeOptions());
    expect(result.results[0]?.entity).toBe('global');
  });

  it('sets entity=resourceId for resource-scoped listen', async () => {
    setImmediate(() => process.emit('SIGINT', 'SIGINT'));
    const result = await runListen(makeOptions({ args: ['resource', 'urn:semiont:resource:doc-1'] }));
    expect(result.results[0]?.entity).toBe('urn:semiont:resource:doc-1');
  });
});
