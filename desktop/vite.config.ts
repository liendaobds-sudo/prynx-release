import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
const ENTRY_BUNDLE_BUDGET_BYTES = 1_500_000;
// PERF (audit 2026-08-10 §OP.8): Vite không quét bare import chỉ xuất hiện trong
// Web Worker trước lần worker chạy đầu tiên. Prebundle ngay để lần mở tính năng
// không phát hiện dependency muộn rồi tự reload toàn bộ trang dev.
export const WORKER_ONLY_OPTIMIZED_DEPS = ['pako', 'diff'] as const;

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
    // KIENTRUC (audit 2026-07-29 §B.3): đã bỏ '@pdfme/common' + '@pdfme/generator'.
    // Hai package đó KHÔNG được import ở bất kỳ file source nào — chỉ còn tên ở đây và
    // trong package.json, tức là một engine sinh PDF thứ hai được cài mà không ai dùng.
    include: ['pdf-lib', 'pdfjs-dist', 'papaparse', ...WORKER_ONLY_OPTIMIZED_DEPS],
    entries: ['index.html']
  }
})
