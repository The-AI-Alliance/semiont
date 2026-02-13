#!/usr/bin/env ts-node
/**
 * Audit dependency arrays for compliance with ARCHITECTURE-TENETS.md
 *
 * Uses TypeScript Compiler API for precise AST analysis
 */

import * as ts from 'typescript';
import * as fs from 'fs';

interface HookAnalysis {
  filePath: string;
  hookName: string;
  usesEventBus: boolean;
  eventBusInDeps: boolean;
  usesClient: boolean;
  clientInDeps: boolean;
  acceptsCallbacks: boolean;
  callbacksInDeps: boolean;
  usesUseEventSubscriptions: boolean;
  hasInlineHandlers: boolean;
  dependencyCount: number;
  dependencies: string[];
  allDepsStable: boolean | null;
  issues: string[];
}

interface FileAnalysis {
  filePath: string;
  hooks: HookAnalysis[];
}

class DependencyArrayAuditor {
  analyzeFile(filePath: string): FileAnalysis {
    const sourceFile = ts.createSourceFile(
      filePath,
      fs.readFileSync(filePath, 'utf-8'),
      ts.ScriptTarget.Latest,
      true
    );

    const hooks: HookAnalysis[] = [];

    const visit = (node: ts.Node) => {
      // Look for function declarations/expressions that might be hooks
      if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
        const analysis = this.analyzeHook(node, filePath);
        if (analysis) {
          hooks.push(analysis);
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    return { filePath, hooks };
  }

  private analyzeHook(node: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction, filePath: string): HookAnalysis | null {
    // Get function name - handle variable declarations like "const useMyHook = () => {}"
    let hookName = 'anonymous';
    if (ts.isFunctionDeclaration(node) && node.name) {
      hookName = node.name.text;
    } else if (ts.isFunctionExpression(node) && node.name) {
      hookName = node.name.text;
    } else if (ts.isArrowFunction(node)) {
      // Check if this arrow function is assigned to a variable
      const parent = node.parent;
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        hookName = parent.name.text;
      } else if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
        hookName = parent.name.text;
      }
    }

    // Only analyze hooks (start with 'use') or components (start with capital)
    if (!hookName.startsWith('use') && !/^[A-Z]/.test(hookName)) {
      return null;
    }

    const analysis: HookAnalysis = {
      filePath,
      hookName,
      usesEventBus: false,
      eventBusInDeps: false,
      usesClient: false,
      clientInDeps: false,
      acceptsCallbacks: false,
      callbacksInDeps: false,
      usesUseEventSubscriptions: false,
      hasInlineHandlers: false,
      dependencyCount: 0,
      dependencies: [],
      allDepsStable: null,
      issues: []
    };

    // Analyze function body
    if (node.body && ts.isBlock(node.body)) {
      this.analyzeFunctionBody(node.body, analysis);
    }

    // Analyze parameters for callbacks
    if (node.parameters) {
      this.analyzeParameters(node.parameters, analysis);
    }

    return analysis;
  }

  private analyzeFunctionBody(body: ts.Block, analysis: HookAnalysis) {
    const allDeps: Set<string> = new Set();
    let hasAnyDeps = false;
    const callbacksStoredInRefs = new Set<string>();
    const localCallbacks = new Set<string>();

    const visit = (node: ts.Node) => {
      // Track locally-defined callbacks (useCallback, useMemo, or function declarations)
      if (ts.isVariableStatement(node)) {
        const declarations = node.declarationList.declarations;
        for (const decl of declarations) {
          if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
            const varName = decl.name.text;
            if (decl.initializer) {
              // Track useRef callbacks
              if (ts.isCallExpression(decl.initializer) &&
                  ts.isIdentifier(decl.initializer.expression) &&
                  decl.initializer.expression.text === 'useRef') {
                const arg = decl.initializer.arguments[0];
                if (arg && ts.isIdentifier(arg) && /^(on[A-Z]|handle[A-Z])/.test(arg.text)) {
                  callbacksStoredInRefs.add(arg.text);
                }
              }
              // Track useCallback/useMemo as local callbacks
              if (ts.isCallExpression(decl.initializer) &&
                  ts.isIdentifier(decl.initializer.expression) &&
                  ['useCallback', 'useMemo'].includes(decl.initializer.expression.text)) {
                localCallbacks.add(varName);
              }
            }
          }
        }
      }

      // Look for xxxRef.current = xxx; pattern
      if (ts.isExpressionStatement(node)) {
        const expr = node.expression;
        if (ts.isBinaryExpression(expr) &&
            expr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const left = expr.left;
          const right = expr.right;
          if (ts.isPropertyAccessExpression(left) &&
              left.name.text === 'current' &&
              ts.isIdentifier(right) &&
              /^(on[A-Z]|handle[A-Z])/.test(right.text)) {
            callbacksStoredInRefs.add(right.text);
          }
        }
      }

      // Look for useEffect, useCallback, useMemo calls
      if (ts.isCallExpression(node)) {
        const expr = node.expression;

        if (ts.isIdentifier(expr)) {
          const hookName = expr.text;

          // Check for useEventBus
          if (hookName === 'useEventBus') {
            analysis.usesEventBus = true;
          }

          // Check for useApiClient
          if (hookName === 'useApiClient') {
            analysis.usesClient = true;
          }

          // Check for useEventSubscriptions
          if (hookName === 'useEventSubscriptions') {
            analysis.usesUseEventSubscriptions = true;
            // Check if handlers are inline
            if (node.arguments.length > 0) {
              const arg = node.arguments[0];
              if (ts.isObjectLiteralExpression(arg)) {
                analysis.hasInlineHandlers = this.hasInlineArrowFunctions(arg);
              }
            }
          }

          // Analyze useEffect/useCallback/useMemo dependency arrays
          if (['useEffect', 'useCallback', 'useMemo', 'useEventOperations'].includes(hookName)) {
            const deps = this.extractDependencyArray(node);
            if (deps) {
              hasAnyDeps = true;
              deps.forEach(d => allDeps.add(d));

              // Check for violations
              if (deps.includes('eventBus')) {
                analysis.eventBusInDeps = true;
                analysis.issues.push('❌ eventBus in dependency array (global singleton)');
              }

              if (deps.includes('client')) {
                analysis.clientInDeps = true;
              }

              // Check for callback-like dependencies (functions starting with 'on')
              // Exclude local callbacks (defined via useCallback/useMemo) and callbacks stored in refs
              const callbacks = deps.filter(d => /^on[A-Z]/.test(d));
              const unsafeCallbacks = callbacks.filter(cb =>
                !callbacksStoredInRefs.has(cb) && !localCallbacks.has(cb)
              );
              if (unsafeCallbacks.length > 0) {
                analysis.callbacksInDeps = true;
                analysis.issues.push(`❌ Callback props in deps: ${unsafeCallbacks.join(', ')} (use events or refs instead)`);
              }
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(body);

    // Aggregate all dependencies found
    if (hasAnyDeps) {
      analysis.dependencies = Array.from(allDeps);
      analysis.dependencyCount = analysis.dependencies.length;
    }
  }

  private analyzeParameters(parameters: ts.NodeArray<ts.ParameterDeclaration>, analysis: HookAnalysis) {
    parameters.forEach(param => {
      if (param.type && ts.isTypeLiteralNode(param.type)) {
        param.type.members.forEach(member => {
          if (ts.isPropertySignature(member) && member.name && ts.isIdentifier(member.name)) {
            const propName = member.name.text;
            // Check for callback props (start with 'on')
            if (propName.startsWith('on') && member.type && this.isFunctionType(member.type)) {
              analysis.acceptsCallbacks = true;
            }
          }
        });
      }
    });
  }

  private extractDependencyArray(callExpr: ts.CallExpression): string[] | null {
    // Dependency array is typically the last argument
    const lastArg = callExpr.arguments[callExpr.arguments.length - 1];

    if (!lastArg || !ts.isArrayLiteralExpression(lastArg)) {
      return null;
    }

    return lastArg.elements.map(elem => {
      if (ts.isIdentifier(elem)) {
        return elem.text;
      }
      if (ts.isPropertyAccessExpression(elem)) {
        return elem.getText();
      }
      return elem.getText();
    });
  }

  private hasInlineArrowFunctions(obj: ts.ObjectLiteralExpression): boolean {
    for (const prop of obj.properties) {
      if (ts.isPropertyAssignment(prop)) {
        if (ts.isArrowFunction(prop.initializer) || ts.isFunctionExpression(prop.initializer)) {
          return true;
        }
      }
    }
    return false;
  }

  private isFunctionType(node: ts.TypeNode): boolean {
    return ts.isFunctionTypeNode(node);
  }
}

// Main execution
function main() {
  const auditor = new DependencyArrayAuditor();

  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: ts-node audit-dependency-arrays.ts <file-path>');
    process.exit(1);
  }

  const filePath = args[0];

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const result = auditor.analyzeFile(filePath);

  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

export { DependencyArrayAuditor };
export type { HookAnalysis, FileAnalysis };
