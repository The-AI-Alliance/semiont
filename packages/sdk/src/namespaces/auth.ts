/**
 * AuthNamespace — authentication. Backend ops only; no bus.
 */

import type { ResourceId, components } from '@semiont/core';
import { email as makeEmail, googleCredential, refreshToken as makeRefreshToken } from '@semiont/core';
import type { IBackendOperations } from '@semiont/core';
import type { AuthNamespace as IAuthNamespace, User } from './types';

type AuthResponse = components['schemas']['AuthResponse'];
type TokenRefreshResponse = components['schemas']['TokenRefreshResponse'];

export class AuthNamespace implements IAuthNamespace {
  constructor(private readonly backend: IBackendOperations) {}

  async password(emailStr: string, passwordStr: string): Promise<AuthResponse> {
    return this.backend.authenticatePassword(makeEmail(emailStr), passwordStr);
  }

  async google(credential: string): Promise<AuthResponse> {
    return this.backend.authenticateGoogle(googleCredential(credential));
  }

  async refresh(token: string): Promise<TokenRefreshResponse> {
    return this.backend.refreshAccessToken(makeRefreshToken(token));
  }

  async logout(): Promise<void> {
    await this.backend.logout();
  }

  async me(): Promise<User> {
    return this.backend.getCurrentUser();
  }

  async acceptTerms(): Promise<void> {
    await this.backend.acceptTerms();
  }

  async mcpToken(): Promise<{ token: string }> {
    return this.backend.generateMcpToken();
  }

  async mediaToken(resourceId: ResourceId): Promise<{ token: string }> {
    return this.backend.getMediaToken(resourceId);
  }
}
