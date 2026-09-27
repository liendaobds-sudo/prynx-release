# Sửa review PPE Viewer GPU — 25/09/2026

Người dùng đã duyệt xử lý toàn bộ 13 finding. **Đợt sửa này chưa hoàn tất toàn bộ
renderer G0–G4.** Các lỗi cụ thể và cơ chế từ chối kết quả sai đã được sửa/kiểm
bên dưới. Không coi Unsupported, microbenchmark xanh hoặc sửa tài liệu là đã
triển khai những thành phần còn thiếu.

## Trạng thái từng finding

| Finding | Đã làm | Còn thiếu trước khi đóng |
|---|---|---|
| R25.GPU.01 | Giữ cờ mặc định tắt, không cho prototype xám thành Viewer mặc định | Đường PDF/resource → retained scene → graph executor → native present và consumer thật vẫn chưa nối |
| R25.GPU.02 | Tj giữ byte chữ/font/cỡ/ma trận; q/Q không thành group; Do/gs/sh/TJ chưa phân giải thì trả Unsupported, không sinh image 1×1 giả | Resource/font/glyph/Form compiler đầy đủ; không gọi metadata Tj là text rendering hoàn chỉnh |
| R25.GPU.03 | Clip có hình học thật, áp sau paint/end-path và restore đúng; replay không bỏ nội dung rồi thành công; graph có clip push/pop, group blend sau children/backdrop, kiểm revision/state | Replay resource/group và fallback theo dependency đầy đủ |
| R25.GPU.04 | Path/image composite dùng coverage draw riêng rồi cộng CMYK; K không còn làm alpha. Alpha mask yêu cầu plane riêng/RGBA, không đọc K | Alpha/shape của transparency group và spot surface đầy đủ |
| R25.GPU.05 | Group đọc trực tiếp scalar coverage từ mask pass | Regression GPU đạt; cần corpus PDF/runtime để nghiệm thu renderer |
| R25.GPU.06 | RGB pixel alpha nhân object opacity; composite giữ đúng nền màu ở alpha 0/0,5/1 | Regression GPU đạt; cần nối resource ảnh thật vào graph |
| R25.GPU.07 | Scene RGB/ICC/spot chưa resolve không bị thay đen/xấp xỉ; proof node yêu cầu CPU/color contract; mask CMYK chưa resolve bị từ chối; sửa encode sRGB hai lần trên surface sRGB; blend mode lạ không thành Normal | GPU ICC/spot/overprint và fallback thực từ graph còn thiếu. Shader swatch vẫn chỉ là chẩn đoán, không dùng làm proof |
| R25.GPU.08 | HWND dispatch UI thread/ACK; configure surface trước acquire; dọn surface trước HWND; trả lỗi resize/destroy; kiểm thread và GPU dimensions | Chưa chạy lifecycle/embedding trên Tauri/WebView2 thật |
| R25.GPU.09 | Registry theo window/view/generation; tombstone chống open sau close; cleanup muộn không đóng generation mới; cleanup theo parent | Chưa đo multiwindow native thật |
| R25.GPU.10 | Runner fail khi thiếu runtime evidence; sửa nhãn synthetic/model/swatch/pool; không skip GPU rồi pass; bỏ claim G0–G4 hoàn thành; modal spike kiểm trạng thái thật thay vì hằng true | Native collector/replay, golden Acrobat và soak thực chưa có. Gate trả UNOBSERVED/FAILED khi thiếu là kết quả đúng |
| R25.GPU.11 | TS khớp Rust và validate runtime; cùng fixture JSON được Rust serialize đối chiếu và hook test tiêu thụ | Contract tự động đạt |
| R25.GPU.12 | Geometry CSS → physical ở một biên; DPR trong bounds; native mouse physical → DIP; DPR initial theo WebView | Cần kiểm chuyển monitor/150%/200% và input thật |
| R25.GPU.13 | Một open pending/lease, close-before-open và close-after-late-open; callback thay không reopen; StrictMode và tắt view đúng lifecycle | 7 test hook đạt; cần kiểm cùng native host thật |

## Các thay đổi và kiểm chứng theo lô

1. Mask scalar và alpha RGB: hai probe độc lập chuyển đỏ → xanh. Mask 50%
   cho `[127,255,255,255]` (dung sai ±2), ảnh alpha 0 cho trắng.
2. Native/React: owner/thread/geometry/schema/async lifetime. `cargo check --lib`
   và typecheck đạt; 7 test hook gồm DOM mount, pending open, unmount, StrictMode,
   hai owner, đổi DPR, payload sai và disable sau open.
3. Compositing path: hai draw cho mỗi primitive, không suy alpha từ K. Kiểm 9 tổ
   hợp K/opacity trên Magenta và Cyan đặc phủ Magenta. Đây là sửa tính đúng;
   chưa dùng chi phí microbenchmark để suy hiệu năng PDF.
4. Compiler/replay: clip 20×20 trở lại đúng 400 pixel so với PPE; thêm kiểm
   restore clip, unsupported resource/color, không bỏ text, bounds stroke.
   Sửa `v` áp CTM hai lần và current point sau closepath. Test Form cũ chỉ kiểm
   image giả đã thay bằng assertion từ chối khi không có resource; không hạ
   expected pixel để test xanh.
5. Acceptance: validator kiểm hash R01/trang/profile/binary/source/artifact,
   mẫu số đo P01–P09, native checks, đối chiếu màu và soak 30 phút. Thiếu hoặc
   NaN/Infinity/sai loại/bỏ kiểm => không pass. Không tự sinh evidence runtime.
6. Ảnh trên nền màu: API composite riêng, giữ backdrop ở alpha 0 và trộn đúng
   tại 0,5/1. Alpha của CMYK phải đi plane riêng; không đọc K như alpha.
7. Nhãn bằng chứng: cảnh tổng hợp không còn mang verdict nghiệm thu P01;
   per-stage đổi tên CPU submit; swatch không còn claim Acrobat/ΔE; pool reuse
   không còn claim VRAM/HWND leak; Python protocol được đánh dấu model.
8. Graph: clip không bị cull như ảnh; blend group đặt sau children với dependency
   backdrop; graph revision/state không hợp lệ bị từ chối.
9. Capability/pool: thăm dò format render/blend/filter của adapter thật, từ chối
   extent 0; lease epoch cũ không hồi sinh cache sau clear. Đây chưa phải chứng
   cứ phục hồi device-loss hoàn chỉnh hoặc quản lý VRAM cho mọi kích thước.
10. Surface màu: sRGB target giải mã giá trị display trước store để tránh encode
    hai lần. Test cùng `[64,128,191]` trên Unorm và UnormSrgb đạt.

## Kết quả và artifact

- 5/5 probe lỗi ban đầu đã đạt sau các sửa pixel/clip/text metadata, giữ expected
  semantics; probe nằm trong `.tmp/review-ppe-gpu-2026-09-25/probe/`.
- 29 test scene/graph/CPU replay đạt: `scene-final.log`.
- Test GPU thật trên RTX 3060: `gpu-final.log`; test màu bổ sung:
  `color-surface-fixes.log`. Không dùng kết quả này làm benchmark R01.
- 11 test camera/scheduler/layout/schema qua harness độc lập:
  `native-contract-fixes.log`.
- 7 test hook đạt và TypeScript typecheck đạt.
- 30 test schema/fixture/validator/runner/microbenchmark smoke đạt:
  `acceptance-tests-fixes.log`.
- `cargo check --offline --manifest-path desktop/src-tauri/Cargo.toml --lib`
  đạt: `native-check-final.log` (còn warning sẵn có của shell).
- `cargo test --lib viewport::` ở target ứng dụng bị build-script chặn vì DLL
  đang được app sử dụng (os error 32): `native-unit-fixes.log`. Không đóng app để
  ép test chạy; harness độc lập kiểm phần thuần, không thay cho kiểm HWND/UI.
- `tools/embedding_spike` cargo check đạt; không tự mở spike/window mới.
- Gate chạy trên `runs/latest` trả UNOBSERVED vì thiếu `runtime-evidence.json`.
- Không thay golden, không commit/push, không phát hành, không tuyên bố giảm
  độ trễ R01 hoặc ngang Acrobat.

Các log trong mục trên đều ở `.tmp/review-ppe-gpu-2026-09-25/` trừ khi ghi rõ.

## Cập nhật triển khai engine thật (25/09, lượt tiếp theo)

Đã nối compiler dùng chính interpreter PPE (font/glyph/Type3/Form/local resources,
OCG View, annotation AP, ảnh Decode/Mask/Matte, shading axial/radial, pattern fill,
clip, mask, group) sang retained scene. Binary wire `PPEIR003` giữ tài nguyên dùng
chung; pixel plane không còn đi qua JSON. Stroke giữ hình học và tính lại hairline,
dash/outline theo camera. Tokenizer PPE sửa lỗi `d0/d1` và comment làm mất phần
content phía sau; bộ hồi quy PPE chạy 787 đạt, 8 bỏ qua có khai báo, không lỗi.

GPU dùng N kênh mực với alpha, shape và group-alpha tách riêng; có isolated,
non-isolated, knockout, AIS, OPM1, mask/TR. Ảnh resident có mipmap; gradient giải
tích; LUT ICC 4D từ LCMS/FOGRA39 và spot tint LUT. Đây chưa phải chứng nhận màu
Acrobat. Pattern stroke đã giữ clip hairline/dash theo camera; pattern là group
non-isolated theo ISO 32000 §11.6.7, opacity/blend/mask áp ở biên group. Mesh và
function shading có replay PPE riêng resource rồi upload mực/alpha lên GPU;
Type 1 lấy đủ hai biến x/y, không kế thừa LUT một chiều của CPU cũ.
DeviceRGB group và non-separable đi PPE worker cho toàn bộ dependency closure
của trang, rồi upload sang cùng resident compositor (chi tiết kiểm chứng bên dưới).

Đã nối executable worker riêng → binary pipe → upload → native present thread →
AcrobatViewer. Native chỉ dùng ở chế độ single/hand phù hợp; lỗi trả về Viewer
hiện hành. Cờ mặc định còn tắt cho tới khi kiểm tích hợp và các gate đạt. Camera
và visibility/modal có IPC; hook có 10 test. HWND ẩn tới khi first-present thành
công; lỗi render có event về React. Native build và frontend typecheck đạt ở
các lô trước; lượt build sau resident presenter đang được kiểm lại.

### Số đo thực trên trang 1 R01

Fixture hiện có: `C:\Users\Khanh Pham\Desktop\PDF\CMNM2026 - Giay moi_BLUE - in.pdf`.
SHA256 `95f38cf429fe7dd7c6500043ce308fd2e87e80a2290217d428fe0c68c6098184`.
File `_5e2846.pdf` ở đường dẫn ban đầu không còn hiện diện.

- Worker executable thật: 683,44 ms gồm mở process/đọc PDF/compile/pipe;
  487 lệnh ngoài, 2 ảnh, 8 shading, 8 mask, không warning; packet 98.564.033 byte.
- 120 camera zoom/pan, 1081×811: GPU complete p50 68,946 ms, p95 85,587 ms;
  phần encode CPU p95 40,558 ms.
- 30 camera cùng điều kiện với PPE RenderSession đã warm: CPU raster+ICC
  p50 525,944 ms, p95 569,481 ms. Sai khác RGB trung bình tối đa 1,1457/255.
- Upload/chuẩn bị resident: khoảng 1,43 giây. Chưa đạt P01 16,7 ms; chưa đo
  input-to-present HWND, chưa đối chiếu Acrobat hoặc soak 30 phút.

Artifact: `r01-worker-pipe.json`, `r01-worker-scene.bin`,
`r01-worker-camera-summary.json`, `r01-retained-camera-trace.csv`,
`r01-worker-camera-ab.log`, `ppe-regressions.log`, `native-scene-build.log`
trong `.tmp/review-ppe-gpu-2026-09-25/`. Không dùng số đo synthetic cũ để nghiệm thu.

### Resident presenter (đo sau khi tách camera/refinement)

Encode refinement chạy trên worker riêng. Presenter giữ overview phủ toàn trang
và detail cuối, biến đổi cả hai theo camera mới. Lệnh GPU refinement chia tại
biên primitive, submit từng đoạn với ngân sách điều phối 4 ms rồi cho camera
chen vào. Không giảm số primitive hoặc chất lượng; pool chỉ tái dùng sau ACK
submit/hủy. Không chuyển PDFium/PPE giữa cử chỉ.

Test dùng chính `viewport/refinement.rs` + R01 worker packet + RTX 3060:
120 camera theo nhịp 16,667 ms; 20 refinement hoàn tất trong 2,183 giây. Thời gian
resident compositor p50 0,6735 ms, p95 0,925 ms; camera mô phỏng → GPU ready p50
1,637 ms, p95 4,946 ms, max 9,325 ms. Camera cuối có pixel khớp tuyệt đối với
render đầy đủ. Đây là **headless**, chưa có HWND/VSync hoặc input thiết bị thật;
không đổi trạng thái P01/P02 sang nghiệm thu native.

Artifact: `native-resident-test.log`, `r01-native-resident-trace.csv`,
`r01-native-resident-trace.summary.json`. Test GPU bổ sung giữ vùng lộ ra khi
đảo chiều zoom/pan, pattern hình học chuẩn ở 1×/2×, function x/y, mesh/BBox,
và 72 tổ hợp biên của 12 blend modes (sửa hai góc ColorDodge/ColorBurn).

Tham chiếu ngữ nghĩa pattern: [ISO 32000-1 §11.6.7](https://developer.adobe.com/document-services/docs/assets/35e4369068f86065372c18787171a17e/PDF_ISO_32000-1.pdf).
Phát hiện thêm ở PPE CPU cũ: pattern stroke bỏ CA/dash và Type 1 dùng LUT một
chiều. Hàm stroke chung đã sửa dash/hairline và độ phân giải curve theo CTM;
792 test PPE đạt sau sửa. CA của pattern CPU cũ và Type 1 CPU tổng quát chưa
được sửa trong lô này. Test renderer mới dùng oracle hình học/hàm độc lập.

### PPE dependency fallback và ổn định build

`viewport/document_renderer.rs` chọn engine một lần khi mở scene. Resource GPU
không hỗ trợ (bao gồm RGB/non-separable group) dùng PPE accurate worker hiện hữu,
giữ owner/session, revision cancellation và ColorVerified gate; PNG decode/upload
ở worker refinement, không chặn camera present. Đây là **CPU raster fallback**,
không gắn nhãn GPU raster cho phần công việc này. Cảnh CMYK R01 vẫn đi retained GPU.

Test worker thật `rgb_group_worker_upload_preserves_pan_crop_rotation_and_fractional_scale`
đạt: RGB page group, CropBox khác gốc, Rotate 0/90, UserUnit 2, ba camera có pan âm,
pan dương và scale lẻ. Pixel readback so với PPE toàn trang sai tối đa 1/255;
revision bị thay thế không được render. Artifact: `native-rgb-fallback-test.log`,
`native-rgb-fallback-0.pdf`, `native-rgb-fallback-90.pdf`.

Trong lúc người dùng chạy dev, việc ghi module mới từng làm Tauri rebuild gặp
`uuid` chưa khai báo. Đã bỏ dependency không cần thiết, dùng owner ID theo process
và atomic sequence; đồng thời xóa offset pan âm chuyển `usize` sớm. Người dùng đã
dừng dev để tránh build-script tranh DLL (`os error 32`). Không xóa/đổi dependency
của ứng dụng chỉ để che lỗi linker.

Đã thêm `GPU_INPUT_PRESENT`: tính từ nhận WM wheel/drag tới gọi `present`, chỉ
ghi một mẫu cho input mới. `GPU_SCENE_PRESENT.request_to_present_us` là tuổi của
request, **không** dùng làm input latency. Cả hai đều chưa phải photon/VSync latency.

Hồi quy hiện hành: PPE **792 đạt, 8 ignored** (28 suite); GPU **37 đạt, 1 ignored**
(9 suite); frontend viewport/settings **11 đạt**; TypeScript đạt; pytest validator
**38 đạt**. Artifact tương ứng: `ppe-regressions-complete.log`,
`gpu-regressions-final.log`, `frontend-native-tests-final.log`,
`frontend-typecheck-final.log`, `acceptance-tests-final.log`.
Kiểm toàn bộ i18n catalog riêng còn 2 test thất bại do các khóa cũ thiếu ở annotation,
imposition/Logoworkspace; hai khóa cài đặt GPU mới có đủ VI/EN. Không coi suite này đã xanh.

### Bản cố định gửi kiểm runtime (12:52, 25/09)

Native build đạt (`native-final-build.log`, 2 phút 52 giây); executable SHA256
`d6c2e454a80f05159d51561ff3cca62a53f72d625d5a9a30e5d76b3caf55fa07`.
12/12 test viewport đạt, gồm worker RGB và R01 refiner (`native-viewport-final-tests.log`).
Worker của executable cuối compile/pipe R01 667,08 ms, packet v3 98.564.180 byte,
không warning (`r01-worker-pipe-final.json`).

Đo lại trên nguồn cuối: lượt toàn suite có 10 refinement/2,297 giây;
lượt cô lập có 12 refinement/2,302 giây, camera mô phỏng → GPU-ready p95 5,557 ms,
resident work p95 4,060 ms. Camera cuối vẫn khớp pixel render đầy đủ. Các số này
**thay thế số 20 refinement/0,925 ms trước đó khi mô tả bản hiện hành**; không
kết luận cải thiện nhịp làm nét từ một số compositor nhanh. Chưa xác định được
toàn bộ nguyên nhân chênh lệch giữa hai đợt, chưa cấp PASSED P03/P06.

Giữ cả trace của lượt toàn suite `r01-native-resident-trace-full-suite.csv` và
lượt cô lập `r01-native-resident-trace.csv`; log cô lập
`native-resident-final-isolated.log`, tổng hợp nguồn/hash/test `verification-final.json`.
Đã yêu cầu người dùng kiểm R01 trên bản cố định; không sửa source hoặc chạy benchmark
nền trong lượt họ thao tác. Kết quả HWND thực chưa có ở thời điểm ghi mục này.

### Lượt runtime đầu và lỗi chọn renderer (12:56–12:58)

Người dùng đã bật setting, single_fit và hand nhưng log vẫn là tile PPE cũ, không
có GPU_SCENE. Hai điều kiện trong consumer sai kiểu dữ liệu: dùng
`!activeDashboardTool` trong khi giá trị không có công cụ là `'none'`; dùng
`!bleedView` trong khi store luôn có object `{ show, mm }`. Cả hai đều chặn native.
Đã sửa bằng `nativeViewerAllowsWorkspaceOverlays` đọc `'none'` và `bleedView.show`,
thêm `native-renderer-policy` vào log, cùng regression lấy trạng thái từ **store
thật** rồi bật/tắt bleed/tool. Frontend 24 test đạt (`frontend-policy-tests.log`).

Sau HMR đã thấy native khởi tạo adapter Vulkan trong PrynX.log nhưng chưa có mốc
hoàn tất viewport/scene. Đang xác minh với người dùng trạng thái cửa sổ; không lấy
lượt zoom tile PPE cũ làm benchmark GPU, không gọi lỗi runtime đã sửa hoàn toàn.

### Chớp “Đang chuẩn bị trang…” khi dùng Space (13:02)

Người dùng xác nhận hộp chuẩn bị trang chớp khi thao tác. Policy trace ghi hand
rồi pointer cách nhau 0,4–0,5 giây; hook phím Space đổi tool tạm thời làm nhánh
native mount/unmount theo mỗi cử chỉ. Đã tách `renderToolMode` trong hotkey:
Space giữ renderer của công cụ trước khi nhấn, còn H/nút bàn tay mới chọn renderer
theo hand lâu dài. Không sửa timing/debounce để che việc khởi tạo lại scene.

Regression dùng store thật kiểm ba lần Space từ pointer, sau đó H và Space từ hand;
41 test frontend đạt và typecheck đạt (`frontend-lifecycle-final.log`,
`frontend-lifecycle-typecheck.log`). Chờ xác nhận runtime ở H giữ nguyên; chưa có
GPU_SCENE/GPU_INPUT chứng minh trang đã present qua native. Người dùng không cần
chạy lại run_dev cho hai lô frontend này.

### Bàn tay đứng ở nền xám: thứ tự HWND (13:05–13:11)

Ca người dùng: R01 trang 1, chọn bàn tay, vùng PDF giữ “Đang chuẩn bị trang…”.
Log lúc 13:04 và 13:05 đã có `GPU_SCENE_READY`, `GPU_SCENE_REFINE` và
`GPU_SCENE_PRESENT`. Bổ sung trace vòng đời frontend rồi HMR, ghi nhận đầy đủ:
scene revision 7 → status đúng view/generation/revision → visibility-start true
→ visibility-done true. Do đó không kết luận GPU bị treo chỉ từ ảnh loading.

Lỗi xác định trong phần embedding: `CreateWindowExW(WS_CHILD)` đặt child mới
ở cuối z-order; Wry 0.55.1 đã đưa WebView sibling lên `HWND_TOP` lúc tạo. Đường
hiện viewport chỉ gọi `ShowWindow(SW_SHOWNOACTIVATE)`, resize lại giữ
`SWP_NOZORDER`, nên việc present/ACK thành công không bảo đảm viewport lên trên
WebView. Tài liệu [Microsoft CreateWindowW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-createwindoww)
quy định thứ tự mặc định này.

Đã tái hiện bằng hai child thật trên Windows, parent ẩn, không chạm cửa sổ user:
test bản cũ thất bại với WebView sibling vẫn đứng đầu. Bản sửa dùng
`SetWindowPos(HWND_TOP, SWP_SHOWWINDOW | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE)`;
ẩn giữ nguyên z-order, trả lỗi HWND không hợp lệ thay vì ACK giả thành công.
5 test đạt: ca gốc, không đổi geometry/focus, ẩn khi dialog xuất hiện/hiện lại,
chuyển hai viewport và HWND đã hủy. Đây là kiểm hợp đồng Win32; **chưa phải
nghiệm thu hình ảnh/input trên Tauri/WebView2 thật**.

Bằng chứng tại `.tmp/review-ppe-gpu-2026-09-25/`: `visibility-before.log`
(1 failed), `visibility-after.log` (5 passed), `frontend-visibility-tests.log`
(41 passed); TypeScript đạt (`frontend-visibility-typecheck.log`). Module native
được chuẩn bị ngoài cây Tauri đang được watch để tránh tự khởi động lại app lúc
người dùng chưa lưu. Sau xác nhận “đã dừng”, đã áp vào `viewport/visibility.rs`,
`commands.rs` và `mod.rs`. Bộ test viewport trong crate Tauri đạt **14 test,
2 ignored** (`native-zorder-tests.log`); hai ca ignored là benchmark R01 và worker
RGB đã kiểm trước đó, không chạy lại vì lô này chỉ đổi visibility/z-order.
Trace mới giữ trong `.tmp/render-diagnostics/PrynX_RenderPerf.log`,
event `native-viewport-lifecycle`; native sẽ ghi `GPU_VIEWPORT_VISIBILITY` gồm
`top_sibling` sau khi áp bản sửa. Build executable đạt trong 2 phút 18 giây
(`native-zorder-build.log`), SHA256
`71ac6e26a6578ab78f1399b4ce9288f31be0675599609068b7a232c4d8531835`.
Nguồn và artifact được chốt trong `zorder-verification.json`. Xác nhận runtime
Tauri/WebView2 sau build vẫn còn thiếu; chưa kết luận lỗi màn hình thực đã hết.

### Runtime sau bản sửa HWND và chờ khi chọn bàn tay (13:22–13:29)

Người dùng xác nhận: “đã thấy trang và kéo zoom được, nhưng lúc chọn bàn tay thì
phải chờ 1 lúc mới thấy trang”. Phiên host PID 25032, exe SHA256
`f50bd420cb5f93b181ebc259c00fc24b9155cc619a53f747f9ed91d58c591346` do run_dev
build lại. Log có `visible=true top_sibling=true`, một lần mount/load scene,
423 present, 331 present phản hồi input và 96 refinement. Trong khoảng thao tác
25 giây không có remount hoặc lỗi status native. Lỗi HWND bị che đã được kiểm
trên runtime bằng log và xác nhận người dùng; chưa suy rộng sang DPI/modal/soak.

Số đo của lượt này lưu riêng trong `native-runtime-zorder-summary.json`,
`native-runtime-zorder-events.csv` và `native-runtime-zorder.log`:

- Chọn bàn tay → ACK hiện viewport: **3.659 ms**; mở HWND/GPU 497 ms;
  chuẩn bị scene 2.714 ms; scene-start → present đầu 3.147 ms.
- WM input → gọi present: trung vị **1,597 ms**, p95 **19,792 ms**, max **31,518 ms**;
  đây không phải độ trễ tới pixel màn hình.
- Camera dùng cho refinement khi hoàn tất đã cũ trung vị **174,131 ms**,
  p95 **285,832 ms**, max **683,067 ms**. Đây là tuổi camera, không phải thời gian
  riêng của một job. 45/94 refinement sau input đầu dùng mức zoom khác mức mới nhất;
  log chưa đủ dữ liệu để so pan.
- Encode refinement: trung vị **77,073 ms**, p95 **121,805 ms**. Đường vector
  vẫn tạo coverage/clip trên CPU trong `RetainedRenderer`; chưa có số tách từng
  công đoạn để gán toàn bộ 77 ms cho raster CPU. `resident_us` bao gồm cả ghi log
  đồng bộ sau present nên không dùng làm số GPU/compositor thuần.

**R25.GPU.29 — giữ trang trong lúc chuyển renderer, tái sử dụng scene khi đổi công cụ.**
Consumer cũ chỉ mount native sau khi chọn hand và unmount ngay cây trang hiện hành.
Đã chuyển sang container ổn định ở chế độ fit: giữ nguyên cây trang cũ tới khi
nhận ACK hiện HWND; pointer → hand lần sau dùng lại scene đang giữ ẩn. Viewport ẩn
không chạy theo zoom pointer. Đổi tài liệu/trang, tắt native hoặc ra khỏi điều kiện
hỗ trợ vẫn đóng lease và không nhận kết quả cũ. Không preload tranh CPU trước khi
người dùng chọn bàn tay lần đầu. Thời gian compile lần đầu chưa được giảm bởi lô này.

Test trước sửa: **4 failed** (`native-handoff-before.log`). Sau sửa và bổ sung
ca ACK chậm, status đến muộn khi rời hand, zoom khi đang ẩn: **48 passed** trên
5 file (`native-handoff-after.log`), TypeScript đạt (`native-handoff-typecheck.log`).
Lô này sửa frontend, không đổi native executable. Chưa có số runtime sau sửa
để khẳng định thời gian chuyển công cụ lần hai hoặc hết khoảng trống trên màn hình.

Trong lúc HMR thay đổi hook, phiên đang mở ghi lỗi React `Should have a queue`,
ID `ROOT-GKVL3P-RW7Z`, component `NativeGpuViewportContainer`. Code đầy đủ khi
mount mới và các chuỗi chuyển công cụ đạt kiểm thử. Đã thêm `@refresh reset` để
Fast Refresh remount component; ErrorBoundary đã bắt lỗi ở phiên đang chạy cần
người dùng bấm **Tải lại**. Không coi HMR của lượt này thành công, không xóa log lỗi.

### R25.GPU.30 — Setting chọn renderer, con trỏ/bàn tay chỉ chọn thao tác

Người dùng đã duyệt triển khai và xác nhận lưu, dừng `run_dev` trước khi áp
native. Đã bỏ điều kiện chỉ cho `hand` dùng GPU trong chế độ một trang. Khi bật
**Trình xem GPU mới**, cả con trỏ và bàn tay dùng cùng viewport, scene và camera.
Đổi công cụ chỉ gửi cấu hình input; không đóng/mở HWND hoặc biên dịch lại PDF.
Công cụ/chế độ chưa hỗ trợ vẫn theo điều kiện fallback hiện có.

- Native xử lý chọn chữ Unicode, kéo chọn ngược/nhiều dòng, nhấp đúp chọn từ,
  Shift chọn tiếp, liên kết, chọn chú thích và menu chuột phải. Bàn tay, phím cách
  hoặc nút giữa vẫn kéo trang. Nhả mouse capture ở ngoài khóa trạng thái để
  tránh WndProc gọi lại đồng bộ làm kẹt khóa.
- Backend gửi thêm glyph box gốc từ PDFium; native áp cùng ma trận crop/rotate/
  UserUnit của scene. Không sửa heuristic bbox cũ của consumer khác, không thêm
  lần render PDF hoặc nới khóa PDFium. Test dùng PDF thật có crop, UserUnit và
  bốn góc xoay.
- Lớp GPU vẽ vùng chọn và đánh dấu trên ảnh PDF đang có. Toolbar, thẻ bình luận,
  menu React dùng vùng loại trừ HWND để nhận cả pixel lẫn hit-test; không đổi
  renderer để hiện popup. Ctrl+C và đánh dấu dùng lại clipboard/store hiện hành.
- Giữ trang hiện có đến khi native đã present và xác nhận cấu hình input. Lọc
  event theo chủ sở hữu, generation và revision; event cũ không áp sang trang mới.
  `GPU_INTERACTION_CONFIG` ghi revision, công cụ và số dòng/đánh dấu, không ghi
  nội dung chữ được chọn vào log.

Bằng chứng của lô ở `.tmp/gpu-interaction-2026-09-25/`:

| Kiểm tra source đã áp dụng | Kết quả | Log |
|---|---|---|
| Frontend: lifecycle, GPU setting, con trỏ/bàn tay, text/menu/markup, hotkeys | 58 passed / 5 file | `frontend-final-tests.log` |
| TypeScript toàn frontend | Đạt | `frontend-final-typecheck.log` |
| PDFium glyph geometry với crop/rotation/UserUnit | 4 passed | `backend-final-tests.log` |
| Native viewport, input Win32 thật, GPU pixel readback, region/hit-test | 28 passed, 2 ignored | `native-final-tests.log` |
| ESLint helper và hai component tương tác | Đạt | `frontend-new-components-lint.log` |
| Build executable dev trên source thực tế | Đạt, 3 phút 01 giây | `native-final-build.log` |

Executable `desktop/src-tauri/target/debug/pdf-inspector.exe` hoàn tất lúc
14:07:51 ngày 25/09/2026 (UTC+7), SHA256
`f2a8b6ffc5ccab20d07184d095a1441939d57ba272ac7d79c8b5b9ae255f5e47`.
Không đổi profile/LTO. Có 17 cảnh báo dead-code của crate, không có lỗi build.

Hai test native ignored là benchmark R01/worker, không chạy lại trong lô input.
ESLint hook `useNativeGpuViewport.ts` còn 2 lỗi `set-state-in-effect` và 2 cảnh báo
cleanup ref tại các đoạn reset vòng đời đã có trước lô này; xem `frontend-lint.log`
và bản trước áp dụng trong `before-apply/`. Không coi lint toàn phạm vi là đạt.
Test Win32 tạo cửa sổ riêng, không thao tác vào cửa sổ PrynX của người dùng.
**Chưa có lượt runtime R01 sau R25.GPU.30**; không suy từ test rằng toàn bộ DPI,
popup, độ trễ khởi tạo hoặc zoom thực tế đã được nghiệm thu. Sổ `verification.json`
ghi hash source, executable và kết quả build cuối để đối chiếu khi chạy lại.

## R25.GPU.31 — Giảm chuẩn bị scene, giữ phiên tài liệu và tài nguyên GPU

Đã áp dụng source đã kiểm thử và build lại bản dev lúc 15:10:33 ngày 25/09/2026
(UTC+7). SHA256 của `desktop/src-tauri/target/debug/pdf-inspector.exe`:
`c2aee2432458a6a175fea2c813969b29b1248a9a5b6def557f68eab1fdbc9531`.

- Worker giữ PDF đã parse; cache scene/material theo nội dung và GPU độc lập
  với HWND/revision. Đóng lease tài liệu cuối dọn cache; RAM/VRAM có áp lực
  mới thu hồi, không giảm độ phân giải hoặc hard-cap số trang trên máy mạnh.
- Tài nguyên ICC/pipeline dùng chung; chuyển ảnh và mipmap theo dải hàng
  song song. Material được chuẩn bị sau culling. Mỗi viewport giữ scratch riêng.
- Token scene không đổi theo sự kiện tile nét hơn. Material không được GPU
  hỗ trợ chuyển cả lease sang PPE trước submit, giữ đúng camera zoom lẻ.
- Sửa vòng đời mask: 492 mask ở R01 trang 2 không còn giữ đồng thời toàn bộ
  surface tới cuối frame. Kết quả tái sử dụng sau lần dùng cuối, giữ pixel.

Kiểm chứng:

| Phạm vi | Kết quả |
|---|---|
| TypeScript trên source đã áp dụng | Đạt |
| Frontend lifecycle/token/input | 98 passed / 6 file |
| GPU mặc định trong staging, source đã đối chiếu SHA256 khi áp dụng | 40 passed, 3 benchmark ignored |
| Native viewport/session/cancel/PPE với executable vừa build | 35 passed |
| Pixel trước/sau, 2 luồng, cache hit và executable mới | 19 cặp RGBA khớp từng byte |
| Build dev từ source thực tế, `--locked` | Đạt |

Native test harness biên dịch từ bản staging đã đối chiếu source; lần kiểm
cuối khởi chạy worker từ **executable source thực tế vừa build**. Không tuyên
bố đã chạy thao tác người dùng trên Tauri/WebView2 sau R31. Ảnh native trang 1
quay lại được so khớp với ảnh lần đầu; bản scene worker giữ parser khi chuyển trang.

Benchmark riêng renderer trang 1: chuẩn bị và frame đầu lần đầu 1.570 → 569 ms;
dùng lại 100–108 ms (không bao parse/compile/GPU init/HWND). Trang 2 vẫn nặng
transparency và chưa đạt ngân sách frame; không coi hết lỗi RAM là hết chậm.
ESLint toàn Viewer chưa xanh do lỗi/warning lifecycle đã ghi ở R30; lượt này
không gắn nhãn lint sạch và không thay các reset ngoài phạm vi.

Bằng chứng đầy đủ: `.tmp/gpu-scene-session-2026-09-25/verification.json`,
`native-final-build.log`, `native-final-tests.log`, `native-final-session/`,
`frontend-final-typecheck.log`, `frontend-final-tests.log`, `pixel-verification.json`.
Hash source, dependency/profile/font và executable lưu cùng kết quả. Báo cáo:
[BAO_CAO_AUDIT_SCENE_STARTUP_2026-09-25.md](BAO_CAO_AUDIT_SCENE_STARTUP_2026-09-25.md).

## R25.GPU.32 — Nối wheel native vào điều hướng Viewer

User báo cuộn giật và không sang trang tiếp theo. HWND nhận wheel nhưng chỉ pan
một trang, mỗi delta bị đổi thành ±50 DIP; Ctrl+wheel nhỏ cũng zoom đủ 15%.
Baseline test qua SendMessageW tái hiện delta 1/120 nấc vẫn zoom 15%.

Đã giữ delta lẻ, dùng thiết lập cuộn Windows, giới hạn wheel theo biên trang
(Rotate/UserUnit/DPR), không phát frame khi camera không thay đổi. Sự kiện biên
đi qua lease/revision vào reducer chung của Viewer; state chống quán tính còn
nguyên khi đổi trang. Không đưa wheel qua React setState tránh mất delta gộp.

37 test native đạt (gồm HWND thật), 48 test frontend đạt (gồm reducer/hook thật,
IPC giả lập; cả ca tab ẩn/đóng, popup, revision cũ, remount và DOM wheel).
Chưa xác minh thao tác tay trong PrynX; không kết luận scene trang nặng đã nhanh.
Chi tiết: [BAO_CAO_AUDIT_GPU_WHEEL_2026-09-25.md](BAO_CAO_AUDIT_GPU_WHEEL_2026-09-25.md).
Provenance/build/typecheck: `.tmp/gpu-wheel-navigation-2026-09-25/verification.json`.

## R25.GPU.33 — Giảm chi phí mask/clip và giữ viewport khi đổi trang

Log sau R32 cho thấy scene trang 2 đã cache (93 ms), nhưng first-present vẫn
mất 12,96 giây. Renderer đóng gói clip theo toàn viewport, sinh 2,37 GB coverage;
đổi trang còn hủy HWND và chờ tác vụ trang cũ trong đường đóng presenter.

- Chỉ lưu/upload vùng clip cần thiết, dùng lại clip trùng hình học và parent;
  hợp vùng mask từ mọi invocation. Giữ nguyên tọa độ raster để không đổi AA.
- Hủy encode lỗi thời giữa primitive; hủy không làm vô hiệu GPU hoặc fallback PPE.
  Cache overview hoàn tất trong PreparedScene, thu hồi theo cơ chế RAM/VRAM sẵn có.
- Giữ HWND qua đổi trang, loại camera/ACK hiển thị sai revision. Reset lớp tương
  tác theo trang; sửa race first-present từ cache đến trước rAF ẩn viewport.
- Tối ưu package `viewer_gpu` trong profile dev như các kernel đã có;
  không thêm profile release/LTO hoặc cap tài nguyên.

Benchmark release riêng renderer R01 trang 2, 1309×885: frame 5,817 → 1,339 giây,
encode 3,774 → 0,874 giây; coverage 2.371.529.036 → 14.622.536 byte. Bốn cặp
ảnh trang 1–2 (toàn trang và zoom/pan) trùng từng byte. Thử nghiệm chia ô thay
đổi AA đã bị loại, không có trong bản áp dụng.

Native HWND tự động, bản dev: load/prepare lần đầu 1,231 giây + present 1,911
giây; quay lại load 1,522 ms + present 29,077 ms; đóng trong lúc đang render
37,041 ms. Đây là phép đo HWND riêng, chưa phải nghiệm thu UX Tauri/WebView2.

42 test GPU, 38 test native và 50 test frontend đạt. Frontend/typecheck chạy
lại trên source đã áp dụng đều đạt. Lint vẫn có 3 lỗi/2 cảnh báo đã có trong
baseline. Source, pixel, executable và phạm vi kiểm chứng được ghi tại
`.tmp/gpu-page-latency-2026-09-25/verification.json`; xem
[báo cáo R33](BAO_CAO_AUDIT_GPU_PAGE_LATENCY_2026-09-25.md).

## Điều kiện còn thiếu để bật mặc định

Compiler/resource, alpha/shape, ICC/spot và đường PDF → GPU → Viewer đã có triển khai
và test thực, nhưng chưa đủ bằng chứng nghiệm thu toàn bộ G0–G4. Còn kiểm HWND thật
trên R01 (zoom/pan/modal/DPI/lifecycle), golden Acrobat/ΔE00, mật độ nét P06 và soak
HWND/VRAM 30 phút. Native hiện áp dụng single-page với con trỏ/bàn tay; các chế độ/công cụ khác giữ
Viewer hiện hành. Cờ mặc định vẫn tắt; không đổi cổng nghiệm thu thành PASSED bằng
số headless hoặc prototype. Bật thử ở Cài đặt → Không gian làm việc → Trình xem GPU mới.
