import { describe, it, expect } from 'vitest';
import { loadTomlConfig } from '../../config/toml-loader';

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

const MINIMAL_TOML = `
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

const WITH_ENV_VAR_TOML = `
[environments.local.make-meaning.actors.gatherer.inference]
type = "anthropic"
model = "claude-haiku-4-5-20251001"
apiKey = "\${MY_API_KEY}"
${SERVICES_LOCAL}`;

function makeReader(globalContent: string | null, projectContent?: string): { readIfExists: (p: string) => string | null } {
  return {
    readIfExists: (p: string) => {
      if (p.endsWith('/.semiontconfig')) return globalContent;
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

  it('reads project name from .semiont/config', () => {
    const config = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(MINIMAL_TOML, '[project]\nname = "my-project"\n'), {});

    expect((config._metadata as any)?.projectName).toBe('my-project');
  });

  it('stores actor inference config in _metadata', () => {
    const config = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(WITH_INFERENCE_TOML), {});

    const actors = (config._metadata as any)?.actors;
    expect(actors?.gatherer?.model).toBe('claude-haiku-4-5-20251001');
    expect(actors?.matcher?.maxTokens).toBe(2048);
  });

  it('stores worker inference config in _metadata with inheritance', () => {
    const config = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(WITH_INFERENCE_TOML), {});

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
    const config = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(WITH_ENV_VAR_TOML), { MY_API_KEY: 'sk-secret' });

    const actors = (config._metadata as any)?.actors;
    expect(actors?.gatherer?.apiKey).toBe('sk-secret');
  });

  it('throws when ${VAR} references a missing env var', () => {
    expect(() =>
      loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(WITH_ENV_VAR_TOML), {})
    ).toThrow('Environment variable MY_API_KEY is not set');
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
    // (The worst of those, site.domain -> 'localhost', is gone — see the
    // domain-less [site] test below — but throwing here is still the fix.)
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
${SERVICES_LOCAL}`;

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

  // SINGLE-KB-MOUNT D4: the launcher stages the KB's committed identity into
  // the config it hands a container, under its own TOP-LEVEL key — never
  // [site], whose domain an environment section can override into an identity
  // the KB never declared. [kb] lives beside [defaults] in the file root, so
  // an environment section cannot reach it by construction.
  // A `[site]` section is routinely added for an unrelated key — most often
  // `oauthAllowedDomains` — and the loader used to fill in the missing `domain`
  // with the literal 'localhost'. That silently renamed the KB's agents to
  // did:web:localhost, an identity every other domain-less KB on the machine
  // also claims. Absent must stay absent so a consumer can fall back to the
  // committed [kb] domain, or refuse; neither is possible on top of a
  // fabricated value.
  it('never manufactures a domain for a [site] section that omits one', () => {
    const toml = `
[defaults]
environment = "local"

[environments.local.gateway]
platform = "posix"
port = 3001

[environments.local.site]
oauthAllowedDomains = ["example.com"]

[environments.local.make-meaning.graph]
type = "memory"
${SERVICES_LOCAL}`;
    const config = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(toml), {});

    expect(config.site?.domain).toBeUndefined();
    // The section still carries what it was actually added for.
    expect(config.site?.oauthAllowedDomains).toEqual(['example.com']);
  });

  it('carries the staged [kb] sign-in policy, so a gateway with no [site] can still authenticate', () => {
    // SINGLE-KB-MOUNT: the gateway stopped mounting the tree that holds
    // `.semiont/config`, so the launcher stages both committed facts under
    // [kb]. Staging the identity but not the policy left a well-formed KB
    // unable to start.
    const toml = `
[kb]
name = "example-kb"
domain = "example.github.io:test-kb"
oauthAllowedDomains = ["example.com"]

[defaults]
environment = "local"

[environments.local.gateway]
platform = "posix"
port = 3001

[environments.local.make-meaning.graph]
type = "memory"
${SERVICES_LOCAL}`;
    const config = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(toml), {});

    expect(config.kb?.domain).toBe('example.github.io:test-kb');
    expect(config.kb?.oauthAllowedDomains).toEqual(['example.com']);
    expect(config.site).toBeUndefined();
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
      loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(noVectors), {})
    ).toThrow(/names no vector store/);
  });

  it('refuses a config naming no embedding provider, config-actionably (MANDATORY-EMBEDDING D1)', () => {
    const noEmbedding = MINIMAL_TOML.replace(/\[environments\.local\.embedding\][^[]*$/, '');
    expect(() =>
      loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(noEmbedding), {})
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
      loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(both), {})
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
