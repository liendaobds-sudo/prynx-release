# Tách chiều rộng panel - log2026-09-07

Yêu cầu đã duyệt: kéo thiết lập không làm bảng công cụ rộng/tự mở theo.
Chi tiết nguồn và hợp đồng tại `BAO_CAO_AUDIT_TACH_CHIEU_RONG_PANEL_2026-09-07.md`.

- LôA: rightToolMenuLayout +test nhận config preference riêng và resize một panel, giữ panel kia/mode.
- LôB: workspace/AppSettings +2testfile lưu, di trú và hydrate riêng hai width; không đổi width Home.
- LôC: ImpositionTab nối constructor/derived layout/pointermove/pointerup;8test pointer kiểm cả draft và số đo chốt.
- Tổng430test/38suite, typecheck và diff-check đạt; lint0error/1warning cũ.
- Chưa native Tauri; chưa commit; giữ nguyên mọi code Bù xén/source-sync đang dirty và backend task khác.
