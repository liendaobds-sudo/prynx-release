# Lô lint P2.44 — 2026-08-23

## Phạm vi

Dọn mã chết thật trong `desktop/src/lib/imposerEngine/NupGridSolver.ts`:

- Bỏ private `findBestHexagonalLayout`, không export và không có call site; HEXAGON live dùng `findBestHexTilingLayout`.
- Bỏ tham số `_bigEndAxisFrac` không được đọc khỏi hai helper HAMMER và các đối số/local plumbing tương ứng.
- Giữ nguyên `_bigEndAxisFrac` của DUMBBELL vì công thức đang dùng trực tiếp để tính shift.
- Giữ nguyên `_waistRatio` của DUMBBELL: dữ liệu vẫn được truyền từ các nhánh legacy và cần một audit hình học/spec riêng trước khi quyết định semantics.

Không đổi công thức pitch, số lượng tem, orientation hoặc serializer output.

## Verify

- ESLint hẹp: chỉ còn 2 finding `_waistRatio` đã giữ có chủ đích; private/HAMMER finding sạch.
- Nup parity + engine tests: 7 file, 108/108 đạt.
- `npm run typecheck`: đạt.
- `git diff --check`: đạt.
- `npm run lint:budget`: 1.197 → 1.194 errors; warnings giữ 103.

## Kết luận

Lô chỉ xóa code private/plumbing không có consumer; các tham số có khả năng là
contract hình học được giữ lại để tránh thay đổi số tem hoặc khoảng cách lồng.
