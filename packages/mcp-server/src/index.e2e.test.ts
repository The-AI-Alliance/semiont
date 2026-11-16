/**
 * The entry point, as a process.
 *
 * `index.ts` is the one module unit tests cannot import — reading it boots a
 * stdio server that never returns. So this drives the real binary over its real
 * transport: spawn it, speak JSON-RPC on stdin/stdout, and check it answers.
 * Nothing here reaches the network; `tools/list` is served from `TOOLS`.
 *
 * Coverage instrumentation does not cross the process boundary, so `index.ts`
 * still reports as uncovered — the assertions below are what actually hold it.
 */

import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { TOOLS } from './tools.js';

const ENV = {
  SEMIONT_API_URL: 'http://localhost:4000',
  SEMIONT_ACCESS_TOKEN: 'e2e-token',
};

function launch(env: Record<string, string>): ChildProcessWithoutNullStreams {
  return spawn('npx', ['tsx', 'src/index.ts'], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Speak one MCP conversation to a freshly spawned server: initialize, then the
 * caller's request. Resolves with that request's result.
 */
function request(method: string, params: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = launch(ENV);
    const done = (fn: () => void) => { child.kill(); fn(); };

    const send = (msg: unknown) => child.stdin.write(JSON.stringify(msg) + '\n');
    let buffered = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      let cut: number;
      while ((cut = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, cut).trim();
        buffered = buffered.slice(cut + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method, params });
        } else if (msg.id === 2) {
          done(() => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
        }
      }
    });
    child.on('error', (err) => done(() => reject(err)));

    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } },
    });
  });
}

describe('the server process', () => {
  it('serves the tool catalogue over stdio', async () => {
    const result = await request('tools/list', {});

    expect(result.tools.map((t: { name: string }) => t.name)).toEqual(TOOLS.map(t => t.name));
  }, 60_000);

  it('dispatches a tools/call without reaching the network', async () => {
    const result = await request('tools/call', { name: 'semiont_hello', arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'Error: Unknown tool: semiont_hello' }]);
  }, 60_000);

  it('refuses to start without its environment', async () => {
    const child = launch({ SEMIONT_API_URL: '', SEMIONT_ACCESS_TOKEN: '' });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    const code = await new Promise<number | null>(resolve => child.on('exit', resolve));

    expect(code).toBe(1);
    expect(stderr).toContain('SEMIONT_API_URL environment variable is required');
  }, 60_000);
});
