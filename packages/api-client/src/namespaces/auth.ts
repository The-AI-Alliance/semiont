/**
 * AuthNamespace — authentication. Pure wire, no bus.
 */

import type { ResourceId, components } from '@semiont/core';
import { email as makeEmail, googleCredential, refreshToken as makeRefreshToken } from '@semiont/core';
import type { ITransport } from '../transport/types';
import type { AuthNamespace as IAuthNamespace, User } from './types';

type AuthResponse = components['schemas']['AuthResponse'];

export class AuthNamespace implements IAuthNamespace {
  constructor(private readonly transport: ITransport) {}

  async password(emailStr: string, passwordStr: string): Promise<AuthResponse> {
    return this.transport.authenticatePassword(makeEmail(emailStr), passwordStr);
  }

  async google(credential: string): Promise<AuthResponse> {
    return this.transport.authenticateGoogle(googleCredential(credential));
  }

  async refresh(token: string): Promise<AuthResponse> {
    return this.transport.refreshAccessToken(makeRefreshToken(token));
  }

  async logout(): Promise<void> {
    await this.transport.logout();
  }

  async me(): Promise<User> {
    return this.transport.getCurrentUser() as unknown as Promise<User>;
  }

  async acceptTerms(): Promise<void> {
    await this.transport.acceptTerms();
  }

  async mcpToken(): Promise<{ token: string }> {
    return this.transport.generateMcpToken();
  }

  async mediaToken(resourceId: ResourceId): Promise<{ token: string }> {
    return this.transport.getMediaToken(resourceId);
  }
}
