// ⚠ GENERATED FILE — do not edit.
//
// Authority:   specs/src/bus/registry.json  (channels, payloads, operations)
// Regenerate:  node scripts/bus/generate-ts.mjs
// Go counterpart: node scripts/bus/generate-go.mjs → packages/sdk-go/bus
//
// Payload schemas themselves live in the OpenAPI components; the registry
// names which one each channel carries, and every payload type here is
// derived from that. Add or change a channel THERE.

import type { EventName } from './bus-protocol';

/** Where a channel sits relative to the hub: emitted toward it, delivered
 *  from it (the fan-in set — BRIDGED_CHANNELS, by construction), or never on
 *  the wire at all. */
export type ChannelDirection = 'outbound' | 'inbound' | 'in-process';

/**
 * A channel's delivery class: what a subscriber is promised about a frame on
 * it when its stream drops, or is handed to another. The promise comes from
 * the frame's identity (docs/protocol/TRANSPORT-CONTRACT.md § Delivery).
 *
 *   positioned — a recorded event delivered on its resource's scope. Its id
 *                is its place in that resource's record: a subscriber that
 *                names the last one it holds is sent what it missed.
 *   correlated — the reply to a claimed request, routed to the client that
 *                asked. Its id is the request's: it is recognised when it
 *                arrives twice, and sent again while it is retained.
 *   passing    — every other frame. Nothing replays it.
 *
 * Derived from the registry's axes, never declared: an operation's replies
 * are correlated; a recorded event whose audience is `scoped` is positioned;
 * everything else that crosses the wire is passing. Who RECEIVES a frame is
 * the audience axis, and a different question.
 */
export type ChannelDelivery = 'positioned' | 'correlated' | 'passing';

export interface ChannelAttrs {
  /** In PERSISTED_EVENT_TYPES — lands in the event log, the system of record. */
  readonly recorded: boolean;
  readonly direction: ChannelDirection;
  /**
   * Does emitting this channel CHANGE the knowledge base, or only ask it
   * something?
   *
   * A WRITE is an act: it appends to the event log, or it enqueues or
   * transitions durable work the log will later cite. A READ answers from
   * state that already exists and leaves nothing behind — every `browse:*`
   * request, and the three lookups that merely resolve a token or a summary.
   *
   * The domain is exactly the EMITTABLE set: an operation's request, or a
   * `kind: command`. Inbound replies, broadcast events and in-process UI
   * signals are absent because nobody emits them at the gateway, so the
   * question does not arise. Every emittable channel names one side or the
   * other and the generator refuses — there is no default.
   *
   * The gateway reads this to decide when the record learns a person's name:
   * a `_userId` stamp is NOT the test, because a read carries one too.
   * Someone who signs in and only browses is never named, and the profile
   * publish rate is the WRITE rate rather than the emit rate — orders of
   * magnitude apart.
   */
  readonly writes?: boolean;
  /** Absent exactly when the channel never crosses the wire (`in-process`). */
  readonly delivery?: ChannelDelivery;
}

export const CHANNEL_ATTRS = {
  'yield:created':                    { recorded: true, direction: 'inbound', delivery: 'passing' },
  'yield:cloned':                     { recorded: true, direction: 'inbound', delivery: 'passing' },
  'yield:updated':                    { recorded: true, direction: 'inbound', delivery: 'passing' },
  'yield:moved':                      { recorded: true, direction: 'inbound', delivery: 'passing' },
  'yield:representation-added':       { recorded: true, direction: 'inbound', delivery: 'positioned' },
  'yield:representation-removed':     { recorded: true, direction: 'inbound', delivery: 'positioned' },
  'yield:create':                     { recorded: false, direction: 'outbound', writes: true, delivery: 'passing' },
  'yield:clone-persist':              { recorded: false, direction: 'outbound', writes: true, delivery: 'passing' },
  'yield:update':                     { recorded: false, direction: 'outbound', writes: true, delivery: 'passing' },
  'yield:mv':                         { recorded: false, direction: 'in-process' },
  'yield:clone':                      { recorded: false, direction: 'in-process' },
  'yield:clone-token-requested':      { recorded: false, direction: 'outbound', writes: false, delivery: 'passing' },
  'yield:clone-resource-requested':   { recorded: false, direction: 'outbound', writes: false, delivery: 'passing' },
  'yield:clone-create':               { recorded: false, direction: 'outbound', writes: true, delivery: 'passing' },
  'yield:create-ok':                  { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'yield:create-failed':              { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'yield:clone-persist-ok':           { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'yield:clone-persist-failed':       { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'yield:update-ok':                  { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'yield:update-failed':              { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'yield:move-failed':                { recorded: false, direction: 'in-process' },
  'yield:clone-token-generated':      { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'yield:clone-token-failed':         { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'yield:clone-resource-result':      { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'yield:clone-resource-failed':      { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'yield:clone-created':              { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'yield:clone-create-failed':        { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'mark:added':                       { recorded: true, direction: 'inbound', delivery: 'positioned' },
  'mark:removed':                     { recorded: true, direction: 'inbound', delivery: 'positioned' },
  'mark:body-updated':                { recorded: true, direction: 'inbound', delivery: 'positioned' },
  'mark:entity-tag-added':            { recorded: true, direction: 'inbound', delivery: 'positioned' },
  'mark:entity-tag-removed':          { recorded: true, direction: 'inbound', delivery: 'positioned' },
  'mark:archived':                    { recorded: true, direction: 'inbound', delivery: 'positioned' },
  'mark:unarchived':                  { recorded: true, direction: 'inbound', delivery: 'positioned' },
  'mark:create-request':              { recorded: false, direction: 'outbound', writes: true, delivery: 'passing' },
  'mark:create':                      { recorded: false, direction: 'in-process' },
  'mark:delete':                      { recorded: false, direction: 'outbound', writes: true, delivery: 'passing' },
  'mark:update-body':                 { recorded: false, direction: 'outbound', writes: true, delivery: 'passing' },
  'mark:archive':                     { recorded: false, direction: 'outbound', writes: true, delivery: 'passing' },
  'mark:unarchive':                   { recorded: false, direction: 'outbound', writes: true, delivery: 'passing' },
  'mark:update-entity-types':         { recorded: false, direction: 'outbound', writes: true, delivery: 'passing' },
  'mark:create-ok':                   { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'mark:create-failed':               { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'mark:commit':                      { recorded: false, direction: 'outbound', writes: true, delivery: 'passing' },
  'mark:commit-ok':                   { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'mark:commit-failed':               { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'mark:delete-ok':                   { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'mark:delete-failed':               { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'mark:archive-ok':                  { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'mark:archive-failed':              { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'mark:unarchive-ok':                { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'mark:unarchive-failed':            { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'mark:update-entity-types-ok':      { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'mark:update-entity-types-failed':  { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'mark:body-update-failed':          { recorded: false, direction: 'inbound', delivery: 'passing' },
  'mark:select-comment':              { recorded: false, direction: 'in-process' },
  'mark:select-tag':                  { recorded: false, direction: 'in-process' },
  'mark:select-assessment':           { recorded: false, direction: 'in-process' },
  'mark:select-reference':            { recorded: false, direction: 'in-process' },
  'mark:requested':                   { recorded: false, direction: 'in-process' },
  'mark:cancel-pending':              { recorded: false, direction: 'in-process' },
  'mark:submit':                      { recorded: false, direction: 'in-process' },
  'mark:delegate-request':            { recorded: false, direction: 'in-process' },
  'mark:progress-dismiss':            { recorded: false, direction: 'in-process' },
  'mark:delegate-timeout':            { recorded: false, direction: 'in-process' },
  'mark:create-error':                { recorded: false, direction: 'in-process' },
  'mark:delete-error':                { recorded: false, direction: 'in-process' },
  'bind:body-error':                  { recorded: false, direction: 'in-process' },
  'frame:entity-type-added':          { recorded: true, direction: 'inbound', delivery: 'passing' },
  'frame:tag-schema-added':           { recorded: true, direction: 'inbound', delivery: 'passing' },
  'frame:add-entity-type':            { recorded: false, direction: 'outbound', writes: true, delivery: 'passing' },
  'frame:add-tag-schema':             { recorded: false, direction: 'outbound', writes: true, delivery: 'passing' },
  'frame:entity-type-add-ok':         { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'frame:entity-type-add-failed':     { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'frame:tag-schema-add-ok':          { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'frame:tag-schema-add-failed':      { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'person:profiled':                  { recorded: true, direction: 'inbound', delivery: 'passing' },
  'person:profile':                   { recorded: false, direction: 'outbound', writes: true, delivery: 'passing' },
  'bind:initiate':                    { recorded: false, direction: 'in-process' },
  'bind:update-body':                 { recorded: false, direction: 'outbound', writes: true, delivery: 'passing' },
  'bind:body-updated':                { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'bind:body-update-failed':          { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'match:search-requested':           { recorded: false, direction: 'outbound', writes: false, delivery: 'passing' },
  'match:search-results':             { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'match:search-failed':              { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'match:resources-requested':        { recorded: false, direction: 'outbound', writes: false, delivery: 'passing' },
  'match:resources-result':           { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'match:resources-failed':           { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'match:limits-requested':           { recorded: false, direction: 'outbound', writes: false, delivery: 'passing' },
  'match:limits-result':              { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'match:limits-failed':              { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'gather:requested':                 { recorded: false, direction: 'outbound', writes: false, delivery: 'passing' },
  'gather:complete':                  { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'gather:failed':                    { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'gather:resource-requested':        { recorded: false, direction: 'outbound', writes: false, delivery: 'passing' },
  'gather:resource-complete':         { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'gather:resource-failed':           { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'gather:summary-requested':         { recorded: false, direction: 'outbound', writes: false, delivery: 'passing' },
  'gather:summary-result':            { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'gather:summary-failed':            { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'gather:referenced-by-requested':   { recorded: false, direction: 'outbound', writes: false, delivery: 'passing' },
  'gather:referenced-by-result':      { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'gather:referenced-by-failed':      { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'gather:limits-requested':          { recorded: false, direction: 'outbound', writes: false, delivery: 'passing' },
  'gather:limits-result':             { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'gather:limits-failed':             { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'browse:resource-requested':        { recorded: false, direction: 'outbound', writes: false, delivery: 'passing' },
  'browse:resource-result':           { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'browse:resource-failed':           { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'browse:anchored-text-requested':   { recorded: false, direction: 'outbound', writes: false, delivery: 'passing' },
  'browse:anchored-text-result':      { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'browse:anchored-text-failed':      { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'browse:resources-requested':       { recorded: false, direction: 'outbound', writes: false, delivery: 'passing' },
  'browse:resources-result':          { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'browse:resources-failed':          { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'browse:annotations-requested':     { recorded: false, direction: 'outbound', writes: false, delivery: 'passing' },
  'browse:annotations-result':        { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'browse:annotations-failed':        { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'browse:annotation-requested':      { recorded: false, direction: 'outbound', writes: false, delivery: 'passing' },
  'browse:annotation-result':         { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'browse:annotation-failed':         { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'browse:events-requested':          { recorded: false, direction: 'outbound', writes: false, delivery: 'passing' },
  'browse:events-result':             { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'browse:events-failed':             { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'browse:annotation-history-requested': { recorded: false, direction: 'outbound', writes: false, delivery: 'passing' },
  'browse:annotation-history-result': { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'browse:annotation-history-failed': { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'browse:annotation-context-requested': { recorded: false, direction: 'outbound', writes: false, delivery: 'passing' },
  'browse:annotation-context-result': { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'browse:annotation-context-failed': { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'browse:entity-types-requested':    { recorded: false, direction: 'outbound', writes: false, delivery: 'passing' },
  'browse:entity-types-result':       { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'browse:entity-types-failed':       { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'browse:tag-schemas-requested':     { recorded: false, direction: 'outbound', writes: false, delivery: 'passing' },
  'browse:tag-schemas-result':        { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'browse:tag-schemas-failed':        { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'browse:agents-requested':          { recorded: false, direction: 'outbound', writes: false, delivery: 'passing' },
  'browse:agents-result':             { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'browse:agents-failed':             { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'browse:kb-requested':              { recorded: false, direction: 'outbound', writes: false, delivery: 'passing' },
  'browse:kb-result':                 { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'browse:kb-failed':                 { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'browse:directory-requested':       { recorded: false, direction: 'outbound', writes: false, delivery: 'passing' },
  'browse:directory-result':          { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'browse:directory-failed':          { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'browse:click':                     { recorded: false, direction: 'inbound', delivery: 'passing' },
  'browse:resource-open':             { recorded: false, direction: 'inbound', delivery: 'passing' },
  'browse:resource-viewed':           { recorded: false, direction: 'inbound', delivery: 'passing' },
  'browse:entity-type-clicked':       { recorded: false, direction: 'in-process' },
  'panel:toggle':                     { recorded: false, direction: 'in-process' },
  'panel:open':                       { recorded: false, direction: 'in-process' },
  'panel:close':                      { recorded: false, direction: 'in-process' },
  'shell:sidebar-toggle':             { recorded: false, direction: 'in-process' },
  'tabs:close':                       { recorded: false, direction: 'in-process' },
  'tabs:reorder':                     { recorded: false, direction: 'in-process' },
  'nav:link-clicked':                 { recorded: false, direction: 'in-process' },
  'nav:push':                         { recorded: false, direction: 'in-process' },
  'nav:external':                     { recorded: false, direction: 'in-process' },
  'beckon:hover':                     { recorded: false, direction: 'in-process' },
  'beckon:focus':                     { recorded: false, direction: 'inbound', delivery: 'passing' },
  'beckon:sparkle':                   { recorded: false, direction: 'inbound', delivery: 'passing' },
  'job:started':                      { recorded: true, direction: 'inbound', delivery: 'positioned' },
  'job:assigned':                     { recorded: true, direction: 'inbound', delivery: 'positioned' },
  'job:completed':                    { recorded: true, direction: 'inbound', delivery: 'positioned' },
  'job:failed':                       { recorded: true, direction: 'inbound', delivery: 'positioned' },
  'job:start':                        { recorded: false, direction: 'outbound', writes: true, delivery: 'passing' },
  'job:assign':                       { recorded: false, direction: 'outbound', writes: true, delivery: 'passing' },
  'job:report-progress':              { recorded: false, direction: 'inbound', delivery: 'passing' },
  'job:complete':                     { recorded: false, direction: 'inbound', delivery: 'passing' },
  'job:fail':                         { recorded: false, direction: 'inbound', delivery: 'passing' },
  'job:checkpoint':                   { recorded: false, direction: 'outbound', writes: true, delivery: 'passing' },
  'job:queued':                       { recorded: false, direction: 'inbound', delivery: 'passing' },
  'job:cancel-requested':             { recorded: false, direction: 'outbound', writes: true, delivery: 'passing' },
  'job:cancel':                       { recorded: false, direction: 'outbound', writes: true, delivery: 'passing' },
  'job:limits-requested':             { recorded: false, direction: 'outbound', writes: false, delivery: 'passing' },
  'job:limits-result':                { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'job:limits-failed':                { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'job:status-requested':             { recorded: false, direction: 'outbound', writes: false, delivery: 'passing' },
  'job:create':                       { recorded: false, direction: 'outbound', writes: true, delivery: 'passing' },
  'job:claim':                        { recorded: false, direction: 'outbound', writes: true, delivery: 'passing' },
  'job:status-result':                { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'job:status-failed':                { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'job:created':                      { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'job:create-failed':                { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'job:claimed':                      { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'job:claim-failed':                 { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'job:cancel-ok':                    { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'job:cancel-failed':                { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'weave:applied':                    { recorded: false, direction: 'inbound', delivery: 'passing' },
  'smelt:settled':                    { recorded: false, direction: 'inbound', delivery: 'passing' },
  'weave:rebuild':                    { recorded: false, direction: 'outbound', writes: true, delivery: 'passing' },
  'weave:rebuild-ok':                 { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'weave:rebuild-failed':             { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'smelt:rebuild-anchors':            { recorded: false, direction: 'outbound', writes: true, delivery: 'passing' },
  'smelt:rebuild-anchors-ok':         { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'smelt:rebuild-anchors-failed':     { recorded: false, direction: 'inbound', delivery: 'correlated' },
  'settings:theme-changed':           { recorded: false, direction: 'in-process' },
  'settings:line-numbers-toggled':    { recorded: false, direction: 'in-process' },
  'settings:locale-changed':          { recorded: false, direction: 'in-process' },
  'settings:hover-delay-changed':     { recorded: false, direction: 'in-process' },
  'bus:resume-gap':                   { recorded: false, direction: 'inbound', delivery: 'passing' },
  'session:joined':                   { recorded: false, direction: 'inbound', delivery: 'passing' },
  'session:left':                     { recorded: false, direction: 'inbound', delivery: 'passing' },
} as const satisfies Record<EventName, ChannelAttrs>;

const BY_CHANNEL: ReadonlyMap<string, ChannelAttrs> = new Map(Object.entries(CHANNEL_ATTRS));

/** String-keyed accessor for boundary code that has not yet narrowed to
 *  EventName. Undefined means "not a channel", never "unclassified" — the
 *  satisfies above makes unclassified unrepresentable. */
export const channelAttrsOf = (channel: string): ChannelAttrs | undefined => BY_CHANNEL.get(channel);

/** Did emitting this channel CHANGE the knowledge base? False for a read, and
 *  for anything nobody emits — both are "no act happened", which is the
 *  question every caller is actually asking. */
export const channelWrites = (channel: string): boolean => BY_CHANNEL.get(channel)?.writes === true;
