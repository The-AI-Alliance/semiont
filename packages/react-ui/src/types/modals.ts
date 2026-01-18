import { ComponentType, ReactNode } from 'react';

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
 * Props for modals that need translation support
 */
export interface TranslatableModalProps {
  /** Translation function for getting localized strings */
  t: (key: string, values?: Record<string, any>) => string;
  /** Current locale code */
  locale?: string;
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

/**
 * Generation config modal props
 */
export interface GenerationConfigModalProps extends BaseModalProps {
  /** Callback when generation is triggered */
  onGenerate: (options: GenerationOptions) => void;
  /** Reference ID for the annotation */
  referenceId: string;
  /** Resource URI */
  resourceUri: string;
  /** Default title from selected text */
  defaultTitle: string;
  /** Translation function */
  t: (key: string, values?: Record<string, any>) => string;
  /** Current locale */
  locale: string;
  /** Available locales */
  locales?: Array<{ code: string; name: string; nativeName: string }>;
}

/**
 * Generation options
 */
export interface GenerationOptions {
  title: string;
  prompt?: string;
  language?: string;
  temperature?: number;
  maxTokens?: number;
  context: any; // GenerationContext from api-client
}

/**
 * Resource search modal props
 */
export interface ResourceSearchModalProps extends BaseModalProps {
  /** Callback when a resource is selected */
  onSelect: (resourceId: string) => void;
  /** Initial search term */
  searchTerm?: string;
  /** Optional translation support */
  translations?: {
    title?: string;
    placeholder?: string;
    searching?: string;
    noResults?: string;
  };
}

/**
 * Modal provider props for dependency injection
 */
export interface ModalProviderProps {
  /** Dialog component (e.g., from @headlessui/react) */
  DialogComponent: ComponentType<any>;
  /** Dialog panel component */
  DialogPanelComponent: ComponentType<any>;
  /** Dialog title component */
  DialogTitleComponent?: ComponentType<any>;
  /** Transition component */
  TransitionComponent: ComponentType<any>;
  /** Transition child component */
  TransitionChildComponent: ComponentType<any>;
  /** Children to render */
  children: ReactNode;
}