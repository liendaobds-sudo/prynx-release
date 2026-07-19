import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
    publicDir: false,
    build: {
        emptyOutDir: true,
        lib: {
            entry: resolve(__dirname, 'src/lib/dieline/sidecarEntry.ts'),
            name: 'PrynXDielineNative',
            formats: ['iife'],
            fileName: () => 'dieline_engine.bundle.js',
        },
        outDir: resolve(__dirname, '../native/src/generated'),
        target: 'es2020',
        minify: true,
        sourcemap: false,
    },
});
