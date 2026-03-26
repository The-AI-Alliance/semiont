/**
 * Listen Command Tests
 *
 * Tests schema validation and stream setup.
 * Simulates signal delivery via SIGINT to verify cleanup.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ListenOptionsSchema, runListen, type ListenOptions } from '../listen.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { mockStream, mockSse, mockCreateAuthenticatedClient } = vi.hoisted(() => {
  const mockStream = { close: vi.fn() };
  const mockSse = {
    globalEvents: vi.fn(),
    resourceEvents: vi.fn(),
  };
  const mockCreateAuthenticatedClient = vi.fn();
  return { mockStream, mockSse, mockCreateAuthenticatedClient };
});

vi.mock('../../api-client-factory.js', () => ({
  createAuthenticatedClient: mockCreateAuthenticatedClient,
}));

vi.mock('../../config-loader.js', () => ({
  findProjectRoot: vi.fn(() => '/test/project/root'),
  loadEnvironmentConfig: vi.fn(() => ({
    services: { backend: { publicURL: 'http://localhost:4000' } },
  })),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOptions(overrides: Partial<ListenOptions> = {}): ListenOptions {
  return {
    environment: 'test',
    verbose: false,
    dryRun: false,
    quiet: true,
    output: 'json',
    forceDiscovery: false,
    preflight: false,
    args: [],
    bus: undefined,
    user: undefined,
    password: undefined,
    ...overrides,
  };
}

// ── Schema tests ──────────────────────────────────────────────────────────────

describe('ListenOptionsSchema', () => {
  it('accepts no args (global listen)', () => {
    const r = ListenOptionsSchema.safeParse({ environment: 'test', args: [] });
    expect(r.success).toBe(true);
  });

  it('accepts "resource <id>"', () => {
    const r = ListenOptionsSchema.safeParse({ environment: 'test', args: ['resource', 'doc-1'] });
    expect(r.success).toBe(true);
  });

  it('rejects unknown subcommand', () => {
    const r = ListenOptionsSchema.safeParse({ environment: 'test', args: ['events'] });
    expect(r.success).toBe(false);
  });

  it('rejects "resource" without resourceId', () => {
    const r = ListenOptionsSchema.safeParse({ environment: 'test', args: ['resource'] });
    expect(r.success).toBe(false);
  });
});

// ── runListen tests ───────────────────────────────────────────────────────────

describe('runListen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateAuthenticatedClient.mockResolvedValue({ client: { sse: mockSse }, token: 'mock-token' });
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
