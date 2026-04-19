/**
 * Payload Type Aliases
 *
 * Convenience aliases for OpenAPI-generated schema types that are
 * referenced across the codebase. Shorter than
 * `components['schemas']['<Name>']` and carry intent: code that imports
 * `YieldProgress` is talking about progress events, whether or not it
 * also participates in the bus protocol.
 *
 * These aliases are not about the bus. They live here so that
 * bus-protocol.ts can focus on channel-protocol concerns (EventMap,
 * CHANNEL_SCHEMAS, scope classification).
 */

import type { components } from './types';

export type Selector =
  | components['schemas']['TextPositionSelector']
  | components['schemas']['TextQuoteSelector']
  | components['schemas']['SvgSelector']
  | components['schemas']['FragmentSelector'];

export type GatheredContext = components['schemas']['GatheredContext'];
export type YieldProgress = components['schemas']['YieldProgress'];
export type MarkProgress = components['schemas']['MarkProgress'];
export type SelectionData = components['schemas']['SelectionData'];
