/**
 * Text Chunking Utilities
 *
 * Handles downloading and chunking text content while preserving
 * original formatting including newlines and whitespace.
 */

export interface ChunkInfo {
  partNumber: number;
  content: string;
  title: string;
}

export interface ChunkingOptions {
  targetChunkSize: number;
  startPattern: RegExp;
  endMarker: string;
  titlePrefix: string;
}

/**
 * Downloads text from a URL
 */
export async function downloadText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status}`);
  }
  return response.text();
}

/**
 * Extracts a section of text between start and end markers
 */
export function extractSection(
  fullText: string,
  startPattern: RegExp,
  endMarker: string
): string {
  const startMatch = fullText.match(startPattern);
  if (!startMatch) {
    throw new Error('Could not find start marker');
  }

  const startIndex = startMatch.index!;
  const endIndex = fullText.indexOf(endMarker);
  if (endIndex === -1) {
    throw new Error('Could not find end marker');
  }

  return fullText.slice(startIndex, endIndex).trim();
}

/**
 * Finds all paragraph break positions in text (double newlines)
 * Handles both Unix (\n\n) and Windows (\r\n\r\n) line endings
 */
function findParagraphBreaks(text: string): number[] {
  const breakPoints: number[] = [0]; // Start of text
  const paragraphBreakPattern = /(\r?\n){2,}/g;
  let match;

  while ((match = paragraphBreakPattern.exec(text)) !== null) {
    // Store position AFTER the break (not at the start of the break)
    breakPoints.push(match.index + match[0].length);
  }

  breakPoints.push(text.length); // End of text
  return breakPoints;
}

/**
 * Finds the best break point near the target position
 * Prefers breaks before target, but will use first break after if none before
 */
function findBestBreakPoint(
  breakPoints: number[],
  startPos: number,
  targetEnd: number
): number {
  let bestBreak = breakPoints[breakPoints.length - 1]; // Default to end
  let foundBreakBeforeTarget = false;

  for (const bp of breakPoints) {
    if (bp <= startPos) {
      // Skip breaks at or before our start
      continue;
    }

    if (bp <= targetEnd) {
      // This break is within target range, keep updating
      bestBreak = bp;
      foundBreakBeforeTarget = true;
    } else if (!foundBreakBeforeTarget) {
      // No break before target, use this first break after target
      bestBreak = bp;
      break;
    } else {
      // We found a break before target, stop looking
      break;
    }
  }

  return bestBreak;
}

/**
 * Chunks text into segments at natural paragraph boundaries
 * Preserves original formatting by using substring extraction
 *
 * @param text - Text to chunk
 * @param targetChunkSize - Target size for each chunk in characters
 * @param titlePrefix - Prefix for chunk titles (e.g., "Prometheus Bound - Part")
 * @returns Array of chunk information
 */
export function chunkText(
  text: string,
  targetChunkSize: number,
  titlePrefix: string
): ChunkInfo[] {
  const breakPoints = findParagraphBreaks(text);
  const chunks: ChunkInfo[] = [];
  let startPos = 0;
  let partNumber = 1;

  while (startPos < text.length) {
    // Find the best break point near startPos + targetChunkSize
    const targetEnd = startPos + targetChunkSize;
    const bestBreak = findBestBreakPoint(breakPoints, startPos, targetEnd);

    // Skip leading whitespace at start position
    while (startPos < bestBreak && /\s/.test(text[startPos])) {
      startPos++;
    }

    // Extract chunk exactly as-is from original text
    const content = text.substring(startPos, bestBreak).trim();

    if (content) {
      chunks.push({
        partNumber,
        content,
        title: `${titlePrefix} ${partNumber}`,
      });
      partNumber++;
    }

    startPos = bestBreak;
  }

  return chunks;
}

/**
 * Downloads text from a URL and chunks it into segments
 * Main entry point combining download, extraction, and chunking
 */
export async function downloadAndChunkText(
  url: string,
  options: ChunkingOptions
): Promise<ChunkInfo[]> {
  // Download
  const fullText = await downloadText(url);

  // Extract the relevant section
  const extractedText = extractSection(
    fullText,
    options.startPattern,
    options.endMarker
  );

  // Chunk the text
  return chunkText(
    extractedText,
    options.targetChunkSize,
    options.titlePrefix
  );
}

/**
 * Statistics about chunking results
 */
export interface ChunkingStats {
  totalChunks: number;
  totalCharacters: number;
  averageChunkSize: number;
  minChunkSize: number;
  maxChunkSize: number;
}

/**
 * Calculate statistics for a set of chunks
 */
export function getChunkingStats(chunks: ChunkInfo[]): ChunkingStats {
  if (chunks.length === 0) {
    return {
      totalChunks: 0,
      totalCharacters: 0,
      averageChunkSize: 0,
      minChunkSize: 0,
      maxChunkSize: 0,
    };
  }

  const lengths = chunks.map(c => c.content.length);
  const totalCharacters = lengths.reduce((sum, len) => sum + len, 0);

  return {
    totalChunks: chunks.length,
    totalCharacters,
    averageChunkSize: Math.round(totalCharacters / chunks.length),
    minChunkSize: Math.min(...lengths),
    maxChunkSize: Math.max(...lengths),
  };
}
