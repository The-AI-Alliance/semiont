# scripts/lint — Linting and Style Enforcement

Stylelint plugins and CSS checks. Referenced by `.stylelintrc.json` — typically
not called directly.

## Scripts

| Script | Purpose |
|--------|---------|
| `stylelint-plugin-accessibility.js` | WCAG accessibility rules |
| `stylelint-plugin-semiont-invariants.js` | Semiont CSS invariant enforcement |
| `stylelint-plugin-theme-selectors.js` | Theme selector best practices |
| `check-css-invariants.sh` | CSS invariant checks |
| `check-no-utility-classes-in-react-ui.js` | Enforce no utility-class frameworks in react-ui |

## Usage

```bash
npm run lint:css                   # Run stylelint (uses plugins automatically)
npm run lint:css:fix               # Run stylelint with auto-fix
npm run lint:no-utility-classes    # Check for utility-class frameworks
```
