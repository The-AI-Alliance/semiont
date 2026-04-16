/**
 * Yield Command
 *
 * Two modes, selected by a required mode flag:
 *
 * UPLOAD mode — register a local file as a semiont resource:
 *   semiont yield --upload docs/overview.md [--name "Title"]
 *   semiont yield --upload docs/a.md --upload docs/b.md
 *
 * DELEGATE mode — generate a new resource from an annotation's gathered context:
 *   semiont yield --delegate --resource <resourceId> --annotation <annotationId> --storage-uri file://generated/loc.md
 *   semiont yield --delegate --resource <resourceId> --annotation <annotationId> --storage-uri file://generated/loc.md \
 *     --title "Paris" --prompt "Write a brief encyclopedia entry" --language en
 *
 * Exactly one of --upload or --delegate must be present.
 */

import * as path from 'path';
import { promises as nodeFs } from 'fs';
import { z } from 'zod';
import { firstValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';
import { resourceId as toResourceId, annotationId as toAnnotationId } from '@semiont/core';
import type { GatheredContext } from '@semiont/core';
import { createGatherVM, createYieldVM } from '@semiont/api-client';
import { CommandResults } from '../command-types.js';
import { CommandBuilder } from '../command-definition.js';
import { ApiOptionsSchema, withApiArgs } from '../base-options-schema.js';
import { printSuccess, printWarning } from '../io/cli-logger.js';

import { findProjectRoot } from '../config-loader.js';
import { loadCachedClient, resolveBusUrl } from '../api-client-factory.js';
import type { SemiontApiClient } from '@semiont/api-client';
import type { AccessToken } from '@semiont/core';

function guessFormat(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.txt': 'text/plain',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.json': 'application/json',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
  };
  return map[ext] ?? 'application/octet-stream';
}

// =====================================================================
// SCHEMA
// =====================================================================

export const YieldOptionsSchema = ApiOptionsSchema.extend({
  // Mode flags
  upload: z.array(z.string()).default([]),
  delegate: z.boolean().default(false),
  // Upload mode options
  name: z.string().optional(),
  // Delegate mode required
  resource: z.string().optional(),
  annotation: z.string().optional(),
  storageUri: z.string().optional(),
  // Delegate mode optional
  title: z.string().optional(),
  prompt: z.string().optional(),
  language: z.string().optional(),
  temperature: z.coerce.number().min(0).max(1).optional(),
  maxTokens: z.coerce.number().int().min(100).max(4000).optional(),
  contextWindow: z.coerce.number().int().min(100).max(5000).default(1000),
}).superRefine((val, ctx) => {
  const hasUpload = val.upload.length > 0;
  const hasDelegate = val.delegate;

  if (!hasUpload && !hasDelegate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'One of --upload <file> or --delegate is required' });
  }
  if (hasUpload && hasDelegate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '--upload and --delegate are mutually exclusive' });
  }
  if (hasUpload && val.name && val.upload.length > 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '--name can only be used when uploading a single file' });
  }
  if (hasDelegate) {
    if (!val.resource) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '--resource <resourceId> is required with --delegate' });
    if (!val.annotation) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '--annotation <annotationId> is required with --delegate' });
    if (!val.storageUri) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '--storage-uri is required with --delegate' });
  }
});

export type YieldOptions = z.output<typeof YieldOptionsSchema>;

// =====================================================================
// DELEGATE MODE HELPERS
// =====================================================================

async function runDelegate(
  semiont: SemiontApiClient,
  _token: AccessToken,
  options: YieldOptions,
): Promise<{ resourceId?: string; resourceName?: string }> {
  const rawResourceId = options.resource!;
  const rawAnnotationId = options.annotation!;
  const rId = toResourceId(rawResourceId);
  const aId = toAnnotationId(rawAnnotationId);
  const eventBus = semiont.eventBus;

  // Step 1: gather context via GatherVM
  const gatherVM = createGatherVM(semiont, eventBus, rId);
  let context: GatheredContext;
  try {
    eventBus.get('gather:requested').next({
      correlationId: crypto.randomUUID(),
      annotationId: aId as string,
      resourceId: rId as string,
      options: { contextWindow: options.contextWindow },
    });
    context = await firstValueFrom(
      gatherVM.context$.pipe(filter((c): c is NonNullable<typeof c> => c !== null)),
    );
  } finally {
    gatherVM.dispose();
  }

  if (!options.quiet) process.stderr.write(`Generating from annotation ${rawAnnotationId}...\n`);

  // Step 2: generate via YieldVM
  const yieldVM = createYieldVM(semiont, eventBus, rId, options.language ?? 'en');
  try {
    yieldVM.generate(aId as string, {
      title: options.title ?? rawAnnotationId,
      storageUri: options.storageUri!,
      context,
      prompt: options.prompt,
      language: options.language,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
    });

    return await new Promise<{ resourceId?: string; resourceName?: string }>((resolve, reject) => {
      const finishedSub = eventBus.get('yield:finished').subscribe((event) => {
        cleanup();
        resolve({ resourceId: (event as any).resourceId, resourceName: (event as any).resourceName });
      });
      const failedSub = eventBus.get('yield:failed').subscribe((event) => {
        cleanup();
        reject(new Error((event as any).error ?? 'Generation failed'));
      });
      function cleanup() { finishedSub.unsubscribe(); failedSub.unsubscribe(); }
    });
  } finally {
    yieldVM.dispose();
  }
}

// =====================================================================
// IMPLEMENTATION
// =====================================================================

export async function runYield(options: YieldOptions): Promise<CommandResults> {
  const startTime = Date.now();
  

  const rawBusUrl = resolveBusUrl(options.bus);
  const { semiont, token } = loadCachedClient(rawBusUrl);
  const projectRoot = findProjectRoot();

  // ── Delegate mode ──────────────────────────────────────────────────
  if (options.delegate) {
    const { resourceId, resourceName } = await runDelegate(semiont, token, options);
    const label = resourceName ?? resourceId ?? options.storageUri!;
    if (!options.quiet) printSuccess(`Yielded: ${options.storageUri} → ${resourceId ?? '(pending)'}`);
    process.stdout.write(JSON.stringify({ resourceId, resourceName, storageUri: options.storageUri }));
    if (!options.quiet) process.stdout.write('\n');
    return {
      command: 'yield',
      environment: rawBusUrl,
      timestamp: new Date(),
      duration: Date.now() - startTime,
      summary: { succeeded: 1, failed: 0, total: 1, warnings: 0 },
      executionContext: { user: process.env.USER || 'unknown', workingDirectory: process.cwd(), dryRun: options.dryRun },
      results: [{ entity: label, platform: 'posix', success: true, metadata: { resourceId, storageUri: options.storageUri }, duration: Date.now() - startTime }],
    };
  }

  // ── Upload mode ────────────────────────────────────────────────────
  let succeeded = 0;
  let failed = 0;
  const results: CommandResults['results'] = [];

  for (const filePath of options.upload) {
    const absPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(projectRoot, filePath);

    const fileStart = Date.now();

    let content: Buffer;
    try {
      content = await nodeFs.readFile(absPath);
    } catch {
      if (!options.quiet) printWarning(`File not found: ${filePath}`);
      results.push({ entity: filePath, platform: 'posix', success: false, metadata: { error: 'File not found' }, duration: 0 });
      failed++;
      continue;
    }

    const relPath = path.relative(projectRoot, absPath).replace(/\\/g, '/');
    const storageUri = `file://${relPath}`;
    const name = options.name ?? path.basename(filePath, path.extname(filePath));
    const format = guessFormat(filePath);

    const { resourceId } = await semiont.yieldResource(
      { name, file: content, format, storageUri },
      { auth: token },
    );

    if (!options.quiet) printSuccess(`Yielded: ${filePath} → ${resourceId}`);
    results.push({ entity: filePath, platform: 'posix', success: true, metadata: { resourceId, storageUri }, duration: Date.now() - fileStart });
    succeeded++;
  }

  return {
    command: 'yield',
    environment: rawBusUrl,
    timestamp: new Date(),
    duration: Date.now() - startTime,
    summary: { succeeded, failed, total: options.upload.length, warnings: 0 },
    executionContext: { user: process.env.USER || 'unknown', workingDirectory: process.cwd(), dryRun: options.dryRun },
    results,
  };
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const yieldCmd = new CommandBuilder()
  .name('yield')
  .description(
    'Upload a local file as a resource (--upload), or generate a new resource from an annotation\'s gathered context (--delegate). ' +
    'Delegate mode outputs JSON { resourceId, resourceName, storageUri } to stdout.'
  )
  .requiresEnvironment(true)
  .requiresServices(true)
  .examples(
    'semiont yield --upload docs/overview.md',
    'semiont yield --upload docs/overview.md --name "Overview Document"',
    'semiont yield --upload docs/a.md --upload docs/b.md --upload docs/c.md',
    'semiont yield --delegate --resource <resourceId> --annotation <annotationId> --storage-uri file://generated/paris.md',
    'semiont yield --delegate --resource <resourceId> --annotation <annotationId> --storage-uri file://generated/paris.md --title "Paris" --language en',
    'semiont yield --delegate --resource <resourceId> --annotation <annotationId> --storage-uri file://generated/paris.md --prompt "Write a brief encyclopedia entry" --temperature 0.3',
    'NEW_ID=$(semiont yield --delegate --resource <resourceId> --annotation <annotationId> --storage-uri file://generated/loc.md --quiet | jq -r \'.resourceId\') && semiont bind <resourceId> <annotationId> "$NEW_ID"',
  )
  .args({
    ...withApiArgs({
      '--upload': {
        type: 'array',
        description: 'Upload mode: one or more local file paths to register as resources (repeatable)',
      },
      '--delegate': {
        type: 'boolean',
        description: 'Delegate mode: generate a new resource from an annotation\'s gathered context',
        default: false,
      },
      '--name': {
        type: 'string',
        description: 'Upload mode: resource name (single file only)',
      },
      '--resource': {
        type: 'string',
        description: 'Delegate mode: source resourceId',
      },
      '--annotation': {
        type: 'string',
        description: 'Delegate mode: source annotationId',
      },
      '--storage-uri': {
        type: 'string',
        description: 'Delegate mode: file://-relative URI where the generated resource will be saved',
      },
      '--title': {
        type: 'string',
        description: 'Delegate mode: custom title for the generated resource',
      },
      '--prompt': {
        type: 'string',
        description: 'Delegate mode: custom prompt to guide content generation',
      },
      '--language': {
        type: 'string',
        description: 'Delegate mode: BCP 47 language tag for generated content (e.g. en, fr, ja)',
      },
      '--temperature': {
        type: 'string',
        description: 'Delegate mode: inference temperature 0.0–1.0 (0 = focused, 1 = creative)',
      },
      '--max-tokens': {
        type: 'string',
        description: 'Delegate mode: maximum tokens to generate (100–4000)',
      },
      '--context-window': {
        type: 'string',
        description: 'Delegate mode: characters of annotation context to gather (100–5000, default: 1000)',
      },
    }, {
      '-n': '--name',
    }),
    aliases: {},
  })
  .schema(YieldOptionsSchema)
  .handler(runYield)
  .build();
