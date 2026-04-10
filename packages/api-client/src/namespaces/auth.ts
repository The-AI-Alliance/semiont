/**
 * AuthNamespace — authentication
 */

import type { ResourceId, AccessToken, components } from '@semiont/core';
import { email as makeEmail, googleCredential, refreshToken as makeRefreshToken } from '@semiont/core';
import type { SemiontApiClient } from '../client';
import type { AuthNamespace as IAuthNamespace, User } from './types';

type AuthResponse = components['schemas']['AuthResponse'];
type TokenGetter = () => AccessToken | undefined;

export class AuthNamespace implements IAuthNamespace {
  constructor(
    private readonly http: SemiontApiClient,
    private readonly getToken: TokenGetter,
  ) {}

  async password(emailStr: string, passwordStr: string): Promise<AuthResponse> {
    return this.http.authenticatePassword(makeEmail(emailStr), passwordStr) as unknown as Promise<AuthResponse>;
  }

  async google(credential: string): Promise<AuthResponse> {
    return this.http.authenticateGoogle(googleCredential(credential)) as unknown as Promise<AuthResponse>;
  }

  async refresh(token: string): Promise<AuthResponse> {
    return this.http.refreshToken(makeRefreshToken(token)) as unknown as Promise<AuthResponse>;
  }

  async logout(): Promise<void> {
    await this.http.logout({ auth: this.getToken() });
  }

  async me(): Promise<User> {
    // getMe returns UserResponse (flat user object), which we return directly
    return this.http.getMe({ auth: this.getToken() }) as unknown as Promise<User>;
  }

  async acceptTerms(): Promise<void> {
    await this.http.acceptTerms({ auth: this.getToken() });
  }

  async mcpToken(): Promise<{ token: string }> {
    return this.http.generateMCPToken({ auth: this.getToken() }) as unknown as Promise<{ token: string }>;
  }

  async mediaToken(resourceId: ResourceId): Promise<{ token: string }> {
    return this.http.getMediaToken(resourceId, { auth: this.getToken() });
  }
}
