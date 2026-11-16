'use client';

import { deriveViews, getBodySource, getExactText, getTargetSelector, type GatheredContext } from '@semiont/core';

export interface ContextSummaryTranslations {
  sourceContextLabel: string;
  connectionsLabel: string;
  citedByLabel: string;
  /** GEP P2: the graph pane's chrome travels with this component (D10). */
  graphPaneTitle: string;
  /** Strategy-relevant empty state — emptiness is evidence (GEP D1). */
  graphEmpty: string;
  /** Resource-level linking annotation whose target the graph can't name. */
  resourceLinkLabel: string;
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
  const { connections, citedBy } = deriveViews(
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
    // Tagging-purpose bodies are the entity-type tag — already shown via
    // entityTypes, so skip them rather than repeat the type in the hover.
    for (const item of Array.isArray(body) ? body : [body]) {
      if (item && typeof item === 'object' && 'value' in item
        && (item as { purpose?: string }).purpose !== 'tagging') {
        return (item as { value?: string }).value;
      }
    }
    return undefined;
  };

  // ── Deterministic layered layout (D3): citers | focal + siblings | peers ──
  // Positions derive from array order alone — no physics, no randomness.
  // Geometry adapts to what's populated (no-clipping principle): an absent
  // citer/peer layer frees its column for the sibling band to wrap into, and
  // the viewBox shrinks to the columns actually used. Everything always draws
  // — overflow rides the wizard pane's scroll, never a cap.
  const NODE_W = 180;
  const NODE_H = 34;
  const ROW = 52;
  const TOP = 8;
  const COL_PITCH = 216;
  const colX = (col: number) => 8 + col * COL_PITCH;

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

  // The sibling band wraps across the columns absent layers free (3 total).
  const hasCiters = citedBy.length > 0;
  const hasPeers = connections.length > 0;
  const bandCols = Math.max(1, Math.min(
    3 - (hasCiters ? 1 : 0) - (hasPeers ? 1 : 0),
    siblings.length,
  ));
  const bandCol0 = hasCiters ? 1 : 0;
  const numCols = (hasCiters ? 1 : 0) + bandCols + (hasPeers ? 1 : 0);

  const focal: DrawnNode = { id: mainResourceId, label: focalLabel, kind: 'focal', hover: focalLabel, x: colX(bandCol0), y: TOP };
  drawn.push(focal);

  citedBy.forEach((c, i) => {
    const node: DrawnNode = { id: c.resourceId, label: c.resourceName, kind: 'resource',
      hover: `${c.resourceName}\n${t.citedByLabel}`, x: colX(0), y: TOP + i * ROW };
    drawn.push(node);
    drawnEdges.push({ key: `cites-${c.resourceId}`, kind: 'cites', hover: 'cites',
      x1: node.x + NODE_W, y1: node.y + NODE_H / 2, x2: focal.x, y2: focal.y + NODE_H / 2 });
  });

  connections.forEach((c, i) => {
    const types = rank(c.entityTypes);
    const node: DrawnNode = { id: c.resourceId, label: c.resourceName, kind: 'resource',
      hover: types.length ? `${c.resourceName}\n${types.join(', ')}` : c.resourceName,
      x: colX(bandCol0 + bandCols), y: TOP + i * ROW };
    drawn.push(node);
    // With a multi-column band the line crosses the band's row 0, which only
    // ever holds the focal node in the band's FIRST column — so it stays clear.
    drawnEdges.push({ key: `peer-${c.resourceId}`, kind: 'peer',
      hover: c.bidirectional ? `${t.connectionsLabel} · mutual` : t.connectionsLabel,
      x1: focal.x + NODE_W, y1: focal.y + NODE_H / 2, x2: node.x, y2: node.y + NODE_H / 2 });
  });

  siblings.forEach((s, i) => {
    // Discriminated: type === 'annotation' guarantees the embedded W3C
    // annotation (P3/D11). The node's identity is the text it wraps — a
    // column of motivation labels is uninterpretable; motivation shows as
    // the node's styling and hover instead.
    const ann = s.type === 'annotation' ? s.annotation : undefined;
    const quote = ann ? getExactText(getTargetSelector(ann.target)) : '';
    const motivation = ann?.motivation ?? s.label;
    const body = ann ? firstBodyValue(ann.body) : undefined;
    const types = rank(s.entityTypes ?? []);
    // A resource-level annotation has no selector — nothing to quote — but is
    // ABOUT a target resource: label it by what it links to. Raw motivation
    // ("linking") is internal vocabulary and stays hover-only.
    const linkTarget = !quote && ann ? getBodySource(ann.body) : null;
    const linkedName = linkTarget
      ? context.graph.nodes.find((n) => n.id === linkTarget)?.label
      : undefined;
    const label = quote
      || (linkedName ? `→ ${linkedName}` : undefined)
      || (linkTarget ? t.resourceLinkLabel : undefined)
      || body
      || s.label;
    // Hover leads with the full label — the drawn one truncates (like the
    // resource nodes, whose hover carries the full name). Deduped: a label
    // that fell through to the body or motivation must not repeat below it.
    const hover = Array.from(new Set(
      [label, motivation, body, types.length ? types.join(', ') : undefined].filter(Boolean),
    )).join('\n');
    const node: DrawnNode = { id: s.id, label, kind: 'annotation',
      hover, x: colX(bandCol0 + (i % bandCols)), y: TOP + (1 + Math.floor(i / bandCols)) * ROW };
    drawn.push(node);
    drawnEdges.push({ key: `annof-${s.id}`, kind: 'annotation-of', hover: 'annotation-of',
      x1: focal.x + NODE_W / 2, y1: focal.y + NODE_H, x2: node.x + NODE_W / 2, y2: node.y });
  });

  const rows = Math.max(citedBy.length, 1 + Math.ceil(siblings.length / bandCols), connections.length);
  const width = numCols * COL_PITCH - 20;
  const height = TOP + rows * ROW + 8;
  const truncate = (s: string) => (s.length > 22 ? `${s.slice(0, 21)}…` : s);
  const hasBody = connections.length > 0 || citedBy.length > 0 || siblings.length > 0;

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
          <svg
            className="semiont-graph"
            viewBox={`0 0 ${width} ${height}`}
            // Natural-size cap: 1 viewBox unit never exceeds 1px, so a compact
            // graph renders small instead of stretching to fill the pane.
            style={{ maxWidth: `${width}px` }}
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
      )}
    </div>
  );
}
