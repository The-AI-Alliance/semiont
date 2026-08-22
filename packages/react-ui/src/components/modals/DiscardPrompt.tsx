'use client';

/**
 * The inline discard band (COMPOSE-IN-MODAL D4, shared by GATHER-AT-THE-TOP
 * P1): a modal dies on ✕/Escape/backdrop, but typed work must not die with
 * it. Hosts route ALL dismissal through one handler; when the draft is dirty
 * that handler shows this band instead of closing. Success paths never come
 * here — the guard protects dismissal, not completion.
 */
interface DiscardPromptProps {
  prompt: string;
  discardLabel: string;
  keepLabel: string;
  onDiscard: () => void;
  onKeepEditing: () => void;
}

export function DiscardPrompt({ prompt, discardLabel, keepLabel, onDiscard, onKeepEditing }: DiscardPromptProps) {
  return (
    <div className="semiont-wizard__discard-prompt" role="alert">
      <span className="semiont-wizard__discard-prompt-text">{prompt}</span>
      <button
        type="button"
        className="semiont-button--danger"
        onClick={onDiscard}
      >
        {discardLabel}
      </button>
      <button
        type="button"
        className="semiont-button--secondary"
        onClick={onKeepEditing}
      >
        {keepLabel}
      </button>
    </div>
  );
}
