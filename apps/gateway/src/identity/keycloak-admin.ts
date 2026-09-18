/**
 * Keycloak's admin REST API — the part `semiont useradd` writes through.
 *
 * The one vendor-shaped module under `identity/`. Everything else here speaks
 * OIDC, which any issuer implements; creating an account has no such standard
 * (SCIM is out of scope), so administering accounts is necessarily specific to
 * the issuer holding them. That asymmetry is why `useradd` refuses for
 * `type = "oidc"`: there the accounts are someone else's to create.
 */

import { isArray, isBoolean, isObject, isString } from '@semiont/core';

/**
 * The `<base>` and `<realm>` of an issuer URL shaped `<base>/realms/<realm>`.
 * The launcher splits the same string in Go (`identity.go` `splitIssuer`) to
 * decide what to launch; this is the reader's half, and the two must agree on
 * what counts as a realm URL.
 */
export function splitIssuer(issuer: string): { base: string; realm: string } {
  const match = /^(.+?)\/realms\/([^/?#]+)\/?$/.exec(issuer);
  if (!match?.[1] || !match[2]) {
    throw new Error(
      `identity issuer ${issuer} is not a Keycloak realm URL — expected <base>/realms/<realm>`,
    );
  }
  return { base: match[1], realm: match[2] };
}

export interface KeycloakUser {
  id: string;
  email: string;
  enabled: boolean;
}

export class KeycloakAdminApi {
  private constructor(
    private readonly base: string,
    private readonly realm: string,
    private readonly token: string,
  ) {}

  /**
   * Authenticate against the `master` realm with the bootstrap administrator
   * credentials the launcher gave Keycloak, and hold the resulting token for
   * this process's lifetime — `useradd` is a one-shot command, so there is no
   * expiry to manage.
   */
  static async connect(
    issuer: string,
    username: string,
    password: string,
  ): Promise<KeycloakAdminApi> {
    const { base, realm } = splitIssuer(issuer);
    const response = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'admin-cli',
        username,
        password,
      }).toString(),
    });
    if (!response.ok) {
      throw new Error(
        `${base} refused the administrator credentials (HTTP ${response.status}). ` +
          'Check KC_BOOTSTRAP_ADMIN_USERNAME and KC_BOOTSTRAP_ADMIN_PASSWORD.',
      );
    }
    const body: unknown = await response.json();
    if (!isObject(body) || !isString(body.access_token)) {
      throw new Error(`${base} answered the administrator token request without an access_token`);
    }
    return new KeycloakAdminApi(base, realm, body.access_token);
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' };
  }

  private usersUrl(suffix = ''): string {
    return `${this.base}/admin/realms/${encodeURIComponent(this.realm)}/users${suffix}`;
  }

  /** The realm's account for this address, or null when it holds none. */
  async findUserByEmail(email: string): Promise<KeycloakUser | null> {
    const query = new URLSearchParams({ email, exact: 'true' }).toString();
    const response = await fetch(`${this.usersUrl()}?${query}`, { headers: this.headers() });
    if (!response.ok) {
      throw new Error(`Searching realm ${this.realm} for ${email} failed (HTTP ${response.status})`);
    }
    const body: unknown = await response.json();
    if (!isArray(body)) {
      throw new Error(`Searching realm ${this.realm} for ${email} returned no list`);
    }
    for (const entry of body) {
      if (isObject(entry) && isString(entry.id)) {
        return {
          id: entry.id,
          email: isString(entry.email) ? entry.email : email,
          enabled: isBoolean(entry.enabled) ? entry.enabled : true,
        };
      }
    }
    return null;
  }

  /**
   * Create the account and return its id — the `sub` its tokens will carry,
   * and so the `providerId` of the User row that backs it.
   *
   * `enabled` is always true and no display name is sent. Both are deliberate:
   * whether an account may sign in to THIS knowledge base is `isActive` on the
   * Semiont row (`--inactive` sets it, and the gateway refuses the token), and
   * the display name is read from that row too — neither is the issuer's to
   * hold, and mirroring them would put one fact in two places.
   */
  async createUser(email: string, password: string): Promise<string> {
    const response = await fetch(this.usersUrl(), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        username: email,
        email,
        // A token whose `email_verified` is false is refused at sign-in, so an
        // account created here has to be verified or its owner could never
        // reach the knowledge base an administrator just granted them.
        emailVerified: true,
        enabled: true,
        credentials: [{ type: 'password', value: password, temporary: false }],
      }),
    });
    if (response.status === 409) {
      throw new Error(`Realm ${this.realm} already holds an account for ${email}`);
    }
    if (!response.ok) {
      throw new Error(`Creating ${email} in realm ${this.realm} failed (HTTP ${response.status})`);
    }
    const id = response.headers.get('location')?.split('/').pop();
    if (!id) {
      throw new Error(`Realm ${this.realm} created ${email} but named no id in its Location header`);
    }
    return id;
  }

  async setPassword(userId: string, password: string): Promise<void> {
    const response = await fetch(this.usersUrl(`/${encodeURIComponent(userId)}/reset-password`), {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify({ type: 'password', value: password, temporary: false }),
    });
    if (!response.ok) {
      throw new Error(`Setting the password for ${userId} failed (HTTP ${response.status})`);
    }
  }
}
