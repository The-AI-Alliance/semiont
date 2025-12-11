'use client';

import React, { useState, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { ANNOTATORS } from '@/lib/annotation-registry';

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
}

interface DropdownGroupProps {
  label: string;
  collapsedContent: React.ReactNode;
  expandedContent: React.ReactNode;
  isExpanded: boolean;
  isPinned: boolean;
  onHoverChange: (hovering: boolean) => void;
  onPin: () => void;
  containerRef: React.RefObject<HTMLDivElement>;
}

function DropdownGroup({
  label,
  collapsedContent,
  expandedContent,
  isExpanded,
  isPinned,
  onHoverChange,
  onPin,
  containerRef,
}: DropdownGroupProps) {
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropUp, setDropUp] = useState(false);

  // Calculate if we should drop up or down based on available space
  useEffect(() => {
    if (isExpanded && dropdownRef.current && containerRef.current) {
      const dropdownRect = dropdownRef.current.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      const spaceBelow = viewportHeight - dropdownRect.bottom;
      const spaceAbove = dropdownRect.top;

      // If not enough space below and more space above, drop up
      setDropUp(spaceBelow < 200 && spaceAbove > spaceBelow);
    }
  }, [isExpanded, containerRef]);

  return (
    <div
      ref={containerRef}
      className="relative flex items-center gap-2 cursor-pointer px-3 py-1.5 rounded-md transition-all hover:bg-blue-100/80 dark:hover:bg-blue-900/30 hover:border-blue-400 dark:hover:border-blue-600 border border-transparent"
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
      onClick={onPin}
    >
      {/* Group label - always visible */}
      <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
        {label}
      </span>

      {/* Selected value or expanded menu */}
      {!isExpanded ? (
        // Collapsed: show selected value
        collapsedContent
      ) : (
        // Expanded: show dropdown menu replacing selected value
        <div
          ref={dropdownRef}
          className={`absolute ${dropUp ? 'bottom-full mb-1' : 'top-full mt-1'} left-0 z-50 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg shadow-lg py-1 min-w-max`}
        >
          {expandedContent}
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
  onShapeChange
}: AnnotateToolbarProps) {
  const t = useTranslations('AnnotateToolbar');

  // State for each group
  const [clickHovered, setClickHovered] = useState(false);
  const [clickPinned, setClickPinned] = useState(false);
  const [selectionHovered, setSelectionHovered] = useState(false);
  const [selectionPinned, setSelectionPinned] = useState(false);
  const [shapeHovered, setShapeHovered] = useState(false);
  const [shapePinned, setShapePinned] = useState(false);

  // Refs for each group
  const clickRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef<HTMLDivElement>(null);
  const shapeRef = useRef<HTMLDivElement>(null);

  // Expanded state = hover OR pinned
  const clickExpanded = clickHovered || clickPinned;
  const selectionExpanded = selectionHovered || selectionPinned;
  const shapeExpanded = shapeHovered || shapePinned;

  // Click outside handler
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
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
  }, [clickPinned, selectionPinned, shapePinned]);

  // Escape key handler
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setClickPinned(false);
        setSelectionPinned(false);
        setShapePinned(false);
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, []);

  const handleSelectionClick = (motivation: SelectionMotivation) => {
    // Toggle: if already selected, deselect it
    onSelectionChange(selectedMotivation === motivation ? null : motivation);
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

  // Render button with icon and label
  const renderButton = (
    icon: string,
    label: string,
    isSelected: boolean,
    onClick: () => void,
    isDelete: boolean = false
  ) => {
    const baseClasses = 'px-3 py-1.5 rounded-md transition-all flex items-center gap-2 font-medium border-none focus:outline-none w-full text-left';

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
        onClick={onClick}
        className={classes}
        aria-pressed={isSelected}
      >
        <span className="text-lg">{icon}</span>
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
        isPinned={clickPinned}
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
          <div className="flex flex-col">
            {clickActions.map(({ action, icon, label, isDelete }) => (
              <div key={action}>
                {renderButton(icon, label, selectedClick === action, () => handleClickClick(action), isDelete)}
              </div>
            ))}
          </div>
        }
      />

      {/* Separator */}
      {showSelectionGroup && <div className="h-8 w-px bg-gray-300 dark:bg-gray-600" />}

      {/* Selection Group */}
      {showSelectionGroup && (
        <DropdownGroup
          label={t('selectionGroup')}
          isExpanded={selectionExpanded}
          isPinned={selectionPinned}
          onHoverChange={setSelectionHovered}
          onPin={() => setSelectionPinned(!selectionPinned)}
          containerRef={selectionRef}
          collapsedContent={
            selectedMotivation ? (
              <div className="flex items-center gap-2">
                <span className="text-lg">{getMotivationEmoji(selectedMotivation)}</span>
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  {selectionMotivations.find(m => m.motivation === selectedMotivation)?.label}
                </span>
              </div>
            ) : null
          }
          expandedContent={
            <div className="flex flex-col">
              {selectionMotivations.map(({ motivation, label }) => (
                <div key={motivation}>
                  {renderButton(
                    getMotivationEmoji(motivation),
                    label,
                    selectedMotivation === motivation,
                    () => handleSelectionClick(motivation)
                  )}
                </div>
              ))}
            </div>
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
          isPinned={shapePinned}
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
            <div className="flex flex-col">
              {shapeTypes.map(({ shape, icon, label }) => (
                <div key={shape}>
                  {renderButton(icon, label, selectedShape === shape, () => handleShapeClick(shape))}
                </div>
              ))}
            </div>
          }
        />
      )}
    </div>
  );
}
