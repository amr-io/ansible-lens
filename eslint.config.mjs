import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/coverage/**',
      '**/*.js',
      '**/*.cjs',
      '**/*.mjs',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ['packages/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-empty': ['error', { allowEmptyCatch: false }],
    },
  },
  {
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: ['vscode', 'vscode-*'],
        },
      ],
    },
  },
);
