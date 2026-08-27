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
[environments.local.backend]
platform = "posix"
port = 3001
publicURL = "http://localhost:3001"
# Deliberately left after FRONTEND-IS-THE-BROWSER P6: frontendURL was declared
# on the backend section and read by nothing, so it was deleted rather than
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
  it('maps backend section to EnvironmentConfig.services.backend', () => {
    const config = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(MINIMAL_TOML), {});

    expect(config.services?.backend?.port).toBe(3001);
    expect(config.services?.backend?.publicURL).toBe('http://localhost:3001');
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
    expect(config.services?.backend?.port).toBe(3001);
    expect(config._metadata?.environment).toBe('local');
  });

  it('throws for a named environment with no [environments.X] section', () => {
    // The silent `?? {}` here is exactly what let a mis-declared environment
    // load an empty section — every downstream default then fires, including
    // site.domain -> 'localhost', fabricating a did:web:localhost identity.
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
  // cfg.Defaults.Environment). The backend must resolve from the SAME key so a
  // KB's declared environment selects the section for BOTH halves.
  const DEFAULTS_STAGING = `
[defaults]
environment = "staging"

[environments.staging.backend]
platform = "posix"
port = 5005
publicURL = "http://localhost:5005"

[environments.local.backend]
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
    expect(config.services?.backend?.port).toBe(5005);
  });

  // `SEMIONT_ENV` is NOT an input. It was removed as a resolution input because an
  // ambient variable can disagree with the config the launcher just staged — the same
  // shape of bug as the hard-coded 'local' that #1108 removed. The chain is now two
  // inputs that cannot contradict each other: an explicit argument (tests) and
  // `[defaults] environment` (everything else).
  it('ignores SEMIONT_ENV entirely — it is not an input to resolution', () => {
    const config = loadTomlConfig('/project', undefined, '/home/user/.semiontconfig', makeReader(DEFAULTS_STAGING), { SEMIONT_ENV: 'local' });
    expect(config._metadata?.environment).toBe('staging');
    expect(config.services?.backend?.port).toBe(5005);
  });

  it('lets an explicit environment win over [defaults]', () => {
    const config = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(DEFAULTS_STAGING), {});
    expect(config._metadata?.environment).toBe('local');
    expect(config.services?.backend?.port).toBe(3001);
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
