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

      // Track what we find
      const interactiveSelectors = new Set();
      const animatedSelectors = new Set();
      const selectorsWithFocus = new Set();
      const outlineRemovals = new Set();
      let hasAnimations = false;

      // Walk all rules
      root.walkRules((rule) => {
        const selector = rule.selector;

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
        if (!selectorsWithFocus.has(selector) && !hasFocusStyles(selector, root)) {
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
      if (hasAnimations && !hasReducedMotionSupport(root)) {
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