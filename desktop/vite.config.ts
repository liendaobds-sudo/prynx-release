import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
const ENTRY_BUNDLE_BUDGET_BYTES = 1_500_000;

function bundleBudgetPlugin() {
  return {
    name: 'prynx-bundle-budget',
    generateBundle(_options: unknown, bundle: Record<string, { type: string; isEntry?: boolean; code?: string; source?: string | Uint8Array }>) {
      for (const [fileName, asset] of Object.entries(bundle)) {
        if (asset.type !== 'chunk' || !asset.isEntry) continue;
        const bytes = Buffer.byteLength(asset.code ?? '', 'utf8');
        if (bytes > ENTRY_BUNDLE_BUDGET_BYTES) {
          throw new Error(
            `Entry bundle ${fileName} is ${bytes} bytes; budget is ${ENTRY_BUNDLE_BUDGET_BYTES} bytes.`,
          );
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), bundleBudgetPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**']
    },
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
    },
  },
  // Force Vite restart timestamp: 1234567890
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalized = id.replace(/\\/g, '/');
          if (
            normalized.includes('/node_modules/react/')
            || normalized.includes('/node_modules/react-dom/')
            || normalized.includes('/node_modules/react-router-dom/')
          ) return 'vendor-react';
          if (
            normalized.includes('/node_modules/pdf-lib/')
            || normalized.includes('/node_modules/pdfjs-dist/')
            || normalized.includes('/node_modules/pako/')
          ) return 'vendor-pdf';
          if (
            normalized.includes('/node_modules/three/')
            || normalized.includes('/node_modules/@react-three/fiber/')
            || normalized.includes('/node_modules/@react-three/drei/')
          ) return 'vendor-three';
          return undefined;
        },
      },
    },
    // HARDENING: KHONG xuat source map cho ban production -> khong lo ma nguon
    // frontend cho ke trinh sat. (Mac dinh Vite da false; chot tuong minh de
    // tranh vo tinh bat sau nay.)
    sourcemap: false,
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    include: ['pdf-lib', 'pdfjs-dist', 'papaparse', '@pdfme/common', '@pdfme/generator'],
    entries: ['index.html']
  }
})
