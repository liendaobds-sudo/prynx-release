# Kế hoạch nâng cấp render, tải trang và độ nét Viewer — 2026-09-24

**Trạng thái: kế hoạch để duyệt triển khai.** Tài liệu này hoàn tất yêu cầu báo cáo/kế hoạch; chưa thực hiện các lô nâng cấp. Đi cùng [báo cáo audit và bằng chứng](BAO_CAO_AUDIT_RENDER_LOAD_DO_NET_2026-09-24.md).

## 1. Quyết định đề xuất

**Chưa có bằng chứng kiến trúc đã đạt trần công nghệ. Giữ Tauri/React, worker Rust và PPE; hoàn thiện tính đúng, phép đo và đường trình bày trước khi thay nền tảng.** Các lỗi đã tái hiện nằm ở vòng đời request, thời điểm thay ảnh, cấu hình renderer và hợp đồng decode. Chúng có thể làm người dùng thấy mờ/chậm dù raster nhanh.

Không đưa ra phần trăm “ngang Acrobat” hoặc cam kết tăng tốc khi chưa có A/B cùng tài liệu và màn hình. Ba mục tiêu cần nghiệm thu độc lập: **đúng nội dung/màu; nét ở kích thước đang xem; phản hồi nhanh và ổn định**. Đạt một mục tiêu không thay thế hai mục tiêu còn lại.

Giữ quyết định của [kế hoạch PPE ngày 13/08](KE_HOACH_KIEN_TRUC_VIEWER_KHONG_PDFIUM_2026-08-13.md): **Viewer chính và thumbnail chuyển sang PPE**, còn Print/Compare/Edit và các consumer khác có lộ trình riêng. Sửa PDFium trong kế hoạch này bảo đảm đường đang hoạt động đúng trong thời gian chuyển tiếp. Chọn mixed-engine làm đích lâu dài phải có quyết định kiến trúc riêng, không ngầm thay chiến lược cũ.

Thứ tự: **xác minh bản sửa hiện có → đo toàn luồng → nâng chất lượng pixel → tối ưu nút thắt đo được → nghiệm thu PPE/Acrobat**. Shared buffer/GPU là nhánh thử nghiệm có điều kiện.

## 2. Hiện trạng đã chốt và phần vừa thay đổi

Audit gốc pin source lúc **21:10 ngày 24/09**, EXE `ff8a97bc…22d`, cache v9. Sau đó working tree và executable đã thay đổi ngoài tác vụ lập kế hoạch. [Manifest lập kế hoạch lúc 21:27](audit/RENDER_LOAD_2026-09-24/planning_source_manifest.json) ghi EXE `aa7bf4ad…e04` và SHA-256 từng file; [manifest audit gốc](audit/RENDER_LOAD_2026-09-24/source_manifest.json) được giữ nguyên.

| Mã | Audit trên bản gốc | Source đọc lại lúc lập kế hoạch | Trạng thái tiếp theo |
|---|---|---|---|
| R24.01 — zoom/in-flight | P1; tái hiện target cuối không được gửi | Có `finishInFlightAndAdvance` và sửa cleanup trong `LivePageFrame.tsx` | SOURCE CHANGED / PENDING VERIFY |
| R24.02 — View/Print | P1; DLL và worker làm mất/hiện sai OCG/annotation | Đã bỏ `.use_print_quality(true)` ở hai nhánh; cache v10 | SOURCE CHANGED / PENDING VERIFY |
| R24.03 — LCD | P2; BGRA LCD bật/tắt cho cùng pixel ở fixture | Chưa có bằng chứng sửa và A/B màn hình mới | OPEN: xác minh chất lượng, không mặc định BGRx tốt hơn |
| R24.04 — thay surface | P1; display mới và PPE cũ cùng bị bỏ khi PPE mới chưa xong | Có guard `!accurateColor` ở quyền retire của display | SOURCE CHANGED / PENDING VERIFY |
| R24.05 — PXRG decode | P2; decoder reject trở thành GIF trắng cacheable | Đã thêm validate, canvas fallback có pixel và throw | SOURCE CHANGED / PENDING VERIFY |
| R24.06 — gate độ nét | P2; mật độ/coverage chưa chứng minh nét so với Acrobat | Harness vẫn chưa có bộ ROI đối chứng Acrobat | OPEN: bổ sung oracle và baseline mới |

161 test hiện hữu đạt và 5 assertion audit tái hiện lỗi là **kết quả lịch sử trên snapshot audit**, không phải nghiệm thu bản sửa mới. Lượt lập kế hoạch không chạy lại test, handshake worker hay GUI A/B. EXE đổi hash không tự chứng minh tương ứng với toàn bộ source hiện tại.

## 3. Kiến trúc còn dư địa ở đâu?

| Tầng | Nền tảng đã có | Việc còn cần hoàn thiện / kiểm chứng |
|---|---|---|
| Tài liệu và scene PPE | `PreparedPageRender`, snapshot bất biến, `ResourceCache` trong `print_engine/src/session.rs` | Kiểm các consumer thực sự dùng lại chúng; không xây lại cache/retained scene từ đầu. Parse lặp phải được chứng minh ở trace hiện tại. |
| Điều phối worker | Multiplex, document affinity, coordinator/scheduler | Đo queue, công việc stale và cancellation; ưu tiên viewport đang xem và target cuối. |
| Raster và màu | PPE, đường PDFium chuyển tiếp, full-page/viewport | Tách semantics View/Proof; AA, sampling, font, ICC, alpha và clip phải đúng trước khi đánh giá tốc độ. |
| Transport | PNG lossless, raw PXRG, ImageBitmap | PXRG bỏ encode PNG ở đường đó nhưng vẫn có sao chép buffer/cache/IPC. Chưa đủ căn cứ gọi end-to-end zero-copy hoặc quy nó là nút thắt chính. |
| Trình bày | Canvas/Image, lớp display/accurate, giữ ảnh cũ | Quyền sở hữu surface, request generation và swap còn quyết định trực tiếp độ nét nhìn thấy. |
| Nghiệm thu | Harness coverage, density, log, worker benchmark | Thiếu cặp ảnh Acrobat và input→present có provenance; đây là khoảng trống đo lường, không phải giới hạn vật lý của công nghệ. |

Đường dữ liệu đích tiếp tục theo kiến trúc hiện có:

```text
Input + document revision
  → target hiện tại / generation
  → scheduler ưu tiên viewport
  → session PPE + prepared page + resource cache
  → raster đúng clip, mật độ, màu
  → pixel buffer có ownership rõ
  → decode/validate back surface
  → swap khi còn đúng target
  → present + overlay
```

Ba trạng thái **target mong muốn / request đang chạy / surface đang hiện** phải độc lập. Một request bị bỏ vì ảnh đang hiện nét hơn vẫn phải kết thúc đúng attempt. Có thể tái dùng bitmap cùng document/revision/trang nếu còn đủ độ nét và được đặt đúng hình học target hiện tại; không coi mọi request khác zoom là vô dụng. Bitmap đã decode chưa đồng nghĩa compositor đã trình bày nó.

## 4. Lộ trình và điều kiện qua giai đoạn

S/M/L là effort tương đối: S cục bộ, M xuyên lifecycle/tầng, L thay hợp đồng hoặc cần tập mẫu rộng; chưa quy đổi thành ngày công. Mỗi lô sửa tối đa 5 file, **tính cả test và tài liệu sửa**. Nếu cần thêm file thì tách lô trước khi làm.

### G0 — Chốt baseline có thể lặp lại · bắt buộc · S/M

| Lô | Phạm vi | Đầu ra / điều kiện đạt |
|---|---|---|
| B0 — provenance | Manifest + harness hiện có + nhật ký | Pin source/dirty diff, EXE, DLL, worker protocol/cache, frontend đang phục vụ, PDF hash và cấu hình. Phân biệt source / binary / GUI đã kiểm. |
| B1 — trace frontend | `useTileRenderer.ts`, `LivePageFrame.tsx`, test hợp đồng, nhật ký, matrix: ≤5 | Nối input, request, generation, doc revision, engine thực tế, decode và surface được trình bày. Tách callback ready khỏi present quan sát được. |
| B2 — trace native | `lib.rs`, `render_worker.rs`, harness native, test hợp đồng, nhật ký: ≤5 | Queue, open/prepare, resource, raster, convert/encode, bytes, lỗi/cancel; cùng request ID. Không log đường dẫn/nội dung PDF khách không cần thiết. |
| B3 — phép đo GUI | Harness WebView, schema test, manifest corpus, nhật ký, matrix: ≤5 | Có lượt mở/zoom/pan/đổi trang tái lập, blank-gap và ảnh đối chứng. Tự kiểm harness không được gắn thành runtime pass. |

Ghi timestamp lúc sự kiện xảy ra, không lấy thời điểm flush log. Clock native/JS có miền riêng: phải liên kết hoặc đồng bộ trước khi trừ; không cộng span lồng nhau hoặc chạy chồng nhau. Nhãn `accurate` được yêu cầu không thay thế `engine_actual` và kết quả kiểm màu.

### G1 — Khóa tính đúng trên bản sửa mới · bắt buộc · S/M

Đây là lô **xác minh trước, chỉ sửa phần còn thất bại**. Nếu patch đang có đạt thì thêm bằng chứng/regression test, không áp lại patch.

| Lô | Phạm vi tối đa | Ca nghiệm thu bắt buộc |
|---|---|---|
| N1 — R24.02 | `lib.rs`, test native, worker probe, manifest, nhật ký: 5 | Handshake/cache v10; View-only/Print-only/annotation đúng ở page và clip; PNG/PXRG cùng pixel trong cùng cấu hình; cache v9 không phục vụ như v10; không đổi hợp đồng Print. |
| F1 — R24.01 | `LivePageFrame.tsx`, `LivePageFrame.liveTile.test.tsx`, nhật ký, matrix: 4 | Zoom 100→130→120→140% tới target cuối; success/discard/stale/cancel/decode-error kết thúc đúng attempt; PNG fallback; response của file/tab/owner cũ không ghi đè. |
| F2 — R24.04 | Component trên, `livePageFramePolicy.ts` nếu cần, test component, nhật ký, matrix: ≤5 | PPE A còn hiện đến khi PPE B hợp lệ; display B ready không loại A hoặc tự biến mất; B bị C vượt qua không retire C; display-only hoạt động; ready lặp có tính idempotent. |
| F3 — R24.05 | `useTileRenderer.ts`, test tương ứng, `tileUrlCache.test.ts` nếu cần, nhật ký, matrix: ≤5 | PXRG 2×2 có màu/alpha riêng; reject/API thiếu/payload ngắn/kích thước 0 phải fallback pixel thật hoặc báo lỗi; không cache placeholder, không phát ready giả. |

F1 thêm ca thời điểm: **request A → zoom B trước khi URL A về → A chuyển sang Image decode → zoom C**. Effect B có thể không sở hữu attempt đang decode; cần kiểm cleanup tương ứng. Đây là nghi vấn về patch mới, chưa phải bug đã tái hiện.

Chạy targeted tests và typecheck trên Windows; phần Rust chạy kiểm tra theo phạm vi thay đổi và worker artifact trên binary đúng source. Sau đó smoke Tauri: wheel đảo chiều, đổi trang/tab, resize, DPI và display/PPE về khác thứ tự. Không nghiệm thu chỉ từ test mock hay comment có tag R24.

### G2 — Nâng chất lượng pixel và đối chiếu Acrobat · bắt buộc · M

1. **Hình học trước:** khóa page box, rotation, clip, scale/DPR và kích thước bitmap. Kiểm DPR 1/1,25/1,5/2; zoom 75/100/125/200/400%; trang khổ lẻ/lớn, chữ ở tọa độ phân số. Không khe tile, cắt góc hoặc dùng surface thấp mật độ làm kết quả cuối.
2. **Chữ và vector:** A/B BGRA grayscale, BGRA LCD hiện có, BGRx LCD đục trong đường PDFium chuyển tiếp. Với PPE kiểm AA/hinting/glyph/outline theo lỗi đo được. Không dùng `FPDF_PRINTING` như nút tăng độ nét, không bật LCD toàn cục chỉ vì fixture có pixel màu.
3. **Ảnh và màu:** sampling ảnh thu nhỏ/phóng lớn, alpha/SMask, ICC, overprint/spot/transparency. Xem thường và proof có profile/intent riêng; không đánh đổi màu/nội dung để làm ảnh “có vẻ nét”.
4. **Oracle:** ảnh chụp device pixel gốc, ROI chữ live/outline 4–12 pt, đường ngang/dọc/chéo mảnh, scan, gradient, mép glyph và vùng màu. Giữ gate density/coverage hiện có, thêm nghiệm thu thị giác.

Tách thành lô geometry frontend, lô AA native và lô sampling/màu PPE; mỗi lô 1–2 file production + test/oracle + nhật ký/matrix, tối đa 5. Không gộp đổi bitmap format, kernel màu và lifecycle trong một lô. Golden chỉ cập nhật khi thay đổi chủ đích và đã soi diff.

**Gate:** không mất glyph/đối tượng; không có viền màu LCD nhìn thấy gây giảm chất lượng so đối chứng ở cấu hình đã khóa, không sai alpha hoặc seam. ROI không kém rõ rệt so Acrobat. Không yêu cầu mọi pixel mép chữ LCD có R=G=B; đó sẽ là phủ định chính subpixel AA. Pixel equality dùng cho đường cùng thuật toán cần giữ nguyên; khác engine không bắt buộc giống từng pixel. MAE/SSIM toàn trang trắng không đủ làm chốt chất lượng.

### G3 — Tối ưu thời gian từ thao tác đến ảnh nét · theo profile · M/L

| Trace chỉ ra phần chi phối | Lô nâng cấp | Điều kiện đạt / dừng |
|---|---|---|
| First-frame prime lỗi hoặc bootstrap chậm | Phân loại nguyên nhân prime; singleflight, ưu tiên trang active, metadata nền; tái dùng session/affinity đang có | Giải thích từng failure, không “sửa” bằng bỏ prime hoặc thêm retry vô hạn. Đo first-visible và first-sharp riêng. |
| Queue/stale work trì hoãn target cuối | Coalesce, latest-target, priority/cancel theo generation | Giảm cancel→next-start và input-stop→sharp; không starvation, không mất cache vô điều kiện. |
| Prepare/resource trội | Kiểm consumer dùng `PreparedPageRender`/resource cache; sửa key, lifetime, hit/miss cần thiết | Warm replay đúng revision/profile, không parse/decode thừa đã được chứng minh; không xây cache trùng. |
| Raster trội | Culling, viewport, sampling/kernel và tile seam theo ca cụ thể | Pixel/màu không hồi quy; cải thiện end-to-end, không chỉ kernel. Không hạ DPI để che latency. |
| Convert/encode/transport/decode trội | Giảm clone tránh được, immutable ownership, hoàn thiện PXRG/ImageBitmap | Giữ length/stride/alpha và PNG fallback đã kiểm; giảm latency/RSS thực. Không suy speedup từ tên zero-copy. |
| Layout/present trội | Surface ownership, back/front buffer, giảm mount/layout khi swap | Đo frame/present thực; timer 16 ms không chứng minh 60 FPS. |

Chỉ chọn 1–2 nút thắt lớn nhất trên critical path mỗi vòng. Một tầng nhanh hơn nhưng làm frame cuối chậm hơn không được coi là nâng cấp trải nghiệm. Cache có lợi phải đo cả cold/warm và memory lifecycle.

**Nhánh cancel PDFium có điều kiện:** đầu tiên đo stale display có thực sự chiếm lane và cản target mới. Nếu đáng kể mới thử progressive render headless rồi tích hợp. [PDFium có Start/Continue/Close và pause callback](https://pdfium.googlesource.com/pdfium/+/refs/heads/main/public/fpdf_progressive.h), nhưng API start/size/rotation khác clip matrix đang dùng. Phải kiểm CropBox/UserUnit/rotation/clip parity, đóng context mọi nhánh, giữ doc/page sống đủ lâu và không publish bitmap dang dở. Không gọi PDFium song song trong cùng process; progressive không làm thư viện thành thread-safe. Chi phí nhánh này phải cân với lộ trình PPE, không mặc định bắt buộc.

### G4 — Thử shared buffer/surface · chỉ khi G3 chứng minh cần · L

WebView2 có [CreateSharedBuffer](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2environment12) và [PostSharedBufferToScript](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2_17), cho ứng dụng và script dùng vùng nhớ chia sẻ. **Điều đó không chứng minh Tauri hiện tại nhận trực tiếp texture GPU từ worker**, cũng không tự loại upload lên GPU. Shared memory CPU và shared GPU texture là hai thử nghiệm khác nhau.

Spike trước ở bridge/pool/receiver/harness/báo cáo, tối đa 5 file mỗi lô. Hợp đồng bắt buộc: ownership, buffer release, generation, stale completion, worker/WebView crash, tab close, resize/DPI và fallback. So cùng pixel, cùng corpus trước/sau. Chỉ promote nếu cải thiện P50/P95 hoặc bộ nhớ có ý nghĩa lặp lại và không đổi nội dung/màu. Nếu raster/present vẫn chi phối hoặc lợi ích trong nhiễu đo, dừng spike.

Shared buffer/GPU **không phải điều kiện bắt buộc** để hoàn tất cutover PPE. Không thay React/Tauri hoặc viết lại renderer chỉ từ cảm giác còn chậm.

### G5 — Nghiệm thu sản phẩm và PPE cutover · bắt buộc · M/L

Viewer chính và thumbnail phải được kiểm riêng, sau đó chạy cùng nhau: grep call site kết hợp trace runtime chứng minh đường pixel được hỗ trợ thật sự dùng PPE. Với tính năng PDF chưa hỗ trợ, ghi capability/soundness rõ; không fallback âm thầm rồi tính là PPE pass. Quyết định phát hành khi còn thiếu capability phải ghi riêng.

Đo lại toàn luồng trên binary/frontend đã pin, A/B Acrobat, có cả panel thumbnail đóng và mở bình thường. Kiểm concurrent job, vòng đời bộ nhớ và RAM tier. Chưa đủ bằng chứng GUI/PPE/thiết bị thì trạng thái tương ứng là HOLD, không nâng từ SOURCE/AUTO lên RUNTIME.

## 5. Tiêu chí nghiệm thu và corpus

### Điều kiện so sánh

Khóa PDF hash, trang, page boxes/rotation, viewport và kích thước hiển thị theo **device pixel**, DPR/Windows scaling, màn hình/ICC, phiên bản Acrobat và PrynX. Cùng “100%” chưa bảo đảm cùng hình học. Ghi Acrobat smooth text/image, thin-line, local-font, overprint và acceleration. So xem thường với xem thường; proof với proof cùng profile/intent/paper-black simulation.

Chọn ba PDF trụ cột: **chữ/vector; scan/ảnh nặng; CMYK/spot/transparency**. Mỗi PDF 30 cặp A/B, đảo thứ tự chạy để giảm thiên lệch cache/nhiệt. Chuỗi: mở app-cache lạnh → zoom burst → pan → đổi trang/quay lại → mở ấm. Tổng 90 cặp cho bộ chính. Ba ca biên (mixed geometry, nhiều trang, file khách khó chịu nhất) chạy 5 cặp chẩn đoán; tăng lên 30 khi cần P95 nghiệm thu. Không báo P95 đạt từ 5 lượt.

“Cold” phải ghi là app-cache hay OS/file-cache; không gọi reopen sau xóa tile là disk-cold. Đo một màn/DPR chính trước, rồi chọn ROI nhạy cảm để kiểm DPR phụ; không nhân mọi biến thành hàng nghìn ca. Lưu lỗi/outlier, không bỏ ca thất bại khỏi mẫu để làm đẹp số liệu.

### Gate đề xuất, chưa phải kết quả đạt

| Hạng mục | Điều kiện nghiệm thu |
|---|---|
| Nội dung, hình học, màu | Không sai/mất glyph, object, clip hoặc rotation; hình học khớp trong 1 device pixel khi đo cùng transform; nhãn proof/accurate đúng engine và cấu hình thực tế. |
| Độ nét | ROI gốc không kém rõ rệt trong A/B; không thêm fringing, seam, alias bất thường. Density ≥0,98 theo harness cũ chỉ là điều kiện cần. |
| Giữ ảnh / stale | Khi zoom/pan cùng trang đã hiện: không quãng trắng do retire sớm, không commit kết quả không còn tương thích target/revision hiện tại, không tụt về bitmap mờ sau bitmap nét. Bitmap nét hơn được tái dùng với geometry đúng. Đổi trang không được nhận pixel trang cũ như kết quả trang mới. |
| First-visible, first-sharp và zoom-stop→sharp | So từng PDF/cold-warm: P50 ≤ P50 Acrobat + max(25 ms, 10% P50 Acrobat); P95 ≤ P95 Acrobat + max(50 ms, 20% P95 Acrobat). Đây là dung sai đề xuất để duyệt, không tuyên bố ngang tuyệt đối. |
| Mục tiêu trải nghiệm đã có trong kế hoạch 13/08 | Page shell P95 ≤100 ms; Standee **FSP** cold P50/P95 ≤250/500 ms, warm ≤120/250 ms; zoom-stop warm ≤120/300 ms. FSP theo harness cũ là có nội dung trong viewport ở phạm vi nó quan sát, không đồng nghĩa first-sharp hay pixel đầu tuyệt đối. Không chuyển ngưỡng FSP này thành ngưỡng first-sharp. Chỉ áp phạm vi/corpus được định nghĩa. |
| Phản hồi thao tác | Đề xuất input→phản hồi hình học P95 ≤50 ms trên màn 60 Hz; phép đo present thực, tách khỏi thời gian ảnh nét cuối. |
| Hồi quy sau mỗi lô | Không giảm chất lượng; latency/RSS không xấu hơn >10% so baseline kiểm soát nếu chưa có đánh đổi được duyệt. Đo lặp để phân biệt nhiễu; giải thích peak memory tăng bằng lợi ích cụ thể. |
| Bộ nhớ / ổn định | 20 vòng mở/zoom/đóng: sau release tài liệu không có tăng tích lũy vô hạn, không crash/OOM. Tách cache còn chủ đích với tài nguyên đáng lẽ đã release. Đo toàn cây process. |
| Thumbnail/job cạnh tranh | Báo interactive P95 ở trạng thái bình thường có thumbnail và khi có job nặng; không starvation. Gate định lượng contention chốt từ baseline G0, không đặt bằng số worker tùy ý. |

Mục tiêu tuyệt đối trong kế hoạch cũ và đối chứng Acrobat là hai cột nghiệm thu khác nhau. Nếu một ngưỡng không phù hợp corpus, cần ghi quyết định điều chỉnh trước vòng nghiệm thu tiếp theo, không thay ngưỡng âm thầm sau khi fail. Chưa có bộ dữ liệu mới để điền cột “đã đạt”.

Kiểm ba tier RAM **<8 GB, 8–<16 GB, ≥16 GB**. Máy ≥16 GB giữ năng lực đầy đủ; không thêm cap worker/cache/chất lượng vô điều kiện. Mô phỏng tier trên máy mạnh chỉ kiểm policy, không thay bằng chứng máy yếu thật về CPU/swap/RAM. Thiếu thiết bị thì ghi HOLD của tier đó.

## 6. Khi nào mới cần đổi kiến trúc?

Chỉ mở quyết định thay transport/compositor/engine khi đồng thời có: (1) correctness đã đạt; (2) trace cùng request chứng minh tầng đó chi phối độ trễ; (3) tối ưu cục bộ có kiểm chứng vẫn không đạt mục tiêu; (4) prototype phương án mới cải thiện lặp lại trên corpus và giữ pixel/màu/lifetime.

| Kết quả đo | Quyết định |
|---|---|
| Lifecycle/present sai nhưng raster nhanh | Hoàn thiện surface/request; giữ engine. |
| PPE chậm ở resource/raster, transport nhỏ | Tối ưu scene/resource/kernel PPE; shared memory không giải quyết gốc. |
| Copy/IPC/decode chi phối sau khi đã giảm clone | Thử shared CPU buffer; GPU surface là nhánh riêng có tích hợp được chứng minh. |
| Pixel đủ nhưng chữ/ảnh vẫn thua | Sửa AA/sampling/hinting/color; không tăng worker hoặc giảm debounce để che. |
| PPE thiếu capability PDF so corpus | Ưu tiên tính đúng và coverage; chưa cutover toàn bộ. |
| Mọi gate đã đạt | Dừng tối ưu diện rộng, giữ regression suite; không viết lại chỉ để đổi công nghệ. |

## 7. Gói triển khai đầu tiên và quản lý rủi ro

**Gói đề nghị duyệt trước: G0 + G1.** Giá trị là có baseline đáng tin và biết chắc bốn bản sửa mới đã khép lỗi hay chưa. Sau gói này sẽ có bảng trước/sau, trace nguyên nhân first-frame prime failure, trạng thái từng finding và danh sách 1–2 nút thắt để chọn G2/G3. Không cam kết triển khai G4 khi chưa có số đo.

Mỗi lô giữ phạm vi ≤5 file và kiểm hẹp xong mới đi tiếp; nhật ký đề xuất `RENDER_VIEWER_UPGRADE_FIXES_2026-09-24.md` ghi patch, binary, test/artifact, rủi ro và rollback. Đây là tên file tương lai, chưa phải artifact đã tạo. Cập nhật master matrix ở lô có phạm vi cho phép; không dùng cập nhật tài liệu để vượt giới hạn file.

Rollback theo từng patch/flag hoặc transport đã kiểm; giữ nguyên các sửa độc lập đang có trong working tree. Không reset repository, không đổi golden vô điều kiện, không thêm release LTO vào Cargo.toml. Công việc nặng vẫn theo worker/process policy và khóa PDFium hiện hữu.

Theo [prynx-audit-workflow](../.agents/skills/prynx-audit-workflow/SKILL.md), giai đoạn 2 yêu cầu **“Dừng lại chờ user duyệt danh sách”** và **“không tự sửa trước khi duyệt”**. Tài liệu này là danh sách cụ thể để duyệt; yêu cầu lập báo cáo/kế hoạch hiện tại đã được hoàn tất, chưa phải lệnh triển khai production.
