# Nhật ký sửa bù xén → Bình tem bế/CNC — 2026-09-23

Phạm vi: các finding `BXHAND23.01`, `NEST23.01`, `NEST23.02`, `BXHAND23.03`, `PERF23.01` trong báo cáo audit ngày 2026-09-23.

## Lô A — parity UI

- File: `desktop/src/components/imposition-tools/ImposerDashboard.tsx`, `ImposerDashboard.groupingParity.test.tsx`.
- Sửa safety effect chỉ ép `sequential` khi đúng lane `sticker_imposer` + đơn vị Từng tem; không còn dựa vào `impositionUnit='sticker'` của N-Up.
- Verify: targeted Vitest **42 passed**.

## Lô B — quantity fast-path

- File: `backend/app/core/nesting_preview_capacity.py`, `backend/tests/test_nesting_preview_capacity.py`.
- Sửa fast-path chỉ chạy khi đúng một trang có quantity=1; global quantity=1 trên nhiều trang đi tiếp session/solver, giữ page membership.
- Verify: targeted tests **49 passed**, 1 cảnh báo Pydantic.

## Lô C — bleed cache identity

- File: `backend/app/core/nesting_preview_session.py`, `backend/tests/test_nesting_preview_session.py`.
- Thêm `bleed_mm` vào identity key; đổi bù xén không thể dùng lại manifest của cấu hình cũ.
- Verify: **80 passed**, 1 cảnh báo Pydantic.

## Lô D — hở bất đối xứng

- File: `backend/app/core/nesting_production_pipeline.py`, `backend/tests/test_nesting_production_pipeline.py`.
- Retained bleed dùng `AxisGapMm` theo X/Y; clip buffer và clearance giữ ngân sách từng trục. Tương thích ngược với scalar trong helper/test cũ.
- Verify: production pipeline **21 passed**, 1 cảnh báo Pydantic; py_compile đạt.

## Lô E — log preview

- File: `backend/app/api/routes/imposition.py`.
- Hạ checkpoint timing chi tiết về `logger.debug` để tránh INFO/I/O lặp trong route nóng.
- Verify: py_compile đạt.

Các cảnh báo blank-line ở EOF còn lại thuộc những file user/phiên khác đã sửa trong working tree; không dọn hàng loạt để tránh chạm ngoài phạm vi.

## Trạng thái còn lại

- Chưa chạy full backend/Vitest, Tauri runtime, bản cài/release hoặc thiết bị CNC vật lý.
- Không cập nhật golden master/snapshot; không thay Rust/native.
