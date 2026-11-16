#!/usr/bin/env tsx
/**
 * Batch audit test files for composition-based testing compliance
 *
 * Generates REACT-UI-TESTS-COMPLIANCE.md report
 */

import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import { TestFileAuditor, TestFileAnalysis } from './audit-test-files';

interface TestComplianceRow {
  testFile: string;
  mocksComponents: string;
  componentMocks: string;
  spiesOnEventBus: string;
  eventBusSpies: string;
  usesEventTracker: string;
  hookMocks: string;
  apiMocks: string;
  status: string;
}

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

function findTestFiles(rootDir: string): string[] {
  // Find all test files: **/__tests__/*.test.tsx and *.test.ts
  const pattern = `${rootDir}/**/__tests__/*.test.{ts,tsx}`;
  return glob.sync(pattern);
}

function analyzeAndFormat(
  testFile: string,
  analysis: TestFileAnalysis,
  bypassConfig: BypassConfig
): TestComplianceRow {
  const bypassEntry = isFileBypassed(testFile, bypassConfig);

  // Determine status
  let status = '✅';

  if (bypassEntry) {
    status = '🔄';
  } else if (analysis.mocksComponents || analysis.spiesOnEventBus) {
    status = '❌';
  } else if (analysis.mockedTypes.hooks.length > 0 || analysis.mockedTypes.apis.length > 0) {
    // Has mocks but they are appropriate (hooks/APIs)
    status = '✅';
  }

  return {
    testFile: path.relative(process.cwd(), testFile),
    mocksComponents: analysis.mocksComponents ? `❌ Yes (${analysis.componentMocks.length})` : '✅ No',
    componentMocks: analysis.componentMocks.join(', ') || 'None',
    spiesOnEventBus: analysis.spiesOnEventBus ? '❌ Yes' : '✅ No',
    eventBusSpies: analysis.eventBusSpies.join(', ') || 'None',
    usesEventTracker: analysis.usesEventTracker ? '✅ Yes' : 'No',
    hookMocks: analysis.mockedTypes.hooks.join(', ') || 'None',
    apiMocks: analysis.mockedTypes.apis.join(', ') || 'None',
    status
  };
}

function formatAsMarkdownTable(rows: TestComplianceRow[]): string {
  const header = '| Test File | Mocks components? | Component mocks | Spies on EventBus? | EventBus spies | Uses EventTracker? | Hook mocks | API mocks | Status |';
  const separator = '|-----------|-------------------|-----------------|-------------------|----------------|-------------------|-----------|-----------|--------|';

  const dataRows = rows.map(row => {
    return `| ${row.testFile} | ${row.mocksComponents} | ${row.componentMocks} | ${row.spiesOnEventBus} | ${row.eventBusSpies} | ${row.usesEventTracker} | ${row.hookMocks} | ${row.apiMocks} | ${row.status} |`;
  });

  return [header, separator, ...dataRows].join('\n');
}

function generateSummary(rows: TestComplianceRow[], bypassConfig: BypassConfig): string {
  const total = rows.length;
  const passing = rows.filter(r => r.status === '✅').length;
  const failing = rows.filter(r => r.status === '❌').length;
  const bypassed = rows.filter(r => r.status === '🔄').length;

  const componentMockViolations = rows.filter(r => r.mocksComponents.includes('❌')).length;
  const eventBusSpyViolations = rows.filter(r => r.spiesOnEventBus.includes('❌')).length;
  const usesEventTracker = rows.filter(r => r.usesEventTracker.includes('✅')).length;

  let bypassedSection = '';
  if (bypassConfig.bypassed.length > 0) {
    bypassedSection = `\n## Bypassed Items (🔄 Legacy/In Progress)\n\nThese items are temporarily bypassed but should be addressed:\n\n| File | Reason | Issue | Added |\n|------|--------|-------|-------|\n`;
    bypassedSection += bypassConfig.bypassed.map(entry =>
      `| ${entry.file} | ${entry.reason} | ${entry.issue} | ${entry.addedDate} |`
    ).join('\n');
    bypassedSection += '\n';
  }

  return `# React UI Tests Compliance Report

## Summary

- **Total test files analyzed**: ${total}
- **Passing (✅)**: ${passing}
- **Failing (❌)**: ${failing}
- **Bypassed (🔄)**: ${bypassed}

## Violation Breakdown

### Critical Violations (❌)
- **Component mocking violations**: ${componentMockViolations} (should use real components)
- **EventBus spy violations**: ${eventBusSpyViolations} (should use EventTracker pattern)

### Best Practices
- **Tests using EventTracker**: ${usesEventTracker} / ${total}

## Test Compliance

${total > 0 ? `Compliance rate: ${Math.round((passing / total) * 100)}%` : 'No test files analyzed'}
${bypassedSection}
## Detailed Analysis

`;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: tsx batch-audit-tests.ts <root-dir>');
    console.error('Example: tsx batch-audit-tests.ts ../src');
    process.exit(1);
  }

  const rootDir = args[0];

  if (!fs.existsSync(rootDir)) {
    console.error(`Directory not found: ${rootDir}`);
    process.exit(1);
  }

  const testFiles = findTestFiles(rootDir);
  const bypassConfig = loadBypassConfig();
  const auditor = new TestFileAuditor();

  console.error(`Analyzing ${testFiles.length} test files from ${rootDir}...`);

  const results: TestComplianceRow[] = [];

  for (const testFile of testFiles) {
    const analysis = auditor.analyzeTestFile(testFile);
    const result = analyzeAndFormat(testFile, analysis, bypassConfig);
    results.push(result);
  }

  // Output summary + table
  console.log(generateSummary(results, bypassConfig));
  console.log(formatAsMarkdownTable(results));
}

if (require.main === module) {
  main();
}
