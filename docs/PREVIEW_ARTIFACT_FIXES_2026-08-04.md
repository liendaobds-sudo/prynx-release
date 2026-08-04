# Nhật ký sửa parity Preview ↔ PDF xuất — 2026-08-04

> Phạm vi: Deep Audit W2 · `§W2.PA1`, `§W2.PA2` · Không build hoặc phát hành GitHub.

## `§W2.PA1` — lề dưới Booklet

- Bổ sung `marginBottom` vào hợp đồng Sheet Viewer và truyền từ cấu hình bình sách.
- Preview và serializer dùng cùng `computeSpreadGrid`, kể cả khi lề dưới lớn hơn gripper.
- Regression test khóa ca từng cho preview `1×2` nhưng artifact chỉ xếp được `1×1`.

## `§W2.PA2` — working PDF fail-closed

- Reorder/delete/duplicate/rotation phải được materialize trước preview và Crop.
- Nếu materialize thất bại, UI dừng với lỗi; không dùng lại file gốc còn trang đã xóa.
- Mixed Guillotine kiểm chéo số trang của request và tài liệu thật trước khi dựng zone/cut tree.

## Verify

- Frontend typecheck đạt; bộ test preview/Crop/working PDF `51/51` đạt; full Vitest đạt `1.857`, skip `2`; cổng ngân sách lint đạt.
- Full backend cuối: `2.238` đạt, `4` skip.
- Rust Tauri: `56/56` test thư viện đạt và `cargo check --offline --locked` đạt.
- Chưa chạy runtime app desktop và không build release.
