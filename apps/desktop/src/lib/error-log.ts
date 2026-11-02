/**
 * Route renderer errors to the XDG `log.txt` (via `window.logBridge`, backed by the main
 * process) so failures in the packaged Electron app are diagnosable without devtools. Wraps
 * `console.error` and captures uncaught errors + unhandled promise rejections. No-op on the
 * web build (no bridge). Install once at startup, before rendering.
 */
function serialize(parts: unknown[]): string {
  return parts
    .map((p) => {
      if (p instanceof Error) return `${p.name}: ${p.message}${p.stack ? `\n${p.stack}` : ''}`;
      if (typeof p === 'string') return p;
      try {
        return JSON.stringify(p);
      } catch {
        return String(p);
      }
    })
    .join(' ');
}

export function installErrorLog(): void {
  const bridge = typeof window !== 'undefined' ? window.logBridge : undefined;
  if (!bridge) return; // web build — nothing to write to

  const write = (level: string, parts: unknown[]): void => {
    try {
      bridge.append(`${new Date().toISOString()} [${level}] ${serialize(parts)}`);
    } catch {
      // logging must never throw
    }
  };

  const originalError = console.error.bind(console);
  console.error = (...args: unknown[]): void => {
    write('error', args);
    originalError(...args);
  };

  window.addEventListener('error', (e) => write('uncaught', [e.message, e.error]));
  window.addEventListener('unhandledrejection', (e) => write('unhandledrejection', [e.reason]));

  write('info', ['renderer started']);
}
