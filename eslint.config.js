import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * One config for every current and future package. Globs, not a list of
 * directories, so a phone CLI or a study-pack package is covered the day it
 * appears under packages/* or apps/*.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/target/**',
      'apps/desktop/src-tauri/**',
      'package-lock.json',
    ],
  },
  eslint.configs.recommended,
  {
    files: [
      'packages/*/src/**/*.ts',
      'packages/*/test/**/*.ts',
      'apps/*/src/**/*.ts',
      'apps/*/src/**/*.tsx',
    ],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Event handlers are arrow shorthands that call a void function. Braces on
      // every one of them add lines and catch nothing. The rule still flags a
      // void expression that is stored or returned from a block.
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
      // Chapter numbers, counts, and minutes are interpolated on purpose.
      // The preset forbids numbers too; that would wrap every one of them in
      // String() and hide nothing this codebase has gotten wrong. null, any,
      // and objects still fail, which is what prints "null" and "[object Object]".
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        {
          allowNumber: true,
          allowBoolean: false,
          allowAny: false,
          allowNullish: false,
          allowNever: false,
          allowRegExp: false,
        },
      ],
      // `as unknown as T` hid the text-node type. Annotation offsets index
      // Block.text, so a cast that reads the wrong field corrupts every highlight.
      'no-restricted-syntax': [
        'error',
        {
          // `JSON.parse(...) as unknown` is the safe direction: any becomes unknown.
          // `as unknown as T` is the cast that skips the narrowing. Only the
          // second one is banned.
          selector: 'TSAsExpression > TSAsExpression > TSUnknownKeyword',
          message:
            'Do not cast through unknown to another type. Stop at unknown and narrow with a type guard.',
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
  prettier,
);
