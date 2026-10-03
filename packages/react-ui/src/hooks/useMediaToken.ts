import { useEffect, useState } from 'react';
import type { ResourceId } from '@semiont/core';
import type { SemiontClient } from '@semiont/sdk';

export interface UseMediaTokenResult {
  token: string | undefined;
  loading: boolean;
}

/** A settled mint, held with the inputs it was made for. No token: the mint failed. */
interface Minted {
  client: SemiontClient;
  id: ResourceId;
  token: string | undefined;
}

/**
 * Mint (and periodically refresh) a short-lived authed media token for a
 * resource — the query param that makes `<img>` / PDF URLs load. Takes the
 * client explicitly (not `useSemiont()`), so a bring-your-own-session host can
 * use it with a bare session; the batteries-included page passes `session.client`.
 */
export function useMediaToken(client: SemiontClient | null, id: ResourceId): UseMediaTokenResult {
  const [minted, setMinted] = useState<Minted | null>(null);
  // `auth` is only constructed when the client was given an IGatewayOperations
  // — a host on a bare transport has none, and cannot mint tokens at all.
  const auth = client?.auth;

  useEffect(() => {
    if (!client || !auth || !id) return;
    let cancelled = false;
    auth.mediaToken(id)
      .then(({ token }) => { if (!cancelled) setMinted({ client, id, token }); })
      .catch(() => { if (!cancelled) setMinted({ client, id, token: undefined }); });

    const refreshInterval = setInterval(() => {
      auth.mediaToken(id)
        .then(({ token }) => { if (!cancelled) setMinted({ client, id, token }); })
        .catch(() => {});
    }, 4 * 60 * 1000);

    return () => {
      cancelled = true;
      clearInterval(refreshInterval);
      // The loop above is what keeps a served token fresh. When it stops the
      // token goes with it: if these same inputs come back later, a token
      // minted before the gap may have expired.
      setMinted(null);
    };
  }, [client, auth, id]);

  if (!client || !auth || !id) return { token: undefined, loading: false };

  // A mint answers only for the client and resource it was made for, and that
  // is checked HERE, during render. Tokens are per-resource, so on an id change
  // the old one is WRONG, not merely stale; and on a client that can no longer
  // mint, a leftover token would keep media URLs alive for 5 minutes and then
  // break them all at once with nothing explaining why. State cleared in the
  // effect arrives one render late — a frame in which a caller builds a URL
  // for the new resource carrying the previous one's token.
  if (minted === null || minted.client !== client || minted.id !== id) {
    return { token: undefined, loading: true };
  }

  return { token: minted.token, loading: false };
}
