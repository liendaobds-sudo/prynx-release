# Lô lint P1.3 — 2026-08-23

## Phạm vi

Tách các helper thuần khỏi `PageResizerTool` để giảm finding
`react-refresh/only-export-components`, không đổi hợp đồng component:

- `desktop/src/components/preprocess-tools/PageResizerTool.tsx`
- `desktop/src/components/preprocess-tools/PageResizerTool.test.ts`
- `desktop/src/components/preprocess-tools/pageResizerViewLogic.ts`

Các helper được chuyển là `PageSizeMode`, `PageResizerSettings`,
`allowedScaleModes`, `shouldShowBackgroundFill` và `applyPageSizeMode`. Test
được cập nhật để import helper từ module mới; component vẫn giữ default export.

## Verify

- Test PageResizer: 1 file, 19/19 test đạt.
- `npm run typecheck`: đạt.
- `git diff --check`: đạt.
- ESLint hẹp: helper và test không có finding mới; component còn 4 finding
  baseline (`no-unused-vars`, `set-state-in-effect`, 2 `no-explicit-any`).
  Nhóm hook/`any` được để lại cho chốt tương ứng trong kế hoạch, không trộn vào
  lô React Refresh này.
- `npm run lint:budget`: errors `1.465 → 1.462`, warnings `108 → 108`;
  `react-refresh/only-export-components` `57 → 54`, vẫn còn vượt budget `32`.

## Kết luận

Lô chỉ thay đổi biên export/import và giữ nguyên hành vi resize. Chưa build
release, commit hoặc push. Lô tiếp theo tiếp tục tách các module có finding
`react-refresh` còn lại rồi verify theo cùng ma trận.
