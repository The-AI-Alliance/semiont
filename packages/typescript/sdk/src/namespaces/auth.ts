/**
 * AuthNamespace — the gateway's view of the signed-in principal. Gateway ops
 * only; no bus. Signing in happens at the issuer (`session/oauth.ts`).
 */

import type { ResourceId, components } from '@semiont/core';
import type { IGatewayOperations } from '@semiont/core';
import type { AuthNamespace as IAuthNamespace, User } from './types';

type ProtectedResourceMetadata = components['schemas']['ProtectedResourceMetadata'];

export class AuthNamespace implements IAuthNamespace {
  constructor(private readonly gateway: IGatewayOperations) {}

  async me(): Promise<User> {
    return this.gateway.getCurrentUser();
  }

  async mediaToken(resourceId: ResourceId): Promise<{ token: string }> {
    return this.gateway.getMediaToken(resourceId);
  }

  async protectedResourceMetadata(): Promise<ProtectedResourceMetadata> {
    return this.gateway.getProtectedResourceMetadata();
  }
}
