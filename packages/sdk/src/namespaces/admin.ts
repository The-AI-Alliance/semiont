/**
 * AdminNamespace — administration. Gateway ops only; no bus.
 */

import type { UserDID, components, paths } from '@semiont/core';
import type { IGatewayOperations } from '@semiont/core';
import type { AdminNamespace as IAdminNamespace, User, RequestContent, ResponseContent } from './types';

type AdminUserStatsResponse = components['schemas']['AdminUserStatsResponse'];
type OAuthConfigResponse = components['schemas']['OAuthConfigResponse'];

export class AdminNamespace implements IAdminNamespace {
  constructor(private readonly gateway: IGatewayOperations) {}

  async users(): Promise<User[]> {
    const result = await this.gateway.listUsers();
    return result.users;
  }

  async userStats(): Promise<AdminUserStatsResponse> {
    return this.gateway.getUserStats();
  }

  async updateUser(userId: UserDID, data: RequestContent<paths['/api/admin/users/{id}']['patch']>): Promise<User> {
    const result = await this.gateway.updateUser(userId, data);
    return result.user;
  }

  async oauthConfig(): Promise<OAuthConfigResponse> {
    return this.gateway.getOAuthConfig();
  }

  async healthCheck(): Promise<ResponseContent<paths['/api/health']['get']>> {
    return this.gateway.healthCheck();
  }

  async status(): Promise<ResponseContent<paths['/api/status']['get']>> {
    return this.gateway.getStatus();
  }
}
