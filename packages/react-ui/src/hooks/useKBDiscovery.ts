'use client';

/**
 * Browser ↔ launcher KB discovery — the react-ui binding (BROWSER-KB-DISCOVERY P4).
 *
 * Thin by design: the sdk's `subscribeDiscovery` owns every discovery
 * semantic (validation, version gate, absent taxonomy, diffing); this hook
 * owns only React lifecycle — `enabled` (pause-when-closed), document
 * visibility (pause-when-hidden), and unmount teardown — and holds the last
 * emitted `DiscoveryState`. The transport lives for the hook's lifetime, so
 * a pause/resume cycle reuses it and its remembered ETag can 304 on resume.
 * No merge policy here: react-ui owns no KB registry.
 */

import { useEffect, useMemo, useState } from 'react';
import { httpDiscovery, subscribeDiscovery } from '@semiont/sdk';
import type { DiscoveryState, DiscoveryTransport } from '@semiont/sdk';
import type { DiscoveredKB } from '@semiont/core';

export interface KBDiscoveryOptions {
  /** Pause entirely (e.g. the KB panel is closed). Default true. */
  enabled?: boolean;
  /** Poll interval, forwarded to the sdk subscription (sdk default applies when omitted). */
  intervalMs?: number;
  /** Transport override (tests, non-default URL). Default: same-origin `httpDiscovery()`. */
  transport?: DiscoveryTransport;
}

export interface KBDiscoveryResult {
  /**
   * Last known discovery state; `null` before the first emission. While
   * paused (disabled or hidden) the last known state is retained — a resumed
   * subscription's immediate poll replaces it promptly.
   */
  state: DiscoveryState | null;
  /** Convenience projection: the managed list, `[]` otherwise. */
  kbs: DiscoveredKB[];
}

export function useKBDiscovery(options?: KBDiscoveryOptions): KBDiscoveryResult {
  const enabled = options?.enabled ?? true;
  const intervalMs = options?.intervalMs;
  const externalTransport = options?.transport;

  // One transport per hook life (or per override change): httpDiscovery holds
  // the last good ETag, which must survive pause/resume to 304 on resume.
  const transport = useMemo(
    () => externalTransport ?? httpDiscovery(),
    [externalTransport],
  );

  const [visible, setVisible] = useState(
    () => typeof document === 'undefined' || !document.hidden,
  );
  const [state, setState] = useState<DiscoveryState | null>(null);

  useEffect(() => {
    const onVisibilityChange = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  useEffect(() => {
    if (!enabled || !visible) return;
    const subscription = subscribeDiscovery(
      transport,
      intervalMs !== undefined ? { intervalMs } : undefined,
    ).subscribe((diff) => setState(diff.state));
    return () => subscription.unsubscribe();
  }, [enabled, visible, transport, intervalMs]);

  return {
    state,
    kbs: state?.kind === 'managed' ? state.kbs : [],
  };
}
