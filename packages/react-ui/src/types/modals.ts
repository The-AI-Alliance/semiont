/**
 * Base modal props that all modals share
 */
export interface BaseModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback when the modal should close */
  onClose: () => void;
  /** Optional CSS class name */
  className?: string;
}

/**
 * Props for modals that navigate
 */
export interface NavigableModalProps {
  /** Navigation function */
  onNavigate: (path: string) => void;
}

/**
 * Search modal specific props
 */
export interface SearchModalProps extends BaseModalProps, NavigableModalProps {
  /** Optional translation support */
  translations?: {
    placeholder?: string;
    searching?: string;
    noResults?: string;
    startTyping?: string;
    navigate?: string;
    select?: string;
    close?: string;
  };
}

