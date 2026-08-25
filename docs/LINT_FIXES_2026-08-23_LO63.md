# Lô lint P2.59 — 2026-08-23

## Phạm vi

Loại 37 lỗi `no-explicit-any` khỏi 5 file thuộc miền VDP/đánh số:

- `useVdpHistory.ts`: generic hóa snapshot undo/redo theo `TField`; timer dùng
  `ReturnType<typeof setTimeout>`.
- `useVdpTool.ts`: khai báo contract structural cho field VDP và setter nhận cả
  giá trị lẫn functional updater; giữ nguyên listener, bước nudge và hook deps.
- `vdpTemplate.ts`: parse JSON qua `unknown` + guard record, hỗ trợ cả mảng legacy
  và envelope `{ fields }`, giữ nguyên key, serialization và cách cấp ID mới.
- `CoverNumberingTool.tsx`: dùng contract field chung, typed group maps, bytes
  `pdf-lib` hợp lệ cho `File` và lỗi `unknown`.
- `NumberingTool.tsx`: typed slot/group, giữ nguyên thứ tự sort và công thức sinh
  ma trận số; fallback tọa độ khớp chuẩn hóa sẵn có của `vdpUtils`.

Không đổi hook dependencies, UI, keyboard lifecycle, payload backend, thứ tự số,
đơn vị tọa độ hay output PDF.

## Verify

- ESLint hẹp 5 file: 0 lỗi; 3 cảnh báo `exhaustive-deps` giữ nguyên baseline và
  để lại cho lô Hooks theo miền hành vi.
- `npm run typecheck`: đạt.
- Vitest toàn miền VDP/đánh số: 6 file, 65/65 test đạt.
- `git diff --check`: đạt; chỉ có cảnh báo chuẩn hóa LF/CRLF ở hai file UI cũ.
- `npm run lint:budget`: 981 → 944 errors; warnings giữ 103; gate đạt.

## Kết luận

Lô contract/type-only hoàn tất ở mức kiểm thử tự động. Chưa chạy runtime GUI,
chưa commit, push hoặc build release.
