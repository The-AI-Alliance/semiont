/**
 * Tests for the UI-signal wrapper methods added by CLIENT-CLEANUP.
 * Each wrapper is a one-line typed sugar over `actor.emit(channel, payload)`.
 * The tests lock in the wrapper→channel mapping so future refactors can't
 * silently change which channel a method routes to.
 */

import { describe, it, expect, vi } from 'vitest';
import { BehaviorSubject, Subject } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import { EventBus, annotationId, resourceId } from '@semiont/core';
import { BeckonNamespace } from '../beckon';
import { BrowseNamespace } from '../browse';
import { MarkNamespace } from '../mark';
import type { SemiontApiClient } from '../../client';
import type { ActorVM, BusEvent, ConnectionState } from '../../view-models/domain/actor-vm';

function createMockActor() {
  const events$ = new Subject<BusEvent>();
  const emitSpy = vi.fn().mockResolvedValue(undefined);
  const actor: ActorVM = {
    on$<T = Record<string, unknown>>(channel: string) {
      return events$.pipe(
        filter((e) => e.channel === channel),
        map((e) => e.payload as T),
      );
    },
    emit: emitSpy,
    state$: new BehaviorSubject<ConnectionState>('open').asObservable(),
    addChannels: vi.fn(),
    removeChannels: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn(),
  };
  return { actor, emitSpy };
}

const AID = annotationId('ann-1');
const RID = resourceId('res-1');

describe('UI signal wrappers', () => {
  describe('beckon.hover', () => {
    it('emits beckon:hover with the given annotationId', () => {
      const { actor, emitSpy } = createMockActor();
      const beckon = new BeckonNamespace(actor);

      beckon.hover(AID);

      expect(emitSpy).toHaveBeenCalledExactlyOnceWith('beckon:hover', { annotationId: AID });
    });

    it('emits beckon:hover with null on unhover', () => {
      const { actor, emitSpy } = createMockActor();
      const beckon = new BeckonNamespace(actor);

      beckon.hover(null);

      expect(emitSpy).toHaveBeenCalledExactlyOnceWith('beckon:hover', { annotationId: null });
    });
  });

  describe('browse.click', () => {
    it('emits browse:click with annotationId and motivation', () => {
      const { actor, emitSpy } = createMockActor();
      const http = {} as SemiontApiClient;
      const browse = new BrowseNamespace(http, new EventBus(), () => undefined, actor);

      browse.click(AID, 'linking');

      expect(emitSpy).toHaveBeenCalledExactlyOnceWith('browse:click', {
        annotationId: AID,
        motivation: 'linking',
      });
    });
  });

  describe('browse.navigateReference', () => {
    it('emits browse:reference-navigate with the given resourceId', () => {
      const { actor, emitSpy } = createMockActor();
      const http = {} as SemiontApiClient;
      const browse = new BrowseNamespace(http, new EventBus(), () => undefined, actor);

      browse.navigateReference(RID);

      expect(emitSpy).toHaveBeenCalledExactlyOnceWith('browse:reference-navigate', {
        resourceId: RID,
      });
    });
  });

  describe('mark.request', () => {
    it('emits mark:requested with selector and motivation', () => {
      const { actor, emitSpy } = createMockActor();
      const http = {} as SemiontApiClient;
      const mark = new MarkNamespace(http, new EventBus(), () => undefined, actor);

      const selector = {
        type: 'TextQuoteSelector' as const,
        exact: 'hello world',
      };

      mark.request(selector, 'highlighting');

      expect(emitSpy).toHaveBeenCalledExactlyOnceWith('mark:requested', {
        selector,
        motivation: 'highlighting',
      });
    });
  });
});
