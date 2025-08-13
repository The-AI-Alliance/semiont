/**
 * Shared Ink utilities for enhanced script UI
 */

import React from 'react';
import { render, Text, Box } from 'ink';

// Enhanced error formatting with ink
export async function showError(message: string, details?: string): Promise<void> {
  return new Promise((resolve) => {
    const ErrorComponent = React.createElement(
      Box,
      { flexDirection: 'column', padding: 1 },
      [
        React.createElement(
          Box,
          { key: 'error-header' },
          [
            React.createElement(Text, { color: 'red', bold: true, key: 'icon' }, '❌ ERROR'),
            React.createElement(Text, { color: 'red', key: 'message' }, ` ${message}`)
          ]
        ),
        details ? React.createElement(
          Box,
          { key: 'details', marginLeft: 3 },
          React.createElement(Text, { color: 'gray' }, details)
        ) : null
      ].filter(Boolean)
    );

    const { unmount } = render(ErrorComponent);
    
    setTimeout(() => {
      unmount();
      resolve();
    }, 100);
  });
}

// Enhanced success formatting
export async function showSuccess(message: string, details?: string[]): Promise<void> {
  return new Promise((resolve) => {
    const elements = [
      React.createElement(
        Box,
        { key: 'success-header' },
        [
          React.createElement(Text, { color: 'green', bold: true, key: 'icon' }, '✅ SUCCESS'),
          React.createElement(Text, { color: 'green', key: 'message' }, ` ${message}`)
        ]
      )
    ];

    if (details && details.length > 0) {
      details.forEach((detail, index) => {
        elements.push(
          React.createElement(
            Box,
            { key: `detail-${index}`, marginLeft: 3 },
            React.createElement(Text, { color: 'gray' }, `• ${detail}`)
          )
        );
      });
    }

    const SuccessComponent = React.createElement(
      Box,
      { flexDirection: 'column', padding: 1 },
      elements
    );

    const { unmount } = render(SuccessComponent);
    
    setTimeout(() => {
      unmount();
      resolve();
    }, 100);
  });
}

// Enhanced warning formatting
export async function showWarning(message: string, suggestions?: string[]): Promise<void> {
  return new Promise((resolve) => {
    const elements = [
      React.createElement(
        Box,
        { key: 'warning-header' },
        [
          React.createElement(Text, { color: 'yellow', bold: true, key: 'icon' }, '⚠️  WARNING'),
          React.createElement(Text, { color: 'yellow', key: 'message' }, ` ${message}`)
        ]
      )
    ];

    if (suggestions && suggestions.length > 0) {
      elements.push(
        React.createElement(
          Box,
          { key: 'suggestions-title', marginLeft: 3, marginTop: 1 },
          React.createElement(Text, { color: 'cyan', bold: true }, 'Suggestions:')
        )
      );
      
      suggestions.forEach((suggestion, index) => {
        elements.push(
          React.createElement(
            Box,
            { key: `suggestion-${index}`, marginLeft: 3 },
            React.createElement(Text, { color: 'cyan' }, `• ${suggestion}`)
          )
        );
      });
    }

    const WarningComponent = React.createElement(
      Box,
      { flexDirection: 'column', padding: 1 },
      elements
    );

    const { unmount } = render(WarningComponent);
    
    setTimeout(() => {
      unmount();
      resolve();
    }, 100);
  });
}

// Progress spinner (reusable)
export function ProgressSpinner({ text }: { text: string }) {
  const [frame, setFrame] = React.useState(0);
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

  React.useEffect(() => {
    const interval = setInterval(() => {
      setFrame((f: number) => (f + 1) % spinnerFrames.length);
    }, 80);
    
    return () => clearInterval(interval);
  }, []);

  return React.createElement(
    Box,
    {},
    React.createElement(Text, { color: 'cyan' }, `${spinnerFrames[frame]} ${text}`)
  );
}

// Simple table component (reusable) - moved from test.ts
export function SimpleTable({ data, columns }: { data: Record<string, any>[], columns: string[] }) {
  // Calculate column widths
  const columnWidths: Record<string, number> = {};
  columns.forEach(col => {
    columnWidths[col] = col.length;
    data.forEach(row => {
      const value = String(row[col] || '');
      columnWidths[col] = Math.max((columnWidths[col] ?? 0) || 0, value.length);
    });
  });

  // Pad string to width
  const pad = (str: string, width: number) => {
    return str.padEnd(width);
  };

  // Create header row
  const headerRow = React.createElement(
    Box,
    { key: 'header' },
    columns.map((col, i) => 
      React.createElement(
        Text,
        { key: col, bold: true, color: 'white' },
        pad(col, (columnWidths[col] ?? 0) || 0) + (i < columns.length - 1 ? '  ' : '')
      )
    )
  );

  // Create separator
  const separator = React.createElement(
    Box,
    { key: 'separator' },
    React.createElement(
      Text,
      { dimColor: true },
      columns.map(col => '─'.repeat((columnWidths[col] ?? 0) || 0)).join('──')
    )
  );

  // Create data rows
  const dataRows = data.map((row, rowIndex) =>
    React.createElement(
      Box,
      { key: `row-${rowIndex}` },
      columns.map((col, i) => 
        React.createElement(
          Text,
          { key: `${rowIndex}-${col}` },
          pad(String(row[col] || ''), (columnWidths[col] ?? 0) || 0) + (i < columns.length - 1 ? '  ' : '')
        )
      )
    )
  );

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    [headerRow, separator, ...dataRows]
  );
}

// Progress bar component
export function ProgressBar({ progress, width = 20, showPercentage = true }: { 
  progress: number; 
  width?: number; 
  showPercentage?: boolean; 
}) {
  const filledWidth = Math.round((progress / 100) * width);
  const emptyWidth = width - filledWidth;
  
  const filledBar = '█'.repeat(filledWidth);
  const emptyBar = '░'.repeat(emptyWidth);
  
  return React.createElement(
    Box,
    {},
    React.createElement(Text, { color: 'green' }, filledBar),
    React.createElement(Text, { color: 'gray' }, emptyBar),
    showPercentage ? React.createElement(Box, { marginLeft: 1 }, 
      React.createElement(Text, {}, `${progress}%`)
    ) : null
  );
}

// Step progress component for multi-step processes
export function StepProgress({ 
  steps, 
  currentStep, 
  completedSteps = [] 
}: { 
  steps: string[]; 
  currentStep: number; 
  completedSteps?: number[]; 
}) {
  return React.createElement(
    Box,
    { flexDirection: 'column' },
    steps.map((step, index) => {
      let status = '⏳';
      let color = 'gray';
      
      if (completedSteps.includes(index)) {
        status = '✅';
        color = 'green';
      } else if (index === currentStep) {
        status = '🔄';
        color = 'cyan';
      } else if (index < currentStep) {
        status = '✅';
        color = 'green';
      }
      
      return React.createElement(
        Box,
        { key: index },
        React.createElement(Text, { color }, `${status} ${step}`)
      );
    })
  );
}

// Live metrics display component
export function MetricsDisplay({ 
  metrics 
}: { 
  metrics: Array<{ label: string; value: string; status?: 'good' | 'warning' | 'error' }> 
}) {
  return React.createElement(
    Box,
    { flexDirection: 'column' },
    metrics.map((metric, index) => {
      let color = 'white';
      let icon = '📊';
      
      if (metric.status === 'good') {
        color = 'green';
        icon = '✅';
      } else if (metric.status === 'warning') {
        color = 'yellow';
        icon = '⚠️';
      } else if (metric.status === 'error') {
        color = 'red';
        icon = '❌';
      }
      
      return React.createElement(
        Box,
        { key: index },
        React.createElement(Text, { color }, `${icon} ${metric.label}: ${metric.value}`)
      );
    })
  );
}

// Deployment status display component
export function DeploymentStatus({ 
  services 
}: { 
  services: Array<{
    name: string;
    icon: string;
    oldTasks: number;
    newTasks: number;
    healthy: boolean;
    status: string;
  }>
}) {
  const statusData = services.map(service => ({
    Service: `${service.icon} ${service.name}`,
    'Old Tasks': service.oldTasks > 0 ? `${service.oldTasks} running` : 'None',
    'New Tasks': service.newTasks > 0 ? `${service.newTasks} starting` : 'None',
    Health: service.healthy ? '✅ Healthy' : '🟡 Rolling',
    Status: service.status
  }));

  return React.createElement(SimpleTable, {
    data: statusData,
    columns: ['Service', 'Old Tasks', 'New Tasks', 'Health', 'Status']
  });
}

// Environment details component
export function EnvironmentDetails({ 
  environment,
  details 
}: { 
  environment: string;
  details: Record<string, string | number>;
}) {
  const detailsData = Object.entries(details).map(([key, value]) => ({
    Property: key,
    Value: String(value)
  }));

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    [
      React.createElement(Text, { 
        bold: true, 
        color: 'magenta', 
        key: 'title' 
      }, `Environment Details: ${environment}`),
      React.createElement(SimpleTable, {
        data: detailsData,
        columns: ['Property', 'Value'],
        key: 'details-table'
      })
    ]
  );
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

  // Calculate column widths
  const columnWidths: Record<string, number> = {};
  columns.forEach(col => {
    columnWidths[col] = col.length;
    data.forEach(row => {
      const value = String(row[col] || '');
      columnWidths[col] = Math.max((columnWidths[col] ?? 0) || 0, value.length);
    });
  });

  const pad = (str: string, width: number) => str.padEnd(width);
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