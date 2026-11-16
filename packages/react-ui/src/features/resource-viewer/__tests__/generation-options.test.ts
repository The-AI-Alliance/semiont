/**
 * GENERATION-OUTPUT-FORMAT D8 — the submitted config becomes generation
 * options in ONE place, by spread.
 *
 * Both page handlers used to build the options object field-by-field, so any
 * field not explicitly listed was silently dropped. That is precisely what
 * stranded `outputMediaType` in the SDK one layer down (P1), relocated one
 * layer up. These pins state the PROPERTY — everything the config carries is
 * forwarded — rather than enumerating today's fields, so a knob added later
 * cannot regress the mode back into existence.
 */
import { describe, it, expect } from 'vitest';
import type { GatheredContext } from '@semiont/core';
import { toGenerationOptions } from '../generation-options';
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

describe('toGenerationOptions', () => {
  it('forwards EVERY field the config carries except the context', () => {
    // Stated structurally on purpose: the expectation is derived from the
    // same object, so adding a field to GenerationConfig extends this pin
    // automatically. A field-by-field assertion would have passed happily
    // while the real handler dropped the new one.
    const { context: _positional, ...forwarded } = config;
    expect(toGenerationOptions(config, 'fr')).toMatchObject(forwarded);
  });

  it('does not pass the context as an option — it is the positional argument', () => {
    expect(toGenerationOptions(config, 'fr')).not.toHaveProperty('context');
  });

  it('injects the sourceLanguage, which comes from the viewed resource and not the form', () => {
    expect(toGenerationOptions(config, 'fr').sourceLanguage).toBe('fr');
  });

  it('omits sourceLanguage entirely when the resource has no language', () => {
    // Absence must stay absence: a manufactured '' would tell the prompt the
    // source is in a language named empty string.
    expect(toGenerationOptions(config, undefined)).not.toHaveProperty('sourceLanguage');
  });
});
