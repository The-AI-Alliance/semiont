/**
 * Plain HTTP against a gateway, and the one check every response in the
 * suite can be put through: that its status is declared for the route, and
 * that its body and headers are what the declaration says.
 */
import { errorsOf, spec, type Method } from './spec';

export interface Reply {
  status: number;
  headers: Headers;
  text: string;
  /** The body parsed as JSON, when it is JSON. */
  json: unknown;
  bytes: Buffer;
}

export interface CallOptions {
  token?: string;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
}

export async function call(origin: string, method: string, path: string, options: CallOptions = {}): Promise<Reply> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers['authorization'] = `Bearer ${options.token}`;
  let body = options.body;
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = typeof options.json === 'string' ? options.json : JSON.stringify(options.json);
  }
  const res = await fetch(`${origin}${path}`, { method, headers, ...(body === undefined ? {} : { body }), redirect: 'manual' });
  const bytes = Buffer.from(await res.arrayBuffer());
  const text = bytes.toString('utf8');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, text, json, bytes };
}

/**
 * The reply's status is one the spec declares for `method path`, and the
 * reply matches that declaration: content type, body schema (JSON bodies),
 * and every declared header whose schema it has, against that schema.
 * Returns a list of mismatches; empty is conformant.
 */
export function nonConformance(method: Method, path: string, reply: Reply): string[] {
  const problems: string[] = [];
  const declared = spec().response(method, path, reply.status);
  if (!declared) return [`${method.toUpperCase()} ${path} answered ${reply.status}, which the spec does not declare (body: ${reply.text.slice(0, 200)})`];

  const content = declared['content'] as Record<string, { schema?: unknown }> | undefined;
  if (content) {
    const got = (reply.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const mediaTypes = Object.keys(content);
    const media = mediaTypes.find((m) => m === got) ?? mediaTypes.find((m) => m === '*/*');
    if (!media) {
      problems.push(`${reply.status} came as ${got || 'no content type'}, not ${mediaTypes.join(' or ')} (body: ${reply.text.slice(0, 200)})`);
    } else if (media.endsWith('json') && content[media]?.schema !== undefined) {
      if (reply.json === undefined) {
        problems.push(`${reply.status} declared ${media} but the body is not JSON: ${reply.text.slice(0, 200)}`);
      } else if (reply.status >= 400 && /\bat [^\s]+ \(|\.[cm]?[jt]s:\d+|node_modules|\/Users\/|\/home\/|JWT_SECRET|CLIENT_SECRET/.test(reply.text)) {
        problems.push(`${reply.status} body carries internals — a stack frame, a source path or a secret's name: ${reply.text.slice(0, 200)}`);
      } else {
        const validate = spec().validator(content[media]!.schema as never);
        if (!validate(reply.json)) problems.push(`${reply.status} body does not match the declared schema: ${errorsOf(validate)}`);
      }
    }
  }

  const headers = declared['headers'] as Record<string, { schema?: unknown }> | undefined;
  for (const [name, header] of Object.entries(headers ?? {})) {
    const value = reply.headers.get(name);
    if (value === null) {
      problems.push(`${reply.status} carries no ${name} header`);
      continue;
    }
    if (header.schema !== undefined) {
      const validate = spec().validator(header.schema as never);
      if (!validate(value)) problems.push(`${reply.status} ${name}: ${JSON.stringify(value)} does not match its schema (${errorsOf(validate)})`);
    }
  }
  return problems;
}
