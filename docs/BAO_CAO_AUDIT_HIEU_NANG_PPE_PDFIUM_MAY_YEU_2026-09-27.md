# Audit hiệu năng PPE/PDFium cho máy cấu hình thấp — 27/09/2026

## Trạng thái

**Đã khảo sát, chưa sửa production, chờ duyệt lô triển khai.** Phạm vi lượt này là đề xuất nâng tốc độ và độ ổn định của đường PPE/PDFium trên máy ít RAM/CPU; không triển khai native GPU View. Bản release nên giữ GPU View ngoài phạm vi cho tới khi có gate runtime riêng; dev vẫn có thể giữ cờ thử nghiệm để chẩn đoán.

## Kết luận điều hành

PPE/PDFium hiện không chậm vì một nút duy nhất. Ba tầng đang cộng chi phí:

1. **Bootstrap trước pixel đầu:** một số đường mở tài liệu còn phân tích/clone/inflate dữ liệu trước khi trang nhìn thấy được.
2. **Working-set vượt ngân sách:** worker, PPE session, scene/tile cache và thumbnail có ngân sách riêng; khi RAM khả dụng tụt, hệ thống mới kill/respawn worker, tạo spike lớn hơn chính chi phí render.
3. **Raster accurate lặp lại:** cache resource có hit nhưng chưa phải retained display-list/tile bitmap theo vùng camera; CMYK, mask, ICC và path outline vẫn có thể raster lại nhiều lần.

Mục tiêu đúng cho máy yếu là **first readable frame sớm, tương tác không bị background làm nghẽn, rồi mới làm nét dần**. Không đặt mục tiêu bằng cách hard-cap mọi máy; máy mạnh bình thường vẫn phải giữ full theo policy dự án.

## Bằng chứng đã có

- Audit file nặng ghi case release 302 MB: bootstrap trung vị khoảng **5.669 ms**, RSS trung vị khoảng **2.772 MiB**, đỉnh worker khoảng **4.573 MiB**; dev cùng nhóm khoảng **222 ms / 598 MiB / 1.285 MiB**. Đây là bằng chứng cần A/B lại trên binary hiện tại, không phải SLA mới.
- Runtime file nặng từng ghi RAM khả dụng còn khoảng **576 MiB**, worker bị kill/respawn, PPE page mất khoảng **10–12 s**, GPU scene prepare khoảng **56,9 s**, thumbnail queue khoảng **93,7 s**.
- Worker probe CMNM outline hiện tại: PPE warm khoảng **1.231 ms**; VDP ảnh-raster warm khoảng **233 ms**. Dung lượng file không dự đoán được chi phí raster.
- CMYK outlined benchmark cũ: PPE lần đầu khoảng **660 ms**, lặp khoảng **324 ms**; nhóm file nhiều ảnh 302 MB có thể warm khoảng **29 ms**. Cần phân loại theo path/mask/Form/image, không theo MB đơn thuần.
- `backend/app/core/system_memory.py` hiện gate worker theo RAM tổng; trần RAM khả dụng chỉ áp máy <16 GB. Đây đúng policy “máy mạnh không cap” trong trạng thái bình thường, nhưng cần một pressure mode chung khi RAM khả dụng thực tế sụt mạnh.
- `desktop/src-tauri/src/viewport/scene_cache.rs` đã có probe RAM/DXGI và thu cache khi pressure, nhưng tile cache, PPE session, thumbnail và process working set chưa dùng chung một reservation.
- `desktop/src/stores/appSettingsStore.ts` đã migrate GPU viewport về tắt mặc định; `SettingsModal.tsx` vẫn còn lối bật thử nghiệm. Đây là quyết định sản phẩm cần chốt riêng cho release, không trộn với tối ưu PPE/PDFium.

## Findings

### §LOW.01 — P1 / S — Release chưa có gate compile-time cho GPU View

**Bằng chứng:** store mặc định/migrate `nativeGpuViewportEnabled=false`, nhưng Settings vẫn render checkbox và `AcrobatViewer` đọc trực tiếp giá trị store. Một bản cài cũ hoặc thao tác bật setting vẫn có thể mở native viewport.

**Đề xuất:** production bundle ép `GPU_VIEWER_RELEASE_ENABLED=false`; Settings chỉ hiển thị mục này khi `import.meta.env.DEV`. Dev giữ cờ để đo. Thêm test nhánh production và dev, không xóa native source.

### §LOW.02 — P0 / L — Bootstrap eager chặn pixel đầu

**Bằng chứng:** audit mở file nặng đã tách được PDFium load/page/render nhanh hơn nhiều so với thời gian người dùng chờ; đường chậm nằm ở tiền xử lý/parse/clone trước tile đầu. Một số log cũ còn ghi stream phình từ khoảng 302 MB lên hơn 1,4 GB.

**Đề xuất:** fast-path chỉ đọc trailer/page tree/PageBox và trang hiện tại; defer risk scan, metadata các trang khác, Form/font/image inventory. Không re-save/proxy toàn tài liệu trước pixel đầu. Byte source bất biến dùng chung hoặc mmap an toàn; chỉ bỏ clone sau khi chốt ownership/PDFium lifetime.

**Gate:** first display pixel, bootstrap RSS, page-1 render; kiểm file 18 MB outline, 47 MB VDP, 88 MB vector nhiều object và 302 MB nhiều trang.

### §LOW.03 — P0 / M — Admission chưa theo working set xuyên tầng

**Bằng chứng:** `plan_worker_count()` có ước lượng theo nguồn/raster và gate RAM tổng; heavy scheduler, PPE session, tile/scene cache và thumbnail giữ ngân sách riêng. Runtime đã có ca RAM khả dụng khoảng 576 MiB nhưng vẫn đi tới kill/respawn.

**Đề xuất:** một reservation ledger cho interactive PPE, background thumbnail, scene cache và job nặng. Máy <8 GB giảm mạnh; 8–16 GB giảm nhẹ; ≥16 GB chỉ vào pressure mode khi RAM khả dụng thấp, không hard-cap thường trực. Interactive lane được giữ một reservation tối thiểu; background bị pause/cancel trước khi kill worker.

**Gate:** máy thật 4/8/16/32 GB hoặc profile mô phỏng có kiểm riêng; ghi working set từng process, available RAM, cache bytes, queue age, cancel/retry.

### §LOW.04 — P1 / M — Background thumbnail có thể tranh interactive lane

**Bằng chứng:** audit runtime ghi thumbnail queue hàng chục giây trong lúc PPE/GPU đang xử lý. PrynX đã có priority/cancel nhưng chưa có gate chung bảo đảm khi người dùng zoom/đổi trang thì thumbnail không giữ CPU/RAM/worker cần thiết.

**Đề xuất:** scheduler ưu tiên active page/PPE viewport; thumbnail chỉ chạy khi có budget thừa, bị preempt khi có input mới, và không giữ PDFium lock qua encode/ghi đĩa. Đo queue wait riêng, không gộp vào raster time.

### §LOW.05 — P1 / L — Warm PPE vẫn raster/ICC lại theo request

**Bằng chứng:** resource/Form cache có hit nhưng CMYK outlined vẫn có render warm hàng trăm ms đến hơn một giây; cache resource chưa phải retained display-list, glyph/path cache theo camera hoặc tile bitmap resident.

**Đề xuất:** giữ scene/resource bất biến theo document revision; cache glyph/Form/image/path có version; render vùng thiếu theo tile/ROI; gom ICC transform theo buffer lớn hơn nhưng không đổi FOGRA39/spot/overprint. Pan thuần túy không được phát sinh raster.

### §LOW.06 — P1 / M — DPI/clip identity phải thống nhất trước khi tối ưu

**Bằng chứng:** audit cũ tái hiện nhánh full-page nhân hệ số 96/72 hai lần ở dev, full PNG 1088×1408 thay vì 816×1056 ở cùng hợp đồng 96 DPI. Cache identity cũ không phân biệt mọi kích thước nên có nguy cơ dùng lại bitmap sai mật độ.

**Đề xuất:** chốt một conversion pt → CSS px → device px; cache key gồm DPI/DPR, rotation/UserUnit/clip/profile/intent. Đây là chốt tính đúng trước khi so tốc độ.

### §LOW.07 — P1 / M — Font/geometry fallback chưa truyền đủ cảnh báo

**Bằng chứng:** audit font cho thấy PPE có thể thay Standard14 không nhúng bằng một fallback chung, làm đổi metrics; response có thể `color-verified` nhưng không phản ánh `geometry-degraded`.

**Đề xuất:** embedded font → Standard14/family-style resolver → fallback có cảnh báo geometry. Không chuyển cả trang về PDFium chỉ vì một font nếu điều đó làm đổi profile màu; UI phải phân biệt color-verified và geometry-verified.

### §LOW.08 — P2 / M — Telemetry chưa đủ để chọn tối ưu

**Đề xuất:** mọi request ghi riêng parse, page load, scene compile, session open, PDFium/PPE raster, ICC, encode, IPC, queue wait, decode, upload/present, RSS, available RAM và cancellation. Báo p50/p95/p99 trên tối thiểu 30 lượt/case; N=5 chỉ là probe.

## Lộ trình đề xuất, mỗi lô tối đa 5 file

### Lô 0 — Baseline không đổi hành vi

Thêm harness/telemetry và corpus matrix; chưa đặt cap mới, chưa đổi renderer. Gate: first-pixel, first-readable, time-to-sharp, peak RSS, queue age, cancel ratio.

### Lô 1 — Fast-path mở trang đầu

Tách bootstrap tối thiểu khỏi scan/risk/metadata nền; loại re-save/proxy khỏi critical path. Verify artifact page 1 và cache identity trên dev/release worker.

### Lô 2 — Pressure/admission máy yếu

Reservation chung và preemption background. Verify máy 4/8/16/32 GB; ≥16 GB bình thường không giảm worker/cache, chỉ pressure mode mới thu.

### Lô 3 — PPE warm/ROI/ICC

Retained scene/resource, tile thiếu, glyph/Form/image cache; giữ pixel/màu/font. Không dùng hard-cap DPI hay cache count để che thời gian.

### Lô 4 — Interactive/background và fallback

Active page luôn thắng thumbnail; lỗi PPE/PDFium trả fallback có provenance; kiểm CMYK/Separation/Type3/font/soft-mask và file nhiều ảnh.

## Gate nghiệm thu trước khi nói “tối ưu”

- Không blank/gray frame ở first pixel, đổi trang, zoom và pressure mode.
- Máy yếu không OOM/swap kéo dài; worker không kill/respawn lặp do admission sai.
- Warm first-readable và time-to-sharp được đo riêng; không lấy GPU utilization làm SLA.
- Pan không tạo full raster; idle 150 ms không tự submit/present vô hạn.
- Pixel parity, ICC/spot/overprint, font metrics và cảnh báo geometry giữ nguyên.
- Build dev/release có provenance riêng; GPU View chỉ là dev experiment cho tới khi có runtime gate đạt.

## Kết luận và chốt duyệt

> Ưu tiên thực tế: **fast-path page 1 → pressure/admission → interactive QoS → PPE retained/ROI → ICC/font correctness**. Không tối ưu GPU trước khi các tầng này có số đo.

Lượt này chỉ audit/đề xuất. **Chưa sửa source, chưa build, chưa đổi setting người dùng.** Cần user duyệt thứ tự lô trước khi triển khai theo `prynx-audit-workflow`.
