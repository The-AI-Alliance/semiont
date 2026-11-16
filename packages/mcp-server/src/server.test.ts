/**
 * The wiring, driven end-to-end: a real MCP `Client` speaks to `createServer`
 * over a linked in-memory transport pair, so requests go through the protocol
 * layer rather than calling the handlers directly.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer, SERVER_INFO } from './server.js';
import { TOOLS } from './tools.js';
import { createStub } from './__fixtures__/stub-client.js';

let open: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(open.map(close => close()));
  open = [];
});

async function connect() {
  const { client: semiont, ...namespaces } = createStub();
  const server = createServer(semiont);
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  open.push(async () => { await client.close(); await server.close(); });

  return { client, ...namespaces };
}

describe('createServer', () => {
  it('advertises the server name and version', async () => {
    const { client } = await connect();

    expect(client.getServerVersion()).toMatchObject(SERVER_INFO);
  });

  it('serves the tool catalogue over tools/list', async () => {
    const { client } = await connect();

    const { tools } = await client.listTools();

    expect(tools.map(t => t.name)).toEqual(TOOLS.map(t => t.name));
  });

  it('routes tools/call to the handler and returns its text block', async () => {
    const { client, browse } = await connect();

    const result = await client.callTool({
      name: 'browse_resources',
      arguments: { search: 'ontology', limit: 5 },
    });

    expect(browse.resources).toHaveBeenCalledWith({ search: 'ontology', limit: 5, archived: false });
    expect(result.content).toEqual([
      { type: 'text', text: 'Found 1 resources:\n- The Iliad (res-iliad) — Book, Poem' },
    ]);
    expect(result.isError).toBeUndefined();
  });

  it('answers an unknown tool with an error result, not a protocol error', async () => {
    const { client } = await connect();

    const result = await client.callTool({ name: 'semiont_hello', arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'Error: Unknown tool: semiont_hello' }]);
  });

  it('serves empty resource and prompt lists', async () => {
    const { client } = await connect();

    expect((await client.listResources()).resources).toEqual([]);
    expect((await client.listPrompts()).prompts).toEqual([]);
  });
});
