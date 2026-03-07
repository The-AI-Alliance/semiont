#!/usr/bin/env node

/**
 * Check for utility-class frameworks in @semiont/react-ui
 *
 * This script scans TSX/JSX files in packages/react-ui/src for utility-class patterns from:
 * - Tailwind CSS
 * - UnoCSS
 * - Tachyons
 * - Bootstrap utilities
 * - Windi CSS
 *
 * It's designed to enforce the "NO UTILITY FRAMEWORKS in react-ui" policy.
 * Only semantic BEM CSS classes (prefixed with semiont-) are allowed.
 *
 * Exit codes:
 *   0 - No utility classes found
 *   1 - Utility classes found (with details)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Common utility-class patterns from various frameworks
// These patterns are shared across Tailwind, UnoCSS, Windi, Tachyons, Bootstrap, and others
const UTILITY_CLASS_PATTERNS = [
  // Layout & Flexbox
  { pattern: /\b(flex-row|flex-col|flex-wrap|flex-nowrap)\b/, name: 'flex direction/wrap' },
  { pattern: /\b(items-start|items-end|items-center|items-baseline|items-stretch)\b/, name: 'items alignment' },
  { pattern: /\b(justify-start|justify-end|justify-center|justify-between|justify-around|justify-evenly)\b/, name: 'justify content' },
  { pattern: /\bgap-\d+\b/, name: 'gap spacing' },
  { pattern: /\bspace-[xy]-\d+\b/, name: 'space between' },

  // Spacing
  { pattern: /\b(p|px|py|pt|pb|pl|pr)-\d+\b/, name: 'padding' },
  { pattern: /\b(m|mx|my|mt|mb|ml|mr)-\d+\b/, name: 'margin' },

  // Sizing
  { pattern: /\b(w|h|min-w|min-h|max-w|max-h)-\d+\b/, name: 'width/height' },
  { pattern: /\b(w|h|min-w|min-h|max-w|max-h)-(full|screen|min|max|fit)\b/, name: 'width/height keywords' },
  { pattern: /\b(w|h)-\[[\d.]+[a-z%]+\]\b/, name: 'arbitrary width/height' },
  { pattern: /\bmax-w-\[[\d.]+[a-z]+\]\b/, name: 'arbitrary max-width' },

  // Typography
  { pattern: /\btext-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)\b/, name: 'text size' },
  { pattern: /\bfont-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)\b/, name: 'font weight' },
  { pattern: /\bline-clamp-\d+\b/, name: 'line clamp' },

  // Colors - most common
  { pattern: /\btext-gray-\d+\b/, name: 'text gray color' },
  { pattern: /\bbg-gray-\d+\b/, name: 'background gray color' },
  { pattern: /\bborder-gray-\d+\b/, name: 'border gray color' },
  { pattern: /\btext-(blue|green|red|yellow|purple|pink)-\d+\b/, name: 'text color' },
  { pattern: /\bbg-(blue|green|red|yellow|purple|pink)-\d+\b/, name: 'background color' },
  { pattern: /\bbg-white\b/, name: 'bg-white' },
  { pattern: /\bbg-black\b/, name: 'bg-black' },
  { pattern: /\btext-white\b/, name: 'text-white' },

  // Borders & Rounded
  { pattern: /\brounded(-[trbl])?(-[trbl][lr])?-(sm|md|lg|xl|2xl|3xl|full|none)?\b/, name: 'rounded corners' },
  { pattern: /\bborder-\d+\b/, name: 'border width' },

  // Effects
  { pattern: /\bshadow(-sm|-md|-lg|-xl|-2xl|-inner|-none)?\b/, name: 'shadow' },
  { pattern: /\bbackdrop-blur(-sm|-md|-lg|-xl)?\b/, name: 'backdrop blur' },

  // Positioning
  { pattern: /\bfixed\b/, name: 'fixed positioning' },
  { pattern: /\babsolute\b/, name: 'absolute positioning' },
  { pattern: /\binset-\d+\b/, name: 'inset' },
  { pattern: /\bz-\[[\d]+\]\b/, name: 'arbitrary z-index' },

  // Dark mode
  { pattern: /\bdark:[a-z-]+\b/, name: 'dark mode variant' },

  // Hover states
  { pattern: /\bhover:(bg|text|border)-[a-z-]+\b/, name: 'hover state' },

  // Transitions
  { pattern: /\btransition(-all|-colors|-opacity|-shadow|-transform)?\b/, name: 'transition' },

  // Bootstrap-specific utilities
  { pattern: /\b(d-flex|d-block|d-none|d-inline|d-inline-block)\b/, name: 'Bootstrap display' },
  { pattern: /\b(justify-content-(start|end|center|between|around))\b/, name: 'Bootstrap justify' },
  { pattern: /\b(align-items-(start|end|center|baseline|stretch))\b/, name: 'Bootstrap align' },
  { pattern: /\b(m|p)[trblxy]?-\d\b/, name: 'Bootstrap spacing' },
  { pattern: /\b(text|bg)-(primary|secondary|success|danger|warning|info|light|dark|muted)\b/, name: 'Bootstrap colors' },

  // Tachyons-specific classes
  { pattern: /\b(f[1-7]|fw[1-9])\b/, name: 'Tachyons typography' },
  { pattern: /\b(ma|pa|na)[0-7]\b/, name: 'Tachyons spacing' },
  { pattern: /\b(db|dib|dn|di)\b/, name: 'Tachyons display' },
  { pattern: /\b(fl|fr|fn)\b/, name: 'Tachyons floats' },
  { pattern: /\b(tc|tl|tr|tj)\b/, name: 'Tachyons text-align' },
];

/**
 * Extract className values from a file and return matches with line numbers
 */
function checkFileForUtilityClasses(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const violations = [];

  lines.forEach((line, lineIndex) => {
    // Match className="..." or className={...}
    const classNameRegex = /className\s*=\s*(?:"([^"]*)"|{`?([^}`]*)`?})/g;

    let match;
    while ((match = classNameRegex.exec(line)) !== null) {
      const className = match[1] || match[2];
      if (!className) continue;

      // Split className into individual classes and check each one
      const classes = className.split(/\s+/).filter(c => c.trim());

      for (const cls of classes) {
        // Skip semiont- prefixed classes (our BEM classes)
        if (cls.startsWith('semiont-')) continue;

        // Check each utility-class pattern
        for (const { pattern, name } of UTILITY_CLASS_PATTERNS) {
          if (pattern.test(cls)) {
            violations.push({
              file: filePath,
              line: lineIndex + 1,
              pattern: name,
              className: className.substring(0, 100) // Limit length
            });
            break; // Only report first match per line
          }
        }

        // Break after finding first violation in this className
        if (violations.length > 0 && violations[violations.length - 1].line === lineIndex + 1) {
          break;
        }
      }
    }
  });

  return violations;
}

/**
 * Find all TSX/JSX files in react-ui/src
 */
function findReactUIFiles() {
  const reactUiSrc = path.join(__dirname, '../packages/react-ui/src');

  if (!fs.existsSync(reactUiSrc)) {
    console.error('Error: packages/react-ui/src not found');
    process.exit(1);
  }

  try {
    // Use find to get all tsx/jsx files, excluding tests
    const cmd = `find "${reactUiSrc}" -type f \\( -name "*.tsx" -o -name "*.jsx" \\) ! -path "*/node_modules/*" ! -path "*/__tests__/*" ! -name "*.test.*" ! -name "*.spec.*"`;
    const output = execSync(cmd, { encoding: 'utf8' });
    return output.trim().split('\n').filter(f => f);
  } catch (error) {
    console.error('Error finding files:', error.message);
    process.exit(1);
  }
}

/**
 * Main execution
 */
function main() {
  console.log('🔍 Checking for utility-class frameworks in @semiont/react-ui...\n');

  const files = findReactUIFiles();
  console.log(`Scanning ${files.length} files...`);

  const allViolations = [];

  for (const file of files) {
    const violations = checkFileForUtilityClasses(file);
    allViolations.push(...violations);
  }

  if (allViolations.length === 0) {
    console.log('\n✅ No utility-class framework patterns found in react-ui!');
    console.log('   The "NO UTILITY FRAMEWORKS" policy is being maintained.\n');
    process.exit(0);
  }

  // Group violations by file
  const byFile = {};
  for (const v of allViolations) {
    const relativePath = path.relative(process.cwd(), v.file);
    if (!byFile[relativePath]) {
      byFile[relativePath] = [];
    }
    byFile[relativePath].push(v);
  }

  console.log('\n❌ Found utility-class framework patterns in react-ui:\n');

  for (const [file, violations] of Object.entries(byFile)) {
    console.log(`📁 ${file}`);
    for (const v of violations) {
      console.log(`   Line ${v.line}: ${v.pattern} - className="${v.className}..."`);
    }
    console.log('');
  }

  console.log('⚠️  Utility-class frameworks (Tailwind, UnoCSS, Bootstrap utilities, etc.) are NOT allowed in @semiont/react-ui');
  console.log('   See REACT-UI-NO-TAILWIND.md for the policy and how to fix this.');
  console.log(`   Total violations: ${allViolations.length}\n`);

  process.exit(1);
}

main();
