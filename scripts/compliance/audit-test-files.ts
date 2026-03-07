#!/usr/bin/env tsx
/**
 * Audit test files for composition-based testing compliance
 *
 * Checks for:
 * - vi.mock() usage for React components (should use real components)
 * - vi.spyOn() usage on EventBus methods (should use EventTracker)
 * - EventTracker pattern usage
 * - Appropriate vs inappropriate mocking patterns
 */

import * as ts from 'typescript';
import * as fs from 'fs';

export interface TestFileAnalysis {
  filePath: string;
  mocksComponents: boolean;
  componentMocks: string[];
  spiesOnEventBus: boolean;
  eventBusSpies: string[];
  usesEventTracker: boolean;
  mockedTypes: {
    hooks: string[];
    components: string[];
    apis: string[];
    browserAPIs: string[];
    utilities: string[];
  };
  issues: string[];
}

export class TestFileAuditor {
  analyzeTestFile(filePath: string): TestFileAnalysis {
    const sourceFile = ts.createSourceFile(
      filePath,
      fs.readFileSync(filePath, 'utf-8'),
      ts.ScriptTarget.Latest,
      true
    );

    const analysis: TestFileAnalysis = {
      filePath,
      mocksComponents: false,
      componentMocks: [],
      spiesOnEventBus: false,
      eventBusSpies: [],
      usesEventTracker: false,
      mockedTypes: {
        hooks: [],
        components: [],
        apis: [],
        browserAPIs: [],
        utilities: []
      },
      issues: []
    };

    this.analyzeSourceFile(sourceFile, analysis);

    // Determine if mocks components
    analysis.mocksComponents = analysis.mockedTypes.components.length > 0;

    // Generate issues
    if (analysis.mocksComponents) {
      analysis.issues.push(`❌ Mocks React components: ${analysis.mockedTypes.components.join(', ')} (use real components instead)`);
    }

    if (analysis.spiesOnEventBus) {
      analysis.issues.push(`❌ Spies on EventBus methods: ${analysis.eventBusSpies.join(', ')} (use EventTracker pattern instead)`);
    }

    return analysis;
  }

  private analyzeSourceFile(sourceFile: ts.SourceFile, analysis: TestFileAnalysis) {
    const visit = (node: ts.Node) => {
      // Check for createEventTracker usage
      if (ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'createEventTracker') {
        analysis.usesEventTracker = true;
      }

      // Check for EventTrackingWrapper usage
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tagName = node.tagName;
        if (ts.isIdentifier(tagName) && tagName.text === 'EventTrackingWrapper') {
          analysis.usesEventTracker = true;
        }
      }

      // Check for vi.mock() calls
      if (ts.isCallExpression(node)) {
        const viMock = this.detectViMock(node);
        if (viMock.isMock) {
          const mockType = this.classifyMock(viMock.target);
          this.addMockToType(analysis, mockType, viMock.target);
        }

        const viSpyOn = this.detectViSpyOn(node);
        if (viSpyOn.isSpy) {
          analysis.eventBusSpies.push(viSpyOn.target);
          analysis.spiesOnEventBus = true;
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  private detectViMock(node: ts.CallExpression): { isMock: boolean, target: string } {
    // Look for vi.mock('module-path', ...)
    const expr = node.expression;
    if (ts.isPropertyAccessExpression(expr) &&
        ts.isIdentifier(expr.expression) &&
        expr.expression.text === 'vi' &&
        expr.name.text === 'mock') {

      if (node.arguments.length > 0) {
        const moduleArg = node.arguments[0];
        if (ts.isStringLiteral(moduleArg)) {
          return { isMock: true, target: moduleArg.text };
        }
      }
    }

    return { isMock: false, target: '' };
  }

  private detectViSpyOn(node: ts.CallExpression): { isSpy: boolean, target: string } {
    // Look for vi.spyOn(eventBus, 'emit'|'on'|'off')
    const expr = node.expression;
    if (ts.isPropertyAccessExpression(expr) &&
        ts.isIdentifier(expr.expression) &&
        expr.expression.text === 'vi' &&
        expr.name.text === 'spyOn') {

      if (node.arguments.length >= 2) {
        const targetArg = node.arguments[0];
        const methodArg = node.arguments[1];

        if (ts.isIdentifier(targetArg) && targetArg.text === 'eventBus' &&
            ts.isStringLiteral(methodArg)) {
          const method = methodArg.text;
          if (['emit', 'on', 'off'].includes(method)) {
            return { isSpy: true, target: `eventBus.${method}` };
          }
        }
      }
    }

    return { isSpy: false, target: '' };
  }

  private classifyMock(target: string): 'hook' | 'component' | 'api' | 'browserAPI' | 'utility' {
    // Hooks: start with 'use' or path includes '/hooks/'
    if (target.match(/\/use[A-Z]/) || target.includes('/hooks/')) {
      return 'hook';
    }

    // Browser APIs
    if (target.match(/^(window|document|navigator|localStorage|sessionStorage)/)) {
      return 'browserAPI';
    }

    // External APIs (fetch, axios, etc.)
    if (target.match(/(fetch|axios|api-client|@semiont\/api-client)/)) {
      return 'api';
    }

    // Components: relative imports from parent directories (../) that are capitalized
    // or path includes '/components/'
    if (target.match(/^\.\.\/.*[A-Z]/) || target.includes('/components/')) {
      return 'component';
    }

    // Default to utility
    return 'utility';
  }

  private addMockToType(
    analysis: TestFileAnalysis,
    type: 'hook' | 'component' | 'api' | 'browserAPI' | 'utility',
    target: string
  ) {
    // Extract just the file/module name from the path
    const name = target.split('/').pop() || target;

    // Ensure the array exists before checking
    if (!analysis.mockedTypes[type]) {
      analysis.mockedTypes[type] = [];
    }

    if (!analysis.mockedTypes[type].includes(name)) {
      analysis.mockedTypes[type].push(name);
    }
  }
}

// Main execution
function main() {
  const auditor = new TestFileAuditor();

  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: tsx audit-test-files.ts <test-file-path>');
    process.exit(1);
  }

  const filePath = args[0];

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const result = auditor.analyzeTestFile(filePath);

  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}
