import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { formatErrors } from '@semiont/core/openapi';

/**
 * A JSON body, validated against the spec schema the route declares. Every
 * refusal is a 400: a body that is not JSON, and one that does not match.
 */
export async function validBody<T>(c: Context, validate: ((data: unknown) => data is T) & { errors?: Parameters<typeof formatErrors>[0] }): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: 'The body is not JSON' });
  }
  if (!validate(body)) throw new HTTPException(400, { message: formatErrors(validate.errors) });
  return body;
}
