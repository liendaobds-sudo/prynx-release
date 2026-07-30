// ============================================================
// [VARIANT 2026-07-29]
// Config RIÊNG cho các script sinh dữ liệu (generator), tách khỏi
// `vitest.config.ts` để `npm run test` không bao giờ ghi tệp ra repo.
//
// Chạy: npm run gen:variant-thumbs
// ============================================================

import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
    test: {
        globals: true,
        include: ['scripts/gen/*.gen.ts'],
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
});
