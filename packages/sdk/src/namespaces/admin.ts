/**
 * AdminNamespace — administration. Backend ops only; no bus.
 */

import type { UserDID, ProgressEvent, components, paths } from '@semiont/core';
import type { BackendDownload, IBackendOperations } from '@semiont/core';
import { StreamObservable } from '../awaitable';
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

  async backup(): Promise<BackendDownload> {
    return this.backend.backupKnowledgeBase();
  }

  restore(file: File): StreamObservable<ProgressEvent> {
    return wrapAsStream(this.backend.restoreKnowledgeBase(file));
  }

  async exportKnowledgeBase(params?: { includeArchived?: boolean }): Promise<BackendDownload> {
    return this.backend.exportKnowledgeBase(params);
  }

  importKnowledgeBase(file: File): StreamObservable<ProgressEvent> {
    return wrapAsStream(this.backend.importKnowledgeBase(file));
  }
}

/**
 * Wrap a plain `Observable<ProgressEvent>` from `IBackendOperations` as
 * a `StreamObservable<ProgressEvent>` for the SDK surface — same RxJS
 * semantics, plus the awaitable PromiseLike that resolves to the last
 * emitted value.
 */
function wrapAsStream(
  source: import('rxjs').Observable<ProgressEvent>,
): StreamObservable<ProgressEvent> {
  return new StreamObservable<ProgressEvent>((subscriber) => {
    const sub = source.subscribe({
      next: (v) => subscriber.next(v),
      error: (e) => subscriber.error(e),
      complete: () => subscriber.complete(),
    });
    return () => sub.unsubscribe();
  });
}
