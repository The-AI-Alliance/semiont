import { describe, it, expect } from 'vitest';
import { loadTomlConfig, resolveEnvVars, createTomlConfigLoader } from '../../config/toml-loader';

// Every environment must NAME a vector store and an embedding provider —
// nothing is defaulted, and the loader refuses without them
// (MANDATORY-EMBEDDING D0+D1). Appended to every fixture that loads.
const SERVICES_LOCAL = `
[environments.local.vectors]
type = "memory"

[environments.local.embedding]
type = "ollama"
model = "nomic-embed-text"
`;

const MINIMAL_NO_IDENTITY = `
[environments.local.gateway]
platform = "posix"
port = 3001
publicURL = "http://localhost:3001"
# Deliberately left after FRONTEND-IS-THE-BROWSER P6: frontendURL was declared
# on the gateway section and read by nothing, so it was deleted rather than
# renamed. Keeping it here means every test below also pins that an unknown KEY
# inside a known section stays inert, the way the [browser] and [frontend]
# tests pin it for a whole section.
frontendURL = "http://localhost:3000"

[environments.local.make-meaning.graph]
type = "memory"
${SERVICES_LOCAL}`;

// `[identity]` is mandatory, so the shared fixture carries one. The tests that
// exercise the section itself use MINIMAL_NO_IDENTITY and supply their own —
// TOML refuses a redefined table, so they cannot simply override.
const IDENTITY_LOCAL = `
[environments.local.identity]
type = "keycloak"
issuer = "http://localhost:8080/realms/semiont"
subjectClaim = "sub"
`;

/** The complete fixture: what every test that is not ABOUT [identity] uses. */
const MINIMAL_TOML = `${MINIMAL_NO_IDENTITY}${IDENTITY_LOCAL}`;


const WITH_INFERENCE_TOML = `
[environments.local.make-meaning.actors.gatherer.inference]
type = "anthropic"
model = "claude-haiku-4-5-20251001"
maxTokens = 4096
apiKey = "test-key"

[environments.local.make-meaning.actors.matcher.inference]
type = "anthropic"
model = "claude-haiku-4-5-20251001"
maxTokens = 2048
apiKey = "test-key"

[environments.local.workers.default.inference]
type = "anthropic"
model = "claude-haiku-4-5-20251001"
maxTokens = 4096
apiKey = "test-key"

[environments.local.workers.generation.inference]
type = "anthropic"
model = "claude-sonnet-4-6"
maxTokens = 16384
apiKey = "test-key"
${SERVICES_LOCAL}`;
const WITH_INFERENCE_TOML_COMPLETE = `${WITH_INFERENCE_TOML}${IDENTITY_LOCAL}`;

const WITH_ENV_VAR_TOML = `
[environments.local.make-meaning.actors.gatherer.inference]
type = "anthropic"
model = "claude-haiku-4-5-20251001"
apiKey = "\${MY_API_KEY}"
${SERVICES_LOCAL}`;
const WITH_ENV_VAR_TOML_COMPLETE = `${WITH_ENV_VAR_TOML}${IDENTITY_LOCAL}`;

/**
 * `[identity]` is mandatory (user, 2026-09-21), and almost none of these tests
 * are ABOUT it — they are about inference, environments, [site], placeholders.
 * So the reader supplies one for every environment a fixture names that lacks
 * it, leaving each fixture's own subject matter untouched. A fixture that
 * DOES declare identity is left exactly as written, which is what lets the
 * identity tests (and the refusal test) say what they mean.
 */
function withMandatoryIdentity(toml: string): string {
  const envs = new Set([...toml.matchAll(/\[environments\.([A-Za-z0-9_-]+)\./g)].map((m) => m[1]));
  let out = toml;
  for (const env of envs) {
    if (new RegExp(`\\[environments\\.${env}\\.identity\\]`).test(toml)) continue;
    out += `\n[environments.${env}.identity]\ntype = "keycloak"\nissuer = "http://localhost:8080/realms/semiont"\nsubjectClaim = "sub"\n`;
  }
  return out;
}

function makeReader(globalContent: string | null, projectContent?: string): { readIfExists: (p: string) => string | null } {
  return {
    readIfExists: (p: string) => {
      if (p.endsWith('/.semiontconfig')) return globalContent === null ? null : withMandatoryIdentity(globalContent);
      if (p.endsWith('/.semiont/config')) return projectContent ?? '[project]\nname = "test-project"\n';
      return null;
    },
  };
}

describe('loadTomlConfig', () => {
  it('maps gateway section to EnvironmentConfig.services.gateway', () => {
    const config = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(MINIMAL_TOML), {});

    expect(config.services?.gateway?.port).toBe(3001);
    expect(config.services?.gateway?.publicURL).toBe('http://localhost:3001');
  });

  it('maps graph section to EnvironmentConfig.services.graph', () => {
    const config = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(MINIMAL_TOML), {});

    expect((config.services?.graph as any)?.type).toBe('memory');
  });

  it('stores actor inference config in _metadata', () => {
    const config = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(WITH_INFERENCE_TOML_COMPLETE), {});

    const actors = (config._metadata as any)?.actors;
    expect(actors?.gatherer?.model).toBe('claude-haiku-4-5-20251001');
    expect(actors?.matcher?.maxTokens).toBe(2048);
  });

  it('stores worker inference config in _metadata with inheritance', () => {
    const config = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(WITH_INFERENCE_TOML_COMPLETE), {});

    const workers = (config._metadata as any)?.workers;
    expect(workers?.default?.model).toBe('claude-haiku-4-5-20251001');
    expect(workers?.generation?.model).toBe('claude-sonnet-4-6');
    expect(workers?.generation?.maxTokens).toBe(16384);
  });

  // The gather settle bound (SMELTER-INDEX-SYNC D5): the loader is the ONE
  // home of the default — consuming code receives a required value and
  // defaults nothing.
  it('always sets _metadata.gather.settleTimeoutMs, defaulting to 15000 when absent', () => {
    const config = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(MINIMAL_TOML), {});

    expect((config._metadata as any)?.gather).toEqual({ settleTimeoutMs: 15_000 });
  });

  it('honors an explicit make-meaning.gather.settleTimeoutMs', () => {
    const toml = `${MINIMAL_TOML}
[environments.local.make-meaning.gather]
settleTimeoutMs = 45000
`;
    const config = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(toml), {});

    expect((config._metadata as any)?.gather).toEqual({ settleTimeoutMs: 45_000 });
  });

  // FRONTEND-IS-THE-BROWSER P5 (D5): `[browser]` left the config model. The
  // Browser is machine-level — one Browser serves many KBs — so a KB has no
  // knowledge of, and no effect on, its port or publicURL. The launcher never
  // mounts a KB's config into the Browser container, which made the loader's
  // `port ?? 3000` a lie by omission: `port = 3100` got no error and no effect.
  //
  // Both spellings stay INERT rather than refused. The fleet's committed
  // configs carry them, and a section that configures nothing cannot be
  // misconfigured — so there is nothing left to map forward or reject.
  //
  // Asserted over the emitted keys, not the type: `ServicesConfig` carries an
  // open `[k: string]: unknown`, so `config.services.browser` keeps compiling
  // after the member is deleted. Only a runtime check can see the difference.
  it('loads a config carrying [browser] and emits no browser service', () => {
    const toml = `${MINIMAL_TOML}
[environments.local.browser]
platform = "container"
port = 3000
`;
    const config = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(toml), {});

    expect(Object.keys(config.services)).not.toContain('browser');
  });

  it('loads a config carrying the older [frontend] spelling just as inertly', () => {
    const toml = `${MINIMAL_TOML}
[environments.local.frontend]
platform = "container"
port = 3000
`;
    const config = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(toml), {});

    expect(Object.keys(config.services)).not.toContain('browser');
    expect(Object.keys(config.services)).not.toContain('frontend');
  });

  it('always sets _metadata.search.semanticFloor, defaulting to 0.6 when absent', () => {
    // SEMANTIC-FALLBACK decision #1: the loader is the ONE home of the
    // default — guess-now (0.6), tune-from-evidence-later; any KB overrides
    // per-TOML without code.
    const config = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(MINIMAL_TOML), {});

    expect((config._metadata as any)?.search).toEqual({ semanticFloor: 0.6 });
  });

  it('honors an explicit make-meaning.search.semanticFloor', () => {
    const toml = `${MINIMAL_TOML}
[environments.local.make-meaning.search]
semanticFloor = 0.75
`;
    const config = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(toml), {});

    expect((config._metadata as any)?.search).toEqual({ semanticFloor: 0.75 });
  });

  it('resolves ${VAR} env var references', () => {
    const config = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(WITH_ENV_VAR_TOML_COMPLETE), { MY_API_KEY: 'sk-secret' });

    const actors = (config._metadata as any)?.actors;
    expect(actors?.gatherer?.apiKey).toBe('sk-secret');
  });

  // The reference sits in the gatherer's inference, so the refusal fires where
  // that section is read (SECRET-DELIVERY P5), not at load.
  it('throws when ${VAR} references a missing env var', () => {
    const config = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(WITH_ENV_VAR_TOML_COMPLETE), {});
    expect(() => config._metadata?.actors).toThrow('Environment variable MY_API_KEY is not set');
  });

  it('resolves from the project config when the global config file is absent', () => {
    // A missing ~/.semiontconfig is fine as long as SOME config declares the
    // selected environment — here the project's .semiont/config does.
    const projectWithLocal = `[project]\nname = "test-project"\n${MINIMAL_TOML}`;
    const config = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(null, projectWithLocal), {});
    expect(config.services?.gateway?.port).toBe(3001);
    expect(config._metadata?.environment).toBe('local');
  });

  it('throws for a named environment with no [environments.X] section', () => {
    // The silent `?? {}` here is exactly what let a mis-declared environment
    // load an empty section, with every downstream default firing behind it.
    expect(() =>
      loadTomlConfig('/project', 'staging', '/home/user/.semiontconfig', makeReader(MINIMAL_TOML), {})
    ).toThrow(/staging/);
  });

  it('sets _metadata.environment and projectRoot', () => {
    const config = loadTomlConfig('/my/project', 'local', '/home/user/.semiontconfig', makeReader(MINIMAL_TOML), {});

    expect(config._metadata?.environment).toBe('local');
    expect(config._metadata?.projectRoot).toBe('/my/project');
  });
});

describe('loadTomlConfig — environment resolution (one config selects it)', () => {
  // `[defaults] environment` is the key the launcher reads (config.go:
  // cfg.Defaults.Environment). The gateway must resolve from the SAME key so a
  // KB's declared environment selects the section for BOTH halves.
  const DEFAULTS_STAGING = `
[defaults]
environment = "staging"

[environments.staging.gateway]
platform = "posix"
port = 5005
publicURL = "http://localhost:5005"

[environments.local.gateway]
platform = "posix"
port = 3001
publicURL = "http://localhost:3001"

[environments.staging.vectors]
type = "memory"

[environments.staging.embedding]
type = "ollama"
model = "nomic-embed-text"
${SERVICES_LOCAL}

[environments.staging.identity]
type = "keycloak"
issuer = "http://localhost:8080/realms/semiont"
subjectClaim = "sub"
`;

  it('resolves the environment from [defaults] environment when none is passed', () => {
    const config = loadTomlConfig('/project', undefined, '/home/user/.semiontconfig', makeReader(DEFAULTS_STAGING), {});
    expect(config._metadata?.environment).toBe('staging');
    expect(config.services?.gateway?.port).toBe(5005);
  });

  // `SEMIONT_ENV` is NOT an input. It was removed as a resolution input because an
  // ambient variable can disagree with the config the launcher just staged — the same
  // shape of bug as the hard-coded 'local' that #1108 removed. The chain is now two
  // inputs that cannot contradict each other: an explicit argument (tests) and
  // `[defaults] environment` (everything else).
  it('ignores SEMIONT_ENV entirely — it is not an input to resolution', () => {
    const config = loadTomlConfig('/project', undefined, '/home/user/.semiontconfig', makeReader(DEFAULTS_STAGING), { SEMIONT_ENV: 'local' });
    expect(config._metadata?.environment).toBe('staging');
    expect(config.services?.gateway?.port).toBe(5005);
  });

  // EXTRACT-ARCHIVIST P3: the gateway replays SSE resumes from the Archivist
  // at services.archivist.{host,port}. The mapping was the missing middle —
  // the cutover added the schema and the consumer, and a section that parses
  // but never reaches services means every resume silently degrades to a gap.
  it('maps [archivist] to services.archivist with the 24103 default', () => {
    const toml = `
[environments.local.archivist]
host = "192.168.64.1"
${MINIMAL_TOML}`;
    const cfg = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(toml), {});
    expect(cfg.services.archivist).toEqual({
      platform: { type: 'external' },
      host: '192.168.64.1',
      port: 24103,
    });
  });

  it('emits no archivist service when the section is absent (resume degrades to gap, loudly)', () => {
    const cfg = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(MINIMAL_TOML), {});
    expect(cfg.services.archivist).toBeUndefined();
  });

  // JOB-QUEUE-DRIVER P2: jobQueueFor reads services.jobs to select the driver.
  // The mapping is the missing middle — the same failure shape the archivist
  // tests above pin: the cutover added the schema and the consumer, and a
  // [jobs] section that parses but never reaches services means the driver
  // silently stays 'fs' on every real stack, unrepresentable in unit tests
  // that hand jobQueueFor a JobsServiceConfig literal.
  it('maps [jobs] to services.jobs — type and servers pass through', () => {
    const toml = `
[environments.local.jobs]
type = "jetstream"
servers = "nats.internal:4222"
${MINIMAL_TOML}`;
    const cfg = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(toml), {});
    expect(cfg.services.jobs).toEqual({
      type: 'jetstream',
      servers: 'nats.internal:4222',
    });
  });

  // SECRET-DELIVERY F2: the broker pair never left the loader, so a JetStream
  // queue built from it never authenticated, whatever the config said.
  it('maps [jobs] user and password to services.jobs — the broker pair reaches the queue', () => {
    const toml = `
[environments.local.jobs]
type = "jetstream"
servers = "nats.internal:4222"
user = "semiont"
password = "\${NATS_PASSWORD}"
${MINIMAL_TOML}`;
    const cfg = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(toml), { NATS_PASSWORD: 's3cret' });
    expect(cfg.services.jobs).toEqual({
      type: 'jetstream',
      servers: 'nats.internal:4222',
      user: 'semiont',
      password: 's3cret',
    });
  });

  it("emits no jobs service when the section is absent (the consumer's 'fs' default)", () => {
    const cfg = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(MINIMAL_TOML), {});
    expect(cfg.services.jobs).toBeUndefined();
  });

  // Selection is stated, never inferred — and never silently defaulted. A
  // [jobs] section that names no type would reach jobQueueFor as neither 'fs'
  // nor 'jetstream' and fall through to the fs driver: exactly the silent
  // fallback selection-by-config exists to prevent. Refuse at load, naming
  // the fix.
  it('refuses a [jobs] section that names no type', () => {
    const toml = `
[environments.local.jobs]
servers = "nats.internal:4222"
${MINIMAL_TOML}`;
    expect(() => loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(toml), {}).services.jobs)
      .toThrow(/\[environments\.local\.jobs\].*type/);
  });

  // The real config's servers value is a ${VAR} placeholder (the launcher
  // renders the variable into the gateway's env). The loader's uniform
  // resolution covers it like every other section — pin that end to end.
  it('resolves ${VAR} placeholders in jobs.servers from the loader env', () => {
    const toml = `
[environments.local.jobs]
type = "jetstream"
servers = "\${NATS_HOST}:4222"
${MINIMAL_TOML}`;
    const cfg = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(toml), { NATS_HOST: '10.0.0.9' });
    expect(cfg.services.jobs?.servers).toBe('10.0.0.9:4222');
  });

  // EXTERNAL-IDENTITY P3: the gateway reads services.identity for the issuer
  // it trusts. Same missing-middle shape as [jobs], and every key
  // the verifier needs is required — typed-but-incomplete refuses, naming the
  // key. There is no `audience` key: the audience is the KB's own resource
  // identifier, derived from its committed did:web domain.
  it('maps [identity] to services.identity — type, issuer and subjectClaim pass through', () => {
    const toml = `
[environments.local.identity]
type = "oidc"
issuer = "https://login.example.com/realms/acme"
subjectClaim = "sub"
${MINIMAL_NO_IDENTITY}`;
    const cfg = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(toml), {});
    expect(cfg.services.identity).toEqual({
      type: 'oidc',
      issuer: 'https://login.example.com/realms/acme',
      subjectClaim: 'sub',
    });
  });

  it('ignores a leftover audience key rather than carrying it through', () => {
    // Fleet configs in other repos still declare one. It decides nothing now,
    // and must not reappear in the resolved services shape where a reader
    // could mistake it for the value tokens are checked against.
    const toml = `
[environments.local.identity]
type = "oidc"
issuer = "https://login.example.com/realms/acme"
subjectClaim = "sub"
audience = "semiont-gateway"
${MINIMAL_NO_IDENTITY}`;
    const cfg = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(toml), {});
    expect(cfg.services.identity).toEqual({
      type: 'oidc',
      issuer: 'https://login.example.com/realms/acme',
      subjectClaim: 'sub',
    });
  });

  // MANDATORY (user, 2026-09-21). Absence used to yield `services.identity`
  // undefined, which produced a knowledge base nobody could sign in to: no
  // person, because there are no keys to verify against; no sidecar, because
  // the agent-minter refuses before it mints; and a gateway unable to reach
  // its own record, because dialling the Archivist needs a service-account
  // token. Only a test harness ever wanted that state.
  it('REFUSES a config with no identity section — every KB trusts an issuer', () => {
    // A RAW reader: `makeReader` supplies the mandatory section for every other
    // test, so this one has to reach the loader without that help.
    const raw = {
      readIfExists: (p: string) =>
        p.endsWith('/.semiontconfig') ? MINIMAL_NO_IDENTITY
        : p.endsWith('/.semiont/config') ? '[project]\nname = "test-project"\n'
        : null,
    };
    expect(() =>
      loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', raw, {}).services.identity,
    ).toThrow(/names no identity section/);
  });

  it('refuses an [identity] section that names no type', () => {
    const toml = `
[environments.local.identity]
issuer = "https://login.example.com/realms/acme"
${MINIMAL_NO_IDENTITY}`;
    expect(() => loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(toml), {}).services.identity)
      .toThrow(/\[environments\.local\.identity\].*type/);
  });

  it('refuses [identity] with no issuer — typed-but-incomplete never falls through', () => {
    const toml = `
[environments.local.identity]
type = "keycloak"
audience = "semiont-gateway"
${MINIMAL_NO_IDENTITY}`;
    expect(() => loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(toml), {}).services.identity)
      .toThrow(/\[environments\.local\.identity\].*issuer/);
  });

  // VERIFIED-PROVENANCE P5. A person's DID is `did:web:<site domain>:users:<the
  // value of this claim>`, and which claim is DECLARED — one rule per
  // deployment, never a fallback chain, never an implied one. An operator who
  // wants email-named people writes subjectClaim = "email" and has said so.
  it('refuses [identity] with no subjectClaim — the claim people are named by is declared, never defaulted', () => {
    const toml = `
[environments.local.identity]
type = "keycloak"
issuer = "http://localhost:8080/realms/semiont"
${MINIMAL_NO_IDENTITY}`;
    expect(() => loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(toml), {}).services.identity)
      .toThrow(/\[environments\.local\.identity\].*subjectClaim/);
  });

  it('resolves ${VAR} placeholders in identity.issuer from the loader env', () => {
    const toml = `
[environments.local.identity]
type = "keycloak"
issuer = "http://\${KEYCLOAK_HOST}:8080/realms/semiont"
subjectClaim = "sub"
${MINIMAL_NO_IDENTITY}`;
    const cfg = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(toml), { KEYCLOAK_HOST: '10.0.0.9' });
    expect(cfg.services.identity?.issuer).toBe('http://10.0.0.9:8080/realms/semiont');
  });

  // A knowledge base declares its identity once: `[site]`, at the top level of
  // its committed .semiont/config. An environment-scoped [site] used to replace
  // that table whole — domain included — so an environment could rename the
  // KB's agents and people, and silently drop the domain by declaring only a
  // siteName. Nothing overrides a KB's identity; the section is refused.
  it.each([
    ['/home/user/.semiontconfig', (section: string) => makeReader(`${MINIMAL_TOML}\n${section}`)],
    ['/project/.semiont/config', (section: string) => makeReader(MINIMAL_TOML, `[project]\nname = "test-project"\n\n${section}`)],
  ])('refuses an environment-scoped [site] in %s, naming the section and the file', (file, reader) => {
    const load = () => loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', reader('[environments.local.site]\nsiteName = "Example"\n'), {});

    expect(load).toThrow('[environments.local.site]');
    expect(load).toThrow(file);
  });

  it('reads nothing from the committed [site]: the KB\'s identity is read where it is committed', () => {
    const config = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig',
      makeReader(MINIMAL_TOML, '[project]\nname = "test-project"\n\n[site]\ndomain = "example.github.io:kb"\n'), {});

    expect(Object.keys(config)).not.toContain('site');
  });

  it('carries the staged [kb] identity, so a gateway with no [site] still knows which KB it serves', () => {
    // SINGLE-KB-MOUNT: the gateway stopped mounting the tree that holds
    // `.semiont/config`, so the launcher stages the committed identity under
    // [kb]. Without it a well-formed KB could not start.
    const toml = `
[kb]
name = "example-kb"
domain = "example.github.io:test-kb"

[defaults]
environment = "local"

[environments.local.gateway]
platform = "posix"
port = 3001

[environments.local.make-meaning.graph]
type = "memory"
${SERVICES_LOCAL}`;
    const config = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(toml), {});

    expect(config.kb?.name).toBe('example-kb');
    expect(config.kb?.domain).toBe('example.github.io:test-kb');
  });

  it('maps top-level [kb] to config.kb', () => {
    const toml = `
[kb]
name = "example-kb"
domain = "example.github.io:test-kb"
${MINIMAL_TOML}`;
    const cfg = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(toml), {});
    expect(cfg.kb).toEqual({ name: 'example-kb', domain: 'example.github.io:test-kb' });
  });

  it('leaves config.kb undefined when no [kb] section is staged', () => {
    const cfg = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(MINIMAL_TOML), {});
    expect(cfg.kb).toBeUndefined();
  });

  it('never populates config.kb from an environment section — the staged identity is not overridable', () => {
    const toml = `
[environments.local.kb]
name = "some-other-kb"
${MINIMAL_TOML}`;
    const cfg = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(toml), {});
    expect(cfg.kb).toBeUndefined();
  });

  // The Librarian loads config with NO project root at all — no /kb mount
  // (SINGLE-KB-MOUNT P1). Everything it needs rides the staged global config.
  it('loads with a null project root when the global config carries the environment', () => {
    const toml = `
[kb]
name = "example-kb"
${MINIMAL_TOML}`;
    const cfg = loadTomlConfig(null, 'local', '/home/user/.semiontconfig', makeReader(toml), {});
    expect(cfg.kb?.name).toBe('example-kb');
    expect(cfg.kb?.domain).toBeUndefined();
    expect(cfg.services?.gateway?.port).toBe(3001);
  });

  it('lets an explicit environment win over [defaults]', () => {
    const config = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(DEFAULTS_STAGING), {});
    expect(config._metadata?.environment).toBe('local');
    expect(config.services?.gateway?.port).toBe(3001);
  });

  it('refuses a config naming no vector store, config-actionably (MANDATORY-EMBEDDING D1)', () => {
    const noVectors = MINIMAL_TOML.replace(/\[environments\.local\.vectors\][^[]*/, '');
    expect(() =>
      loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(noVectors), {}).services.vectors
    ).toThrow(/names no vector store/);
  });

  it('refuses a config naming no embedding provider, config-actionably (MANDATORY-EMBEDDING D1)', () => {
    // Anchored to the NEXT table rather than end-of-string: the fixture no
    // longer ends with [embedding] now that identity follows it.
    const noEmbedding = MINIMAL_TOML.replace(/\[environments\.local\.embedding\][\s\S]*?(?=\n\[|$)/, '');
    expect(() =>
      loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(noEmbedding), {}).services.embedding
    ).toThrow(/names no embedding provider/);
  });

  it('throws when nothing selects an environment (no arg, no [defaults]) even if SEMIONT_ENV is set', () => {
    // MINIMAL_TOML declares [environments.local] but no [defaults] environment.
    // SEMIONT_ENV=local must NOT rescue it — that is the input being removed.
    expect(() =>
      loadTomlConfig('/project', undefined, '/home/user/.semiontconfig', makeReader(MINIMAL_TOML), { SEMIONT_ENV: 'local' })
    ).toThrow(/environment/i);
  });
});

// The gateway/backend alias, pinned row for row. `resolveGatewaySection` in
// apps/launcher/internal/launcher/config.go implements these SAME four cases
// against an independently-written Go struct — no schema is shared between the
// lanes, so the pair of test blocks is what keeps them honest. Change one, change
// the other.
describe('loadTomlConfig — the gateway/backend section alias', () => {
  const withSection = (key: 'gateway' | 'backend') => `
[defaults]
environment = "local"

[environments.local.${key}]
platform = "posix"
port = 3001
publicURL = "http://localhost:3001"

[environments.local.make-meaning.graph]
type = "memory"
${SERVICES_LOCAL}`;

  it('row 1 — gateway only: used', () => {
    const config = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(withSection('gateway')), {});
    expect(config.services?.gateway?.port).toBe(3001);
    expect(config.services?.gateway?.publicURL).toBe('http://localhost:3001');
  });

  it('row 2 — backend only: used, and lands on services.gateway (the compat path)', () => {
    // The whole point of the alias: a fleet KB that still says `backend` loads,
    // and every consumer downstream reads the ONE current name.
    const config = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(withSection('backend')), {});
    expect(config.services?.gateway?.port).toBe(3001);
    expect(config.services?.gateway?.publicURL).toBe('http://localhost:3001');
  });

  it('row 3 — both: throws, naming both keys', () => {
    // Not "gateway wins". A file with both is half-migrated, and picking a
    // winner silently leaves the next reader unable to tell which one is live.
    const both = `
[defaults]
environment = "local"

[environments.local.gateway]
platform = "posix"
port = 3001

[environments.local.backend]
platform = "posix"
port = 4001

[environments.local.make-meaning.graph]
type = "memory"
${SERVICES_LOCAL}`;
    expect(() =>
      loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(both), {}).services.gateway
    ).toThrow(/both \[gateway\] and \[backend\]/);
  });

  it('row 4 — neither: services.gateway is absent, and nothing is invented', () => {
    const neither = `
[defaults]
environment = "local"

[environments.local.make-meaning.graph]
type = "memory"
${SERVICES_LOCAL}`;
    const config = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(neither), {});
    expect(config.services?.gateway).toBeUndefined();
  });
});

// SECRET-DELIVERY P5, as ruled: a section's ${VAR}s resolve when a service
// reads that section ("Loader resolves lazily"), and a service reads only the
// sections specs/src/service-config/sections.json lists for it ("Spec file,
// enforced lazily"). That is what lets the launcher forward each service only
// the variables its own sections reference.
describe('sections resolve when read, and a service reads only what it declares', () => {
  const UNREAD_SECRET = `
[environments.local.inference.anthropic]
platform = "external"
apiKey = "\${UNSET_P5_KEY}"
`;

  it('an unset variable in a section nothing reads does not refuse the load', () => {
    const cfg = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(`${MINIMAL_TOML}${UNREAD_SECRET}`), {});
    expect(cfg.services.identity.issuer).toBe('http://localhost:8080/realms/semiont');
  });

  it('reading that section refuses, naming the variable', () => {
    const cfg = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(`${MINIMAL_TOML}${UNREAD_SECRET}`), {});
    expect(() => cfg.inference).toThrow(/UNSET_P5_KEY/);
  });

  it('a service reading a section it does not declare refuses, naming the section and the spec', () => {
    const cfg = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(MINIMAL_TOML), {}, 'weaver');
    expect(cfg.services.identity.type).toBe('keycloak');
    expect(() => cfg.services.vectors).toThrow(/weaver.*\[environments\.local\.vectors\].*specs\/src\/service-config\/sections\.json/);
  });
});

// Who is on the collaborator roster is a keyless fact: each role's provider
// and model. The archivist lists the roster and holds no inference credential
// (ruled 2026-09-29: "The worker and the librarian are the only two images
// that should get inference secrets"), so it reads the keyless maps and never
// [inference]. They must select exactly what the credentialed maps select.
describe('the keyless roster maps', () => {
  const ROSTER = `${MINIMAL_TOML}
[environments.local.inference.anthropic]
platform = "external"
apiKey = "\${UNSET_ROSTER_KEY}"

[environments.local.inference.ollama]
platform = "external"
baseURL = "http://ollama.internal:11434"

[environments.local.workers.default.inference]
type = "anthropic"
model = "m-default"

[environments.local.workers.generation.inference]
type = "anthropic"
model = "m-generation"

[environments.local.make-meaning.default.inference]
type = "ollama"
model = "g-fallback"

[environments.local.actors.matcher.inference]
type = "anthropic"
model = "m-matcher"
`;

  it('an archivist reads them without reading [inference], which it cannot', () => {
    const cfg = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(ROSTER), {}, 'archivist');
    expect(cfg.workers).toEqual({
      default: { inference: { type: 'anthropic', model: 'm-default' } },
      generation: { inference: { type: 'anthropic', model: 'm-generation' } },
    });
    // The gatherer names no section of its own: make-meaning.default serves it.
    expect(cfg.actors).toEqual({
      gatherer: { inference: { type: 'ollama', model: 'g-fallback' } },
      matcher: { inference: { type: 'anthropic', model: 'm-matcher' } },
    });
    expect(() => cfg.inference).toThrow(/archivist.*\[environments\.local\.inference\]/);
  });

  it('they select what the credentialed maps select, role by role', () => {
    const cfg = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(ROSTER), { UNSET_ROSTER_KEY: 'k' }, 'librarian');
    const pick = (i: { type?: string; model?: string }) => ({ type: i.type, model: i.model });
    const merged = cfg._metadata?.actors as Record<string, { type: string; model: string }>;
    for (const [role, { inference }] of Object.entries(cfg.actors ?? {})) {
      expect(inference && pick(inference), role).toEqual(pick(merged[role]!));
    }
    expect(Object.keys(cfg.actors ?? {}).sort()).toEqual(Object.keys(merged).sort());

    const worker = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(ROSTER), { UNSET_ROSTER_KEY: 'k' }, 'worker');
    const mergedWorkers = worker._metadata?.workers as Record<string, { type: string; model: string }>;
    for (const [role, { inference }] of Object.entries(worker.workers ?? {})) {
      expect(inference && pick(inference), role).toEqual(pick(mergedWorkers[role]!));
    }
    expect(Object.keys(worker.workers ?? {}).sort()).toEqual(Object.keys(mergedWorkers).sort());
  });
});

// What each part of the config maps to, read part by part. These paths are
// the loader's own, built at each part's first read (SECRET-DELIVERY P5).
describe('each part maps its section', () => {
  const load = (toml: string, env: Record<string, string> = {}) =>
    loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(toml), env);
  const BASE = `
[environments.local.gateway]
platform = "posix"
port = 3001
`;

  it('workers inherit credentials from the keyed [inference.anthropic]', () => {
    const cfg = load(`${MINIMAL_TOML}
[environments.local.inference.anthropic]
platform = "external"
apiKey = "k"

[environments.local.workers.default.inference]
type = "anthropic"
model = "m"
`);
    const workers = cfg._metadata?.workers as Record<string, { apiKey?: string; endpoint?: string; model?: string }>;
    expect(workers.default).toMatchObject({ model: 'm', apiKey: 'k' });
    expect(cfg.inference?.anthropic).toMatchObject({ apiKey: 'k', endpoint: 'https://api.anthropic.com' });
    expect(cfg.workers).toEqual({ default: { inference: { type: 'anthropic', model: 'm' } } });
  });

  it('workers inherit baseURL and maxTokens from a flat [inference] of type ollama', () => {
    const cfg = load(`${MINIMAL_TOML}
[environments.local.inference]
type = "ollama"
platform = "external"
baseURL = "http://ollama.internal:11434"
maxTokens = 512

[environments.local.workers.generation.inference]
type = "ollama"
model = "gemma"
`);
    const workers = cfg._metadata?.workers as Record<string, { baseURL?: string; maxTokens?: number }>;
    expect(workers.generation).toMatchObject({ baseURL: 'http://ollama.internal:11434', maxTokens: 512 });
    expect(cfg.inference?.ollama).toMatchObject({ baseURL: 'http://ollama.internal:11434' });
  });

  it('a flat [inference] with no type refuses at the read that needs it', () => {
    for (const type of ['anthropic', 'ollama']) {
      const cfg = load(`${MINIMAL_TOML}
[environments.local.inference]
platform = "external"

[environments.local.workers.default.inference]
type = "${type}"
model = "m"
`);
      expect(() => cfg._metadata?.workers).toThrow(/inference\] is missing 'type'/);
    }
  });

  it('maps a flat anthropic provider and a keyed ollama one, with their defaults', () => {
    const cfg = load(`${MINIMAL_TOML}
[environments.local.inference]
type = "anthropic"
platform = "external"
apiKey = "k"

[environments.local.inference.ollama]
platform = "external"
baseURL = "http://ollama.internal:11434"

[environments.local.workers.default.inference]
type = "anthropic"
model = "a"

[environments.local.workers.generation.inference]
type = "ollama"
model = "o"
`);
    expect(cfg.inference?.anthropic).toMatchObject({ apiKey: 'k', endpoint: 'https://api.anthropic.com' });
    expect(cfg.inference?.ollama).toMatchObject({ baseURL: 'http://ollama.internal:11434' });
    // A flat anthropic section hands its key down; a keyed ollama its baseURL.
    const workers = cfg._metadata?.workers as Record<string, { apiKey?: string; baseURL?: string }>;
    expect(workers.default.apiKey).toBe('k');
    expect(workers.generation.baseURL).toBe('http://ollama.internal:11434');
  });

  it('a config with no [inference] maps no providers', () => {
    expect(load(MINIMAL_TOML).inference).toBeUndefined();
  });

  it('maps the actor maps from [actors] and [make-meaning.actors]', () => {
    const cfg = load(`${MINIMAL_TOML}
[environments.local.actors.gatherer.inference]
type = "anthropic"
model = "g"
apiKey = "k"

[environments.local.make-meaning.actors.matcher.inference]
type = "anthropic"
model = "mm"
apiKey = "k"

[environments.local.make-meaning.actors.gatherer.inference]
type = "anthropic"
model = "mg"
apiKey = "k"
`);
    // [make-meaning.actors] wins over [actors] for the same actor.
    expect(cfg.actors).toEqual({
      gatherer: { inference: { type: 'anthropic', model: 'mg' } },
      matcher: { inference: { type: 'anthropic', model: 'mm' } },
    });
  });

  it('maps [graph] and [database], with their defaults', () => {
    const cfg = load(`${BASE}
[environments.local.graph]
platform = "external"
uri = "bolt://neo4j.internal:7687"

[environments.local.database]
platform = "external"
name = "semiont"

[environments.local.vectors]
type = "memory"

[environments.local.embedding]
type = "ollama"
model = "nomic-embed-text"
`);
    expect(cfg.services.graph).toMatchObject({ type: 'neo4j', uri: 'bolt://neo4j.internal:7687', platform: { type: 'external' } });
    expect(cfg.services.database).toMatchObject({ type: 'postgres', host: 'localhost', port: 5432, name: 'semiont' });
  });

  it('a [graph] with no platform refuses at its read', () => {
    const cfg = load(`${BASE}
[environments.local.graph]
type = "neo4j"

[environments.local.vectors]
type = "memory"

[environments.local.embedding]
type = "ollama"
model = "nomic-embed-text"
`);
    expect(() => cfg.services.graph).toThrow(/platform is required for service 'graph'/);
  });

  it('vectors default their port, and chunking falls back to [vectors]', () => {
    const cfg = load(`${BASE}
[environments.local.vectors]
type = "qdrant"
host = "qdrant.internal"

[environments.local.vectors.chunking]
chunkSize = 256

[environments.local.embedding]
type = "ollama"
model = "nomic-embed-text"
`);
    expect(cfg.services.vectors).toMatchObject({ host: 'qdrant.internal', port: 6333 });
    expect(cfg.services.database).toBeUndefined();
    expect(cfg.services.embedding?.chunking).toEqual({ chunkSize: 256, overlap: 64 });
  });

  it('resolves a ${VAR} inside an array', () => {
    expect(resolveEnvVars({ servers: ['${A}:4222', 'b:4222'] }, { A: 'a' })).toEqual({ servers: ['a:4222', 'b:4222'] });
  });

  it('merges a nested project section under the user config', () => {
    const project = `[project]\nname = "p"\n\n[environments.local.graph]\nplatform = "external"\ntype = "neo4j"\nuri = "bolt://project:7687"\ndatabase = "neo4j"\n`;
    const user = `${BASE}
[environments.local.graph]
uri = "bolt://user:7687"

[environments.local.vectors]
type = "memory"

[environments.local.embedding]
type = "ollama"
model = "nomic-embed-text"
`;
    const cfg = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(user, project), {});
    expect(cfg.services.graph).toMatchObject({ uri: 'bolt://user:7687', database: 'neo4j' });
  });

  it('createTomlConfigLoader hands its service to the loader', () => {
    const cfg = createTomlConfigLoader(makeReader(MINIMAL_TOML), '/home/user/.semiontconfig', {}, 'weaver')('/project', 'local');
    expect(() => cfg.services.vectors).toThrow(/weaver/);
  });
});
