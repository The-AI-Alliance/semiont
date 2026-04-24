/**
 * Tests for the UI-signal wrapper methods added by CLIENT-CLEANUP.
 * Each wrapper is a one-line typed sugar over `client.emit(channel, payload)`
 * (local-bus emit). The tests lock in the wrapper→channel mapping so future
 * refactors can't silently change which channel a method routes to, nor
 * accidentally swap local emit for actor.emit (HTTP).
 */

import { describe, it, expect, vi } from 'vitest';
import { BehaviorSubject, Subject } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import { EventBus, annotationId, resourceId } from '@semiont/core';
import { BeckonNamespace } from '../beckon';
import { BindNamespace } from '../bind';
import { BrowseNamespace } from '../browse';
import { JobNamespace } from '../job';
import { MarkNamespace } from '../mark';
import { MatchNamespace } from '../match';
import { YieldNamespace } from '../yield';
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
  return { actor, actorEmitSpy: emitSpy };
}

/** Mock client exposing just the local `.emit` surface these wrappers use. */
function createMockClient() {
  const emitSpy = vi.fn();
  const client = { emit: emitSpy } as unknown as SemiontApiClient;
  return { client, clientEmitSpy: emitSpy };
}

const AID = annotationId('ann-1');
const RID = resourceId('res-1');

describe('UI signal wrappers', () => {
  describe('beckon.hover', () => {
    it('emits beckon:hover with the given annotationId (local bus)', () => {
      const { actor } = createMockActor();
      const { client, clientEmitSpy } = createMockClient();
      const beckon = new BeckonNamespace(client, actor);

      beckon.hover(AID);

      expect(clientEmitSpy).toHaveBeenCalledExactlyOnceWith('beckon:hover', { annotationId: AID });
    });

    it('emits beckon:hover with null on unhover', () => {
      const { actor } = createMockActor();
      const { client, clientEmitSpy } = createMockClient();
      const beckon = new BeckonNamespace(client, actor);

      beckon.hover(null);

      expect(clientEmitSpy).toHaveBeenCalledExactlyOnceWith('beckon:hover', { annotationId: null });
    });
  });

  describe('browse.click', () => {
    it('emits browse:click with annotationId and motivation (local bus)', () => {
      const { actor } = createMockActor();
      const { client, clientEmitSpy } = createMockClient();
      const browse = new BrowseNamespace(client, new EventBus(), () => undefined, actor);

      browse.click(AID, 'linking');

      expect(clientEmitSpy).toHaveBeenCalledExactlyOnceWith('browse:click', {
        annotationId: AID,
        motivation: 'linking',
      });
    });
  });

  describe('browse.navigateReference', () => {
    it('emits browse:reference-navigate with the given resourceId (local bus)', () => {
      const { actor } = createMockActor();
      const { client, clientEmitSpy } = createMockClient();
      const browse = new BrowseNamespace(client, new EventBus(), () => undefined, actor);

      browse.navigateReference(RID);

      expect(clientEmitSpy).toHaveBeenCalledExactlyOnceWith('browse:reference-navigate', {
        resourceId: RID,
      });
    });
  });

  describe('mark.request', () => {
    it('emits mark:requested with selector and motivation (local bus)', () => {
      const { actor } = createMockActor();
      const { client, clientEmitSpy } = createMockClient();
      const mark = new MarkNamespace(client, new EventBus(), () => undefined, actor);

      const selector = {
        type: 'TextQuoteSelector' as const,
        exact: 'hello world',
      };

      mark.request(selector, 'highlighting');

      expect(clientEmitSpy).toHaveBeenCalledExactlyOnceWith('mark:requested', {
        selector,
        motivation: 'highlighting',
      });
    });
  });

  // ── Phase 2 wrappers ────────────────────────────────────────────────────

  describe('beckon.sparkle', () => {
    it('emits beckon:sparkle with the given annotationId (local bus)', () => {
      const { actor } = createMockActor();
      const { client, clientEmitSpy } = createMockClient();
      const beckon = new BeckonNamespace(client, actor);

      beckon.sparkle(AID);

      expect(clientEmitSpy).toHaveBeenCalledExactlyOnceWith('beckon:sparkle', { annotationId: AID });
    });
  });

  describe('bind.initiate', () => {
    it('emits bind:initiate with the given command payload (local bus)', () => {
      const { actor } = createMockActor();
      const { client, clientEmitSpy } = createMockClient();
      const bind = new BindNamespace(client, actor);

      const payload = {
        annotationId: AID as string,
        resourceId: RID as string,
        defaultTitle: 'Some Title',
        entityTypes: ['Person'],
      };
      bind.initiate(payload);

      expect(clientEmitSpy).toHaveBeenCalledExactlyOnceWith('bind:initiate', payload);
    });
  });

  describe('yield.clone', () => {
    it('emits yield:clone with no payload (local bus)', () => {
      const { actor } = createMockActor();
      const { client, clientEmitSpy } = createMockClient();
      const yieldNs = new YieldNamespace(client, new EventBus(), () => undefined, actor);

      yieldNs.clone();

      expect(clientEmitSpy).toHaveBeenCalledExactlyOnceWith('yield:clone', undefined);
    });
  });

  describe('match.requestSearch', () => {
    it('emits match:search-requested with the given payload (local bus)', () => {
      const { actor } = createMockActor();
      const { client, clientEmitSpy } = createMockClient();
      const match = new MatchNamespace(client, new EventBus(), actor);

      const payload = {
        correlationId: 'corr-1',
        resourceId: RID as string,
        referenceId: AID as string,
        context: { text: 'ctx' } as never,
        limit: 10,
        useSemanticScoring: true,
      };
      match.requestSearch(payload);

      expect(clientEmitSpy).toHaveBeenCalledExactlyOnceWith('match:search-requested', payload);
    });
  });

  describe('job.cancelRequest', () => {
    it('emits job:cancel-requested with the given jobType (local bus)', () => {
      const { actor } = createMockActor();
      const { client, clientEmitSpy } = createMockClient();
      const job = new JobNamespace(client, actor);

      job.cancelRequest('annotation');

      expect(clientEmitSpy).toHaveBeenCalledExactlyOnceWith('job:cancel-requested', {
        jobType: 'annotation',
      });
    });
  });

  describe('mark.submit', () => {
    it('emits mark:submit with the given payload (local bus)', () => {
      const { actor } = createMockActor();
      const { client, clientEmitSpy } = createMockClient();
      const mark = new MarkNamespace(client, new EventBus(), () => undefined, actor);

      const payload = {
        motivation: 'commenting' as const,
        selector: { type: 'TextQuoteSelector' as const, exact: 'x' },
        body: [{ type: 'TextualBody' as const, value: 'hi', purpose: 'commenting' as const }],
      };
      mark.submit(payload);

      expect(clientEmitSpy).toHaveBeenCalledExactlyOnceWith('mark:submit', payload);
    });
  });

  describe('mark.cancelPending', () => {
    it('emits mark:cancel-pending with no payload (local bus)', () => {
      const { actor } = createMockActor();
      const { client, clientEmitSpy } = createMockClient();
      const mark = new MarkNamespace(client, new EventBus(), () => undefined, actor);

      mark.cancelPending();

      expect(clientEmitSpy).toHaveBeenCalledExactlyOnceWith('mark:cancel-pending', undefined);
    });
  });

  describe('mark.requestAssist', () => {
    it('emits mark:assist-request with motivation and options (local bus)', () => {
      const { actor } = createMockActor();
      const { client, clientEmitSpy } = createMockClient();
      const mark = new MarkNamespace(client, new EventBus(), () => undefined, actor);

      mark.requestAssist('linking', { entityTypes: ['Person'] });

      expect(clientEmitSpy).toHaveBeenCalledExactlyOnceWith('mark:assist-request', {
        motivation: 'linking',
        options: { entityTypes: ['Person'] },
      });
    });

    it('threads correlationId when provided', () => {
      const { actor } = createMockActor();
      const { client, clientEmitSpy } = createMockClient();
      const mark = new MarkNamespace(client, new EventBus(), () => undefined, actor);

      mark.requestAssist('highlighting', { density: 5 }, 'corr-123');

      expect(clientEmitSpy).toHaveBeenCalledExactlyOnceWith('mark:assist-request', {
        motivation: 'highlighting',
        options: { density: 5 },
        correlationId: 'corr-123',
      });
    });
  });

  describe('mark.dismissProgress', () => {
    it('emits mark:progress-dismiss with no payload (local bus)', () => {
      const { actor } = createMockActor();
      const { client, clientEmitSpy } = createMockClient();
      const mark = new MarkNamespace(client, new EventBus(), () => undefined, actor);

      mark.dismissProgress();

      expect(clientEmitSpy).toHaveBeenCalledExactlyOnceWith('mark:progress-dismiss', undefined);
    });
  });

  describe('mark.changeSelection', () => {
    it('emits mark:selection-changed with motivation (local bus)', () => {
      const { actor } = createMockActor();
      const { client, clientEmitSpy } = createMockClient();
      const mark = new MarkNamespace(client, new EventBus(), () => undefined, actor);

      mark.changeSelection('linking');

      expect(clientEmitSpy).toHaveBeenCalledExactlyOnceWith('mark:selection-changed', {
        motivation: 'linking',
      });
    });

    it('emits mark:selection-changed with null on deselect', () => {
      const { actor } = createMockActor();
      const { client, clientEmitSpy } = createMockClient();
      const mark = new MarkNamespace(client, new EventBus(), () => undefined, actor);

      mark.changeSelection(null);

      expect(clientEmitSpy).toHaveBeenCalledExactlyOnceWith('mark:selection-changed', {
        motivation: null,
      });
    });
  });

  describe('mark.changeClick', () => {
    it('emits mark:click-changed with the given action (local bus)', () => {
      const { actor } = createMockActor();
      const { client, clientEmitSpy } = createMockClient();
      const mark = new MarkNamespace(client, new EventBus(), () => undefined, actor);

      mark.changeClick('view');

      expect(clientEmitSpy).toHaveBeenCalledExactlyOnceWith('mark:click-changed', { action: 'view' });
    });
  });

  describe('mark.changeShape', () => {
    it('emits mark:shape-changed with the given shape (local bus)', () => {
      const { actor } = createMockActor();
      const { client, clientEmitSpy } = createMockClient();
      const mark = new MarkNamespace(client, new EventBus(), () => undefined, actor);

      mark.changeShape('rectangle');

      expect(clientEmitSpy).toHaveBeenCalledExactlyOnceWith('mark:shape-changed', {
        shape: 'rectangle',
      });
    });
  });

  describe('mark.toggleMode', () => {
    it('emits mark:mode-toggled with no payload (local bus)', () => {
      const { actor } = createMockActor();
      const { client, clientEmitSpy } = createMockClient();
      const mark = new MarkNamespace(client, new EventBus(), () => undefined, actor);

      mark.toggleMode();

      expect(clientEmitSpy).toHaveBeenCalledExactlyOnceWith('mark:mode-toggled', undefined);
    });
  });
});
