import type { TranslationSource } from '../contexts/TranslationContext';

/**
 * The language a component was given among its props, alone: what it hands
 * its own `TranslationProvider`, and what it passes on to a view it renders.
 */
export function translationSourceOf(props: TranslationSource): TranslationSource {
  if (props.translationManager) {
    return { translationManager: props.translationManager };
  }
  return { locale: props.locale, loadingComponent: props.loadingComponent };
}
