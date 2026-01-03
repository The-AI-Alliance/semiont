'use client';

import React, { useState, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { ANNOTATORS } from '../../lib/annotation-registry';

export type SelectionMotivation = 'linking' | 'highlighting' | 'assessing' | 'commenting' | 'tagging';
export type ClickAction = 'detail' | 'follow' | 'jsonld' | 'deleting';
export type ShapeType = 'rectangle' | 'circle' | 'polygon';

// Helper to get emoji from registry by motivation (with fallback for safety)
const getMotivationEmoji = (motivation: SelectionMotivation): string => {
  // Find annotator by motivation
  const annotator = Object.values(ANNOTATORS).find(a => a.motivation === motivation);
  return annotator?.iconEmoji || '❓';
};

interface AnnotateToolbarProps {
  selectedMotivation: SelectionMotivation | null;
  selectedClick: ClickAction;
  onSelectionChange: (motivation: SelectionMotivation | null) => void;
  onClickChange: (motivation: ClickAction) => void;
  showSelectionGroup?: boolean;
  showDeleteButton?: boolean;
  showShapeGroup?: boolean;
  selectedShape?: ShapeType;
  onShapeChange?: (shape: ShapeType) => void;

  // Mode props
  annotateMode: boolean;
  onAnnotateModeToggle: () => void;
}

interface DropdownGroupProps {
  label: string;
  collapsedContent: React.ReactNode;
  expandedContent: React.ReactNode;
  isExpanded: boolean;
  onHoverChange: (hovering: boolean) => void;
  onPin: () => void;
  containerRef: React.RefObject<HTMLDivElement>;
}

function DropdownGroup({
  label,
  collapsedContent,
  expandedContent,
  isExpanded,
  onHoverChange,
  onPin,
  containerRef,
}: DropdownGroupProps) {
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Keyboard navigation
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onPin();
    }
  };

  return (
    <div
      className="relative"
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
    >
      <div
        ref={containerRef}
        role="button"
        tabIndex={0}
        aria-haspopup="true"
        aria-expanded={isExpanded}
        aria-label={label}
        className="flex items-center gap-2 cursor-pointer px-3 py-1.5 rounded-md transition-all hover:bg-blue-100/80 dark:hover:bg-blue-900/30 hover:border-blue-400 dark:hover:border-blue-600 border border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
        onClick={onPin}
        onKeyDown={handleKeyDown}
      >
        {/* Always show collapsed content */}
        {collapsedContent}
      </div>

      {/* Expanded menu appears as dropdown below */}
      {isExpanded && (
        <div
          ref={dropdownRef}
          role="menu"
          aria-orientation="vertical"
          className="absolute top-full left-0 pt-2 z-50"
        >
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-2 min-w-max flex flex-col gap-1">
            <div className="text-xs font-semibold text-gray-600 dark:text-gray-300 uppercase tracking-wider px-2 py-1 border-b border-gray-200 dark:border-gray-700">
              {label}
            </div>
            {expandedContent}
          </div>
        </div>
      )}
    </div>
  );
}

export function AnnotateToolbar({
  selectedMotivation,
  selectedClick,
  onSelectionChange,
  onClickChange,
  showSelectionGroup = true,
  showDeleteButton = true,
  showShapeGroup = false,
  selectedShape = 'rectangle',
  onShapeChange,
  annotateMode = false,
  onAnnotateModeToggle
}: AnnotateToolbarProps) {
  const t = useTranslations('AnnotateToolbar');

  // State for each group
  const [modeHovered, setModeHovered] = useState(false);
  const [modePinned, setModePinned] = useState(false);
  const [clickHovered, setClickHovered] = useState(false);
  const [clickPinned, setClickPinned] = useState(false);
  const [selectionHovered, setSelectionHovered] = useState(false);
  const [selectionPinned, setSelectionPinned] = useState(false);
  const [shapeHovered, setShapeHovered] = useState(false);
  const [shapePinned, setShapePinned] = useState(false);

  // Refs for each group
  const modeRef = useRef<HTMLDivElement>(null);
  const clickRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef<HTMLDivElement>(null);
  const shapeRef = useRef<HTMLDivElement>(null);

  // Expanded state = hover OR pinned
  const modeExpanded = modeHovered || modePinned;
  const clickExpanded = clickHovered || clickPinned;
  const selectionExpanded = selectionHovered || selectionPinned;
  const shapeExpanded = shapeHovered || shapePinned;

  // Click outside handler
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (modePinned && modeRef.current && !modeRef.current.contains(event.target as Node)) {
        setModePinned(false);
      }
      if (clickPinned && clickRef.current && !clickRef.current.contains(event.target as Node)) {
        setClickPinned(false);
      }
      if (selectionPinned && selectionRef.current && !selectionRef.current.contains(event.target as Node)) {
        setSelectionPinned(false);
      }
      if (shapePinned && shapeRef.current && !shapeRef.current.contains(event.target as Node)) {
        setShapePinned(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [modePinned, clickPinned, selectionPinned, shapePinned]);

  // Escape key handler
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setModePinned(false);
        setClickPinned(false);
        setSelectionPinned(false);
        setShapePinned(false);
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, []);

  const handleSelectionClick = (motivation: SelectionMotivation | null) => {
    // If null is clicked, always deselect. Otherwise toggle.
    if (motivation === null) {
      onSelectionChange(null);
    } else {
      onSelectionChange(selectedMotivation === motivation ? null : motivation);
    }
    // Close dropdown after selection
    setSelectionPinned(false);
    setSelectionHovered(false);
  };

  const handleClickClick = (action: ClickAction) => {
    onClickChange(action);
    // Close dropdown after selection
    setClickPinned(false);
    setClickHovered(false);
  };

  const handleShapeClick = (shape: ShapeType) => {
    if (onShapeChange) {
      onShapeChange(shape);
    }
    // Close dropdown after selection
    setShapePinned(false);
    setShapeHovered(false);
  };

  const handleModeToggle = () => {
    onAnnotateModeToggle();
    setModePinned(false);
    setModeHovered(false);
  };

  const handleBrowseClick = () => {
    if (annotateMode) {
      handleModeToggle();
    }
  };

  const handleAnnotateClick = () => {
    if (!annotateMode) {
      handleModeToggle();
    }
  };

  // Render button with icon and label
  const renderButton = (
    icon: string,
    label: string,
    isSelected: boolean,
    onClick: () => void,
    isDelete: boolean = false
  ) => {
    const baseClasses = 'px-2 py-1 rounded-md transition-all flex items-center gap-1.5 font-medium border-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 text-left whitespace-nowrap';

    let classes = baseClasses;
    if (isDelete) {
      classes += isSelected
        ? ' bg-red-600 dark:bg-red-800 text-white dark:text-red-50'
        : ' text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/20';
    } else {
      classes += isSelected
        ? ' bg-gray-300 dark:bg-gray-700 text-gray-900 dark:text-gray-100'
        : ' text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800';
    }

    return (
      <button
        role="menuitem"
        onClick={(e) => {
          e.stopPropagation(); // Prevent click from bubbling to parent container
          onClick();
        }}
        className={classes}
        aria-pressed={isSelected}
        aria-label={label}
      >
        <span className="text-lg" aria-hidden="true">{icon}</span>
        <span className="text-sm">{label}</span>
      </button>
    );
  };

  // Click actions data
  const clickActions: Array<{ action: ClickAction; icon: string; label: string; isDelete?: boolean }> = [
    { action: 'detail', icon: '🔍', label: t('detail') },
    { action: 'follow', icon: '➡️', label: t('follow') },
    { action: 'jsonld', icon: '🌐', label: t('jsonld') },
  ];

  if (showDeleteButton) {
    clickActions.push({ action: 'deleting', icon: '🗑️', label: t('deleting'), isDelete: true });
  }

  // Selection motivations data
  const selectionMotivations: Array<{ motivation: SelectionMotivation; label: string }> = [
    { motivation: 'linking', label: t('linking') },
    { motivation: 'highlighting', label: t('highlighting') },
    { motivation: 'assessing', label: t('assessing') },
    { motivation: 'commenting', label: t('commenting') },
    { motivation: 'tagging', label: t('tagging') },
  ];

  // Shape types data
  const shapeTypes: Array<{ shape: ShapeType; icon: string; label: string }> = [
    { shape: 'rectangle', icon: '▭', label: t('rectangle') },
    { shape: 'circle', icon: '○', label: t('circle') },
    { shape: 'polygon', icon: '⬡', label: t('polygon') },
  ];

  return (
    <div className="flex items-center gap-3 p-3 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
      {/* Click Group */}
      <DropdownGroup
        label={t('clickGroup')}
        isExpanded={clickExpanded}
        onHoverChange={setClickHovered}
        onPin={() => setClickPinned(!clickPinned)}
        containerRef={clickRef}
        collapsedContent={
          <div className="flex items-center gap-2">
            <span className="text-lg">
              {clickActions.find(a => a.action === selectedClick)?.icon}
            </span>
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              {clickActions.find(a => a.action === selectedClick)?.label}
            </span>
          </div>
        }
        expandedContent={
          <>
            {clickActions.map(({ action, icon, label, isDelete }) => (
              <React.Fragment key={action}>
                {renderButton(icon, label, selectedClick === action, () => handleClickClick(action), isDelete)}
              </React.Fragment>
            ))}
          </>
        }
      />

      {/* Separator */}
      <div className="h-8 w-px bg-gray-300 dark:bg-gray-600" />

      {/* Mode Group */}
      <DropdownGroup
        label={t('modeGroup')}
        isExpanded={modeExpanded}
        onHoverChange={setModeHovered}
        onPin={() => setModePinned(!modePinned)}
        containerRef={modeRef}
        collapsedContent={
          <div className="flex items-center gap-2">
            <span className="text-lg">{annotateMode ? '✏️' : '📖'}</span>
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              {annotateMode ? t('annotate') : t('browse')}
            </span>
          </div>
        }
        expandedContent={
          <>
            {renderButton('📖', t('browse'), !annotateMode, handleBrowseClick)}
            {renderButton('✏️', t('annotate'), annotateMode, handleAnnotateClick)}
          </>
        }
      />

      {/* Separator */}
      {showSelectionGroup && <div className="h-8 w-px bg-gray-300 dark:bg-gray-600" />}

      {/* Selection Group */}
      {showSelectionGroup && (
        <DropdownGroup
          label={t('selectionGroup')}
          isExpanded={selectionExpanded}
          onHoverChange={setSelectionHovered}
          onPin={() => setSelectionPinned(!selectionPinned)}
          containerRef={selectionRef}
          collapsedContent={
            <div className="flex items-center gap-2">
              <span className="text-lg">{selectedMotivation ? getMotivationEmoji(selectedMotivation) : '—'}</span>
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {selectedMotivation
                  ? selectionMotivations.find(m => m.motivation === selectedMotivation)?.label
                  : t('none')
                }
              </span>
            </div>
          }
          expandedContent={
            <>
              {/* None option to deselect */}
              {renderButton(
                '—',
                t('none'),
                selectedMotivation === null,
                () => handleSelectionClick(null)
              )}
              {selectionMotivations.map(({ motivation, label }) => (
                <React.Fragment key={motivation}>
                  {renderButton(
                    getMotivationEmoji(motivation),
                    label,
                    selectedMotivation === motivation,
                    () => handleSelectionClick(motivation)
                  )}
                </React.Fragment>
              ))}
            </>
          }
        />
      )}

      {/* Separator */}
      {showShapeGroup && <div className="h-8 w-px bg-gray-300 dark:bg-gray-600" />}

      {/* Shape Group */}
      {showShapeGroup && (
        <DropdownGroup
          label={t('shapeGroup')}
          isExpanded={shapeExpanded}
          onHoverChange={setShapeHovered}
          onPin={() => setShapePinned(!shapePinned)}
          containerRef={shapeRef}
          collapsedContent={
            <div className="flex items-center gap-2">
              <span className="text-lg">
                {shapeTypes.find(s => s.shape === selectedShape)?.icon}
              </span>
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {shapeTypes.find(s => s.shape === selectedShape)?.label}
              </span>
            </div>
          }
          expandedContent={
            <>
              {shapeTypes.map(({ shape, icon, label }) => (
                <React.Fragment key={shape}>
                  {renderButton(icon, label, selectedShape === shape, () => handleShapeClick(shape))}
                </React.Fragment>
              ))}
            </>
          }
        />
      )}
    </div>
  );
}
