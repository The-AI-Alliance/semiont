/**
 * Serve Command
 *
 * One command that takes a new user from nothing to a running Semiont instance.
 * Replaces the manual sequence: mkdir → init → provision → start → check → useradd.
 *
 * Flow:
 * 1. Resolve/prompt SEMIONT_ROOT and SEMIONT_ENV
 * 2. semiont init (if not already initialized)
 * 3. For each service: check → provision/start as needed
 * 4. semiont useradd (hardcoded admin@example.com / password)
 * 5. semiont check (final)
 * 6. Print summary with login URL and env var reminders
 */

import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { execFileSync } from 'child_process';
import { colors } from '../io/cli-colors.js';
import { CommandResults } from '../command-types.js';
import { CommandBuilder } from '../command-definition.js';
import { OpsOptionsSchema, withOpsArgs } from '../base-options-schema.js';
import { ensureGlobalConfig } from './init.js';
import { loadEnvironmentConfig } from '../config-loader.js';

// =====================================================================
// SCHEMA
// =====================================================================

const ServeOptionsSchema = OpsOptionsSchema.extend({
  directory: z.string().optional(),
  yes: z.boolean().default(false),
}).transform((data) => ({
  ...data,
  environment: data.environment || '_local_',
}));

type ServeOptions = z.output<typeof ServeOptionsSchema>;

// =====================================================================
// HELPERS
// =====================================================================

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}


function runSemiont(args: string[], env: NodeJS.ProcessEnv, captureOutput = false): string {
  return execFileSync('semiont', args, {
    env,
    stdio: captureOutput ? 'pipe' : 'inherit',
    encoding: 'utf8',
  }) as string;
}

function runSemiontSafe(args: string[], env: NodeJS.ProcessEnv): { success: boolean; output: string; error: string } {
  try {
    const output = execFileSync('semiont', args, {
      env,
      stdio: 'pipe',
      encoding: 'utf8',
    }) as string;
    return { success: true, output: output || '', error: '' };
  } catch (err: any) {
    return {
      success: false,
      output: err.stdout || '',
      error: err.stderr || err.message || '',
    };
  }
}

// =====================================================================
// SERVICE READINESS
// =====================================================================

const REQUIRED_SERVICES = ['database', 'backend'];
const EXTERNAL_SERVICES = ['graph', 'inference'];
const ALL_SERVICES = [...REQUIRED_SERVICES, ...EXTERNAL_SERVICES];

type ServiceStatus = 'healthy' | 'stopped' | 'unhealthy' | 'unknown';

interface ServiceCheckResult {
  name: string;
  status: ServiceStatus;
  healthy: boolean;
  // Whether the service has been provisioned, as reported by the check handler.
  // Undefined means the handler didn't set it — treat as provisioned (default true).
  provisioned?: boolean;
}

function parseCheckOutput(jsonOutput: string): ServiceCheckResult[] {
  try {
    const parsed = JSON.parse(jsonOutput);
    const results: ServiceCheckResult[] = [];
    const items: any[] = parsed.results || [];
    for (const item of items) {
      const name: string = item.entity || '';
      const extensions = item.extensions || {};
      const statusStr: string = extensions.status || 'unknown';
      const health = extensions.health;
      const healthy: boolean = item.success && (health?.healthy ?? statusStr === 'running');
      const status: ServiceStatus =
        statusStr === 'running' && healthy ? 'healthy' :
        statusStr === 'running' ? 'unhealthy' :
        statusStr === 'stopped' ? 'stopped' : 'unknown';
      results.push({
        name,
        status,
        healthy,
        provisioned: extensions.provisioned,
      });
    }
    return results;
  } catch {
    return [];
  }
}

// =====================================================================
// COMMAND IMPLEMENTATION
// =====================================================================

async function serve(options: ServeOptions): Promise<CommandResults> {
  const startTime = Date.now();
  const envVarsToAdvise: string[] = [];
  const warnings: string[] = [];

  const results: CommandResults & { metadata?: any; error?: string } = {
    command: 'local',
    environment: 'local',
    timestamp: new Date(),
    duration: 0,
    results: [],
    summary: { total: 0, succeeded: 0, failed: 0, warnings: 0 },
    executionContext: {
      user: process.env.USER || 'unknown',
      workingDirectory: process.cwd(),
      dryRun: false,
    },
  };

  console.log(`\n${colors.bright}🌐 Semiont Local Setup${colors.reset}\n`);

  try {
    // ─── Step 1: Project directory ───────────────────────────────────────

    // Only check cwd (or --directory if given) — do NOT walk up. Walking up would
    // silently adopt an ancestor project, which is wrong for `semiont local`.
    const explicitDir = options.directory ? path.resolve(options.directory) : null;
    let semiotRoot = '';
    const checkDir = explicitDir || process.cwd();
    if (fs.existsSync(path.join(checkDir, '.semiont'))) {
      semiotRoot = checkDir;
    }

    if (!semiotRoot) {
      const defaultPath = explicitDir || process.cwd();
      const answer = options.yes || explicitDir
        ? ''
        : await prompt(
            `${colors.cyan}No .semiont/ project found.${colors.reset}\n` +
            `Press Enter to create one in ${colors.bright}${defaultPath}${colors.reset}, or type a path: `
          );
      semiotRoot = answer || defaultPath;
      fs.mkdirSync(semiotRoot, { recursive: true });
      process.env.SEMIONT_ROOT = semiotRoot;
      envVarsToAdvise.push(`export SEMIONT_ROOT=${semiotRoot}`);
      console.log(`${colors.green}✓${colors.reset} Using ${semiotRoot}\n`);
      if (semiotRoot !== process.cwd()) {
        console.log(`${colors.dim}Tip: cd ${semiotRoot} to run semiont commands without SEMIONT_ROOT${colors.reset}\n`);
      }
    } else {
      console.log(`${colors.green}✓${colors.reset} Found project at ${semiotRoot}\n`);
      process.env.SEMIONT_ROOT = semiotRoot;
    }

    // ─── Step 1b: SEMIONT_ENV ───────────────────────────────────────────

    let semiotEnv = process.env.SEMIONT_ENV || '';
    if (!semiotEnv) {
      semiotEnv = 'local';
      process.env.SEMIONT_ENV = semiotEnv;
      envVarsToAdvise.push(`export SEMIONT_ENV=local`);
      console.log(`${colors.dim}SEMIONT_ENV not set, using "local"${colors.reset}\n`);
    } else {
      console.log(`${colors.green}✓${colors.reset} SEMIONT_ENV=${semiotEnv}\n`);
    }

    const env = { ...process.env } as NodeJS.ProcessEnv;

    // ─── Step 1c: Global config ──────────────────────────────────────────

    await ensureGlobalConfig(false);

    // ─── Step 2: Init ───────────────────────────────────────────────────

    const isInitialized = fs.existsSync(path.join(semiotRoot, '.semiont'));

    if (isInitialized) {
      console.log(`${colors.green}✓${colors.reset} Project already initialized\n`);
    } else {
      console.log(`${colors.cyan}▶ Initializing project...${colors.reset}`);
      try {
        runSemiont(['init'], env);
        console.log(`${colors.green}✓${colors.reset} Project initialized\n`);
      } catch (err) {
        const initMsg = err instanceof Error ? err.message : String(err);
        console.error(`${colors.red}✗ semiont init failed — cannot continue${colors.reset}`);
        console.error(`  ${initMsg}`);
        results.summary.failed = 1;
        results.duration = Date.now() - startTime;
        return results;
      }
    }

    // ─── Step 3: Service readiness loop ─────────────────────────────────

    // Derive which services are external from the actual environment config.
    // Fallback to the static list if the config isn't available yet (e.g. before init).
    let externalServices = EXTERNAL_SERVICES;
    try {
      const cfg = loadEnvironmentConfig(semiotRoot, semiotEnv);
      externalServices = ALL_SERVICES.filter(name => {
        const svc = (cfg.services as Record<string, { platform?: unknown } | undefined>)?.[name];
        return svc?.platform === 'external';
      });
    } catch {
      // Config not yet available — use static defaults
    }

    console.log(`${colors.cyan}▶ Checking services...${colors.reset}`);
    const checkResult = runSemiontSafe(['check', '--all', '--output', 'json'], env);
    const serviceStatuses = parseCheckOutput(checkResult.output);

    // Build a lookup by name
    const statusByName = new Map<string, ServiceCheckResult>(
      serviceStatuses.map(s => [s.name, s])
    );

    for (const serviceName of ALL_SERVICES) {
      const info = statusByName.get(serviceName);
      const isExternal = externalServices.includes(serviceName);

      if (!info) {
        // Service not reported — treat as needing provision+start
        if (isExternal) {
          warnings.push(`${serviceName}: not found in check output (external — skipping)`);
          console.log(`  ${colors.yellow}⚠ ${serviceName}${colors.reset} (external): not found in check output`);
          continue;
        }
        console.log(`  ${colors.yellow}? ${serviceName}${colors.reset}: not found — provisioning...`);
      } else if (info.healthy) {
        console.log(`  ${colors.green}✓ ${serviceName}${colors.reset}: running`);
        continue;
      } else if (isExternal && !info.healthy) {
        warnings.push(`${serviceName}: unhealthy (external service — check credentials)`);
        console.log(`  ${colors.yellow}⚠ ${serviceName}${colors.reset} (external): unhealthy — check your credentials`);
        continue;
      }

      // Decide: provision+start or start only.
      // Check handlers set provisioned=false when their sentinel is absent.
      // Undefined means the handler didn't specify — default to provisioned.
      const alreadyProvisioned = info
        ? info.status === 'stopped' && (info.provisioned ?? true)
        : false;

      if (!alreadyProvisioned) {
        console.log(`  ${colors.cyan}  provisioning ${serviceName}...${colors.reset}`);
        const provResult = runSemiontSafe(['provision', '--service', serviceName], env);
        if (!provResult.success) {
          const combinedOutput = provResult.error + provResult.output;
          if (combinedOutput.includes("does not support capability 'provision'")) {
            // Service doesn't support provision (e.g. external) — skip silently
          } else {
            const msg = `Failed to provision ${serviceName}: ${provResult.error}`;
            if (isExternal) {
              warnings.push(msg);
              console.log(`  ${colors.yellow}  ⚠ ${msg}${colors.reset}`);
              continue;
            } else {
              throw new Error(msg);
            }
          }
        }
      }

      console.log(`  ${colors.cyan}  starting ${serviceName}...${colors.reset}`);
      const startResult = runSemiontSafe(['start', '--service', serviceName], env);
      if (!startResult.success) {
        const combinedOutput = startResult.error + startResult.output;
        if (combinedOutput.includes("does not support capability 'start'")) {
          // Service doesn't support start — skip silently
        } else {
          const msg = `Failed to start ${serviceName}: ${startResult.error}`;
          if (isExternal) {
            warnings.push(msg);
            console.log(`  ${colors.yellow}  ⚠ ${msg}${colors.reset}`);
          } else {
            throw new Error(msg);
          }
        }
      } else {
        console.log(`  ${colors.green}  ✓ ${serviceName} started${colors.reset}`);
      }
    }

    console.log('');

    // ─── Step 4: Admin credentials ──────────────────────────────────────

    const adminEmail = 'admin@example.com';
    const adminPassword = 'password';

    console.log(`${colors.cyan}▶ Creating admin user...${colors.reset}`);
    const useraddResult = runSemiontSafe(
      ['useradd', '--email', adminEmail, '--password', adminPassword, '--admin', '--upsert'],
      env
    );
    if (useraddResult.success) {
      console.log(`${colors.green}✓${colors.reset} Admin user ready\n`);
    } else {
      console.log(`${colors.yellow}⚠ useradd failed: ${useraddResult.error}${colors.reset}`);
      console.log(`  Run manually: semiont useradd --email ${adminEmail} --password ${adminPassword} --admin\n`);
      warnings.push(`useradd failed: ${useraddResult.error}`);
    }

    // ─── Step 5: Final check ─────────────────────────────────────────────

    console.log(`${colors.cyan}▶ Final service check...${colors.reset}\n`);
    runSemiont(['check', ...ALL_SERVICES.flatMap(s => ['--service', s])], env);

    // ─── Step 6: Summary ─────────────────────────────────────────────────

    const envConfig = loadEnvironmentConfig(semiotRoot, semiotEnv);
    const backendUrl = envConfig.services?.backend?.publicURL ?? 'http://localhost:4000';

    console.log(`\n${colors.bright}${colors.green}✓ Semiont Knowledge Base is running at ${backendUrl}${colors.reset}\n`);
    console.log(`  Admin email:    ${adminEmail}`);
    console.log(`  Admin password: ${adminPassword}`);
    console.log('');
    console.log(`  To start the frontend UI:`);
    console.log(`  ${colors.cyan}semiont start --service frontend${colors.reset}`);

    if (warnings.length > 0) {
      console.log(`\n${colors.yellow}Warnings:${colors.reset}`);
      for (const w of warnings) {
        console.log(`  ${colors.yellow}⚠${colors.reset} ${w}`);
      }
    }

    if (envVarsToAdvise.length > 0) {
      console.log(`\nTo persist your environment across sessions, add to your shell profile:`);
      for (const line of envVarsToAdvise) {
        console.log(`  ${colors.cyan}${line}${colors.reset}`);
      }
    }

    results.summary.succeeded = 1;
    results.metadata = { semiotRoot, semiotEnv };

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`\n${colors.red}✗ Setup failed: ${msg}${colors.reset}`);
    results.summary.failed = 1;
    results.error = msg;
  }

  results.duration = Date.now() - startTime;
  return results;
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const serveCommand = new CommandBuilder()
  .name('serve')
  .description('Set up and start Semiont locally (init + provision + start + useradd)')
  .schema(ServeOptionsSchema)
  .args(withOpsArgs({
    '--directory': {
      type: 'string',
      description: 'Project directory (default: cwd)',
    },
    '--yes': {
      type: 'boolean',
      description: 'Non-interactive: accept all defaults (for scripts)',
      default: false,
    },
  }, {
    '-y': '--yes',
  }))
  .requiresEnvironment(false)
  .requiresServices(false)
  .examples(
    'semiont serve',
    'semiont serve --yes',
    'semiont serve --directory /opt/myproject --yes',
  )
  .setupHandler(serve)
  .build();
