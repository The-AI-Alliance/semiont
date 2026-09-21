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
 * this knowledge base accepts. Public.
 *
 * `resource` is the knowledge base's own identifier — its did:web resolved to
 * an https URL — and it is read off the VERIFIER, so it is byte-for-byte the
 * value a token's `aud` must carry. Not the request origin: that varies with
 * the host, port and proxy a caller happened to reach, which would make the
 * resource's name a property of how you asked for it.
 */
wellKnownRouter.get(PROTECTED_RESOURCE_METADATA_PATH, (c) => {
  const issuer = trustedIssuer();
  const kbName = c.get('config').kb?.name;
  const response: ProtectedResourceMetadata = {
    resource: issuer.audience,
    authorization_servers: [issuer.issuer],
    bearer_methods_supported: ['header'],
    ...(kbName ? { resource_name: kbName } : {}),
  };
  return c.json(response, 200);
});
