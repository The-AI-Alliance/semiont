const stylelint = require('stylelint');
const { report, ruleMessages, validateOptions } = stylelint.utils;

const ruleName = 'semiont/invariants';
const messages = ruleMessages(ruleName, {
  tailwindClass: (className) => `Tailwind utility class "${className}" detected. Use semantic CSS classes instead.`,
  invalidPrefix: (className) => `Class "${className}" doesn't follow semiont- naming convention in react-ui package.`,
  missingDarkTheme: (selector) => `Missing dark theme variant for "${selector}". Add [data-theme="dark"] variant.`,
  hardcodedColor: (value) => `Hardcoded color "${value}" detected. Use CSS variables instead.`,
  invalidThemeSelector: (selector) => `Invalid theme selector "${selector}". Use [data-theme="dark"] instead of :root:not([data-theme="light"]).`,
});

// Comprehensive list of Tailwind utility patterns
const TAILWIND_PATTERNS = [
  // Spacing
  /^(p|m)(t|r|b|l|x|y)?-\d+$/,
  /^space-(x|y)-\d+$/,
  /^gap-\d+$/,

  // Sizing
  /^(w|h)-(full|\d+|auto|screen|min|max|fit)$/,
  /^(min|max)-(w|h)-\d+$/,

  // Typography
  /^text-(xs|sm|base|lg|xl|\dxl|left|center|right|justify)$/,
  /^font-(thin|light|normal|medium|semibold|bold|extrabold|black)$/,
  /^leading-\d+$/,
  /^tracking-(tighter|tight|normal|wide|wider|widest)$/,

  // Colors
  /^(text|bg|border)-(white|black|gray|red|yellow|green|blue|indigo|purple|pink|cyan|orange|amber|lime|emerald|teal|sky|violet|fuchsia|rose)-\d+$/,
  /^(text|bg|border)-(current|transparent|inherit)$/,

  // Borders
  /^border(-\d+)?$/,
  /^rounded(-\w+)?$/,
  /^border-(t|r|b|l)(-\d+)?$/,

  // Display & Position
  /^(block|inline-block|inline|flex|grid|hidden)$/,
  /^(static|fixed|absolute|relative|sticky)$/,
  /^(top|right|bottom|left|inset)-(auto|\d+)$/,

  // Flexbox & Grid
  /^flex-(row|col|wrap|nowrap|\d|auto|initial|none|grow|shrink)$/,
  /^(justify|items|content)-(start|end|center|between|around|evenly)$/,
  /^grid-(cols|rows)-\d+$/,
  /^col-span-\d+$/,
  /^row-span-\d+$/,

  // Effects
  /^opacity-\d+$/,
  /^shadow(-\w+)?$/,
  /^blur(-\w+)?$/,

  // Transforms & Animations
  /^(scale|rotate|translate)-(x|y)?-?\d+$/,
  /^transform(-gpu)?$/,
  /^transition(-\w+)?$/,
  /^duration-\d+$/,
  /^ease-(linear|in|out|in-out)$/,
  /^animate-\w+$/,

  // States
  /^hover:\w+$/,
  /^focus:\w+$/,
  /^active:\w+$/,
  /^disabled:\w+$/,
  /^dark:\w+$/,

  // Other common utilities
  /^overflow-(auto|hidden|visible|scroll|x-auto|y-auto)$/,
  /^z-\d+$/,
  /^cursor-\w+$/,
  /^select-(none|text|all|auto)$/,
  /^sr-only$/,
  /^not-sr-only$/,
  /^pointer-events-(none|auto)$/,
  /^resize(-none|-y|-x)?$/,
  /^list-(none|disc|decimal)$/,
  /^appearance-none$/,
  /^outline-(none|white|black)$/,
  /^ring(-\d+)?$/,
  /^divide-(x|y)(-\d+)?$/,
  /^truncate$/,
  /^whitespace-(normal|nowrap|pre|pre-line|pre-wrap)$/,
  /^break-(normal|words|all)$/,
  /^decoration-(slice|clone)$/,

  // Special Tailwind classes
  /^container$/,
  /^prose$/,
  /^aspect-(auto|square|video|\w+)$/,
  /^backdrop-\w+$/,
  /^placeholder-\w+$/,

  // Prefixed utilities
  /^![\w-]+$/,  // Important prefix
  /^-[\w-]+$/,  // Negative values
];

// Check if a class is a Tailwind utility
function isTailwindClass(className) {
  return TAILWIND_PATTERNS.some(pattern => pattern.test(className));
}

// Check if we're in a react-ui package file
function isReactUIFile(filename) {
  return filename && filename.includes('packages/react-ui');
}

// Check if file should be skipped
function shouldSkipFile(filename) {
  const skipPatterns = [
    '.module.css',
    'variables.css',
    '.test.',
    '.stories.',
    'examples/',
    'mock',
    'status-display.css', // Has intentional status colors - TODO: refactor to use variables
    'toast.css', // Has intentional toast colors - TODO: refactor to use variables
  ];

  return skipPatterns.some(pattern => filename.includes(pattern));
}

// Check if a class follows semiont- naming convention
function isValidSemiontClass(className) {
  // Allow certain exceptions for legitimate non-semiont classes
  const exceptions = [
    'annotation-', // All annotation classes
    'red-underline',
    'sr-only', // Accessibility
    'cm-', // CodeMirror classes
    'md-', // Markdown classes
    'sidebar-navigation', // Sidebar navigation classes (including BEM variants)
    'quick-actions-widget',
    'animate-', // Animation classes
  ];

  // Check exceptions
  if (exceptions.some(exception => {
    if (exception.endsWith('-')) {
      return className.startsWith(exception);
    }
    // Allow BEM-style variants (e.g., sidebar-navigation__item)
    return className === exception || className.startsWith(exception + '__') || className.startsWith(exception + '--');
  })) {
    return true;
  }

  // Must start with semiont-
  return className.startsWith('semiont-');
}

// Check for hardcoded colors
function hasHardcodedColor(value) {
  const hardcodedPatterns = [
    /^#[0-9a-f]{3,6}$/i, // Hex colors
    /^rgb\(/i,
    /^rgba\(/i,
    /^hsl\(/i,
    /^hsla\(/i,
    // Named colors (except currentColor which is allowed)
    /^(red|blue|green|yellow|purple|pink|orange|gray|black|white|cyan|indigo|violet|teal|amber|lime|emerald|fuchsia|rose)$/i,
  ];

  // Allow certain color values
  const allowedValues = [
    'currentColor',
    'transparent',
    'inherit',
    'initial',
    'unset',
  ];

  if (allowedValues.includes(value)) {
    return false;
  }

  return hardcodedPatterns.some(pattern => pattern.test(value.trim()));
}

// Check if a property typically needs dark theme support
function needsDarkThemeSupport(prop) {
  const themeProperties = [
    'background-color',
    'color',
    'border-color',
    'outline-color',
    'box-shadow',
    'fill',
    'stroke',
  ];

  return themeProperties.includes(prop);
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
      const isReactUI = isReactUIFile(filename);

      // Skip files that shouldn't be checked
      if (shouldSkipFile(filename)) {
        return;
      }

      // Track selectors that have theme-specific properties
      const selectorsWithThemeProps = new Set();
      const selectorsWithDarkVariant = new Set();

      root.walkRules((rule) => {
        const selector = rule.selector;

        // Check for invalid theme selectors
        if (selector.includes(':root:not([data-theme="light"])')) {
          report({
            message: messages.invalidThemeSelector(selector),
            node: rule,
            result,
            ruleName,
          });
        }

        // Track dark theme variants
        if (selector.includes('[data-theme="dark"]')) {
          // Extract the base selector
          const baseSelector = selector.replace(/\[data-theme="dark"\]\s*/g, '').trim();
          selectorsWithDarkVariant.add(baseSelector);
        }

        // Check class names in selectors
        const classMatches = selector.matchAll(/\.([a-zA-Z0-9_-]+)/g);
        for (const match of classMatches) {
          const className = match[1];

          // Skip checking if this is a class definition (not usage)
          // We only want to check class usage in HTML/JSX, not CSS definitions

          // Check for Tailwind classes in react-ui (but sr-only is allowed as it's accessibility)
          if (isReactUI && isTailwindClass(className) && className !== 'sr-only') {
            report({
              message: messages.tailwindClass(className),
              node: rule,
              result,
              ruleName,
            });
          }

          // Check for proper semiont- prefix in react-ui
          if (isReactUI && !isValidSemiontClass(className)) {
            // Only report if it's not a dark theme selector variant
            if (!selector.includes('[data-theme="dark"]')) {
              report({
                message: messages.invalidPrefix(className),
                node: rule,
                result,
                ruleName,
              });
            }
          }
        }

        // Check properties that might need dark theme support
        rule.walkDecls((decl) => {
          const prop = decl.prop;
          const value = decl.value;

          // Check for hardcoded colors (except in gradients and rgba)
          if (isReactUI && !value.includes('gradient') && !value.includes('rgba') && !value.includes('rgb')) {
            if (hasHardcodedColor(value)) {
              report({
                message: messages.hardcodedColor(value),
                node: decl,
                result,
                ruleName,
              });
            }
          }

          // Track selectors with theme-sensitive properties
          if (needsDarkThemeSupport(prop) && !selector.includes('[data-theme="dark"]')) {
            selectorsWithThemeProps.add(selector);
          }
        });
      });

      // Check for missing dark theme variants (only for react-ui)
      if (isReactUI) {
        selectorsWithThemeProps.forEach((selector) => {
          // Skip if it's a general rule or already has a dark variant
          if (selector.includes(':root') ||
              selector.includes('[data-theme=') ||
              selector.includes('@media') ||
              selector.includes('@keyframes') ||
              selector.includes('::before') ||
              selector.includes('::after') ||
              selector.includes(':hover') ||
              selector.includes(':focus') ||
              selector.includes(':active') ||
              selector.includes(':disabled')) {
            return;
          }

          // Check if this selector has a corresponding dark variant
          if (!selectorsWithDarkVariant.has(selector)) {
            // Only warn for semiont- classes
            if (selector.includes('.semiont-')) {
              // Find the rule to report on
              root.walkRules((rule) => {
                if (rule.selector === selector) {
                  let hasThemeProperty = false;
                  rule.walkDecls((decl) => {
                    if (needsDarkThemeSupport(decl.prop)) {
                      hasThemeProperty = true;
                    }
                  });

                  if (hasThemeProperty) {
                    report({
                      message: messages.missingDarkTheme(selector),
                      node: rule,
                      result,
                      ruleName,
                      severity: 'warning', // Make this a warning, not an error
                    });
                  }
                }
              });
            }
          }
        });
      }
    };
  }
);

module.exports = plugin;
module.exports.ruleName = ruleName;
module.exports.messages = messages;