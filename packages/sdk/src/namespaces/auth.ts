/**
 * AuthNamespace — authentication. Gateway ops only; no bus.
 */

import type { ResourceId, components } from '@semiont/core';
import { email as makeEmail, googleCredential, refreshToken as makeRefreshToken } from '@semiont/core';
import type { IGatewayOperations } from '@semiont/core';
import type { AuthNamespace as IAuthNamespace, User } from './types';

type AuthResponse = components['schemas']['AuthResponse'];
type TokenRefreshResponse = components['schemas']['TokenRefreshResponse'];

export class AuthNamespace implements IAuthNamespace {
  constructor(private readonly gateway: IGatewayOperations) {}

  async password(emailStr: string, passwordStr: string): Promise<AuthResponse> {
    return this.gateway.authenticatePassword(makeEmail(emailStr), passwordStr);
  }

  async google(credential: string): Promise<AuthResponse> {
    return this.gateway.authenticateGoogle(googleCredential(credential));
  }

  async refresh(token: string): Promise<TokenRefreshResponse> {
    return this.gateway.refreshAccessToken(makeRefreshToken(token));
  }

  async logout(): Promise<void> {
    await this.gateway.logout();
  }

  async me(): Promise<User> {
    return this.gateway.getCurrentUser();
  }

  async acceptTerms(): Promise<void> {
    await this.gateway.acceptTerms();
  }

  async mediaToken(resourceId: ResourceId): Promise<{ token: string }> {
    return this.gateway.getMediaToken(resourceId);
  }
}
