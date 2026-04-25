/**
 * Beckon Command Tests
 *
 * Tests schema validation and command result shape.
 * Mocks createAuthenticatedClient to avoid network I/O.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BeckonOptionsSchema, runBeckon, type BeckonOptions } from '../beckon.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

const { mockBeckonAttention, mockLoadCachedClient } = vi.hoisted(() => {
  const mockBeckonAttention = vi.fn();
  const mockLoadCachedClient = vi.fn();
  return { mockBeckonAttention, mockLoadCachedClient };
});

vi.mock('../../api-client-factory.js', () => ({
  resolveBusUrl: vi.fn(() => 'http://localhost:4000'),
  loadCachedClient: mockLoadCachedClient,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOptions(overrides: Partial<BeckonOptions> = {}): BeckonOptions {
  return {
    verbose: false,
    dryRun: false,
    quiet: true,
    output: 'json',
    forceDiscovery: false,
    preflight: false,
    participantArr: ['alice'],
    resource: 'urn:semiont:resource:doc-1',
    annotation: undefined,
    message: undefined,
    bus: undefined,
    ...overrides,
  };
}

// ── Schema tests ──────────────────────────────────────────────────────────────

describe('BeckonOptionsSchema', () => {
  it('accepts minimum valid input', () => {
    const result = BeckonOptionsSchema.safeParse({
      participantArr: ['alice'],
      resource: 'urn:semiont:resource:doc-1',
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty participantArr', () => {
    const result = BeckonOptionsSchema.safeParse({
      participantArr: [],
      resource: 'urn:semiont:resource:doc-1',
    });
    expect(result.success).toBe(false);
  });

  it('rejects multiple participants', () => {
    const result = BeckonOptionsSchema.safeParse({
      participantArr: ['alice', 'bob'],
      resource: 'urn:semiont:resource:doc-1',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing resource', () => {
    const result = BeckonOptionsSchema.safeParse({
      participantArr: ['alice'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects message longer than 500 chars', () => {
    const result = BeckonOptionsSchema.safeParse({
      participantArr: ['alice'],
      resource: 'urn:semiont:resource:doc-1',
      message: 'x'.repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it('accepts optional annotation and message', () => {
    const result = BeckonOptionsSchema.safeParse({
      participantArr: ['alice'],
      resource: 'urn:semiont:resource:doc-1',
      annotation: 'urn:semiont:annotation:ann-1',
      message: 'Please review this',
    });
    expect(result.success).toBe(true);
  });
});

// ── runBeckon tests ───────────────────────────────────────────────────────────

describe('runBeckon', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBeckonAttention.mockResolvedValue({ participant: 'alice', resourceId: 'urn:semiont:resource:doc-1' });
    mockLoadCachedClient.mockReturnValue({
      semiont: { beckonAttention: mockBeckonAttention },
      token: 'mock-token',
    });
  });

  it('returns a CommandResults with command=beckon', async () => {
    const result = await runBeckon(makeOptions());
    expect(result.command).toBe('beckon');
    expect(result.environment).toBe('http://localhost:4000');
    expect(result.summary.total).toBe(1);
    expect(result.summary.succeeded).toBe(1);
    expect(result.summary.failed).toBe(0);
  });

  it('calls beckonAttention with resourceId only when no annotation', async () => {
    await runBeckon(makeOptions());
    expect(mockBeckonAttention).toHaveBeenCalledWith(
      'alice',
      expect.objectContaining({ resourceId: 'urn:semiont:resource:doc-1' }),
      expect.any(Object),
    );
    const [, body] = mockBeckonAttention.mock.calls[0];
    expect(body.annotationId).toBeUndefined();
  });

  it('includes annotationId when provided', async () => {
    await runBeckon(makeOptions({ annotation: 'urn:semiont:annotation:ann-1' }));
    const [, body] = mockBeckonAttention.mock.calls[0];
    expect(body.annotationId).toBe('urn:semiont:annotation:ann-1');
  });

  it('returns entity=participantId in results', async () => {
    const result = await runBeckon(makeOptions());
    expect(result.results[0]?.entity).toBe('alice');
    expect(result.results[0]?.success).toBe(true);
  });
});
