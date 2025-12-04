/**
 * CodeMirrorRenderer Tests
 *
 * Tests for annotation position accuracy with different line endings
 */

import { describe, it, expect } from 'vitest';
import type { TextSegment } from '../CodeMirrorRenderer';

/**
 * Convert positions from CRLF character space to LF character space.
 * This is needed because CodeMirror normalizes all line endings to LF internally,
 * but annotation positions are calculated in the original content's character space.
 *
 * @param segments - Segments with positions in CRLF space
 * @param content - Original content (may have CRLF line endings)
 * @returns Segments with positions adjusted for LF space
 */
function convertSegmentPositions(segments: TextSegment[], content: string): TextSegment[] {
  // If content has no CRLF, no conversion needed
  if (!content.includes('\r\n')) {
    return segments;
  }

  // Build a map of CRLF->LF position conversions
  // For each position, count how many CRLFs appear before it
  const crlfPositions: number[] = [];
  for (let i = 0; i < content.length - 1; i++) {
    if (content[i] === '\r' && content[i + 1] === '\n') {
      crlfPositions.push(i);
    }
  }

  // Convert a single position from CRLF space to LF space
  const convertPosition = (pos: number): number => {
    // Count how many CRLFs appear before this position
    const crlfsBefore = crlfPositions.filter(crlfPos => crlfPos < pos).length;
    return pos - crlfsBefore;
  };

  return segments.map(seg => ({
    ...seg,
    start: convertPosition(seg.start),
    end: convertPosition(seg.end)
  }));
}

describe('CodeMirrorRenderer - Line Ending Handling', () => {
  describe('Position calculations with CRLF line endings', () => {
    it('should handle annotations with CRLF line endings correctly', () => {
      // Content with CRLF line endings (Windows-style)
      const content = "PROMETHEUS BOUND\r\n\r\nARGUMENT\r\n\r\n\r\nIn the beginning, Ouranos";

      // This is the actual annotation from the bug report
      // Position 52-59 should contain "Ouranos" in the CRLF content
      const start = 52;
      const end = 59;

      const extracted = content.substring(start, end);

      // Verify that position 52-59 actually contains "Ouranos" in CRLF space
      expect(extracted).toBe('Ouranos');

      // Count CRLF sequences before position 52
      const beforePosition = content.substring(0, start);
      const crlfCount = (beforePosition.match(/\r\n/g) || []).length;
      console.log('CRLF sequences before position 52:', crlfCount);
      console.log('Content before position 52:', JSON.stringify(beforePosition));
    });

    it('should demonstrate the position mismatch after LF normalization', () => {
      const contentCRLF = "PROMETHEUS BOUND\r\n\r\nARGUMENT\r\n\r\n\r\nIn the beginning, Ouranos";
      const contentLF = contentCRLF.replace(/\r\n/g, '\n');

      // Position that works in CRLF space
      const crlfStart = 52;
      const crlfEnd = 59;

      // In CRLF space, this is "Ouranos"
      expect(contentCRLF.substring(crlfStart, crlfEnd)).toBe('Ouranos');

      // In LF space, using the same positions gives wrong text
      const wrongText = contentLF.substring(crlfStart, crlfEnd);
      expect(wrongText).not.toBe('Ouranos');

      // Calculate correct position in LF space
      // Count CRLFs before the position and subtract that many characters
      const beforePosition = contentCRLF.substring(0, crlfStart);
      const crlfCount = (beforePosition.match(/\r\n/g) || []).length;

      const lfStart = crlfStart - crlfCount;
      const lfEnd = crlfEnd - crlfCount;

      // In LF space with adjusted positions, this should be "Ouranos"
      expect(contentLF.substring(lfStart, lfEnd)).toBe('Ouranos');

      console.log('Position adjustment needed:', crlfCount);
      console.log('CRLF positions:', crlfStart, '-', crlfEnd);
      console.log('LF positions:', lfStart, '-', lfEnd);
    });
  });

  describe('Position conversion utilities', () => {
    it('should convert CRLF positions to LF positions', () => {
      const content = "line1\r\nline2\r\nline3";

      // Position 8 in CRLF space is the start of "line2"
      const crlfPos = 7; // After "line1\r\n"

      // Count CRLFs before position
      const beforePos = content.substring(0, crlfPos);
      const crlfCount = (beforePos.match(/\r\n/g) || []).length;

      const lfPos = crlfPos - crlfCount;

      // In LF space, "line2" starts at position 6
      expect(lfPos).toBe(6);

      // Verify: normalize to LF and check the position
      const contentLF = content.replace(/\r\n/g, '\n');
      expect(contentLF[lfPos]).toBe('l'); // First character of "line2"
    });

    it('should handle multiple CRLF sequences correctly', () => {
      // 5 CRLF sequences = 10 characters in CRLF space but 5 in LF space
      const content = "\r\n\r\n\r\n\r\n\r\ntext";

      // "text" starts at position 10 in CRLF space
      const crlfPos = 10;

      const beforePos = content.substring(0, crlfPos);
      const crlfCount = (beforePos.match(/\r\n/g) || []).length;

      const lfPos = crlfPos - crlfCount;

      // In LF space, "text" starts at position 5
      expect(lfPos).toBe(5);
      expect(crlfCount).toBe(5);
    });
  });

  describe('convertSegmentPositions', () => {
    it('should convert segment positions from CRLF to LF space', () => {
      const content = "PROMETHEUS BOUND\r\n\r\nARGUMENT\r\n\r\n\r\nIn the beginning, Ouranos";

      const segments: TextSegment[] = [
        { start: 52, end: 59, exact: 'Ouranos' }
      ];

      const converted = convertSegmentPositions(segments, content);

      // Should adjust positions by -5 (number of CRLFs before position 52)
      expect(converted[0]?.start).toBe(47);
      expect(converted[0]?.end).toBe(54);

      // Verify in LF-normalized content
      const contentLF = content.replace(/\r\n/g, '\n');
      const extracted = contentLF.substring(converted[0]?.start ?? 0, converted[0]?.end ?? 0);
      expect(extracted).toBe('Ouranos');
    });

    it('should not modify positions for LF-only content', () => {
      const content = "line1\nline2\nline3";

      const segments: TextSegment[] = [
        { start: 6, end: 11, exact: 'line2' }
      ];

      const converted = convertSegmentPositions(segments, content);

      // Positions should be unchanged
      expect(converted[0]?.start).toBe(6);
      expect(converted[0]?.end).toBe(11);
    });

    it('should handle multiple segments correctly', () => {
      const content = "A\r\nB\r\nC\r\nD";

      const segments: TextSegment[] = [
        { start: 0, end: 1, exact: 'A' },   // No CRLFs before
        { start: 3, end: 4, exact: 'B' },   // 1 CRLF before
        { start: 6, end: 7, exact: 'C' },   // 2 CRLFs before
        { start: 9, end: 10, exact: 'D' },  // 3 CRLFs before
      ];

      const converted = convertSegmentPositions(segments, content);

      expect(converted[0]?.start).toBe(0);  // 0 - 0 = 0
      expect(converted[0]?.end).toBe(1);    // 1 - 0 = 1

      expect(converted[1]?.start).toBe(2);  // 3 - 1 = 2
      expect(converted[1]?.end).toBe(3);    // 4 - 1 = 3

      expect(converted[2]?.start).toBe(4);  // 6 - 2 = 4
      expect(converted[2]?.end).toBe(5);    // 7 - 2 = 5

      expect(converted[3]?.start).toBe(6);  // 9 - 3 = 6
      expect(converted[3]?.end).toBe(7);    // 10 - 3 = 7

      // Verify in LF content
      const contentLF = content.replace(/\r\n/g, '\n');
      expect(contentLF.substring(converted[0]?.start ?? 0, converted[0]?.end ?? 0)).toBe('A');
      expect(contentLF.substring(converted[1]?.start ?? 0, converted[1]?.end ?? 0)).toBe('B');
      expect(contentLF.substring(converted[2]?.start ?? 0, converted[2]?.end ?? 0)).toBe('C');
      expect(contentLF.substring(converted[3]?.start ?? 0, converted[3]?.end ?? 0)).toBe('D');
    });
  });
});
