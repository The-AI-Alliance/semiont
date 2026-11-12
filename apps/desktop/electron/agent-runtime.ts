import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentHistoryMessage, AgentModelId, AgentToolEvent, AgentTurnResult } from '../src/lib/agent-bridge';

const MCP_VERSION = '2025-03-26';
const MAX_TOOL_ROUNDS = 6;
const MAX_TOOL_OUTPUT = 24_000;
const MCP_REQUEST_TIMEOUT_MS = 35_000;
const MODEL_TIMEOUT_MS = 240_000;

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  readOnly: boolean;
  destructive: boolean;
}

interface McpEnvelope {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: { message?: unknown };
  method?: unknown;
}

interface OllamaToolCall {
  function?: { name?: unknown; arguments?: unknown };
}

interface OllamaMessage {
  role?: unknown;
  content?: unknown;
  tool_calls?: unknown;
}

interface OllamaResponse {
  message?: OllamaMessage;
  error?: unknown;
}

interface RuntimeToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

interface RuntimeMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_name?: string;
  tool_calls?: Array<{ function: RuntimeToolCall }>;
}

const SYSTEM_PROMPT = `Semiont Desktop agent prompt v1. You are an assistant working in one Semiont Knowledge Base.

Semiont SDK concepts: a Knowledge Base is the scope of every operation; Resources hold durable content; Annotations express typed relations, spans, and provenance. Entity types classify Resources, while annotation motivations describe the relation. Use gather for grounded context, match to find candidates, and linking annotations when a reference is confirmed. Never invent resource or annotation identifiers. Treat tool results as the source of truth, and distinguish a suggestion from a completed write.

Use the available Semiont tools when useful. Desktop asks the user before any tool marked destructive. Do not claim to have changed anything unless the tool result confirms it.`;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function extractJsonRpcMessages(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n');
  return { lines: parts.slice(0, -1), rest: parts.at(-1) ?? '' };
}

class McpStdioClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private output = '';
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private closed = false;

  constructor(executable: string, env: NodeJS.ProcessEnv, cwd: string) {
    this.child = spawn(executable, ['mcp'], { cwd, env, stdio: 'pipe', windowsHide: true });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.child.stderr.on('data', () => {}); // drain diagnostics without copying them into app logs
    this.child.once('error', (error) => this.failAll(error));
    this.child.once('close', (code, signal) => {
      this.closed = true;
      this.failAll(new Error(`semiont mcp exited${code === null ? '' : ` with code ${code}`}${signal === null ? '' : ` (${signal})`}`));
    });
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: MCP_VERSION,
      capabilities: {},
      clientInfo: { name: 'semiont-desktop', version: '0.7.3' },
    });
    this.notify('notifications/initialized', {});
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('semiont mcp is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`semiont mcp ${method} timed out`));
      }, MCP_REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
        if (error !== undefined && error !== null) this.reject(id, error);
      });
    });
  }

  close(): void {
    this.closed = true;
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 1500);
    this.child.once('close', () => clearTimeout(timer));
    this.failAll(new Error('semiont mcp client closed'));
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  private onData(chunk: string): void {
    this.output += chunk;
    if (this.output.length > 2_000_000) {
      this.failAll(new Error('semiont mcp sent an oversized response'));
      this.close();
      return;
    }
    const parsed = extractJsonRpcMessages(this.output);
    this.output = parsed.rest;
    for (const line of parsed.lines) {
      if (line.trim().length === 0) continue;
      let message: McpEnvelope;
      try {
        message = JSON.parse(line) as McpEnvelope;
      } catch {
        this.failAll(new Error('semiont mcp sent invalid JSON-RPC data'));
        continue;
      }
      if (typeof message.id !== 'number') continue;
      const pending = this.pending.get(message.id);
      if (pending === undefined) continue;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error !== undefined) {
        pending.reject(new Error(typeof message.error.message === 'string' ? message.error.message : 'MCP request failed'));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private reject(id: number, error: Error): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.reject(error);
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}

function mcpResultText(value: unknown): string {
  const record = asRecord(value);
  if (record === null) return JSON.stringify(value) ?? String(value);
  if (record['isError'] === true) throw new Error('Semiont MCP tool returned an error');
  const structured = record['structuredContent'];
  if (structured !== undefined) return JSON.stringify(structured).slice(0, MAX_TOOL_OUTPUT);
  const content = record['content'];
  if (!Array.isArray(content)) return (JSON.stringify(value) ?? String(value)).slice(0, MAX_TOOL_OUTPUT);
  return content.flatMap((part: unknown) => {
    const item = asRecord(part);
    return item !== null && item['type'] === 'text' && typeof item['text'] === 'string' ? [item['text']] : [];
  }).join('\n').slice(0, MAX_TOOL_OUTPUT);
}

function toolCalls(message: OllamaMessage): RuntimeToolCall[] {
  if (!Array.isArray(message.tool_calls)) return [];
  return message.tool_calls.flatMap((entry: unknown) => {
    const call = asRecord(entry) as OllamaToolCall | null;
    const fn = call === null ? null : asRecord(call.function);
    if (fn === null || typeof fn['name'] !== 'string') return [];
    const args = fn['arguments'];
    const parsed = typeof args === 'string' ? JSON.parse(args) as unknown : args;
    const record = asRecord(parsed);
    if (record === null) throw new Error(`Ollama gave invalid arguments for ${fn['name']}`);
    return [{ name: fn['name'], arguments: record }];
  });
}

async function ollamaChat(endpoint: string, model: AgentModelId, messages: RuntimeMessage[], tools: McpTool[]): Promise<OllamaMessage> {
  const response = await fetch(`${endpoint}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    body: JSON.stringify({
      model,
      stream: false,
      messages,
      tools: tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description ?? tool.name,
          parameters: tool.inputSchema ?? { type: 'object', properties: {} },
        },
      })),
    }),
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const record = asRecord(payload);
    const reason = typeof record?.['error'] === 'string' ? record['error'] : `HTTP ${response.status}`;
    throw new Error(`Ollama request failed: ${reason}`);
  }
  const result = payload as OllamaResponse;
  if (typeof result.message?.content !== 'string') {
    throw new Error(typeof result.error === 'string' ? result.error : 'Ollama returned no message');
  }
  return result.message;
}

function scopedToolArguments(args: Record<string, unknown>, kbKey: string): Record<string, unknown> {
  const current = args['kb'];
  if (current !== undefined && current !== kbKey) throw new Error('A tool call tried to use a different Knowledge Base');
  return { ...args, kb: kbKey };
}

function runtimeTools(value: unknown): McpTool[] {
  const record = asRecord(value);
  return Array.isArray(record?.['tools'])
    ? (record['tools'] as unknown[]).flatMap((item) => {
      const tool = asRecord(item);
      if (tool === null || typeof tool['name'] !== 'string' || tool['annotations'] === undefined) return [];
      if (tool['name'] === 'knowledge_bases') return []; // main already resolved the selected KB key
      const annotations = asRecord(tool['annotations']);
      return [{
        name: tool['name'],
        ...(typeof tool['description'] === 'string' ? { description: tool['description'] } : {}),
        ...(asRecord(tool['inputSchema']) !== null ? { inputSchema: asRecord(tool['inputSchema'])! } : {}),
        readOnly: annotations?.['readOnlyHint'] === true,
        destructive: annotations?.['destructiveHint'] === true,
      }];
    })
    : [];
}

async function findKbKey(client: McpStdioClient, did: string): Promise<string> {
  const result = await client.request('tools/call', { name: 'knowledge_bases', arguments: {} });
  const record = asRecord(result);
  const content = record?.['content'];
  let parsed: unknown = record?.['structuredContent'];
  if (parsed === undefined && Array.isArray(content)) {
    for (const part of content) {
      const item = asRecord(part);
      if (typeof item?.['text'] !== 'string') continue;
      try { parsed = JSON.parse(item['text']) as unknown; } catch { continue; }
    }
  }
  const payload = asRecord(parsed);
  const bases = payload?.['knowledgeBases'];
  if (!Array.isArray(bases)) throw new Error('semiont mcp did not return its signed-in Knowledge Bases');
  const match = bases.map(asRecord).find((item) => item?.['did'] === did);
  if (typeof match?.['kb'] !== 'string') throw new Error('Sign in to this Knowledge Base with the Semiont launcher to enable chat tools.');
  return match['kb'];
}

export async function runLocalAgentTurn(input: {
  endpoint: string;
  launcherPath: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  kbDid: string;
  model: AgentModelId;
  messages: AgentHistoryMessage[];
  confirmDestructiveTool: (toolName: string, args: Record<string, unknown>) => Promise<boolean>;
}): Promise<AgentTurnResult> {
  const mcp = new McpStdioClient(input.launcherPath, input.env, input.cwd);
  try {
    await mcp.initialize();
    const kbKey = await findKbKey(mcp, input.kbDid);
    const tools = runtimeTools(await mcp.request('tools/list', {}));
    if (tools.length === 0) throw new Error('semiont mcp did not advertise any tools for Desktop.');

    const messages: RuntimeMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...input.messages.map((message): RuntimeMessage => ({
        role: message.role,
        content: message.content,
        ...(message.toolName !== undefined ? { tool_name: message.toolName } : {}),
        ...(message.toolCalls !== undefined ? {
          tool_calls: message.toolCalls.map((call) => ({ function: call })),
        } : {}),
      })),
    ];
    const events: AgentToolEvent[] = [];
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
      const answer = await ollamaChat(input.endpoint, input.model, messages, tools);
      const calls = toolCalls(answer);
      if (calls.length === 0) return { answer: answer.content as string, events };
      if (round === MAX_TOOL_ROUNDS) throw new Error('Semiont agent reached the tool-call limit for this turn.');
      const assistant: RuntimeMessage = {
        role: 'assistant',
        content: answer.content as string,
        tool_calls: calls.map((call) => ({ function: call })),
      };
      messages.push(assistant);
      events.push({ kind: 'tool-call', name: calls.map((call) => call.name).join(', '), payload: JSON.stringify(assistant) });
      for (const call of calls) {
        const tool = tools.find((candidate) => candidate.name === call.name);
        if (tool === undefined) throw new Error(`Ollama requested unavailable tool ${call.name}`);
        const args = scopedToolArguments(call.arguments, kbKey);
        if (tool.destructive && !(await input.confirmDestructiveTool(tool.name, args))) {
          const content = 'The user declined this action. No tool call was made.';
          events.push({ kind: 'tool-result', name: call.name, payload: content });
          messages.push({ role: 'tool', tool_name: call.name, content });
          continue;
        }
        const result = await mcp.request('tools/call', {
          name: call.name,
          arguments: args,
        });
        const content = mcpResultText(result);
        events.push({ kind: 'tool-result', name: call.name, payload: content });
        messages.push({ role: 'tool', tool_name: call.name, content });
      }
    }
    throw new Error('Semiont agent stopped without a final response.');
  } finally {
    mcp.close();
  }
}
