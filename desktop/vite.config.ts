import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
