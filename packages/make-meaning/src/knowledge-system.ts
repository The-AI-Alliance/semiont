/**
 * Knowledge System
 *
 * Binds the KnowledgeBase to the actors that provide disciplined access to it.
 * Nothing outside the KnowledgeSystem reads or writes the KnowledgeBase directly.
 *
 * - kb:                the durable store (event log, views, content, graph)
 * - stower:            write actor — the single write gateway
 * - browser:           read actor — all KB queries plus directory listings
 * - gatherer:          context-assembly actor — builds GatheredContext from passage, graph, and vectors
 * - matcher:           search actor — context-driven candidate search and scoring
 * - cloneTokenManager: token actor — manages resource clone tokens
 *
 * These are the five access actors. Two projection-pipeline actors complete
 * the seven, and BOTH run standalone (D4: the projections are part of their
 * stores' stacks, not of the embedding process): the Weaver (weaver-main →
 * graph) and the Smelter (smelter-main → vectors). The backend keeps only
 * the Weaver's `weave:applied` fold (kb.weaveProgress).
 *
 * EventBus, JobQueue, and workers are peers to KnowledgeSystem, not members.
 */

import type { KnowledgeBase }     from './knowledge-base.js';
import type { Stower }            from './stower.js';
import type { Gatherer }          from './gatherer.js';
import type { Matcher }           from './matcher.js';
import type { Browser }           from './browser.js';
import type { CloneTokenManager } from './clone-token-manager.js';

export interface KnowledgeSystem {
  kb:                KnowledgeBase;
  stower:            Stower;
  gatherer:          Gatherer;
  matcher:           Matcher;
  browser:           Browser;
  cloneTokenManager: CloneTokenManager;
  stop:              () => Promise<void>;
}

export async function stopKnowledgeSystem(ks: KnowledgeSystem): Promise<void> {
  await ks.gatherer.stop();
  await ks.matcher.stop();
  await ks.browser.stop();
  await ks.cloneTokenManager.stop();
  await ks.stower.stop();
  ks.kb.weaveProgress.dispose();
  await ks.kb.graph.disconnect();
}
