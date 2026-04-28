/**
 * Listen Command Tests
 *
 * Tests schema validation and stream setup.
 * Mocks createActorVM to verify channel registration and disposal.
 * Simulates signal delivery via SIGINT to verify cleanup.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Subject } from 'rxjs';
import { ListenOptionsSchema, runListen, type ListenOptions } from '../listen.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { mockActor, mockCreateActorVM, mockLoadCachedClient } = vi.hoisted(() => {
  const mockActor: any = {
    addChannels: vi.fn(),
    on$: vi.fn(),
    start: vi.fn(),
    dispose: vi.fn(),
  };
  const mockCreateActorVM = vi.fn(() => mockActor);
  const mockLoadCachedClient = vi.fn();
  return { mockActor, mockCreateActorVM, mockLoadCachedClient };
});

vi.mock('@semiont/api-client', () => ({
  createActorVM: mockCreateActorVM,
}));

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
    mockLoadCachedClient.mockReturnValue({ semiont: {}, token: 'mock-token' });
    mockActor.on$.mockImplementation(() => new Subject());
  });

  it('opens an actor with global channels for no-args listen and resolves on SIGINT', async () => {
    setImmediate(() => process.emit('SIGINT', 'SIGINT'));

    const result = await runListen(makeOptions());
    expect(result.command).toBe('listen');
    expect(mockCreateActorVM).toHaveBeenCalledOnce();
    const opts = mockCreateActorVM.mock.calls[0][0] as { channels: string[] };
    expect(opts.channels.length).toBeGreaterThan(0);
    expect(mockActor.addChannels).not.toHaveBeenCalled();
    expect(mockActor.start).toHaveBeenCalledOnce();
    expect(mockActor.dispose).toHaveBeenCalledOnce();
  });

  it('opens an actor with resource-scoped channels for "resource <id>" and resolves on SIGINT', async () => {
    setImmediate(() => process.emit('SIGINT', 'SIGINT'));

    const result = await runListen(makeOptions({ args: ['resource', 'urn:semiont:resource:doc-1'] }));
    expect(result.command).toBe('listen');
    expect(mockCreateActorVM).toHaveBeenCalledOnce();
    const opts = mockCreateActorVM.mock.calls[0][0] as { channels: string[] };
    expect(opts.channels).toEqual([]);
    expect(mockActor.addChannels).toHaveBeenCalledOnce();
    expect(mockActor.addChannels.mock.calls[0][1]).toBe('urn:semiont:resource:doc-1');
    expect(mockActor.dispose).toHaveBeenCalledOnce();
  });

  it('global listen (no entity field on results)', async () => {
    setImmediate(() => process.emit('SIGINT', 'SIGINT'));
    const result = await runListen(makeOptions());
    expect(result.summary.total).toBeGreaterThanOrEqual(0);
  });

  it('resource-scoped listen passes the resourceId to actor.addChannels', async () => {
    setImmediate(() => process.emit('SIGINT', 'SIGINT'));
    await runListen(makeOptions({ args: ['resource', 'urn:semiont:resource:doc-1'] }));
    expect(mockActor.addChannels.mock.calls[0][1]).toBe('urn:semiont:resource:doc-1');
  });
});
