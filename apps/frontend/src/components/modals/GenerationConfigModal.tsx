'use client';

import React, { useState, useEffect } from 'react';
import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react';
import { useTranslations, useLocale } from 'next-intl';
import type { GatheredContext } from '@semiont/core';
import { LOCALES } from '@semiont/api-client';
import { Fragment } from 'react';

interface GenerationConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  onGenerate: (options: {
    title: string;
    prompt?: string;
    language?: string;
    temperature?: number;
    maxTokens?: number;
    context: GatheredContext;
  }) => void;
  defaultTitle: string;          // Selected text from reference
  context: GatheredContext | null;
  contextLoading: boolean;
  contextError: Error | null;
}

export function GenerationConfigModal({
  isOpen,
  onClose,
  onGenerate,
  defaultTitle,
  context,
  contextLoading,
  contextError,
}: GenerationConfigModalProps) {
  const t = useTranslations('GenerationConfigModal');
  const currentLocale = useLocale();
  const [title, setTitle] = useState(defaultTitle);
  const [prompt, setPrompt] = useState('');
  const [language, setLanguage] = useState(currentLocale);
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(500);

  // Reset form when modal opens
  useEffect(() => {
    if (isOpen) {
      setTitle(defaultTitle);
      setPrompt('');
      setLanguage(currentLocale);
      setTemperature(0.7);
      setMaxTokens(500);
    }
  }, [isOpen, defaultTitle, currentLocale]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    // Context must be loaded before we can generate
    if (!context) {
      console.error('Cannot generate without context');
      return;
    }

    const trimmedPrompt = prompt.trim();
    onGenerate({
      title,
      ...(trimmedPrompt ? { prompt: trimmedPrompt } : {}),
      language,
      temperature,
      maxTokens,
      context,
    });
    onClose();
  };

  const sourceContext = context?.sourceContext;
  const hasContext = sourceContext && (sourceContext.before || sourceContext.after);
  const graphContext = context?.graphContext;
  const connections = graphContext?.connections ?? [];
  const citedBy = graphContext?.citedBy ?? [];
  const citedByCount = graphContext?.citedByCount ?? 0;
  const siblingEntityTypes = graphContext?.siblingEntityTypes ?? [];
  const entityTypes = context?.metadata?.entityTypes ?? [];

  return (
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog as="div" className="semiont-modal" style={{ zIndex: 1001 }} onClose={onClose}>
        {/* Backdrop */}
        <TransitionChild
          as={Fragment}
          enter="ease-out duration-200"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-150"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="semiont-modal__backdrop" />
        </TransitionChild>

        {/* Modal panel */}
        <div className="semiont-modal__container">
          <div className="semiont-modal__wrapper">
            <TransitionChild
              as={Fragment}
              enter="ease-out duration-200"
              enterFrom="opacity-0 scale-95"
              enterTo="opacity-100 scale-100"
              leave="ease-in duration-150"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-95"
            >
              <DialogPanel className="semiont-modal__panel" style={{ maxWidth: '700px' }}>
                <div className="semiont-modal__header-content" style={{ marginBottom: '1rem' }}>
                  <DialogTitle className="semiont-modal__title">
                    {t('title')}
                  </DialogTitle>
                  <button onClick={onClose} className="semiont-modal__close">
                    ✕
                  </button>
                </div>

                <form onSubmit={handleSubmit} className="semiont-form">
                  {/* Source Context Preview */}
                  <div className="semiont-form__field">
                    <label className="semiont-form__label">
                      {t('sourceContext')}
                    </label>
                    {contextLoading && (
                      <div className="semiont-modal__empty-state" style={{ textAlign: 'center', padding: '1rem 0' }}>
                        {t('loadingContext')}
                      </div>
                    )}
                    {!!contextError && (
                      <div style={{ textAlign: 'center', padding: '1rem 0', color: 'var(--semiont-color-red-600)' }}>
                        {t('failedContext')}
                      </div>
                    )}
                    {hasContext && (
                      <div style={{
                        padding: '0.75rem',
                        backgroundColor: 'var(--semiont-bg-secondary)',
                        borderRadius: 'var(--semiont-radius-md)',
                        border: '1px solid var(--semiont-border-primary)',
                        maxHeight: '200px',
                        overflowY: 'auto',
                      }}>
                        <div style={{ fontSize: 'var(--semiont-text-sm)', fontFamily: 'monospace', whiteSpace: 'pre-wrap', color: 'var(--semiont-text-secondary)' }}>
                          {sourceContext.before && <span>{sourceContext.before}</span>}
                          <span style={{
                            backgroundColor: 'var(--semiont-color-primary-100)',
                            padding: '0 0.25rem',
                            fontWeight: 600,
                            color: 'var(--semiont-color-primary-900)',
                          }}>
                            {sourceContext.selected}
                          </span>
                          {sourceContext.after && <span>{sourceContext.after}</span>}
                        </div>
                      </div>
                    )}
                    <p className="semiont-form__help">
                      {t('contextHelp')}
                    </p>
                  </div>

                  {/* Entity Types */}
                  {entityTypes.length > 0 && (
                    <div className="semiont-form__field">
                      <label className="semiont-form__label">
                        {t('entityTypes')}
                      </label>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem' }}>
                        {entityTypes.map(et => (
                          <span key={et} className="semiont-chip" style={{ fontSize: 'var(--semiont-text-xs)', padding: '0.125rem 0.5rem' }}>
                            {et}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Graph Context */}
                  {graphContext && (connections.length > 0 || citedByCount > 0 || siblingEntityTypes.length > 0) && (
                    <div className="semiont-form__field">
                      <label className="semiont-form__label">
                        {t('graphContext')}
                      </label>
                      <div style={{
                        padding: '0.75rem',
                        backgroundColor: 'var(--semiont-bg-secondary)',
                        borderRadius: 'var(--semiont-radius-md)',
                        border: '1px solid var(--semiont-border-primary)',
                        fontSize: 'var(--semiont-text-sm)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.5rem',
                      }}>
                        {connections.length > 0 && (
                          <div>
                            <span style={{ fontWeight: 500, color: 'var(--semiont-text-secondary)' }}>{t('connections')}</span>
                            <ul style={{ marginTop: '0.25rem', display: 'flex', flexDirection: 'column', gap: '0.125rem', listStyle: 'none', padding: 0 }}>
                              {connections.map(conn => (
                                <li key={conn.resourceId} style={{ color: 'var(--semiont-text-secondary)', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                                  <span>{conn.resourceName}</span>
                                  {conn.bidirectional && (
                                    <span className="semiont-chip" style={{ fontSize: 'var(--semiont-text-xs)', padding: '0.125rem 0.375rem' }}>mutual</span>
                                  )}
                                  {conn.entityTypes && conn.entityTypes.length > 0 && (
                                    <span style={{ fontSize: 'var(--semiont-text-xs)', color: 'var(--semiont-text-tertiary)' }}>
                                      {conn.entityTypes.join(', ')}
                                    </span>
                                  )}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {citedByCount > 0 && (
                          <div>
                            <span style={{ fontWeight: 500, color: 'var(--semiont-text-secondary)' }}>
                              {t('citedBy', { count: citedByCount })}
                            </span>
                            {citedBy.length > 0 && (
                              <ul style={{ marginTop: '0.25rem', display: 'flex', flexDirection: 'column', gap: '0.125rem', listStyle: 'none', padding: 0 }}>
                                {citedBy.map(ref => (
                                  <li key={ref.resourceId} style={{ color: 'var(--semiont-text-secondary)' }}>
                                    {ref.resourceName}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        )}
                        {siblingEntityTypes.length > 0 && (
                          <div>
                            <span style={{ fontWeight: 500, color: 'var(--semiont-text-secondary)' }}>{t('siblingTypes')}</span>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', marginTop: '0.25rem' }}>
                              {siblingEntityTypes.map(et => (
                                <span key={et} className="semiont-chip" style={{ fontSize: 'var(--semiont-text-xs)', padding: '0.125rem 0.5rem' }}>
                                  {et}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Resource Title */}
                  <div className="semiont-form__field">
                    <label htmlFor="title" className="semiont-form__label">
                      {t('resourceTitle')}
                    </label>
                    <input
                      id="title"
                      type="text"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      required
                      className="semiont-input"
                      placeholder={t('resourceTitlePlaceholder')}
                    />
                  </div>

                  {/* Additional Instructions */}
                  <div className="semiont-form__field">
                    <label htmlFor="prompt" className="semiont-form__label">
                      {t('additionalInstructions')}
                    </label>
                    <textarea
                      id="prompt"
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      rows={3}
                      className="semiont-textarea"
                      placeholder={t('additionalInstructionsPlaceholder')}
                    />
                  </div>

                  {/* Language Selection */}
                  <div className="semiont-form__field">
                    <label htmlFor="language" className="semiont-form__label">
                      {t('language')}
                    </label>
                    <select
                      id="language"
                      value={language}
                      onChange={(e) => setLanguage(e.target.value)}
                      className="semiont-select"
                    >
                      {LOCALES.map((lang) => (
                        <option key={lang.code} value={lang.code}>
                          {lang.nativeName}
                        </option>
                      ))}
                    </select>
                    <p className="semiont-form__help">
                      {t('languageHelp')}
                    </p>
                  </div>

                  {/* Temperature Slider */}
                  <div className="semiont-form__field">
                    <label htmlFor="temperature" className="semiont-form__label">
                      {t('creativity', { value: temperature.toFixed(1) })}
                    </label>
                    <input
                      id="temperature"
                      type="range"
                      min="0"
                      max="1"
                      step="0.1"
                      value={temperature}
                      onChange={(e) => setTemperature(parseFloat(e.target.value))}
                      className="semiont-slider"
                    />
                    <div className="semiont-slider__labels">
                      <span>{t('creativityFocused')}</span>
                      <span>{t('creativityCreative')}</span>
                    </div>
                  </div>

                  {/* Max Tokens Input */}
                  <div className="semiont-form__field">
                    <label htmlFor="maxTokens" className="semiont-form__label">
                      {t('maxLength')}
                    </label>
                    <input
                      id="maxTokens"
                      type="number"
                      min="100"
                      max="4000"
                      step="100"
                      value={maxTokens}
                      onChange={(e) => setMaxTokens(parseInt(e.target.value))}
                      className="semiont-input"
                    />
                    <p className="semiont-form__help">
                      {t('maxLengthHelp')}
                    </p>
                  </div>

                  {/* Action Buttons */}
                  <div className="semiont-modal__actions" style={{ paddingTop: '0.5rem' }}>
                    <button
                      type="button"
                      onClick={onClose}
                      className="semiont-button--secondary semiont-button--flex"
                    >
                      {t('cancel')}
                    </button>
                    <button
                      type="submit"
                      disabled={contextLoading || !context}
                      className="semiont-button--gradient semiont-button--flex"
                    >
                      {t('generate')}
                    </button>
                  </div>
                </form>
              </DialogPanel>
            </TransitionChild>
          </div>
        </div>
      </Dialog>
    </Transition>
  );
}
