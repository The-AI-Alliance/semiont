import { createServer } from 'node:http';

const CALLBACK_PATH = '/callback';

const page = (sentence: string) =>
  `<!doctype html><meta charset="utf-8"><title>Sign-in</title>` +
  `<body style="font:16px system-ui;margin:4rem auto;max-width:28rem"><p>${sentence}</p></body>`;

/**
 * Where an issuer sends a person back to after they sign in, when the application asking
 * is on their own machine (RFC 8252 §7.3): an address on the loopback interface, at a port
 * the system picks. Only software already on the machine can listen there, which is why an
 * issuer accepts any port for it.
 */
export interface LoopbackRedirect {
  /** The redirect address to state in the authorization request. */
  readonly redirectUri: string;
  /** The whole address the issuer sent the person back to, its query included. Rejects
   *  when `timeoutMs` passes, or the listener is closed, before anyone arrives. */
  readonly callbackUrl: Promise<string>;
  /** Stop listening. Safe to call more than once. */
  close(): void;
}

/** Listen for one sign-in to come back. */
export function openLoopbackRedirect(timeoutMs: number): Promise<LoopbackRedirect> {
  return new Promise((opened, failed) => {
    let arrived: (url: string) => void = () => {};
    let abandoned: (reason: Error) => void = () => {};
    const callbackUrl = new Promise<string>((resolve, reject) => {
      arrived = resolve;
      abandoned = reject;
    });
    // A close with nobody awaiting the address is not an unhandled rejection.
    callbackUrl.catch(() => {});

    let origin = '';
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', origin);
      if (url.pathname !== CALLBACK_PATH) {
        response.writeHead(404).end();
        return;
      }
      const refused = url.searchParams.has('error');
      response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(
          page(
            refused
              ? 'The sign-in did not complete. You can close this tab and return to the app.'
              : 'Signed in. You can close this tab and return to the app.',
          ),
        );
      arrived(url.href);
    });

    server.once('error', failed);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        failed(new Error('The sign-in listener has no port.'));
        return;
      }
      origin = `http://127.0.0.1:${address.port}`;
      const timer = setTimeout(() => abandoned(new Error('Nobody finished signing in.')), timeoutMs);
      let closed = false;
      opened({
        redirectUri: `${origin}${CALLBACK_PATH}`,
        callbackUrl,
        close: () => {
          if (closed) return;
          closed = true;
          clearTimeout(timer);
          abandoned(new Error('The sign-in was closed before it finished.'));
          server.close();
          server.closeAllConnections();
        },
      });
    });
  });
}
