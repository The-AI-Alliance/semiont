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
 * the seven: the Graph Consumer (kb.graphConsumer, started by
 * createKnowledgeBase) and the Smelter (standalone process via smelter-main).
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
  await ks.kb.graphConsumer.stop();
  await ks.kb.graph.disconnect();
}
