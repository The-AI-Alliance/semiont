/**
 * Mark Command
 *
 * Two modes, selected by a required mode flag:
 *
 * MANUAL mode — create a single explicitly-specified annotation:
 *   semiont mark <resourceId> --motivation highlighting --quote "some text"
 *   semiont mark <resourceId> --motivation commenting --quote "some text" --body-text "my comment"
 *   semiont mark <resourceId> --motivation linking --quote "some text" --link <targetResourceId>
 *   semiont mark <resourceId> --motivation tagging --quote "Einstein" --body-text "Person"
 *
 * With --fetch-content, the resource text is fetched to auto-complete the dual selector:
 *   semiont mark <resourceId> --motivation highlighting --quote "some text" --fetch-content
 *   semiont mark <resourceId> --motivation highlighting --start 10 --end 25 --fetch-content
 *
 * DELEGATE mode — ask the backend to auto-annotate a resource using AI:
 *   semiont mark <resourceId> --delegate --motivation highlighting
 *   semiont mark <resourceId> --delegate --motivation assessing --tone analytical --density 4
 *   semiont mark <resourceId> --delegate --motivation linking --entity-type Location --entity-type Person
 *   semiont mark <resourceId> --delegate --motivation tagging --schema-id <id> --category Biology
 */

import { z } from 'zod';
import { resourceId as toResourceId, type Motivation } from '@semiont/core';
import { CommandResults } from '../command-types.js';
import { CommandBuilder } from '../command-definition.js';
import { ApiOptionsSchema, withApiArgs } from '../base-options-schema.js';
import { printSuccess } from '../io/cli-logger.js';

import { loadCachedClient, resolveBusUrl } from '../api-client-factory.js';
import type { components } from '@semiont/core';
import type { SemiontApiClient } from '@semiont/api-client';
import type { AccessToken } from '@semiont/core';

type CreateAnnotationRequest = components['schemas']['CreateAnnotationRequest'];

// =====================================================================
// SCHEMA
// =====================================================================

const MOTIVATIONS = ['highlighting', 'commenting', 'tagging', 'assessing', 'linking'] as const;

/** Characters of surrounding context to include in prefix/suffix */
const CONTEXT_WINDOW = 32;

export const MarkOptionsSchema = ApiOptionsSchema.extend({
  resourceIdArr: z.array(z.string()).min(1, 'resourceId is required').max(1, 'Only one resourceId allowed'),
  motivation: z.enum(MOTIVATIONS),

  // ── Mode switch ──────────────────────────────────────────────────────
  delegate: z.boolean().default(false),

  // ── Manual mode ──────────────────────────────────────────────────────
  // TextQuoteSelector
  quote: z.string().optional(),
  prefix: z.string().optional(),
  suffix: z.string().optional(),
  // TextPositionSelector
  start: z.coerce.number().int().nonnegative().optional(),
  end: z.coerce.number().int().nonnegative().optional(),
  // SvgSelector
  svg: z.string().optional(),
  // FragmentSelector
  fragment: z.string().optional(),
  fragmentConformsTo: z.string().optional(),
  // Content fetching
  fetchContent: z.boolean().default(false),
  // Body
  bodyText: z.string().optional(),
  bodyFormat: z.string().optional(),
  bodyLanguage: z.string().optional(),
  bodyPurpose: z.string().optional(),
  link: z.array(z.string()).optional(),

  // ── Delegate mode: shared ──────────────────────────────────────────────
  instructions: z.string().optional(),
  density: z.coerce.number().int().optional(),
  tone: z.string().optional(),

  // ── Delegate mode: linking ─────────────────────────────────────────────
  entityType: z.array(z.string()).default([]),
  includeDescriptive: z.boolean().default(false),

  // ── Delegate mode: tagging ─────────────────────────────────────────────
  schemaId: z.string().optional(),
  category: z.array(z.string()).default([]),

}).superRefine((val, ctx) => {
  if (val.delegate) {
    const manualFlags = ['quote', 'start', 'end', 'svg', 'fragment', 'fetchContent', 'bodyText', 'link'] as const;
    for (const f of manualFlags) {
      const v = val[f];
      if (v !== undefined && v !== false && !(Array.isArray(v) && v.length === 0)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `--${f.replace(/([A-Z])/g, '-$1').toLowerCase()} cannot be used with --delegate` });
      }
    }
    if (val.motivation === 'linking' && val.entityType.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '--entity-type is required for --delegate --motivation linking' });
    }
    if (val.motivation === 'tagging') {
      if (!val.schemaId) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '--schema-id is required for --delegate --motivation tagging' });
      if (val.category.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '--category is required for --delegate --motivation tagging' });
    }
  }
});

export type MarkOptions = z.output<typeof MarkOptionsSchema>;

// =====================================================================
// HELPERS
// =====================================================================

async function fetchResourceText(
  client: SemiontApiClient,
  resourceId: ReturnType<typeof toResourceId>,
  token: AccessToken,
): Promise<string> {
  const { data } = await client.getResourceRepresentation(resourceId, { accept: 'text/plain', auth: token });
  return new TextDecoder().decode(data);
}

function buildTextSelector(options: MarkOptions, content?: string): any[] {
  let exact = options.quote;
  let start = options.start;
  let end = options.end;

  if (content !== undefined) {
    if (exact !== undefined && (start === undefined || end === undefined)) {
      // Derive position from quote
      const idx = content.indexOf(exact);
      if (idx === -1) throw new Error(`--quote text not found in resource content: "${exact}"`);
      start = idx;
      end = idx + exact.length;
    } else if (start !== undefined && end !== undefined && exact === undefined) {
      // Derive quote from position
      exact = content.slice(start, end);
      if (!exact) throw new Error(`--start/--end range [${start}, ${end}) is empty or out of bounds`);
    }
  }

  const selectors: any[] = [];

  if (start !== undefined && end !== undefined) {
    selectors.push({ type: 'TextPositionSelector', start, end });
  }

  if (exact !== undefined) {
    const q: any = { type: 'TextQuoteSelector', exact };
    // Use explicit prefix/suffix if provided, otherwise derive from content if available
    if (options.prefix !== undefined) {
      q.prefix = options.prefix;
    } else if (content !== undefined && start !== undefined) {
      q.prefix = content.slice(Math.max(0, start - CONTEXT_WINDOW), start);
    }
    if (options.suffix !== undefined) {
      q.suffix = options.suffix;
    } else if (content !== undefined && end !== undefined) {
      q.suffix = content.slice(end, end + CONTEXT_WINDOW);
    }
    selectors.push(q);
  }

  return selectors;
}

async function buildSelector(
  options: MarkOptions,
  client: SemiontApiClient,
  resourceId: ReturnType<typeof toResourceId>,
  token: AccessToken,
): Promise<CreateAnnotationRequest['target']['selector']> {
  const hasText = options.quote !== undefined || (options.start !== undefined && options.end !== undefined);
  const hasSvg = options.svg !== undefined;
  const hasFragment = options.fragment !== undefined;

  const selectorTypes = [hasText, hasSvg, hasFragment].filter(Boolean).length;
  if (selectorTypes > 1) {
    throw new Error('Selector flags are mutually exclusive: use text (--quote/--start/--end), --svg, or --fragment, not a combination.');
  }

  if (hasSvg) {
    return { type: 'SvgSelector', value: options.svg! };
  }

  if (hasFragment) {
    const f: any = { type: 'FragmentSelector', value: options.fragment };
    if (options.fragmentConformsTo) f.conformsTo = options.fragmentConformsTo;
    return f;
  }

  if (!hasText) return undefined as any;

  const content = options.fetchContent
    ? await fetchResourceText(client, resourceId, token)
    : undefined;

  const selectors = buildTextSelector(options, content);
  if (selectors.length === 0) return undefined as any;
  if (selectors.length === 1) return selectors[0];
  return selectors;
}

function buildBody(options: MarkOptions): CreateAnnotationRequest['body'] {
  const items: any[] = [];

  if (options.bodyText !== undefined) {
    const b: any = { type: 'TextualBody', value: options.bodyText };
    if (options.bodyFormat) b.format = options.bodyFormat;
    if (options.bodyLanguage) b.language = options.bodyLanguage;
    b.purpose = options.bodyPurpose ?? options.motivation;
    items.push(b);
  }

  for (const source of options.link ?? []) {
    items.push({ type: 'SpecificResource', source, purpose: 'linking' });
  }

  if (items.length === 0) return [];
  if (items.length === 1) return items[0];
  return items;
}

// =====================================================================
// DELEGATE MODE
// =====================================================================

async function runDelegate(
  client: SemiontApiClient,
  options: MarkOptions,
): Promise<{ motivation: string; resourceId: string; createdCount: number }> {
  const rawResourceId = options.resourceIdArr[0];
  const resourceId = toResourceId(rawResourceId);
  const { motivation, instructions, density, tone, entityType, includeDescriptive, schemaId, category } = options;

  if (!options.quiet) process.stderr.write(`Annotating ${motivation} on ${rawResourceId}...\n`);

  const result = await new Promise<{ createdCount: number }>((resolve, reject) => {
    client.mark.assist(resourceId, motivation as Motivation, {
      instructions,
      density,
      tone: tone as string | undefined,
      entityTypes: entityType as string[] | undefined,
      includeDescriptiveReferences: includeDescriptive,
      schemaId: schemaId as string | undefined,
      categories: category as string[] | undefined,
    }).subscribe({
      next: (progress) => {
        if ('foundCount' in progress) {
          resolve({ createdCount: progress.createdCount ?? 0 });
        }
      },
      error: (err) => reject(err),
      complete: () => resolve({ createdCount: 0 }),
    });
  });

  if (!options.quiet) process.stderr.write(`✓ ${result.createdCount} annotations created\n`);
  return { motivation, resourceId: rawResourceId, createdCount: result.createdCount };
}

// =====================================================================
// IMPLEMENTATION
// =====================================================================

export async function runMark(options: MarkOptions): Promise<CommandResults> {
  const startTime = Date.now();
  

  const rawBusUrl = resolveBusUrl(options.bus);
  const { client, token } = loadCachedClient(rawBusUrl);

  // ── Delegate mode ────────────────────────────────────────────────────
  if (options.delegate) {
    const result = await runDelegate(client, options);
    process.stdout.write(JSON.stringify(result));
    if (!options.quiet) process.stdout.write('\n');
    return {
      command: 'mark',
      environment: rawBusUrl,
      timestamp: new Date(),
      duration: Date.now() - startTime,
      summary: { succeeded: result.createdCount, failed: 0, total: result.createdCount, warnings: 0 },
      executionContext: { user: process.env.USER || 'unknown', workingDirectory: process.cwd(), dryRun: options.dryRun },
      results: [{ entity: result.resourceId, platform: 'posix', success: true, metadata: { createdCount: result.createdCount, motivation: result.motivation }, duration: Date.now() - startTime }],
    };
  }

  const rawResourceId = options.resourceIdArr[0];
  const resourceId = toResourceId(rawResourceId);
  const selector = await buildSelector(options, client, resourceId, token);
  const body = buildBody(options);

  const target = (selector !== undefined
    ? { source: rawResourceId, selector }
    : { source: rawResourceId, selector: undefined }) as CreateAnnotationRequest['target'];

  const request: CreateAnnotationRequest = {
    motivation: options.motivation as Motivation,
    target,
    body,
  };

  const { annotationId } = await client.markAnnotation(resourceId, request, { auth: token });

  if (!options.quiet) printSuccess(`Marked: ${rawResourceId} → ${annotationId}`);

  return {
    command: 'mark',
    environment: rawBusUrl,
    timestamp: new Date(),
    duration: Date.now() - startTime,
    summary: { succeeded: 1, failed: 0, total: 1, warnings: 0 },
    executionContext: { user: process.env.USER || 'unknown', workingDirectory: process.cwd(), dryRun: options.dryRun },
    results: [{ entity: rawResourceId, platform: 'posix', success: true, metadata: { annotationId }, duration: Date.now() - startTime }],
  };
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const markCmd = new CommandBuilder()
  .name('mark')
  .description(
    'Create a W3C annotation on a resource. ' +
    'Manual mode (default): create a single explicitly-specified annotation. ' +
    'Delegate mode (--delegate): AI-assisted bulk annotation via SSE stream. ' +
    'Outputs JSON { motivation, resourceId, createdCount } in delegate mode.'
  )
  .requiresEnvironment(true)
  .requiresServices(true)
  .examples(
    // Manual mode
    'semiont mark <resourceId> --motivation highlighting --quote "some text"',
    'semiont mark <resourceId> --motivation highlighting --quote "some text" --fetch-content',
    'semiont mark <resourceId> --motivation commenting --quote "some text" --body-text "my comment"',
    'semiont mark <resourceId> --motivation linking --quote "some text" --link <targetResourceId>',
    'semiont mark <resourceId> --motivation tagging --quote "Einstein" --body-text "Person"',
    // Detect mode
    'semiont mark <resourceId> --delegate --motivation highlighting',
    'semiont mark <resourceId> --delegate --motivation highlighting --instructions "Focus on key claims" --density 8',
    'semiont mark <resourceId> --delegate --motivation assessing --tone analytical --density 4',
    'semiont mark <resourceId> --delegate --motivation commenting --tone scholarly',
    'semiont mark <resourceId> --delegate --motivation linking --entity-type Location --entity-type Person',
    'semiont mark <resourceId> --delegate --motivation linking --entity-type Location --include-descriptive',
    'semiont mark <resourceId> --delegate --motivation tagging --schema-id <schemaId> --category Biology --category Chemistry',
  )
  .args({
    ...withApiArgs({
      '--motivation': {
        type: 'string',
        description: `Annotation motivation: ${MOTIVATIONS.join(', ')}`,
      },
      // ── Mode switch ───────────────────────────────────────────────────
      '--delegate': {
        type: 'boolean',
        description: 'Delegate annotation work to AI (request mode); incompatible with manual selector flags',
        default: false,
      },
      // ── Manual mode options ───────────────────────────────────────────
      '--quote': {
        type: 'string',
        description: 'Manual: TextQuoteSelector exact text to select',
      },
      '--prefix': {
        type: 'string',
        description: 'Manual: TextQuoteSelector context before the quote (auto-derived with --fetch-content)',
      },
      '--suffix': {
        type: 'string',
        description: 'Manual: TextQuoteSelector context after the quote (auto-derived with --fetch-content)',
      },
      '--start': {
        type: 'string',
        description: 'Manual: TextPositionSelector start character offset',
      },
      '--end': {
        type: 'string',
        description: 'Manual: TextPositionSelector end character offset',
      },
      '--fetch-content': {
        type: 'boolean',
        description: 'Manual: fetch resource text to auto-complete dual selector',
        default: false,
      },
      '--svg': {
        type: 'string',
        description: 'Manual: SvgSelector SVG markup defining a region (for images)',
      },
      '--fragment': {
        type: 'string',
        description: 'Manual: FragmentSelector media fragment value',
      },
      '--fragment-conforms-to': {
        type: 'string',
        description: 'Manual: FragmentSelector conformance URI',
      },
      '--body-text': {
        type: 'string',
        description: 'Manual: TextualBody text content',
      },
      '--body-format': {
        type: 'string',
        description: 'Manual: TextualBody MIME type (default: text/plain)',
      },
      '--body-language': {
        type: 'string',
        description: 'Manual: TextualBody BCP 47 language tag',
      },
      '--body-purpose': {
        type: 'string',
        description: 'Manual: TextualBody purpose (defaults to motivation)',
      },
      '--link': {
        type: 'array',
        description: 'Manual: SpecificResource body target resourceId to link to (repeatable)',
      },
      // ── Delegate mode: shared ───────────────────────────────────────────
      '--instructions': {
        type: 'string',
        description: 'Delegate: free-text instructions for the AI (highlighting, assessing, commenting)',
      },
      '--density': {
        type: 'string',
        description: 'Delegate: annotations per 2000 words (highlighting: 1–15; assessing: 1–10; commenting: 2–12)',
      },
      '--tone': {
        type: 'string',
        description: 'Delegate: tone for assessing (analytical|critical|balanced|constructive) or commenting (scholarly|explanatory|conversational|technical)',
      },
      // ── Delegate mode: linking ──────────────────────────────────────────
      '--entity-type': {
        type: 'array',
        description: 'Delegate linking: entity type to detect (repeatable; at least one required)',
      },
      '--include-descriptive': {
        type: 'boolean',
        description: 'Delegate linking: also detect descriptive/prose references',
        default: false,
      },
      // ── Delegate mode: tagging ──────────────────────────────────────────
      '--schema-id': {
        type: 'string',
        description: 'Delegate tagging: tag schema ID (required)',
      },
      '--category': {
        type: 'array',
        description: 'Delegate tagging: category within the schema (repeatable; at least one required)',
      },
    }, {
      '-m': '--motivation',
    }),
    restAs: 'resourceIdArr',
    aliases: {},
  })
  .schema(MarkOptionsSchema)
  .handler(runMark)
  .build();
