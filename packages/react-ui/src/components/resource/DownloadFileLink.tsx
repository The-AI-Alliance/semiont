'use client';

import { resourceId as toResourceId } from '@semiont/core';
import type { SemiontSession } from '@semiont/sdk';
import { useMediaToken } from '../../hooks/useMediaToken';
import { mediaUrl } from '../../lib/media-url';

interface Props {
  /** The '@id' of the resource whose bytes to offer. */
  resourceUri: string;
  /** Session for that resource — its client mints the media token and supplies the backend origin. */
  session: SemiontSession | null;
}

/**
 * The "Download File" affordance on the unsupported-media fallback, shared by
 * the browse and annotate views.
 *
 * Its own component rather than inline markup for two reasons. The token is a
 * hook, and this fallback is a branch — mounting the component only in that
 * branch keeps every text/image/PDF view from minting a media token it will
 * never use. And the URL rule (absolute + `?token=`) lives in `mediaUrl`,
 * where both views and the viewer page read the same one.
 *
 * Before the token lands the anchor renders as a disabled button: a tokenless
 * URL is a guaranteed 401, and a link that silently fails is worse than one
 * visibly not ready yet. A client with no `auth` namespace (a host on a bare
 * transport) stays in that state permanently, which is the honest answer —
 * it cannot mint tokens at all.
 */
export function DownloadFileLink({ resourceUri, session }: Props) {
  const client = session?.client ?? null;
  const { token } = useMediaToken(client, toResourceId(resourceUri));
  const href = mediaUrl(client, toResourceId(resourceUri), token);

  if (!href) {
    return (
      <button type="button" disabled className="semiont-button semiont-button--primary semiont-button--disabled">
        Download File
      </button>
    );
  }

  return (
    <a href={href} download className="semiont-button semiont-button--primary">
      Download File
    </a>
  );
}
