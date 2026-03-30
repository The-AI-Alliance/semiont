/**
 * Clean Command
 *
 * Removes ephemeral files created by Semiont:
 *   - Log files        (.local/state/semiont/{project}/)
 *   - PID files        (runtime dir)
 *   - Generated config (.config/semiont/{project}/)
 *   - Docker volumes   (semiont-{service}-{env}-data)
 *   - Docker networks  (semiont-{env})
 *
 * Does NOT touch:
 *   - .semiont/events/   (system of record)
 *   - representations/   (committed data)
 *   - ~/.semiontconfig   (user config)
 *   - .semiont/config    (project config)
 *
 * Options:
 *   --force   Skip confirmation prompts
 *   --logs    Clean only log files
 *   --pids    Clean only PID files
 *   --config  Clean only generated config files
 *   --volumes Clean only Docker volumes
 *   --all     Clean everything (default when no filter flags given)
 */

import { z } from 'zod';
import * as fs from 'fs';
import * as readline from 'readline';
import { execFileSync } from 'child_process';
import { SemiontProject } from '@semiont/core/node';
import { colors } from '../io/cli-colors.js';
import { CommandResults } from '../command-types.js';
import { CommandBuilder } from '../command-definition.js';
import { OpsOptionsSchema, withOpsArgs } from '../base-options-schema.js';

// =====================================================================
// SCHEMA
// =====================================================================

export const CleanOptionsSchema = OpsOptionsSchema.extend({
  force: z.boolean().default(false),
  logs: z.boolean().default(false),
  pids: z.boolean().default(false),
  config: z.boolean().default(false),
  volumes: z.boolean().default(false),
}).transform((data) => ({
  ...data,
  environment: data.environment || 'local',
  output: data.output === 'table' ? 'summary' : data.output,
}));

export type CleanOptions = z.output<typeof CleanOptionsSchema>;

// =====================================================================
// HELPERS
// =====================================================================

function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

interface CleanTarget {
  label: string;
  paths?: string[];
  action?: () => Promise<string[]>; // Returns list of removed items
}

function sizeOf(p: string): number {
  try {
    const stat = fs.statSync(p);
    if (stat.isFile()) return stat.size;
    // Rough directory size: sum immediate children
    return fs.readdirSync(p).reduce((sum, child) => {
      try { return sum + fs.statSync(`${p}/${child}`).size; } catch { return sum; }
    }, 0);
  } catch { return 0; }
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function listDir(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir).map(f => `${dir}/${f}`);
  } catch { return []; }
}

function containerRuntime(): string | null {
  for (const rt of ['docker', 'podman']) {
    try {
      execFileSync(rt, ['info'], { stdio: 'ignore' });
      return rt;
    } catch { /* try next */ }
  }
  return null;
}

// =====================================================================
// COMMAND IMPLEMENTATION
// =====================================================================

export async function clean(options: CleanOptions): Promise<CommandResults> {
  const startTime = Date.now();
  const projectRoot = process.cwd();

  const results: CommandResults & { metadata?: any; error?: string } = {
    command: 'clean',
    environment: options.environment,
    timestamp: new Date(),
    duration: 0,
    results: [],
    summary: { total: 0, succeeded: 0, failed: 0, warnings: 0 },
    executionContext: {
      user: process.env.USER || 'unknown',
      workingDirectory: projectRoot,
      dryRun: options.dryRun || false,
    },
  };

  // Determine which categories to clean
  const anyFilter = options.logs || options.pids || options.config || options.volumes;
  const cleanLogs    = !anyFilter || options.logs;
  const cleanPids    = !anyFilter || options.pids;
  const cleanConfig  = !anyFilter || options.config;
  const cleanVolumes = !anyFilter || options.volumes;

  let project: SemiontProject;
  try {
    project = new SemiontProject(projectRoot);
  } catch (err) {
    results.summary.failed = 1;
    results.error = `Not a Semiont project: ${(err as Error).message}`;
    if (!options.quiet) {
      console.error(`${colors.red}❌ ${results.error}${colors.reset}`);
    }
    results.duration = Date.now() - startTime;
    return results;
  }

  const env = options.environment;
  const runtime = containerRuntime();

  // Build list of clean targets
  const targets: CleanTarget[] = [];

  // ── Logs ─────────────────────────────────────────────────────────────
  if (cleanLogs) {
    const logFiles: string[] = [];
    for (const svc of ['backend', 'frontend', 'graph', 'inference', 'database', 'mcp']) {
      logFiles.push(...listDir(`${project.stateDir}/${svc}`));
    }
    if (logFiles.length > 0) {
      const totalSize = logFiles.reduce((s, f) => s + sizeOf(f), 0);
      targets.push({
        label: `Log files (${logFiles.length} file${logFiles.length !== 1 ? 's' : ''}, ${humanSize(totalSize)}):\n` +
               logFiles.map(f => `  ${f}`).join('\n'),
        paths: logFiles,
      });
    }
  }

  // ── PID files ─────────────────────────────────────────────────────────
  if (cleanPids) {
    const pidFiles: string[] = [];
    for (const svc of ['backend', 'frontend', 'graph', 'inference', 'database', 'mcp']) {
      const p = `${project.runtimeDir}/${svc}.pid`;
      if (fs.existsSync(p)) pidFiles.push(p);
    }
    if (pidFiles.length > 0) {
      targets.push({
        label: `PID files (${pidFiles.length}):\n` + pidFiles.map(f => `  ${f}`).join('\n'),
        paths: pidFiles,
      });
    }
  }

  // ── Generated config ──────────────────────────────────────────────────
  if (cleanConfig) {
    const configFiles: string[] = [];
    for (const svc of ['graph', 'inference', 'mcp']) {
      configFiles.push(...listDir(`${project.configDir}/${svc}`));
    }
    if (configFiles.length > 0) {
      const totalSize = configFiles.reduce((s, f) => s + sizeOf(f), 0);
      targets.push({
        label: `Generated config files (${configFiles.length} file${configFiles.length !== 1 ? 's' : ''}, ${humanSize(totalSize)}):\n` +
               configFiles.map(f => `  ${f}`).join('\n'),
        paths: configFiles,
      });
    }
  }

  // ── Docker volumes ────────────────────────────────────────────────────
  if (cleanVolumes && runtime) {
    targets.push({
      label: `Docker volumes for environment '${env}' (will query ${runtime})`,
      action: async () => {
        const removed: string[] = [];
        // Services that use persistent volumes
        for (const svc of ['database', 'graph', 'inference']) {
          const volName = `semiont-${svc}-${env}-data`;
          try {
            execFileSync(runtime, ['volume', 'inspect', volName], { stdio: 'ignore' });
            // Volume exists — remove it
            if (!options.dryRun) {
              execFileSync(runtime, ['volume', 'rm', volName], { stdio: 'pipe' });
            }
            removed.push(volName);
          } catch { /* volume doesn't exist */ }
        }
        // Network
        const netName = `semiont-${env}`;
        try {
          execFileSync(runtime, ['network', 'inspect', netName], { stdio: 'ignore' });
          if (!options.dryRun) {
            execFileSync(runtime, ['network', 'rm', netName], { stdio: 'pipe' });
          }
          removed.push(`network: ${netName}`);
        } catch { /* network doesn't exist */ }
        return removed;
      },
    });
  } else if (cleanVolumes && !runtime) {
    if (!options.quiet) {
      console.log(`${colors.yellow}⚠️  No container runtime found (docker/podman) — skipping volumes${colors.reset}`);
    }
  }

  if (targets.length === 0) {
    if (!options.quiet) {
      console.log(`${colors.green}✓${colors.reset} Nothing to clean.`);
    }
    results.summary.succeeded = 1;
    results.duration = Date.now() - startTime;
    return results;
  }

  if (!options.quiet) {
    console.log(`\n${colors.bright}Semiont clean — project: ${project.name}${colors.reset}\n`);
  }

  let totalRemoved = 0;
  let totalFailed = 0;

  for (const target of targets) {
    if (!options.quiet) {
      console.log(`${colors.cyan}→${colors.reset} ${target.label}`);
    }

    const proceed = options.force || options.dryRun
      ? true
      : await confirm(`  Remove?`);

    if (!proceed) {
      if (!options.quiet) console.log(`  ${colors.dim}Skipped.${colors.reset}`);
      continue;
    }

    if (options.dryRun) {
      if (!options.quiet) console.log(`  ${colors.dim}[DRY RUN] Would remove.${colors.reset}`);
      totalRemoved++;
      continue;
    }

    try {
      if (target.paths) {
        for (const p of target.paths) {
          try {
            fs.rmSync(p, { recursive: true, force: true });
          } catch (err) {
            if (!options.quiet) {
              console.error(`  ${colors.red}Failed to remove ${p}: ${(err as Error).message}${colors.reset}`);
            }
            totalFailed++;
          }
        }
        // Remove now-empty parent state/config/runtime dirs
        for (const p of target.paths) {
          const parent = p.substring(0, p.lastIndexOf('/'));
          try {
            if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
              fs.rmdirSync(parent);
            }
          } catch { /* best-effort */ }
        }
        totalRemoved++;
        if (!options.quiet) console.log(`  ${colors.green}✓ Removed.${colors.reset}`);
      } else if (target.action) {
        const removed = await target.action();
        if (removed.length === 0) {
          if (!options.quiet) console.log(`  ${colors.dim}Nothing found.${colors.reset}`);
        } else {
          for (const item of removed) {
            if (!options.quiet) console.log(`  ${colors.green}✓${colors.reset} ${item}`);
          }
          totalRemoved++;
        }
      }
    } catch (err) {
      totalFailed++;
      if (!options.quiet) {
        console.error(`  ${colors.red}Error: ${(err as Error).message}${colors.reset}`);
      }
    }

    if (!options.quiet) console.log('');
  }

  results.summary.total = targets.length;
  results.summary.succeeded = totalRemoved;
  results.summary.failed = totalFailed;
  results.duration = Date.now() - startTime;
  return results;
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export { clean as cleanHandler };

export const cleanCommand = new CommandBuilder()
  .name('clean')
  .description('Remove ephemeral files (logs, PID files, generated config, Docker volumes)')
  .schema(CleanOptionsSchema)
  .args(withOpsArgs({
    '--force': {
      type: 'boolean',
      description: 'Skip confirmation prompts',
      default: false,
    },
    '--logs': {
      type: 'boolean',
      description: 'Clean log files only',
      default: false,
    },
    '--pids': {
      type: 'boolean',
      description: 'Clean PID files only',
      default: false,
    },
    '--config': {
      type: 'boolean',
      description: 'Clean generated config files only',
      default: false,
    },
    '--volumes': {
      type: 'boolean',
      description: 'Clean Docker volumes and networks only',
      default: false,
    },
  }, {
    '-f': '--force',
  }))
  .requiresEnvironment(false)
  .requiresServices(false)
  .examples(
    'semiont clean',
    'semiont clean --force',
    'semiont clean --logs',
    'semiont clean --volumes --environment staging',
    'semiont clean --force --dry-run'
  )
  .setupHandler(clean)
  .build();
