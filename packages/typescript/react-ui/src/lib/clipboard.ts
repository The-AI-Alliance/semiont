/**
 * The page's Clipboard API, where it has one.
 *
 * A browser withholds `navigator.clipboard` from a page that is not a secure
 * context: one served over plain http from any host but localhost, which is
 * an origin the Browser is served from. So a copy control asks here, and
 * renders only where there is a clipboard to copy to: a control that fails
 * silently is worse than none.
 */
export function clipboard(): Clipboard | undefined {
  if (typeof navigator === 'undefined') return undefined;
  // The DOM types say it is always there. Outside a secure context it is not.
  const available: Clipboard | undefined = navigator.clipboard;
  return available;
}
