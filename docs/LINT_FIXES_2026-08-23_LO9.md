# Lô lint P2.5 — 2026-08-23

## Phạm vi

Làm sạch tham số mock không dùng trong hai bộ test viewer/preprocess, nhưng giữ
nguyên chữ ký callback bằng type alias:

- `desktop/src/components/preprocess-tools/StickerTool.ui.test.tsx`
- `desktop/src/components/workspace/LivePageFrame.liveTile.test.tsx`

Các callback vẫn nhận đủ tham số để kiểm tra `mock.calls`; implementation mock
không còn khai báo biến `_args`/`_blob`/`_ticket` không dùng.

## Verify

- ESLint hẹp: đạt, không còn `no-unused-vars`.
- Regression: 2 file, 36/36 test đạt.
- `npm run typecheck`: đạt.
- `git diff --check`: đạt.
- `npm run lint:budget`: errors `1.418 → 1.411`, warnings `108 → 108`;
  budget gate đạt.

## Kết luận

Chỉ thay implementation mock/type alias trong test, không đổi production code.
Chưa build release, commit hoặc push.
