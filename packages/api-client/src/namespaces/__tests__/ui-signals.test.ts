/**
 * Tests for the UI-signal wrapper methods (CLIENT-CLEANUP).
 * Each wrapper is a one-line typed sugar over `bus.get(channel).next(payload)`
 * (local-bus emit). The tests lock in the wrapper→channel mapping so future
 * refactors can't silently change which channel a method routes to, nor
 * accidentally swap local emit for transport.emit (wire).
 */

import { describe, it, expect, vi } from 'vitest';
import { BehaviorSubject } from 'rxjs';
import { EventBus, annotationId, resourceId } from '@semiont/core';
import type { EventMap } from '@semiont/core';
import { BeckonNamespace } from '../beckon';
import { BindNamespace } from '../bind';
import { BrowseNamespace } from '../browse';
import { JobNamespace } from '../job';
import { MarkNamespace } from '../mark';
import { MatchNamespace } from '../match';
import { YieldNamespace } from '../yield';
import type { ITransport, IContentTransport } from '../../transport/types';

function makeMockTransport(): ITransport {
  return {
    emit: vi.fn().mockResolvedValue(undefined),
    on: vi.fn().mockReturnValue(() => {}),
    stream: vi.fn(),
    subscribeToResource: vi.fn().mockReturnValue(() => {}),
    bridgeInto: vi.fn(),
    authenticatePassword: vi.fn(),
    authenticateGoogle: vi.fn(),
    refreshAccessToken: vi.fn(),
    logout: vi.fn(),
    acceptTerms: vi.fn(),
    getCurrentUser: vi.fn(),
    generateMcpToken: vi.fn(),
    getMediaToken: vi.fn(),
    listUsers: vi.fn(),
    getUserStats: vi.fn(),
    updateUser: vi.fn(),
    getOAuthConfig: vi.fn(),
    backupKnowledgeBase: vi.fn(),
    restoreKnowledgeBase: vi.fn(),
    exportKnowledgeBase: vi.fn(),
    importKnowledgeBase: vi.fn(),
    healthCheck: vi.fn(),
    getStatus: vi.fn(),
    state$: new BehaviorSubject<'connected'>('connected').asObservable() as never,
    dispose: vi.fn(),
  } as unknown as ITransport;
}

function makeMockContent(): IContentTransport {
  return {
    putBinary: vi.fn(),
    getBinary: vi.fn(),
    getBinaryStream: vi.fn(),
    dispose: vi.fn(),
  };
}

/**
 * Sets up a fresh bus and returns a spy that captures every payload emitted on
 * the given channel. Use this to assert wrapper→channel→payload mapping.
 */
function busSpy<K extends keyof EventMap>(bus: EventBus, channel: K) {
  const spy = vi.fn();
  bus.get(channel).subscribe((payload) => spy(channel, payload));
  return spy;
}

const AID = annotationId('ann-1');
const RID = resourceId('res-1');

describe('UI signal wrappers', () => {
  describe('beckon.hover', () => {
    it('emits beckon:hover with the given annotationId (local bus)', () => {
      const bus = new EventBus();
      const spy = busSpy(bus, 'beckon:hover');
      const beckon = new BeckonNamespace(makeMockTransport(), bus);

      beckon.hover(AID);

      expect(spy).toHaveBeenCalledExactlyOnceWith('beckon:hover', { annotationId: AID });
    });

    it('emits beckon:hover with null on unhover', () => {
      const bus = new EventBus();
      const spy = busSpy(bus, 'beckon:hover');
      const beckon = new BeckonNamespace(makeMockTransport(), bus);

      beckon.hover(null);

      expect(spy).toHaveBeenCalledExactlyOnceWith('beckon:hover', { annotationId: null });
    });
  });

  describe('browse.click', () => {
    it('emits browse:click with annotationId and motivation (local bus)', () => {
      const bus = new EventBus();
      const spy = busSpy(bus, 'browse:click');
      const browse = new BrowseNamespace(makeMockTransport(), bus, makeMockContent());

      browse.click(AID, 'linking');

      expect(spy).toHaveBeenCalledExactlyOnceWith('browse:click', {
        annotationId: AID,
        motivation: 'linking',
      });
    });
  });

  describe('browse.navigateReference', () => {
    it('emits browse:reference-navigate with the given resourceId (local bus)', () => {
      const bus = new EventBus();
      const spy = busSpy(bus, 'browse:reference-navigate');
      const browse = new BrowseNamespace(makeMockTransport(), bus, makeMockContent());

      browse.navigateReference(RID);

      expect(spy).toHaveBeenCalledExactlyOnceWith('browse:reference-navigate', {
        resourceId: RID,
      });
    });
  });

  describe('mark.request', () => {
    it('emits mark:requested with selector and motivation (local bus)', () => {
      const bus = new EventBus();
      const spy = busSpy(bus, 'mark:requested');
      const mark = new MarkNamespace(makeMockTransport(), bus);

      const selector = {
        type: 'TextQuoteSelector' as const,
        exact: 'hello world',
      };

      mark.request(selector, 'highlighting');

      expect(spy).toHaveBeenCalledExactlyOnceWith('mark:requested', {
        selector,
        motivation: 'highlighting',
      });
    });
  });

  describe('beckon.sparkle', () => {
    it('emits beckon:sparkle with the given annotationId (local bus)', () => {
      const bus = new EventBus();
      const spy = busSpy(bus, 'beckon:sparkle');
      const beckon = new BeckonNamespace(makeMockTransport(), bus);

      beckon.sparkle(AID);

      expect(spy).toHaveBeenCalledExactlyOnceWith('beckon:sparkle', { annotationId: AID });
    });
  });

  describe('bind.initiate', () => {
    it('emits bind:initiate with the given command payload (local bus)', () => {
      const bus = new EventBus();
      const spy = busSpy(bus, 'bind:initiate');
      const bind = new BindNamespace(makeMockTransport(), bus);

      const payload = {
        annotationId: AID,
        resourceId: RID,
        defaultTitle: 'Some Title',
        entityTypes: ['Person'],
      };
      bind.initiate(payload);

      expect(spy).toHaveBeenCalledExactlyOnceWith('bind:initiate', payload);
    });
  });

  describe('yield.clone', () => {
    it('emits yield:clone with no payload (local bus)', () => {
      const bus = new EventBus();
      const spy = busSpy(bus, 'yield:clone');
      const yieldNs = new YieldNamespace(makeMockTransport(), bus, makeMockContent());

      yieldNs.clone();

      expect(spy).toHaveBeenCalledExactlyOnceWith('yield:clone', undefined);
    });
  });

  describe('match.requestSearch', () => {
    it('emits match:search-requested with the given payload (local bus)', () => {
      const bus = new EventBus();
      const spy = busSpy(bus, 'match:search-requested');
      const match = new MatchNamespace(makeMockTransport(), bus);

      const payload = {
        correlationId: 'corr-1',
        resourceId: RID as string,
        referenceId: AID as string,
        context: { text: 'ctx' } as never,
        limit: 10,
        useSemanticScoring: true,
      };
      match.requestSearch(payload);

      expect(spy).toHaveBeenCalledExactlyOnceWith('match:search-requested', payload);
    });
  });

  describe('job.cancelRequest', () => {
    it('emits job:cancel-requested with the given jobType (local bus)', () => {
      const bus = new EventBus();
      const spy = busSpy(bus, 'job:cancel-requested');
      const job = new JobNamespace(makeMockTransport(), bus);

      job.cancelRequest('annotation');

      expect(spy).toHaveBeenCalledExactlyOnceWith('job:cancel-requested', {
        jobType: 'annotation',
      });
    });
  });

  describe('mark.submit', () => {
    it('emits mark:submit with the given payload (local bus)', () => {
      const bus = new EventBus();
      const spy = busSpy(bus, 'mark:submit');
      const mark = new MarkNamespace(makeMockTransport(), bus);

      const payload = {
        motivation: 'commenting' as const,
        selector: { type: 'TextQuoteSelector' as const, exact: 'x' },
        body: [{ type: 'TextualBody' as const, value: 'hi', purpose: 'commenting' as const }],
      };
      mark.submit(payload);

      expect(spy).toHaveBeenCalledExactlyOnceWith('mark:submit', payload);
    });
  });

  describe('mark.cancelPending', () => {
    it('emits mark:cancel-pending with no payload (local bus)', () => {
      const bus = new EventBus();
      const spy = busSpy(bus, 'mark:cancel-pending');
      const mark = new MarkNamespace(makeMockTransport(), bus);

      mark.cancelPending();

      expect(spy).toHaveBeenCalledExactlyOnceWith('mark:cancel-pending', undefined);
    });
  });

  describe('mark.requestAssist', () => {
    it('emits mark:assist-request with motivation and options (local bus)', () => {
      const bus = new EventBus();
      const spy = busSpy(bus, 'mark:assist-request');
      const mark = new MarkNamespace(makeMockTransport(), bus);

      mark.requestAssist('linking', { entityTypes: ['Person'] });

      expect(spy).toHaveBeenCalledExactlyOnceWith('mark:assist-request', {
        motivation: 'linking',
        options: { entityTypes: ['Person'] },
      });
    });

    it('threads correlationId when provided', () => {
      const bus = new EventBus();
      const spy = busSpy(bus, 'mark:assist-request');
      const mark = new MarkNamespace(makeMockTransport(), bus);

      mark.requestAssist('highlighting', { density: 5 }, 'corr-123');

      expect(spy).toHaveBeenCalledExactlyOnceWith('mark:assist-request', {
        motivation: 'highlighting',
        options: { density: 5 },
        correlationId: 'corr-123',
      });
    });
  });

  describe('mark.dismissProgress', () => {
    it('emits mark:progress-dismiss with no payload (local bus)', () => {
      const bus = new EventBus();
      const spy = busSpy(bus, 'mark:progress-dismiss');
      const mark = new MarkNamespace(makeMockTransport(), bus);

      mark.dismissProgress();

      expect(spy).toHaveBeenCalledExactlyOnceWith('mark:progress-dismiss', undefined);
    });
  });

  describe('mark.changeSelection', () => {
    it('emits mark:selection-changed with motivation (local bus)', () => {
      const bus = new EventBus();
      const spy = busSpy(bus, 'mark:selection-changed');
      const mark = new MarkNamespace(makeMockTransport(), bus);

      mark.changeSelection('linking');

      expect(spy).toHaveBeenCalledExactlyOnceWith('mark:selection-changed', {
        motivation: 'linking',
      });
    });

    it('emits mark:selection-changed with null on deselect', () => {
      const bus = new EventBus();
      const spy = busSpy(bus, 'mark:selection-changed');
      const mark = new MarkNamespace(makeMockTransport(), bus);

      mark.changeSelection(null);

      expect(spy).toHaveBeenCalledExactlyOnceWith('mark:selection-changed', {
        motivation: null,
      });
    });
  });

  describe('mark.changeClick', () => {
    it('emits mark:click-changed with the given action (local bus)', () => {
      const bus = new EventBus();
      const spy = busSpy(bus, 'mark:click-changed');
      const mark = new MarkNamespace(makeMockTransport(), bus);

      mark.changeClick('view');

      expect(spy).toHaveBeenCalledExactlyOnceWith('mark:click-changed', { action: 'view' });
    });
  });

  describe('mark.changeShape', () => {
    it('emits mark:shape-changed with the given shape (local bus)', () => {
      const bus = new EventBus();
      const spy = busSpy(bus, 'mark:shape-changed');
      const mark = new MarkNamespace(makeMockTransport(), bus);

      mark.changeShape('rectangle');

      expect(spy).toHaveBeenCalledExactlyOnceWith('mark:shape-changed', {
        shape: 'rectangle',
      });
    });
  });

  describe('mark.toggleMode', () => {
    it('emits mark:mode-toggled with no payload (local bus)', () => {
      const bus = new EventBus();
      const spy = busSpy(bus, 'mark:mode-toggled');
      const mark = new MarkNamespace(makeMockTransport(), bus);

      mark.toggleMode();

      expect(spy).toHaveBeenCalledExactlyOnceWith('mark:mode-toggled', undefined);
    });
  });
});
