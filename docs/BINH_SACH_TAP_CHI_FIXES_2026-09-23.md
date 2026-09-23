# NHẬT KÝ SỬA BÌNH SÁCH / TẠP CHÍ — 2026-09-23

## Lô A — fail-closed khổ phase-2 (§BOOK.01)

| File | Thay đổi | Lý do |
|---|---|---|
| desktop/src/lib/imposerEngine/InstructionSerializer.ts | computeSpreadGrid trả fits=false khi press sheet không chứa nổi spread; buildPhase2 fail-closed; dùng frame SSOT sau xoay hợp lệ | Không phát tọa độ âm/tràn khổ |
| backend/app/core/plan_executor.py | Kiểm tra placement phase-2 trước show_pdf_page; từ chối bbox âm/tràn plate | Chặn stale payload và defense-in-depth |
| desktop/src/lib/imposerEngine/__tests__/InstructionSerializer.phase2.test.ts | Regression khổ 200×200 không chứa spread; cập nhật ca stack-depth dùng khổ đủ 175 mm | Khóa planner không xuất kế hoạch sai |
| backend/tests/test_plan_executor.py | Regression placement âm phải raise PlanExecutionError | Khóa backend không tạo artifact trắng |

## Kiểm chứng

- Vitest InstructionSerializer.phase2 + SheetViewerDialog.grid: 21/21.
- Pytest test_plan_executor + test_booklet_scheduler: 44/44.
- desktop npm run typecheck: đạt.

## Lô E1 — report fail-closed (§BOOK.S2, In nhanh)

| File | Thay đổi | Lý do |
|---|---|---|
| backend/app/core/plan_executor.py | Stamp report lỗi thì raise PlanExecutionError thay vì trả PDF thiếu report | Report là một phần hợp đồng artifact |
| backend/tests/test_plan_executor.py | Fault-injection test cho stamp report | Khóa không báo thành công giả |

Kiểm chứng: pytest PlanExecutor/route 45/45; Offset/Auto Catalog không mở.
- Không cập nhật snapshot/golden.
- Chưa chạy Tauri runtime; cần thao tác thật một ca Step & Repeat trên khổ đủ và một ca khổ thiếu để kiểm thông báo UI.

## Lô B — chia tép và trang trắng (§BOOK.02/§BOOK.03)

| File | Thay đổi | Lý do |
|---|---|---|
| desktop/src/lib/imposerEngine/VirtualMap.ts | Thread không còn gộp 4 trang dư vào tép trước; dựng segment từng tép theo folio; blank center chỉ chèn trong tép cuối thiếu trang | Giữ folio là giới hạn cứng và không chen blank giữa hai tép |
| desktop/src/lib/imposerEngine/__tests__/VirtualMap.test.ts | Thêm regression 20 trang → 16+4 và 34 trang center → blank logical 34–35 | Khóa page-order/chia tép theo hợp đồng mới |

## Kiểm chứng Lô B

- Vitest VirtualMap.test.ts: 29/29.
- Probe Node: 20 trang → 16+4; 34 trang center → blank logical 34–35; 78 trang center → blank logical 72–73.
- Chưa chạy Tauri runtime hoặc PDF artifact sinh từ UI; cần verify artifact ở Lô E2E sau khi các lô còn lại ổn định.

## Lô C — preset round-trip (§BOOK.04)

| File | Thay đổi | Lý do |
|---|---|---|
| desktop/src/lib/presetManager.ts | Bổ sung classification, cover, catalog và bookReportDisplay vào hợp đồng preset | Không làm mất ngữ cảnh ảnh hưởng output |
| desktop/src/components/imposition-tools/ImposerDashboard.tsx | Snapshot/lưu và load lại đủ field; giữ tương thích preset cũ, khôi phục được giá trị 0/false/chuỗi rỗng | Cùng preset phải tái lập cùng bài bình |
| desktop/src/lib/presetManager.test.ts | Khóa field classification/cover/report trong preset mới | Regression hợp đồng lưu |

## Kiểm chứng Lô C

- Vitest presetManager + ImposerDashboard.groupingParity: 39/39.
- Typecheck verify cuối: đạt.

## Lô D1 — backend hủy Bình sách (§BOOK.05)

| File | Thay đổi | Lý do |
|---|---|---|
| backend/app/core/plan_executor.py | Nhận threading.Event và kiểm tra trước/giữa các sheet, plate, bìa tách | Dừng an toàn, cleanup qua finally |
| backend/app/api/routes/imposition.py | Registry event theo job_id và endpoint cancel-plan riêng từng job | Nhiều tab không ghi đè cờ hủy của nhau |
| backend/tests/test_plan_executor.py | Test event hủy trước render | Khóa boundary cleanup/fail-closed |
| backend/tests/test_imposition_route_output_path.py | Test cancel đúng job, không ảnh hưởng job khác | Khóa ownership theo job |
## Kiểm chứng Lô D1

- Pytest PlanExecutor/scheduler/route: 47/47.

## Lô D2 — nối UI AbortSignal (§BOOK.05)

| File | Thay đổi | Lý do |
|---|---|---|
| desktop/src/lib/pdfImposer.ts | Gửi job_id, AbortSignal và gọi cancel-plan khi abort | Nối UI abort tới backend |
| desktop/src/lib/processHandlers.ts | Đăng ký nút Hủy riêng cho nhánh booklet | Người dùng có thể dừng job Bình sách |

## Kiểm chứng Lô D2

- Vitest processHandlers + presetManager: 61/61.
- desktop npm run typecheck: đạt.
