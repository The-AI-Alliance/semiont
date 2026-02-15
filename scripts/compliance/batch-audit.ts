#!/usr/bin/env tsx
/**
 * Batch audit all files from compliance inventories
 *
 * Supports two input formats:
 * 1. JSON format (from discover-symbols.ts)
 * 2. Markdown table format (legacy)
 *
 * Usage:
 *   npx tsx batch-audit.ts <root-dir> <inventory-file>
 *
 * Example:
 *   npx tsx batch-audit.ts ../src ./symbols.json
 *   npx tsx batch-audit.ts ../src ./INVENTORY.md
 */

import * as fs from 'fs';
import * as path from 'path';
import { DependencyArrayAuditor } from './audit-dependency-arrays';
import type { HookAnalysis, FileAnalysis } from './audit-dependency-arrays';

interface BypassEntry {
  file: string;
  reason: string;
  issue: string;
  ticketUrl: string;
  addedDate: string;
}

interface BypassConfig {
  bypassed: BypassEntry[];
}

function loadBypassConfig(): BypassConfig {
  const configPath = path.join(__dirname, 'bypass-config.json');
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }
  return { bypassed: [] };
}

function isFileBypassed(filePath: string, bypassConfig: BypassConfig): BypassEntry | null {
  const normalizedPath = filePath.replace(/\\/g, '/');
  for (const entry of bypassConfig.bypassed) {
    const normalizedBypassPath = entry.file.replace(/\\/g, '/');
    if (normalizedPath.endsWith(normalizedBypassPath) || normalizedPath.includes(normalizedBypassPath)) {
      return entry;
    }
  }
  return null;
}

interface ComplianceRow {
  path: string;
  symbol: string;
  type: string;
  isContainer: string;
  usesEventBus: string;
  eventBusInDeps: string;
  eventBusProp: string;
  returnsEventBus: string;
  usesClient: string;
  clientInDeps: string;
  acceptsCallbacks: string;
  callbacksInDeps: string;
  usesUseEventSubscriptions: string;
  inlineHandlers: string;
  eventDocs: string;
  emittedEvents: string;
  subscribedEvents: string;
  missingDocs: string;
  eventNaming: string;
  depCount: string;
  allDepsStable: string;
  status: string;
}

interface SymbolInfo {
  path: string;
  symbol: string;
  type: string;
}

interface DiscoveredSymbol {
  name: string;
  type: 'hook' | 'component' | 'function' | 'interface' | 'type';
  file: string;
  lineNumber: number;
  exported: boolean;
}

/**
 * Read symbols from either JSON or Markdown format
 */
function readSymbols(inputPath: string): SymbolInfo[] {
  const content = fs.readFileSync(inputPath, 'utf-8');

  // Try JSON parse first
  try {
    const data = JSON.parse(content);
    if (Array.isArray(data)) {
      // Convert from DiscoveredSymbol[] to SymbolInfo[]
      return data.map((s: DiscoveredSymbol) => ({
        path: s.file,
        symbol: s.name,
        type: s.type
      }));
    }
  } catch {
    // Fall back to markdown parsing
    return parseMarkdownInventory(content);
  }

  return [];
}

function parseMarkdownInventory(content: string): SymbolInfo[] {
  const lines = content.split('\n');
  const items: SymbolInfo[] = [];

  for (const line of lines) {
    // Parse markdown table rows
    const match = line.match(/^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|/);
    if (match && !line.includes('---') && !line.includes('Path')) {
      const [, filePath, symbol, type] = match;
      if (filePath.trim() && symbol.trim() && type.trim()) {
        items.push({
          path: filePath.trim(),
          symbol: symbol.trim(),
          type: type.trim()
        });
      }
    }
  }

  return items;
}

function analyzeHookForSymbol(fileAnalysis: FileAnalysis, symbolName: string): HookAnalysis | null {
  // Find the hook/component matching this symbol
  for (const hook of fileAnalysis.hooks) {
    if (hook.hookName === symbolName) {
      return hook;
    }
  }
  return null;
}

function analyzeAndFormat(
  rootDir: string,
  item: SymbolInfo,
  bypassConfig: BypassConfig
): ComplianceRow {
  const fullPath = path.join(rootDir, item.path);

  // Check if file is bypassed
  const bypassEntry = isFileBypassed(fullPath, bypassConfig);

  // Skip if file doesn't exist
  if (!fs.existsSync(fullPath)) {
    return {
      path: item.path,
      symbol: item.symbol,
      type: item.type,
      isContainer: '🔍',
      usesEventBus: '🔍',
      eventBusInDeps: '🔍',
      eventBusProp: '🔍',
      returnsEventBus: '🔍',
      usesClient: '🔍',
      clientInDeps: '🔍',
      acceptsCallbacks: '🔍',
      callbacksInDeps: '🔍',
      usesUseEventSubscriptions: '🔍',
      inlineHandlers: '🔍',
      eventDocs: '🔍',
      emittedEvents: '🔍',
      subscribedEvents: '🔍',
      missingDocs: '🔍',
      eventNaming: '🔍',
      depCount: '🔍',
      allDepsStable: '🔍',
      status: '🔍'
    };
  }

  const auditor = new DependencyArrayAuditor();
  const fileAnalysis = auditor.analyzeFile(fullPath);
  const hookAnalysis = analyzeHookForSymbol(fileAnalysis, item.symbol);

  if (!hookAnalysis) {
    // Symbol not found - might be an interface or non-hook export
    return {
      path: item.path,
      symbol: item.symbol,
      type: item.type,
      isContainer: 'N/A',
      usesEventBus: 'N/A',
      eventBusInDeps: 'N/A',
      eventBusProp: 'N/A',
      returnsEventBus: 'N/A',
      usesClient: 'N/A',
      clientInDeps: 'N/A',
      acceptsCallbacks: 'N/A',
      callbacksInDeps: 'N/A',
      usesUseEventSubscriptions: 'N/A',
      inlineHandlers: 'N/A',
      eventDocs: 'N/A',
      emittedEvents: 'N/A',
      subscribedEvents: 'N/A',
      missingDocs: 'N/A',
      eventNaming: 'N/A',
      depCount: '0',
      allDepsStable: 'N/A',
      status: item.type === 'interface' || item.type === 'type' ? '✅' : '🔍'
    };
  }

  // Determine status based on issues (Phase 7 logic)
  let status = '✅';

  // Check if bypassed
  if (bypassEntry) {
    status = '🔄';
  } else {
    // Critical failures (❌)
    if (hookAnalysis.eventBusInDeps) {
      status = '❌';
    } else if (hookAnalysis.acceptsEventBusProp) {
      status = '❌';
    } else if (hookAnalysis.returnsEventBus) {
      status = '❌';
    } else if (hookAnalysis.isContainer && !hookAnalysis.hasEventContractDocs) {
      status = '❌';
    } else if (hookAnalysis.isContainer && hookAnalysis.acceptsCallbacks) {
      status = '❌';
    } else if (hookAnalysis.callbacksInDeps) {
      status = '❌';
    }
    // Warnings (⚠️)
    else if (hookAnalysis.hasInlineHandlers) {
      status = '⚠️';
    } else if (hookAnalysis.usesHyphenSeparatedEvents) {
      status = '⚠️';
    } else if (hookAnalysis.issues.length > 0) {
      status = '⚠️';
    }
  }

  // Calculate missing docs (must be done before checking for warnings)
  const missingEmitsDocs = hookAnalysis.emittedEvents.filter(e => !hookAnalysis.documentedEmittedEvents.includes(e));
  const missingSubscribesDocs = hookAnalysis.subscribedEvents.filter(e => !hookAnalysis.documentedSubscribedEvents.includes(e));

  // Check for missing documentation (use unique events, not total occurrences)
  if (status === '✅' && (missingEmitsDocs.length > 0 || missingSubscribesDocs.length > 0)) {
    status = '⚠️';
  }
  const missingDocsStr = [...missingEmitsDocs.map(e => `emit:${e}`), ...missingSubscribesDocs.map(e => `sub:${e}`)].join(', ') || 'None';

  // Event naming status
  let eventNamingStr = 'N/A';
  if (hookAnalysis.usesColonSeparatedEvents && !hookAnalysis.usesHyphenSeparatedEvents) {
    eventNamingStr = '✅ Colon';
  } else if (hookAnalysis.usesHyphenSeparatedEvents && !hookAnalysis.usesColonSeparatedEvents) {
    eventNamingStr = '⚠️ Hyphen';
  } else if (hookAnalysis.usesColonSeparatedEvents && hookAnalysis.usesHyphenSeparatedEvents) {
    eventNamingStr = '⚠️ Mixed';
  }

  return {
    path: item.path,
    symbol: item.symbol,
    type: item.type,
    isContainer: hookAnalysis.isContainer ? 'Yes' : 'No',
    usesEventBus: hookAnalysis.usesEventBus ? 'Yes' : 'No',
    eventBusInDeps: hookAnalysis.eventBusInDeps ? '❌ Yes' : hookAnalysis.usesEventBus ? '✅ No' : 'N/A',
    eventBusProp: hookAnalysis.acceptsEventBusProp ? '❌ Yes' : '✅ No',
    returnsEventBus: hookAnalysis.returnsEventBus ? '❌ Yes' : 'No',
    usesClient: hookAnalysis.usesClient ? 'Yes' : 'No',
    clientInDeps: hookAnalysis.clientInDeps ? '✅ Yes' : hookAnalysis.usesClient ? '✅ No' : 'N/A',
    acceptsCallbacks: hookAnalysis.acceptsCallbacks ? 'Yes' : '✅ No',
    callbacksInDeps: hookAnalysis.callbacksInDeps ? '❌ Yes' : hookAnalysis.acceptsCallbacks ? '✅ No' : 'N/A',
    usesUseEventSubscriptions: hookAnalysis.usesUseEventSubscriptions ? 'Yes' : 'No',
    inlineHandlers: hookAnalysis.hasInlineHandlers ? '⚠️ Yes' : hookAnalysis.usesUseEventSubscriptions ? '✅ No' : 'N/A',
    eventDocs: hookAnalysis.hasEventContractDocs ? '✅ Yes' : hookAnalysis.isContainer ? '❌ No' : 'No',
    emittedEvents: hookAnalysis.emittedEvents.join(', ') || 'None',
    subscribedEvents: hookAnalysis.subscribedEvents.join(', ') || 'None',
    missingDocs: missingDocsStr,
    eventNaming: eventNamingStr,
    depCount: hookAnalysis.dependencyCount.toString(),
    allDepsStable: hookAnalysis.allDepsStable === null ? '🔍' : (hookAnalysis.allDepsStable ? '✅ Yes' : '⚠️ No'),
    status
  };
}

function formatAsMarkdownTable(rows: ComplianceRow[]): string {
  const header = '| Path | Symbol/Export | Type | Container? | Uses eventBus? | eventBus in deps? | eventBus prop? | Returns eventBus? | Event docs? | Emitted events | Subscribed events | Missing docs | Event naming | Uses client? | client in deps? | Accepts callbacks? | Callbacks in deps? | Uses useEventSubscriptions? | Inline handlers? | Dep count | All deps stable? | Status |';
  const separator = '|------|---------------|------|------------|----------------|-------------------|----------------|-------------------|-------------|----------------|-------------------|--------------|--------------|--------------|-----------------|-------------------|-------------------|----------------------------|------------------|-----------|------------------|--------|';

  const dataRows = rows.map(row => {
    return `| ${row.path} | ${row.symbol} | ${row.type} | ${row.isContainer} | ${row.usesEventBus} | ${row.eventBusInDeps} | ${row.eventBusProp} | ${row.returnsEventBus} | ${row.eventDocs} | ${row.emittedEvents} | ${row.subscribedEvents} | ${row.missingDocs} | ${row.eventNaming} | ${row.usesClient} | ${row.clientInDeps} | ${row.acceptsCallbacks} | ${row.callbacksInDeps} | ${row.usesUseEventSubscriptions} | ${row.inlineHandlers} | ${row.depCount} | ${row.allDepsStable} | ${row.status} |`;
  });

  return [header, separator, ...dataRows].join('\n');
}

function generateSummary(rows: ComplianceRow[], bypassConfig: BypassConfig): string {
  const total = rows.length;
  const passing = rows.filter(r => r.status === '✅').length;
  const warnings = rows.filter(r => r.status === '⚠️').length;
  const failing = rows.filter(r => r.status === '❌').length;
  const bypassed = rows.filter(r => r.status === '🔄').length;
  const unknown = rows.filter(r => r.status === '🔍').length;

  const eventBusInDepsViolations = rows.filter(r => r.eventBusInDeps.includes('❌')).length;
  const eventBusPropViolations = rows.filter(r => r.eventBusProp.includes('❌')).length;
  const returnsEventBusViolations = rows.filter(r => r.returnsEventBus.includes('❌')).length;
  const callbackViolations = rows.filter(r => r.callbacksInDeps.includes('❌')).length;
  const inlineHandlerViolations = rows.filter(r => r.inlineHandlers.includes('⚠️')).length;
  const missingEventDocsViolations = rows.filter(r => r.eventDocs.includes('❌')).length;
  const legacyEventNamingViolations = rows.filter(r => r.eventNaming.includes('⚠️')).length;

  let bypassedSection = '';
  if (bypassConfig.bypassed.length > 0) {
    bypassedSection = `\n## Bypassed Items (🔄 Legacy/In Progress)\n\nThese items are temporarily bypassed but should be addressed:\n\n| File | Reason | Issue | Added |\n|------|--------|-------|-------|\n`;
    bypassedSection += bypassConfig.bypassed.map(entry =>
      `| ${entry.file} | ${entry.reason} | ${entry.issue} | ${entry.addedDate} |`
    ).join('\n');
    bypassedSection += '\n';
  }

  return `# React UI Compliance Report

## Summary

- **Total symbols analyzed**: ${total}
- **Passing (✅)**: ${passing}
- **Warnings (⚠️)**: ${warnings}
- **Failing (❌)**: ${failing}
- **Bypassed (🔄)**: ${bypassed}
- **Unknown (🔍)**: ${unknown}

## Violation Breakdown

### Critical Violations (❌)
- **eventBus in deps violations**: ${eventBusInDepsViolations}
- **eventBus prop violations**: ${eventBusPropViolations}
- **Returns eventBus violations**: ${returnsEventBusViolations}
- **Callback prop in deps violations**: ${callbackViolations}
- **Missing event docs (containers)**: ${missingEventDocsViolations}

### Warnings (⚠️)
- **Inline handler violations**: ${inlineHandlerViolations}
- **Legacy event naming (hyphen)**: ${legacyEventNamingViolations}

## Architecture Compliance

${total > 0 ? `Compliance rate: ${Math.round((passing / total) * 100)}%` : 'No symbols analyzed'}
${bypassedSection}
## Detailed Analysis

`;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: tsx batch-audit.ts <root-dir> <inventory-file>');
    console.error('Example: tsx batch-audit.ts ../src ./symbols.json');
    console.error('Example: tsx batch-audit.ts ../src ./INVENTORY.md');
    process.exit(1);
  }

  const rootDir = args[0];
  const inventoryPath = args[1];

  if (!fs.existsSync(inventoryPath)) {
    console.error(`Inventory file not found: ${inventoryPath}`);
    process.exit(1);
  }

  const items = readSymbols(inventoryPath);
  const bypassConfig = loadBypassConfig();

  console.error(`Analyzing ${items.length} items from ${inventoryPath}...`);

  const results: ComplianceRow[] = [];

  for (const item of items) {
    const result = analyzeAndFormat(rootDir, item, bypassConfig);
    results.push(result);
  }

  // Output summary + table
  console.log(generateSummary(results, bypassConfig));
  console.log(formatAsMarkdownTable(results));
}

if (require.main === module) {
  main();
}
