#!/usr/bin/env ts-node
/**
 * Audit React Hooks ordering violations using TypeScript AST analysis
 *
 * Detects:
 * 1. Inline hooks in conditional JSX (the killer pattern from ResourceViewer bug)
 * 2. Multiple useEventSubscriptions calls (should be combined into one)
 */

import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';

interface HookViolation {
  filePath: string;
  line: number;
  column: number;
  hookName: string;
  violation: 'inline-hook-in-conditional' | 'multiple-event-subscriptions';
  message: string;
  fix: string;
}

class HooksOrderingAuditor {
  private violations: HookViolation[] = [];

  /**
   * Check if a node is a hook call (starts with 'use' and is uppercase next char)
   */
  private isHookCall(node: ts.Node): boolean {
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (ts.isIdentifier(expr)) {
        const name = expr.text;
        return /^use[A-Z]/.test(name);
      }
    }
    return false;
  }

  /**
   * Get the hook name from a call expression
   */
  private getHookName(node: ts.CallExpression): string | null {
    if (ts.isIdentifier(node.expression)) {
      return node.expression.text;
    }
    return null;
  }

  /**
   * Check if node is inside a conditional expression (ternary or logical &&)
   */
  private isInConditionalJSX(node: ts.Node, sourceFile: ts.SourceFile): boolean {
    let current: ts.Node | undefined = node;

    while (current) {
      // Check for ternary (ConditionalExpression)
      if (ts.isConditionalExpression(current)) {
        return true;
      }

      // Check for logical && in JSX
      if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        return true;
      }

      current = current.parent;
    }

    return false;
  }

  /**
   * Check if a hook call is inline as a JSX prop value
   */
  private isInlineJSXProp(node: ts.CallExpression): boolean {
    let current: ts.Node | undefined = node;

    while (current) {
      // Check if we're in a JsxExpression (the {...} part of a JSX prop)
      if (ts.isJsxExpression(current)) {
        // Check if parent is JsxAttribute
        if (current.parent && ts.isJsxAttribute(current.parent)) {
          return true;
        }
      }
      current = current.parent;
    }

    return false;
  }

  /**
   * Visit all nodes in the AST to find violations
   */
  private visitNode(node: ts.Node, sourceFile: ts.SourceFile, filePath: string) {
    // Pattern 1: Inline hooks in conditional JSX
    if (this.isHookCall(node) && ts.isCallExpression(node)) {
      const hookName = this.getHookName(node);

      if (this.isInlineJSXProp(node) && this.isInConditionalJSX(node, sourceFile)) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());

        this.violations.push({
          filePath,
          line: line + 1,
          column: character + 1,
          hookName: hookName || 'unknown',
          violation: 'inline-hook-in-conditional',
          message: `Hook ${hookName} called inline as prop inside conditional render`,
          fix: 'Define hook before conditional, then reference it',
        });
      }
    }

    // Recurse into child nodes
    ts.forEachChild(node, child => this.visitNode(child, sourceFile, filePath));
  }

  /**
   * Count useEventSubscriptions calls in a file
   */
  private countEventSubscriptionCalls(sourceFile: ts.SourceFile): number {
    let count = 0;

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression) && node.expression.text === 'useEventSubscriptions') {
          count++;
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return count;
  }

  /**
   * Analyze a single file
   */
  analyzeFile(filePath: string): void {
    if (!fs.existsSync(filePath)) {
      return;
    }

    const sourceCode = fs.readFileSync(filePath, 'utf-8');
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceCode,
      ts.ScriptTarget.Latest,
      true
    );

    // Pattern 1: Inline hooks in conditional JSX
    this.visitNode(sourceFile, sourceFile, filePath);

    // Pattern 2: Multiple useEventSubscriptions calls
    const subscriptionCount = this.countEventSubscriptionCalls(sourceFile);
    if (subscriptionCount > 1) {
      this.violations.push({
        filePath,
        line: 0,
        column: 0,
        hookName: 'useEventSubscriptions',
        violation: 'multiple-event-subscriptions',
        message: `Found ${subscriptionCount} calls to useEventSubscriptions (should be combined into one)`,
        fix: 'Combine all event subscriptions into a single useEventSubscriptions call',
      });
    }
  }

  /**
   * Recursively find all .ts and .tsx files
   */
  private findSourceFiles(dir: string): string[] {
    const files: string[] = [];

    if (!fs.existsSync(dir)) {
      return files;
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      // Skip node_modules, dist, build, etc.
      if (entry.isDirectory()) {
        if (!['node_modules', 'dist', 'build', '.next', 'coverage'].includes(entry.name)) {
          files.push(...this.findSourceFiles(fullPath));
        }
      } else if (entry.isFile() && /\.(tsx?)$/.test(entry.name)) {
        // Skip test files
        if (!/\.(test|spec)\.(tsx?)$/.test(entry.name)) {
          files.push(fullPath);
        }
      }
    }

    return files;
  }

  /**
   * Analyze all files in directories
   */
  analyzeDirectories(dirs: string[]): void {
    for (const dir of dirs) {
      const files = this.findSourceFiles(dir);
      for (const file of files) {
        this.analyzeFile(file);
      }
    }
  }

  /**
   * Print violations report
   */
  printReport(): void {
    const errorViolations = this.violations.filter(v => v.violation === 'inline-hook-in-conditional');
    const warningViolations = this.violations.filter(v => v.violation === 'multiple-event-subscriptions');

    console.log('🔍 React Hooks Ordering Compliance Report');
    console.log('=========================================\n');

    if (errorViolations.length === 0 && warningViolations.length === 0) {
      console.log('✅ No React Hooks ordering violations found\n');
      return;
    }

    // Errors
    if (errorViolations.length > 0) {
      console.log(`❌ ERRORS (${errorViolations.length}):\n`);

      for (const violation of errorViolations) {
        console.log(`  ${violation.filePath}:${violation.line}:${violation.column}`);
        console.log(`    Hook: ${violation.hookName}`);
        console.log(`    Problem: ${violation.message}`);
        console.log(`    Fix: ${violation.fix}\n`);
      }
    }

    // Warnings
    if (warningViolations.length > 0) {
      console.log(`⚠️  WARNINGS (${warningViolations.length}):\n`);

      for (const violation of warningViolations) {
        console.log(`  ${violation.filePath}`);
        console.log(`    Problem: ${violation.message}`);
        console.log(`    Fix: ${violation.fix}\n`);
      }
    }

    // Summary
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Total: ${errorViolations.length} error(s), ${warningViolations.length} warning(s)\n`);

    if (errorViolations.length > 0) {
      console.log('React Hooks Rules:');
      console.log('  1. Only call hooks at the top level (not in loops, conditions, or nested functions)');
      console.log('  2. Only call hooks from React function components or custom hooks');
      console.log('  3. Call hooks in the same order on every render\n');

      console.log('Common violations:');
      console.log('  - Inline hooks in conditional JSX: prop={useCallback(...)} inside ternary');
      console.log('  - Multiple useEventSubscriptions calls (should be combined into one)\n');

      process.exit(1);
    }
  }

  /**
   * Get violations for programmatic access
   */
  getViolations(): HookViolation[] {
    return this.violations;
  }
}

// CLI usage
if (require.main === module) {
  const auditor = new HooksOrderingAuditor();

  const repoRoot = path.resolve(__dirname, '../..');
  const dirs = [
    path.join(repoRoot, 'packages/react-ui/src'),
    path.join(repoRoot, 'apps/frontend/src'),
  ];

  auditor.analyzeDirectories(dirs);
  auditor.printReport();
}

export { HooksOrderingAuditor, HookViolation };
