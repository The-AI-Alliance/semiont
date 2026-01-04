import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { TranslationProvider, useTranslations } from '../TranslationContext';
import type { TranslationManager } from '../../types/TranslationManager';

// Test component that uses the hook
function TestConsumer({ namespace }: { namespace: string }) {
  const t = useTranslations(namespace);

  return (
    <div>
      <div data-testid="translation-1">{t('key1')}</div>
      <div data-testid="translation-2">{t('key2')}</div>
      <div data-testid="translation-missing">{t('missingKey')}</div>
    </div>
  );
}

describe('TranslationContext', () => {
  describe('TranslationProvider', () => {
    it('should provide translation manager to child components', () => {
      const mockManager: TranslationManager = {
        t: (namespace: string, key: string) => `${namespace}.${key}`,
      };

      render(
        <TranslationProvider translationManager={mockManager}>
          <TestConsumer namespace="Toolbar" />
        </TranslationProvider>
      );

      expect(screen.getByTestId('translation-1')).toHaveTextContent('Toolbar.key1');
      expect(screen.getByTestId('translation-2')).toHaveTextContent('Toolbar.key2');
      expect(screen.getByTestId('translation-missing')).toHaveTextContent('Toolbar.missingKey');
    });

    it('should support multiple namespaces', () => {
      const mockManager: TranslationManager = {
        t: (namespace: string, key: string) => `Translated: ${namespace}/${key}`,
      };

      function MultiNamespaceConsumer() {
        const toolbar = useTranslations('Toolbar');
        const footer = useTranslations('Footer');

        return (
          <div>
            <div data-testid="toolbar">{toolbar('save')}</div>
            <div data-testid="footer">{footer('copyright')}</div>
          </div>
        );
      }

      render(
        <TranslationProvider translationManager={mockManager}>
          <MultiNamespaceConsumer />
        </TranslationProvider>
      );

      expect(screen.getByTestId('toolbar')).toHaveTextContent('Translated: Toolbar/save');
      expect(screen.getByTestId('footer')).toHaveTextContent('Translated: Footer/copyright');
    });

    it('should handle actual translations', () => {
      const mockManager: TranslationManager = {
        t: (namespace: string, key: string) => {
          const translations: Record<string, Record<string, string>> = {
            Common: {
              save: 'Save',
              cancel: 'Cancel',
              delete: 'Delete',
            },
            Navigation: {
              home: 'Home',
              know: 'Know',
            },
          };
          return translations[namespace]?.[key] || key;
        },
      };

      function RealTranslationsConsumer() {
        const common = useTranslations('Common');
        const nav = useTranslations('Navigation');

        return (
          <div>
            <button data-testid="save-btn">{common('save')}</button>
            <button data-testid="cancel-btn">{common('cancel')}</button>
            <a data-testid="home-link">{nav('home')}</a>
          </div>
        );
      }

      render(
        <TranslationProvider translationManager={mockManager}>
          <RealTranslationsConsumer />
        </TranslationProvider>
      );

      expect(screen.getByTestId('save-btn')).toHaveTextContent('Save');
      expect(screen.getByTestId('cancel-btn')).toHaveTextContent('Cancel');
      expect(screen.getByTestId('home-link')).toHaveTextContent('Home');
    });

    it('should handle missing translations gracefully', () => {
      const mockManager: TranslationManager = {
        t: (namespace: string, key: string) => {
          const translations: Record<string, Record<string, string>> = {
            Common: { save: 'Save' },
          };
          return translations[namespace]?.[key] || key; // Return key as fallback
        },
      };

      function MissingTranslationConsumer() {
        const common = useTranslations('Common');
        const unknown = useTranslations('UnknownNamespace');

        return (
          <div>
            <div data-testid="existing">{common('save')}</div>
            <div data-testid="missing-key">{common('missingKey')}</div>
            <div data-testid="missing-namespace">{unknown('anyKey')}</div>
          </div>
        );
      }

      render(
        <TranslationProvider translationManager={mockManager}>
          <MissingTranslationConsumer />
        </TranslationProvider>
      );

      expect(screen.getByTestId('existing')).toHaveTextContent('Save');
      expect(screen.getByTestId('missing-key')).toHaveTextContent('missingKey');
      expect(screen.getByTestId('missing-namespace')).toHaveTextContent('anyKey');
    });

    it('should render children', () => {
      const mockManager: TranslationManager = {
        t: (namespace: string, key: string) => `${namespace}.${key}`,
      };

      render(
        <TranslationProvider translationManager={mockManager}>
          <div data-testid="child">Child content</div>
        </TranslationProvider>
      );

      expect(screen.getByTestId('child')).toHaveTextContent('Child content');
    });

    it('should update when manager changes', () => {
      const mockManager1: TranslationManager = {
        t: (namespace: string, key: string) => `EN: ${namespace}.${key}`,
      };

      const { rerender } = render(
        <TranslationProvider translationManager={mockManager1}>
          <TestConsumer namespace="Toolbar" />
        </TranslationProvider>
      );

      expect(screen.getByTestId('translation-1')).toHaveTextContent('EN: Toolbar.key1');

      const mockManager2: TranslationManager = {
        t: (namespace: string, key: string) => `FR: ${namespace}.${key}`,
      };

      rerender(
        <TranslationProvider translationManager={mockManager2}>
          <TestConsumer namespace="Toolbar" />
        </TranslationProvider>
      );

      expect(screen.getByTestId('translation-1')).toHaveTextContent('FR: Toolbar.key1');
    });

    it('should call translation manager for each key', () => {
      const tMock = vi.fn((namespace: string, key: string) => `${namespace}.${key}`);
      const mockManager: TranslationManager = { t: tMock };

      render(
        <TranslationProvider translationManager={mockManager}>
          <TestConsumer namespace="Toolbar" />
        </TranslationProvider>
      );

      expect(tMock).toHaveBeenCalledWith('Toolbar', 'key1');
      expect(tMock).toHaveBeenCalledWith('Toolbar', 'key2');
      expect(tMock).toHaveBeenCalledWith('Toolbar', 'missingKey');
    });
  });

  describe('useTranslations', () => {
    it('should throw error when used outside provider', () => {
      // Suppress console.error for this test
      const consoleError = console.error;
      console.error = () => {};

      expect(() => {
        render(<TestConsumer namespace="Toolbar" />);
      }).toThrow('useTranslations must be used within a TranslationProvider');

      console.error = consoleError;
    });

    it('should return translation function scoped to namespace', () => {
      const mockManager: TranslationManager = {
        t: (namespace: string, key: string) => `${namespace}/${key}`,
      };

      function ScopedConsumer() {
        const toolbar = useTranslations('Toolbar');
        const footer = useTranslations('Footer');

        return (
          <div>
            <div data-testid="toolbar-save">{toolbar('save')}</div>
            <div data-testid="footer-copyright">{footer('copyright')}</div>
          </div>
        );
      }

      render(
        <TranslationProvider translationManager={mockManager}>
          <ScopedConsumer />
        </TranslationProvider>
      );

      expect(screen.getByTestId('toolbar-save')).toHaveTextContent('Toolbar/save');
      expect(screen.getByTestId('footer-copyright')).toHaveTextContent('Footer/copyright');
    });
  });

  describe('Provider Pattern Integration', () => {
    it('should accept any TranslationManager implementation', () => {
      // Custom implementation (e.g., with different i18n library)
      class CustomTranslationManager implements TranslationManager {
        private locale = 'es';

        t(namespace: string, key: string): string {
          // Simulated Spanish translations
          return `[${this.locale}] ${namespace}.${key}`;
        }
      }

      const customManager = new CustomTranslationManager();

      render(
        <TranslationProvider translationManager={customManager}>
          <TestConsumer namespace="Common" />
        </TranslationProvider>
      );

      expect(screen.getByTestId('translation-1')).toHaveTextContent('[es] Common.key1');
    });

    it('should work with nested providers', () => {
      const outerManager: TranslationManager = {
        t: (namespace: string, key: string) => `OUTER: ${namespace}.${key}`,
      };

      const innerManager: TranslationManager = {
        t: (namespace: string, key: string) => `INNER: ${namespace}.${key}`,
      };

      function InnerConsumer() {
        const t = useTranslations('Inner');
        return <div data-testid="inner">{t('test')}</div>;
      }

      function OuterConsumer() {
        const t = useTranslations('Outer');
        return (
          <div>
            <div data-testid="outer">{t('test')}</div>
            <TranslationProvider translationManager={innerManager}>
              <InnerConsumer />
            </TranslationProvider>
          </div>
        );
      }

      render(
        <TranslationProvider translationManager={outerManager}>
          <OuterConsumer />
        </TranslationProvider>
      );

      expect(screen.getByTestId('outer')).toHaveTextContent('OUTER: Outer.test');
      expect(screen.getByTestId('inner')).toHaveTextContent('INNER: Inner.test');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty namespace', () => {
      const mockManager: TranslationManager = {
        t: (namespace: string, key: string) => {
          if (!namespace) return `NO_NAMESPACE: ${key}`;
          return `${namespace}.${key}`;
        },
      };

      function EmptyNamespaceConsumer() {
        const t = useTranslations('');
        return <div data-testid="result">{t('key')}</div>;
      }

      render(
        <TranslationProvider translationManager={mockManager}>
          <EmptyNamespaceConsumer />
        </TranslationProvider>
      );

      expect(screen.getByTestId('result')).toHaveTextContent('NO_NAMESPACE: key');
    });

    it('should handle empty key', () => {
      const mockManager: TranslationManager = {
        t: (namespace: string, key: string) => {
          if (!key) return `${namespace}: NO_KEY`;
          return `${namespace}.${key}`;
        },
      };

      function EmptyKeyConsumer() {
        const t = useTranslations('Toolbar');
        return <div data-testid="result">{t('')}</div>;
      }

      render(
        <TranslationProvider translationManager={mockManager}>
          <EmptyKeyConsumer />
        </TranslationProvider>
      );

      expect(screen.getByTestId('result')).toHaveTextContent('Toolbar: NO_KEY');
    });

    it('should handle special characters in namespace and key', () => {
      const mockManager: TranslationManager = {
        t: (namespace: string, key: string) => `${namespace}::${key}`,
      };

      function SpecialCharsConsumer() {
        const t = useTranslations('Tool-bar_v2');
        return <div data-testid="result">{t('save.action#1')}</div>;
      }

      render(
        <TranslationProvider translationManager={mockManager}>
          <SpecialCharsConsumer />
        </TranslationProvider>
      );

      expect(screen.getByTestId('result')).toHaveTextContent('Tool-bar_v2::save.action#1');
    });

    it('should handle very long translation strings', () => {
      const longTranslation = 'A'.repeat(1000);
      const mockManager: TranslationManager = {
        t: (namespace: string, key: string) => {
          if (key === 'long') return longTranslation;
          return `${namespace}.${key}`;
        },
      };

      function LongTranslationConsumer() {
        const t = useTranslations('Test');
        return <div data-testid="result">{t('long')}</div>;
      }

      render(
        <TranslationProvider translationManager={mockManager}>
          <LongTranslationConsumer />
        </TranslationProvider>
      );

      expect(screen.getByTestId('result')).toHaveTextContent(longTranslation);
    });

    it('should handle translations with HTML-like content', () => {
      const mockManager: TranslationManager = {
        t: (namespace: string, key: string) => {
          if (key === 'html') return '<strong>Bold</strong> & "quoted"';
          return `${namespace}.${key}`;
        },
      };

      function HtmlContentConsumer() {
        const t = useTranslations('Test');
        return <div data-testid="result">{t('html')}</div>;
      }

      render(
        <TranslationProvider translationManager={mockManager}>
          <HtmlContentConsumer />
        </TranslationProvider>
      );

      // React renders text content, not HTML
      expect(screen.getByTestId('result')).toHaveTextContent('<strong>Bold</strong> & "quoted"');
    });

    it('should handle manager that returns numbers', () => {
      const mockManager: TranslationManager = {
        t: (namespace: string, key: string) => {
          // TypeScript expects string, but testing runtime behavior
          return '42' as string;
        },
      };

      function NumberConsumer() {
        const t = useTranslations('Test');
        return <div data-testid="result">{t('number')}</div>;
      }

      render(
        <TranslationProvider translationManager={mockManager}>
          <NumberConsumer />
        </TranslationProvider>
      );

      expect(screen.getByTestId('result')).toHaveTextContent('42');
    });

    it('should handle same namespace used multiple times', () => {
      const tMock = vi.fn((namespace: string, key: string) => `${namespace}.${key}`);
      const mockManager: TranslationManager = { t: tMock };

      function MultipleCallsConsumer() {
        const t1 = useTranslations('Common');
        const t2 = useTranslations('Common'); // Same namespace again

        return (
          <div>
            <div data-testid="first">{t1('save')}</div>
            <div data-testid="second">{t2('cancel')}</div>
          </div>
        );
      }

      render(
        <TranslationProvider translationManager={mockManager}>
          <MultipleCallsConsumer />
        </TranslationProvider>
      );

      expect(screen.getByTestId('first')).toHaveTextContent('Common.save');
      expect(screen.getByTestId('second')).toHaveTextContent('Common.cancel');
      expect(tMock).toHaveBeenCalledWith('Common', 'save');
      expect(tMock).toHaveBeenCalledWith('Common', 'cancel');
    });
  });
});
