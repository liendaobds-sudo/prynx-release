# Lô lint P2.40 — 2026-08-23

## Phạm vi

Thu hẹp 3 `no-explicit-any` trong `desktop/src/lib/recipe/recipeStore.ts`:

- Namespace plugin filesystem/path dùng `typeof import(...) | null`.
- Cờ runtime dùng global `window.__TAURI_INTERNALS__` đã khai báo trong dự án.

Không đổi feature detection, thư mục AppData, CRUD, import/export hoặc fallback localStorage.

## Verify

- ESLint riêng file: sạch.
- Test CRUD/import recipe: 7/7 đạt.
- `npm run typecheck`: đạt.
- `npm run lint:budget`: 1.234 → 1.231 errors; warnings giữ 103.

## Kết luận

Chỉ thu hẹp type module runtime; hành vi lưu/tải recipe không đổi.
