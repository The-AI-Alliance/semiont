/**
 * The HMAC path of `principalFromToken`: a gateway-signed token resolves to
 * its User row, surfaces the agent DID it carries, and is refused when the
 * signature, the row, or the revocation epoch does not hold up.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { User } from '@prisma/client';
import { faker } from '@faker-js/faker';
import { accessToken, email as makeEmail, userId as makeUserId } from '@semiont/core';
import { DatabaseConnection } from '../../db';
import { JWTService } from '../../auth/jwt';
import { principalFromGatewayToken } from '../../identity/principal';

const prisma = DatabaseConnection.getClient();
const mockPrismaUser = vi.mocked(prisma.user);

const makeCuid = () => `c${faker.string.alphanumeric(24).toLowerCase()}`;

function fakeUser(overrides: Partial<User> = {}): User {
  return {
    id: makeCuid(),
    email: 'principal@example.com',
    name: 'Principal',
    image: null,
    domain: 'example.com',
    provider: 'agent',
    providerId: 'anthropic:claude',
    passwordHash: null,
    isAdmin: false,
    isActive: true,
    isModerator: false,
    termsAcceptedAt: null,
    lastLogin: null,
    tokenVersion: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function mintToken(user: User, extra: { tokenVersion?: number; agentDid?: string } = {}) {
  return accessToken(JWTService.generateToken({
    userId: makeUserId(user.id),
    email: makeEmail(user.email),
    domain: user.domain,
    provider: user.provider,
    isAdmin: user.isAdmin,
    tokenVersion: extra.tokenVersion ?? user.tokenVersion,
    ...(extra.agentDid ? { agentDid: extra.agentDid } : {}),
  }, '1h'));
}

describe('principalFromGatewayToken', () => {
  beforeAll(() => {
    JWTService.initialize({
      site: { domain: 'test.local', oauthAllowedDomains: ['test.local', 'example.com'] },
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves a valid token to its User row', async () => {
    const user = fakeUser();
    mockPrismaUser.findUnique.mockResolvedValue(user);

    const principal = await principalFromGatewayToken(mintToken(user));

    expect(principal).toEqual({ user });
    expect(mockPrismaUser.findUnique).toHaveBeenCalledWith({ where: { id: user.id } });
  });

  it('surfaces the agent DID the token carries', async () => {
    const user = fakeUser();
    mockPrismaUser.findUnique.mockResolvedValue(user);
    const agentDid = 'did:web:test.local:agents:anthropic:claude';

    const principal = await principalFromGatewayToken(mintToken(user, { agentDid }));

    expect(principal).toEqual({ user, agentDid });
  });

  it('refuses a token the key ring did not sign', async () => {
    await expect(principalFromGatewayToken(accessToken('not.a.token'))).rejects.toThrow();
    expect(mockPrismaUser.findUnique).not.toHaveBeenCalled();
  });

  it('refuses a token whose User row is gone', async () => {
    const user = fakeUser();
    mockPrismaUser.findUnique.mockResolvedValue(null);

    await expect(principalFromGatewayToken(mintToken(user))).rejects.toThrow('User not found or inactive');
  });

  it('refuses a token for a deactivated user', async () => {
    const user = fakeUser({ isActive: false });
    mockPrismaUser.findUnique.mockResolvedValue(user);

    await expect(principalFromGatewayToken(mintToken(user))).rejects.toThrow('User not found or inactive');
  });

  it('refuses a token minted before the user\'s last logout', async () => {
    const user = fakeUser({ tokenVersion: 3 });
    mockPrismaUser.findUnique.mockResolvedValue(user);

    await expect(principalFromGatewayToken(mintToken(user, { tokenVersion: 2 }))).rejects.toThrow('Token revoked');
  });
});
