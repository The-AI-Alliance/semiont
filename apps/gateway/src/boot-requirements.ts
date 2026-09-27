/**
 * What this process must have before it serves anything, beyond its
 * configuration document: its own account at the issuer, which it reaches the
 * Archivist with.
 *
 * Nothing here dials the Archivist or obtains a token, which would couple this
 * process's startup to another's. Exported for the reason `requireJwtSecret`
 * is — one copy of the rule — and it returns what it validated, so the caller
 * builds a credential from narrowed strings rather than asserting non-null.
 */
export function requireServiceAccount(): { clientId: string; clientSecret: string } {
  const clientId = process.env.SEMIONT_OIDC_CLIENT_ID;
  const clientSecret = process.env.SEMIONT_OIDC_CLIENT_SECRET;
  // One guard, so both narrow to `string` for the return.
  if (!clientId || !clientSecret) {
    const missing = [
      ['SEMIONT_OIDC_CLIENT_ID', clientId],
      ['SEMIONT_OIDC_CLIENT_SECRET', clientSecret],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    throw new Error(
      `${missing.join(' and ')} not set — this gateway has no service account, so it cannot ` +
        'authenticate to the Archivist and every read of the record would fail.\n' +
        'The launcher passes both for each service it starts; a gateway started another way ' +
        'needs the client its realm registers for it (SEMIONT_OIDC_CLIENT_ID=semiont-gateway).',
    );
  }
  return { clientId, clientSecret };
}
