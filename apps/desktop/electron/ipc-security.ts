import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';

type RendererIpcEvent = IpcMainEvent | IpcMainInvokeEvent;

/** Reject IPC unless it came from the app's trusted top-level renderer frame. */
export function assertTrustedRenderer(event: RendererIpcEvent): void {
  if (event.sender.isDestroyed() || event.senderFrame === null || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('IPC request did not come from the Semiont Desktop main frame');
  }

  let frameUrl: URL;
  try {
    frameUrl = new URL(event.senderFrame.url);
  } catch {
    throw new Error('IPC request came from an invalid renderer URL');
  }

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl !== undefined) {
    try {
      const dev = new URL(devUrl);
      const isLoopback = dev.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(dev.hostname);
      if (isLoopback && frameUrl.origin === dev.origin) return;
    } catch {
      // An invalid development URL does not widen the IPC trust boundary.
    }
  } else if (
    frameUrl.protocol === 'semiont-app:' &&
    frameUrl.hostname === 'desktop' &&
    frameUrl.pathname === '/index.html'
  ) {
    return;
  }

  throw new Error('IPC request came from an untrusted renderer origin');
}

/** Register an invoke handler that is callable only by the trusted app frame. */
export function handleTrustedIpc<Args extends unknown[]>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: Args) => unknown,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedRenderer(event);
    return handler(event, ...(args as Args));
  });
}

/** Register a one-way handler that is callable only by the trusted app frame. */
export function onTrustedIpc<Args extends unknown[]>(
  channel: string,
  handler: (event: IpcMainEvent, ...args: Args) => void,
): void {
  ipcMain.on(channel, (event, ...args) => {
    assertTrustedRenderer(event);
    handler(event, ...(args as Args));
  });
}
