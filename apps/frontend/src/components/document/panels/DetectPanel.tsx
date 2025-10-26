'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { DetectionProgressWidget } from '@/components/DetectionProgressWidget';

interface DetectionLog {
  entityType: string;
  foundCount: number;
}

interface Props {
  allEntityTypes: string[];
  isDetecting: boolean;
  detectionProgress: any; // TODO: type this properly
  onDetect: (selectedTypes: string[]) => void;
  onCancelDetection: () => void;
}

export function DetectPanel({
  allEntityTypes,
  isDetecting,
  detectionProgress,
  onDetect,
  onCancelDetection
}: Props) {
  const t = useTranslations('DetectPanel');
  const [selectedEntityTypes, setSelectedEntityTypes] = useState<string[]>([]);
  const [lastDetectionLog, setLastDetectionLog] = useState<DetectionLog[] | null>(null);

  // Clear log when starting new detection
  const handleDetect = () => {
    setLastDetectionLog(null);
    onDetect(selectedEntityTypes);
  };

  // When detection completes, save log
  React.useEffect(() => {
    if (!isDetecting && detectionProgress?.completedEntityTypes) {
      setLastDetectionLog(detectionProgress.completedEntityTypes);
      setSelectedEntityTypes([]);
    }
  }, [isDetecting, detectionProgress]);

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-2xl">🔵</span>
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
          {t('title')}
        </h3>
      </div>

      {/* Show annotation UI only when not detecting and no completed log */}
      {!detectionProgress && !lastDetectionLog && (
        <>
          {/* Entity Types Selection */}
          <div className="mb-4">
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {t('selectEntityTypes')}
            </p>
            <div className="flex flex-wrap gap-2">
              {allEntityTypes.length > 0 ? (
                allEntityTypes.map((type: string) => (
                  <button
                    key={type}
                    onClick={() => {
                      setSelectedEntityTypes(prev =>
                        prev.includes(type)
                          ? prev.filter(t => t !== type)
                          : [...prev, type]
                      );
                    }}
                    aria-pressed={selectedEntityTypes.includes(type)}
                    aria-label={`${selectedEntityTypes.includes(type) ? t('deselect') : t('select')} ${type}`}
                    className={`px-3 py-1 text-sm rounded-full transition-colors border focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                      selectedEntityTypes.includes(type)
                        ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-300 dark:border-blue-700'
                        : 'bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700'
                    }`}
                  >
                    {type}
                  </button>
                ))
              ) : (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {t('noEntityTypes')}
                </p>
              )}
            </div>
          </div>

          {/* Selected Count */}
          {selectedEntityTypes.length > 0 && (
            <p className="text-xs text-gray-500 dark:text-gray-400 text-center mb-4">
              {t('typesSelected', { count: selectedEntityTypes.length })}
            </p>
          )}

          {/* Start Detection Button */}
          <button
            onClick={handleDetect}
            disabled={selectedEntityTypes.length === 0}
            className={`w-full px-4 py-2 rounded-lg transition-colors duration-200 font-medium ${
              selectedEntityTypes.length > 0
                ? 'bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700 text-white shadow-md hover:shadow-lg'
                : 'bg-gray-200 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed'
            }`}
          >
            ✨ {t('startDetection')}
          </button>
        </>
      )}

      {/* Detection Progress - shown when active */}
      {detectionProgress && (
        <div className="mt-4">
          <DetectionProgressWidget
            progress={detectionProgress}
            onCancel={onCancelDetection}
          />
        </div>
      )}

      {/* Completed detection log - shown after completion */}
      {!detectionProgress && lastDetectionLog && lastDetectionLog.length > 0 && (
        <div className="space-y-3">
          <div className="space-y-1">
            {lastDetectionLog.map((item, index) => (
              <div key={index} className="text-xs text-gray-600 dark:text-gray-400 flex items-center gap-2">
                <span className="text-green-600 dark:text-green-400">✓</span>
                <span className="font-medium">{item.entityType}:</span>
                <span>{t('found', { count: item.foundCount })}</span>
              </div>
            ))}
          </div>
          <button
            onClick={() => setLastDetectionLog(null)}
            className="w-full px-4 py-2 rounded-lg transition-colors duration-200 font-medium bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700 text-white shadow-md hover:shadow-lg"
          >
            {t('more')}
          </button>
        </div>
      )}
    </div>
  );
}
