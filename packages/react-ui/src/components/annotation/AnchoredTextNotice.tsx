'use client';

import { useTranslations } from '../../contexts/TranslationContext';
import type { AnchoredTextState } from '../../hooks/useAnchoredText';

/**
 * The line a person is shown while a viewer may not annotate for want of the
 * resource's text: that the viewer is waiting for the text, or that there
 * will be none. Nothing while the viewer holds the text, and nothing with no
 * session, where there is nobody to annotate.
 *
 * The line is its own component so that translations are read only when
 * there is a line: a canvas mounted with no session, to paint and nothing
 * else, needs no `TranslationProvider` for a line it never shows.
 */
export function AnchoredTextNotice({ status }: { status: AnchoredTextState['status'] }) {
  if (status === 'held' || status === 'unasked') return null;
  return <AnchoredTextLine status={status} />;
}

function AnchoredTextLine({ status }: { status: 'waiting' | 'never' }) {
  const t = useTranslations('PdfViewer');
  return (
    <div className="semiont-anchored-text-notice" data-anchored-text={status} role="status">
      {t(status === 'waiting' ? 'preparingTextLayer' : 'textLayerUnreadable')}
    </div>
  );
}
