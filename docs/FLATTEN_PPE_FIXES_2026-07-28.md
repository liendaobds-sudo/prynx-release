# Nhật ký sửa Flatten / PPE — 2026-07-28

Tài liệu này ghi lại các lô sửa được duyệt sau
`BAO_CAO_AUDIT_FLATTEN_PPE_2026-07-28.md`. Mục tiêu của lô A là làm lộ rõ suy giảm
chất lượng và khôi phục cổng kiểm tra phát hành; **không đổi nội dung PDF đầu ra**.

## Lô A1 — API cảnh báo và cổng phát hành

- `EditResponse` nhận trường `warning`; route `/edit/session/flatten` chuyển nguyên cảnh
  báo do tầng session trả về.
- `gs_dependency_audit.py` không còn crash khi cấu hình `PRYNX_ALLOW_GS_FALLBACK`
  đã bị xoá; cổng vẫn fail-closed nếu thuộc tính cũ được tái lập và bật.
- Thêm hồi quy backend cho cả hai hợp đồng trên.

## Lô A2 — Cảnh báo nhìn thấy trên giao diện

- `SelectionLayersPanel` dùng `toast.info` để hiện cảnh báo do backend trả về; bỏ đường
  `reportMsg` vì trạng thái đó không có nơi render trong ứng dụng.
- Thêm test thao tác nút Flatten, xác minh thông báo mất vector/Pantone/kênh bế xuất
  hiện trên bề mặt UI.

## Kết quả verify

- Backend hẹp: **29 passed**, 0 failed.
- Frontend liên quan (`useEditSession` + `SelectionLayersPanel`): **9 passed**, 0 failed.
- TypeScript `tsc --noEmit`: đạt.
- Corpus phát hành 18 file × 16 tác vụ: **279 OK, 9 REFUSED an toàn, 0 GS,
  0 ERROR**; lệnh gate kết thúc mã 0.
- Riêng `FLATTEN_TRANSPARENCY`: **18/18 OK bằng PPE**.
- `OUTLINE_FONTS`: 14.827 glyph dùng hình học PPE, 0 lùi về fontTools.

Các ca `REFUSED` là fail-closed có thông báo trên những chức năng PPE chưa phủ chắc
chắn; không phải fallback Ghostscript và không phát sinh từ thay đổi cảnh báo Flatten.

## Ngoài phạm vi lô này

- Không đổi thuật toán `LayerEngine.flatten_visible`; Working File Flatten vẫn giữ
  hành vi raster 300 DPI RGB hiện tại, nhưng nay người vận hành được cảnh báo rõ.
- Chưa đổi fallback lấy mẫu bleed của bình tem và chưa thay nghĩa sản phẩm của nút
  Flatten. Hai việc này cần golden/đối chiếu hình ảnh riêng trước khi sửa engine.
