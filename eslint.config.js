import tseslint from 'typescript-eslint';

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    rules: {
      // The openclaw plugin API surface is untyped by upstream convention
      // (register(api: any)); banning `any` here would fight the SDK.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    ignores: ['**/dist/**', '**/node_modules/**', '.superpowers/**'],
  },
);
