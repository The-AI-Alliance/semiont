/**
 * Legal Text Utilities
 *
 * Utilities for downloading and formatting legal opinions.
 */

/**
 * Download and clean legal text from Cornell LII
 */
export async function downloadCornellLII(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download from Cornell LII: ${response.status}`);
  }

  const html = await response.text();

  // Extract text from HTML (simple approach - strips all tags)
  // This is basic but works for most legal texts
  let text = html
    // Remove script and style tags
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    // Remove HTML tags
    .replace(/<[^>]+>/g, ' ')
    // Decode HTML entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Clean up whitespace
    .replace(/\s+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim();

  return text;
}

/**
 * Format legal text with markdown sections
 */
export function formatLegalOpinion(
  caseTitle: string,
  citation: string,
  text: string
): string {
  let formatted = `# ${caseTitle}\n\n`;
  formatted += `**Citation:** ${citation}\n\n`;
  formatted += `---\n\n`;
  formatted += text;
  return formatted;
}

/**
 * Extract sections from legal opinion based on common patterns
 */
export function extractOpinionSections(text: string): string[] {
  // Split on common section markers in legal opinions
  // This is a simple heuristic - you may need to adjust based on actual format
  const sections: string[] = [];

  // Try to split on major section markers like "I", "II", "III", etc.
  // or "Part I", "Part II", etc.
  const sectionPattern = /(?:^|\n)(?:Part\s+)?([IVX]+)\s*\n/;

  // If we can find sections, split on them
  const parts = text.split(sectionPattern);

  if (parts.length > 3) {
    // We found section markers
    for (let i = 1; i < parts.length; i += 2) {
      const sectionNumber = parts[i];
      const sectionContent = parts[i + 1] || '';
      sections.push(`## ${sectionNumber}\n\n${sectionContent.trim()}`);
    }
  } else {
    // No clear sections, return as single section
    sections.push(text);
  }

  return sections;
}
