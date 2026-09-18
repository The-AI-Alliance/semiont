import { decodeJwt } from 'jose';
import type { User } from '@prisma/client';
import type { AccessToken } from '@semiont/core';
import { isString } from '@semiont/core';
import { DatabaseConnection } from '../db';
import { OAuthService } from '../auth/oauth';
import { IssuerVerifier } from './issuer';
import { trustedIssuer } from './trusted-issuer';

export interface Principal {
  user: User;
  agentDid?: string;
}

/**
 * The principal behind a bearer token, dispatched on `iss`: a token from the
 * trusted issuer is verified against that issuer's keys and its subject
 * mapped to a User row; any other token is gateway-signed and takes the
 * HMAC path (agent tokens, and human tokens until the gateway stops minting
 * them).
 */
export async function principalFromToken(token: AccessToken): Promise<Principal> {
  const issuer = trustedIssuer();
  if (issuer && issuerOf(token) === issuer.issuer) {
    return principalFromIssuerToken(token, issuer);
  }
  return OAuthService.getPrincipalFromToken(token);
}

function issuerOf(token: string): string | undefined {
  try {
    return decodeJwt(token).iss;
  } catch {
    return undefined;
  }
}

async function principalFromIssuerToken(token: AccessToken, verifier: IssuerVerifier): Promise<Principal> {
  const claims = await verifier.verify(token);
  if (!isString(claims.sub)) {
    throw new Error('Token has no subject');
  }
  const email = claims['email'];
  if (!isString(email)) {
    throw new Error('Token carries no email claim');
  }
  if (claims['email_verified'] === false) {
    throw new Error('Token email is not verified');
  }
  const name = claims['name'];
  const user = await provisionUser(verifier.issuer, claims.sub, email, isString(name) ? name : undefined);
  if (!user.isActive) {
    throw new Error('User not found or inactive');
  }
  return { user };
}

/**
 * The User row for an issuer subject: found by (issuer, subject); else the
 * row with the same email, which the issuer now vouches for, linked to the
 * subject; else created. A read per request, a write only on first sight.
 * `provider`/`providerId` hold the issuer and subject — the join key — as
 * they hold `agent` and `<provider>:<model>` for software agents.
 */
async function provisionUser(issuer: string, subject: string, email: string, name: string | undefined): Promise<User> {
  const prisma = DatabaseConnection.getClient();
  const linked = await prisma.user.findFirst({ where: { provider: issuer, providerId: subject } });
  if (linked) {
    return linked;
  }
  const byEmail = await prisma.user.findUnique({ where: { email } });
  if (byEmail) {
    return prisma.user.update({
      where: { id: byEmail.id },
      data: { provider: issuer, providerId: subject, ...(name ? { name } : {}), lastLogin: new Date() },
    });
  }
  return prisma.user.create({
    data: {
      email,
      name: name ?? null,
      provider: issuer,
      providerId: subject,
      passwordHash: null,
      domain: email.split('@')[1] ?? '',
      isAdmin: false,
      lastLogin: new Date(),
    },
  });
}
