# Lô lint P2.57 — 2026-08-23

## Phạm vi

Loại 77 lỗi lint khỏi 3 test file:

- `recipeRunners.test.ts`: thay mock/call cast lỏng bằng `vi.mocked`, response
  fixture có kiểu, guard cho JSON/FormData và type guard cho thiết lập tem bế.
- `InstructionSerializer.phase2.test.ts`: dựng fixture bằng contract thật
  `InstructionSet`, `Phase2Plate`, `Phase2Placement` và các settings tương ứng;
  giữ nguyên payload, công thức và đơn vị bình bản.
- `renderWiring.integration.test.ts`: định kiểu Canvas/renderer/texture/three
  state và props mesh; cập nhật API hook qua `useEffect` để tuân thủ bất biến
  React mà không đổi hành vi wiring.

Không đổi production code, backend, engine hình học, golden master hay sidecar.

## Verify

- ESLint hẹp 3 file: 0 lỗi.
- `npm run typecheck`: đạt.
- Vitest đúng 3 file: 71/71 đạt.
- `git diff --check`: đạt ở từng file.
- `npm run lint:budget`: 1.098 → 1.021 errors; warnings giữ 103; gate đạt.

## Kết luận

Lô test-only hoàn tất. Chưa commit, push hoặc build release.
