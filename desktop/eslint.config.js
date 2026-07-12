import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // Bỏ qua build artifact / file sinh tự động / bundle vendored — KHÔNG phải source
  // của ta. Trước đây chỉ ignore 'dist' nên ESLint quét cả src-tauri/target (artifact
  // biên dịch Rust/Tauri) → hàng nghìn "Parsing error" rác làm nhiễu lint thật.
  globalIgnores([
    'dist',
    'src-tauri/target',
    'src-tauri/gen',
    'public/websr.js',
  ]),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
])
