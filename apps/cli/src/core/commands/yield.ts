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
import { lastValueFrom } from 'rxjs';
import { resourceId as toResourceId, annotationId as toAnnotationId, mediaTypeForExtension, isSupportedMediaType } from '@semiont/core';
import type { GatheredContext, SupportedMediaType } from '@semiont/core';
import { CommandResults } from '../command-types.js';
import { CommandBuilder } from '../command-definition.js';
import { ApiOptionsSchema, withApiArgs } from '../base-options-schema.js';
import { printSuccess, printWarning } from '../io/cli-logger.js';

import { findProjectRoot } from '../config-loader.js';
import { loadCachedClient, resolveBusUrl } from '../client-factory.js';
import type { SemiontClient } from '@semiont/sdk';

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
  /** BCP-47 tag — language the *generated resource* is written in. */
  language: z.string().optional(),
  /**
   * BCP-47 tag — language of the *source resource* the annotation lives on.
   * Goes into the prompt so the LLM understands embedded source-context
   * snippets correctly when source ≠ target language.
   */
  sourceLanguage: z.string().optional(),
  temperature: z.coerce.number().min(0).max(1).optional(),
  maxTokens: z.coerce.number().int().min(100).max(4000).optional(),
  contextWindow: z.coerce.number().int().min(100).max(5000).default(1000),
  /**
   * Media type of the generated resource (delegate mode). Validated for
   * registry membership at the call site; the create route owns the
   * authorable / role-appropriateness rejection (MEDIA-TYPES).
   */
  outputMediaType: z.string().optional(),
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
    // --annotation is optional: present → annotation-anchored, absent → resource-anchored.
    if (!val.resource) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '--resource <resourceId> is required with --delegate' });
    if (!val.storageUri) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '--storage-uri is required with --delegate' });
  }
});

export type YieldOptions = z.output<typeof YieldOptionsSchema>;

// =====================================================================
// DELEGATE MODE HELPERS
// =====================================================================

/**
 * Validate --output-media-type for registry membership (a typo is a CLI
 * input error). The create route owns the authorable / role-appropriateness
 * rejection — no parallel gate here (MEDIA-TYPES). Uses the core type guard,
 * not a cast.
 */
function resolveOutputMediaType(raw: string | undefined): SupportedMediaType | undefined {
  if (raw === undefined) return undefined;
  if (!isSupportedMediaType(raw)) {
    throw new Error(`Unknown output media type: ${raw}`);
  }
  return raw;
}

function extractResult(final: { kind: string; data?: unknown }): { resourceId?: string; resourceName?: string } {
  if (final.kind !== 'complete') return {};
  const r = (final.data as { result?: { resourceId?: string; resourceName?: string } } | undefined)?.result ?? {};
  return { resourceId: r.resourceId, resourceName: r.resourceName };
}

async function runDelegate(
  semiont: SemiontClient,
  options: YieldOptions,
): Promise<{ resourceId?: string; resourceName?: string }> {
  const rawResourceId = options.resource!;
  const rId = toResourceId(rawResourceId);
  const outputMediaType = resolveOutputMediaType(options.outputMediaType);

  // Resource-anchored mode: no --annotation. Derive a new resource from the
  // whole source resource, grounded by a resource-focus GatheredContext.
  if (!options.annotation) {
    // gather.resource is a Promise (resource-focus), not an Observable.
    // includeContent/includeSummary keep generation grounded (avoid the
    // thin-context failure mode); the worker renders those sections.
    const context = await semiont.gather.resource(rId, { includeContent: true, includeSummary: true });

    if (!options.quiet) process.stderr.write(`Deriving from resource ${rawResourceId}...\n`);

    const final = await lastValueFrom(
      semiont.yield.fromResource(rId, {
        title: options.title ?? rawResourceId,
        storageUri: options.storageUri!,
        context,
        prompt: options.prompt,
        language: options.language,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        outputMediaType,
      }),
    );
    return extractResult(final);
  }

  // Annotation-anchored mode.
  const rawAnnotationId = options.annotation;
  const aId = toAnnotationId(rawAnnotationId);

  // Step 1: gather context
  const context = await lastValueFrom(
    semiont.gather.annotation(rId, aId, { contextWindow: options.contextWindow }),
  ) as GatheredContext;

  if (!options.quiet) process.stderr.write(`Generating from annotation ${rawAnnotationId}...\n`);

  // Step 2: generate — yield.fromAnnotation Observable yields progress
  // events, then a final `complete` event carrying the JobCompleteCommand
  // (with `result.resourceId` / `result.resourceName`).
  // The gathered context's metadata.language is populated by the backend's
  // gather flow from the source resource's primary representation. Use it as
  // a default for --source-language so callers don't have to specify it
  // unless they want to override.
  const ctxSourceLanguage = (context as { metadata?: { language?: string } } | undefined)?.metadata?.language;

  const final = await lastValueFrom(
    semiont.yield.fromAnnotation(rId, aId, {
      title: options.title ?? rawAnnotationId,
      storageUri: options.storageUri!,
      context,
      prompt: options.prompt,
      language: options.language,
      sourceLanguage: options.sourceLanguage ?? ctxSourceLanguage,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      outputMediaType,
    }),
  );
  return extractResult(final);
}

// =====================================================================
// IMPLEMENTATION
// =====================================================================

export async function runYield(options: YieldOptions): Promise<CommandResults> {
  const startTime = Date.now();
  

  const rawBusUrl = resolveBusUrl(options.bus);
  const { semiont } = loadCachedClient(rawBusUrl);
  const projectRoot = findProjectRoot();

  // ── Delegate mode ──────────────────────────────────────────────────
  if (options.delegate) {
    const { resourceId, resourceName } = await runDelegate(semiont, options);
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
    // Registry-driven detection; unknown extensions are still uploadable
    // under the big tent (validated by the create route server-side)
    const format = mediaTypeForExtension(path.extname(filePath)) ?? 'application/octet-stream';

    const { resourceId } = await semiont.yield.resource(
      { name, file: content, format, storageUri },
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
    'Upload a local file as a resource (--upload), or generate a new resource via --delegate: ' +
    'from an annotation\'s gathered context (with --annotation), or derived from a whole source resource (without --annotation). ' +
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
    'semiont yield --delegate --resource <resourceId> --storage-uri file://generated/summary.md --prompt "Summarize this document"',
    'semiont yield --delegate --resource <resourceId> --storage-uri file://generated/translated.html --prompt "Translate to French" --language fr --output-media-type text/html',
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
      '--output-media-type': {
        type: 'string',
        description: 'Delegate mode: media type of the generated resource (e.g. text/markdown, text/html; default: text/markdown)',
      },
    }, {
      '-n': '--name',
    }),
    aliases: {},
  })
  .schema(YieldOptionsSchema)
  .handler(runYield)
  .build();
