import type { AnchorMethod, Logger } from '@semiont/core';
import { recordAnchorOutcome } from '@semiont/observability';

/**
 * The anchoring methods that picked a plausible occurrence rather than a
 * certain one: `first-of-many` had several candidates and no usable context,
 * `fuzzy-match` recovered through case/whitespace/Levenshtein. Neither is an
 * error — the write-time selector invariant still holds — but both are places
 * the span could be the wrong instance.
 *
 * ONE decider, deliberately. This classification lived in two places (the
 * reference path's inline warn and the motivation parsers' logger) that
 * happened to agree; two copies of a risk judgement is one copy too many.
 */
const DEGRADED: ReadonlySet<string> = new Set<AnchorMethod>(['first-of-many', 'fuzzy-match']);

/**
 * Audit one anchoring outcome: counted always, warned only when degraded.
 *
 * Counting EVERY outcome is the point (P5). A warning tells an operator that
 * one anchor was uncertain; only a rate over all anchors says whether the
 * detection run was precise, and the rate is what the plan asks to put beside
 * the yield numbers.
 */
export function noteAnchor(label: string, exact: string, method: AnchorMethod, logger?: Logger): void {
  recordAnchorOutcome(label, method);
  if (!DEGRADED.has(method)) return;
  const detail = { text: exact, anchorMethod: method };
  if (logger) logger.warn('Annotation anchored via degraded method', { label, ...detail });
  else console.warn(`[${label}] anchored via ${method}: "${exact}"`);
}
