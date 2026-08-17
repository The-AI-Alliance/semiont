'use client';

/**
 * The one wizard footer (WIZARD-NAVIGATION D7).
 *
 * Four steps used to hand-build this markup, which is how four different footers
 * happened: three carried a `✕ Cancel` that duplicated the corner control, one had no
 * footer at all, and every button stretched to equal width so "leave" read as a peer of
 * "do the thing".
 *
 * The grammar, settled in D1/D2:
 *   • Dismissal is NOT here. The corner ✕, Esc and the backdrop are the way out, and
 *     they are the same on every step including the one with no footer.
 *   • Retreat is chrome: quiet, left, no emoji.
 *   • Advance is the decision: filled, right, one verb.
 */

export interface WizardFooterPrimary {
  label: string;
  /** Shown while `pending`; falls back to `label`. */
  pendingLabel?: string;
  pending?: boolean;
  /**
   * The action's PRECONDITION is not met yet (e.g. the review step waiting on
   * gather). Unlike `pending` — the action itself running — this disables only
   * the primary: retreat must stay live while a precondition loads.
   */
  disabled?: boolean;
  type: 'submit' | 'button';
  onClick?: () => void;
}

export interface WizardFooterProps {
  /** Omit both to render no retreat — correct on the first step. */
  backLabel?: string;
  onBack?: () => void;
  /** Omit on steps whose action lives elsewhere (search results links per row). */
  primary?: WizardFooterPrimary;
}

export function WizardFooter({ backLabel, onBack, primary }: WizardFooterProps) {
  const pending = primary?.pending ?? false;

  return (
    <div className="semiont-modal__actions semiont-modal__actions--wizard">
      {onBack && backLabel && (
        <button
          type="button"
          onClick={onBack}
          className="semiont-button--secondary semiont-wizard-footer__back"
          disabled={pending}
        >
          ◀ {backLabel}
        </button>
      )}
      {primary && (
        <button
          type={primary.type}
          {...(primary.onClick ? { onClick: primary.onClick } : {})}
          className="semiont-button--primary"
          disabled={pending || (primary.disabled ?? false)}
          data-pending={pending ? 'true' : 'false'}
        >
          {pending ? (primary.pendingLabel ?? primary.label) : primary.label}
        </button>
      )}
    </div>
  );
}
