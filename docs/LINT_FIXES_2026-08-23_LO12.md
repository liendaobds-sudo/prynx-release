# Lô lint P2.8 — 2026-08-23

## Phạm vi

Dọn dead code/no-empty đã xác minh trong 4 file, không đổi contract xử lý:

- `desktop/src/components/preprocess-tools/SplitTool.tsx` — bỏ import `useState` không dùng.
- `desktop/src/components/preprocess-tools/PageResizerTool.tsx` — bỏ hằng `selectCls` không có consumer.
- `desktop/src/components/OutputPreviewTab.tsx` — bỏ import `useAppSettingsStore` không dùng; đổi `catch(err){}` thành `catch {}` có chú thích; loại dependency `workspaceStore` dư khỏi callback.
- `desktop/src/components/ReportModal.tsx` — bỏ biến `totalDiffs` không được đọc.

Các `any`, cảnh báo hook và state lỗi chưa hiển thị được giữ lại để xử lý ở lô contract riêng; không dùng `eslint --fix` toàn kho.

## Verify

- ESLint hẹp: 4 file không còn finding `no-unused-vars`/`no-empty` của lô; các finding `no-explicit-any` và hook warning còn lại là baseline đã ghi nhận.
- Regression: 5 file Output/Preprocess, 32/32 test đạt.
- `npm run typecheck`: đạt.
- `npm run lint:budget`: errors `1.398 → 1.392`, warnings `108 → 107`; budget gate đạt.
- Không build release, không commit, không push.

## Kết luận

Lô chỉ loại symbol chết và xử lý catch rỗng đã xác minh; không thay đổi logic nghiệp vụ.
