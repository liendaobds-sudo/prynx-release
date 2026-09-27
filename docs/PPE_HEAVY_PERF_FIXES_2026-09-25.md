# Triển khai kế hoạch PPE và file nặng — 25/09/2026

Phạm vi được người dùng duyệt: triển khai toàn bộ `BAO_CAO_AUDIT_PPE_HIEU_NANG_FILE_NANG_2026-09-25.md`, liên tục, không hỏi lại. Không thay đổi độ chính xác màu hoặc hình học để đổi lấy tốc độ. Kiểm tra tự động theo từng lô; không coi test tự động là bằng chứng UX thực tế.

## Nhật ký

### Lô 01 — Quan sát GPU và phản ứng cache với áp lực RAM

- `desktop/src-tauri/src/lib.rs`: tile cache thu tạm trên máy ≥16 GB khi RAM khả dụng <10%; giữ chính sách bình thường và env override. Log chuyển budget.
- `desktop/src-tauri/src/pdf_engine/render_worker.rs`: bỏ sàn budget lớn trong nhánh thiếu RAM của máy mạnh; log total/available/lane/render/cache.
- `desktop/src-tauri/src/viewport/scene_cache.rs`: ghi DXGI budget/usage và áp lực RAM riêng biệt.
- `desktop/src-tauri/src/viewport/commands.rs`: ghi adapter/backend/driver và lỗi đặt bounds HWND.
- Kiểm tra: `cargo check --manifest-path desktop/src-tauri/Cargo.toml` đạt (còn warning dead-code có sẵn). Test cache đang chạy.

### Lô 02 — Admission ProcessPool theo working set

- `backend/app/core/system_memory.py`: thêm ngân sách RAM khả dụng và ước lượng working set theo kích thước nguồn.
- `backend/app/core/heavy_job_scheduler.py`: reservation dùng chung giữa các loại job và admission trước khi spawn pool.
- `backend/app/workers/nup_output_finalize.py`: N-Up reserve trước `ProcessPoolExecutor`.
- `backend/app/workers/sticker_engine.py`: Sticker reserve cho pool, retry pool giảm và fallback tuần tự.
- `backend/app/workers/vdp_engine.py`: VDP reserve theo template/ảnh trước khi fan-out.
- Kiểm tra: 148 test scheduler/RAM và 63 test N-Up/Optimize/Sticker/VDP đạt.

### Lô 03 — Bỏ pass thừa và giảm peak fallback màu

- `backend/app/core/pdf_actions_native.py`, `backend/app/api/routes/pdf_tools.py`: strip metadata/PieceInfo trong cùng pass Optimize, không mở-save lại output lần hai.
- `backend/app/core/separations.py`: RGB→CMYK fallback xử lý theo dải 512 hàng; công thức và JSON contract giữ nguyên.
- `backend/app/core/preflight_engine.py`: admission theo working set trước pool scan trang lớn.
- Kiểm tra: nằm trong 63 test liên quan đạt; cần benchmark artifact màu/Optimize nặng để chốt p95 runtime.

### Lô 04 — Đường present và chất lượng overview

- `desktop/src-tauri/src/viewport/presenter.rs`: bỏ `Maintain::Wait` trên vòng present; ghi lỗi surface và reconfigure Lost/Outdated.
- `desktop/src-tauri/src/viewport/refinement.rs`: overview dư mẫu 1.5× trên máy ≥16 GB, 1.25× trên 8–16 GB, giữ 1× dưới 8 GB.
- `desktop/src-tauri/Cargo.toml`, `desktop/src-tauri/src/lib.rs`, `desktop/src-tauri/src/pdf_engine/render_worker.rs`: ghi adapter/VRAM, process working set và budget PPE.
- `scripts/report_viewer_perf.ps1`: đọc các mốc governor mới.
- Kiểm tra: `cargo check --manifest-path desktop/src-tauri/Cargo.toml` đạt.

### Lô 05 — Handoff scene không làm mất frame đang hiển thị

- `desktop/src-tauri/src/viewport/commands.rs`: khi đổi trang không xóa renderer
  và không ẩn HWND trong lúc scene mới compile. Revision vẫn được chốt trước khi
  load nên frame cũ chỉ là lớp chuyển tiếp, không thể gắn nhầm vào trang mới.
- `desktop/src/hooks/viewer/useNativeGpuViewport.ts`: giữ native frame cũ tới
  `first-present` của revision mới; bỏ IPC visibility dư thừa khi HWND đã visible.
  Chỉ ẩn khi lần mở đầu, tab bị ẩn, dialog che hoặc lease bị đóng.
- `desktop/src/hooks/viewer/useNativeGpuViewport.test.ts`: cập nhật hợp đồng handoff
  và kiểm tra stale status/camera không làm đổi camera mới.
- Mục tiêu: chuyển trang không còn rơi vào “Đang chuẩn bị trang…”/nền trắng trong
  toàn bộ thời gian parse/compile. Độ nét của trang mới chỉ được báo sẵn sàng sau
  first-present, không dùng frame cũ để giả ACK.

### Lô 06 — Ghi nhận lỗi thiết bị và thu hồi frame resource

- `viewer_gpu/src/device.rs`: đăng ký uncaptured-error handler, giữ lỗi gần nhất
  để presenter đọc được thay vì để wgpu chỉ in cảnh báo không truy vết.
- `viewer_gpu/src/ink_surface.rs`, `viewer_gpu/src/retained_renderer.rs`: thêm
  đường thu hồi surface/buffer tạm của frame khi GPU validation/device error.
- `desktop/src-tauri/src/viewport/presenter.rs`: ghi `GPU_DEVICE_ERROR`, thu hồi
  resource frame và thử lại vòng present; lỗi surface vẫn phân biệt Lost/Outdated,
  Timeout và terminal. Lỗi terminal/uncaptured sẽ invalidated context dùng chung,
  để lần mở viewport sau tạo adapter/device mới.

### Lô 07 — Giữ vùng đã nét khi pan/zoom quay lại

**Cập nhật 26/09/2026 sau lượt test thực tế:** chưa đạt mục tiêu UX. Phiên
07:08 có 144 lượt refine bị hủy và chỉ 20 detail hoàn tất; 118 cache miss xảy
ra trước eviction đầu. Nhánh tile cũ vẫn gửi request khi bị ẩn. Kết luận quy
chủ yếu cho FIFO và coi hủy mọi camera là tối ưu chưa có đủ cơ sở. Xem
`PHAN_TICH_LOG_GPU_ZOOM_PAN_2026-09-26.md` cùng snapshot bằng chứng trong `.tmp`.

- `desktop/src-tauri/src/viewport/detail_cache.rs`: thay cache detail FIFO
  bằng LRU có xét cả vùng phủ và vùng giao với camera. Frame đã nét được đánh
  dấu sử dụng lại khi camera quay về; chỉ frame ít dùng nhất bị loại khi cache
  đầy.
- `desktop/src-tauri/src/viewport/presenter.rs`: dùng resident LRU cho lớp
  detail, tăng ngân sách máy mạnh lên 12 frame khi không thiếu RAM (2/4 frame
  vẫn giữ cho máy dưới 8/16 GB), ghi `GPU_DETAIL_CACHE` để phân biệt hit,
  insert và eviction. Overview chỉ còn là fallback cho vùng chưa có detail;
  kết quả refinement stale bị ACK/loại bỏ ngay khi camera đổi.
- Mục tiêu UX: pan A → B → A không được trả A về ảnh overview mờ nếu frame A
  vẫn còn trong ngân sách; refinement chỉ chạy khi camera hiện tại chưa được
  frame resident phủ đủ.
- Kiểm tra: `cargo check` đạt; test LRU chọn đúng frame cũ nhất và xử lý cache
  rỗng đạt 2/2.

## Kiểm tra cuối lượt

- `cargo check --manifest-path desktop/src-tauri/Cargo.toml`: đạt; còn 17 cảnh báo
  dead-code đã có trước trong workspace.
- `cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib tile_cache -- --test-threads=1`:
  6 đạt.
- `npm run typecheck`: đạt.
- `npx vitest run src/hooks/viewer/useNativeGpuViewport.test.ts
  src/components/acrobat/NativeGpuViewportContainer.test.tsx`: 31 đạt.
- `npm run test -- --reporter=dot`: 338 file, 3.871 test đạt, 2 bỏ qua.
- `npm run build`: đạt (3.626 module; chỉ còn cảnh báo chunk lớn/dynamic import).
- Bộ backend liên quan: 109 đạt, 1 cảnh báo.
- Toàn bộ backend hiện có 6.026 đạt / 91 lỗi / 24 bỏ qua. 91 lỗi không được gán
  cho lô này: phần lớn là giới hạn spawn/process trong môi trường Windows sandbox,
  cùng các golden/API đang dirty từ trước; các test thuộc đường đã sửa đã chạy riêng
  và đạt. Không dùng kết quả này để tuyên bố toàn bộ backend xanh.

## Chốt nghiệm thu

Các governor/admission/Optimize/Separations fallback/Preflight, đường present,
handoff scene và thu hồi resource khi có lỗi GPU đã được triển khai. Những hạng mục
còn cần một vòng riêng vì liên quan contract hoặc benchmark thực tế: separations
binary/tile end-to-end, tái tạo `wgpu Device` hoàn toàn sau device-lost, merge hàng
nghìn trang theo manifest chunk, PDF.js fallback và benchmark P50/P95/P99 trên file
1–1,5 GB. Chúng không được giả vờ “đã xong” chỉ vì compile xanh.

Rust thay đổi bắt buộc đóng PrynX và chạy lại `run_dev.bat`/build Tauri trước khi
đo UX. Log mới đọc bằng `scripts/report_viewer_perf.ps1` để phân biệt RAM pressure,
VRAM pressure, pool admission và lỗi surface.

### Lô 08 — Chặn pipeline tile ẩn và giữ resident detail khi camera thay đổi nhỏ

Phân tích phiên GPU ngày 26/09 cho thấy present native chỉ mất khoảng 2 ms ở
p50; độ trễ người dùng nhìn thấy đến từ 199 yêu cầu tile/PPE vẫn chạy dù HWND
native đang hiển thị, cùng 144 lượt refine bị hủy bởi các thay đổi camera nhỏ.

- `NativeGpuViewportContainer` báo trạng thái HWND đã thực sự visible. Khi đó
  `AcrobatViewer` tắt toàn bộ lớp tile của đúng trang native đang hiển thị;
  các trang ẩn và fallback vẫn giữ pipeline cũ.
- `presenter.rs` chỉ invalidate refinement khi đổi scene hoặc camera đi xa
  (zoom log > 0,45 hoặc pan > 75% cạnh viewport). Pan nhỏ và một nấc wheel
  được phép hoàn tất để đưa frame vào resident cache.
- `refinement.rs` gắn generation vào kết quả để kết quả của camera đã bị
  invalidate không thể ghi đè frame mới.
- `resident_present.rs` cho phép hiển thị detail cũ ở density từ 0,55 trong
  lúc refinement density 0,9 đang chạy; mục tiêu là không trả vùng đã nét về
  overview mờ khi người dùng zoom một nấc.

Kiểm tra: `npm run typecheck`, bộ Vitest native viewport/LivePageFrame (41
test), `cargo check`, test camera refinement, test resident detail và `npm run
build` đều đạt. Cần đo lại bằng thao tác thật sau khi chạy lại `run_dev.bat`; các
con số trong báo cáo log trước Lô 08 không được dùng làm bằng chứng cho bản
đã sửa.

### Lô 09 — Không bỏ present trong lúc nạp command refinement

Log sau Lô 08 còn có các khoảng `GPU_SCENE_PRESENT` cách nhau 50–700 ms, trong
khi `resident_us` thường chỉ khoảng 1–2 ms. Nguyên nhân là presenter nạp tối đa
4 command buffer mỗi vòng nhưng chỉ đánh dấu `dirty` sau khi toàn bộ refinement
đã nạp xong; frame resident đang có bị bỏ đói trong thời gian đó.

Sau mỗi batch command đã submit, presenter hiện đánh dấu cần present để tiếp
tục vẽ frame resident theo camera mới trong lúc refinement còn chạy. Điều này
không thay đổi thứ tự queue GPU và không hiển thị texture refinement trước khi
các command của nó được submit.

Kiểm tra sau thay đổi: `cargo check --manifest-path desktop/src-tauri/Cargo.toml`
đạt; test camera refinement đạt 1/1. Cần một phiên runtime mới để xác nhận các
spike `request_to_present_us` đã giảm.
