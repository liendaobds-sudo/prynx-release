# NHẬT KÝ SỬA BÌNH SÁCH / TẠP CHÍ IN NHANH — 2026-07-31

Báo cáo gốc: docs/BAO_CAO_AUDIT_BINH_SACH_TAP_CHI_2026-07-31.md.

Phạm vi đã chốt: chỉ Bình sách In nhanh. Không mở Offset/Auto Catalog, không triển khai
tạo/tách bìa và không thay đổi nghiệp vụ chia tép của kiểu Khâu chỉ.

## Lô 1 — chặn sai output và sửa dấu gia công

| Mục | File | Thay đổi |
|---|---|---|
| §A.1 | BookletSettingsSection.tsx | Ẩn Cut & Stack khi chọn Dán đối lưng |
| §A.1 | ImposerDashboard.tsx | Tự đưa state/preset cũ về 1 cuốn/tờ nếu tổ hợp không hợp lệ |
| §A.1 | InstructionSerializer.ts | Hàng rào engine từ chối ghép surface một mặt thành plate A/B |
| §A.4 | InstructionSerializer.ts | Saddle/thread dùng nếp gấp đỏ; kiểu không gấp dùng đường xẻ đen |
| Test | InstructionSerializer.phase2.test.ts | Thêm regression cho tổ hợp P0 và loại/màu dấu giữa |

Kiểm chứng:

- npm run typecheck: đạt.
- vitest InstructionSerializer.phase2.test.ts: 19/19 đạt.

## Lô 2 — một cuốn/tờ và page-order

| Mục | File | Thay đổi |
|---|---|---|
| §A.2/§C.2 | VirtualMap.ts | Continuous thường dùng một bộ trang tuần tự, pad bội 4 |
| §A.2/§C.2 | VirtualMap.ts | Continuous + Cut & Stack vẫn ghép nửa đầu/nửa sau riêng |
| §B.2 | VirtualMap.test.ts | Khôi phục test saddle/thread/cut-stacks; thêm continuous thường và cut-stack |
| Test | InstructionSerializer.phase2.test.ts | Helper test truyền scaleMode giống production |

Kiểm chứng:

- npm run typecheck: đạt.
- vitest VirtualMap.test.ts InstructionSerializer.phase2.test.ts: 46/46 đạt.

## Lô 3 — preset In nhanh

| Mục | File | Thay đổi |
|---|---|---|
| §B.1 | presetManager.ts | Schema preset lưu gutterMargin và blankPlacement |
| §B.1 | ImposerDashboard.tsx | Snapshot và load lại đúng hai giá trị trên |
| Test | presetManager.test.ts | Khóa việc hai field bị rơi khi tạo preset |

Kiểm chứng:

- npm run typecheck: đạt.
- vitest presetManager.test.ts: 1/1 đạt.

## Chưa tuyên bố

- Chưa chạy thao tác thật trong app desktop và chưa in/xén mẫu vật lý.
- Không thay đổi Offset/Auto Catalog.
- Không thay đổi luồng tạo/tách bìa.
- Không thay đổi quy tắc tự gộp tép của kiểu Khâu chỉ.
