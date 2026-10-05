import { STALL_THRESHOLD_MS } from '@semiont/jobs';
import type { MakeMeaningConfig } from './config';
import { GRAPH_BARRIER_BUDGET_MS } from './graph-context';

/** What the Librarian refuses to boot on: no graph, or a gather that outlives the worker's watchdog. */
export function assertMakeMeaningConfig(config: MakeMeaningConfig): void {
  if (!config.services?.graph) {
    throw new Error('services.graph is required for make-meaning service');
  }

  // Watchdog nesting: the gather's worst-case read-barrier spend — the
  // settle bound plus the graph barrier budget — must degrade gracefully
  // BEFORE the job-worker stall watchdog fails fast; a barrier that outlives
  // the watchdog gets the worker killed instead of a thin context. Tighter
  // EXTERNAL watchdogs (e.g. my-chat's 90s generation stall) are not
  // importable and remain documented on the config field.
  if (!Number.isFinite(config.gather.settleTimeoutMs) || config.gather.settleTimeoutMs <= 0) {
    throw new Error(`gather.settleTimeoutMs must be a positive number of milliseconds, got ${config.gather.settleTimeoutMs}`);
  }
  if (config.gather.settleTimeoutMs + GRAPH_BARRIER_BUDGET_MS >= STALL_THRESHOLD_MS) {
    throw new Error(
      `gather.settleTimeoutMs (${config.gather.settleTimeoutMs}ms) plus the graph barrier budget (${GRAPH_BARRIER_BUDGET_MS}ms) ` +
      `must nest inside the job-worker stall watchdog (${STALL_THRESHOLD_MS}ms) — lower settleTimeoutMs`,
    );
  }
}
