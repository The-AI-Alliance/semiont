'use client';

import { deriveViews, type GatheredContext } from '@semiont/core';

export interface ContextSummaryTranslations {
  sourceContextLabel: string;
  connectionsLabel: string;
  citedByLabel: string;
  /** GEP P2: the graph pane's chrome travels with this component (D10). */
  graphPaneTitle: string;
  /** Strategy-relevant empty state — emptiness is evidence (GEP D1). */
  graphEmpty: string;
}

export interface ContextSummaryProps {
  context: GatheredContext;
  translations: ContextSummaryTranslations;
}

export function ContextSummary({ context, translations: t }: ContextSummaryProps) {
  // Graph views are focus-agnostic — only the focal resource id (and an optional
  // focal annotation id) differ by kind.
  // ResourceDescriptor's identifier is `@id` (JSON-LD) — its open index
  // signature makes a bare `.id` deref compile and silently yield undefined.
  const mainResourceId = context.focus.kind === 'annotation'
    ? context.focus.sourceResource['@id']
    : context.focus.resource['@id'];
  const focalAnnotationId = context.focus.kind === 'annotation'
    ? context.focus.annotation.id
    : undefined;
  const { connections, citedBy, citedByCount } = deriveViews(
    context.graph,
    mainResourceId,
    focalAnnotationId,
  );

  // Sibling NODES — the same structural annotation-of walk core uses for its
  // entity-type set, collected at node granularity because the viz draws them
  // (GEP P4; core's `siblingEntityTypes` stays the prompt-side view).
  const annotationOf = new Map<string, string>();
  for (const edge of context.graph.edges) {
    if (edge.type === 'annotation-of') annotationOf.set(edge.source, edge.target);
  }
  const siblings = context.graph.nodes.filter(
    (n) => n.type === 'annotation' && n.id !== focalAnnotationId && annotationOf.get(n.id) === mainResourceId,
  );

  // Rarity-ranked entity types for hover-text — the IDF semantics
  // `entityTypeFrequencies` was stored for (D3).
  const freq: Record<string, number> =
    (context.metadata?.entityTypeFrequencies as Record<string, number> | undefined) ?? {};
  const rank = (types: string[]) => [...types].sort((a, b) => (freq[a] ?? 0) - (freq[b] ?? 0));

  const firstBodyValue = (body: unknown): string | undefined => {
    const item = Array.isArray(body) ? body[0] : body;
    return item && typeof item === 'object' && 'value' in item
      ? (item as { value?: string }).value
      : undefined;
  };

  // ── Deterministic layered layout (D3): citers | focal + siblings | peers ──
  // Positions derive from array order alone — no physics, no randomness.
  const NODE_W = 180;
  const NODE_H = 34;
  const ROW = 52;
  const TOP = 8;
  const COL_X = [8, 224, 440];

  type DrawnNode = {
    id: string; label: string; kind: 'focal' | 'resource' | 'annotation';
    hover: string; x: number; y: number;
  };
  type DrawnEdge = { key: string; kind: 'cites' | 'peer' | 'annotation-of'; hover: string;
    x1: number; y1: number; x2: number; y2: number };

  const focalNode = context.graph.nodes.find((n) => n.id === mainResourceId);
  const focalLabel = focalNode?.label
    ?? (context.focus.kind === 'annotation' ? context.focus.sourceResource.name : context.focus.resource.name)
    ?? mainResourceId;

  const drawn: DrawnNode[] = [];
  const drawnEdges: DrawnEdge[] = [];

  const focal: DrawnNode = { id: mainResourceId, label: focalLabel, kind: 'focal', hover: focalLabel, x: COL_X[1]!, y: TOP };
  drawn.push(focal);

  citedBy.forEach((c, i) => {
    const node: DrawnNode = { id: c.resourceId, label: c.resourceName, kind: 'resource',
      hover: `${c.resourceName}\n${t.citedByLabel}`, x: COL_X[0]!, y: TOP + i * ROW };
    drawn.push(node);
    drawnEdges.push({ key: `cites-${c.resourceId}`, kind: 'cites', hover: 'cites',
      x1: node.x + NODE_W, y1: node.y + NODE_H / 2, x2: focal.x, y2: focal.y + NODE_H / 2 });
  });

  connections.forEach((c, i) => {
    const types = rank(c.entityTypes);
    const node: DrawnNode = { id: c.resourceId, label: c.resourceName, kind: 'resource',
      hover: types.length ? `${c.resourceName}\n${types.join(', ')}` : c.resourceName,
      x: COL_X[2]!, y: TOP + i * ROW };
    drawn.push(node);
    drawnEdges.push({ key: `peer-${c.resourceId}`, kind: 'peer',
      hover: c.bidirectional ? `${t.connectionsLabel} · mutual` : t.connectionsLabel,
      x1: focal.x + NODE_W, y1: focal.y + NODE_H / 2, x2: node.x, y2: node.y + NODE_H / 2 });
  });

  siblings.forEach((s, i) => {
    // Discriminated: type === 'annotation' guarantees the embedded W3C
    // annotation (P3/D11) — motivation and body feed the hover.
    const ann = s.type === 'annotation' ? s.annotation : undefined;
    const motivation = ann?.motivation ?? s.label;
    const body = ann ? firstBodyValue(ann.body) : undefined;
    const types = rank(s.entityTypes ?? []);
    const hover = [motivation, body, types.length ? types.join(', ') : undefined]
      .filter(Boolean).join('\n');
    const node: DrawnNode = { id: s.id, label: s.label, kind: 'annotation',
      hover, x: COL_X[1]!, y: TOP + (i + 1) * ROW };
    drawn.push(node);
    drawnEdges.push({ key: `annof-${s.id}`, kind: 'annotation-of', hover: 'annotation-of',
      x1: focal.x + NODE_W / 2, y1: focal.y + NODE_H, x2: node.x + NODE_W / 2, y2: node.y });
  });

  const rows = Math.max(citedBy.length, 1 + siblings.length, connections.length);
  const height = TOP + rows * ROW + 8;
  const truncate = (s: string) => (s.length > 22 ? `${s.slice(0, 21)}…` : s);
  const hasBody = connections.length > 0 || citedByCount > 0 || siblings.length > 0;

  // GEP P4: this component IS the graph pane, and its body IS a graph — a
  // hand-rolled deterministic SVG (D3: no physics, no library, no pan-zoom;
  // a decision surface, not an explorer). Chrome travels with the component,
  // so every consumer inherits it (D10). Emptiness is evidence (D1).
  return (
    <div className="semiont-gather-pane semiont-gather-pane--graph">
      <div className="semiont-gather-pane__title">{t.graphPaneTitle}</div>
      {context.inferredRelationshipSummary && (
        <p className="semiont-gather-pane__summary">{context.inferredRelationshipSummary}</p>
      )}
      {!hasBody && (
        <p className="semiont-gather-pane__empty">{t.graphEmpty}</p>
      )}
      {hasBody && (
        <>
          <svg
            className="semiont-graph"
            viewBox={`0 0 628 ${height}`}
            role="img"
            aria-label={t.graphPaneTitle}
          >
            {drawnEdges.map((e) => (
              <g key={e.key} className={`semiont-graph__edge semiont-graph__edge--${e.kind}`}>
                <line x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} />
                <title>{e.hover}</title>
              </g>
            ))}
            {drawn.map((n) => (
              <g
                key={n.id}
                className={`semiont-graph__node semiont-graph__node--${n.kind}`}
                data-node-id={n.id}
              >
                <rect x={n.x} y={n.y} width={NODE_W} height={NODE_H} rx={6} />
                <text x={n.x + 10} y={n.y + 22}>{truncate(n.label)}</text>
                <title>{n.hover}</title>
              </g>
            ))}
          </svg>
          {citedByCount > 0 && (
            <p className="semiont-graph__cited-line">← {t.citedByLabel} ({citedByCount})</p>
          )}
        </>
      )}
    </div>
  );
}
