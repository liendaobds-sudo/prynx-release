# Lô lint P2.53 — 2026-08-23

## Phạm vi

Thu hẹp 9 `any` trong 5 file có hợp đồng rõ:

- `main.tsx`: định kiểu tối thiểu cho global Tauri dùng để capture/freeze `core.invoke`.
- `RecipeRecordControl.tsx`: nhận lỗi lưu recipe bằng `unknown` và thu hẹp trường `message`.
- `RecipePanel.tsx`: đọc trực tiếp `RecipeStep.params` vốn đã là `Record<string, unknown>`.
- `pdfObjectCache.ts`: định nghĩa `CachedPdfObject` theo giao chung của
  `/edit/objects` và `/preflight/objects`; metadata riêng của từng endpoint là optional.
- `presetManager.ts`: giữ dynamic import nhưng mang type module chính thức cho plugin
  filesystem và API path của Tauri.

`toolRegistry.ts` được giữ nguyên: registry chứa component dị thể và payload mở tool
động; thay generic tại đây cần lô contract riêng cùng `App.tsx` và các consumer.

Không đổi payload, thuật toán, tọa độ object PDF, luồng fallback localStorage hay hành
vi capture IPC.

## Verify

- ESLint hẹp trên 5 file: 0 lỗi.
- `npm run typecheck`: đạt.
- Vitest recipe/cache: 14 file, 121/121 đạt.
- `presetManager.test.ts`: 1/1 đạt.
- `git diff --check`: đạt.
- `npm run lint:budget`: 1.153 → 1.144 errors; warnings giữ 103; gate đạt.

## Kết luận

Lô hoàn tất 5 boundary type-only có schema xác minh được. Chưa kiểm runtime GUI;
chưa commit, push hoặc build release.
