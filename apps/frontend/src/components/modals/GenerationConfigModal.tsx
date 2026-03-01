'use client';

import React, { useState, useEffect } from 'react';
import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react';
import { useTranslations, useLocale } from 'next-intl';
import type { YieldContext } from '@semiont/core';
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
    context: YieldContext;
  }) => void;
  defaultTitle: string;          // Selected text from reference
  context: YieldContext | null;
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

  return (
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-[1001]" onClose={onClose}>
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
          <div className="fixed inset-0 bg-black/30 backdrop-blur-sm" />
        </TransitionChild>

        {/* Modal panel */}
        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4">
            <TransitionChild
              as={Fragment}
              enter="ease-out duration-200"
              enterFrom="opacity-0 scale-95"
              enterTo="opacity-100 scale-100"
              leave="ease-in duration-150"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-95"
            >
              <DialogPanel className="w-full max-w-[700px] transform overflow-hidden rounded-lg bg-white dark:bg-gray-800 shadow-xl border border-gray-200 dark:border-gray-700 p-6 transition-all">
                <div className="flex items-center justify-between mb-4">
                  <DialogTitle className="text-lg font-semibold text-gray-900 dark:text-white">
                    {t('title')}
                  </DialogTitle>
                  <button
                    onClick={onClose}
                    className="text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-300"
                  >
                    ✕
                  </button>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                  {/* Source Context Preview */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      {t('sourceContext')}
                    </label>
                    {contextLoading && (
                      <div className="text-center py-4 text-gray-600 dark:text-gray-400">
                        {t('loadingContext')}
                      </div>
                    )}
                    {!!contextError && (
                      <div className="text-center py-4 text-red-600 dark:text-red-400">
                        {t('failedContext')}
                      </div>
                    )}
                    {hasContext && (
                      <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 max-h-[200px] overflow-y-auto">
                        <div className="text-sm font-mono whitespace-pre-wrap text-gray-600 dark:text-gray-400">
                          {sourceContext.before && <span>{sourceContext.before}</span>}
                          <span className="bg-blue-100 dark:bg-blue-900/40 px-1 font-semibold text-blue-900 dark:text-blue-200">
                            {sourceContext.selected}
                          </span>
                          {sourceContext.after && <span>{sourceContext.after}</span>}
                        </div>
                      </div>
                    )}
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      {t('contextHelp')}
                    </p>
                  </div>

                  {/* Resource Title */}
                  <div>
                    <label htmlFor="title" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      {t('resourceTitle')}
                    </label>
                    <input
                      id="title"
                      type="text"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      required
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg dark:bg-gray-700 text-gray-900 dark:text-white"
                      placeholder={t('resourceTitlePlaceholder')}
                    />
                  </div>

                  {/* Additional Instructions */}
                  <div>
                    <label htmlFor="prompt" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      {t('additionalInstructions')}
                    </label>
                    <textarea
                      id="prompt"
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      rows={3}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg dark:bg-gray-700 text-gray-900 dark:text-white"
                      placeholder={t('additionalInstructionsPlaceholder')}
                    />
                  </div>

                  {/* Language Selection */}
                  <div>
                    <label htmlFor="language" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      {t('language')}
                    </label>
                    <select
                      id="language"
                      value={language}
                      onChange={(e) => setLanguage(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg dark:bg-gray-700 text-gray-900 dark:text-white"
                    >
                      {LOCALES.map((lang) => (
                        <option key={lang.code} value={lang.code}>
                          {lang.nativeName}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      {t('languageHelp')}
                    </p>
                  </div>

                  {/* Temperature Slider */}
                  <div>
                    <label htmlFor="temperature" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
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
                      className="w-full"
                    />
                    <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mt-1">
                      <span>{t('creativityFocused')}</span>
                      <span>{t('creativityCreative')}</span>
                    </div>
                  </div>

                  {/* Max Tokens Input */}
                  <div>
                    <label htmlFor="maxTokens" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
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
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg dark:bg-gray-700 text-gray-900 dark:text-white"
                    />
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      {t('maxLengthHelp')}
                    </p>
                  </div>

                  {/* Action Buttons */}
                  <div className="flex gap-3 pt-2">
                    <button
                      type="button"
                      onClick={onClose}
                      className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                    >
                      {t('cancel')}
                    </button>
                    <button
                      type="submit"
                      disabled={contextLoading || !context}
                      className="flex-1 px-4 py-2 bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700 text-white rounded-lg font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed"
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
