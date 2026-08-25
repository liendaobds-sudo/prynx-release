# Lô lint P2.3 — 2026-08-23

## Phạm vi

Vệ sinh 5 finding `@typescript-eslint/no-unused-vars` rõ ràng trong component
preprocess nhỏ:

- `desktop/src/components/preprocess-tools/MergeTool.tsx`

Đã loại import `useState`, `ToolDivider`, `ToolCheckboxOption`,
`ToolNumberInput` và hằng `inputCls` không có consumer. Không đổi UI hoặc hợp
đồng `MergeSettings`.

## Verify

- ESLint file: không còn `no-unused-vars`; còn 1 finding React Refresh baseline
  tại export hiện hữu, không phát sinh từ lô này.
- `npm run typecheck`: đạt.
- `git diff --check`: đạt.
- `npm run lint:budget`: errors `1.428 → 1.423`, warnings `108 → 108`;
  budget gate đạt.
- Không có test riêng cho `MergeTool`; typecheck và budget là verify tự động
  áp dụng được trong lô này.

## Kết luận

Chỉ dọn symbol không được tham chiếu, không đổi hành vi merge. Chưa build
release, commit hoặc push.
