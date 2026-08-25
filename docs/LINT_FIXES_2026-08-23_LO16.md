# Lô lint P2.12 — 2026-08-23

## Phạm vi

Dọn symbol chết và catch rỗng đã xác minh trong 5 file UI:

- desktop/src/components/imposition-tools/MarksSettingsDialog.tsx — bỏ hằng labelCls không có consumer.
- desktop/src/components/imposition-tools/PaperSettingsUI.tsx — đổi catch(e) rỗng thành catch có chú thích; giữ nguyên fallback khi localStorage hỏng.
- desktop/src/components/imposition-tools/PontSettingsDialog.tsx — bỏ binding lỗi không dùng trong nhánh preset hỏng.
- desktop/src/components/preprocess-tools/FontSelector.tsx — bỏ tham số click không dùng.
- desktop/src/components/paper-library/tables.tsx — bỏ import FamilyBand không được render.

Các cảnh báo Fast Refresh, lifecycle effect và explicit any khác không thuộc cleanup này nên giữ lại để xử lý theo contract riêng.

## Verify

- ESLint hẹp: các finding no-unused-vars/no-empty của lô hết.
- Regression: 3 file test liên quan, 69/69 đạt.
- npm run typecheck: đạt.
- npm run lint:budget: errors 1.382 → 1.376, warnings 106 → 106; budget gate đạt.
- Không build release, không commit, không push.

## Kết luận

Chỉ loại code không có consumer và làm rõ catch chủ đích; không thay đổi luồng lưu preset, chọn giấy hoặc chọn font.
