/**
 * Mark Command
 *
 * Creates a W3C Web Annotation on a resource via the live backend.
 * Calls POST /resources/{id}/annotations through SemiontApiClient.
 *
 * Usage:
 *   semiont mark <resourceId> --motivation highlighting --quote "some text"
 *   semiont mark <resourceId> --motivation commenting --quote "some text" --body-text "my comment"
 *   semiont mark <resourceId> --motivation linking --quote "some text" --link <targetResourceId>
 *   semiont mark <resourceId> --motivation tagging --quote "Einstein" --body-text "Person"
 *
 * With --fetch-content, the resource text is fetched to auto-complete the dual selector:
 *   semiont mark <resourceId> --motivation highlighting --quote "some text" --fetch-content
 *   semiont mark <resourceId> --motivation highlighting --start 10 --end 25 --fetch-content
 */

import { z } from 'zod';
import { resourceId as toResourceId } from '@semiont/core';
import { CommandResults } from '../command-types.js';
import { CommandBuilder } from '../command-definition.js';
import { BaseOptionsSchema, withBaseArgs } from '../base-options-schema.js';
import { printSuccess } from '../io/cli-logger.js';
import { findProjectRoot } from '../config-loader.js';
import { createAuthenticatedClient } from '../api-client-factory.js';
import type { components } from '@semiont/core';
import type { SemiontApiClient } from '@semiont/api-client';
import type { AccessToken } from '@semiont/core';

type CreateAnnotationRequest = components['schemas']['CreateAnnotationRequest'];
type Motivation = components['schemas']['Motivation'];

// =====================================================================
// SCHEMA
// =====================================================================

const MOTIVATIONS = ['highlighting', 'commenting', 'tagging', 'assessing', 'linking'] as const;

/** Characters of surrounding context to include in prefix/suffix */
const CONTEXT_WINDOW = 32;

export const MarkOptionsSchema = BaseOptionsSchema.extend({
  resourceIdArr: z.array(z.string()).min(1, 'resourceId is required').max(1, 'Only one resourceId allowed'),
  motivation: z.enum(MOTIVATIONS),
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
// IMPLEMENTATION
// =====================================================================

export async function runMark(options: MarkOptions): Promise<CommandResults> {
  const startTime = Date.now();
  const projectRoot = findProjectRoot();
  const environment = options.environment!;

  const { client, token } = await createAuthenticatedClient(projectRoot, environment);

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

  const { annotationId } = await client.createAnnotation(resourceId, request, { auth: token });

  if (!options.quiet) printSuccess(`Marked: ${rawResourceId} → ${annotationId}`);

  return {
    command: 'mark',
    environment,
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
  .description('Create a W3C annotation on a resource')
  .requiresEnvironment(true)
  .requiresServices(true)
  .examples(
    'semiont mark <resourceId> --motivation highlighting --quote "some text"',
    'semiont mark <resourceId> --motivation highlighting --quote "some text" --fetch-content',
    'semiont mark <resourceId> --motivation commenting --quote "some text" --body-text "my comment"',
    'semiont mark <resourceId> --motivation linking --quote "some text" --link <targetResourceId>',
    'semiont mark <resourceId> --motivation tagging --quote "Einstein" --body-text "Person"',
  )
  .args({
    ...withBaseArgs({
      '--motivation': {
        type: 'string',
        description: `Annotation motivation: ${MOTIVATIONS.join(', ')}`,
      },
      '--quote': {
        type: 'string',
        description: 'TextQuoteSelector: exact text to select',
      },
      '--prefix': {
        type: 'string',
        description: 'TextQuoteSelector: context before the quote (auto-derived with --fetch-content)',
      },
      '--suffix': {
        type: 'string',
        description: 'TextQuoteSelector: context after the quote (auto-derived with --fetch-content)',
      },
      '--start': {
        type: 'string',
        description: 'TextPositionSelector: start character offset',
      },
      '--end': {
        type: 'string',
        description: 'TextPositionSelector: end character offset',
      },
      '--fetch-content': {
        type: 'boolean',
        description: 'Fetch resource text to auto-complete dual selector (derives missing quote or position, auto-derives prefix/suffix)',
        default: false,
      },
      '--svg': {
        type: 'string',
        description: 'SvgSelector: SVG markup defining a region (for images)',
      },
      '--fragment': {
        type: 'string',
        description: 'FragmentSelector: media fragment value (e.g. "page=1&viewrect=100,200,50,30")',
      },
      '--fragment-conforms-to': {
        type: 'string',
        description: 'FragmentSelector: conformance URI',
      },
      '--body-text': {
        type: 'string',
        description: 'TextualBody: text content of the annotation body',
      },
      '--body-format': {
        type: 'string',
        description: 'TextualBody: MIME type (default: text/plain)',
      },
      '--body-language': {
        type: 'string',
        description: 'TextualBody: BCP 47 language tag',
      },
      '--body-purpose': {
        type: 'string',
        description: 'TextualBody: purpose (defaults to motivation)',
      },
      '--link': {
        type: 'array',
        description: 'SpecificResource body: target resourceId to link to (repeatable)',
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
