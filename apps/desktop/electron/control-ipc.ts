import { type WebContents } from 'electron';
import { isObject } from '@semiont/core';
import { ControlRequestError, type ControlCall, type ControlClient } from './control-client';
import { isControlMethod } from './control-schemas';
import type { ControlMethod } from './control-types.gen';
import {
  controlEventChannel,
  type ControlEvent,
  type ControlHandle,
  type ControlOutcome,
} from '../src/lib/launcher-bridge';
import { handleTrustedIpc, onTrustedIpc } from './ipc-security';

/** Serve the renderer's control requests (`window.launcherBridge.startControl` and
 *  `cancelControl`, src/lib/launcher-bridge.ts) through `client`. A request's notifications and
 *  its answer go to the window that sent it, on its handle's channel; a window that closes or
 *  loads another page gives up the requests it sent. */
export function registerControlHandlers(client: ControlClient): void {
  const forwarded = new Map<WebContents, Map<ControlHandle, ControlCall<ControlMethod>>>();

  const callsOf = (sender: WebContents): Map<ControlHandle, ControlCall<ControlMethod>> => {
    const known = forwarded.get(sender);
    if (known !== undefined) return known;
    const calls = new Map<ControlHandle, ControlCall<ControlMethod>>();
    forwarded.set(sender, calls);
    const giveUpAll = (reason: string): void => {
      for (const [handle, call] of calls) {
        calls.delete(handle);
        call.cancel(reason);
      }
    };
    sender.on('did-navigate', () => giveUpAll('the window that sent it loaded another page'));
    sender.once('destroyed', () => {
      giveUpAll('the window that sent it closed');
      forwarded.delete(sender);
    });
    return calls;
  };

  handleTrustedIpc('control:start', (event, handle: unknown, method: unknown, params: unknown) => {
    if (typeof handle !== 'number' || !isControlMethod(method) || !isObject(params)) {
      throw new Error('control:start takes a request handle, a control method and its params');
    }
    const sender = event.sender;
    const calls = callsOf(sender);
    if (calls.has(handle)) throw new Error(`control request ${handle} is in flight already`);
    const channel = controlEventChannel(handle);
    const deliver = (controlEvent: ControlEvent<ControlMethod>): void => {
      if (calls.get(handle) === call && !sender.isDestroyed()) sender.send(channel, controlEvent);
    };
    const call = client.request(method, params, (notice) => deliver({ kind: 'notification', notice }));
    calls.set(handle, call);
    void outcomeOf(call).then((outcome) => {
      deliver({ kind: 'answer', outcome });
      if (calls.get(handle) === call) calls.delete(handle);
    });
  });

  onTrustedIpc('control:cancel', (event, handle: unknown, reason: unknown) => {
    if (typeof handle !== 'number' || typeof reason !== 'string') {
      throw new Error('control:cancel takes a request handle and why it is given up');
    }
    // Not found: answered already, and an answered request has nothing to cancel.
    forwarded.get(event.sender)?.get(handle)?.cancel(reason);
  });
}

async function outcomeOf<M extends ControlMethod>(call: ControlCall<M>): Promise<ControlOutcome<M>> {
  try {
    return { ok: true, result: await call.answer };
  } catch (error) {
    if (error instanceof ControlRequestError) return { ok: false, error: error.failure };
    throw error;
  }
}
