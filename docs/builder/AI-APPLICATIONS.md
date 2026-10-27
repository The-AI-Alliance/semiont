# Connecting an AI application

An AI application that speaks the Model Context Protocol (MCP), such as Claude Code, Claude Desktop or any other MCP client, reaches the knowledge bases you have signed in to through `semiont mcp`, the launcher's MCP server. It runs on your machine, talks to the application over stdio, and acts as you. No token goes into any configuration file.

## Set it up

1. Sign in to each knowledge base once, as the [Quick Start](./QUICK-START.md#6-sign-in) does:

   ```bash
   semiont login
   ```

   A codespace's knowledge base is signed in to by its repository:

   ```bash
   semiont login --repo <owner/name>
   ```

2. Add the server to the application. In Claude Code:

   ```bash
   claude mcp add semiont -- semiont mcp
   ```

   In any other MCP client, the server's entry in the client's configuration:

   ```json
   {
     "mcpServers": {
       "semiont": { "command": "semiont", "args": ["mcp"] }
     }
   }
   ```

   An application that does not find `semiont` on its own `PATH` is given the full path that `which semiont` prints.

## What it serves

- **Every knowledge base you have signed in to**, local and codespace alike. The `knowledge_bases` tool lists them, each with the key every other tool takes as its `kb` argument: `local`, or `codespace:<owner>/<name>`. With one knowledge base signed in, `kb` may be left out. With several, a call names one, and one that names none is refused, naming them.
- **Tools named by the [eight verbs](../protocol/flows/README.md)**: `browse_…`, `match_…` and `gather_…` read; `mark_…`, `bind_link`, `yield_…` and `frame_…` write; `beckon_attention` draws the attention of whoever is watching in a Browser; `job_status` and `job_cancel` follow the work the stack does. Each tool's arguments and result are the spec's, and the application reads them from the tool's schema. The set is curated around what an agent does in a knowledge base, not one tool per SDK method: [`mcp-tools.json`](../../apps/launcher/internal/verbs/mcp-tools.json) names the methods each tool calls, and each method left out with the reason.
- **The knowledge bases' resources**, as MCP resources named `semiont://kb/<key>/resources/<id>`. A tool that names a resource links to it.

## How a call behaves

- **Its arguments are checked before anything is sent.** A call that breaks its tool's schema is refused with every fault named at once, so the model can correct it. Nothing the call did not state is sent: where the SDK states what a call that states nothing sends, the SDK sends that, as every SDK does.
- **Work the stack does waits for its job.** `mark_delegate` and `yield_generate` answer the job's completion, with its progress as notifications when the application asks for them. Cancelling the call cancels the job. `job_status` reads a job later, and only one of your own.
- **The session renews itself.** When it cannot be renewed, a tool answers with an error that names `semiont login`, and the server stays up for the knowledge bases still signed in. A codespace whose forward to this machine is down is answered with `semiont status --repo <owner/name>`, which brings the forward back.
- **Both revisions of the protocol are served:** a 2026-07-28 client and an older one that initializes a session. The server logs to stderr, where the application keeps its logs.

## What it is not

- **Not a remote endpoint.** It serves the machine you signed in on, over stdio.
- **Not a separate identity.** What an application writes through it is attributed to you, as anything you write is: people and AI agents are the same kind of participant.
- **Not the [agent skills](./skills/README.md).** The skills help an AI coding assistant write a program on the SDK; `semiont mcp` lets an AI application work in a knowledge base itself.

The launcher's own account of the server is in its [README](../../apps/launcher/README.md#serving-ai-applications-over-mcp).
