/**
 * Main-pane layout policy: when a document is open BESIDE an active chat and the pane is
 * wide enough for both, they split; otherwise the document takes precedence over the chat
 * (the original swap). Pure — the component measures, this decides.
 */

/** The chat column never goes below this (bubbles stay readable). */
export const CHAT_MIN = 420;
/** The document column never goes below this (PDF/image viewers stay usable). */
export const DOC_MIN = 360;
/** First-run document-pane width, before the user drags the divider. */
export const DOC_DEFAULT = 520;

export type MainLayout = 'chat' | 'doc' | 'split';

export function mainLayout(opts: { docOpen: boolean; chatActive: boolean; containerWidth: number }): MainLayout {
  if (opts.docOpen && opts.chatActive && opts.containerWidth >= CHAT_MIN + DOC_MIN) return 'split';
  if (opts.docOpen) return 'doc';
  return 'chat';
}

/** Divider drag clamp: the doc pane keeps DOC_MIN, the chat keeps CHAT_MIN — after the
 *  grid's 1px divider column is paid for. */
export function clampDocWidth(width: number, containerWidth: number): number {
  return Math.max(DOC_MIN, Math.min(width, containerWidth - CHAT_MIN - 1));
}
