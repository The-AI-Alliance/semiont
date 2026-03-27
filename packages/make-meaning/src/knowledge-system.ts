/**
 * Knowledge System
 *
 * Binds the KnowledgeBase to the actors that provide disciplined access to it.
 * Nothing outside the KnowledgeSystem reads or writes the KnowledgeBase directly.
 *
 * - kb:                the durable store (event log, views, content, graph)
 * - stower:            write actor — weaves new knowledge in
 * - gatherer:          read actor — traces threads to build context
 * - matcher:           search actor — finds related threads
 * - cloneTokenManager: token actor — manages resource clone tokens
 *
 * EventBus, JobQueue, and workers are peers to KnowledgeSystem, not members.
 */

import type { KnowledgeBase }     from './knowledge-base.js';
import type { Stower }            from './stower.js';
import type { Gatherer }          from './gatherer.js';
import type { Matcher }           from './matcher.js';
import type { CloneTokenManager } from './clone-token-manager.js';

export interface KnowledgeSystem {
  kb:                KnowledgeBase;
  stower:            Stower;
  gatherer:          Gatherer;
  matcher:           Matcher;
  cloneTokenManager: CloneTokenManager;
  stop:              () => Promise<void>;
}

export async function stopKnowledgeSystem(ks: KnowledgeSystem): Promise<void> {
  await ks.gatherer.stop();
  await ks.matcher.stop();
  await ks.cloneTokenManager.stop();
  await ks.stower.stop();
  await ks.kb.graphConsumer.stop();
  await ks.kb.graph.disconnect();
}
