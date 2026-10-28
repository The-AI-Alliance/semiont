/**
 * The submitted config becomes the generation job's params in ONE place, by
 * spread.
 *
 * A handler that builds the params object field-by-field silently drops any
 * field it does not list. These pins state the PROPERTY — everything the
 * config carries is forwarded — rather than enumerating the fields, so a knob
 * added later is covered without a change here.
 */
import { describe, it, expect } from 'vitest';
import type { GatheredContext } from '@semiont/core';
import { toGenerationParams } from '../generation-params';
import type { GenerationConfig } from '../../../components/modals/ConfigureGenerationStep';

const context = { focus: { kind: 'resource' } } as unknown as GatheredContext;

const config: GenerationConfig = {
  title: 'Cedar County',
  storageUri: 'file://research/notes.pdf',
  prompt: 'lead with the treaty',
  language: 'en',
  temperature: 0.7,
  maxTokens: 500,
  outputMediaType: 'application/pdf',
  context,
};

describe('toGenerationParams', () => {
  it('forwards EVERY field the config carries, its context among them', () => {
    // Stated structurally on purpose: the expectation is the config itself,
    // so adding a field to GenerationConfig extends this pin automatically. A
    // field-by-field assertion would have passed happily while the real
    // handler dropped the new one.
    expect(toGenerationParams(config, 'fr')).toMatchObject(config);
    expect(toGenerationParams(config, 'fr').context).toBe(context);
  });

  it('injects the sourceLanguage, which comes from the viewed resource and not the form', () => {
    expect(toGenerationParams(config, 'fr').sourceLanguage).toBe('fr');
  });

  it('omits sourceLanguage entirely when the resource has no language', () => {
    // Absence must stay absence: a manufactured '' would tell the prompt the
    // source is in a language named empty string.
    expect(toGenerationParams(config, undefined)).not.toHaveProperty('sourceLanguage');
  });
});
