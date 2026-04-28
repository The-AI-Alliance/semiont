/**
 * AdminNamespace — administration. Backend ops only; no bus.
 */

import type { UserDID, components, paths } from '@semiont/core';
import type { IBackendOperations } from '@semiont/core';
import type { AdminNamespace as IAdminNamespace, User, RequestContent, ResponseContent } from './types';

type AdminUserStatsResponse = components['schemas']['AdminUserStatsResponse'];
type OAuthConfigResponse = components['schemas']['OAuthConfigResponse'];

export class AdminNamespace implements IAdminNamespace {
  constructor(private readonly backend: IBackendOperations) {}

  async users(): Promise<User[]> {
    const result = await this.backend.listUsers();
    return result.users;
  }

  async userStats(): Promise<AdminUserStatsResponse> {
    return this.backend.getUserStats();
  }

  async updateUser(userId: UserDID, data: RequestContent<paths['/api/admin/users/{id}']['patch']>): Promise<User> {
    const result = await this.backend.updateUser(userId, data);
    return result.user;
  }

  async oauthConfig(): Promise<OAuthConfigResponse> {
    return this.backend.getOAuthConfig();
  }

  async healthCheck(): Promise<ResponseContent<paths['/api/health']['get']>> {
    return this.backend.healthCheck();
  }

  async status(): Promise<ResponseContent<paths['/api/status']['get']>> {
    return this.backend.getStatus();
  }

  async backup(): Promise<Response> {
    return this.backend.backupKnowledgeBase();
  }

  async restore(
    file: File,
    onProgress?: (event: { phase: string; message?: string; result?: Record<string, unknown> }) => void,
  ): Promise<{ phase: string; message?: string; result?: Record<string, unknown> }> {
    return this.backend.restoreKnowledgeBase(file, onProgress);
  }

  async exportKnowledgeBase(params?: { includeArchived?: boolean }): Promise<Response> {
    return this.backend.exportKnowledgeBase(params);
  }

  async importKnowledgeBase(
    file: File,
    onProgress?: (event: { phase: string; message?: string; result?: Record<string, unknown> }) => void,
  ): Promise<{ phase: string; message?: string; result?: Record<string, unknown> }> {
    return this.backend.importKnowledgeBase(file, onProgress);
  }
}
