# Lô lint P2.25 — 2026-08-23

## Phạm vi

Dọn 5 block catch rỗng trong engine nup:

- desktop/src/lib/imposerEngine/NupGridSolver.ts — ghi rõ fallback dùng tham số shape mặc định khi JSON tùy chọn lỗi.

Không sửa công thức hình học, layout, số lượng tem hoặc parity logic.

## Verify

- ESLint no-empty hẹp: sạch; các any/unused geometry baseline giữ nguyên.
- Regression parity: NupGridSolver.parity.test.ts 14/14 đạt.
- npm run typecheck: đạt.
- npm run lint:budget: errors 1.324 → 1.319, warnings 103 → 103; budget gate đạt.
- Không build release, không commit, không push.

## Kết luận

Chỉ làm rõ fallback parse, không thay đổi kết quả xếp nup.
