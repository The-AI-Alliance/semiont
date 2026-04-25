/**
 * AdminNamespace — administration. Pure wire, no bus.
 */

import type { UserDID, components, paths } from '@semiont/core';
import type { ITransport } from '@semiont/core';
import type { AdminNamespace as IAdminNamespace, User, RequestContent, ResponseContent } from './types';

type AdminUserStatsResponse = components['schemas']['AdminUserStatsResponse'];
type OAuthConfigResponse = components['schemas']['OAuthConfigResponse'];

export class AdminNamespace implements IAdminNamespace {
  constructor(private readonly transport: ITransport) {}

  async users(): Promise<User[]> {
    const result = await this.transport.listUsers();
    return (result as unknown as { users: User[] }).users;
  }

  async userStats(): Promise<AdminUserStatsResponse> {
    return this.transport.getUserStats();
  }

  async updateUser(userId: UserDID, data: RequestContent<paths['/api/admin/users/{id}']['patch']>): Promise<User> {
    const result = await this.transport.updateUser(userId, data as never);
    return (result as unknown as { user: User }).user;
  }

  async oauthConfig(): Promise<OAuthConfigResponse> {
    return this.transport.getOAuthConfig();
  }

  async healthCheck(): Promise<ResponseContent<paths['/api/health']['get']>> {
    return this.transport.healthCheck() as unknown as Promise<ResponseContent<paths['/api/health']['get']>>;
  }

  async status(): Promise<ResponseContent<paths['/api/status']['get']>> {
    return this.transport.getStatus() as unknown as Promise<ResponseContent<paths['/api/status']['get']>>;
  }

  async backup(): Promise<Response> {
    return this.transport.backupKnowledgeBase();
  }

  async restore(
    file: File,
    onProgress?: (event: { phase: string; message?: string; result?: Record<string, unknown> }) => void,
  ): Promise<{ phase: string; message?: string; result?: Record<string, unknown> }> {
    return this.transport.restoreKnowledgeBase(file, onProgress);
  }

  async exportKnowledgeBase(params?: { includeArchived?: boolean }): Promise<Response> {
    return this.transport.exportKnowledgeBase(params);
  }

  async importKnowledgeBase(
    file: File,
    onProgress?: (event: { phase: string; message?: string; result?: Record<string, unknown> }) => void,
  ): Promise<{ phase: string; message?: string; result?: Record<string, unknown> }> {
    return this.transport.importKnowledgeBase(file, onProgress);
  }
}
