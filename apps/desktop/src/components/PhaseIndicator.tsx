import { useEffect, useState } from 'react';

export type Phase = 'gathering' | 'yielding' | 'marking';

const PHASE_LABEL: Record<Phase, string> = {
  gathering: 'Gathering context…',
  yielding: 'Yielding answer…',
  marking: 'Finding references…',
};

/** Each phase gets its own glyph — distinct shape, colour, and motion — that enacts the
 *  verb: Gather converges scattered bits onto a core, Yield writes a document line by
 *  line, Mark highlights passages in one. Pure CSS animation (honours
 *  prefers-reduced-motion); decorative, so aria-hidden. Shared by the running chat turn
 *  and the delegation form's running-task view (DelegationControl). */
export function PhaseIndicator({
  phase,
  startedAt,
  detail,
  label: labelOverride,
}: {
  phase: Phase;
  startedAt: number;
  detail?: string;
  /** Caller-supplied label (the delegation form's verb-specific running copy). */
  label?: string;
}) {
  const Sprite = phase === 'gathering' ? GatherSprite : phase === 'yielding' ? YieldSprite : MarkSprite;
  // While finding references, the linking job reports the entity type it's on.
  const label =
    labelOverride ?? (phase === 'marking' && detail ? `Finding ${detail} references…` : PHASE_LABEL[phase]);
  return (
    <p className={phase === 'marking' ? 'turn__progress turn__progress--refs' : 'turn__progress'}>
      <span className={`sprite sprite--${phase}`} aria-hidden="true">
        <Sprite />
      </span>
      {label}
      <PhaseTimer startedAt={startedAt} />
    </p>
  );
}

/** Live elapsed time for the current phase, ticking once a second. Under a minute it
 *  reads "42s"; at or past a minute, "1m", "1m 1s", "2m 30s", … */
function PhaseTimer({ startedAt }: { startedAt: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  const total = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  const label = m === 0 ? `${s}s` : s === 0 ? `${m}m` : `${m}m ${s}s`;
  return <span className="turn__timer">{label}</span>;
}

// Gather — convergence: bits stream in from three sides and accrete onto a hexagonal
// core (context assembled from across the KB). Teal.
function GatherSprite() {
  return (
    <svg viewBox="0 0 40 40">
      <circle className="gather-bit gather-bit--a" cx="20" cy="5" r="2.4" />
      <circle className="gather-bit gather-bit--b" cx="7" cy="31" r="2.4" />
      <circle className="gather-bit gather-bit--c" cx="33" cy="31" r="2.4" />
      <path className="gather-core" d="M27 20 L23.5 26.1 L16.5 26.1 L13 20 L16.5 13.9 L23.5 13.9 Z" />
    </svg>
  );
}

// Yield — a document writes itself in: its lines fill left-to-right, staggered top to
// bottom (a new answer being composed from the gathered context). Amber.
function YieldSprite() {
  return (
    <svg viewBox="0 0 40 40">
      <rect className="doc-page" x="8" y="4" width="24" height="32" rx="3" />
      <rect className="doc-line yl1" x="12" y="11" width="16" height="2.8" rx="1.4" />
      <rect className="doc-line yl2" x="12" y="17.5" width="16" height="2.8" rx="1.4" />
      <rect className="doc-line yl3" x="12" y="24" width="16" height="2.8" rx="1.4" />
      <rect className="doc-line yl4" x="12" y="30.5" width="10" height="2.8" rx="1.4" />
    </svg>
  );
}

// Mark — the same document, now static (grey) text, with a marker sweeping across two
// passages in turn (the answer's sources surfacing). Violet.
function MarkSprite() {
  return (
    <svg viewBox="0 0 40 40">
      <rect className="doc-page" x="8" y="4" width="24" height="32" rx="3" />
      <rect className="doc-text" x="12" y="11" width="16" height="2.8" rx="1.4" />
      <rect className="doc-text" x="12" y="17.5" width="16" height="2.8" rx="1.4" />
      <rect className="doc-text" x="12" y="24" width="16" height="2.8" rx="1.4" />
      <rect className="doc-text" x="12" y="30.5" width="10" height="2.8" rx="1.4" />
      <rect className="mark-hl hl1" x="12" y="9.8" width="11" height="5.2" rx="2.6" />
      <rect className="mark-hl hl2" x="15" y="22.3" width="13" height="5.2" rx="2.6" />
    </svg>
  );
}
