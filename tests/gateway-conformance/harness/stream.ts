/**
 * A bus-stream client. It opens `POST /bus/subscribe`, parses the
 * Server-Sent Events as they arrive, and checks every message against the
 * spec as it goes: the message against `BusStreamMessage` (with `data`
 * parsed), and the id against the frame it names — a persisted id exactly
 * when the frame is scoped and its payload carries a sequence number, a
 * reply id exactly when it carries a correlationId — and that the stream
 * came as `text/event-stream`. A case reads `violations` at the end; any
 * entry is a failure whatever the case was about.
 */
import { errorsOf, spec } from './spec';

export interface BusFrame {
  channel: string;
  correlationId?: string;
  payload: Record<string, unknown>;
  scope?: string;
}

export interface StreamMessage {
  event: string;
  id: string | undefined;
  data: string;
  frame: BusFrame | undefined;
  at: number;
}

export interface SubscribeBody {
  clientId: string;
  global?: string[];
  scoped?: Array<{ scope: string; channels: string[]; lastEventId?: string }>;
  pendingReplies?: string[];
}

export class BusStream {
  readonly messages: StreamMessage[] = [];
  readonly violations: string[] = [];
  private waiters: Array<() => void> = [];
  private listeners: Array<(message: StreamMessage) => void> = [];
  private ended = false;
  readonly done: Promise<void>;

  constructor(
    body: ReadableStream<Uint8Array>,
    private readonly controller: AbortController,
  ) {
    this.done = this.read(body);
  }

  private async read(body: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = '';
    let event = '';
    let id: string | undefined;
    let data: string[] = [];
    let sawData = false;
    try {
      const reader = body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          if (line === '') {
            if (event || sawData) this.accept(event || 'message', id, data.join('\n'));
            event = '';
            id = undefined;
            data = [];
            sawData = false;
            continue;
          }
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'event') event = value;
          else if (field === 'id') id = value;
          else if (field === 'data') {
            data.push(value);
            sawData = true;
          }
        }
      }
    } catch {
      // Aborted by `close()`, or the gateway closed the connection.
    } finally {
      this.ended = true;
      this.wake();
    }
  }

  private accept(event: string, id: string | undefined, data: string): void {
    let frame: BusFrame | undefined;
    let parsed: unknown = data;
    if (event === 'bus-event') {
      try {
        parsed = JSON.parse(data);
        frame = parsed as BusFrame;
      } catch {
        this.violations.push(`a bus-event whose data is not JSON: ${data.slice(0, 200)}`);
      }
    }
    const message = { event, ...(id === undefined ? {} : { id }), data: parsed };
    const validate = spec().component('BusStreamMessage');
    if (!validate(message)) {
      this.violations.push(`a message that is not a BusStreamMessage (${errorsOf(validate)}): ${JSON.stringify(message).slice(0, 300)}`);
    }
    if (frame && id !== undefined) {
      const sequence = (frame.payload?.['metadata'] as { sequenceNumber?: unknown } | undefined)?.sequenceNumber;
      const persisted = frame.scope !== undefined && typeof sequence === 'number';
      if (persisted && id !== `p-${frame.scope}-${sequence}`) {
        this.violations.push(`a persisted frame (scope ${frame.scope}, sequence ${sequence}) carried id ${id}`);
      } else if (!persisted && frame.correlationId !== undefined && id !== `e-${frame.channel}:${frame.correlationId}`) {
        this.violations.push(`a reply on ${frame.channel} carried id ${id}, not e-${frame.channel}:${frame.correlationId}`);
      } else if (!persisted && frame.correlationId === undefined && !spec().component('EphemeralEventId')(id)) {
        this.violations.push(`a frame on ${frame.channel} with no correlationId carried id ${id}`);
      }
    }
    const received: StreamMessage = { event, id, data, frame, at: Date.now() };
    this.messages.push(received);
    for (const listener of this.listeners) listener(received);
    this.wake();
  }

  /** Call `listener` for every message from now on. */
  on(listener: (message: StreamMessage) => void): void {
    this.listeners.push(listener);
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  /** Whether the connection has ended — closed by either side. */
  get closed(): boolean {
    return this.ended;
  }

  frames(channel?: string): BusFrame[] {
    return this.messages.flatMap((m) => (m.frame && (channel === undefined || m.frame.channel === channel) ? [m.frame] : []));
  }

  /** The first message, at or after index `from`, that `match` accepts. */
  async next(what: string, match: (m: StreamMessage) => boolean, timeoutMs = 10_000, from = 0): Promise<StreamMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.slice(from).find(match);
      if (found) return found;
      if (this.ended) throw new Error(`the stream ended before ${what}`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** The first frame on `channel` that `match` accepts. */
  async frame(channel: string, match: (f: BusFrame) => boolean = () => true, timeoutMs = 10_000): Promise<BusFrame> {
    const m = await this.next(`a frame on ${channel}`, (m) => m.frame?.channel === channel && match(m.frame), timeoutMs);
    return m.frame!;
  }

  /** Resolves once the connection has ended, or fails after `timeoutMs`. */
  async ends(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.ended) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`the stream was still open after ${timeoutMs} ms`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /**
   * Nothing matching ever arrives on `channel`: after waiting `ms` for
   * anything still in flight, no frame the stream has carried since it
   * opened matches.
   */
  async quiet(channel: string, ms: number, match: (f: BusFrame) => boolean = () => true): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
    const arrived = this.messages.filter((m) => m.frame?.channel === channel && match(m.frame));
    if (arrived.length > 0) throw new Error(`expected nothing on ${channel}, got ${JSON.stringify(arrived.map((m) => m.frame))}`);
  }

  close(): void {
    this.controller.abort();
  }
}

export interface SubscribeResult {
  status: number;
  headers: Headers;
  /** Present when the gateway answered 200. */
  stream: BusStream | undefined;
  /** The body, when it answered anything else. */
  text: string | undefined;
}

export async function subscribe(origin: string, token: string | undefined, body: unknown): Promise<SubscribeResult> {
  const controller = new AbortController();
  const res = await fetch(`${origin}/bus/subscribe`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal: controller.signal,
  });
  if (res.status !== 200 || !res.body) {
    return { status: res.status, headers: res.headers, stream: undefined, text: await res.text() };
  }
  const stream = new BusStream(res.body, controller);
  const type = res.headers.get('content-type') ?? '';
  if (type.split(';')[0]!.trim() !== 'text/event-stream') stream.violations.push(`a stream that came as ${JSON.stringify(type)}, not text/event-stream`);
  return { status: res.status, headers: res.headers, stream, text: undefined };
}
