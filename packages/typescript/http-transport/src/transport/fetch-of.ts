/**
 * The fetch a request is sent with: the one its caller gave, or the runtime's
 * own, looked up as each request is made. Either is called as a plain
 * function, never as a method of something else, which a browser refuses.
 */
export function fetchOf(given: typeof fetch | undefined): typeof fetch {
  return (...request: Parameters<typeof fetch>) => (given ?? globalThis.fetch)(...request);
}
