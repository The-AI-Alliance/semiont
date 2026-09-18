import { decodeJwt } from 'jose';
import type { User } from '@prisma/client';
import type { AccessToken } from '@semiont/core';
import { isString } from '@semiont/core';
import { DatabaseConnection } from '../db';
import { JWTService } from '../auth/jwt';
import { IssuerVerifier } from './issuer';
import { trustedIssuer } from './trusted-issuer';

export interface Principal {
  user: User;
  agentDid?: string;
}

/**
 * The principal behind a bearer token, dispatched on `iss`: a token from the
 * trusted issuer is verified against that issuer's keys and its subject
 * mapped to a User row; any other token is gateway-signed (a software
 * agent's) and takes the HMAC path.
 */
export async function principalFromToken(token: AccessToken): Promise<Principal> {
  const issuer = trustedIssuer();
  if (issuer && issuerOf(token) === issuer.issuer) {
    return principalFromIssuerToken(token, issuer);
  }
  return principalFromGatewayToken(token);
}

function issuerOf(token: string): string | undefined {
  try {
    return decodeJwt(token).iss;
  } catch {
    return undefined;
  }
}

/**
 * A gateway-signed token: verified against the HMAC key ring, its User row
 * read, and its revocation epoch compared to the row's — a logout bumps the
 * row's epoch, so a token minted before it is refused.
 */
export async function principalFromGatewayToken(token: AccessToken): Promise<Principal> {
  const payload = JWTService.verifyToken(token);
  const prisma = DatabaseConnection.getClient();
  const user = await prisma.user.findUnique({ where: { id: payload.userId } });
  if (!user || !user.isActive) {
    throw new Error('User not found or inactive');
  }
  if (payload.tokenVersion !== user.tokenVersion) {
    throw new Error('Token revoked');
  }
  return payload.agentDid ? { user, agentDid: payload.agentDid } : { user };
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
  const user = await provisionUser({
    issuer: verifier.issuer,
    subject: claims.sub,
    email,
    ...(isString(name) ? { name } : {}),
    lastLogin: new Date(),
  });
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
 *
 * `semiont useradd` calls this too, with the id the issuer just minted and a
 * null `lastLogin`: an administrator creating an account and its owner first
 * presenting a token are the same mapping question, and answering it twice
 * would let the two answers drift.
 */
export async function provisionUser(input: {
  issuer: string;
  subject: string;
  email: string;
  name?: string;
  lastLogin: Date | null;
}): Promise<User> {
  const { issuer, subject, email, name, lastLogin } = input;
  const prisma = DatabaseConnection.getClient();
  const linked = await prisma.user.findFirst({ where: { provider: issuer, providerId: subject } });
  if (linked) {
    return linked;
  }
  const byEmail = await prisma.user.findUnique({ where: { email } });
  if (byEmail) {
    return prisma.user.update({
      where: { id: byEmail.id },
      data: { provider: issuer, providerId: subject, ...(name ? { name } : {}), lastLogin },
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
      lastLogin,
    },
  });
}
