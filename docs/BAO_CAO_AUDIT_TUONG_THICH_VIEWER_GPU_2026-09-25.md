# R34 — Rà soát tương thích Viewer GPU với đường xem trước nâng cấp

Ngày: 25/09/2026. Trạng thái: **AUDIT HOÀN TẤT TRONG PHẠM VI DƯỚI ĐÂY; CHƯA ĐỦ ĐIỀU KIỆN THAY VIEWER CŨ**. Chưa sửa source ứng dụng trong lượt này.

> **Cập nhật sau khi người dùng duyệt sửa:** bảy finding R34 đã có bản vá SOURCE + AUTO. Báo cáo này giữ nguyên bằng chứng baseline; trạng thái và kiểm thử sau sửa nằm ở [VIEWER_GPU_COMPAT_FIXES_2026-09-25.md](VIEWER_GPU_COMPAT_FIXES_2026-09-25.md). Chưa tuyên bố đạt runtime/Acrobat parity cho tới khi chạy GUI, DPI, driver, soak và installer.

## Kết luận điều hành

Vấn đề không chỉ là tốc độ dựng hình. Hai đường Viewer chưa dùng chung hợp đồng về **ý định màu, năng lực dựng PDF, camera/vị trí trang và vòng đời kết quả bất đồng bộ**. Vì vậy sửa riêng shader, cache hoặc một thao tác zoom vẫn có thể làm hỏng thao tác khác.

Đã xác nhận **7 finding: 4 P1 và 3 P2**. Ngoài ra có các khoảng trống nghiệm thu được ghi riêng; không biến thiếu test thành kết luận có bug. Không có cơ sở nói engine mới tương thích hoàn toàn hoặc ngang Acrobat.

Kết quả quan trọng:

- Bộ 20 ca gồm 8 fixture có sẵn và 12 ca tổng hợp có chủ đích: native PDFium display dựng **20/20**; GPU trực tiếp dựng **8/20**; native PPE accurate nhận **14/20**, từ chối **6/20**. Sáu ca là Hue/Saturation/Color/Luminosity trong CMYK, fixture JPEG progressive và ảnh JPX. Đây là bộ săn giới hạn, **không phải tỷ lệ lỗi thống kê của PDF thực tế**. GPU từ chối không đồng nghĩa cả Viewer trắng; frontend hiện còn lùi về Viewer cũ sau khi báo lỗi.
- Với bốn mode RGB tương ứng và hai ca font thay thế, PPE còn dựng được; cần phân biệt những ca này với sáu ca không có đường PPE accurate. Đếm tất cả fallback là lỗi sẽ sai.
- Hai probe DOM/IPC mới đều đỏ: mất vị trí cuộn khi đổi renderer; lỗi zoom của trang cũ báo sang trang mới. **253 test frontend hiện hữu vẫn xanh** trong cùng lượt. Đây là bằng chứng bộ test cũ thiếu hợp đồng tích hợp, không phải chỉ thiếu số lượng test.
- Mẫu xanh RGB có pixel display `(0,255,0)`; native PPE/GPU ra `(103,179,46)` qua FOGRA39. Khác biệt này hợp lý khi người dùng chọn soft-proof, nhưng native hiện không nhận lựa chọn display/CMYK của Viewer.
- Log sau R33 cho thấy quay lại trang đã hoàn tất có ACK hiện native khoảng **41–56 ms**, trong khi hai lần mở đầu quan sát được khoảng **1.16–1.21 s** từ `scene-start`. Không dùng các số này thay phép đo mở file tổng thể hoặc so nhanh/chậm với executable cũ.

## Phạm vi, baseline và nguồn bằng chứng

- Baseline Git: `bb139dde242804fb44d0514f2c6688bbd686e13a`, trước các file native GPU hiện còn trong working tree. Audit đọc cả file mới, không chỉ `git diff`.
- Đường cũ đối chứng là **native PDFium display và Viewer hybrid hiện còn được giữ trong code**. `render_worker.rs` không có diff so với HEAD tại thời điểm kiểm. Không giả rằng đây là chạy lại toàn bộ executable/installer lịch sử.
- Executable dùng cho 40 request render thật: `desktop/src-tauri/target/debug/pdf-inspector.exe`, SHA256 `c0d1b6ebe3270537e4cb63b92b422acac495e7a1fc93556e9a5015436e39ca0b`; protocol 4; PDFium SHA256 `01be7a757183793f15eb35de9d9da424fc07d24b5560e8c3822f52812b2ad89a`. Đây là executable sau người dùng chạy lại dev, khác artifact build riêng được ghi ở R33.
- Worker audit được khởi chạy riêng với `--prynx-render-worker`, không mở/đóng PrynX của người dùng. Gửi từng request và đợi response, lưu PNG/hash. Đường GPU dùng source hiện tại, cùng profile và font fallback của scene worker, ở viewport kiểm tra 256×256; không phải benchmark GPU trong cửa sổ Tauri.
- `source-manifest.json` giữ hash 958 file frontend/viewport/GPU/PPE lúc bắt đầu. Kiểm lại sau probe: không đổi source trong phạm vi đó.
- Evidence: `.tmp/viewer-compat-audit-2026-09-25/`: `native-corpus.json`, `corpus.json`, `pixels/corpus-gpu.json`, PNG/RGBA, `frontend-matrix.log`, `frontend-probes.log`, `native-baseline.log`, `audit-summary.json`, `runtime-tail.log`, probe source và `source-manifest.json`.
- Log người dùng gần nhất: trace `Vmugqpgkb-4yn9ti`. Đây là bằng chứng thao tác do người dùng thực hiện, không phải tôi đã điều khiển GUI và nghiệm thu các thao tác chưa được quan sát.

## Phát hiện đã xác nhận

| ID | Mức / công sửa | Bất biến bị vi phạm | Bằng chứng chính |
|---|---|---|---|
| R34.01 | P1 / L | Nội dung Viewer cũ xem được không được trở thành lỗi engine mới | 20 display / 14 PPE / 8 GPU; toast Luminosity thực tế |
| R34.02 | P1 / L | Chọn backend không được tự đổi display thành soft-proof hoặc bỏ cài đặt nền | Source consumer + pixel xanh RGB đối chứng |
| R34.03 | P1 / M–L | Đổi backend/công cụ phải giữ vị trí trang và trạng thái tương tác | Probe cuộn `(240,360)` → `(0,0)`, DOM bị tạo lại |
| R34.04 | P1 / M | Kết quả lỗi của revision cũ không được làm hỏng revision mới | Probe zoom trang 1 reject sau khi đã load trang 2 |
| R34.05 | P2 / M | Fit Page phải đặt cả tỷ lệ lẫn vị trí, không chỉ đổi zoom quanh điểm neo | Consumer Fit + controller thật cho pan sai tâm |
| R34.06 | P2 / M | Cảnh báo thông tin không được đánh đồng với thiếu năng lực GPU | Hai ca chữ bị loại GPU do `skipped_ops`, native PPE vẫn ready |
| R34.07 | P2 / M | Thước đo input → present phải thuộc đúng view/revision/input | InputStamp không có revision; timestamp cũ xuất hiện dưới revision mới |

### R34.01 — Fallback GPU → PPE không bao phủ năng lực Viewer cũ

**[CONFIRMED — ARTIFACT + log runtime].**

Trace: `AcrobatViewer.tsx:3041` → `useNativeGpuViewport.ts:202` → `viewport/commands.rs:120` → `scene_cache.rs:75` → `PreparedScene::new` → `RetainedRenderer::with_resources` → `DocumentRenderer::with_prepared_cancellable` → worker → status → `AcrobatViewer.tsx:3053`.

- `viewer_gpu/src/retained_renderer.rs:101` từ chối scene có cảnh báo độ tin cậy; dòng 122 từ chối RGB/non-separable.
- `desktop/src-tauri/src/viewport/document_renderer.rs:162` chỉ thử PPE accurate; dòng 181 biến `Unsupported` có kiểu thành chuỗi lỗi chung. Không có PDFium compatibility trong presenter này.
- `desktop/src-tauri/src/pdf_engine/render_worker.rs:1395` từ chối màu xấp xỉ. Log runtime ghi rõ `BlendMode /Luminosity ngoài blending space DeviceRGB`, sau đó frontend báo lỗi.
- Đường cũ `useTileRenderer.ts:811` phân loại `PPE_NATIVE_UNSUPPORTED`, giữ page trong `compatibilityPagesRef` và trả `invokeDisplayPng`. Native không dùng quyết định này; `AcrobatViewer.tsx:2597` lại xóa failure khi đổi trang nên có thể thử lại ca đã biết không hỗ trợ.
- JPX và fixture progressive JPEG còn thất bại ngay trong compile scene, trước khi tạo được `DocumentRenderer` để thử PPE. Không được gọi mọi thất bại này là file hỏng: display worker đã trả ảnh cho cả hai.

**Cần sửa:** quyết định capability có kiểu và dùng chung cho cả hai đường; phân biệt unsupported, cancel, lỗi tài liệu, I/O và lỗi GPU. Preview bình thường phải có đường tương thích hợp lệ từ đầu, giữ cố định engine của trang theo document revision và color intent. Soft-proof yêu cầu chính xác phải giữ thông tin giới hạn, không gắn nhãn `color-verified` cho ảnh PDFium. Không sửa bằng bỏ cảnh báo của PPE.

### R34.02 — Native không nhận ý định màu và cài đặt nền

**[CONFIRMED — TRACED + ARTIFACT].**

- Đường cũ tính `accurateColorEnabled` theo tùy chọn từng file và nền tối ở `AcrobatViewer.tsx:752`; truyền lựa chọn/profile/intent vào `useTileRenderer` tại dòng 833; nút CMYK thay state ở dòng 2894.
- `nativeSceneEligible` tại dòng 2576 không kiểm lựa chọn này. Props native tại dòng 3044 chỉ truyền file/page/token/visibility/scale/input, không truyền display/soft-proof hoặc nền. Camera/token không thay thế hợp đồng màu.
- `viewport/scene_worker.rs:7,14` cố định FOGRA39/Relative; `scene_cache.rs:39` cũng ghi rõ profile/intent native cố định. Thay đổi nút CMYK không thay config/scene của native.
- `LivePageFrame.tsx:6336` có nền đen theo `viewerDarkBackground`, trong khi surface native không nhận cài đặt đó.
- `rgb-green.pdf`: display worker pixel giữa `(0,255,0,255)`; accurate worker `(103,179,46)`; GPU `(103,179,46,255)`. Ảnh và bytes lưu trong `pixels/`. Đây là đổi ý định màu, không dùng phép so này để kết luận shader sai phép chuyển ICC.

**Cần sửa:** `RenderIntent/ColorContract` là đầu vào bắt buộc của mọi backend, có khóa cache theo intent/profile/nền; renderer chọn theo năng lực đáp ứng hợp đồng. Chưa hỗ trợ display/nền thì chọn đường cũ cho trạng thái đó. Không lấy GPU như một cờ thay thế chế độ xem màu.

### R34.03 — Hai camera độc lập, chuyển renderer làm mất trạng thái

**[CONFIRMED — AUTO; chưa thao tác lại ca này trong Tauri].**

- `NativeGpuViewportContainer.tsx:73`: `{!showingNative && children}` tháo toàn bộ cây trang/scroll khi HWND hiện. Tắt native, modal che hoặc chuyển công cụ sẽ tạo lại cây đó.
- Callback tại `AcrobatViewer.tsx:3052` chỉ đồng bộ `camera.zoom` về React; bỏ `pan_x/pan_y`. Không có chuyển đổi điểm neo trang ↔ scroll vào handoff.
- Probe dùng component/hook thật và IPC giả lập: trước chuyển có `scrollLeft=240`, `scrollTop=360`; sau GPU rồi quay lại, `sameNode=false`, cả hai giá trị thành 0. Đây không phải native pan được đo bằng GUI; nó chứng minh container không bảo toàn trạng thái scroll của consumer.
- Hạ nguồn: `useViewerZoom.ts:595` cập nhật minimap từ `internalScrollRef`; dòng 679–686 kéo minimap cũng đòi scroll DOM. Khi cây này bị tháo, adapter camera native chưa thay cho các consumer đó. Phần kéo minimap chưa được chạy lại GUI.

**Cần sửa:** một trạng thái viewport chuẩn gồm page instance, điểm neo trong trang, zoom/fit và vị trí; DOM/native là hai adapter. Chuyển đổi phải có ACK khung đúng revision/camera trước khi bàn giao input; không để mount/unmount quyết định camera. Giữ bitmap dự phòng đã hoàn tất hoặc cơ chế phục hồi state tương đương, không giữ hai bộ render nặng vô điều kiện.

### R34.04 — Nhánh lỗi thiếu hàng rào revision

**[CONFIRMED — AUTO].**

- `useNativeGpuViewport.ts:216` chụp revision trước `cameraCommand`. Nhánh thành công kiểm lại revision, nhưng `catch` tại dòng 224 chỉ kiểm `!lease.closed`.
- R33 giữ lease qua đổi trang, vì vậy cùng lease không đồng nghĩa cùng scene. Probe: load page 1 → gọi zoom còn pending → load page 2 → zoom page 1 reject. `onError` vẫn nhận lỗi một lần.
- Consumer `AcrobatViewer.tsx:3053` đặt `nativeGpuFailure` và toast; `nativeSceneEligible` chuyển false cho trang mới. Một thao tác cũ có thể vô hiệu hóa GPU của trang đúng.
- Pattern cần rà khi sửa: visibility `.catch(report)`, invalidation catch và cleanup callback. Chưa gọi các sibling đó là lỗi tái hiện nếu chưa có probe tương ứng.

**Cần sửa:** kiểm lease + generation + document/page revision ở cả success lẫn error; cancel/stale không là lỗi người dùng. Native command tác động camera cũng cần nhận revision để từ chối mutation đến muộn, không chỉ bỏ response ở frontend.

### R34.05 — Fit Page đi qua lệnh zoom giữ neo, thiếu đặt tâm

**[CONFIRMED — TRACED + probe controller; chưa GUI].**

- Toolbar/menu gọi `applyFitPage` (`AcrobatViewer.tsx:1442,2787`); `useViewerZoom.ts:159` đổi zoom/fit mode. Đường cũ căn tâm bằng DOM tại dòng 201.
- Native nhận mỗi `scale`, gọi `setZoom(scale)` ở `NativeGpuViewportContainer.tsx:66`; `commands.rs:345` áp `anchor_zoom` quanh tâm viewport. Nó giữ điểm đang nhìn, không căn toàn trang. Cây DOM thực hiện bước căn tâm đã bị tháo.
- Probe gọi controller production: viewport 800×600, trang 400×600, custom zoom 2 và pan `(-240,-360)`, chuyển target 0.873333. Pan nhận được `(120.533,11.8)`, tâm đúng `(225.333,38)`. `pixels/fit-camera.json` lưu kết quả. Đây là kiểm toán học của consumer, không phải bằng chứng đã bấm nút Fit trong app.

**Cần sửa:** phân biệt `ZoomAtPoint`, `FitPage`, `FitWidth`, `RestoreAnchor` trong hợp đồng camera. Fit phải tính theo page bounds/Rotate/UserUnit/DPR/padding thống nhất; không dùng lệnh zoom giữ neo để thay Fit.

### R34.06 — Loại GPU vì mọi `skipped_ops`, kể cả cảnh báo font

**[CONFIRMED — ARTIFACT; lỗi phân loại/performance, không kết luận mất chữ].**

- `print_engine/src/error.rs:73` phân biệt `ink_unsound`, `geometry_approximate` và thông tin thuần trong `skipped_ops`.
- `retained_renderer.rs:103` lại coi mọi `skipped_ops` là thiếu capability. Corpus `fixture-live-text` và `base14-font` ghi `font thay thế: Helvetica` rồi rời GPU dù scene đã có hình glyph; PPE worker trả ready, `geometry_approximated=true`.
- `render_worker.rs:1407` có chủ đích cho phép font fallback với metadata hình học. Không được xóa metadata này hoặc gọi các glyph thay thế là đúng tuyệt đối.

**Cần sửa:** capability typed theo từng nội dung thực sự không dựng được, tách độ tin cậy hình học/màu khỏi lỗi render. Giữ cảnh báo thay font; chỉ cho GPU xử lý khi có bằng chứng glyph/clip/metrics không kém chính đường dự phòng. Đây không phải lý do bỏ toàn bộ gate `skipped_ops` một cách mù quáng.

### R34.07 — Log input/present có thể gán timestamp cũ cho trang mới

**[CONFIRMED — TRACED + LOG].**

- `presenter.rs:19` định nghĩa `InputStamp` chỉ có sequence/time; `win32_host.rs:364` ghi vào `last_input`, dòng 756 gắn nó vào FrameRequest. `commands.rs:102` đổi scene nhưng không reset/bind input stamp theo revision.
- `presenter.rs:133` log bằng **revision của frame mới**. Bản log có `revision=6 input_seq=3 message_to_present_us=1001457` trong khi cùng frame có `request_to_present_us=30588`; timestamp input cũ kéo sang revision 6.
- Tổng hợp thô có 328 mẫu, nhưng không dùng max/p95 gộp này để tuyên bố input latency đạt hoặc fail. Nó gồm mẫu khác revision và chưa đo thời điểm scanout trên màn hình.

**Cần sửa:** gắn view/document/page/revision và loại input (pan/zoom/page-navigation), giữ chain input→camera→submit→present. Không ép delta log thành 0 hoặc bỏ mẫu chậm để làm đẹp benchmark.

## Ma trận audit dọc

Mỗi dòng nêu entry → handler/engine → artifact/consumer, hợp đồng và khoảng trống. Mức evidence chỉ áp cho phần đã thực hiện trong dòng, không nâng cả luồng GUI lên RUNTIME.

| Audit unit | Trace / hợp đồng | Evidence hiện tại | Còn thiếu trước nghiệm thu |
|---|---|---|---|
| R34-U01 Mở PDF thường | Loader/bootstrap → tile policy hoặc scene worker → PNG/scene → DOM/HWND; file identity, page 1-based | ARTIFACT: 20 display, 14 accurate, 8 GPU | Picker, DOM drop, native drop, encrypted/repaired PDF, installer |
| R34-U02 PDF ngoài năng lực GPU | Scene warnings → PreparedScene → PPE → status → Viewer; unsupported khác fatal | ARTIFACT + log lỗi user; R34.01 | Camera-preserving compatibility không toast kỹ thuật; quay lại trang không retry vô ích |
| R34-U03 Display/CMYK/nền | Nút CMYK/settings → tile policy hoặc native config → pixels; cùng color intent | ARTIFACT mẫu xanh + TRACED; R34.02 | RGB/Lab/ICC/spot/overprint corpus, nền tối, intent/profile đổi khi đang zoom |
| R34-U04 Công cụ/modal/fallback | NativeContainer → visibility → DOM consumer; camera/selection/page ownership | AUTO đỏ handoff; R34.03 | Tauri popup/menu/dialog thật, không nhảy vùng hoặc dựng lại trắng |
| R34-U05 Zoom/Fit/resize | Toolbar/useViewerZoom → IPC/controller → camera → presenter | Probe controller + test hiện hữu; R34.05 | Fit Page/Width, 100%, pan rồi Fit, chuyển màn hình 100/125/150/200% DPI |
| R34-U06 Chuyển trang nhanh | wheel reducer → navigatePage → revision → compile/refine → ACK | AUTO reducer; log warm ACK 41–56 ms; R34.04 | Trang nặng/chậm, đảo chiều, cùng file khác tab; frame cũ không nhận input |
| R34-U07 Font/chữ/liên kết/markup | PDFium text geometry + PPE scene → native interaction → React popup/store | Native tests + corpus font; R34.06 | Font không nhúng/CJK/Type3, copy multiline, liên kết PDF thật, search/highlight, nhân bản trang |
| R34-U08 Page boxes/rotation/UserUnit | Retained compile → page_to_view → pixels; PDF pt, DIP, physical px | Render thành công ca tổng hợp CropBox+Rotate+UserUnit, test native cũ | Pixel/hit-test đối chiếu đủ góc, box kế thừa, khổ trang hỗn hợp |
| R34-U09 Tab/vòng đời/cancel | React lease → registry owner/generation → scene revision → worker/close | 37 test native R33 chạy lại; AUTO đỏ stale error | Cửa sổ thật, tab nền/đóng, cancel trong decode/ICC, soak 30 phút |
| R34-U10 GPU/tài nguyên | GpuContext → surface/refiner/cache → present | TRACED + R33 artifact lịch sử | Device loss thật, OOM, adapter yếu, driver khác, VRAM/RAM theo thời gian |
| R34-U11 Hiệu năng đầu-cuối | Entry/input → compile/encode → present/visibility | LOG có scope; R34.07 | A/B cùng input, phần cứng, zoom, cache state; P01–P09 và ảnh density |
| R34-U12 Cutover/đóng gói | Setting → native gate; acceptance validator → evidence | Default false, mô tả thử nghiệm; acceptance UNOBSERVED | Bản cài đặt + golden độc lập + soak + runtime evidence đã băm |

## Những điều không được gọi nhầm là lỗi mới

- PPE từ chối gắn `color-verified` khi màu còn xấp xỉ là **EXPECTED**. Lỗi là chuỗi lựa chọn/fallback và UX chưa bảo toàn khả năng xem file.
- `showOutputPreview`, crop/object edit/ruler/overlay chưa hỗ trợ được loại khỏi native là lựa chọn có chủ đích. Vấn đề R34.03 nằm ở handoff sang các chế độ đó.
- R33 có cải thiện thật về lượng coverage và tái sử dụng trang. Không phủ định pixel byte-identical đã đo; chỉ giới hạn bằng chứng đó vào đúng PDF/camera đã kiểm.
- `PPE_VIEWER_GPU_TIENDO` đầu tài liệu đã đính chính các nhãn PASSED prototype cũ. Không lấy phần lịch sử cuối file để cáo buộc trạng thái hiện tại đang PASSED.
- GPU resident compositor nhanh không chứng minh file mở nhanh hoặc vùng mới luôn nét trong lúc zoom.

## Rủi ro chưa đủ bằng chứng để xếp severity

**[SUSPECTED / cần probe riêng]:** GPU_CONTEXT được giữ toàn process, chưa thấy đường tái tạo device/nguồn tài nguyên khi device thực sự mất; surface Lost/Outdated có reconfigure nhưng không tương đương device-loss recovery. Đường PPE fallback chờ render đồng bộ và vòng `device.poll(Wait)` có thể kéo dài đóng/present; chưa tái hiện deadlock/OOM nên không gọi là bug đã xác nhận. Chi phí song song giữa DOM renderer đang chuẩn bị và native cần đo riêng, chưa quy toàn bộ chậm cho việc render hai đường.

## Lộ trình sửa và chốt nghiệm thu

Không nên tiếp tục mở rộng shader rồi cho người dùng thử từng lỗi. Cần chốt ba hợp đồng chung trước, sau đó sửa thành lô nhỏ có ca đỏ → xanh.

| Lô | Kết quả phải có | Phạm vi triển khai và chốt |
|---|---|---|
| A — Hợp đồng capability/intent | Một quyết định backend cho mỗi doc/page/intent; có display compatibility; không suy GPU ⇒ soft-proof | Typed reason + adapter, chia ≤5 source/test file/lô. 20 ca đều xem được theo đúng intent; accurate không được gắn nhãn sai |
| B — Camera và handoff | Một nguồn camera/fit/anchor; đổi tool/modal/renderer giữ vùng đang xem | Container/hook/Viewer rồi native commands/controller ở lô kế. Hai chiều DOM↔native, minimap, Fit và DPI có test |
| C — Lifecycle | Không success/error/input của revision cũ tác động trang mới; cancel không toast | Hook/command/event schema, ≤5 file/lô; stale success/reject/visibility/close và multi-tab |
| D — Năng lực PDF còn thiếu | Ma trận font, blend CMYK/RGB, codec, mask/clip, ICC/spot được công khai; fallback hoạt động ổn định trước khi port thêm | Mỗi family là một lô, golden độc lập; không xóa gate tin cậy để ép xanh |
| E — Đo và scheduler | Trace có identity đầy đủ; giảm cold/open/settle đúng bottleneck đã đo | Sửa R34.07 trước benchmark. Không dùng 4 ms submit budget hoặc 31 ms warm test làm claim UX toàn cục |
| F — Nghiệm thu | Cùng corpus và thao tác chạy cả Viewer cũ/mới, dev/installer; có bằng chứng tự động và GUI | P01–P09, ảnh màu/hình học, DPI, popup, multitab, cancel, soak 30 phút; chỉ chuyển mặc định khi đạt |

Chốt chống hồi quy tối thiểu:

1. Mọi fixture baseline xem được phải tiếp tục có frame hợp lệ; unsupported là quyết định capability, không là màn hình lỗi vô cớ.
2. Cùng display/soft-proof intent mới được so pixel; thêm Acrobat/renderer độc lập cho màu, không chỉ GPU so PPE cùng compiler.
3. Handoff giữ điểm neo trong sai số 1 pixel; Fit đặt đúng trang, không giữ pan của thao tác cũ; input chỉ tới revision đang hiện.
4. Dùng ngưỡng P01–P09 đã có, với baseline cùng phần cứng/chất lượng. P08 không chậm hơn baseline quá 10%; chưa có đo A/B thì chưa được PASS.
5. Native được bật trong setting không phải bằng chứng đang dùng GPU. Log phải nêu producer thực tế GPU/PPE/PDFium và lý do chọn, không đổi theo từng wheel.
6. Cổng nghiệm thu hiện có đã fail-closed đúng: trong `.tmp` và `tests/viewer_gpu` không tìm thấy `runtime-evidence.json`; bản `runs/latest/runtime-acceptance.json` là UNOBSERVED. Đây là khoảng trống phải hoàn thành, không sửa validator để vượt qua.

## Kiểm thử đã chạy trong lượt audit

| Kiểm | Kết quả / phạm vi |
|---|---|
| Frontend Viewer matrix, bản sao source hiện tại | 253 passed, 2 failed là hai probe hồi quy mới; 13 test file |
| Native viewport harness R33 đã build ở lượt trước, chạy lại | 37 passed, 5 ignored; không gọi là vừa rebuild harness từ source mới |
| Native worker executable hiện tại, protocol thật | 40 response; 20/20 display ready, 14/20 accurate ready, 6 unsupported; exit 0 |
| GPU source hiện tại, 20 PDF/ca thật | 8 direct render; 10 từ chối capability; 2 lỗi compile codec. Có artifact cho ca render thành công |
| Đối chứng màu | PDFium native xanh `(0,255,0)`; PPE/GPU `(103,179,46)` |
| Handoff/late error | Hai probe đỏ, có console evidence và assertion output |
| Source integrity | 958 hash trong phạm vi audit không đổi |
| GUI và installer | Chưa thực hiện. Native computer automation không khả dụng trong phiên này; chỉ dùng log thao tác user đã có |

Không chạy lại typecheck/build production vì không sửa production source. Không cập nhật golden để làm xanh. Không đóng PrynX, không đổi setting người dùng và không khởi động run_dev.

Phạm vi audit này kết thúc ở báo cáo và kế hoạch sửa. Theo quy trình dự án, các lô sửa phải đi sau chốt danh sách; chưa có tuyên bố “đã sửa” cho các finding R34.
