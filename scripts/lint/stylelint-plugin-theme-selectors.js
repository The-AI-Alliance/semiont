/**
 * Custom Stylelint plugin to enforce theme selector best practices
 *
 * Rules:
 * 1. Warns against :root:not([data-theme="light"]) pattern
 * 2. Ensures dark theme selectors use [data-theme="dark"]
 * 3. Catches duplicate selectors after dark theme selectors
 */

const stylelint = require('stylelint');
const { report, ruleMessages, validateOptions } = stylelint.utils;

const ruleName = 'semiont/theme-selectors';
const messages = ruleMessages(ruleName, {
  avoidRootNot: 'Avoid ":root:not([data-theme=\\"light\\"])" - use "[data-theme=\\"dark\\"]" instead',
  duplicateSelector: (selector) => `Duplicate selector "${selector}" after dark theme selector`,
  nestedSelectorInPlainCSS: 'Nested "&" selectors are not valid in plain CSS files',
});

const plugin = stylelint.createPlugin(ruleName, (primaryOption, secondaryOptions, context) => {
  return (root, result) => {
    const validOptions = validateOptions(result, ruleName, {
      actual: primaryOption,
      possible: [true, false],
    });

    if (!validOptions || !primaryOption) {
      return;
    }

    let previousRule = null;

    root.walkRules((rule) => {
      // Check for :root:not([data-theme="light"]) pattern
      if (rule.selector.includes(':root:not([data-theme="light"])')) {
        report({
          message: messages.avoidRootNot,
          node: rule,
          result,
          ruleName,
        });
      }

      // Check for nested & selectors in plain CSS
      if (rule.selector.includes('&')) {
        report({
          message: messages.nestedSelectorInPlainCSS,
          node: rule,
          result,
          ruleName,
        });
      }

      // Skip duplicate checking for rules inside media queries
      const isInsideMediaQuery = rule.parent && rule.parent.type === 'atrule' && rule.parent.name === 'media';

      // Check for duplicate selectors after dark theme selectors
      if (!isInsideMediaQuery &&
          previousRule &&
          previousRule.selector.startsWith('[data-theme="dark"]') &&
          !rule.selector.startsWith('[data-theme="dark"]')) {

        // Extract the base selector from both
        const prevBase = previousRule.selector.replace(/^\[data-theme="dark"\]\s*/, '').trim();
        const currBase = rule.selector.trim();

        if (prevBase === currBase) {
          report({
            message: messages.duplicateSelector(currBase),
            node: rule,
            result,
            ruleName,
          });
        }
      }

      // Only track previousRule if not inside media query
      if (!isInsideMediaQuery) {
        previousRule = rule;
      }
    });
  };
});

plugin.ruleName = ruleName;
plugin.messages = messages;

module.exports = plugin;