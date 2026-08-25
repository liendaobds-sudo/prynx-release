# Lô lint P2.54 — 2026-08-23

## Phạm vi

Loại 5 `any` khỏi 5 fixture test, không chạm code runtime:

- `useEditSession.test.ts`: dùng `undefined` cho trạng thái chưa nhận kết quả thay
  sentinel chuỗi ép `any`.
- `VirtualMap.test.ts`: fixture hình học nhận trực tiếp kiểu tham số thứ ba của
  `solveGeometry` và khai đủ trường bắt buộc của `BookletSettings`.
- `processHandlers.mixedGuillotine.test.ts`: fixture dùng `GuillotineSettings`
  kết hợp field runtime `exportUniqueSheets`, đồng thời khai `paperThickness`.
- `recipeOps.test.ts`: guard mảng thật trước khi mutate bản clone.
- `recipeStore.test.ts`: mock localStorage bằng `Pick<Storage, ...>` và cài qua
  `Object.defineProperty` thay cast global sang `any`.

Assertion và dữ liệu đầu vào có ý nghĩa của các ca test được giữ nguyên.

## Verify

- ESLint hẹp trên 5 file: 0 lỗi.
- `npm run typecheck`: đạt.
- Vitest đúng 5 file: 55/55 đạt.
- `git diff --check`: đạt.
- `npm run lint:budget`: 1.144 → 1.139 errors; warnings giữ 103; gate đạt.

## Kết luận

Lô test-only hoàn tất, không đổi hành vi ứng dụng. Chưa commit, push hoặc build.
