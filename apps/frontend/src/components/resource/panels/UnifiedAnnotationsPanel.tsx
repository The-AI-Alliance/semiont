'use client';

import React, { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import type { components } from '@semiont/api-client';
import { groupAnnotationsByType, type Annotator, ANNOTATORS } from '@/lib/annotation-registry';
import { HighlightPanel } from './HighlightPanel';
import { ReferencesPanel } from './ReferencesPanel';
import { AssessmentPanel } from './AssessmentPanel';
import { CommentsPanel } from './CommentsPanel';
import { TaggingPanel } from './TaggingPanel';

type Annotation = components['schemas']['Annotation'];
type Motivation = components['schemas']['Motivation'];
type AnnotatorKey = keyof typeof ANNOTATORS;

// Tab display order (controls the order tabs appear in the UI)
const TAB_ORDER: AnnotatorKey[] = ['highlight', 'reference', 'assessment', 'comment', 'tag'];

// Panel component mapping for dynamic rendering
type PanelComponent = React.ComponentType<any>;

const PANEL_COMPONENTS: Record<AnnotatorKey, PanelComponent> = {
  highlight: HighlightPanel,
  reference: ReferencesPanel,
  assessment: AssessmentPanel,
  comment: CommentsPanel,
  tag: TaggingPanel
};

/**
 * Simplified UnifiedAnnotationsPanel using Annotator abstraction
 *
 * Key simplifications:
 * - Single annotations array (grouped internally by motivation)
 * - Single focusedAnnotationId (motivation-agnostic)
 * - Single hoveredAnnotationId (motivation-agnostic)
 * - Annotators contain handlers (no explosion of onXClick, onXHover props)
 */
interface UnifiedAnnotationsPanelProps {
  // All annotations (grouped internally by motivation)
  annotations: Annotation[];

  // Annotators with injected handlers
  annotators: Record<string, Annotator>;

  // Unified state (motivation-agnostic)
  focusedAnnotationId: string | null;
  hoveredAnnotationId?: string | null;

  // Mode
  annotateMode?: boolean;

  // Detection state (per motivation)
  detectingMotivation?: Motivation | null;
  detectionProgress?: {
    status: string;
    percentage?: number;
    message?: string;
    // Tag-specific progress fields
    currentCategory?: string;
    processedCategories?: number;
    totalCategories?: number;
  } | null;

  // Pending selections (for creating new annotations)
  pendingCommentSelection?: {
    exact: string;
    start: number;
    end: number;
  } | null;

  pendingTagSelection?: {
    exact: string;
    start: number;
    end: number;
  } | null;

  // Reference-specific props (TODO: refactor these into annotator handlers)
  allEntityTypes?: string[];
  generatingReferenceId?: string | null;
  mediaType?: string;
  referencedBy?: any[];
  referencedByLoading?: boolean;

  // Resource context
  resourceId?: string;
  initialTab?: AnnotatorKey;
}

/**
 * Adapter function to convert unified props to panel-specific prop names
 * Each panel has different prop naming conventions (highlights vs assessments vs tags, etc.)
 * This function maps the generic props to the specific names each panel expects
 */
function getPanelSpecificProps(
  key: AnnotatorKey,
  props: UnifiedAnnotationsPanelProps,
  grouped: Record<string, Annotation[]>
): any {
  const annotator = props.annotators[key];
  if (!annotator) return {};

  const baseProps = {
    focusedAnnotationId: props.focusedAnnotationId,
    hoveredAnnotationId: props.hoveredAnnotationId,
    annotateMode: props.annotateMode,
    isDetecting: props.detectingMotivation === annotator.motivation,
    detectionProgress: props.detectingMotivation === annotator.motivation ? props.detectionProgress : null
  };

  switch (key) {
    case 'highlight':
      return {
        highlights: grouped.highlight || [],
        onHighlightClick: annotator.handlers?.onClick || (() => {}),
        focusedHighlightId: props.focusedAnnotationId,
        hoveredHighlightId: props.hoveredAnnotationId ?? null,
        ...(annotator.handlers?.onHover ? { onHighlightHover: annotator.handlers.onHover } : {}),
        ...(annotator.handlers?.onDetect ? { onDetectHighlights: annotator.handlers.onDetect } : {}),
        ...(baseProps.isDetecting ? { isDetecting: true } : {}),
        ...(baseProps.detectionProgress ? { detectionProgress: baseProps.detectionProgress } : {}),
        ...(props.annotateMode !== undefined ? { annotateMode: props.annotateMode } : {})
      };

    case 'reference':
      return {
        allEntityTypes: props.allEntityTypes || [],
        isDetecting: baseProps.isDetecting,
        detectionProgress: baseProps.detectionProgress,
        onDetect: annotator.handlers?.onDetect || (() => {}),
        onCancelDetection: () => {}, // TODO: add to handlers
        references: grouped.reference || [],
        ...(annotator.handlers?.onClick ? { onReferenceClick: annotator.handlers.onClick } : {}),
        ...(props.focusedAnnotationId ? { focusedReferenceId: props.focusedAnnotationId } : {}),
        hoveredReferenceId: props.hoveredAnnotationId ?? null,
        ...(annotator.handlers?.onHover ? { onReferenceHover: annotator.handlers.onHover } : {}),
        ...(annotator.handlers?.onCreate ? { onGenerateDocument: annotator.handlers.onCreate } : {}),
        ...(props.annotateMode !== undefined ? { annotateMode: props.annotateMode } : {}),
        ...(props.mediaType ? { mediaType: props.mediaType } : {}),
        ...(props.referencedBy ? { referencedBy: props.referencedBy } : {}),
        ...(props.referencedByLoading !== undefined ? { referencedByLoading: props.referencedByLoading } : {})
      };

    case 'assessment':
      return {
        assessments: grouped.assessment || [],
        onAssessmentClick: annotator.handlers?.onClick || (() => {}),
        focusedAssessmentId: props.focusedAnnotationId,
        hoveredAssessmentId: props.hoveredAnnotationId ?? null,
        ...(annotator.handlers?.onHover ? { onAssessmentHover: annotator.handlers.onHover } : {}),
        ...(annotator.handlers?.onDetect ? { onDetectAssessments: annotator.handlers.onDetect } : {}),
        ...(baseProps.isDetecting ? { isDetecting: true } : {}),
        ...(baseProps.detectionProgress ? { detectionProgress: baseProps.detectionProgress } : {}),
        ...(props.annotateMode !== undefined ? { annotateMode: props.annotateMode } : {})
      };

    case 'comment':
      if (!annotator.handlers?.onUpdate) return null;
      return {
        comments: grouped.comment || [],
        onCommentClick: annotator.handlers.onClick || (() => {}),
        onUpdateComment: annotator.handlers.onUpdate,
        ...(annotator.handlers.onCreate ? { onCreateComment: annotator.handlers.onCreate } : {}),
        focusedCommentId: props.focusedAnnotationId,
        hoveredCommentId: props.hoveredAnnotationId ?? null,
        ...(annotator.handlers.onHover ? { onCommentHover: annotator.handlers.onHover } : {}),
        ...(props.pendingCommentSelection ? { pendingSelection: props.pendingCommentSelection } : {}),
        ...(props.annotateMode !== undefined ? { annotateMode: props.annotateMode } : {}),
        ...(annotator.handlers.onDetect ? { onDetectComments: annotator.handlers.onDetect } : {}),
        ...(baseProps.isDetecting ? { isDetecting: true } : {}),
        ...(baseProps.detectionProgress ? { detectionProgress: baseProps.detectionProgress } : {})
      };

    case 'tag':
      return {
        tags: grouped.tag || [],
        onTagClick: annotator.handlers?.onClick || (() => {}),
        focusedTagId: props.focusedAnnotationId,
        hoveredTagId: props.hoveredAnnotationId ?? null,
        ...(annotator.handlers?.onHover ? { onTagHover: annotator.handlers.onHover } : {}),
        ...(props.annotateMode !== undefined ? { annotateMode: props.annotateMode } : {}),
        ...(annotator.handlers?.onDetect ? { onDetectTags: annotator.handlers.onDetect } : {}),
        ...(annotator.handlers?.onCreate ? { onCreateTag: annotator.handlers.onCreate } : {}),
        ...(baseProps.isDetecting ? { isDetecting: true } : {}),
        ...(baseProps.detectionProgress ? { detectionProgress: baseProps.detectionProgress } : {}),
        ...(props.pendingTagSelection ? { pendingSelection: props.pendingTagSelection } : {})
      };

    default:
      return {};
  }
}

export function UnifiedAnnotationsPanel(props: UnifiedAnnotationsPanelProps) {
  const t = useTranslations('UnifiedAnnotationsPanel');

  // Group annotations by type
  const grouped = groupAnnotationsByType(props.annotations);

  // Load tab from localStorage (per-resource)
  const [activeTab, setActiveTab] = useState<AnnotatorKey>(() => {
    if (typeof window === 'undefined') return props.initialTab || 'highlight';

    const storageKey = props.resourceId
      ? `annotations-tab-${props.resourceId}`
      : 'annotations-tab-global';

    const stored = localStorage.getItem(storageKey);
    if (stored && TAB_ORDER.includes(stored as AnnotatorKey)) {
      return stored as AnnotatorKey;
    }

    return props.initialTab || 'highlight';
  });

  // Persist tab selection
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const storageKey = props.resourceId
      ? `annotations-tab-${props.resourceId}`
      : 'annotations-tab-global';

    localStorage.setItem(storageKey, activeTab);
  }, [activeTab, props.resourceId]);

  const handleTabClick = (tab: AnnotatorKey) => {
    setActiveTab(tab);
  };

  // Tab button styling
  const tabButtonClass = (tab: AnnotatorKey) => {
    const isActive = activeTab === tab;
    return `
      px-3 py-1.5 text-sm font-medium rounded-md transition-colors
      ${isActive
        ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
        : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
      }
    `.trim();
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-900">
      {/* Tab Navigation */}
      <div className="flex flex-wrap gap-1 p-2 border-b border-gray-200 dark:border-gray-700">
        {TAB_ORDER.map(key => {
          const annotator = props.annotators[key];
          if (!annotator) return null;

          const count = grouped[key]?.length || 0;

          return (
            <button
              key={key}
              onClick={() => handleTabClick(key)}
              className={tabButtonClass(key)}
              aria-pressed={activeTab === key}
            >
              {annotator.iconEmoji} {t(key)} ({count})
            </button>
          );
        })}
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-hidden">
        {(() => {
          const PanelComponent = PANEL_COMPONENTS[activeTab];
          const annotator = props.annotators[activeTab];
          const panelProps = getPanelSpecificProps(activeTab, props, grouped);

          if (!PanelComponent || !annotator || !panelProps) return null;

          return <PanelComponent {...panelProps} />;
        })()}
      </div>
    </div>
  );
}
