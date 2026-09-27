# Đề xuất chốt kiến trúc PPE Viewer dài hạn

Ngày: 25/09/2026. Trạng thái: **thiết kế đích đề xuất, chưa triển khai hoặc nghiệm thu GPU/native viewport**.

Yêu cầu: một hướng phát triển thống nhất để zoom/pan nét và nhanh, chấm dứt chuỗi vá timer rồi nhờ người dùng thử lại. Tài liệu này thay phần định hướng thăm dò F–H ở `RENDER_ZOOM_RUNTIME_FIXES_2026-09-25.md` bằng một kiến trúc đích và các chốt triển khai. Các kết quả đo/bản sửa trước vẫn giữ nguyên giá trị và giới hạn đã ghi.

Kế hoạch chi tiết: [Triển khai PPE Viewer GPU và native viewport](KE_HOACH_TRIEN_KHAI_PPE_VIEWER_GPU_2026-09-25.md) — gói việc G0–G4, ranh giới module/process, tiêu chí nghiệm thu, log/replay, chuyển consumer, rollback và ước lượng nguồn lực. Các gate hiện chưa được triển khai/nghiệm thu.

## 1. Quyết định đề xuất

**Xây PPE Viewer dựa trên scene bất biến, render graph và raster/composite GPU, trình bày bằng native viewport có vòng frame riêng.** Giữ Tauri/React cho shell/panel; giữ PPE làm nguồn semantics PDF, màu, chữ, clip và transparency. CPU PPE là backend tương thích và đường đối chiếu, không chuyển PDFium/PPE theo động tác zoom.

Hướng này kế thừa quyết định `KE_HOACH_KIEN_TRUC_VIEWER_KHONG_PDFIUM_2026-08-13.md` về Viewer PPE thuần Rust. Thay đổi so với kế hoạch đó: trình bày pixel chuyển từ WebView compositor sang viewport native; GPU raster trở thành phần của đích kiến trúc, không còn là ý tưởng tối ưu tùy hứng cuối lộ trình. Đây là một dự án thay lõi Viewer, không phải một patch hoặc đổi thư viện là xong.

Chọn **Rust + wgpu** làm lớp truy cập GPU, ưu tiên D3D12 trên Windows khi adapter đáp ứng hợp đồng. Phiên bản sẽ được pin cùng toolchain/MSRV ở chốt tích hợp. wgpu cung cấp API đồ họa native có backend D3D12/Vulkan/Metal/OpenGL, **không cung cấp PDF interpreter hay bảo đảm màu PPE**. Shader, tài nguyên, raster và kiểm đúng semantics vẫn là phần việc của PrynX. Nguồn: [tài liệu wgpu](https://docs.rs/wgpu/latest/wgpu/).

Không dùng một thư viện vector RGB làm vật thay trực tiếp InkSpace CMYK/DeviceN. Skia/Vello có năng lực vẽ 2D nhưng không phải bằng chứng sẵn có cho toàn bộ hợp đồng PDF chế bản của PrynX; Vello còn mô tả các backend với mức trưởng thành khác nhau. Nguồn: [Skia](https://skia.org/docs/user/), [Vello](https://github.com/linebender/vello/blob/main/README.md). Đây là lý do không chốt một lời hứa “thay sang Skia/Vello sẽ ngang Acrobat”.

## 2. Khoảng cách so với code hiện tại

| Bằng chứng đã đọc/đo | Ý nghĩa kiến trúc |
|---|---|
| `print_engine/src/page_program.rs`: lưu `Operation`, inline image và provenance decode | Đã bỏ tokenize lặp; chưa phải danh sách primitive với graphics state/bounds/dependency đã phân giải |
| `session.rs::PreparedPageRender::raster` gọi lại `render_page_descriptor`; `content/interp.rs::execute_program_inner` lặp operator và dựng state/path | Snapshot/job bất biến đã có, nhưng không thể gọi toàn bộ đường này là retained render scene hoàn chỉnh |
| 20 viewport warm: render trung vị 330 ms, worker 351,5 ms, gửi IPC 0–2 ms | Cần thay phần tạo pixel; chỉ tối ưu giao tiếp không đạt mục tiêu |
| `viewportTilePresentationItems` có nhánh ẩn ảnh cũ thiếu coverage | Quyền sở hữu pixel và vùng phủ cần thuộc compositor thống nhất |
| Long task UI 51–107 ms, một request thêm 194 ms sau nhận byte | Vòng present không nên phụ thuộc reconciliation/layout của panel React |
| PNG encode trung vị 20 ms | Bỏ PNG là cải thiện phụ; tăng tốc GPU chỉ để scale PNG cũ không giải quyết raster 330 ms |

Số đo lấy từ trace `Vmug8p305-zncw82`, đúng file Desktop/trang 1, snapshot và SHA trong báo cáo runtime. Có chi phí raster kể cả khi logging tắt ở benchmark worker trước đó. Chưa đo GPU/VRAM trên máy này; không suy mục tiêu GPU từ RAM 32 GiB/16 logical CPU.

## 3. Luồng dữ liệu đích

```text
PDF + document revision
          ↓
PPE ObjectStore / ResourceStore hiện có
          ↓
SceneCompiler → scene primitive bất biến, graphics state, bounds, dependencies
          ↓
RenderGraph → clip / mask / transparency group / paint order / color contract
          ↓
Viewport scheduler + cache nhiều mức theo tọa độ trang
          ↓
PPE GPU raster/composite ── CPU PPE cho đơn vị tương thích đã xác định
          ↓
Texture/surface pool + color resolve
          ↓
Native viewport: swap/present + selection/annotation overlay

React shell/panel ⇄ lệnh tài liệu, hình học viewport, trạng thái công cụ
```

GPU phải tham gia **tạo coverage/mask và composite**, không chỉ phóng to texture của frame cũ. Những primitive vector đang nhìn được raster theo mật độ màn hình hiện hành. Bitmap ảnh nguồn dùng sampler/mipmap phù hợp; không tạo thêm chi tiết không tồn tại trong ảnh gốc.

### 3.1. Scene và render graph

- Scene sống theo document revision/page, tái dùng ObjectStore/ResourceCache; compile trang đang xem trước, không buộc dựng cả tài liệu.
- Primitive mang path/glyph/image/shading, resource ID, CTM, clip, graphics state, paint order và bounds bảo thủ. Trạng thái phụ thuộc zoom như hairline, hinting, AA và sampling giữ ở device stage, không đóng cứng trong scene.
- Form/Pattern/Type3 dùng chương trình chia sẻ nhưng invocation giữ state/resource scope riêng. Không cache theo ObjectId đơn lẻ khi trạng thái bên ngoài khác nhau.
- Render graph biểu diễn quan hệ group/mask/backdrop, isolation/knockout và overprint. Culling chỉ được bỏ công việc sau khi xét dependency và vùng ảnh hưởng; không chia tùy tiện từng đối tượng transparency thành các lớp độc lập.
- Đổi zoom/pan làm đổi view transform và vùng cần raster; đổi nội dung/profile/OCG làm invalidation đúng dependency. Không diễn giải lại toàn bộ chuỗi PDF để phục hồi cùng graphics state cho mọi tile.

### 3.2. GPU và hợp đồng màu

- Một hợp đồng PPE duy nhất: page box/rotation, View/Proof, overprint, blend space, alpha, ICC/profile/intent và DeviceN/spot. CPU và GPU triển khai cùng hợp đồng; không gọi thay đổi backend là thay chế độ màu.
- GPU storage phải giữ dữ liệu mực và alpha đủ cho các stage cần chúng. Chỉ resolve sang RGB màn hình ở biên đã quy định. Không chuyển CMYK/spot thành sRGB sớm rồi blend sai không gian.
- Chốt capability theo **đơn vị render có dependency đầy đủ** khi chuẩn bị graph. Phần chưa hỗ trợ GPU chạy CPU PPE; với nhóm phụ thuộc backdrop phải bao cả nhóm/ranh giới compositing hợp lệ. Không fallback tùy thời gian wheel hoặc thấy chậm mới đổi engine.
- CPU fallback có thể tạo pixel rồi upload; GPU path thông thường phải giữ kết quả trên GPU tới present, không đọc lại toàn frame về CPU mỗi wheel. ICC trên GPU chỉ được dùng nếu qua kiểm chứng màu; CPU ICC có chi phí và phải nằm trong benchmark, không ẩn khỏi số đo.
- GPU device loss có quy trình dựng lại tài nguyên từ scene và backend CPU PPE khi cần. Hành vi đúng được giữ; tốc độ của máy không có GPU phù hợp phải báo riêng, không hứa cùng SLA.

### 3.3. Tile và vòng frame

- Tile neo ở tọa độ trang; cache tách dữ liệu scene, tài nguyên và kết quả raster nhiều mức. Key gồm revision, page, view/proof contract, scale/device sampling và region; không dùng ảnh khác profile để lấp vùng trống.
- Scheduler nhận target mới nhất, ưu tiên vùng nhìn và dependency cần thiết; phần làm xong còn hữu ích được giữ. Đơn vị công việc có checkpoint/cancellation; không hủy cả frame trên từng wheel.
- Compositor quản lý vùng phủ và biên tile; phần nét cũ có thể đóng góp trong lúc bổ sung phần thiếu. Swap chỉ nhận surface hợp lệ, đúng revision/pipeline; không xóa ảnh đang hiện trước khi có phần thay thế.
- Gutter/clip/AA được quy định theo vùng phụ thuộc của phép vẽ. Không lấy một viền vài pixel cố định làm đúng cho mọi filter/mask. Kiểm zoom phân số, DPR, rotation và cạnh trang.
- Ngân sách CPU RAM/VRAM dựa trên phần cứng và áp lực thực. Tuân thủ tier RAM PrynX, không cap worker/chất lượng vô điều kiện trên máy mạnh. Giới hạn texture/adapter là capability phải xử lý bằng partitioning/fallback, không bằng bỏ nội dung.

### 3.4. Native viewport và UI

- Native viewport sở hữu frame clock, input zoom/pan, camera transform, hit-test và overlay đồ họa trong vùng PDF. React giữ menu, panel, tài liệu/công cụ và nhận snapshot trạng thái; frame không chờ React dựng lại cây component.
- Đưa cả overlay selection/annotation cần đồng bộ pixel vào cùng presenter. Editor text/IME, accessibility, context menu, drag/drop, focus và cửa sổ nổi phải có hợp đồng với shell; không giả định canvas native có thể chèn dưới DOM mà tự hết lỗi z-order.
- Chốt embedding bằng native surface/child viewport ở Windows. Bài kiểm tích hợp phải xử lý resize, per-monitor DPI, minimize/restore, multiwindow và panel che viewport. Nếu embedding chưa đạt, chưa được chuyển Viewer thật sang renderer mới.
- Không sử dụng PNG/Blob/ImageBitmap làm hợp đồng bắt buộc giữa renderer và màn hình. PNG giữ vai trò ảnh kiểm chứng/xuất/debug. Shared CPU buffer phục vụ CPU fallback hoặc phép đo; API shared buffer WebView2 chỉ trả bộ nhớ dùng chung/ArrayBuffer, không tự chứng minh chia sẻ texture GPU hay zero-copy tới màn hình. Nguồn: [Microsoft CreateSharedBuffer](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2environment12).

## 4. Ranh giới module và API phải khóa trước triển khai rộng

Tên dưới là module/crate đích đề xuất, chưa có trong repo:

| Thành phần | Trách nhiệm | Không được sở hữu |
|---|---|---|
| PPE scene/compiler | semantics PDF, primitive, dependency, capability | window/React, timer UI |
| PPE render graph | stage và dữ liệu màu/mask, invalidation | DOM hoặc chính sách panel |
| PPE GPU backend | GPU resources, kernels, fences và kết quả stage | giải nghĩa PDF lần hai |
| PPE CPU backend | compatibility/reference cùng graph contract | tự đổi profile để tăng tốc |
| Viewer runtime | scheduler, camera, tile coverage, surface lifecycle | gọi lại metadata toàn file mỗi wheel |
| Tauri viewport adapter | window/input/DPI/accessibility bridge, lifecycle | kernel màu hoặc cache scene |
| React viewer shell | document/tool commands, panel state | vòng raster/present của từng frame |

Hợp đồng tối thiểu: `DocumentRevision`, `SceneRevision`, `ViewTransform`, `ColorContract`, `CapabilityPlan`, `RenderTarget`, `SurfaceLease`, `FrameCommit` và event input/present. Handle tài nguyên có owner/lifetime; chỉ nhận message đúng revision. Không truyền GPU pointer/handle tùy ý vào WebView. Process isolation cho nội dung PDF/worker được giữ; native presenter và worker thống nhất ownership, recovery và synchronization qua API rõ ràng.

Phân bố process cụ thể phải được chốt cùng bài kiểm embedding: renderer sở hữu device/texture/present, compiler/CPU worker gửi scene/resource hoặc surface qua giao thức có version. Không thiết kế đường GPU xong rồi mới phát hiện phải copy toàn frame qua IPC để đưa vào WebView.

## 5. Cách làm để không lặp chuỗi thử trên người dùng

Trình tự cố định, mỗi milestone có đầu ra và tiêu chí đạt. Lô source/test/tài liệu ≤5 file theo quy ước repo; đó là đơn vị review, không phải thay đổi hướng sau từng lô. Không phát các bản giữa chừng vào Viewer đang dùng để nhờ người dùng đoán cảm giác.

| Mốc | Đầu ra phải có | Điều kiện chuyển tiếp |
|---|---|---|
| G0 — khóa hợp đồng và bài nghiệm thu | Schema scene/graph/surface; hardware GPU/driver; corpus và trace cố định; embedding/overlay/native present; chi phí logger được tách | Giải quyết được lifetime, process boundary và z-order; không có giả định zero-copy chưa chứng minh |
| G1 — scene đúng | Compiler từ PPE hiện có, CPU replay graph và invalidation | Cùng nội dung/clip/màu với golden đã duyệt; không dùng PPE hiện tại làm nguồn chân lý duy nhất; camera đổi không compile lại cùng scene |
| G2 — GPU renderer đúng và đủ nhanh | Raster/mask/composite/color contract, capability/fallback, recovery | Toàn bộ scene của PDF mục tiêu có đường chạy rõ; benchmark đúng vùng nhìn đạt ngân sách; không lấy scene toy hoặc chỉ chữ thay cho nhóm mask nặng |
| G3 — viewport hoàn chỉnh | Scheduler/cache/presenter, input/overlay/IME/accessibility; replay zoom/pan | Không chớp, sai vùng, đổi màu; tiến triển nét khi wheel; kết quả đo present thật cùng nguồn pixel |
| G4 — chuyển đổi | Adapter viewer/thumbnail và cổng lựa chọn toàn renderer theo phiên; bộ consumer đã rà | Full regression + corpus + benchmark; cutover theo phiên, không trộn renderer mới/cũ trên mỗi frame; giữ rollback toàn phiên tới lúc nghiệm thu |

G0/G2 là kiểm chứng bắt buộc của thiết kế, có phạm vi và tiêu chí dừng rõ; không có lời hứa loại bỏ mọi bất định của GPU/driver/màu. Nếu một mốc không đạt, ghi đúng lý do và không triển khai nửa chừng cho người dùng. Không đổi kiến trúc bằng cách chèn thêm timer để làm xanh phép đo.

## 6. Tiêu chí nghiệm thu đề xuất

Các con số sau là **ngân sách thiết kế trên phần cứng hỗ trợ đã ghi nhận**, chưa phải số đo hoặc cam kết đã đạt. Tách cold-open, warm zoom, first visit zoom chưa cache, revisit/pan đã cache và CPU compatibility.

- Vòng compositor warm: p95 ≤16,7 ms ở màn hình 60 Hz; input → present p95 ≤33 ms cho camera/ảnh đã resident. Không dùng số này để gắn nhãn “ảnh mới đã nét”.
- Warm viewport nội dung mới: p95 ≤100 ms từ target được nhận đến ảnh đạt chuẩn vùng nhìn trên corpus mục tiêu; ảnh cuối sau dừng p95 ≤150 ms. Phải kiểm cả first visit vào mức zoom chưa cache, không chỉ đảo qua hai mức đã warm.
- Trong chuỗi wheel: đo liên tục coverage, mật độ và tuổi ảnh từng vùng; vùng nhìn được refine trong gesture dài, không chỉ frame sau idle. Mật độ pixel là điều kiện cần; glyph/gradient vẫn phải qua kiểm hình ảnh.
- Sau ảnh đầu: 0 blank frame do pipeline, 0 seam trắng/sai clip/stale commit, 0 lần đổi engine/profile theo wheel. Không dùng opacity/crossfade để che khác màu.
- Chất lượng: corpus gồm chữ live/outline, Type3, CJK, scan, gradient, SMask, nested transparency/knockout, CMYK/spot/DeviceN, overprint View/Proof, OCG và annotation. Golden PDF-spec/ảnh đã duyệt; so Acrobat ở cùng page box/profile/DPR/zoom. Dung sai màu và mép AA phải được chốt theo loại phép so trước khi chạy, không nới sau khi thấy sai.
- Tài nguyên: không tăng bộ nhớ/handle qua vòng mở/đóng/đổi file kéo dài; thu hồi khi device loss; chất lượng không bị hạ vô điều kiện trên máy mạnh. Ghi cả cold cost xây scene và RSS/VRAM của cache.
- Phép đo tự động ghi input, submit, raster, present, frame capture và provenance source/binary/PDF/profile/GPU. Logger async có đếm mất bản ghi, kiểm bật/tắt. Không gọi unit test, browser mock hoặc rAF của DOM là nghiệm thu native.

## 7. Điều gì đã chốt và điều gì chưa được phép hứa

Đã chốt trong đề xuất: giữ PPE; scene/graph là lõi; GPU tạo pixel; native viewport độc lập React; một hợp đồng màu; cache/tile dựa trên revision và vùng phủ; thay renderer theo milestone có gate. Không tiếp tục xem chỉnh timer/đổi PNG là giải pháp dài hạn.

Chưa chốt bằng thực nghiệm: GPU adapter của máy, tốc độ graph thực, độ đúng mọi shader/màu, embedding/overlay, phạm vi CPU fallback và lịch hoàn thành. Không thể hứa “ngang Acrobat trên mọi PDF” chỉ từ tên kiến trúc. Nếu yêu cầu là loại bỏ cả công việc nghiên cứu/kiểm chứng một PDF renderer riêng, điều đó mâu thuẫn với quyết định tự làm PPE và cần quyết định sản phẩm mới về sử dụng SDK bên ngoài; tài liệu này không tự ý đảo quyết định đó.

Đầu ra người dùng nhận ở mốc nghiệm thu là một Viewer hoàn chỉnh kèm báo cáo so sánh, không phải nhiều lượt “đổi một chỗ rồi zoom thử”.
