'use client';

import React, { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import type { components } from '@semiont/api-client';
import { groupAnnotationsByType, type Annotator } from '@/lib/annotation-registry';
import { HighlightPanel } from './HighlightPanel';
import { ReferencesPanel } from './ReferencesPanel';
import { AssessmentPanel } from './AssessmentPanel';
import { CommentsPanel } from './CommentsPanel';
import { TaggingPanel } from './TaggingPanel';

type Annotation = components['schemas']['Annotation'];

type AnnotationType = 'highlights' | 'references' | 'assessments' | 'comments' | 'tags';

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
  detectingMotivation?: string | null;
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
  initialTab?: AnnotationType;
}

export function UnifiedAnnotationsPanel(props: UnifiedAnnotationsPanelProps) {
  const t = useTranslations('UnifiedAnnotationsPanel');

  // Group annotations by type
  const grouped = groupAnnotationsByType(props.annotations);

  // Load tab from localStorage (per-resource)
  const [activeTab, setActiveTab] = useState<AnnotationType>(() => {
    if (typeof window === 'undefined') return props.initialTab || 'highlights';

    const storageKey = props.resourceId
      ? `annotations-tab-${props.resourceId}`
      : 'annotations-tab-global';

    const stored = localStorage.getItem(storageKey);
    if (stored && ['highlights', 'references', 'assessments', 'comments', 'tags'].includes(stored)) {
      return stored as AnnotationType;
    }

    return props.initialTab || 'highlights';
  });

  // Persist tab selection
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const storageKey = props.resourceId
      ? `annotations-tab-${props.resourceId}`
      : 'annotations-tab-global';

    localStorage.setItem(storageKey, activeTab);
  }, [activeTab, props.resourceId]);

  const handleTabClick = (tab: AnnotationType) => {
    setActiveTab(tab);
  };

  // Tab button styling
  const tabButtonClass = (tab: AnnotationType) => {
    const isActive = activeTab === tab;
    return `
      px-3 py-1.5 text-sm font-medium rounded-md transition-colors
      ${isActive
        ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
        : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
      }
    `.trim();
  };

  // Get annotators for each type
  const highlightAnnotator = props.annotators.highlight;
  const referenceAnnotator = props.annotators.reference;
  const assessmentAnnotator = props.annotators.assessment;
  const commentAnnotator = props.annotators.comment;
  const tagAnnotator = props.annotators.tag;

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-900">
      {/* Tab Navigation */}
      <div className="flex flex-wrap gap-1 p-2 border-b border-gray-200 dark:border-gray-700">
        <button
          onClick={() => handleTabClick('highlights')}
          className={tabButtonClass('highlights')}
          aria-pressed={activeTab === 'highlights'}
        >
          {highlightAnnotator?.iconEmoji || '🟡'} {t('highlights')} ({grouped.highlight?.length || 0})
        </button>
        <button
          onClick={() => handleTabClick('references')}
          className={tabButtonClass('references')}
          aria-pressed={activeTab === 'references'}
        >
          {referenceAnnotator?.iconEmoji || '🔵'} {t('references')} ({grouped.reference?.length || 0})
        </button>
        <button
          onClick={() => handleTabClick('assessments')}
          className={tabButtonClass('assessments')}
          aria-pressed={activeTab === 'assessments'}
        >
          {assessmentAnnotator?.iconEmoji || '🔴'} {t('assessments')} ({grouped.assessment?.length || 0})
        </button>
        <button
          onClick={() => handleTabClick('comments')}
          className={tabButtonClass('comments')}
          aria-pressed={activeTab === 'comments'}
        >
          {commentAnnotator?.iconEmoji || '💬'} {t('comments')} ({grouped.comment?.length || 0})
        </button>
        <button
          onClick={() => handleTabClick('tags')}
          className={tabButtonClass('tags')}
          aria-pressed={activeTab === 'tags'}
        >
          {tagAnnotator?.iconEmoji || '🏷️'} {t('tags')} ({grouped.tag?.length || 0})
        </button>
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'highlights' && (
          <HighlightPanel
            highlights={grouped.highlight || []}
            onHighlightClick={highlightAnnotator?.handlers?.onClick || (() => {})}
            focusedHighlightId={props.focusedAnnotationId}
            hoveredHighlightId={props.hoveredAnnotationId ?? null}
            {...(highlightAnnotator?.handlers?.onHover ? { onHighlightHover: highlightAnnotator.handlers.onHover } : {})}
            {...(highlightAnnotator?.handlers?.onDetect ? { onDetectHighlights: highlightAnnotator.handlers.onDetect } : {})}
            {...(props.detectingMotivation === 'highlighting' ? { isDetecting: true } : {})}
            {...(props.detectingMotivation === 'highlighting' && props.detectionProgress ? { detectionProgress: props.detectionProgress } : {})}
            {...(props.annotateMode !== undefined ? { annotateMode: props.annotateMode } : {})}
          />
        )}

        {activeTab === 'references' && (
          <ReferencesPanel
            allEntityTypes={props.allEntityTypes || []}
            isDetecting={props.detectingMotivation === 'linking'}
            detectionProgress={props.detectionProgress}
            onDetect={referenceAnnotator?.handlers?.onDetect || (() => {})}
            onCancelDetection={() => {}} // TODO: add to handlers
            references={grouped.reference || []}
            {...(referenceAnnotator?.handlers?.onClick ? { onReferenceClick: referenceAnnotator.handlers.onClick } : {})}
            {...(props.focusedAnnotationId ? { focusedReferenceId: props.focusedAnnotationId } : {})}
            hoveredReferenceId={props.hoveredAnnotationId ?? null}
            {...(referenceAnnotator?.handlers?.onHover ? { onReferenceHover: referenceAnnotator.handlers.onHover } : {})}
            {...(referenceAnnotator?.handlers?.onCreate ? { onGenerateDocument: referenceAnnotator.handlers.onCreate } : {})}
            {...(props.annotateMode !== undefined ? { annotateMode: props.annotateMode } : {})}
            {...(props.mediaType ? { mediaType: props.mediaType } : {})}
            {...(props.referencedBy ? { referencedBy: props.referencedBy } : {})}
            {...(props.referencedByLoading !== undefined ? { referencedByLoading: props.referencedByLoading } : {})}
          />
        )}

        {activeTab === 'assessments' && (
          <AssessmentPanel
            assessments={grouped.assessment || []}
            onAssessmentClick={assessmentAnnotator?.handlers?.onClick || (() => {})}
            focusedAssessmentId={props.focusedAnnotationId}
            hoveredAssessmentId={props.hoveredAnnotationId ?? null}
            {...(assessmentAnnotator?.handlers?.onHover ? { onAssessmentHover: assessmentAnnotator.handlers.onHover } : {})}
            {...(assessmentAnnotator?.handlers?.onDetect ? { onDetectAssessments: assessmentAnnotator.handlers.onDetect } : {})}
            {...(props.detectingMotivation === 'assessing' ? { isDetecting: true } : {})}
            {...(props.detectingMotivation === 'assessing' && props.detectionProgress ? { detectionProgress: props.detectionProgress } : {})}
            {...(props.annotateMode !== undefined ? { annotateMode: props.annotateMode } : {})}
          />
        )}

        {activeTab === 'comments' && commentAnnotator?.handlers?.onUpdate && (
          <CommentsPanel
            comments={grouped.comment || []}
            onCommentClick={commentAnnotator.handlers.onClick || (() => {})}
            onUpdateComment={commentAnnotator.handlers.onUpdate}
            {...(commentAnnotator.handlers.onCreate ? { onCreateComment: commentAnnotator.handlers.onCreate } : {})}
            focusedCommentId={props.focusedAnnotationId}
            hoveredCommentId={props.hoveredAnnotationId ?? null}
            {...(commentAnnotator.handlers.onHover ? { onCommentHover: commentAnnotator.handlers.onHover } : {})}
            {...(props.pendingCommentSelection ? { pendingSelection: props.pendingCommentSelection } : {})}
            {...(props.annotateMode !== undefined ? { annotateMode: props.annotateMode } : {})}
            {...(commentAnnotator.handlers.onDetect ? { onDetectComments: commentAnnotator.handlers.onDetect } : {})}
            {...(props.detectingMotivation === 'commenting' ? { isDetecting: true } : {})}
            {...(props.detectingMotivation === 'commenting' && props.detectionProgress ? { detectionProgress: props.detectionProgress } : {})}
          />
        )}

        {activeTab === 'tags' && (
          <TaggingPanel
            tags={grouped.tag || []}
            onTagClick={tagAnnotator?.handlers?.onClick || (() => {})}
            focusedTagId={props.focusedAnnotationId}
            hoveredTagId={props.hoveredAnnotationId ?? null}
            {...(tagAnnotator?.handlers?.onHover ? { onTagHover: tagAnnotator.handlers.onHover } : {})}
            {...(props.annotateMode !== undefined ? { annotateMode: props.annotateMode } : {})}
            {...(tagAnnotator?.handlers?.onDetect ? { onDetectTags: tagAnnotator.handlers.onDetect } : {})}
            {...(tagAnnotator?.handlers?.onCreate ? { onCreateTag: tagAnnotator.handlers.onCreate } : {})}
            {...(props.detectingMotivation === 'tagging' ? { isDetecting: true } : {})}
            {...(props.detectingMotivation === 'tagging' && props.detectionProgress ? { detectionProgress: props.detectionProgress } : {})}
            {...(props.pendingTagSelection ? { pendingSelection: props.pendingTagSelection } : {})}
          />
        )}
      </div>
    </div>
  );
}
