/**
 * The Keycloak admin API client `semiont useradd` writes through.
 *
 * The load-bearing case is `createUser` marking the address verified: the
 * gateway refuses a token whose `email_verified` is false, so an account
 * created without it would belong to someone who could never sign in — a
 * failure that surfaces only at the far end of a live sign-in, which is exactly
 * the distance this test exists to close.
 */

import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../setup';
import { KeycloakAdminApi, splitIssuer } from '../../identity/keycloak-admin';

const BASE = 'https://keycloak.test';
const ISSUER = `${BASE}/realms/semiont`;
const USERS = `${BASE}/admin/realms/semiont/users`;
const TOKEN = 'admin-access-token';

/** The master-realm token endpoint, answering with an administrator token. */
function tokenEndpoint() {
  return http.post(`${BASE}/realms/master/protocol/openid-connect/token`, () =>
    HttpResponse.json({ access_token: TOKEN }),
  );
}

function connect(): Promise<KeycloakAdminApi> {
  return KeycloakAdminApi.connect(ISSUER, 'admin', 'admin-password');
}

describe('splitIssuer', () => {
  it('splits a realm URL into its base and realm', () => {
    expect(splitIssuer('https://kc.test/realms/semiont')).toEqual({
      base: 'https://kc.test',
      realm: 'semiont',
    });
  });

  it('keeps a path prefix in the base', () => {
    expect(splitIssuer('https://kc.test/auth/realms/semiont')).toEqual({
      base: 'https://kc.test/auth',
      realm: 'semiont',
    });
  });

  it('tolerates a trailing slash', () => {
    expect(splitIssuer('https://kc.test/realms/semiont/').realm).toBe('semiont');
  });

  it('refuses a URL that names no realm', () => {
    expect(() => splitIssuer('https://kc.test')).toThrow(/not a Keycloak realm URL/);
  });
});

describe('KeycloakAdminApi.connect', () => {
  it('authenticates against the master realm with the admin-cli password grant', async () => {
    let body = '';
    server.use(
      http.post(`${BASE}/realms/master/protocol/openid-connect/token`, async ({ request }) => {
        body = await request.text();
        return HttpResponse.json({ access_token: TOKEN });
      }),
    );

    await connect();

    const form = new URLSearchParams(body);
    expect(form.get('grant_type')).toBe('password');
    expect(form.get('client_id')).toBe('admin-cli');
    expect(form.get('username')).toBe('admin');
    expect(form.get('password')).toBe('admin-password');
  });

  it('names the credentials to check when the realm refuses them', async () => {
    server.use(
      http.post(`${BASE}/realms/master/protocol/openid-connect/token`, () =>
        HttpResponse.json({ error: 'invalid_grant' }, { status: 401 }),
      ),
    );

    await expect(connect()).rejects.toThrow(/KC_BOOTSTRAP_ADMIN_PASSWORD/);
  });

  it('refuses a token response carrying no access_token', async () => {
    server.use(
      http.post(`${BASE}/realms/master/protocol/openid-connect/token`, () =>
        HttpResponse.json({ token_type: 'Bearer' }),
      ),
    );

    await expect(connect()).rejects.toThrow(/without an access_token/);
  });
});

describe('KeycloakAdminApi.findUserByEmail', () => {
  it('searches for an exact address and returns the account', async () => {
    let url = '';
    let authorization: string | null = null;
    server.use(
      tokenEndpoint(),
      http.get(USERS, ({ request }) => {
        url = request.url;
        authorization = request.headers.get('authorization');
        return HttpResponse.json([{ id: 'kc-user-1', email: 'alice@example.com', enabled: true }]);
      }),
    );

    const api = await connect();
    const found = await api.findUserByEmail('alice@example.com');

    expect(found).toEqual({ id: 'kc-user-1', email: 'alice@example.com', enabled: true });
    expect(authorization).toBe(`Bearer ${TOKEN}`);
    const query = new URL(url).searchParams;
    expect(query.get('email')).toBe('alice@example.com');
    expect(query.get('exact')).toBe('true');
  });

  it('answers null when the realm holds no such account', async () => {
    server.use(tokenEndpoint(), http.get(USERS, () => HttpResponse.json([])));

    const api = await connect();

    expect(await api.findUserByEmail('nobody@example.com')).toBeNull();
  });
});

describe('KeycloakAdminApi.createUser', () => {
  it('creates a verified, enabled account with a permanent password and returns its id', async () => {
    let payload: unknown;
    server.use(
      tokenEndpoint(),
      http.post(USERS, async ({ request }) => {
        payload = await request.json();
        return new HttpResponse(null, {
          status: 201,
          headers: { location: `${USERS}/kc-user-2` },
        });
      }),
    );

    const api = await connect();
    const id = await api.createUser('bob@example.com', 'a-strong-password');

    expect(id).toBe('kc-user-2');
    expect(payload).toMatchObject({
      username: 'bob@example.com',
      email: 'bob@example.com',
      emailVerified: true,
      enabled: true,
      credentials: [{ type: 'password', value: 'a-strong-password', temporary: false }],
    });
  });

  it('reports a duplicate account rather than a bare HTTP status', async () => {
    server.use(
      tokenEndpoint(),
      http.post(USERS, () => new HttpResponse(null, { status: 409 })),
    );

    const api = await connect();

    await expect(api.createUser('bob@example.com', 'pw')).rejects.toThrow(/already holds an account/);
  });

  it('refuses a creation the realm answered without an id', async () => {
    server.use(
      tokenEndpoint(),
      http.post(USERS, () => new HttpResponse(null, { status: 201 })),
    );

    const api = await connect();

    await expect(api.createUser('bob@example.com', 'pw')).rejects.toThrow(/named no id/);
  });

  /**
   * `useradd --inactive` used to set a Semiont column the gateway checked on
   * every request. The issuer holds that answer now, so the flag has to reach
   * the realm at creation — an account created "inactive" that the realm
   * nonetheless enables would let someone sign in to a knowledge base an
   * administrator deliberately closed to them.
   */
  it('creates a disabled account when asked, so --inactive reaches the realm', async () => {
    let payload: unknown;
    server.use(
      tokenEndpoint(),
      http.post(USERS, async ({ request }) => {
        payload = await request.json();
        return new HttpResponse(null, { status: 201, headers: { location: `${USERS}/kc-user-3` } });
      }),
    );

    const api = await connect();
    await api.createUser('carol@example.com', 'a-strong-password', false);

    expect(payload).toMatchObject({ email: 'carol@example.com', enabled: false });
  });
});

describe('KeycloakAdminApi.setEnabled', () => {
  it.each([true, false])('sets enabled=%s on an existing account', async (enabled) => {
    let payload: unknown;
    server.use(
      tokenEndpoint(),
      http.put(`${USERS}/kc-user-1`, async ({ request }) => {
        payload = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const api = await connect();
    await api.setEnabled('kc-user-1', enabled);

    expect(payload).toEqual({ enabled });
  });

  it('surfaces a refusal, naming the direction it was attempting', async () => {
    server.use(
      tokenEndpoint(),
      http.put(`${USERS}/kc-user-1`, () => new HttpResponse(null, { status: 403 })),
    );

    const api = await connect();

    await expect(api.setEnabled('kc-user-1', false)).rejects.toThrow(/Disabling kc-user-1 .* \(HTTP 403\)/);
  });
});

describe('KeycloakAdminApi.setPassword', () => {
  it('resets the password without making it temporary', async () => {
    let payload: unknown;
    server.use(
      tokenEndpoint(),
      http.put(`${USERS}/kc-user-1/reset-password`, async ({ request }) => {
        payload = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const api = await connect();
    await api.setPassword('kc-user-1', 'replacement-password');

    expect(payload).toEqual({ type: 'password', value: 'replacement-password', temporary: false });
  });

  it('surfaces a refusal', async () => {
    server.use(
      tokenEndpoint(),
      http.put(`${USERS}/kc-user-1/reset-password`, () => new HttpResponse(null, { status: 403 })),
    );

    const api = await connect();

    await expect(api.setPassword('kc-user-1', 'pw')).rejects.toThrow(/failed \(HTTP 403\)/);
  });
});
