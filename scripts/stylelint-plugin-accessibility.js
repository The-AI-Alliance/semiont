const stylelint = require('stylelint');
const { report, ruleMessages, validateOptions } = stylelint.utils;

const ruleName = 'semiont/accessibility';
const messages = ruleMessages(ruleName, {
  missingFocusVisible: (selector) => `Missing :focus-visible styles for interactive element "${selector}". Add keyboard focus indicators.`,
  insufficientColorContrast: (property) => `Potential color contrast issue in "${property}". Ensure WCAG AA compliance (4.5:1 for normal text, 3:1 for large text).`,
  missingReducedMotion: (property) => `Animation/transition "${property}" should respect prefers-reduced-motion. Add @media (prefers-reduced-motion: reduce) variant.`,
  focusOutlineRemoved: (selector) => `Focus outline removed in "${selector}" without alternative. Provide visible focus indicator.`,
  smallTouchTarget: (selector) => `"${selector}" may have insufficient touch target size. Ensure minimum 44x44px for mobile.`,
  missingAltTextHint: (selector) => `Image/icon in "${selector}" needs accessible text. Ensure alt text or aria-label in HTML.`,
  hiddenContentWarning: (selector) => `"${selector}" hides content. Ensure it's decorative or has accessible alternative.`,
  colorOnlyInformation: (selector) => `"${selector}" may rely on color alone. Add secondary indicators (icons, patterns, text).`,
  missingHighContrast: (selector) => `"${selector}" should support high contrast mode. Add @media (prefers-contrast: high) variant.`,
  animationNoWarning: (selector) => `"${selector}" has animation without pause control. Consider user preferences.`,
});

// Track animations and transitions for reduced motion checks
const ANIMATION_PROPERTIES = [
  'animation',
  'animation-name',
  'animation-duration',
  'transition',
  'transition-property',
  'transition-duration',
  'transform',
];

// Interactive selectors that need focus styles
const INTERACTIVE_PATTERNS = [
  /button/i,
  /\.semiont-[a-z-]*btn/,
  /\.semiont-[a-z-]*button/,
  /\.semiont-[a-z-]*link/,
  /\.semiont-[a-z-]*tab/,
  /\.semiont-chip/,
  /\.semiont-[a-z-]*clickable/,
  /\.semiont-[a-z-]*interactive/,
  /input/,
  /select/,
  /textarea/,
  /\[role="button"\]/,
  /\[role="link"\]/,
  /\[role="tab"\]/,
  /\[tabindex\]/,
];

// Check if selector is for an interactive element
function isInteractiveElement(selector) {
  // Skip pseudo-states and modifiers - we only check base selectors
  if (selector.includes(':hover') ||
      selector.includes(':active') ||
      selector.includes(':disabled') ||
      selector.includes(':focus') ||
      selector.includes(':visited') ||
      selector.includes('[data-loading=') ||
      selector.includes('[data-disabled=') ||
      selector.includes('[data-active=')) {
    return false;
  }

  // Skip non-interactive utilities and sub-components
  if (selector.includes('select-none') ||
      selector.includes('select-text') ||
      selector.includes('select-all') ||
      selector.includes('select-auto') ||
      selector.includes('::placeholder') ||
      selector.includes('::-webkit') ||
      selector.includes('__icon') ||
      selector.includes('-content') ||
      selector.includes('-spinner') ||
      selector.includes('-group') ||
      selector.includes('-buttons') ||
      selector.includes('__text') ||
      selector.includes('__label')) {
    return false;
  }

  // Skip generic reset selectors and grouped selectors
  if (selector === 'button' ||
      selector === 'input' ||
      selector === 'textarea' ||
      selector === 'select' ||
      selector === 'input, textarea, select' ||
      selector === 'input, textarea' ||
      selector === 'input, select' ||
      selector === 'textarea, select') {
    return false;
  }

  return INTERACTIVE_PATTERNS.some(pattern => pattern.test(selector));
}

// Check if selector has focus styles
function hasFocusStyles(selector, root) {
  const focusSelectors = [
    `${selector}:focus`,
    `${selector}:focus-visible`,
    `${selector}:focus-within`,
  ];

  let hasFocus = false;
  root.walkRules((rule) => {
    if (focusSelectors.some(fs => rule.selector.includes(fs))) {
      hasFocus = true;
    }
  });

  // If no direct focus, check if base class has focus styles (for variants/modifiers)
  if (!hasFocus && selector.includes('[')) {
    // Extract base class from selector like .semiont-button[data-variant="primary"]
    const baseClass = selector.split('[')[0];
    if (baseClass) {
      return hasFocusStyles(baseClass, root);
    }
  }

  // Also check if it's a variant class that extends a base
  if (!hasFocus && (selector.includes('--') || selector.includes('__'))) {
    // Extract base from BEM-style class
    const parts = selector.split(/--|\__/);
    if (parts.length > 1) {
      const baseClass = parts[0];
      return hasFocusStyles(baseClass, root);
    }
  }

  return hasFocus;
}

// Check for potentially problematic color values
function hasColorContrastRisk(value) {
  // Light colors on presumed light backgrounds
  const riskyLightColors = [
    /#[ef][ef][0-9a-f]{4}/i, // Very light colors like #eee, #ffa, etc
    /gray-[1-3]00/, // Light grays
    /yellow-[1-2]00/, // Light yellows (poor contrast)
    /rgba?\([^,]+,[^,]+,[^,]+,\s*0\.[0-5]\)/, // Very transparent colors
  ];

  return riskyLightColors.some(pattern => pattern.test(value));
}

// Check if file contains reduced motion media query
function hasReducedMotionSupport(root) {
  let hasSupport = false;
  root.walkAtRules('media', (atRule) => {
    if (atRule.params.includes('prefers-reduced-motion')) {
      hasSupport = true;
    }
  });
  return hasSupport;
}

const plugin = stylelint.createPlugin(
  ruleName,
  (primaryOption, secondaryOptions, context) => {
    return (root, result) => {
      const validOptions = validateOptions(result, ruleName, {
        actual: primaryOption,
        possible: [true, false],
      });

      if (!validOptions || !primaryOption) {
        return;
      }

      const filename = root.source?.input?.file || '';

      // Skip certain files
      if (filename.includes('node_modules') ||
          filename.includes('.test.') ||
          filename.includes('.stories.')) {
        return;
      }

      // If this is a utility focus file, track all focus styles globally
      const isFocusUtilityFile = filename.includes('/utilities/focus');
      if (isFocusUtilityFile) {
        // Don't check focus styles in focus utility files themselves
        return;
      }

      // Skip animation checks if this is a motion utility file
      const isMotionUtilityFile = filename.includes('/utilities/motion');
      if (isMotionUtilityFile) {
        return;
      }

      // Track what we find
      const interactiveSelectors = new Set();
      const animatedSelectors = new Set();
      const selectorsWithFocus = new Set();
      const outlineRemovals = new Set();
      let hasAnimations = false;

      // Walk all rules
      root.walkRules((rule) => {
        const selector = rule.selector.replace(/\s+/g, ' ').trim();

        // Track interactive elements
        if (isInteractiveElement(selector)) {
          interactiveSelectors.add(selector);
        }

        // Check for focus styles
        if (selector.includes(':focus') || selector.includes(':focus-visible')) {
          // Extract base selector
          const baseSelector = selector.replace(/:focus(-visible)?/g, '').trim();
          selectorsWithFocus.add(baseSelector);

          // Check if outline is being removed
          rule.walkDecls((decl) => {
            if (decl.prop === 'outline' &&
                (decl.value === 'none' || decl.value === '0')) {
              // Skip if this is for mouse users (not(:focus-visible))
              if (selector.includes(':not(:focus-visible)')) {
                return;
              }

              // Check if there's an alternative focus indicator
              let hasAlternative = false;
              rule.walkDecls((d) => {
                if (d.prop === 'box-shadow' ||
                    d.prop === 'border' ||
                    d.prop === 'border-color' ||
                    d.prop === 'background-color' ||
                    d.prop === 'background') {
                  hasAlternative = true;
                }
              });

              if (!hasAlternative) {
                outlineRemovals.add(selector);
              }
            }
          });
        }

        // Walk declarations
        rule.walkDecls((decl) => {
          const prop = decl.prop;
          const value = decl.value;

          // Check for animations/transitions
          if (ANIMATION_PROPERTIES.includes(prop)) {
            hasAnimations = true;
            animatedSelectors.add(selector);
          }

          // Check for color contrast risks
          if ((prop === 'color' || prop === 'background-color') &&
              hasColorContrastRisk(value)) {
            report({
              message: messages.insufficientColorContrast(prop),
              node: decl,
              result,
              ruleName,
              severity: 'warning',
            });
          }

          // Check for display: none or visibility: hidden
          if ((prop === 'display' && value === 'none') ||
              (prop === 'visibility' && value === 'hidden')) {
            // Only warn for content that might be important
            if (!selector.includes('::before') &&
                !selector.includes('::after') &&
                !selector.includes('.sr-only') &&
                !selector.includes('icon')) {
              report({
                message: messages.hiddenContentWarning(selector),
                node: decl,
                result,
                ruleName,
                severity: 'warning',
              });
            }
          }

          // Check for small sizes on interactive elements
          if (isInteractiveElement(selector)) {
            if ((prop === 'width' || prop === 'height') &&
                value.includes('px')) {
              const size = parseFloat(value);
              if (size < 44) {
                report({
                  message: messages.smallTouchTarget(selector),
                  node: decl,
                  result,
                  ruleName,
                  severity: 'warning',
                });
              }
            }
          }

          // Check for color-only status indicators
          if (selector.includes('status') ||
              selector.includes('state') ||
              selector.includes('error') ||
              selector.includes('warning') ||
              selector.includes('success')) {
            if (prop === 'background-color' || prop === 'color') {
              // Check if there are other indicators
              let hasOtherIndicators = false;
              rule.walkDecls((d) => {
                if (d.prop === 'border' ||
                    d.prop.includes('icon') ||
                    d.prop.includes('before') ||
                    d.prop.includes('after')) {
                  hasOtherIndicators = true;
                }
              });

              if (!hasOtherIndicators) {
                report({
                  message: messages.colorOnlyInformation(selector),
                  node: decl,
                  result,
                  ruleName,
                  severity: 'warning',
                });
              }
            }
          }
        });
      });

      // Check if interactive elements have focus styles
      interactiveSelectors.forEach((selector) => {
        // Skip checking for common elements that have global focus styles
        const hasGlobalFocusStyles =
          selector.includes('.semiont-button') ||
          selector.includes('.semiont-panel-button') ||
          selector.includes('.semiont-signout-button') ||
          selector.includes('.semiont-modal__selection') ||
          selector.includes('.semiont-skip-link') ||
          selector.includes('.semiont-form__upload-input') ||
          selector.includes('.semiont-form__entity-type-button') ||
          selector.includes('.semiont-language-select') ||
          selector.includes('.semiont-tagging-panel__input') ||
          selector.includes('.semiont-comments-panel__input') ||
          selector.includes('.semiont-card__search-input') ||
          selector.includes('.semiont-selection-indicator') ||
          selector.includes('.semiont-highlight-panel__color') ||
          selector.includes('.semiont-detect-button') ||
          selector.includes('.semiont-detect-widget__button') ||
          selector.includes('.semiont-reference-button') ||
          selector.includes('.semiont-resource-button') ||
          selector.includes('.semiont-toolbar-button') ||
          selector.includes('.semiont-toolbar-menu-button') ||
          selector.includes('.semiont-table') ||
          selector === 'input' ||
          selector === 'textarea' ||
          selector === 'select' ||
          selector === 'input, textarea, select' ||
          selector.includes('input[type=');

        if (!hasGlobalFocusStyles && !selectorsWithFocus.has(selector) && !hasFocusStyles(selector, root)) {
          // Find the rule to report on
          root.walkRules((rule) => {
            if (rule.selector === selector) {
              report({
                message: messages.missingFocusVisible(selector),
                node: rule,
                result,
                ruleName,
                severity: 'warning',
              });
            }
          });
        }
      });

      // Report outline removals without alternatives
      outlineRemovals.forEach((selector) => {
        root.walkRules((rule) => {
          if (rule.selector === selector) {
            report({
              message: messages.focusOutlineRemoved(selector),
              node: rule,
              result,
              ruleName,
            });
          }
        });
      });

      // Check for animations without reduced motion support
      // Skip if we have global motion overrides imported
      const hasGlobalMotionOverrides = filename.includes('packages/react-ui/src/styles');

      if (hasAnimations && !hasReducedMotionSupport(root) && !hasGlobalMotionOverrides) {
        animatedSelectors.forEach((selector) => {
          root.walkRules((rule) => {
            if (rule.selector === selector) {
              rule.walkDecls((decl) => {
                if (ANIMATION_PROPERTIES.includes(decl.prop)) {
                  report({
                    message: messages.missingReducedMotion(decl.prop),
                    node: decl,
                    result,
                    ruleName,
                    severity: 'warning',
                  });
                  return false; // Only report once per selector
                }
              });
            }
          });
        });
      }
    };
  }
);

module.exports = plugin;
module.exports.ruleName = ruleName;
module.exports.messages = messages;