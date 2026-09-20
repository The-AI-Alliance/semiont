/**
 * SystemNamespace — what a knowledge base says about itself. Gateway ops
 * only; no bus.
 *
 * This was `AdminNamespace` until the administration surface was removed:
 * user management lives at the issuer now, so the four admin operations went
 * and what remained — health and status — was never administration. Status is
 * how a client learns a knowledge base's identity and branch before it trusts
 * the connection (`describeConnection`), and health is the liveness probe.
 */

import type { paths } from '@semiont/core';
import type { IGatewayOperations } from '@semiont/core';
import type { SystemNamespace as ISystemNamespace, ResponseContent } from './types';

export class SystemNamespace implements ISystemNamespace {
  constructor(private readonly gateway: IGatewayOperations) {}

  async healthCheck(): Promise<ResponseContent<paths['/api/health']['get']>> {
    return this.gateway.healthCheck();
  }

  async status(): Promise<ResponseContent<paths['/api/status']['get']>> {
    return this.gateway.getStatus();
  }
}
