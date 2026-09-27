/**
 * Create Resource Route
 *
 * An upload is multipart/form-data, and the gateway forwards it untouched to
 * the Archivist — the KB tree's one writer — which stores the bytes and
 * records the resource (the user's ruling on GATEWAY-SIMPLIFY S3, 2026-09-27:
 * "(a) Archivist records it"). The gateway authenticates the caller, names
 * them to the Archivist, and answers 202 with the new resource's id; it
 * neither parses the upload nor makes a bus request. The frontend navigates
 * by the id and reconciles full state from the SSE domain events.
 */

import type { ResourcesRouterType } from '../shared';
import { recordUpload } from '../../../lib/archivist';
import { compositionFor, SignalPlaneUnavailable } from '../../../signal';
import { profileOnce } from '../../../identity/person-profile';
import { SpanKind, withSpan, withTraceparent } from '@semiont/observability';
import type { components } from '@semiont/core';

type CreateResourceResponse = components['schemas']['CreateResourceResponse'];

export function registerCreateResource(router: ResourcesRouterType) {
  router.post('/resources', async (c) => {
    const principal = c.get('principal');

    // Tier 2: parent the server span on the client transport's traceparent
    // header (sent by HttpContentTransport.putBinary).
    const traceparent = c.req.header('traceparent');
    const tracestate = c.req.header('tracestate');
    const carrier = traceparent
      ? (tracestate ? { traceparent, tracestate } : { traceparent })
      : undefined;

    const resourceId = await withTraceparent(carrier, () =>
      withSpan(
        'content.put.server',
        () =>
          recordUpload(
            c.get('archivist'),
            { body: c.req.raw.body, contentType: c.req.header('content-type') ?? '' },
            { did: principal.did, roles: principal.roles ?? [] },
          ),
        { kind: SpanKind.SERVER, attrs: {} },
      ),
    );

    // A recorded upload is a write, whichever command the Archivist issued for
    // it, so the person who made it is named on the record (PERSON-PROFILE
    // D3) — once it is recorded: an upload refused wrote nothing. The upload
    // stands whether or not the plane can carry the name.
    try {
      profileOnce(principal, (ch, p) => compositionFor(c.get('eventBus')).plane.ingest(ch, p));
    } catch (error) {
      if (!(error instanceof SignalPlaneUnavailable)) throw error;
      c.get('logger').warn('[bus PROFILE-DROPPED] the signal plane could not carry an uploader\'s name', { did: principal.did });
    }

    const response: CreateResourceResponse = { resourceId };
    return c.json(response, 202);
  });
}
