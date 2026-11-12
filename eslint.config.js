// ESLint flat config: recommended rules + a few hygiene rules.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'docs/design/**', 'coverage/**'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always'],
      'no-implicit-coercion': ['error', { allow: ['!!'] }],
      'object-shorthand': 'error',
      'no-console': 'error',
    },
  },
  // Server, scripts and tests run in Node.
  { files: ['src/**', 'scripts/**', 'test/**', 'e2e/**', '*.js'], languageOptions: { globals: globals.node } },
  // Browser code (and the shared module used by both).
  { files: ['public/**'], languageOptions: { globals: globals.browser } },
  { files: ['public/sw.js'], languageOptions: { globals: globals.serviceworker } },
  { files: ['public/js/theme-boot.js'], languageOptions: { sourceType: 'script' }, rules: { 'no-var': 'off' } },
  { files: ['scripts/*.cjs'], languageOptions: { sourceType: 'commonjs', globals: globals.node } },
  // CLIs legitimately print to the console.
  { files: ['scripts/**', 'src/config.js'], rules: { 'no-console': 'off' } },
  // e2e page.evaluate callbacks run in the browser.
  { files: ['e2e/**'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
];
