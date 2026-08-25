# Lô LO95 — Dọn suppression thừa ở SolidPanelMesh (2026-08-24)

## Phạm vi

`desktop/src/components/dieline-tool/SolidPanelMesh.tsx`.

## Thay đổi

Xóa đúng năm dòng `eslint-disable-next-line react-hooks/exhaustive-deps` mà ESLint
xác nhận không che finding nào. Không thay đổi geometry solid, UV, vật liệu,
fold matrix, CAD overlay hoặc dependency effect.

## Verify

- ESLint file: các suppression thừa đã hết; còn 3 finding React Refresh export
  (được tách sang lô helper riêng).
- `npx vitest run src/components/dieline-tool/__tests__/renderWiring.integration.test.ts`:
  21/21 passed.
- Typecheck đã chạy nhưng hiện bị chặn bởi lỗi độc lập có sẵn ở
  `LogoRebuildWorkspace.tsx` (object labels thiếu `comparisonWarning` và
  `keyboardHint` trong `LogoCompareLabels`), không liên quan SolidPanel.

Không cập nhật golden snapshot; chưa commit/push/build release.
