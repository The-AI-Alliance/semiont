import { describe, it, expect } from 'vitest';
import { loadTomlConfig } from '../../config/toml-loader';

const MINIMAL_TOML = `
[environments.local.backend]
port = 3001
publicURL = "http://localhost:3001"
frontendURL = "http://localhost:3000"
corsOrigin = "http://localhost:3000"

[environments.local.make-meaning.graph]
type = "memory"
`;

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
`;

const WITH_ENV_VAR_TOML = `
[environments.local.make-meaning.actors.gatherer.inference]
type = "anthropic"
model = "claude-haiku-4-5-20251001"
apiKey = "\${MY_API_KEY}"
`;

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
    expect(config.services?.backend?.corsOrigin).toBe('http://localhost:3000');
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

  it('resolves ${VAR} env var references', () => {
    const config = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(WITH_ENV_VAR_TOML), { MY_API_KEY: 'sk-secret' });

    const actors = (config._metadata as any)?.actors;
    expect(actors?.gatherer?.apiKey).toBe('sk-secret');
  });

  it('leaves unresolved ${VAR} when env var is missing', () => {
    const config = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(WITH_ENV_VAR_TOML), {});

    const actors = (config._metadata as any)?.actors;
    expect(actors?.gatherer?.apiKey).toBe('${MY_API_KEY}');
  });

  it('returns empty config when global config file is not found', () => {
    const config = loadTomlConfig('/project', 'local', '/home/user/.semiontconfig', makeReader(null), {});
    expect(config.services?.backend).toBeUndefined();
    expect(config._metadata?.environment).toBe('local');
  });

  it('returns empty services for unknown environment', () => {
    const config = loadTomlConfig('/project', 'staging', '/home/user/.semiontconfig', makeReader(MINIMAL_TOML), {});

    // staging is not defined in MINIMAL_TOML — no error, just empty
    expect(config.services?.backend).toBeUndefined();
  });

  it('sets _metadata.environment and projectRoot', () => {
    const config = loadTomlConfig('/my/project', 'local', '/home/user/.semiontconfig', makeReader(MINIMAL_TOML), {});

    expect(config._metadata?.environment).toBe('local');
    expect(config._metadata?.projectRoot).toBe('/my/project');
  });
});
