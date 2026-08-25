# Lint fixes 2026-08-23 — Lô 85

## Phạm vi

- `desktop/src/lib/dieline/GableBox.ts`
- Mục tiêu: loại bốn lỗi `@typescript-eslint/no-explicit-any` ở mảng chú thích, không đổi generator geometry.

## Thay đổi

- Dùng alias `DielineAnnotation = NonNullable<Panel['annotations']>[number]` cho kết quả chú thích của `buildGablePanel` và `buildSideTriFlap`.
- Giữ nguyên toàn bộ điểm, segment, fold, outline, hole và thứ tự push vào model.
- Diff hiện tại còn có việc bỏ import `arc` và bỏ các biến destructure không dùng (`L`, `HH`) đã tồn tại trong working tree trước lô LO85; lô này không tạo/hoàn tác các thay đổi đó.

## Kết quả

- Giảm 4 lỗi lint: `671 -> 667`.
- Cảnh báo toàn kho giữ nguyên: `103`.

## Xác nhận

- `npx eslint src/lib/dieline/GableBox.ts`: đạt.
- `npm run typecheck`: đạt.
- `npx vitest run src/lib/dieline/generators.test.ts src/lib/dieline/geometry.test.ts src/lib/dieline/contourValidator.test.ts`: 180/180 test đạt.
- `npx vitest run src/lib/dieline`: 582 test đạt, 2 skip.
- `npm run build:dieline-sidecar`: đạt.
- `npm run check:dieline-webview`: đạt.
- `git diff --check -- desktop/src/lib/dieline/GableBox.ts`: đạt.
- `npm run lint:budget`: đạt (`667 errors`, `103 warnings`).

## Bất biến đã giữ

- Không cập nhật golden master/snapshot vì không đổi hình học chủ đích.
- Không chạm backend/native/PDFium; không build release, commit hoặc push.
