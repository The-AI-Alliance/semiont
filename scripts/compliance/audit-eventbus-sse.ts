#!/usr/bin/env tsx
/**
 * Audit EventBus/SSE Architecture Compliance
 *
 * Detects legacy callback-based SSE patterns that violate EventBus-native architecture.
 *
 * Checks:
 * 1. No callback properties in SSE options (onProgress, onComplete, onError)
 * 2. No callback method calls on SSE streams (.onProgress(), .onComplete(), .onError())
 * 3. No generic SSEStream types (should be just SSEStream, not SSEStream<T, U>)
 *
 * Usage:
 *   npx tsx audit-eventbus-sse.ts <src-dir>
 *
 * Example:
 *   npx tsx scripts/compliance/audit-eventbus-sse.ts packages/react-ui/src
 */

import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';

interface Violation {
  file: string;
  line: number;
  column: number;
  type: 'callback-property' | 'callback-method' | 'generic-stream-type';
  message: string;
  code: string;
}

function scanFile(filePath: string): Violation[] {
  const violations: Violation[] = [];
  const sourceCode = fs.readFileSync(filePath, 'utf-8');
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceCode,
    ts.ScriptTarget.Latest,
    true
  );

  function visit(node: ts.Node) {
    // Check 1 & 2: Detect callback properties and method calls
    if (ts.isCallExpression(node)) {
      const expression = node.expression;

      // Check for callback method calls: stream.onProgress(), stream.onComplete(), etc.
      if (ts.isPropertyAccessExpression(expression)) {
        const methodName = expression.name.text;
        if (methodName === 'onProgress' || methodName === 'onComplete' || methodName === 'onError') {
          const leftSide = expression.expression.getText(sourceFile);
          if (leftSide.includes('stream') || leftSide.includes('Stream')) {
            const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
            violations.push({
              file: path.relative(process.cwd(), filePath),
              line: line + 1,
              column: character,
              type: 'callback-method',
              message: `Forbidden callback method '.${methodName}()' - use EventBus subscriptions instead`,
              code: node.getText(sourceFile).substring(0, 80) + (node.getText(sourceFile).length > 80 ? '...' : '')
            });
          }
        }

        // Check for client.sse.* calls with callback properties
        const leftSide = expression.expression;
        if (ts.isPropertyAccessExpression(leftSide) && leftSide.name.text === 'sse') {
          // This is a client.sse.* call - check arguments for callback properties
          node.arguments.forEach(arg => {
            if (ts.isObjectLiteralExpression(arg)) {
              arg.properties.forEach(prop => {
                if (ts.isPropertyAssignment(prop)) {
                  const propName = prop.name?.getText(sourceFile);
                  if (propName === 'onProgress' || propName === 'onComplete' || propName === 'onError') {
                    const { line, character } = sourceFile.getLineAndCharacterOfPosition(prop.getStart());
                    violations.push({
                      file: path.relative(process.cwd(), filePath),
                      line: line + 1,
                      column: character,
                      type: 'callback-property',
                      message: `Forbidden callback property '${propName}' in SSE options - use EventBus instead`,
                      code: prop.getText(sourceFile)
                    });
                  }
                }
              });
            }
          });
        }
      }
    }

    // Check 3: Detect generic SSEStream types
    if (ts.isTypeReferenceNode(node)) {
      const typeName = node.typeName.getText(sourceFile);
      if (typeName === 'SSEStream' && node.typeArguments && node.typeArguments.length > 0) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        violations.push({
          file: path.relative(process.cwd(), filePath),
          line: line + 1,
          column: character,
          type: 'generic-stream-type',
          message: `Generic SSEStream type should be just 'SSEStream' not 'SSEStream<...>'`,
          code: node.getText(sourceFile)
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

function getAllTypeScriptFiles(dir: string): string[] {
  const files: string[] = [];

  function traverse(currentPath: string) {
    if (!fs.existsSync(currentPath)) {
      return;
    }

    const entries = fs.readdirSync(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        // Skip node_modules, dist, build directories
        if (!['node_modules', 'dist', 'build', '.git', '__tests__'].includes(entry.name)) {
          traverse(fullPath);
        }
      } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
        // Skip test files
        if (!entry.name.includes('.test.')) {
          files.push(fullPath);
        }
      }
    }
  }

  traverse(dir);
  return files;
}

function generateReport(violations: Violation[]): string {
  const lines: string[] = [];

  lines.push('# EventBus/SSE Architecture Compliance Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');

  // Summary
  lines.push('## Summary');
  lines.push('');
  const callbackProps = violations.filter(v => v.type === 'callback-property').length;
  const callbackMethods = violations.filter(v => v.type === 'callback-method').length;
  const genericTypes = violations.filter(v => v.type === 'generic-stream-type').length;
  const total = violations.length;

  lines.push(`- **Total violations**: ${total}`);
  lines.push(`- Callback properties in options: ${callbackProps}`);
  lines.push(`- Callback method calls: ${callbackMethods}`);
  lines.push(`- Generic SSEStream types: ${genericTypes}`);
  lines.push('');

  if (total === 0) {
    lines.push('✅ **No violations found!** All SSE code follows EventBus-native architecture.');
    lines.push('');
    return lines.join('\n');
  }

  lines.push('## Architecture Rules');
  lines.push('');
  lines.push('### 1. No Callback Properties in SSE Options');
  lines.push('```typescript');
  lines.push('// ❌ FORBIDDEN');
  lines.push('client.sse.detectReferences(rUri, args, {');
  lines.push('  auth,');
  lines.push('  onProgress: (p) => { ... }  // FORBIDDEN');
  lines.push('});');
  lines.push('');
  lines.push('// ✅ CORRECT');
  lines.push('client.sse.detectReferences(rUri, args, {');
  lines.push('  auth,');
  lines.push('  eventBus  // Events auto-emit to EventBus');
  lines.push('});');
  lines.push('```');
  lines.push('');

  lines.push('### 2. No Callback Method Calls');
  lines.push('```typescript');
  lines.push('// ❌ FORBIDDEN');
  lines.push('stream.onProgress((p) => { ... });');
  lines.push('');
  lines.push('// ✅ CORRECT');
  lines.push('eventBus.get("detection:progress").subscribe((p) => { ... });');
  lines.push('```');
  lines.push('');

  lines.push('### 3. No Generic SSEStream Types');
  lines.push('```typescript');
  lines.push('// ❌ FORBIDDEN');
  lines.push('const streamRef = useRef<SSEStream<ProgressType, CompleteType>>(null);');
  lines.push('');
  lines.push('// ✅ CORRECT');
  lines.push('const streamRef = useRef<SSEStream | null>(null);');
  lines.push('```');
  lines.push('');

  // Violations by type
  lines.push('## Violations');
  lines.push('');

  if (callbackProps > 0) {
    lines.push('### Callback Properties in Options');
    lines.push('');
    lines.push('| File | Line | Code |');
    lines.push('|------|------|------|');
    violations.filter(v => v.type === 'callback-property').forEach(v => {
      lines.push(`| ${v.file} | ${v.line} | \`${v.code.replace(/`/g, "'")}\` |`);
    });
    lines.push('');
  }

  if (callbackMethods > 0) {
    lines.push('### Callback Method Calls');
    lines.push('');
    lines.push('| File | Line | Code |');
    lines.push('|------|------|------|');
    violations.filter(v => v.type === 'callback-method').forEach(v => {
      lines.push(`| ${v.file} | ${v.line} | \`${v.code.replace(/`/g, "'")}\` |`);
    });
    lines.push('');
  }

  if (genericTypes > 0) {
    lines.push('### Generic SSEStream Types');
    lines.push('');
    lines.push('| File | Line | Code |');
    lines.push('|------|------|------|');
    violations.filter(v => v.type === 'generic-stream-type').forEach(v => {
      lines.push(`| ${v.file} | ${v.line} | \`${v.code.replace(/`/g, "'")}\` |`);
    });
    lines.push('');
  }

  return lines.join('\n');
}

// Main execution
const args = process.argv.slice(2);
if (args.length !== 1) {
  console.error('Usage: npx tsx audit-eventbus-sse.ts <src-dir>');
  process.exit(1);
}

const srcDir = path.resolve(args[0]);
if (!fs.existsSync(srcDir)) {
  console.error(`Error: Directory not found: ${srcDir}`);
  process.exit(1);
}

console.error(`🔌 Auditing EventBus/SSE architecture in ${srcDir}...`);

const files = getAllTypeScriptFiles(srcDir);
const allViolations: Violation[] = [];

for (const file of files) {
  const violations = scanFile(file);
  allViolations.push(...violations);
}

const report = generateReport(allViolations);

// Output report to stdout
console.log(report);

// Exit with error code if violations found
process.exit(allViolations.length > 0 ? 1 : 0);
