/**
 * AdminNamespace — administration
 */

import type { AccessToken, UserDID, components, paths } from '@semiont/core';
import type { SemiontApiClient } from '../client';
import type { AdminNamespace as IAdminNamespace, User, RequestContent, ResponseContent } from './types';

type AdminUserStatsResponse = components['schemas']['AdminUserStatsResponse'];
type OAuthConfigResponse = components['schemas']['OAuthConfigResponse'];
type TokenGetter = () => AccessToken | undefined;

export class AdminNamespace implements IAdminNamespace {
  constructor(
    private readonly http: SemiontApiClient,
    private readonly getToken: TokenGetter,
  ) {}

  async users(): Promise<User[]> {
    const result = await this.http.listUsers({ auth: this.getToken() });
    return (result as unknown as { users: User[] }).users;
  }

  async userStats(): Promise<AdminUserStatsResponse> {
    return this.http.getUserStats({ auth: this.getToken() });
  }

  async updateUser(userId: UserDID, data: RequestContent<paths['/api/admin/users/{id}']['patch']>): Promise<User> {
    const result = await this.http.updateUser(userId, data, { auth: this.getToken() });
    return (result as unknown as { user: User }).user;
  }

  async oauthConfig(): Promise<OAuthConfigResponse> {
    return this.http.getOAuthConfig({ auth: this.getToken() });
  }

  async healthCheck(): Promise<ResponseContent<paths['/api/health']['get']>> {
    return this.http.healthCheck({ auth: this.getToken() });
  }

  async status(): Promise<ResponseContent<paths['/api/status']['get']>> {
    return this.http.getStatus({ auth: this.getToken() });
  }

  async backup(): Promise<Response> {
    return this.http.backupKnowledgeBase({ auth: this.getToken() });
  }

  async restore(
    file: File,
    onProgress?: (event: { phase: string; message?: string; result?: Record<string, unknown> }) => void,
  ): Promise<{ phase: string; message?: string; result?: Record<string, unknown> }> {
    return this.http.restoreKnowledgeBase(file, { auth: this.getToken(), onProgress });
  }

  async exportKnowledgeBase(params?: { includeArchived?: boolean }): Promise<Response> {
    return this.http.exportKnowledgeBase(params, { auth: this.getToken() });
  }

  async importKnowledgeBase(
    file: File,
    onProgress?: (event: { phase: string; message?: string; result?: Record<string, unknown> }) => void,
  ): Promise<{ phase: string; message?: string; result?: Record<string, unknown> }> {
    return this.http.importKnowledgeBase(file, { auth: this.getToken(), onProgress });
  }
}
