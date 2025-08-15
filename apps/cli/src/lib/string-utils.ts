/**
 * String Utilities - Pure string manipulation functions without React/Ink dependencies
 */

// Helper function to calculate display width of strings with emojis
function getDisplayWidth(str: string): number {
  // Simple approximation: most emojis are 2 characters wide in terminal display
  // This regex matches most common emoji ranges
  const emojiRegex = /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F900}-\u{1F9FF}]|[\u{1F018}-\u{1F270}]/gu;
  
  const emojis = str.match(emojiRegex) || [];
  return str.length + emojis.length; // Add 1 for each emoji (they take 2 but count as 1, so +1 total)
}

// String-based table utility for CLI output (non-React)
export function createStringTable(
  data: Record<string, any>[], 
  columns: string[], 
  options: { 
    colors?: boolean;
    padding?: number;
    borders?: boolean;
  } = {}
): string {
  if (data.length === 0) {
    return 'No data to display\n';
  }

  const { colors = true, padding = 1, borders = true } = options;
  
  // Color utilities
  const c = colors ? {
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    reset: '\x1b[0m',
    white: '\x1b[37m'
  } : {
    bright: '', dim: '', reset: '', white: ''
  };

  // Calculate column widths (accounting for emoji display width)
  const columnWidths: Record<string, number> = {};
  columns.forEach(col => {
    columnWidths[col] = col.length;
    data.forEach(row => {
      const value = String(row[col] || '');
      // Account for emojis which take 2 display units but only count as 1 in string length
      const displayWidth = getDisplayWidth(value);
      columnWidths[col] = Math.max((columnWidths[col] ?? 0) || 0, displayWidth);
    });
  });

  const pad = (str: string, width: number) => {
    const displayWidth = getDisplayWidth(str);
    const paddingNeeded = width - displayWidth;
    return str + ' '.repeat(Math.max(0, paddingNeeded));
  };
  const spacer = ' '.repeat(padding);

  let output = '';

  if (borders) {
    // Top border
    output += '┌';
    columns.forEach((col, i) => {
      output += '─'.repeat((columnWidths[col] ?? 0) + padding * 2);
      if (i < columns.length - 1) output += '┬';
    });
    output += '┐\n';

    // Header row
    output += '│';
    columns.forEach((col) => {
      const headerText = `${spacer}${c.bright}${c.white}${col}${c.reset}${spacer}`;
      const plainHeader = `${spacer}${col}${spacer}`;
      const paddingSpaces = (columnWidths[col] ?? 0) + padding * 2 - plainHeader.length;
      output += headerText + ' '.repeat(paddingSpaces) + '│';
    });
    output += '\n';

    // Separator
    output += '├';
    columns.forEach((col, i) => {
      output += '─'.repeat((columnWidths[col] ?? 0) + padding * 2);
      if (i < columns.length - 1) output += '┼';
    });
    output += '┤\n';

    // Data rows
    data.forEach(row => {
      output += '│';
      columns.forEach(col => {
        const value = String(row[col] || '');
        const cellText = `${spacer}${pad(value, (columnWidths[col] ?? 0))}${spacer}`;
        output += cellText + '│';
      });
      output += '\n';
    });

    // Bottom border
    output += '└';
    columns.forEach((col, i) => {
      output += '─'.repeat((columnWidths[col] ?? 0) + padding * 2);
      if (i < columns.length - 1) output += '┴';
    });
    output += '┘\n';

  } else {
    // No borders - simple format
    
    // Header
    columns.forEach((col, i) => {
      output += `${c.bright}${c.white}${pad(col, (columnWidths[col] ?? 0))}${c.reset}`;
      if (i < columns.length - 1) output += '  ';
    });
    output += '\n';

    // Separator
    columns.forEach((col, i) => {
      output += '─'.repeat((columnWidths[col] ?? 0));
      if (i < columns.length - 1) output += '  ';
    });
    output += '\n';

    // Data rows  
    data.forEach(row => {
      columns.forEach((col, i) => {
        const value = String(row[col] || '');
        output += pad(value, (columnWidths[col] ?? 0));
        if (i < columns.length - 1) output += '  ';
      });
      output += '\n';
    });
  }

  return output;
}