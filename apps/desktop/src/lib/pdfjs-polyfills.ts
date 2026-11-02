/**
 * Polyfill the recent TC39 methods pdf.js 6 hard-requires (i.e. uses without a feature-detect
 * fallback). A modern Chromium has them natively — so on an up-to-date Electron these are all
 * no-ops — but they keep the web build (and any lagging runtime) working:
 *   - `Uint8Array.prototype.toHex` / `toBase64`, `Uint8Array.fromBase64`   (Chrome ~140)
 *   - `Map`/`WeakMap.prototype.getOrInsert` / `getOrInsertComputed`         (Chrome ~140)
 *   - `Promise.try`                                                         (Chrome 134)
 * (`Float16Array` is NOT polyfilled — pdf.js feature-detects it and falls back to Float32Array.)
 *
 * Kept **self-contained** (no module-scope references) on purpose: the same function is
 * serialized via `toString()` and prepended to the pdf.js *worker* blob (see main.tsx), so the
 * worker's separate global gets the patch too. `btoa`/`atob` exist in both window and worker.
 */
export function installPdfjsPolyfills(): void {
  // Uint8Array ⇄ hex / base64
  const u8 = Uint8Array.prototype as unknown as {
    toHex?: () => string;
    toBase64?: (opts?: { alphabet?: string; omitPadding?: boolean }) => string;
  };
  const U8 = Uint8Array as unknown as { fromBase64?: (s: string, opts?: { alphabet?: string }) => Uint8Array };

  if (typeof u8.toHex !== 'function') {
    u8.toHex = function toHex(this: Uint8Array): string {
      let s = '';
      for (let i = 0; i < this.length; i++) s += this[i]!.toString(16).padStart(2, '0');
      return s;
    };
  }
  if (typeof u8.toBase64 !== 'function') {
    u8.toBase64 = function toBase64(this: Uint8Array, opts?: { alphabet?: string; omitPadding?: boolean }): string {
      let bin = '';
      for (let i = 0; i < this.length; i++) bin += String.fromCharCode(this[i]!);
      let b64 = btoa(bin);
      if (opts && opts.alphabet === 'base64url') b64 = b64.replace(/\+/g, '-').replace(/\//g, '_');
      if (opts && opts.omitPadding) b64 = b64.replace(/=+$/, '');
      return b64;
    };
  }
  if (typeof U8.fromBase64 !== 'function') {
    U8.fromBase64 = function fromBase64(str: string, opts?: { alphabet?: string }): Uint8Array {
      let s = opts && opts.alphabet === 'base64url' ? str.replace(/-/g, '+').replace(/_/g, '/') : str;
      while (s.length % 4) s += '=';
      const bin = atob(s);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    };
  }

  // Map / WeakMap getOrInsert(Computed)
  const protos = [Map.prototype, WeakMap.prototype] as unknown as Array<{
    has(k: unknown): boolean;
    get(k: unknown): unknown;
    set(k: unknown, v: unknown): unknown;
    getOrInsert?: (k: unknown, v: unknown) => unknown;
    getOrInsertComputed?: (k: unknown, cb: (k: unknown) => unknown) => unknown;
  }>;
  for (const proto of protos) {
    if (typeof proto.getOrInsert !== 'function') {
      proto.getOrInsert = function getOrInsert(key: unknown, value: unknown): unknown {
        if (this.has(key)) return this.get(key);
        this.set(key, value);
        return value;
      };
    }
    if (typeof proto.getOrInsertComputed !== 'function') {
      proto.getOrInsertComputed = function getOrInsertComputed(key: unknown, cb: (k: unknown) => unknown): unknown {
        if (this.has(key)) return this.get(key);
        const v = cb(key);
        this.set(key, v);
        return v;
      };
    }
  }

  // Promise.try
  const P = Promise as unknown as { try?: (fn: (...a: unknown[]) => unknown, ...args: unknown[]) => Promise<unknown> };
  if (typeof P.try !== 'function') {
    P.try = (fn: (...a: unknown[]) => unknown, ...args: unknown[]): Promise<unknown> =>
      new Promise((resolve) => resolve(fn(...args)));
  }
}
