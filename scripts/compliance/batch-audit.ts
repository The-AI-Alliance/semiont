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

interface ComplianceRow {
  path: string;
  symbol: string;
  type: string;
  usesEventBus: string;
  eventBusInDeps: string;
  usesClient: string;
  clientInDeps: string;
  acceptsCallbacks: string;
  callbacksInDeps: string;
  usesUseEventSubscriptions: string;
  inlineHandlers: string;
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
  item: SymbolInfo
): ComplianceRow {
  const fullPath = path.join(rootDir, item.path);

  // Skip if file doesn't exist
  if (!fs.existsSync(fullPath)) {
    return {
      path: item.path,
      symbol: item.symbol,
      type: item.type,
      usesEventBus: '🔍',
      eventBusInDeps: '🔍',
      usesClient: '🔍',
      clientInDeps: '🔍',
      acceptsCallbacks: '🔍',
      callbacksInDeps: '🔍',
      usesUseEventSubscriptions: '🔍',
      inlineHandlers: '🔍',
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
      usesEventBus: 'N/A',
      eventBusInDeps: 'N/A',
      usesClient: 'N/A',
      clientInDeps: 'N/A',
      acceptsCallbacks: 'N/A',
      callbacksInDeps: 'N/A',
      usesUseEventSubscriptions: 'N/A',
      inlineHandlers: 'N/A',
      depCount: '0',
      allDepsStable: 'N/A',
      status: item.type === 'interface' || item.type === 'type' ? '✅' : '🔍'
    };
  }

  // Determine status based on issues
  let status = '✅';
  if (hookAnalysis.eventBusInDeps) {
    status = '❌';
  } else if (hookAnalysis.callbacksInDeps || hookAnalysis.hasInlineHandlers) {
    status = '⚠️';
  } else if (hookAnalysis.issues.length > 0) {
    status = '⚠️';
  }

  return {
    path: item.path,
    symbol: item.symbol,
    type: item.type,
    usesEventBus: hookAnalysis.usesEventBus ? 'Yes' : 'No',
    eventBusInDeps: hookAnalysis.eventBusInDeps ? '❌ Yes' : hookAnalysis.usesEventBus ? '✅ No' : 'N/A',
    usesClient: hookAnalysis.usesClient ? 'Yes' : 'No',
    clientInDeps: hookAnalysis.clientInDeps ? '✅ Yes' : hookAnalysis.usesClient ? '✅ No' : 'N/A',
    acceptsCallbacks: hookAnalysis.acceptsCallbacks ? 'Yes' : '✅ No',
    callbacksInDeps: hookAnalysis.callbacksInDeps ? '❌ Yes' : hookAnalysis.acceptsCallbacks ? '✅ No' : 'N/A',
    usesUseEventSubscriptions: hookAnalysis.usesUseEventSubscriptions ? 'Yes' : 'No',
    inlineHandlers: hookAnalysis.hasInlineHandlers ? '⚠️ Yes' : hookAnalysis.usesUseEventSubscriptions ? '✅ No' : 'N/A',
    depCount: hookAnalysis.dependencyCount.toString(),
    allDepsStable: hookAnalysis.allDepsStable === null ? '🔍' : (hookAnalysis.allDepsStable ? '✅ Yes' : '⚠️ No'),
    status
  };
}

function formatAsMarkdownTable(rows: ComplianceRow[]): string {
  const header = '| Path | Symbol/Export | Type | Uses eventBus? | eventBus in deps? | Uses client? | client in deps? | Accepts callbacks? | Callbacks in deps? | Uses useEventSubscriptions? | Inline handlers? | Dep count | All deps stable? | Status |';
  const separator = '|------|---------------|------|----------------|-------------------|--------------|-----------------|-------------------|-------------------|----------------------------|------------------|-----------|------------------|--------|';

  const dataRows = rows.map(row => {
    return `| ${row.path} | ${row.symbol} | ${row.type} | ${row.usesEventBus} | ${row.eventBusInDeps} | ${row.usesClient} | ${row.clientInDeps} | ${row.acceptsCallbacks} | ${row.callbacksInDeps} | ${row.usesUseEventSubscriptions} | ${row.inlineHandlers} | ${row.depCount} | ${row.allDepsStable} | ${row.status} |`;
  });

  return [header, separator, ...dataRows].join('\n');
}

function generateSummary(rows: ComplianceRow[]): string {
  const total = rows.length;
  const passing = rows.filter(r => r.status === '✅').length;
  const warnings = rows.filter(r => r.status === '⚠️').length;
  const failing = rows.filter(r => r.status === '❌').length;
  const unknown = rows.filter(r => r.status === '🔍').length;

  const eventBusViolations = rows.filter(r => r.eventBusInDeps.includes('❌')).length;
  const callbackViolations = rows.filter(r => r.callbacksInDeps.includes('❌')).length;
  const inlineHandlerViolations = rows.filter(r => r.inlineHandlers.includes('⚠️')).length;

  return `# React UI Compliance Report

## Summary

- **Total symbols analyzed**: ${total}
- **Passing (✅)**: ${passing}
- **Warnings (⚠️)**: ${warnings}
- **Failing (❌)**: ${failing}
- **Unknown (🔍)**: ${unknown}

## Violation Breakdown

- **eventBus in deps violations**: ${eventBusViolations}
- **Callback prop in deps violations**: ${callbackViolations}
- **Inline handler violations**: ${inlineHandlerViolations}

## Architecture Compliance

${total > 0 ? `Compliance rate: ${Math.round((passing / total) * 100)}%` : 'No symbols analyzed'}

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
  console.error(`Analyzing ${items.length} items from ${inventoryPath}...`);

  const results: ComplianceRow[] = [];

  for (const item of items) {
    const result = analyzeAndFormat(rootDir, item);
    results.push(result);
  }

  // Output summary + table
  console.log(generateSummary(results));
  console.log(formatAsMarkdownTable(results));
}

if (require.main === module) {
  main();
}
