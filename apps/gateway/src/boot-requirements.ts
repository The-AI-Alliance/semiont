/**
 * What this process must have before it serves anything.
 *
 * Config completeness only: nothing here dials the Archivist or obtains a
 * token, which would couple this process's startup to another's. Exported for
 * the reason `requireJwtSecret` is — one copy of the rule, reachable by a test
 * without booting an app — and it returns what it validated, so the caller
 * builds a credential from narrowed strings rather than asserting non-null.
 */

type ArchivistSection = { services?: { archivist?: { host?: string } } };

export function requireArchivistAccess(
  config: ArchivistSection,
): { host: string; clientId: string; clientSecret: string } {
  const host = config.services?.archivist?.host;
  if (!host) {
    throw new Error(
      'services.archivist.host is not configured — this gateway cannot reach the record, ' +
        'so it could not serve content, proxy bytes, or read the event log.\n' +
        '`semiont start` stages this section for every stack it starts; a gateway started ' +
        'another way must be given it:\n\n  [environments.<env>.archivist]\n  host = "<where the archivist listens>"\n',
    );
  }
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
  return { host, clientId, clientSecret };
}
