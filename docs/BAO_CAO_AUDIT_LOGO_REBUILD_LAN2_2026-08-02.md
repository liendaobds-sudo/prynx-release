# Báo cáo re-audit — Phục hồi & Vector hóa Logo, lần 2

**Ngày audit:** 2026-08-02
**Revision chốt:** `7ebcd344948590f83680e76ab21303ed2a9ed780`
**Trạng thái:** **LÔ A ĐÃ SỬA VÀ VERIFY; CHỜ DUYỆT LÔ B**
**Phán quyết:** **NO-GO cho production; tiếp tục giữ dev-only**
**Chế độ:** re-audit chức năng có kiểm chứng tĩnh, test tự động và fixture cục bộ
**Quy trình:** `prynx-architecture` + `prynx-audit-workflow` +
`prynx-security-review` + `prynx-performance` + `prynx-imposition` + `prynx-testing`

## 1. Tóm tắt điều hành

Lõi VTracer ở nhánh **fixed palette đã biết trước** vẫn có trần chất lượng tốt trên corpus
synthetic: benchmark 8 logo × 4 mức đầu vào giữ `ΔE50 = 0,00`; bF2 đạt `1,000` ở PNG
1200 px, `0,995` ở PNG 600 px và `0,997` ở JPEG 600 q75. Các bản sửa cũ về ICC, viewBox,
Undo/Redo, preview stale, lưu SVG và xác nhận palette vẫn qua test.

Tuy nhiên pipeline sản phẩm hiện **chưa sẵn sàng phát hành**. Blocker cao nhất là lỗi topology
khi bật **Loại màu nền khỏi SVG**: VTracer có thể gom nền ngoài và counter/hole vào cùng một
compound path, trong khi worker xóa theo cả thẻ `<path>`. Fixture vòng khuyên vì vậy từ logo có
lỗ biến thành khối màu đặc mà không có warning. Đây là lỗi sai kết quả in im lặng và là **P0 duy
nhất** của đợt re-audit.

Các blocker P1 còn lại gồm panic ảnh hoàn toàn trong suốt, nổ path/node do upscale JPEG,
thiếu output-QC cho cả SVG quá phức tạp lẫn SVG rỗng, admission RAM/threadpool không an toàn,
mất màu nhấn nhỏ, drop ảnh đi sai tab, mất phiên chưa lưu, thiếu công cụ QA trực quan, UI che
giới hạn phạm vi và kích thước mm phụ thuộc metadata DPI.

Tổng finding sau khi gộp các biểu hiện cùng nguyên nhân để tránh đếm trùng:

- **1 P0** — sai topology/counter khi loại nền;
- **10 P1** — sai/không kiểm soát kết quả, resource safety và mất dữ liệu/luồng chính;
- **6 P2** — release control, validation/recovery, i18n, accessibility và job lifecycle;
- **1 P3** — SVG vẫn là điểm cuối, chưa round-trip trong PrynX.

**Cập nhật sau Lô A:** §LR2.01 P0 và §LR2.02 P1 đã đóng ở Mức 2 tự động kèm smoke native.
Backlog còn mở là **0 P0, 9 P1, 6 P2, 1 P3**; phán quyết toàn tính năng vẫn NO-GO cho tới khi
các cổng ở §10 đạt.

Không phát hiện lỗ hổng bảo mật mới đủ confidence ≥80%. Điều này **không** có nghĩa toàn hệ thống
an toàn: chưa fuzz parser/VTracer, chưa sanitizer, chưa kiểm binary installer thật và SVG sanitizer
hiện còn tối thiểu. Các finding availability/resource được xếp theo tác động chức năng trong threat
model hiện tại, không phải bypass license.

## 2. Phạm vi và scan context

### 2.1 Phạm vi đã rà

- Điểm vào Home, routing tab/file, dev/prod gate và entitlement.
- `LogoRebuildWorkspace`, API client, Undo/Redo, stale response, hủy job, lưu SVG, i18n và a11y.
- Schema, upload/preflight, palette suggestion, ICC/EXIF, crop/phối cảnh, RAM/upscale,
  SVG geometry/background mask, scheduler và job registry.
- Adapter Rust VTracer, cancellation/GIL, dependency pin/NOTICE và đường maturin → Nuitka.
- Test backend/frontend/native, production-mode routing và benchmark/corpus có sẵn.

### 2.2 Ngoài phạm vi

- AI dựng lại phần bị che, nhăn vải mạnh, font matching và phối cảnh phi tuyến.
- Fuzz/sanitizer dài cho Pillow/OpenCV/VTracer và audit toàn bộ parser ảnh/native FFI.
- Build installer production, ký/phát hành hoặc thử trên hệ thống khách hàng.
- Đánh giá màu/hình học tuyệt đối cho ảnh thật không có vector ground truth.

### 2.3 Revision và working tree

- Audit bắt đầu khi working tree có nhiều thay đổi song song.
- Trong lúc audit, chủ workspace tạo checkpoint `7ebcd344948590f83680e76ab21303ed2a9ed780`
  (`checkpoint: lưu các đợt sửa trước tối ưu Combine`).
- Toàn bộ finding cuối được đối chiếu lại trên HEAD `7ebcd34`.
- Sau đó HEAD chuyển qua `afa7654` tới `d246932` cho tài liệu và fast path native Combine. Diff ở
  `native/Cargo.toml`, `Cargo.lock` và `native/src/lib.rs` chỉ thêm dependency/module/symbol Combine;
  module Logo, ba đăng ký PyO3 Logo và pin VTracer không đổi, nên baseline/kết luận dưới đây giữ nguyên.
- Audit chỉ cập nhật báo cáo này theo yêu cầu; không sửa mã sản phẩm, không cập nhật snapshot,
  không stage/commit/push.

## 3. Bằng chứng kiểm thử và số đo

### 3.1 Cổng tự động

| Cổng | Kết quả |
|---|---:|
| Pytest logo + feature gate + entitlement | **33 passed** |
| Vitest Logo workspace + routing/drop + quyền + i18n | **60 passed** |
| Vitest routing `--mode production` | **20 passed** |
| TypeScript typecheck toàn desktop | **đạt** |
| Rust `cargo test logo_vectorizer --lib --offline` | **6 passed** |
| `py_compile` + `git diff --check` phạm vi logo | **đạt** |

Ba warning pytest là deprecation dependency có sẵn; không phải regression của tính năng.
Các test xanh chỉ chứng minh ca đã được viết. Chúng chưa phủ compound-path thật, drop Tauri,
dirty close, English render, invalid geometry UX, capabilities failure hay release artifact.

### 3.2 Benchmark ground truth cố định

Chạy lại `backend/scratch/main_check/gt_bench.py palette+smooth0` trên đúng 8 logo và
4 mức đầu vào của audit 30/07:

| Đầu vào | bF2 | IoU | ΔE50 | Node trung bình |
|---|---:|---:|---:|---:|
| PNG 1200 px | 1,000 | 0,980 | 0,00 | 142 |
| PNG 600 px | 0,995 | 0,980 | 0,00 | 59 |
| JPEG 600 q75 | 0,997 | 0,980 | 0,00 | 553 |
| PNG 300 px, chưa upscale | 0,917 | 0,955 | 0,00 | 57 |

Kết luận được giữ: engine có thể rất chính xác **khi palette đúng và ảnh thuộc corpus phẳng**.
Số này không chứng minh preset sản phẩm xử lý tốt JPEG thật, topology loại nền hay palette gợi ý.

### 3.3 Counterexample sản phẩm

Pipeline sản phẩm hiện tại (auto suggestion → fixed palette → upscale ảnh nhỏ → smoothing 0,
despeckle 4) được đo bằng chính `metrics.svg_complexity`:

| Fixture | Path | Node | Tỷ lệ path vụn | SVG |
|---|---:|---:|---:|---:|
| `2.jpg` | 2.431 | **40.371** | **84,5%** | 839,2 KB |
| `7.jpg` | 3.143 | **44.030** | 69,7% | 1.339,1 KB |
| `8.jpg` | 3.029 | **45.101** | 64,8% | 1.370,1 KB |

Không ca nào nhận warning complexity/reject. Ở chiều ngược lại, logo trắng/vàng chạy
`monochrome` có thể trả SVG chỉ 108 byte, `paths=0`, nhưng response vẫn `ready`.

Fixture vòng khuyên khi bật loại nền cho thấy:

```text
SVG thô: 2 path
- path logo đỏ
- 1 path nền trắng compound gồm 3 subpath
Sau _strip_svg_background: chỉ còn path đỏ phủ kín khung
Alpha tâm lỗ: 255; warning: []
```

## 4. Bảng finding

| Mã | Mức | Effort | Trạng thái | Tóm tắt |
|---|---:|---:|---|---|
| §LR2.01 | P0 | M | `[FIXED LÔ A — VERIFIED M2]` | Xóa nền theo path làm compound counter/hole bị lấp thành mảng đặc |
| §LR2.02 | P1 | S | `[FIXED LÔ A — VERIFIED M2]` | All-transparent fixed palette làm VTracer ném `PanicException` ngoài hợp đồng lỗi |
| §LR2.03 | P1 | M | `[VERIFIED]` | Upscale NEAREST khuếch đại nhiễu JPEG thành 40 nghìn node |
| §LR2.04 | P1 | M | `[VERIFIED]` | Không có output-QC: SVG quá phức tạp hoặc không có path vẫn báo `ready` |
| §LR2.05 | P1 | L | `[VERIFIED]` tĩnh + harness | RAM planner muộn/not-slot-aware; waiter giữ cạn Starlette thread token và kẹt cancel |
| §LR2.06 | P1 | M | `[VERIFIED]` | Palette suggestion bỏ màu nhấn <1% mà không cảnh báo |
| §LR2.07 | P1 | M | `[VERIFIED]` tĩnh | Drop ảnh khi Logo active đi sang tab thường/Combine |
| §LR2.08 | P1 | M | `[VERIFIED]` tĩnh | Đóng tab/app làm mất editor/preview chưa lưu mà không có dirty guard |
| §LR2.09 | P1 | L | `[VERIFIED]` tĩnh | Không có zoom/pan/A-B/overlay hoặc tay nắm crop/quad |
| §LR2.10 | P1 | S | `[VERIFIED]` tĩnh | Limitations bị ẩn; UI còn mời ảnh vải/chụp trái phạm vi duyệt |
| §LR2.11 | P1 | M | `[VERIFIED]` | Kích thước mm tin metadata DPI, không có bước xác nhận |
| §LR2.12 | P2 | M | `[VERIFIED]` tĩnh | HOLD frontend-only và release smoke không kiểm symbol/trace Logo |
| §LR2.13 | P2 | S | `[VERIFIED]` tĩnh | Palette gợi ý gồm nền rồi validation “Loại nền” từ chối chính màu đó |
| §LR2.14 | P2 | M | `[VERIFIED]` tĩnh | Crop/quad validate muộn; capabilities lỗi làm UI kẹt và không có retry |
| §LR2.15 | P2 | M | `[VERIFIED]` | 45/68 chuỗi `tv()` của workspace thiếu catalog |
| §LR2.16 | P2 | S | `[VERIFIED]` tĩnh | File input ẩn không dùng được bằng phím; trạng thái async thiếu `aria-live` |
| §LR2.17 | P2 | S | `[VERIFIED]` | `logo_vectorizer_info()` lỗi trước `finally` làm rò `_ACTIVE_JOBS` |
| §LR2.18 | P3 | L | `[VERIFIED]` tĩnh | SVG là endpoint; chưa project JSON/import/round-trip PrynX |
## 5. Phát hiện chi tiết

### §LR2.01 — P0: loại nền làm lấp counter/hole của compound path

**Cập nhật Lô A:** đã sửa. Worker nhận biết background compound path và dùng nguyên topology làm
vùng mask khoét. Fixture native vòng khuyên sau raster cho tâm/góc `(255,255,255)`, vành đỏ
`(220,30,30)`; không còn layer đỏ phủ kín khung.

**Bằng chứng code.** `_strip_svg_background()` tìm các **thẻ** có `fill` trùng màu nền
([worker:503-520](../backend/app/workers/logo_rebuild.py#L503)), giả định thẻ đầu là nền ngoài và
chỉ dùng các thẻ từ `matches[1:]` làm hình khoét
([worker:522-526](../backend/app/workers/logo_rebuild.py#L522)). Giả định này không đúng với
topology thật của VTracer: một `<path>` có thể chứa nhiều subpath với winding khác nhau.

**Tái hiện qua engine thật.** Fixture vòng khuyên đỏ trên nền trắng sinh SVG thô gồm hai path:

- path đỏ;
- một path trắng compound có ba subpath: nền ngoài, biên khoét và counter giữa.

Vì chỉ có một **thẻ** trắng, `matches` có độ dài 1 và `hole_shapes` rỗng. Worker xóa toàn bộ path
trắng, kể cả subpath biểu diễn counter; còn path đỏ phủ kín khung. Kết quả raster cuối có alpha
tâm lỗ `255`, tức vòng khuyên thành khối đỏ đặc. `removed=1` nên nhánh warning không chạy.
Corpus lỗ cục bộ trước đó tái hiện 7/10 biến thể bị lấp im lặng; `monochrome` giữ lỗ 7/7.

**Vì sao test xanh không bác finding.** Test hiện tại dùng `FakeNative` trả ba `<path>` tách biệt
([test:536-544](../backend/tests/test_logo_rebuild.py#L536)), rồi chỉ kiểm có mask và màu nền
không còn trong XML
([test:566-577](../backend/tests/test_logo_rebuild.py#L566)). Nó không đưa compound path thật,
không rasterize kết quả và không assert alpha tại tâm counter.

**Tác động.** Chữ O/P/R/B, vòng khuyên và logo có vùng âm có thể bị biến thành mảng đặc khi người
dùng bật đúng tính năng “Loại màu nền”. Đây là sai hình học đầu ra im lặng, có thể đi thẳng tới
bản in nên xếp P0.

**Hướng sửa.**

1. Không suy luận hole bằng thứ tự thẻ path; parse subpath/winding hoặc giữ topology ở tầng
   `VectorDoc` trước khi serialize.
2. Nếu chưa chứng minh được topology, fail closed hoặc trả `review/rejected`; không xuất mảng đặc.
3. Regression phải dùng output native thật/fixture compound, rasterize SVG và khóa alpha nhiều điểm
   trong counter, không chỉ tìm chuỗi XML.
4. Test cả một lỗ, nhiều lỗ, chữ có counter, path nền tách và compound.

### §LR2.02 — P1: all-transparent fixed palette làm `PanicException`

**Cập nhật Lô A:** đã sửa defense-in-depth. Backend từ chối vùng alpha=0 trước FFI bằng HTTP 422;
Rust cũng từ chối buffer không có pixel nhìn thấy và đổi panic dependency thành `RuntimeError` thường
ở biên PyO3. Smoke extension mới trả `ValueError`, thuộc `Exception`, không còn `PanicException`.

Preflight nhận biết ảnh không có pixel nhìn thấy nhưng chỉ trả warning. Nhánh fixed palette vẫn
đưa RGBA alpha=0 tới native
([worker:581-604](../backend/app/workers/logo_rebuild.py#L581)). Adapter Rust kiểm kích thước buffer
nhưng chưa chặn toàn bộ alpha bằng 0. Dependency VisionCortex có đường chia cho số cluster bằng 0.

Reproducer PNG RGBA alpha=0 cho:

```text
pyo3_runtime.PanicException: attempt to divide by zero
isinstance(exc, RuntimeError) = false
isinstance(exc, Exception) = false
```

Route chỉ chuyển các exception nghiệp vụ và `RuntimeError` thành HTTP có hợp đồng
([route:221-230](../backend/app/api/routes/logo_rebuild.py#L221)), nên panic này thoát khỏi lớp xử lý
dự kiến. PyO3 bắt unwind trong phép thử trực tiếp và tiến trình Python còn sống; audit **không**
khẳng định uvicorn production bị chết vì chưa gửi fixture phá lỗi vào sidecar thật.

Phản chứng đã kiểm: cancel token và native smoke thông thường vẫn hoạt động; preflight alpha=0 có
warning. Chúng không thay thế preview regression.

**Hướng sửa:** backend từ chối vùng không có pixel nhìn thấy bằng 422; Rust defense-in-depth trả
`PyValueError`; thêm native/route test và health-after-error. Không sửa bằng `except BaseException`,
vì cách đó có thể nuốt `KeyboardInterrupt`, `SystemExit` và che panic khác.

### §LR2.03 — P1: NEAREST khuếch đại artifact JPEG thành path rác

Mọi ảnh có cạnh ngắn dưới 600 px được nâng lên 600/900/1200 theo RAM mà không xét định dạng/noise;
mọi upscale dùng NEAREST. UI mặc định fixed palette, `smoothing=0`, `despeckle=4`.

A/B cùng `2.jpg`:

| Xử lý | Despeckle | Path | Node | Path vụn | SVG |
|---|---:|---:|---:|---:|---:|
| Nguyên bản | 4 | 192 | 4.098 | 3,1% | 123,2 KB |
| NEAREST 2023×1200 | 4 | **2.431** | **40.371** | **84,5%** | 839,2 KB |
| Nguyên bản | 48 | 4 | 448 | 0% | 15,4 KB |
| NEAREST 2023×1200 | 48 | 18 | 5.886 | 0% | 106,8 KB |

Đổi smoothing không giải quyết được nguyên nhân chính; NEAREST nhân artifact và despeckle vẫn tính
theo pixel ảnh làm việc. Đây là hồi quy chéo của bản sửa upscale vốn đạt trên PNG synthetic.

**Hướng sửa:** preset theo loại ảnh/chỉ số noise; scale despeckle theo hệ số upscale và chi tiết vật
lý; benchmark LANCZOS/giữ nguyên/khử JPEG thay vì đổi cảm tính; cho người dùng chọn “Trung thực nét”
hoặc “Dễ chỉnh sửa”, kèm dự báo complexity.

### §LR2.04 — P1: thiếu output-QC cho cả SVG quá phức tạp và SVG rỗng

Sau khi nhận SVG, worker chỉ kiểm có chuỗi `<svg` và không có `<script>`
([worker:609-626](../backend/app/workers/logo_rebuild.py#L609)). UI sau đó báo “Preview đã sẵn sàng”.
Không có path/node/tiny-path ratio, kích thước file, empty-geometry, nonfinite/bounds hoặc phân loại
ảnh chụp/chuyển sắc.

Hai cực đều lọt:

- JPEG thật sinh 40–45 nghìn node vẫn `ready`, không warning complexity;
- logo trắng/vàng ở `monochrome` có thể sinh SVG 108 byte, `paths=0`, vẫn `ready`.

Phản chứng: SVG parser/viewBox và chặn `<script>` bắt một số artifact hỏng cú pháp, nhưng không chứng
minh nội dung vector có thể dùng.

**Hướng sửa:** trả complexity report và trạng thái `ready | review | rejected`; reject geometry rỗng,
nonfinite hoặc vượt bounds; ngưỡng complexity dựa trên node density/kích thước in; UI chỉ cho tải
khi warning `review` đã được đọc/override.

### §LR2.05 — P1: admission RAM và threadpool/cancel không an toàn

**RAM gate quá muộn.** Palette suggestion decode → ICC → warp/crop → tạo RGBA toàn ảnh rồi mới
lấy mẫu. Preview cũng load/convert/warp trước planner. Planner cấp 55–65% RAM khả dụng cho **mỗi**
job nhưng không chia theo `max_active_heavy_jobs()`. Trên máy audit có 3 slot và 12,4 GB available,
mỗi job 8000×8000 vẫn được phép cam kết khoảng 6,84 GB; hai job đã vượt ngân sách.

**Waiter giữ Starlette thread token.** `run_scheduled_in_threadpool()` đưa `_run_heavy` vào
Starlette/AnyIO pool
([scheduler:158-172](../backend/app/core/heavy_job_scheduler.py#L158)); bên trong thread đó mới gọi
`BoundedSemaphore.acquire()` chặn vô hạn
([scheduler:117-125](../backend/app/core/heavy_job_scheduler.py#L117)). Khi slot nặng đã kín, mỗi
request chờ vẫn giữ một thread token. Harness cô lập với 40 waiter làm cạn limiter mặc định 40 token.
Endpoint hủy là hàm sync
([route:244-253](../backend/app/api/routes/logo_rebuild.py#L244)), nên cũng cần thread token và có thể
không chạy để set cancel cho chính hàng đợi đang kẹt.

Phản chứng: khi job đã được admit, native token hủy giữa lúc chạy hoạt động và semaphore được nhả ở
`finally`. Finding nằm ở admission/queued state, không phủ định cancellation của active worker.

**Hướng sửa:** admission async trước khi chiếm worker token hoặc hàng đợi/job API riêng; timeout và
cooperative cancel cho cả queued/running; reserve byte budget nguyên tử trước decode/warp và chia
theo slot; thumbnail sớm cho preflight. Test phải bão hòa slot + thread limiter rồi xác nhận health
và DELETE cancel vẫn phản hồi.

### §LR2.06 — P1: palette suggestion bỏ màu nhấn dưới 1% mà không cảnh báo

Worker đặt _MIN_PALETTE_COVERAGE = 0.01
([worker:59-61](../backend/app/workers/logo_rebuild.py#L59)) và bỏ cụm dưới ngưỡng trong bước
chuẩn hóa kết quả
([worker:395-410](../backend/app/workers/logo_rebuild.py#L395)).

Fixture 200×200 gồm nền trắng 74,75%, khối xanh 25% và ô đỏ 10×10 = 0,25% chỉ trả trắng
74,75% và xanh 25%, warnings rỗng. Màu đỏ thương hiệu biến mất khỏi gợi ý. Khi người dùng bấm
“Áp dụng gợi ý”, fixed palette không còn màu đó và tracer buộc vùng đỏ sang màu gần nhất. Test hiện
chỉ phủ các màu có coverage lớn, không khóa chữ nhỏ/dấu/chấm màu thương hiệu.

Phản chứng: hạ ngưỡng toàn cục về 0 sẽ giữ cả nhiễu JPEG, nên không thể kết luận mọi cluster nhỏ
đều là màu hợp lệ.

**Hướng sửa:** giữ hoặc cảnh báo cụm nhỏ có chroma, tương phản và vùng liên kết đủ rõ; phân biệt
hạt JPEG bằng hình học thay vì coverage đơn; thêm eyedropper; test dải 0,1–1,5%, chữ nhỏ có dấu
và ảnh JPEG nhiễu.

### §LR2.07 — P1: drop ảnh khi Logo active đi sang tab thường hoặc Combine

Workspace chỉ có file input onChange, không có onDrop
([workspace:547](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L547)).
Registry receiver ảnh toàn cục chỉ có bgremover và upscale
([tabNavigation:22](../desktop/src/lib/tabNavigation.ts#L22)); resolver trả null cho live feature
logo_rebuild
([tabNavigation:51](../desktop/src/lib/tabNavigation.ts#L51)). Dispatcher vì vậy dùng fallback:
một ảnh mở tab imposition thường, nhiều ảnh mở Combine
([dispatcher:67](../desktop/src/hooks/useIncomingFileDispatcher.ts#L67)). Cả Tauri native drop và
DOM drop đi qua dispatcher này
([SystemIntegrations:101](../desktop/src/components/SystemIntegrations.tsx#L101)).

Phản chứng: picker có test và hoạt động; routing theo tabId cho Tách nền/Upscale cũng hoạt động.
Không tìm thấy listener Logo khác nhận file sau fallback. DOM test không chứng minh native drop.

**Hướng sửa:** đăng ký Logo Rebuild làm receiver theo activeTabId và live feature; từ chối tab nền,
tab đã đóng và intent cũ. Test đủ picker, DOM drop, native drop, nhiều tab. File path-backed cần
materialize bytes hoặc localFileUrl trước khi tạo object URL.

### §LR2.08 — P1: đóng tab/app làm mất editor và preview chưa lưu

LogoRebuildWorkspace chỉ nhận isActive, không có callback dirty/save
([workspace:21](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L21)). File,
editor, history và preview đều nằm trong state cục bộ
([workspace:90](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L90)); lưu SVG
chỉ cập nhật status cục bộ
([workspace:483](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L483)).
ImpositionTab không tính Logo vào dirty
([ImpositionTab:640](../desktop/src/components/ImpositionTab.tsx#L640)); App đóng thẳng tab khi
tab.isDirty là false
([App:644](../desktop/src/App.tsx#L644)).

Phản chứng: saveBlob, preview regeneration và Undo/Redo hoạt động. Nhưng palette, crop, quad,
history và SVG chưa export vẫn mất im lặng; không có crash recovery.

**Hướng sửa:** nối dirty contract từ workspace lên tab; đánh dấu khi nguồn/tham số/kết quả đổi và
chỉ clear sau lưu thành công. Phân biệt “đã lưu SVG hiện tại” với “đã đổi tham số sau lần lưu”;
test close tab/app, cancel confirm và save fail.

### §LR2.09 — P1: không có công cụ QA và đặt hình học trực quan

UI yêu cầu “Hãy phóng to và kiểm tra chữ, nét nhỏ”, nhưng preview nguồn/kết quả chỉ là img
object-contain, không có zoom, pan, A/B, overlay hoặc slider
([workspace:799-823](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L799)).
Crop và bốn điểm phối cảnh chỉ nhập số phần trăm
([workspace:717-758](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L717));
không có tay nắm trên ảnh.

**Tác động:** người dùng không thể thực hiện chính cổng QA mà sản phẩm yêu cầu, khó đặt bốn góc và
không nhìn ra counter bị lấp, chữ nhỏ hay path rác trước khi lưu. Đây là gap chức năng, không chỉ
đánh bóng giao diện.

**Hướng sửa:** viewer có zoom 100–800%, pan, A/B/overlay, nền caro và ruler; crop/quad kéo trực tiếp;
hiện complexity và kích thước in cạnh preview. DOM/unit test phải đi cùng nghiệm thu Tauri thật.

### §LR2.10 — P1: giới hạn bị ẩn và UI mời đầu vào ngoài phạm vi

Backend trả rõ các limitations, gồm “chưa tự phục hồi phần logo bị che hoặc mất nét”
([route:44-57](../backend/app/api/routes/logo_rebuild.py#L44)). API client đã khai báo trường này,
nhưng workspace chỉ dùng capabilities để hiện engine/version
([workspace:223-229](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L223),
[workspace:535-540](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L535)).
Ngược lại, UI còn đưa lựa chọn “Cân bằng ánh sáng trên vải/ảnh chụp”
([workspace:773](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L773)).

Corpus §3 chỉ chứng minh trần tốt cho artwork/logo phẳng; ảnh chụp, vải nhăn, phần bị che/mất không
có ground truth đủ để được hứa là đã hỗ trợ. Subtitle “màu lấy từ pixel nhìn thấy” và lời nhắc kiểm
tra trước in là phản chứng một phần, nhưng không nói rõ phần đã mất sẽ không được phục dựng.

**Tác động:** tên “Phục hồi” cộng với response ready có thể khiến người dùng hiểu engine đã vẽ lại
chi tiết không còn nhìn thấy. Đây là sai lệch phạm vi sản phẩm, không chỉ thiếu một tooltip.

**Hướng sửa:** hiển thị limitations trước chọn file và mang warning phù hợp vào artifact; đổi copy
illumination về cân bằng nền nhẹ cho artwork phẳng. Chỉ mở preset ảnh chụp/vải sau classifier,
corpus và tiêu chí nghiệm thu riêng.

### §LR2.11 — P1: kích thước mm tin metadata DPI, không có bước xác nhận

Worker tính mm bằng pixel × 25,4 / DPI
([worker:426-437](../backend/app/workers/logo_rebuild.py#L426)) rồi ghi trực tiếp vào SVG
([worker:485-500](../backend/app/workers/logo_rebuild.py#L485)). Workspace không hiển thị kích thước
mm và không cho nhập/khóa tỷ lệ kích thước in.

Hai PNG 100×100 giống hệt pixel nhưng metadata khác cho 35,2734 mm ở 72 DPI và 8,4667 mm ở
300 DPI. DPI của ảnh web/JPEG thường là mặc định metadata, không phải kích thước logo thật. ViewBox
đã đúng và test mm theo metadata xanh; đó không phải phản chứng cho nghiệp vụ 1:1.

**Hướng sửa:** xem DPI như gợi ý có ghi nguồn; bắt người dùng xác nhận rộng/cao mm trước export,
khóa tỷ lệ và giữ quyết định trong history/project. Nghiệm thu mở 1:1 trong ít nhất hai phần mềm
chế bản, không chỉ parse XML.

### §LR2.12 — P2: HOLD chỉ cưỡng chế ở frontend và release smoke chưa phủ engine

Frontend dùng import.meta.env.DEV để chặn registry, route ban đầu và mount workspace
([preprocessRouterTools:19-25](../desktop/src/components/imposition-tools/sections/preprocessRouterTools.ts#L19));
production routing test 20/20 đạt. Nhưng backend vẫn include router
([main:218](../backend/app/main.py#L218)); route chỉ yêu cầu entitlement Pro
([route:40](../backend/app/api/routes/logo_rebuild.py#L40)); util.logo_rebuild vẫn thuộc PRO_FEATURES
([feature_entitlements:23-30](../backend/app/core/feature_entitlements.py#L23)). Native VTracer và
NOTICE vẫn đi theo đường wheel/sidecar. Scan release smoke không thấy assertion symbol
logo_vectorizer_info hoặc trace tối thiểu.

**Kết luận bảo mật:** không có bypass Free→Pro; renderer hợp lệ vẫn cần HMAC/license/feature gate.
Nhưng frontend không phải enforcement boundary, nên client Pro/patched có thể gọi API đang HOLD.

**Hướng sửa:** một release flag chung fail-closed ở capabilities/router và frontend, hoặc loại
route/native khỏi release tới GO. Production smoke phải chứng minh API bị từ chối khi flag tắt và
symbol/trace chạy được khi flag bật.

### §LR2.13 — P2: palette gợi ý và “Loại nền” tự xung đột

“Áp dụng gợi ý” sao chép mọi màu, thường gồm nền trắng, vào palette logo
([workspace:621-631](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L621)).
Khi bật “Loại màu nền”, UI/schema lại bắt background phải khác palette
([workspace:398-405](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L398),
[schema:106-110](../backend/app/schemas/logo_rebuild.py#L106)).

Với logo nền trắng, người dùng đi theo hai CTA hợp lệ rồi gặp lỗi cho tới khi tự tìm và xóa trắng.
Backend từ chối đúng contract hiện tại, nên đây là xung đột thiết kế frontend/API chứ không phải
validation backend bị bỏ qua.

**Hướng sửa:** trả/hiển thị background candidate riêng với confidence từ viền; thao tác “Đặt làm
nền” đồng thời loại màu khỏi logo palette và tham gia Undo/Redo. Test nền trắng, alpha, nền không
đều và người dùng đổi ý.

### §LR2.14 — P2: validation muộn và lỗi capabilities không có đường hồi phục

**Hình học.** Crop chỉ clamp từng trường 0–100, không kiểm x + width/y + height
([workspace:729](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L729)).
Quad chỉ clamp từng tọa độ, không kiểm điểm trùng, suy biến, tự cắt hoặc thứ tự lồi
([workspace:501](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L501)).
Backend có invariant và trả 422
([schema:25](../backend/app/schemas/logo_rebuild.py#L25),
[schema:112](../backend/app/schemas/logo_rebuild.py#L112)), nên kết quả được bảo vệ nhưng lỗi chỉ
đến sau upload/chờ.

**Capabilities.** GET lỗi chỉ setError còn capabilities vẫn null
([workspace:223](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L223));
null luôn render “Đang kiểm tra engine…”
([workspace:535](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L535)).
Chọn file xóa error, trong khi Preview bị disable nếu engine chưa ready; không có Retry.

**Hướng sửa:** validate crop/quad phía client nhưng giữ backend làm enforcement; dùng state machine
loading | ready | unavailable | error, tách lỗi engine khỏi lỗi file/job và có Thử lại. Test geometry
biên, reject → retry thành công và unmount/abort.

### §LR2.15 — P2: 45/68 chuỗi workspace thiếu catalog i18n

Đối chiếu static tại HEAD 7ebcd34 theo reverse-map mà tv() dùng cho thấy workspace có 68 chuỗi
tv() tĩnh, trong đó 45 chuỗi không tồn tại trong catalog tiếng Việt; ở locale English chúng trả
nguyên tiếng Việt. Namespace Logo chỉ có 15 key trong hai catalog
([vi.json:4146](../desktop/src/i18n/locales/vi.json#L4146),
[en.json:4146](../desktop/src/i18n/locales/en.json#L4146)). Fallback API cũng hardcode tiếng Việt
([logoRebuildApi:80](../desktop/src/lib/logoRebuildApi.ts#L80)).

i18nCatalog.test chủ yếu thu thập call t('namespace:key'), không phủ call-site tv()
([i18nCatalog.test:26](../desktop/src/i18n/i18nCatalog.test.ts#L26),
[i18nCatalog.test:81](../desktop/src/i18n/i18nCatalog.test.ts#L81)). Vì vậy 60 Vitest xanh không
phản chứng finding.

**Tác động:** English trộn tiếng Việt ở chọn ảnh, engine, lỗi palette/nền, crop/quad, preview,
lưu SVG và alt text.

**Hướng sửa:** bổ sung đầy đủ cặp VI/EN và fallback, hoặc chuyển namespace Logo sang key tường minh;
mở rộng test để quét tv()/manifest tương đương. Render toàn workspace ở English trước GO.

### §LR2.16 — P2: entry action và trạng thái async chưa đạt accessibility

Điều khiển chọn file là label chứa input class hidden
([workspace:547](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L547)).
Input display:none không vào tab order, label không có semantics bàn phím như button. Status
preview/lưu/hủy chỉ là paragraph, không có role=status hoặc aria-live
([workspace:795](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L795)).

Phản chứng: error có role=alert; mode, Undo/Redo, màu và preview phần lớn có accessible name/alt.
Finding vì vậy giới hạn ở thao tác vào và phản hồi async, không kết luận toàn workspace bất khả dụng.

**Hướng sửa:** dùng button thật gọi input ref; input có thể visually hidden nhưng giữ semantics phù
hợp; thêm focus-visible, live region và quản lý focus khi lỗi/hoàn tất. Test keyboard và nghiệm thu
screen reader trên Windows.

### §LR2.17 — P2: lỗi metadata native trước finally làm rò registry job

Trong process_logo_preview, _load_native_module() và logo_vectorizer_info() chạy trước khối
try/finally dọn registry
([worker:581-585](../backend/app/workers/logo_rebuild.py#L581)); discard token chỉ nằm ở finally
sau phần trace
([worker:627-628](../backend/app/workers/logo_rebuild.py#L627)).

Reproducer fake ABI cho logo_vectorizer_info() raise ghi nhận token job vẫn còn trong _ACTIVE_JOBS.
Retry UUID mới tích thêm token; dùng lại UUID cũ nhận 409 cho tới khi process restart. UI capabilities
làm ca này ít gặp hơn nhưng không loại bỏ binary lệch ABI hoặc metadata engine lỗi.

Phản chứng: lỗi trong phần trace sau khi đã vào try vẫn cleanup đúng; finding chỉ áp dụng exit path
trước dòng 585.

**Hướng sửa:** đưa load/info vào cùng try/finally, và để route cleanup reservation nếu scheduler
không gọi được worker. Test từng exit path trước admission, trước trace, trong trace và cancel.

### §LR2.18 — P3: SVG là endpoint, chưa round-trip vào PrynX

Frontend chỉ cung cấp lưu/tải SVG
([workspace:483](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L483),
[workspace:807](../desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx#L807)).
Scan desktop/src không thấy importer/parser đưa SVG vừa tạo vào project, imposition hoặc editor khác.

Artifact vẫn dùng được ngoài PrynX nên đây là P3 roadmap, không phải blocker độc lập của export SVG.
Tuy nhiên workflow “phục hồi → dùng ngay trong PrynX” chưa khép kín và không có project persistence.

**Hướng sửa:** sau khi lõi đạt GO, định nghĩa artifact/project JSON chứa source, tham số, SVG, QC và
kích thước mm; thêm thao tác đưa vào tài liệu hiện tại qua importer an toàn. Không mở round-trip
trước khi SVG validator ở §7 được harden.

## 6. Finding cũ và backlog đã biết

| Mục cũ | Trạng thái re-audit |
|---|---|
| Kết luận cũ loại nền compound là an toàn | **Bị bác và mở lại bởi §LR2.01 với native counterexample** |
| §LR.01 lưu SVG trong Tauri | Có saveBlob, test xanh; Save dialog thật vẫn là proof gap |
| §LR.02 Undo/Redo | History 60 bước, scope theo tab; test xanh |
| §LR.05 preview stale | Revision + AbortController + cancel token đã có; race test xanh |
| §LG.01 mặc định mono làm mất màu | Default đã đổi fixed palette; mono-empty vẫn mở trong §LR2.04 |
| §LG.02 smoothing màu | Đã hạ 0; reopened cho node JPEG ở §LR2.03 |
| §LG.03 upscale ảnh nhỏ | PNG synthetic đạt; reopened cho JPEG thật ở §LR2.03 |
| §LG.04 gợi ý palette | Đã triển khai; reopened biên màu nhỏ ở §LR2.06 |
| §LG.05 ICC CMYK | Thứ tự transform đã sửa và có test |
| §LG.06 viewBox/mm | ViewBox đã có; kích thước 1:1 còn mở ở §LR2.11 |
| §LG.07 TIFF/BMP/AVIF | Chưa làm; hiện chỉ PNG/JPEG/WebP |
| §LR.04 Polygon/Spline | Chưa làm; native vẫn ưu tiên spline, giá trị chính là dễ chỉnh tay |
| §LG.08 round-trip PrynX | Được nâng thành finding hiện tại §LR2.18 P3 |

## 7. Bảo mật và supply chain

### Kết luận trong phạm vi

- Router dùng require_feature(util.logo_rebuild); không thấy bypass Free→Pro.
- Upload kiểm extension và format thật, chặn ảnh động và biến DecompressionBombWarning thành lỗi.
- Filename không được dùng làm server path; dữ liệu xử lý trong bộ nhớ.
- SVG hiện đến từ VTracer đã pin; không thấy nguồn attacker-controlled đi vào tag/attribute để đủ
  exploit path báo XSS mới.
- VTracer/VisionCortex/FloCurves có pin trong lockfile và NOTICE.

Không phát hiện lỗ hổng bảo mật mới đủ confidence ≥80%. §LR2.01 là lỗi integrity đầu ra,
§LR2.02/05/17 là availability/resource/lifecycle có thể do input hoặc tải cục bộ kích hoạt; theo
threat model hiện tại chúng được quản lý như finding chức năng. Kết luận này không mở rộng thành
“toàn hệ thống an toàn”.

### Hardening và proof gap

- SVG validator hiện chủ yếu chặn chuỗi script; trước importer/round-trip phải dùng allowlist
  element, attribute, URL và external reference.
- Chưa fuzz codec/ICC/VTracer, chưa sanitizer Rust và chưa thử binary Nuitka/installer thật.
- Chưa chứng minh bounded queue, RAM reservation và cancellation dưới tải sidecar production.
- Release smoke cần assertion engine symbol/trace nếu feature bật, và API fail-closed nếu tắt.

## 8. Coverage gap và proof gap

- Chưa có ít nhất 3–4 logo khách hàng kèm vector gốc làm holdout cuối.
- Corpus ảnh thật không có vector ground truth; complexity chỉ chứng minh editability, không chứng
  minh hình học/màu tuyệt đối.
- Chưa end-to-end trong Tauri thật: picker/DOM/native drop → preview → cancel → save → mở SVG.
- Chưa runtime close tab/app khi dirty, render toàn workspace English, keyboard/screen reader.
- Chưa nghiệm thu zoom/overlay/crop/quad vì các công cụ này chưa tồn tại.
- Chưa mở SVG 1:1 trong Illustrator/CorelDRAW/Inkscape/RIP.
- Không chạy OOM thật, không gửi panic vào sidecar dev đang dùng và chưa build installer production.
- Reproducer P0 đã rasterize fixture cục bộ, nhưng chưa có corpus counter O/P/R/B từ khách hàng.

Mức bằng chứng chung: **Mức 2 — tự động**. Một số finding frontend là Mức 1 tĩnh có phản chứng;
đường Home → workspace từng có runtime ngày 01/08 nhưng không chứng minh workflow hiện tại.

## 9. Lô sửa đề xuất

Theo quy trình hai chốt, các lô dưới đây chỉ là đề xuất. Không lô nào được áp dụng trước khi chủ
dự án duyệt; mỗi lô giữ tối đa 5 file.

### Lô A — Topology counter + panic boundary (ưu tiên tuyệt đối, tối đa 4 file)

- `backend/app/workers/logo_rebuild.py`: giữ đúng compound counter/hole hoặc fail closed; chặn vùng
  xử lý không có pixel nhìn thấy trước FFI.
- `native/src/logo_vectorizer.rs`: guard all-transparent và đổi panic dependency thành lỗi thường ở
  biên Rust/PyO3; không chữa bằng `except BaseException` ở Python.
- `backend/tests/test_logo_rebuild.py`: fixture compound thật + raster alpha cho vòng khuyên/O/P/R/B;
  preview all-transparent trả lỗi có kiểu và health vẫn phản hồi.
- `backend/app/api/routes/logo_rebuild.py` chỉ chạm nếu cần chuẩn hóa mã lỗi HTTP.

Đóng §LR2.01–02. Không chuyển sang lô khác nếu counter nhiều lỗ, path nền tách/compound, regression
logo không lỗ, native panic boundary và health-after-error chưa cùng xanh.

### Lô B — Output-QC + preset JPEG/mono (tối đa 5 file mỗi nhánh)

- Complexity/empty-geometry report, trạng thái `ready | review | rejected` cùng reason/action có kiểu.
- Preset upscale/despeckle dựa trên loại ảnh/noise, benchmark PNG/JPEG có ground truth.
- Mono dùng alpha/polarity/threshold phù hợp và không được trả SVG không có drawable.
- Nếu contract backend và UI vượt 5 file, tách B1 backend và B2 frontend; không trộn lô.

Đóng §LR2.03–04. Không dùng một hard-cap chất lượng cho mọi máy/ảnh.

### Lô C — Scheduler, RAM admission và job lifecycle (tối đa 5 file)

- Async/bounded admission trước Starlette worker, queued cancel có thể đánh thức waiter.
- Reserve byte budget trước decode/warp, chia theo slot đang active và release nguyên tử.
- Cleanup registry trên mọi exit path, gồm lỗi load/info trước trace.
- Test bão hòa thread limiter, nhiều job, cancel/health và hồ sơ <8 GB, 8–16 GB, ≥16 GB.

Đóng §LR2.05 và §LR2.17. Máy ≥16 GB vẫn chạy full khi ngân sách thực đủ; không hard-cap vô điều kiện.

### Lô D1/D2 — Palette và background contract (mỗi lô tối đa 5 file)

- D1 backend: analyzer giữ/cảnh báo màu nhấn, background candidate/confidence và fixture 0,25%.
- D2 frontend: “Đặt làm nền” loại màu khỏi palette, Undo/Redo và eyedropper.

Đóng §LR2.06 và §LR2.13.

### Lô E1/E2 — Nhận file và bảo vệ phiên (mỗi lô tối đa 5 file)

- E1: receiver Logo theo activeTabId; picker, DOM/native drop, nhiều tab và file path-backed.
- E2: dirty contract workspace → tab/app, save-success/fail và confirm close.

Đóng §LR2.07–08.

### Lô F — Shared release gate và phạm vi sản phẩm (tối đa 5 file)

- Một flag fail-closed ở backend/frontend, production API smoke và engine symbol smoke.
- Render limitations trước upload; sửa copy ảnh vải/chụp theo phạm vi artwork phẳng.

Đóng §LR2.10 và §LR2.12.

### Lô G1/G2 — Resilience, i18n và accessibility (mỗi lô tối đa 5 file)

- G1: validation crop/quad phía client, capabilities state machine và retry.
- G2: phủ catalog VI/EN, test tv(), button picker và live region.

Đóng §LR2.14–16.

### Lô H — Workspace QA trực quan (chia nhiều lô)

Thiết kế rồi triển khai zoom/pan/A-B/overlay, crop/quad handles, complexity panel; mỗi lô ≤5 file
và nghiệm thu Tauri thật. Đóng §LR2.09.

### Lô I — Kích thước in 1:1 (tối đa 5 file)

Schema/API nhận mm người dùng xác nhận; UI khóa tỷ lệ và coi DPI là gợi ý; mở artifact thật trong
ít nhất hai phần mềm chế bản. Đóng §LR2.11.

### Lô J — Round-trip PrynX sau GO

Thiết kế project artifact/importer và SVG allowlist theo §LR2.18. Đây là P3 roadmap, không chen
vào các lô blocker.

## 10. Cổng GO production

Chỉ mở Logo Rebuild production khi đồng thời đạt:

1. Loại nền giữ đúng counter/hole trên ring/O/P/R/B; raster alpha và corpus native đều xanh.
2. All-transparent trả 422, native không panic và health vẫn 200 sau request lỗi.
3. SVG rỗng bị reject; SVG quá phức tạp không thể ready im lặng.
4. Scheduler có queue/cancel/health an toàn; RAM budget theo concurrency và không phạt máy ≥16 GB.
5. Màu nhấn nhỏ không mất im lặng; background flow hoàn thành bằng thao tác rõ ràng.
6. Picker, DOM drop và Tauri native drop đều vào đúng active tab; tab nền/đã đóng không nhận file.
7. Đóng tab/app cảnh báo đúng khi editor/preview thay đổi chưa được lưu.
8. Có zoom/overlay và crop/quad trực quan; hình học sai bị chặn trước upload.
9. Capabilities lỗi có trạng thái terminal/retry; limitations hiện trước upload.
10. Backend/frontend dùng cùng release flag; production flag tắt fail-closed, flag bật có engine smoke.
11. Kích thước mm được xác nhận và SVG mở 1:1 trong ít nhất hai phần mềm chế bản.
12. English không trộn tiếng Việt; picker/status dùng được bằng bàn phím và screen reader.
13. Có ít nhất 3 logo thật kèm vector gốc làm holdout, không dùng chúng để tune preset.
14. Typecheck/vitest/pytest/cargo/release smoke xanh; bản cài sạch chạy offline.
15. Chủ dự án nghiệm thu runtime Home → nhận file → preview → hủy → lưu → mở artifact.

§LR2.18 round-trip là P3 roadmap và không phải điều kiện GO của bản export-SVG đầu tiên, trừ khi
scope phát hành quảng bá “dùng ngay trong PrynX”.

## 11. Kết quả Lô A và chốt duyệt tiếp

Lô A đã được chủ dự án duyệt và áp dụng trong đúng ba file sản phẩm/test:

- `backend/app/workers/logo_rebuild.py`: guard pixel nhìn thấy và mask compound background;
- `native/src/logo_vectorizer.rs`: guard alpha=0 + panic boundary Rust;
- `backend/tests/test_logo_rebuild.py`: regression route/health và compound counter.

Verify đã đạt:

- backend Logo + feature gate + entitlement: **35 passed**;
- Rust Logo: **8 passed**; `cargo check --locked` đạt;
- `rustfmt --check` riêng `logo_vectorizer.rs`, `py_compile` và `git diff --check` đạt;
- pipeline native thật: mask có mặt, tâm/góc trong suốt và vành đỏ giữ nguyên;
- extension PyO3 mới: alpha=0 trả `ValueError`; route thật trả HTTP 422, health kế tiếp 200;
- backend dev đang chạy vẫn trả `/health` 200.

`cargo fmt --check` toàn crate còn đỏ do nhiều file native/khuôn bế thay đổi song song đã lệch format;
file Rust của Lô A tự nó đạt `rustfmt --check`. Chưa nghiệm thu toàn workflow trong Tauri thật.

§LR2.01–02 được đóng; các finding từ §LR2.03 trở đi vẫn mở, nên tính năng tiếp tục **NO-GO
production và dev-only**. Đề nghị chỉ duyệt **Lô B — output-QC + preset JPEG/mono** sau khi xem kết
quả Lô A; không tự động triển khai lô tiếp theo.

## 12. Kết quả Lô B — output-QC, JPEG, topology rác và mono

Lô B được triển khai thành ba nhánh nhỏ, mỗi nhánh không vượt quá 5 file:

- **B1 backend:** `logo_svg_cleanup.py`, worker, schema, route và regression backend;
- **B2 frontend:** API client, workspace, test và catalog VI/EN;
- **B3 mono:** worker + regression polarity/empty-output.

### 12.1 Ảnh JPEG thật do chủ dự án cung cấp

Ảnh kiểm chứng:
`1784100103383_5435225431418698358_5435225431418698358_959171371f8abf7a17fbc6fb745cb97a.jpg`.
Palette xác nhận: `#0c7dc9`, `#ed1925`, `#fefefe`.

| Đường xử lý | Despeckle | Path | Node | Tiny path | SVG | Trạng thái |
|---|---:|---:|---:|---:|---:|---|
| Trước Lô B | 4 | 2.894 | 54.145 | chưa QC | 1.341.149 B | luôn ready |
| B1, preset chung | 8 | 433 | 17.389 | 289 (66,74%) | 508.896 B | review |
| B2 cũ, Stacked + JPEG 16 | 16 | 114 | 7.409 | 12 (10,53%) | 245.752 B | **bị user bác: còn rác, mất dấu** |
| B2 sửa lại, Cutout + JPEG smoothing 1 | **4** | **87** | **2.688** | **11 (12,64%)** | **95.681 B** | ready, chờ user duyệt hình |

Nghiệm thu lần đầu đã bác preset 16: giảm path bằng cách xóa mảng nhỏ làm mất dấu rời của `Ệ`, `À`, `Ố`,
`Ồ`, `Í`, trong khi topology Stacked vẫn giữ các lớp chồng. Hướng này không được coi là bản sửa đạt.

Bản sửa lại chuyển chính VTracer từ `Hierarchical::Stacked` sang `Hierarchical::Cutout` cho fixed palette.
Vì các vùng màu không còn chồng lớp, có thể trả despeckle về 4 để giữ dấu. So với baseline, Cutout +
smoothing 1 giảm **97,0% path**, **95,0% node** và **92,9% dung lượng SVG**. Kiểm hình học 87 path không
có cặp nào chồng diện tích quá 0,05 px². A/B crop cho thấy các dấu
tiếng Việt xuất hiện lại; vẫn phải chờ chủ dự án duyệt artifact thật. Không có vector gốc của logo khách
nên số này không thay cho phép đo ground truth.

Artifact qua đúng worker + extension mới nằm tại `tmp/prynx_user_logo_product_cutout.svg`; ảnh render và
crop A/B nằm cùng thư mục.

### 12.2 Cơ chế dọn topology

- Fixed palette dùng `Hierarchical::Cutout`: mỗi vùng màu nhìn thấy là một miền không chồng lớp; không còn
  khối tổng bên dưới cộng hàng nghìn mảng con phía trên như Stacked.
- Chỉ xét path rất nhỏ theo tỷ lệ diện tích khung, không xóa chỉ vì kích thước.
- Duyệt ngược các lớp giao nhau; path chỉ bị xóa khi ít nhất 99,5% diện tích nhìn thấy đã là cùng màu.
- Nếu có lớp màu khác chen giữa, path khôi phục màu được giữ.
- Không union/difference toàn artwork; chỉ thao tác vùng candidate nhỏ qua STRtree nên tránh lỗi topology và
  thời gian 67 giây của prototype union toàn cảnh.
- Compound counter/hole được giữ nguyên; lỗi số học ở một path làm hệ thống giữ path đó, không xóa đoán.

### 12.3 Output-QC và giao diện

- API trả `ready | review | rejected`, complexity có path/drawable/node/tiny/byte/path đã dọn cùng
  reason/action có kiểu.
- SVG không có mảng drawable hoặc vượt bounds bị `rejected`; SVG quá nhiều path/node/tiny/byte bị `review`.
- Giao diện không tạo preview giả cho `rejected`; `review` khóa tải SVG cho tới khi người dùng xác nhận đã
  kiểm tra. Số path, node và mảng dư đã dọn được hiển thị cạnh preview.
- Preset sửa lại: JPEG smoothing 1 + despeckle 4; PNG/WebP smoothing 0 + despeckle 4. Khi ảnh được resize,
  despeckle được quy đổi theo hệ số chiều dài
  (`sqrt` của tỷ lệ diện tích), đúng hợp đồng VTracer vì engine tự bình phương cạnh thành diện tích lọc.

### 12.4 Mono

Mono dùng Otsu để tách hai lớp rồi lấy lớp chiếm đa số trên viền ảnh làm nền. Logo vàng trên nền trắng và
logo trắng trên nền tối đều được chuẩn hóa về mực đen/nền trắng trước VTracer. Ảnh phẳng/không sinh drawable
trả `rejected`, không còn `ready` với SVG 108 byte rỗng.

### 12.5 Verify

- Backend Logo + feature gate + entitlement: **43 passed**.
- Frontend Logo workspace: **12 passed**.
- `tsc --noEmit`, ESLint hẹp, `py_compile` và `git diff --check`: đạt.
- Ảnh JPEG thật qua worker + extension Cutout mới: **ready**, 87 path / 2.688 node / 95.681 byte;
  0 cặp path chồng diện tích >0,05 px².
- Rust Logo: **8 passed**; `cargo check --locked` và `rustfmt --check logo_vectorizer.rs` đạt.

§LR2.03 được mở lại cho tới khi chủ dự án duyệt artifact Cutout; §LR2.04 đã đóng ở phạm vi
code/unit/integration. Tính năng vẫn chưa đạt GO
production toàn cục vì các cổng còn lại của mục 10 (scheduler, nhận file nhiều tab, dirty-session, release
flag, QA Tauri/Illustrator/CorelDRAW và holdout có vector gốc) chưa hoàn tất.
