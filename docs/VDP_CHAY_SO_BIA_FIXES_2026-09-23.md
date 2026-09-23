# Nhật ký sửa VDP → Chạy số → Bìa — 2026-09-23

Phạm vi: `VDP23.01..04`, `NUM23.01..02`, `COVER23.01` trong báo cáo audit 2026-09-23.

## Lô A — parity preview/output

- `backend/app/workers/vdp_preview.py` dùng chính `run_vdp_engine` cho một record rồi rasterize PDF cuối; không dựng ảnh ReportLab riêng làm nguồn hiển thị.
- `render_one_record` vẫn được dùng để thu `field_errors`, còn artifact hiển thị lấy từ pipeline production.
- Verify: `test_vdp_engine.py` + `vdp/test_preview_properties.py` **19 passed**.

## Lô B — font fail-closed

- `backend/app/workers/vdp_engine.py` bỏ fallback Arial khi field đã yêu cầu font cụ thể nhưng không resolve được; output fail-closed, preview trả ERR tại field.
- Font mặc định không khai báo vẫn giữ fallback tương thích cũ.
- Verify: VDP engine/text picker/preview suite xanh.

## Lô C — logging/privacy

- Hạ log debug VDP từ warning xuống debug; bỏ sample row, text raw, font path và content-stream bytes khỏi log.
- Giữ lại metadata kỹ thuật không nhạy cảm (số record, field count, byte count).

## Lô D — Numbering determinism

- `NumberingTool.computeSequenceFromConfig` dùng seed ổn định từ cấu hình cho Shuffle, nên live preview, `/vdp/preview` và Generate nhận cùng một hoán vị.
- Thêm `NumberingTool.sequence.test.ts` khóa parity Shuffle.
- Verify frontend VDP/Numbering/Cover: **27 passed**, typecheck đạt.

## Lô E — cleaned template lifecycle

- `_VDP_CLEANED_TEMPLATES` có TTL 24 giờ và trần 256 entry; registry purge path đã mất/hết hạn trước khi resolve/register.
- Không tự xóa file lease-owned trong registry purge.

## Trạng thái còn lại

- Chưa nghiệm thu Illustrator/CorelDRAW thật cho live text/font editability.
- Chưa tạo artifact khách mới để đo full matrix Cover (nhiều cluster, sort, stack/sequential, ô trống tờ cuối).
- Chưa chạy full Vitest/backend; chỉ suite VDP mục tiêu.
