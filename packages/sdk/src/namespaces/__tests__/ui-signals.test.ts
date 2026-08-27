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
import type { ConnectionState, EventMap } from '@semiont/core';
import { BeckonNamespace } from '../beckon';
import { BindNamespace } from '../bind';
import { BrowseNamespace } from '../browse';
import { JobNamespace } from '../job';
import { MarkNamespace } from '../mark';
import { MatchNamespace } from '../match';
import { YieldNamespace } from '../yield';
import type { ITransport, IContentTransport } from '@semiont/core';

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
    getMediaToken: vi.fn(),
    listUsers: vi.fn(),
    getUserStats: vi.fn(),
    updateUser: vi.fn(),
    getOAuthConfig: vi.fn(),
    healthCheck: vi.fn(),
    getStatus: vi.fn(),
    state$: new BehaviorSubject<ConnectionState>('open').asObservable(),
    dispose: vi.fn(),
  } as unknown as ITransport;
}

function makeMockContent(): IContentTransport {
  return {
    putBinary: vi.fn(),
    getBinary: vi.fn(),
    getBinaryStream: vi.fn(),
    getResourceGraph: vi.fn(),
    putAnchoredText: vi.fn(),
    getAnchoredText: vi.fn(),
    listAnchoredTextKeys: vi.fn().mockResolvedValue([]),
    getAnchoredTextByChecksum: vi.fn().mockResolvedValue(null),
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
    it('emits browse:click with the annotationId alone (local bus)', () => {
      const bus = new EventBus();
      const spy = busSpy(bus, 'browse:click');
      const transport = makeMockTransport();
      const browse = new BrowseNamespace(transport, bus, makeMockContent());

      browse.click(AID);

      // No motivation: the id addresses exactly one annotation, and the viewer
      // derives the motivation from the annotation it names (TOUR-CLICK D2).
      // Carrying it too would state one fact twice on a wire that also carries
      // the id it comes from.
      expect(spy).toHaveBeenCalledExactlyOnceWith('browse:click', {
        annotationId: AID,
      });
      // NEVER the wire: browse:click is bridged (TOUR-CLICK P1), so a transport
      // emit here would broadcast this viewer's own click to every participant
      // — the D6 feedback loop. The wire path is `beckon.click()`.
      expect(transport.emit).not.toHaveBeenCalled();
    });
  });

  describe('browse.openResource', () => {
    it('emits browse:resource-open with the given resourceId (local bus)', () => {
      const bus = new EventBus();
      const spy = busSpy(bus, 'browse:resource-open');
      const transport = makeMockTransport();
      const browse = new BrowseNamespace(transport, bus, makeMockContent());

      browse.openResource(RID);

      expect(spy).toHaveBeenCalledExactlyOnceWith('browse:resource-open', {
        resourceId: RID,
      });
      // NEVER the wire: `browse:resource-open` is bridged (GUIDED-TOUR P2),
      // so a transport emit here would broadcast this viewer's own click to
      // every participant — the D6 feedback loop. The wire path is
      // `beckon.openResource()` (SDK-REMOTE-SIGNALS).
      expect(transport.emit).not.toHaveBeenCalled();
    });
  });

  describe('browse.resourceViewed', () => {
    it('emits browse:resource-viewed over the TRANSPORT (wire) — the tour report, not a local signal', () => {
      // D6 (GUIDED-TOUR): the viewer REPORTS arrival so a remote guide can
      // branch on it. A local-bus emit would never leave the page; the
      // beckon:focus idiom (transport.emit) is the wire path.
      const bus = new EventBus();
      const transport = makeMockTransport();
      const browse = new BrowseNamespace(transport, bus, makeMockContent());

      browse.resourceViewed(RID);

      expect(transport.emit).toHaveBeenCalledExactlyOnceWith('browse:resource-viewed', {
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

      mark.request(resourceId('res-1'), selector, 'highlighting');

      expect(spy).toHaveBeenCalledExactlyOnceWith('mark:requested', {
        source: resourceId('res-1'),
        selector,
        motivation: 'highlighting',
      });
    });
  });

  describe('beckon.sparkle', () => {
    it('emits beckon:sparkle with the given annotationId (local bus)', () => {
      const bus = new EventBus();
      const spy = busSpy(bus, 'beckon:sparkle');
      const transport = makeMockTransport();
      const beckon = new BeckonNamespace(transport, bus);

      beckon.sparkle(AID);

      expect(spy).toHaveBeenCalledExactlyOnceWith('beckon:sparkle', { annotationId: AID });
      // NEVER the wire: the just-created-annotation affordance is this
      // viewer's own. The wire path is `beckon.sparkleAll()`.
      expect(transport.emit).not.toHaveBeenCalled();
    });
  });

  // ── SDK-REMOTE-SIGNALS P2: the beckon wire drives ───────────────────────
  // These drive OTHER participants (the guided-tour moves) and resolve with
  // the subscriber count from /bus/emit (`-1` = unknown; ITransport.emit).

  describe('beckon.openResource (wire drive)', () => {
    it('emits browse:resource-open over the TRANSPORT and resolves the subscriber count', async () => {
      const bus = new EventBus();
      const localSpy = busSpy(bus, 'browse:resource-open');
      const transport = makeMockTransport();
      (transport.emit as ReturnType<typeof vi.fn>).mockResolvedValue(3);
      const beckon = new BeckonNamespace(transport, bus);

      await expect(beckon.openResource(RID)).resolves.toBe(3);

      expect(transport.emit).toHaveBeenCalledExactlyOnceWith('browse:resource-open', {
        resourceId: RID,
      });
      // The drive is for OTHER participants; it must not loop back locally
      // (arrivals come in bridged, like any remote emit).
      expect(localSpy).not.toHaveBeenCalled();
    });
  });

  describe('beckon.click (wire drive)', () => {
    it('emits browse:click over the TRANSPORT and resolves the subscriber count', async () => {
      const bus = new EventBus();
      const localSpy = busSpy(bus, 'browse:click');
      const transport = makeMockTransport();
      (transport.emit as ReturnType<typeof vi.fn>).mockResolvedValue(4);
      const beckon = new BeckonNamespace(transport, bus);

      await expect(beckon.click(AID)).resolves.toBe(4);

      expect(transport.emit).toHaveBeenCalledExactlyOnceWith('browse:click', {
        annotationId: AID,
      });
      // Same cross-namespace rule as openResource: `browse.click()` opens it
      // for me, `beckon.click()` opens it for everyone else. No audience
      // marker — beckon has no local `click` sibling to disambiguate from.
      expect(localSpy).not.toHaveBeenCalled();
    });
  });

  describe('beckon.sparkleAll (wire drive)', () => {
    it('emits beckon:sparkle over the TRANSPORT and resolves the subscriber count', async () => {
      const bus = new EventBus();
      const localSpy = busSpy(bus, 'beckon:sparkle');
      const transport = makeMockTransport();
      (transport.emit as ReturnType<typeof vi.fn>).mockResolvedValue(2);
      const beckon = new BeckonNamespace(transport, bus);

      await expect(beckon.sparkleAll(AID)).resolves.toBe(2);

      expect(transport.emit).toHaveBeenCalledExactlyOnceWith('beckon:sparkle', {
        annotationId: AID,
      });
      expect(localSpy).not.toHaveBeenCalled();
    });
  });

  describe('beckon.attention (wire drive)', () => {
    it('emits beckon:focus over the TRANSPORT and resolves the subscriber count', async () => {
      const bus = new EventBus();
      const transport = makeMockTransport();
      (transport.emit as ReturnType<typeof vi.fn>).mockResolvedValue(4);
      const beckon = new BeckonNamespace(transport, bus);

      await expect(beckon.attention(RID, AID)).resolves.toBe(4);

      expect(transport.emit).toHaveBeenCalledExactlyOnceWith('beckon:focus', {
        annotationId: AID,
        resourceId: RID,
      });
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

  describe('bind.reportBodyError', () => {
    it('emits bind:body-error with the given payload (local bus)', () => {
      // The client-local UI notification for a bind failure caught by a caller
      // with no toast surface (ReferenceEntry's unlink) — components must go
      // through this wrapper, never raw bus.get (audit-raw-bus.sh).
      const bus = new EventBus();
      const spy = busSpy(bus, 'bind:body-error');
      const bind = new BindNamespace(makeMockTransport(), bus);

      const payload = { resourceId: 'res-1', message: 'link is load-bearing' };
      bind.reportBodyError(payload);

      expect(spy).toHaveBeenCalledExactlyOnceWith('bind:body-error', payload);
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
        source: 'res-1',
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

});
