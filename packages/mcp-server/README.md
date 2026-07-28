# Semiont MCP Server

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+mcp-server%22)

This Model Context Protocol (MCP) server provides AI applications with access to the Semiont API using the common `@semiont/http-transport`.

## Features

Ten MCP tools, named by flow:

- **browse** — read resources, their highlights, and their references
- **mark** — create annotations, or have an LLM detect them
- **bind** — link a reference annotation to its target resource
- **gather** — assemble LLM context for an annotation
- **yield** — create a resource from content, or generate one from an annotation

See [Available tools](#available-tools) for each tool's parameters.

## Architecture

The MCP server uses the `@semiont/sdk` `SemiontClient` (over `@semiont/http-transport` HTTP transports) to communicate with the Semiont backend:

```typescript
import { SemiontClient } from '@semiont/sdk';
import { HttpTransport, HttpContentTransport } from '@semiont/http-transport';
import { baseUrl, accessToken, type AccessToken } from '@semiont/core';
import { BehaviorSubject } from 'rxjs';

// HTTP transports carry the observable access token
const token$ = new BehaviorSubject<AccessToken | null>(accessToken(SEMIONT_ACCESS_TOKEN));
const transport = new HttpTransport({ baseUrl: baseUrl(SEMIONT_API_URL), token$ });
const semiont = new SemiontClient(transport, new HttpContentTransport(transport), transport);

// All handlers receive the client instance and call its verb namespaces
async function browseResources(semiont: SemiontClient, args: any) {
  const resources = await semiont.browse.resources({ limit: args.limit });

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(resources, null, 2),
    }],
  };
}
```

**Key Benefits:**
- **Type-Safe**: Full TypeScript types from OpenAPI specification
- **Common Client**: Same client used by demo scripts and other external consumers
- **No Duplication**: Reuses authentication, retry logic, and error handling
- **Maintainable**: Changes to the API client benefit all consumers

## Installation

```bash
cd packages/mcp-server
npm install
npm run build
```

## Authentication

The server needs exactly two environment variables:

| Variable | Meaning |
|---|---|
| `SEMIONT_API_URL` | Backend base URL, e.g. `http://localhost:4000` |
| `SEMIONT_ACCESS_TOKEN` | A bearer access token |

Both are required — the process exits at startup if either is missing.

`semiont login` obtains a token against a running stack. It authenticates an
existing account, so a fresh stack needs one created first:

```bash
semiont useradd --email you@example.com --admin
semiont login --email you@example.com     # password read from stdin
```

Both read the password from stdin — prompted with echo off on a terminal, or
piped (`echo "$PASSWORD" | semiont login --email you@example.com`) for scripts.

The token lands in the launcher's state home, mode 0600:
`~/Library/Application Support/semiont/tokens.json` on macOS,
`$XDG_STATE_HOME/semiont/tokens.json` on Linux (`~/.local/state/semiont/` when
that variable is unset). Entries are keyed by stack — `local` for a local
stack, `codespace:<owner>/<name>` for a codespace. Read the `token` field for
your stack's key and export it:

```bash
export SEMIONT_API_URL=http://localhost:4000
export SEMIONT_ACCESS_TOKEN=$(python3 -c \
  "import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]]['token'])" \
  ~/Library/Application\ Support/semiont/tokens.json local)
```

**Access tokens are short-lived and this server does not refresh them.** It
holds a `SemiontClient` over a fixed token for the life of the process, so a
long-running session stops working when the token expires and the process must
be restarted with a fresh one. For anything long-running, prefer a
`SemiontSession` (`@semiont/sdk`), which refreshes; see
[the SDK README](../sdk/README.md).

## Usage

### Claude Desktop

Add the built server to your Claude Desktop configuration, passing the two
environment variables:

```json
{
  "mcpServers": {
    "semiont": {
      "command": "node",
      "args": ["/absolute/path/to/semiont/packages/mcp-server/dist/index.js"],
      "env": {
        "SEMIONT_API_URL": "http://localhost:4000",
        "SEMIONT_ACCESS_TOKEN": "<your access token>"
      }
    }
  }
}
```

The stack must be running (`semiont start`) for the server to reach the backend.

### Programmatic usage

```javascript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['packages/mcp-server/dist/index.js'],
  env: {
    ...process.env,
    SEMIONT_API_URL: 'http://localhost:4000',
    SEMIONT_ACCESS_TOKEN: process.env.SEMIONT_ACCESS_TOKEN,
  },
});

const client = new Client({ name: 'semiont-client', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);

const tools = await client.request({ method: 'tools/list' });

const result = await client.request({
  method: 'tools/call',
  params: {
    name: 'browse_resources',
    arguments: { search: 'ontology', limit: 5 },
  },
});

console.log(result);
```

## Available tools

Every tool answers with a single `text` content block. `browse_resource` and
`gather_annotation` return JSON; the rest return a short summary line. A tool
that fails answers the same way, with `isError` set.

### browse

| Tool | Required | Optional |
|---|---|---|
| `browse_resource` — get a resource with its annotations and references | `id` | |
| `browse_resources` — list resources | | `search`, `archived` (default `false`), `limit` (default `20`) |
| `browse_highlights` — highlighting annotations for a resource | `resourceId` | |
| `browse_references` — linking annotations for a resource | `resourceId` | |

### mark

| Tool | Required | Optional |
|---|---|---|
| `mark_annotation` — create an annotation (highlight, comment, reference, tag) | `resourceId`, `selectionData` (`{offset, length, text}`) | `entityTypes` |
| `mark_assist` — AI-assisted annotation: detect entities, highlights, assessments, comments, or tags | `resourceId` | `entityTypes`, `language`, `sourceLanguage` |

`language` is a BCP-47 tag for what the LLM writes (stamped on `TextualBody.language`); `sourceLanguage` describes the source resource and feeds the prompt.

### bind

| Tool | Required |
|---|---|
| `bind_body` — link a reference annotation to a target resource | `sourceResourceId`, `annotationId`, `targetResourceId` |

### gather

| Tool | Required | Optional |
|---|---|---|
| `gather_annotation` — gather LLM context for an annotation (passage + graph context) | `resourceId`, `annotationId` | `contextWindow` (default `2000`) |

### yield

| Tool | Required | Optional |
|---|---|---|
| `yield_resource` — create a resource from content | `name`, `content`, `storageUri` | `entityTypes`, `contentType` (default `text/plain`) |
| `yield_from_annotation` — generate a resource from an annotation using AI | `resourceId`, `annotationId`, `storageUri` | `title` (default `Generated`), `prompt`, `language`, `sourceLanguage` |

`storageUri` looks like `file://docs/my-resource.md`.

## Development

```bash
npm run dev              # tsx src/index.ts — no build step
npm run build            # tsc
npm start                # node dist/index.js
npm test                 # vitest run
npm run test:coverage
```

`dev` and `start` both need `SEMIONT_API_URL` and `SEMIONT_ACCESS_TOKEN` in the
environment.

## Testing the MCP Server

```bash
SEMIONT_API_URL=http://localhost:4000 \
SEMIONT_ACCESS_TOKEN="$SEMIONT_ACCESS_TOKEN" \
npx @modelcontextprotocol/inspector node packages/mcp-server/dist/index.js
```

The inspector opens a web interface listing the registered tools, where you can
call one and see the request and response.

## Extending the server

Adding a tool takes three edits, all in `src/`:

1. A tool definition in `TOOLS` ([`src/tools.ts`](src/tools.ts)) — the `tools/list` payload
2. The handler in [`src/handlers.ts`](src/handlers.ts), taking `(semiont: McpClient, args)` and returning `McpResult`
3. A `case` in `callTool` (same file) routing the tool name to that handler

[`src/index.ts`](src/index.ts) is wiring only — config, transports, and the four
request handlers — so none of the above touches it.

Handlers call the client's verb namespaces — `semiont.browse.*`, `semiont.mark.*`,
and so on. They never construct HTTP requests: the transport, auth, and retry
behaviour belong to the client. `McpClient` names the slice of `SemiontClient`
the handlers use; widen it when a new handler needs another namespace method. If
the capability you need is not on `SemiontClient` yet, add it to `@semiont/sdk`
rather than reaching around it from here.

Then document the tool in [Available tools](#available-tools) above.

## Troubleshooting

**Startup fails immediately**

The process throws if `SEMIONT_API_URL` or `SEMIONT_ACCESS_TOKEN` is unset. In a
Claude Desktop config, they must be in the server entry's `env` block — the
desktop app does not inherit your shell environment.

**401 / authentication failed**

The access token expired. This server does not refresh tokens; get a new one
(`semiont login`) and restart the process. See [Authentication](#authentication).

**Connection refused**

```bash
semiont status     # is the stack up, and is the backend healthy?
```

Check that `SEMIONT_API_URL` matches the backend's port (4000 by default).

**Unknown tool**

Tool names are exactly the ten listed under [Available tools](#available-tools) —
flow-prefixed and snake_cased, e.g. `browse_resources`, not `browseResources`.

## Security notes

- Tokens are bearer credentials. Never commit them; keep them out of shell
  history and out of the repo.
- `semiont login` stores tokens at mode 0600 in the launcher's state home.
- Access tokens are short-lived by design. This server holds one for its
  lifetime and does not renew it — restart it with a fresh token rather than
  reaching for a longer-lived credential.
