# Lô LO89 — Adapter lưu PDF dieline (2026-08-24)

## Phạm vi

- `desktop/src/lib/dieline/saveJsPdfDoc.ts`
- `desktop/src/lib/dieline/savePdfBlob.ts`

## Thay đổi

Thay hai phép dò `(window as any).__TAURI_INTERNALS__` bằng thuộc tính
`window.__TAURI_INTERNALS__` đã có khai báo global trong
`desktop/src/types/tauri-globals.d.ts`. Đây là thay đổi kiểu tĩnh, không đổi
nhánh Tauri/browser, payload `write_file_atomic`, kết quả `saved/cancelled`, hay
luồng tạo blob.

## Verify

- ESLint hai file: đạt.
- `npm run typecheck`: đạt.
- Test trực tiếp `exportGate.test.ts` và `signature.smoke.test.ts`: 23/23 passed.
- Full `npx vitest run src/lib/dieline`: 29 file, 582 passed, 2 skipped.
- `npm run build:dieline-sidecar`: đạt.
- `npm run check:dieline-webview`: đạt.

Không cập nhật golden snapshot; không commit, push hoặc build release.
