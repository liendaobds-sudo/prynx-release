# Lô lint P2.48 — 2026-08-23

## Phạm vi

Thu hẹp năm `no-explicit-any` trong nhóm preprocess:

- `PageToolsPanel`: payload event dùng `unknown`, khớp helper tạo event hiện có.
- `ShuffleTool`: mapping preview dùng `PageMapping[]` từ engine.
- `OcrTool`, `OptimizeTool`, `TrapPresetsTool`: catch dùng `unknown` và chỉ đọc
  `message` sau khi kiểm tra kiểu.

Không đổi payload event, quy tắc xáo trang, request backend hoặc chuỗi fallback.

## Verify

- ESLint hẹp: 5 file còn 0 `no-explicit-any`.
- Toàn bộ test `src/components/preprocess-tools`: 24 file, 250/250 đạt.
- `npm run typecheck`: đạt.
- `git diff --check`: đạt; chỉ có cảnh báo autocrlf.
- `npm run lint:budget`: 1.186 → 1.181 errors; warnings giữ 103.

## Kết luận

Lô chỉ siết hợp đồng tĩnh ở UI preprocess; dữ liệu và hành vi runtime giữ nguyên.
