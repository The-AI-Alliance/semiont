/**
 * The gateway's `.well-known/` surface. Plain Hono, response types from the
 * OpenAPI spec.
 */

import { Hono } from 'hono';
import type { components, EnvironmentConfig } from '@semiont/core';
import { trustedIssuer } from '../identity/trusted-issuer';
import { PROTECTED_RESOURCE_METADATA_PATH } from '../identity/resource-metadata';

type ProtectedResourceMetadata = components['schemas']['ProtectedResourceMetadata'];

export const wellKnownRouter = new Hono<{ Variables: { config: EnvironmentConfig } }>();

/**
 * GET /.well-known/oauth-protected-resource
 *
 * OAuth 2.0 Protected Resource Metadata (RFC 9728): the issuer whose tokens
 * this knowledge base accepts. `resource` is the origin the metadata was
 * fetched from — the identifier the caller already used. Public.
 */
wellKnownRouter.get(PROTECTED_RESOURCE_METADATA_PATH, (c) => {
  const issuer = trustedIssuer();
  if (!issuer) {
    return c.json({ error: 'This knowledge base trusts no external issuer' }, 404);
  }
  const kbName = c.get('config').kb?.name;
  const response: ProtectedResourceMetadata = {
    resource: new URL(c.req.url).origin,
    authorization_servers: [issuer.issuer],
    bearer_methods_supported: ['header'],
    ...(kbName ? { resource_name: kbName } : {}),
  };
  return c.json(response, 200);
});
