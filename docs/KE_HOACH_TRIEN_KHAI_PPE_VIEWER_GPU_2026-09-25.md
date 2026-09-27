# Kế hoạch triển khai PPE Viewer GPU và native viewport

Ngày: 25/09/2026. Trạng thái: **kế hoạch để duyệt triển khai; chưa xây hoặc nghiệm thu renderer mới**.

Mục tiêu: làm nét nhanh trong lúc zoom/pan, giữ đúng nội dung và màu chế bản, chấm dứt việc thay timer rồi yêu cầu người dùng thử từng bản nhỏ. Đây là dự án nâng cấp lõi Viewer, với đích kiến trúc cố định và các cổng kiểm chứng có tiêu chí định trước.

Tài liệu này cụ thể hóa [quyết định kiến trúc dài hạn](QUYET_DINH_KIEN_TRUC_PPE_VIEWER_DAI_HAN_2026-09-25.md), kế thừa [quyết định Viewer PPE thuần Rust](KE_HOACH_KIEN_TRUC_VIEWER_KHONG_PDFIUM_2026-08-13.md). Phần triển khai tương lai ở đây thay hướng nâng cấp từng bước trong [kế hoạch ngày 24/09](KE_HOACH_NANG_CAP_RENDER_VIEWER_2026-09-24.md); các bất biến và bản sửa đúng đã có vẫn được giữ.

## 1. Kết quả cần bàn giao

Một Viewer hoàn chỉnh gồm **PPE scene dùng lại → render graph → GPU raster/composite → native viewport có vòng frame riêng**. React tiếp tục quản lý shell, panel, công cụ và trạng thái nghiệp vụ. PPE tiếp tục quyết định semantics PDF, page box, chữ, màu, overprint và transparency.

Khi zoom, camera phản hồi ngay bằng nội dung hiện có; GPU tạo nội dung ở mật độ mới trong khi thao tác vẫn tiếp diễn. Không đợi người dùng dừng mới bắt đầu làm nét. Khi pan sang vùng chưa có, scheduler ưu tiên phần thiếu nhưng vẫn giữ các vùng đang hợp lệ.

Phạm vi bàn giao:

- Viewer chính, chế độ một/nhiều trang, thumbnail, View/Proof, OCG, overlay và tương tác đang sử dụng Viewer.
- Bộ replay và log tự đọc được, bộ đối chiếu hình ảnh, báo cáo hiệu năng và tài nguyên có provenance.
- Đường PPE CPU tương thích cùng hợp đồng màu; phục hồi device loss; chuyển về Viewer cũ theo phiên khi cần.
- Tích hợp dev/release, cập nhật dependency có khóa phiên bản và tài liệu vận hành.

Không thay engine Print, Compare, Edit/Geometry, Preflight, VDP, N-up hoặc Sticker trong đợt này. **Phần preview/overlay của các công cụ đó nằm trong Viewer vẫn phải được chuyển đủ.** Không đưa PDFium, PDF.js, MuPDF hay SDK PDF khác vào đường pixel Viewer mới. Không đổi dữ liệu tài liệu, undo/redo hoặc format file xuất để thuận tiện cho renderer.

## 2. Cơ sở và giới hạn của số đo hiện tại

### 2.1. Ca bắt buộc R01: trang 1 tài liệu người dùng

Định danh dưới đây lấy từ runtime đã thu, không suy từ tên file:

| Thuộc tính | Giá trị |
|---|---|
| File thực tế trong trace | `C:\Users\Khanh Pham\Desktop\PDF\CMNM2026 - Giay moi_BLUE - in.pdf` |
| Trang | 1, tính từ 1 |
| Kích thước | 17.869.243 byte |
| SHA-256 | `95f38cf429fe7dd7c6500043ce308fd2e87e80a2290217d428fe0c68c6098184` |
| Máy đã đo | 16 logical CPU, RAM 32 GiB, DPR 1 |
| Chưa có | GPU adapter, driver, VRAM/budget và native present timing |
| Trace | `Vmug8p305-zncw82`, 88 wheel input/10 gesture, 20 viewport ready |
| Snapshot | `D:\pdfcompare\.tmp\render-r25-09\native-after.snapshot.log` |
| SHA-256 snapshot | `f0563577890b9dd0d5f2c850b07c84910bcc7a4daef25ab9be6f54a45ccc4817` |

Đường dẫn người dùng từng gửi là `D:\pdfcompare\test\CMNM2026 - Giay moi\_BLUE - in\_OUTLINE\_FONTS\_5e2846.pdf`. Không tự coi file gần giống tên là cùng tài liệu. Runner phải xác nhận SHA R01; sai hash thì báo sai fixture, không âm thầm chạy rồi so kết quả.

| Thành phần | Kết quả đã đo | Hệ quả cho kế hoạch |
|---|---|---|
| Gửi IPC → native entry | 0–2 ms, trung vị 1 ms | Không còn là nút thắt chính trong trace này |
| PPE render | 269–478 ms, trung vị 330 ms | Phải thay đường tạo pixel |
| Worker tổng | 288–511 ms, trung vị 351,5 ms | Bỏ encode chỉ giải quyết một phần |
| Encode | 16–28 ms, trung vị 20 ms | Đường GPU không cần PNG giữa raster và màn hình |
| Frontend tổng request | 296–684 ms, trung vị 395,5 ms | Cần đo cả queue, receive và present |
| Sau wheel cuối → mẫu ảnh hiện có density ≥0,98 | 393–911 ms, trung vị 574 ms | Trải nghiệm cuối gesture còn chậm |
| UI long task trong khoảng zoom | 31 task, 51–107 ms | Vòng frame phải độc lập React |

Đây là một lượt thao tác, không phải phân phối benchmark đủ rộng. Density và mẫu DOM không chứng minh ảnh thực sự nét hoặc đã hiện lên màn hình. Báo cáo chi tiết: [runtime và các bản sửa](RENDER_ZOOM_RUNTIME_FIXES_2026-09-25.md).

### 2.2. Phần có thể tái sử dụng

- `print_engine/src/page_program.rs:31`: `PageProgram` đã cache operator/inline image; chưa có đầy đủ primitive, state phân giải, bounds và dependency.
- `print_engine/src/session.rs:616,654`: `PreparedPageRender` giữ snapshot/session/resource; raster vẫn gọi render trang.
- `print_engine/src/content/interp.rs:1082`: vòng thực thi operator; các điểm mask/group/image tại 2522/3021/3394. Đã có ROI/cache ở một số nhánh; không làm lại với giả định hiện tại chưa có.
- `color/`, `image/`, `text/`, `shading/`, `ink.rs`, `blend.rs`, `oc.rs`: tái sử dụng semantics và kiểm thử. Tách phần phân giải khỏi phần tạo pixel, không viết lại parser/font/codec đồng loạt.
- Worker/process ownership, revision, cancel, page geometry và kiểm stale đã có: giữ hợp đồng đúng, bổ sung adapter.

**R01 có chi phí image/soft mask/transparency đáng kể. G2 không được nghiệm thu bằng demo chữ/vector đơn giản trong khi toàn bộ phần nặng này vẫn chạy CPU mỗi zoom.**

## 3. Quyết định kỹ thuật phải giữ xuyên suốt

### 3.1. Quyền sở hữu và đường dữ liệu

Thiết kế xuất phát cho G0:

```text
Worker PPE cách ly: đọc PDF → scene/graph bất biến + resource → CPU compatibility
                               │ giao thức có phiên bản, resource gửi một lần
                               ▼
Native host: kiểm message → GPU device + runtime → surface của viewport → present
                               ▲
React shell: document/tool commands, viewport rectangle, trạng thái panel
```

GPU device, texture pool và presenter cùng process native host để đường GPU thông thường không cần chia sẻ texture xuyên process hay readback mỗi frame. Parser/codec PDF và CPU fallback ở worker. Scene nhận từ worker vẫn được kiểm schema, kích thước, chỉ số, revision và lifetime trước khi dùng; không coi IPC nội bộ là dữ liệu mặc nhiên đúng.

Đây là **phân bố đề xuất cần được G0 xác nhận**, không phải khả năng đã chứng minh của Tauri hiện tại. G0 phải ghi nhận phạm vi cách ly thực tế: worker lỗi không kéo sập host; GPU/device lỗi có recovery; device/driver lỗi vẫn có rủi ro riêng. Nếu phải đổi phân bố process để đáp ứng yêu cầu cách ly, cập nhật quyết định trước G1; không giấu một đường copy toàn frame phía sau chữ “zero-copy”.

CPU fallback trả surface cùng color/alpha/geometry contract qua vùng nhớ có ownership rõ; upload chỉ khi nội dung thay đổi. Thumbnail có thể readback/encode theo nhu cầu; không biến thumbnail thành lý do readback Viewer trên từng wheel.

### 3.2. Hợp đồng API

| Hợp đồng | Trường/điều kiện bắt buộc |
|---|---|
| `DocumentRevision` | identity/hash hoặc token đã xác thực, edit revision; phân biệt file gốc và tài liệu sửa trong bộ nhớ |
| `SceneRevision` | document/page/resource revision, phiên bản compiler; camera đổi không tự đổi scene |
| `ViewTransform` | page↔viewport↔physical pixel, page box, rotation, UserUnit, DPR; quy ước điểm neo zoom |
| `ColorContract` | View/Proof, profile hashes, rendering intent, black-point policy, overprint, blend space, alpha representation, output transform |
| `CapabilityPlan` | backend từng graph unit, lý do fallback, dependency/backdrop cần có, phiên bản capability |
| `RenderTarget` | window/tab/view/page owner, target sequence, camera, vùng nhìn, chất lượng và deadline |
| `SurfaceLease` | resource ID, owner/device epoch, format/stride/extent, fence/lifetime; không truyền raw pointer vào JS |
| `FrameCommit` | revision, target, tile coverage, nguồn pixel, color contract, frame ID; không nhận scene/profile/device cũ |
| `OverlayModel` | object ID, page coordinates, z-order, hit-test, selection/tool state; giữ nguồn nghiệp vụ ở store/session hiện tại |

Giao thức đóng/mở/đổi revision có ACK và timeout/recovery; job đến muộn bị từ chối. Kết quả của target camera cũ chỉ được tái dùng qua cache sau khi xác nhận còn đúng document/color/geometry; không commit nguyên frame stale.

### 3.3. Native viewport và lớp phủ

Một native viewport cho mỗi **view đang hiển thị**, chứa cả bố cục các trang và khoảng trống; không tạo HWND cho từng tile/trang. Hai khung xem đồng thời là hai view owner. Hidden tab nhả quyền input/present, dù React vẫn mounted.

Chọn bố cục vùng native riêng: toolbar/sidebar/panel nằm ngoài rectangle đó. Chỉ bố cục chưa giải quyết toàn bộ menu/modal: các thành phần buộc chồng lên vùng PDF phải có cách host rõ ràng và được kiểm ở G0.

- Vùng chọn, guide, thước đo trong trang, crop, annotation và thao tác hình học: native overlay đồng bộ camera/frame.
- Context menu đi qua bộ lệnh dùng chung nhưng dùng native/owned popup có z-order phù hợp. Không giả định React portal có thể phủ lên child HWND.
- Text editor/IME và các card tương tác: kiểm owned editor surface hoặc vị trí trong panel; chốt phương án mà không mất nhập tiếng Việt, clipboard, undo hoặc liên kết vị trí trang.
- Modal chặn toàn ứng dụng: cơ chế che/ẩn viewport có chủ đích khi modal mở, rồi phục hồi đúng camera/scene; kiểm focus, Alt+Tab và cancel. Không dùng cơ chế đó để che lỗi chớp khi zoom.
- Accessibility, tab order và đường điều khiển bàn phím là điều kiện bàn giao, không để sau cutover.

Microsoft phân biệt windowed/visual hosting và yêu cầu host tự xử lý thêm input/scale với visual hosting. Vì vậy không coi đổi hosting mode là một cờ bảo đảm hết vấn đề tích hợp. [Nguồn Microsoft](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/windowed-vs-visual-hosting).

### 3.4. GPU và CPU fallback

Chọn Rust/wgpu, ưu tiên D3D12 trên Windows; pin phiên bản tương thích toolchain và MSRV của repo tại G0. wgpu cung cấp API GPU, không cung cấp semantics PDF. [Nguồn wgpu](https://docs.rs/wgpu/latest/wgpu/).

Compiler/graph xác định fallback trước khi submit. Fallback chạy **đơn vị có đủ dependency**, có thể là cả group hoặc vùng lớn hơn khi cần backdrop. Không raster riêng một đối tượng trong nhóm non-isolated rồi dán như ảnh độc lập. Group blending/alpha phải theo mô hình PDF. [Errata PDF về transparency](https://pdf-issues.pdfa.org/32000-2-2020/clause11.html).

Ưu tiên GPU gồm path/glyph coverage, image sampling, soft mask, group composition và color resolve thực sự xuất hiện trong R01. CMYK/DeviceN/spot không được chuyển sớm sang sRGB rồi blend cho tiện. Dữ liệu mực/alpha/shape tồn tại đến đúng biên resolve. LUT/ICC GPU chỉ được dùng cho class transform đã qua kiểm màu; chi phí mọi CPU ICC/readback phải tính đủ vào phép đo.

Tính đúng không bảo đảm tính nhanh: CPU fallback có thể giữ nội dung đúng nhưng nếu làm R01 không đạt ngân sách, **G2 chưa đạt**. Không chuyển PDFium/PPE hoặc View/Proof khi thấy wheel nhanh/chậm.

## 4. Ranh giới mã nguồn dự kiến

Các đường dẫn “mới” dưới đây là đề xuất, chưa được tạo trong lượt lập kế hoạch.

| Khối | Vị trí | Công việc |
|---|---|---|
| Scene/compiler | Mới: `print_engine/src/scene/` | IR, state, resource invocation, bounds, compile và invalidation |
| Render graph | Mới: `print_engine/src/render_graph/` | clip/mask/group/backdrop/color stage, dependency, capability |
| CPU replay | Mới: `print_engine/src/cpu_scene/` | thực thi graph bằng các kernel PPE hiện có; đối chiếu interpreter cũ |
| GPU backend | Crate mới: `viewer_gpu/` | device, shaders, image/glyph/ink resources, fences, color resolve; không đọc PDF |
| Runtime | Crate mới: `viewer_runtime/` | camera, layout nhiều trang, scheduler, tile coverage/cache, overlay/presenter contract |
| Tauri adapter | Mới: `desktop/src-tauri/src/viewer_native/` | HWND, input, DPI, popup/editor, lifecycle; `lib.rs` chỉ đăng ký/ghép adapter |
| Worker adapter | `desktop/src-tauri/src/pdf_engine/render_worker/` và điểm nối ở `render_worker.rs` | scene/resource protocol, CPU fallback, document ownership; không nhét toàn bộ engine vào file lớn |
| React adapter | Mới: `desktop/src/components/workspace/NativeViewerHost.tsx`, `desktop/src/lib/nativeViewerBridge.ts` | rectangle, state/event bridge, registry theo tab/view |
| Nơi chuyển consumer | `AcrobatViewer.tsx`, `LivePageFrame.tsx`, hooks viewer, `ThumbSidebar.tsx` | chuyển dần theo feature flag; chưa xóa path cũ trước G4 |
| Harness | Mới: `viewer_runtime/examples/`, `scripts/viewer_gpu/`, `tests/viewer_gpu/` | fixture manifest, replay, native integration, so ảnh/metric và tổng hợp log |

Compiler và CPU replay dùng chung cấu trúc semantics; GPU không diễn giải lại PDF. `viewer_runtime` không phụ thuộc React/Tauri. Tauri adapter không sở hữu shader hoặc luật màu. Không tách file chỉ để đạt số dòng; ranh giới dựa trên trách nhiệm và hợp đồng test.

## 5. Lộ trình G0–G4 và gói công việc

Đường bắt buộc: **G0 → G1 → G2 → G3 → G4**. Sau khi hợp đồng G0 khóa, harness/UI adapter có thể được phát triển độc lập với shader, nhưng chưa tích hợp vào Viewer mặc định. “Song song” ở đây là cách tổ chức nguồn lực nếu có, không phải đề xuất bỏ qua cổng nghiệm thu.

### G0 — Khóa nền tảng và bài nghiệm thu

| Mã | Công việc cụ thể | Đầu ra/kiểm chứng |
|---|---|---|
| G0.1 | Chụp baseline source/binary/PDF/profile; kiểm GPU/driver/monitor; kiểm giấy phép và MSRV dependency | `baseline-manifest.json`, `hardware.json`; build CPU/GPU capability được phân biệt |
| G0.2 | Chốt schema ở §3, tọa độ, alpha/ink và invalidation; inventory đủ consumer | Đặc tả version 1, bảng feature→owner→test; không còn React overlay “chưa biết xử lý” |
| G0.3 | Tạo embedding harness cùng phiên bản Tauri/wry/WebView2; surface đơn giản, native camera/input và popup/editor | Resize, 100/125/150/200% DPI, đổi màn hình, minimize/restore, modal, context menu, IME tiếng Việt, 2 cửa sổ; ảnh/video và trace |
| G0.4 | Thử process protocol/resource upload/CPU surface lifetime; kiểm đóng worker, hủy view, lost surface/device | Không dùng tài nguyên đã nhả; GPU path không readback toàn frame; ghi đúng số byte copy |
| G0.5 | Tạo replay và logger ngoài đường frame; đo bật/tắt logging; chuẩn hóa capture/present/cold-warm | Runner một lệnh, artifact đọc được ở §7; fixture sai hash hoặc thiếu evidence phải báo lỗi |
| G0.6 | Khóa test matrix và ngưỡng hình ảnh/hiệu năng; xác nhận feature phát sinh từ R01 | `acceptance-v1.json`, danh mục graph feature của R01, biên bản go/no-go |

**G0 đạt khi:** embedding thực tế vượt bài kiểm, process/device ownership rõ, runner lặp được, toàn bộ chỉ tiêu bắt buộc có cách đo. Lỗi airspace/DPI/input chưa giải quyết là điều kiện dừng trước G1, không để đến sát phát hành. Nếu cần đổi cơ chế hosting phải ghi một quyết định sửa thiết kế và thử lại cùng bài kiểm; không chuyển hướng ngầm.

### G1 — Scene dùng lại và CPU replay đúng

| Mã | Công việc cụ thể | Đầu ra/kiểm chứng |
|---|---|---|
| G1.1 | Scene IR primitive + state + resource ID; compile trang active từ `PageProgram`; giữ lazy loading | Scene bất biến theo revision, không compile toàn tài liệu để xem trang 1 |
| G1.2 | Path/glyph/image/shading; Form/Pattern/Type3 theo invocation/resource scope | Cùng resource nhưng CTM/state khác không bị dùng nhầm; text outline/live/Type3 qua corpus |
| G1.3 | Graph clip/SMask/group/isolation/knockout/overprint/OCG; conservative bounds | Culling bật/tắt và tile/full-region cùng nội dung; backdrop không bị cắt mất |
| G1.4 | CPU replay graph bằng kernel hiện có, instrument phase; giữ interpreter làm đối chiếu chuyển đổi | Regression hiện có + golden được duyệt; khác biệt với interpreter phải phân loại đúng/sai theo spec |
| G1.5 | Invalidation edit/profile/OCG/annotation; index hit-test/text semantics | Đổi zoom không compile lại scene; đổi nội dung không nhận resource/ảnh cũ; sửa bộ nhớ và undo/redo đúng |

**G1 đạt khi:** corpus bắt buộc đúng, R01 đúng, compile count bằng 0 cho camera-only trên cùng scene đã warm. Ghi cold compile time/RSS và invalidation thực tế. Chỉ G1 đạt chưa đủ hứa zoom nhanh: raster có thể còn chậm.

Test tái sử dụng: `render_page_boxes`, `render_form_cache`, `render_text`, `render_type3`, `render_tiling_pattern`, `render_image`, `render_inline_image`, `render_shading`, `render_mesh_shading`, `render_transparency`, `render_smask_cache`, `render_icc`, `render_oc`, `render_annotation`, `render_cancel`, `render_session` trong `print_engine/tests/`. Thêm test phân biệt lỗi mới của scene/graph; không viết lại hàng loạt test trùng implementation.

### G2 — GPU tạo pixel đúng và giảm được chi phí của R01

| Mã | Công việc cụ thể | Đầu ra/kiểm chứng |
|---|---|---|
| G2.1 | Device/resource pool, path raster, clipping, glyph coverage và AA | Glyph/path tại zoom phân số, hairline, rotation/DPR; không chỉ scale glyph bitmap độ phân giải thấp |
| G2.2 | Decode resource một lần, upload/mipmap/sampler, image/color input | Image mask, CMYK/YCCK, decode arrays/interpolate theo corpus; đo upload lạnh/nóng riêng |
| G2.3 | SMask alpha/luminosity, transfer function, nested groups, backdrop và blend stages của R01 | Các vùng tốn thời gian trong R01 được tạo mask/composite trên GPU; so CPU/spec/golden |
| G2.4 | Hợp đồng ink/alpha/shape; overprint/knockout/blend space; ICC/output resolve | View/Proof và spot/DeviceN đúng; format/precision chọn bằng sai số đo được, không chỉ tiết kiệm VRAM |
| G2.5 | Capability planner + CPU fallback đúng ranh giới; cache fallback theo dependency | Log unit/lý do/diện tích/chi phí fallback; synthetic test non-isolated không bị dán sai backdrop |
| G2.6 | Benchmark graph R01 + corpus; partition nội dung lớn; device loss/OOM; tài nguyên theo phần cứng | Báo cáo per-stage CPU/GPU/upload/resolve/present; p50/p95/p99, peak RAM/VRAM, cache/fallback tỷ lệ |

**G2 đạt khi:** R01 qua đúng hình/màu và ngân sách tạo ảnh mới trong §6; xử lý thực sự nhánh image/mask/group nặng, không chỉ làm demo path nhanh. Fallback tính đầy đủ vào thời gian. Không kết luận GPU tốt từ GPU timestamp khi CPU queue hoặc color resolve vẫn làm end-to-end vượt ngưỡng.

Loại primitive hiếm chưa có GPU được đưa vào capability matrix cụ thể; CPU tương thích được phép nhưng không được rơi nội dung hoặc nhận nhãn tăng tốc đã đạt. Muốn bỏ một loại khỏi phạm vi sản phẩm phải sửa phạm vi trước, không đánh dấu “unsupported” để làm xanh corpus.

### G3 — Viewer tương tác hoàn chỉnh

| Mã | Công việc cụ thể | Đầu ra/kiểm chứng |
|---|---|---|
| G3.1 | Camera native, anchor zoom, page layout/scroll và target coalescing | Wheel/trackpad/keyboard/pan/fit, đảo chiều nhanh và nhiều trang; React nhận snapshot, không quyết định từng frame |
| G3.2 | Scheduler theo vùng nhìn và dependency; cache nhiều mức; giữ công việc còn hữu ích | Không starvation khi wheel liên tục, thumbnail không chặn vùng active; hủy không reset cả pipeline |
| G3.3 | Coverage compositor, gutter/clip, atomic revision, đổi surface không blank | Seam và khung trắng bằng 0 tại biên tile, DPR, zoom phân số, xoay và cạnh trang |
| G3.4 | Hit-test/text selection, crop/object handles/annotation/guide/measurement và lớp phủ công cụ | Overlay cùng transform với PDF; select/copy/search/drag/edit không lệch sau zoom/pan/DPI |
| G3.5 | Popup/editor/IME, accessibility, clipboard/drop, tab/multiwindow ownership | Bài G0 được chạy lại với tính năng thật; tab nền không nhận input/global event |
| G3.6 | Replay dài, tải panel React đồng thời, cold/warm/first-visit, memory pressure | Đạt chỉ tiêu trình bày và làm nét khi đang wheel; trace/capture đối chiếu frame thật |

**G3 đạt khi:** build thử nghiệm độc lập dùng được đầy đủ luồng Viewer đã rà, không chỉ một cửa sổ benchmark. Người dùng nhận một bản hoàn chỉnh để so trải nghiệm; không cần chạy lại từng lô shader hay timer.

### G4 — Tích hợp, nghiệm thu và chuyển mặc định

| Mã | Công việc cụ thể | Đầu ra/kiểm chứng |
|---|---|---|
| G4.1 | Adapter native sau feature flag; chọn toàn Viewer theo session; snapshot camera/tool state khi chuyển | Không trộn frame từ Viewer cũ/mới; rollback không ảnh hưởng tài liệu/undo |
| G4.2 | Chuyển đủ consumer trong §8, thumbnail shared scene nhưng ưu tiên riêng | Native view đúng page instance/revision; thumbnail/edit preview/OCG không lệch nội dung |
| G4.3 | Bộ regression đầy đủ, ma trận phần cứng, Windows runtime, build đóng gói | Không chỉ dev binary; manifest source/dependency/shader/binary khớp |
| G4.4 | So R01 và corpus với baseline/Acrobat, đánh giá người dùng ở bản ứng viên | Báo cáo có điều kiện so, ảnh/video, số đo; không nhận “ngang Acrobat” nếu chưa có chứng cứ tương ứng |
| G4.5 | Bật mặc định trên capability đã đạt; rollback vận hành; theo dõi nội bộ trước khi gỡ path cũ | Một chu kỳ ứng viên → bản vá/ổn định không có lỗi chặn; gỡ mã cũ ở đợt riêng sau nghiệm thu |

**G4 đạt khi:** các yêu cầu §6/§8 đều có evidence, người dùng chấp nhận trải nghiệm trên R01 và không còn lỗi nội dung/màu/overlay/cửa sổ chặn phát hành. Máy hoặc capability chưa đạt dùng chế độ PPE CPU tương thích được ghi rõ; không lấy nó làm bằng chứng đạt mục tiêu GPU.

## 6. Tiêu chí nghiệm thu và cách tính

Các con số dưới là **mục tiêu đề xuất**, chưa phải kết quả. Khóa bằng `acceptance-v1.json` tại G0 trên cấu hình được ghi nhận. Muốn đổi ngưỡng phải có quyết định thay yêu cầu trước khi chạy lại; không sửa sau đo chỉ để đạt.

### 6.1. Trải nghiệm, độ nét và độ trễ

| Mã | Chỉ tiêu | Mục tiêu/định nghĩa |
|---|---|---|
| P01 | Compositor khi tài nguyên đã resident | p95 frame work ≤16,7 ms ở 60 Hz; ghi frame pacing/dropped present riêng |
| P02 | Phản hồi camera | Input native → present p95 ≤33 ms, tài nguyên resident; không đồng nghĩa ảnh mới đã nét |
| P03 | Ảnh mới ở scale/vùng chưa cache, scene/resource warm | p95 target accepted → present ảnh đạt chuẩn vùng nhìn ≤100 ms; đo zoom bước và pan vào vùng mới, không chỉ revisit |
| P04 | Ảnh cuối sau dừng zoom | p95 last input → present đạt chuẩn vùng nhìn ≤150 ms; chỉ tính khi frame hiện tại chưa đạt, không bỏ các lượt timeout |
| P05 | Làm nét khi thao tác liên tục | Với trace zoom liên tục chuẩn: sau giai đoạn vào gesture 100 ms, không có khoảng >150 ms mà vùng đang thiếu chất lượng không được cập nhật pixel hữu ích; cache hit đã đủ chuẩn không cần raster thêm |
| P06 | Chất lượng trong gesture | Đề xuất ≥95% diện tích trang đang nhìn có density ≥0,8 trong ≥95% mẫu thời gian; vector/text cuối gesture density ≥0,98 và qua kiểm ảnh. Cố định tốc độ wheel/zoom/DPR để phép đo có nghĩa |
| P07 | Tính liên tục/đúng owner | 0 blank frame do pipeline sau ảnh đầu, 0 seam/khung trắng, 0 commit sai document/revision/profile, 0 đổi engine/màu theo wheel |
| P08 | Cold open/page jump | Báo riêng process-cold, document-cold, first-page, first-use shader/upload. Với cùng fixture/build class: không chậm hơn baseline đối chứng quá 10%; không chờ compile cả tài liệu |
| P09 | Chi phí log | Logging nhẹ bật/tắt lệch trung vị và p95 ≤3% hoặc trong nhiễu đã đo; trace chứng minh bắt buộc không mất event. Capture nặng chạy riêng, không nhập vào benchmark thuần |

“Đạt chuẩn vùng nhìn”: đúng geometry/color/revision, phủ toàn bộ phần trang nhìn thấy, mật độ phù hợp vật liệu và qua ngưỡng ảnh. Bitmap nguồn thấp không thể có thêm chi tiết; kiểm sampler/aliasing so tham chiếu, không đòi tạo chi tiết giả. Không dùng density một mình để công bố ảnh nét.

Đo cả request thành công, hủy, superseded, timeout và gesture chưa đạt; không bỏ request chậm để làm đẹp p95. Báo p50/p95/p99 và max theo từng ca/từng máy; p99 ở tập nhỏ chỉ mang tính mô tả. Ít nhất 100 target cho mỗi ca warm, 30 lượt mở document-cold, 10 lượt process-cold; lặp nhiều block theo thứ tự ABBA hoặc hoán đổi có seed, báo khoảng dao động. Kiểm soát nhiệt/nguồn điện/window size/background workload; không so debug mới với release cũ.

### 6.2. Đúng hình và màu

- Corpus bao gồm live/outline text, chữ Việt/CJK, Type3, scan, gradient/mesh, image/SMask, nested transparency, isolation/knockout, overprint CMYK/spot/DeviceN, ICC, OCG, annotation và page geometry bất thường.
- Synthetic fixtures có expected semantics theo PDF và những mẫu approved golden. So CPU/GPU với cùng transform và profile; interpreter PPE cũ không phải nguồn chân lý duy nhất.
- Đề xuất với patch màu phẳng sau cùng display transform: ΔE00 p95 ≤1, max ≤2; không áp ngưỡng màu này lên mép AA. Các phép toán ink/alpha có tolerance riêng theo precision, được ghi bằng số ở G0.
- Glyph/path dùng edge displacement, coverage/stroke preservation và vùng sai ngoài biên; đề xuất sai vị trí biên ≤1 physical pixel, không mất nét mảnh/glyph/đối tượng. SSIM toàn trang không được che lỗi một chữ hoặc overprint sai.
- Không cho phép sai channel spot, paint order, visibility, backdrop hay annotation chỉ vì trung bình màu toàn trang vẫn tốt. Test semantics là hard gate độc lập với dung sai ảnh.
- Chốt profile/intent/overprint/page box/rotation/DPR/zoom và font substitution cho ảnh Acrobat. Khác biệt chưa phân loại thì chưa đủ căn cứ kết luận PPE đúng hoặc Acrobat sai. Không cập nhật golden hàng loạt để test xanh.

### 6.3. Tài nguyên và phần cứng

- Máy tham chiếu R01 phải được bổ sung adapter/driver/VRAM. Ma trận tối thiểu gồm máy này, iGPU phổ biến, dGPU và CPU compatibility; có máy RAM <8, 8–<16, ≥16 GiB. Nếu thiếu máy thật, ghi “chưa nghiệm thu”; env giả lập không chứng minh hiệu năng iGPU.
- ≥16 GiB không áp cap worker/chất lượng vô điều kiện. Điều chỉnh trên máy yếu theo quy tắc repo. Giới hạn texture/format/VRAM thực là capability: partition, thu hồi cache và xử lý allocation failure; không bỏ đối tượng hay giảm màu.
- Cache theo revision/resource/scale/profile, có accounting và thu hồi inactive; không cam kết cache vô hạn trên máy mạnh. Báo peak và steady-state RSS/VRAM, thời gian evict/reupload.
- Test 100 vòng mở/zoom/đóng tài liệu, nhiều tab/cửa sổ, 30 phút replay; kiểm live resource/handle về mức sau warmup, không tăng tuyến tính. RSS/VRAM allocator có thể giữ high-water mark; không dùng mỗi RSS để kết luận leak.
- Device loss, adapter reset, suspend/resume, resize surface và OOM phải có kết quả xác định; chỉ fault-inject vào harness/process do bài test sở hữu. Không cố tình reset driver của phiên người dùng để chạy test.

## 7. Bộ đo và log tự động

Tạo output cố định mà agent và người phát triển đều đọc được:

```text
D:\pdfcompare\.tmp\viewer-gpu\runs\<run-id>\
    manifest.json          source/binary/shader/PDF/profile/fixture hashes
    hardware.json          OS, CPU/RAM, GPU/driver, display/DPR, power/build mode
    acceptance.json        bản tiêu chí sử dụng cho lượt đo
    events.jsonl           input → target → compile/queue/raster/upload/resolve/present
    frames.jsonl           frame ID, owner/revision/camera, coverage/density/quality age
    resources.jsonl        CPU/GPU allocation, eviction, fallback và lifetime
    summary.json           số đo, lỗi, số event thiếu, verdict từng tiêu chí
    report.html            biểu đồ timeline + bảng đối chiếu trước/sau
    captures\             ảnh/diff/ROI, chỉ có ở lượt kiểm hình/capture
```

Tên runner dự kiến: `scripts/viewer_gpu/run_acceptance.ps1`; API dự kiến nhận fixture manifest, binary, acceptance version, seed và output. **Chưa có lệnh này ở thời điểm lập kế hoạch.** Tái sử dụng ý tưởng/provenance từ `scripts/ppe_viewer_baseline.py`, probe `print_engine/examples/perf_profile.rs` và `scripts/ppe_viewer_webview_baseline.mjs`; browser harness chỉ kiểm adapter cũ/React, không được đóng vai native present test.

Yêu cầu instrumentation:

1. Timestamp monotonic và sequence theo process; handshake để đối chiếu clock. Ghi độ bất định khi ghép timeline. Không trừ epoch JS/Rust rồi coi sai số âm là latency thật.
2. ID xuyên suốt document→page→view→target→graph job→surface→frame; ghi pixel producer CPU/GPU, color contract và lý do fallback.
3. Logger ghi bất đồng bộ ngoài frame loop; mọi buffer có accounting/drop counter. Lượt dùng để chứng minh phải đủ event, thiếu thì invalid thay vì bù số giả. Log lỗi tối thiểu không cần ghi PDF hoặc toàn bộ stream.
4. Tách thời điểm CPU submit, GPU completed, present submitted và frame được OS trình bày; correlation/capture dùng cơ chế Windows được G0 xác minh. Không gọi `present()` trả về là bằng chứng scanout hay input-to-photon; nếu thiếu mốc OS phải ghi đúng giới hạn và chưa đạt gate tương ứng.
5. Lượt benchmark timing nhẹ tách lượt frame capture đầy đủ. Đồng bộ frame ID giữa capture và trace, kiểm có che khuất bởi menu/cửa sổ. Screenshot canvas/headless không thay desktop runtime.
6. Tự replay zoom vào, đảo chiều, pan, zoom phân số, vùng mới, đổi trang, resize/DPI/tab; có seed và tọa độ trang cố định. R01 phải bao phủ các vùng hình/chữ/mask đã gây chậm, gồm các clip baseline 104/848/2072 DPI trong `.tmp/render-r25-07/page1-profile.json`.
7. Artifact nặng/PDF khách giữ cục bộ, không đưa vào git. Báo cáo milestone gọn và manifest không chứa dữ liệu PDF ghi trong `docs/`; export bằng chứng trước khi dọn `.tmp` để không mất baseline.

## 8. Ma trận consumer phải chuyển đủ

| Nhóm | Điểm tích hợp đã thấy | Điều kiện không được mất |
|---|---|---|
| Page layout/zoom/pan | `AcrobatViewer.tsx`, `useViewerZoom.ts`, `LivePageFrame.tsx` | Một/nhiều trang, page order/rotation/box, fit và anchor; nhiều trang trên một native view |
| Thumbnail | `ThumbSidebar.tsx`, `useThumbSidebar.ts`, hooks render | Nội dung/revision/profile đúng, đổi trang đúng; nền không tranh ưu tiên viewport |
| Selection/comment | `LivePageFrame.tsx`, `TextSelectionToolbar.tsx`, `AcrobatCommentCard.tsx`, text markup store | Select/copy/highlight/comment, toolbar/card, text hit-test và lưu/undo đúng |
| Edit/crop | `LivePageFrame.tsx`, edit session/transform, `useCropPointerDrawing` | Ghost/handles, apply trong bộ nhớ, commit/undo/redo, không hiện lại đối tượng đã xóa |
| Chế bản/VDP | `OutputPreviewPageBoxLayer`, `VdpPreviewImage`, callback VDP và page overlay renderer | Proof/ink sampling/OCG, box/barcode/text picker, record preview, page instance mapping |
| Guide/đo | `GuideLayer.tsx`, `DimensionLayer.tsx`, `Ruler.tsx` | Đơn vị mm/pt, snapping, vị trí sau DPR/rotation/zoom |
| Menu/modal/phím | `ViewerContextMenu.tsx`, toolbars, hotkey hook, editor | Z-order, focus/IME, clipboard, shortcut không chạy vào tab nền |
| Tab/window/file | `App.tsx`, `document_window_registry.rs`, SystemIntegrations | Active owner, native drop/picker, file live-link, nhiều cửa sổ, cleanup khi đóng |
| Consumer khác | `DualPDFViewer.tsx`, `DualPDFViewerInner.tsx`, các nơi truyền `pageOverlayRenderer` | Inventory tại G0 quyết định adapter nào dùng native; thuật toán Compare giữ nguyên |

G0 phải tìm tất cả nơi gọi/nhúng Viewer và cấp ID ca test; bảng này là điểm bắt đầu đã đối chiếu source, không tuyên bố đã rà hết mọi consumer. Chỉ chuyển consumer sau khi có kết quả so với hành vi hiện tại, kể cả các phần đang được phát triển ở nhánh khác.

## 9. Cách triển khai và rollback

- Sau khi kế hoạch được duyệt, tạo checkout/worktree riêng từ **baseline chứa các bản sửa đã chấp nhận**. Vì working tree hiện có nhiều sửa chưa commit của các tính năng khác, phải lập manifest và bảo toàn chúng; worktree từ HEAD đơn thuần chưa chắc chứa baseline đang chạy.
- Native Viewer mới mặc định tắt đến G4. Không HMR bản thử vào PrynX người dùng đang làm việc. Harness và build thử nghiệm có output/profile riêng, không chiếm thư mục/cache/session đang dùng.
- Mỗi lô review tối đa 5 file tính cả source/test/docs/lockfile. Gói công việc ở §5 có thể gồm nhiều lô; không ép cả milestone vào một lô. Contract hai đầu phải đi cùng nhau hoặc có adapter version để trạng thái giữa lô vẫn build được.
- Hết lô: test hẹp đúng hành vi. Hết gói/mốc: regression và runtime harness tương ứng. Ghi tag `PERF (audit 2026-09-25 §Gx.y)`/`RENDER` và bằng chứng vào sổ tiến độ; không đoán pass từ việc compile thành công.
- Áp dụng bước xác nhận runtime trong quy trình repo cho **build thử nghiệm riêng**. Các kiểm chứng lặp do harness thực hiện; xác nhận trải nghiệm người dùng gom vào bản ứng viên hoàn chỉnh. Không lấy sự im lặng của người dùng làm xác nhận một gate.
- Một session chọn toàn bộ Viewer cũ hoặc mới. CPU/GPU trong renderer mới chỉ khác backend graph, cùng PPE semantics. Lỗi nội dung/màu, crash, blank hoặc regression máy mạnh chặn cutover; dừng rollout để sửa đúng lô.
- Rollback: hủy job owner mới, nhả surface/input, mở adapter cũ từ camera/document/tool snapshot. Giữ edit session và undo; nếu đường chuyển chưa bảo toàn được trạng thái, rollback ở lần mở phiên kế tiếp thay vì đóng tài liệu chưa lưu.
- Device loss thử tái tạo từ scene theo policy; nếu không phục hồi, chuyển PPE CPU cùng contract và ghi degraded mode. Không retry vô hạn, không đảo engine mỗi frame.
- Không xóa renderer cũ ngay khi bật cờ mới. Việc gỡ path cũ là đợt riêng sau nghiệm thu và một chu kỳ phát hành ổn định; không kéo thay đổi backend nghiệp vụ vào đợt này.

## 10. Ước lượng nguồn lực và thứ tự ưu tiên

Ước lượng sơ bộ theo phạm vi trên, **không phải cam kết lịch hoặc kết quả đã kiểm chứng**. Đơn vị tuần công của kỹ sư có kinh nghiệm liên quan; AI hỗ trợ không loại bỏ thời gian kiểm GPU/màu/Windows. Cập nhật sau G0 bằng feature inventory thực, không tự thu hẹp nghiệm thu để giữ lịch.

| Mốc | Tuần công dự kiến | Rủi ro chi phối |
|---|---:|---|
| G0 | 2–3 | Hosting, process/device boundary, đo present |
| G1 | 4–6 | Tách interpreter/state và dependency đúng PDF |
| G2 | 8–14 | Coverage/SMask/transparency/ICC/DeviceN trên GPU |
| G3 | 5–8 | Overlay/editor/IME/multiwindow và scheduler thực |
| G4 | 3–5 | Consumer migration, phần cứng, đóng gói và regression |
| Tổng trước dự phòng | **22–36** | Không cộng thêm “tối ưu GPU cuối dự án” vì đã nằm ở G2 |

Dự phòng kế hoạch khoảng 25%: **28–45 tuần công**. Một người làm tuần tự tương đương khoảng 7–11 tháng làm việc; hai kỹ sư bổ trợ graphics/PDF và Windows/UI cùng QA có thể lập ngân sách lịch sơ bộ khoảng 4–7 tháng, phụ thuộc các gate. Không chia tuyến tính số tuần cho số người vì G1/G2 là đường phụ thuộc chính. Đây là quy mô của đích đầy đủ, không phải thời gian tới demo GPU đầu tiên.

Vai trò cần có: người chịu trách nhiệm semantics/màu PPE; người GPU/Windows; người kiểm nghiệm corpus/benchmark. Có thể một người kiêm nhiều vai trò nhưng vẫn cần review độc lập ở phần màu/graph quan trọng. Kế hoạch này không tự tạo nhóm hoặc giao task bên ngoài.

Ưu tiên đầu tư: G0 chặn sớm hướng tích hợp không đạt; G1/G2 chứng minh đúng và nhanh trên R01; G3 hoàn thiện tương tác; G4 chuyển sản phẩm. Không ưu tiên dashboard số FPS hoặc giao diện mới trước image/mask/group của R01.

## 11. Rủi ro, điều kiện dừng và quyết định tương ứng

| Rủi ro | Phát hiện tại | Hành động khi không đạt |
|---|---|---|
| Child viewport bị menu/modal che sai hoặc focus/DPI sai | G0.3 | Chốt lại hosting/owned popup và chạy lại cùng ma trận; không tiến hành migration dựa trên demo cửa sổ rời |
| Scene vẫn phụ thuộc zoom hoặc state tài nguyên không đủ | G1 | Sửa IR/invocation contract trước shader; không cache kết quả sai để giảm compile count |
| R01 vẫn nằm trên CPU mask/group | G2.3/G2.6 | Hoàn thiện GPU dependency tương ứng; mốc chưa đạt, không công bố đã giải quyết độ trễ |
| GPU nhanh nhưng màu sai | G2.4 | Sửa blend/ink/precision/resolve; fallback đúng và ghi ảnh hưởng ngân sách, không giảm yêu cầu màu |
| Quá nhiều fallback hoặc VRAM tăng mạnh | G2.5/G2.6 | Phân tích graph unit, working set, partition; không hard-cap chất lượng máy mạnh |
| Capture/logger tự gây chậm | G0.5 và mọi benchmark | Tách lượt capture/timing, sửa log path; phép đo thiếu mốc phải invalid |
| Chỉ đẹp ở zoom warm đã cache | G2/G3 | First-visit, pan vùng mới và wheel dài là ca bắt buộc; không dùng revisit để đại diện |
| UI adapter mất chức năng đang có | G3/G4 | Chặn consumer cutover, giữ path cũ theo session; bổ sung parity test |
| Build thử khác binary người dùng chạy | Mọi gate | Kiểm hash/marker/provenance trước đọc timing; sai binary không được nghiệm thu |

Không có cổng nào cho phép thay bằng “cảm giác có vẻ nhanh hơn”. Một gate không đạt sinh báo cáo nguyên nhân và phương án có phạm vi; thay đổi đích kiến trúc/phạm vi lớn phải cập nhật kế hoạch trước khi làm tiếp. Đây là kiểm chứng thiết kế có tiêu chí, không phải phát bản vá thử liên tục vào ứng dụng đang dùng.

## 12. Lô đầu tiên khi bắt đầu triển khai

**G0.1a — Chốt fixture và bằng chứng, chưa thay renderer mặc định.** Tối đa 5 file dự kiến:

1. `tests/viewer_gpu/fixtures.json`: R01 hash/page/clip/trace identity, không chứa PDF khách.
2. `scripts/viewer_gpu/capture_baseline.ps1`: inventory/build/PDF checks và gom artifact hiện có; không tự đóng PrynX.
3. `scripts/viewer_gpu/summarize_baseline.py`: chuyển metric/provenance thành báo cáo có giới hạn phép đo.
4. `tests/viewer_gpu/test_baseline_manifest.py`: kiểm sai hash, thiếu binary provenance và thiếu mốc không được báo pass.
5. `docs/PPE_VIEWER_GPU_TIENDO_2026-09-25.md`: sổ tiến độ, trạng thái gate và đường dẫn bằng chứng.

Nghiệm thu lô này: đọc được toàn bộ baseline R01 từ một run folder, phân biệt timing quan sát được với metric chưa có; fixture sai bị từ chối; không thay file ứng dụng hoặc dữ liệu PDF. Lô tiếp theo G0.1b dựng GPU capability probe và pin dependency; sau đó G0.2/G0.3 theo hợp đồng. Không bắt đầu bằng tăng cache, worker hay sửa debounce nữa.

## 13. Trạng thái bàn giao kế hoạch

- [x] Có cơ sở runtime và định danh R01.
- [x] Có kiến trúc đích, ranh giới process/module và hợp đồng cần khóa.
- [x] Có gói công việc, cổng nghiệm thu, corpus/replay/log, migration và rollback.
- [ ] G0 được triển khai và nghiệm thu.
- [ ] G1 được triển khai và nghiệm thu.
- [ ] G2 được triển khai và nghiệm thu.
- [ ] G3 được triển khai và nghiệm thu.
- [ ] G4 được triển khai và nghiệm thu.

Lượt này chỉ lập kế hoạch và liên kết tài liệu; không có thay đổi ứng dụng, build GPU hoặc kết quả benchmark mới. Chỉ được kết luận mức độ gần Acrobat sau khi bản ứng viên có phép so cùng điều kiện. Kiến trúc là phương án để đạt mục tiêu, không phải bằng chứng đã đạt.
