# BÁO CÁO AUDIT NỀN TẢNG — ỨNG VIÊN CHUYỂN SANG RUST NATIVE

**Ngày:** 2026-08-29
**Mốc code:** `8bc0a21`, branch `codex/pre-release-audit-2026-08-04`
**Máy đo:** Windows, 31,77 GB RAM, 16 CPU logic (cùng máy với các audit hiệu năng trước)
**Trạng thái:** Chốt 1 — khảo sát, đo, đề xuất. **CHƯA SỬA GÌ — chờ duyệt danh sách.**

> Câu hỏi của chủ dự án: "audit đánh giá nền tảng hiện tại của PrynX, xem có phần nào có thể chuyển sang Rust native để tối ưu hiệu năng và sức mạnh phần mềm không."

---

## 1. Kết luận điều hành

**Phần nặng đã ở Rust rồi.** Kiểm kê cho thấy 2,84 MB mã Rust đã phủ đúng những chỗ đáng phủ: raster + mực + ICC + font + shading (`print_engine`, ~1,1 MB), nesting true-shape với kernel Clipper2 (`imposition_core/mixed_nesting`, ~285 KB), vector hóa logo v2 (`native/src/logo_engine`), ghép ảnh → PDF (`combine_image_pdf.rs`), solver bình bài (grid/sticker/shape). Phần Python còn lại phần lớn **không phải** ứng viên: nó bị chặn bởi qpdf/pikepdf, OpenCV hoặc GEOS — tức chi phí đã nằm trong mã native, viết lại bằng Rust lợi rất ít.

**Ngoại lệ lớn: engine khuôn bế.** Đây là engine tính toán duy nhất của sản phẩm chưa hề ở Rust, và nó chưa ở Rust theo một cách không lộ ra khi đọc cây thư mục: `native/src/dieline_engine.rs` **không phải engine Rust** — nó là một *host Boa* (JS interpreter thuần Rust, không JIT) nạp và `eval` chính bundle TypeScript của `desktop/src/lib/dieline`. Toàn bộ hình học khuôn bế và nesting khuôn chạy bằng JavaScript được thông dịch.

Đo trên **cùng một bundle, cùng một request**: Boa chậm hơn V8 (Node 24) **48×** ở ca nesting điển hình và **119×** ở ca 104 khuôn/tờ. Kết quả JSON **byte-identical** giữa hai engine, nên đây thuần là chi phí hiệu năng, không phải lệch parity.

Nghiêm trọng hơn dự đoán ban đầu: ca đắt nhất **là đường tương tác**, không phải đường xuất file. `setNestingConfig` (`useBoxStore.ts:283-291`) gửi `includeNesting: true`, và nó nối vào **26 control** trong `NestingPanel.tsx` — gồm cả `onChange` của các input số khổ tờ, lề, `dieGap`, gripper. Mỗi lần gõ/kéo là một lượt nesting 97–380 ms, debounce chỉ 70 ms, và **mọi request khuôn bế của toàn app nối đuôi trên một thread duy nhất** (`dieline.py:22`, `ThreadPoolExecutor(max_workers=1)`, buộc phải vậy vì context Boa là `thread_local` + `Box::leak`).

**Điều quan trọng về thứ tự sửa:** phần lớn triệu chứng người dùng thấy được có thể xử lý **không cần viết một dòng Rust nào** — chỉ cần đừng chạy nesting 26 lần trên mỗi lượt gõ. Port sang Rust là bước hai, và chỉ cần port *kernel hình học* (~4 hàm), không phải cả engine.

### Bảng xếp hạng ứng viên

| # | Ứng viên | Bằng chứng | Mức | Effort | Kết luận |
|---|---|---|---:|---|---|
| 1 | Kernel nesting khuôn bế (`nestingEngine.ts` trong Boa) | **Đo: 48–119× chậm hơn V8**; đường tương tác 97–380 ms | P1 | L | **Có** — nhưng làm quick-win trước |
| 2 | Tokenizer content stream `channel_remover` | **Đo: 1,39–1,48 MiB/s**, qpdf C++ 7,03–8,62 MiB/s trên cùng dữ liệu | P2 | M | **Có** — Rust là đường duy nhất (xem §RS.02) |
| 3 | argmin ΔE trên LUT `channel_remover` | **Đo: 1,41 ms/màu ở mặc định; 21,38 ms/màu ở `grid_step=2`** | P2 | S | **Không cần Rust** — `np.argmin` giải xong |
| 4 | `pont_collision` O(N²) Shapely | Chỉ bằng chứng in-code (30 s, 961×); **chưa đo đợt này** | P2 | M | Phải đo trước khi quyết |
| 5 | Lấy mẫu Bézier `shape_classifier` | **Đo: 1,57–1,60 M điểm/s** → 1.000 cung = 9,6 ms | P3 | — | **HẠ** — không đáng port |
| 6 | 4 symbol Rust/Python chết (0 caller) | grep xác nhận | P3 | S | Xoá, không phải cơ hội tăng tốc |

---

## 2. Phạm vi, phương pháp, và những gì KHÔNG audit lại

### Đã đọc trước khi phán

- `prynx-architecture`, `prynx-performance`, `prynx-audit-workflow` (SKILL.md)
- `PRYNX_MASTER_AUDIT_MATRIX.md` — trạng thái W1–W8
- `KE_HOACH_ENGINE_PRYNX_THAY_THE_PDFIUM_2026-08-09.md` — Gate 0 → Lô 7 đã xong, Lô 8 chưa bắt đầu, Viewer default vẫn `current` (PDFium)
- `PPE_CURRENT_STATE.md` (SSOT), `DEFERRED_FEATURES.md`
- `BAO_CAO_AUDIT_HIEU_NANG_TOAN_DIEN_2026-08-13.md` (§P25.1–5) và `BAO_CAO_RE_AUDIT_HIEU_NANG_LO_P_A_2026-08-13.md` (§PA.R1–R6)

### KHÔNG audit lại

- **§P25.1–P25.4 và §PA.R1–R6** (So sánh PDF đa lõi, trần 50 trang, locale EN, import diet sidecar) — đã có chủ quản, đang mở. Báo cáo này không lặp và không đổi kết luận của chúng.
- **Kế hoạch thay PDFium bằng PPE ở Viewer** — đã là một lộ trình riêng đã duyệt, đang ở Lô 8. Việc "chuyển render sang Rust" **đã được trả lời** ở đó.
- Không chạy full build, không build installer, không đo máy vật lý 8/16 GB.

### Mở lại một finding đã đóng — có lý do

Audit `2026-08-13` mục 6 ghi **"[DISPROVED] Nesting engine TS chậm"**, căn cứ: *"kiểm tra cấu trúc `nestingEngine.ts` — vòng lặp theo số khuôn trên tờ (hàng chục phần tử) … không có bằng chứng chậm ở quy mô thật"*.

Kết luận đó đúng **về cấu trúc thuật toán** và tôi không phản đối phần đó: hằng số thuật toán nhỏ, vòng O(n²) trên hàng chục phần tử là hợp lý. Nhưng nó đánh giá *thuật toán* mà không xét *môi trường thực thi*: code này không chạy trong WebView (V8) như tên file gợi ý, mà chạy trong Boa. Báo cáo này mở lại finding bằng **số đo mới trên đúng bundle production**, không bằng suy luận — đúng điều kiện mà `prynx-audit-workflow` §1.4 đòi.

### Bằng chứng mới tạo trong đợt này

Harness nằm ở `tmp/bench_boa/` (thư mục `tmp/` bị gitignore). Xem §8 để tái lập.

| Phép đo | Công cụ | Vì sao hợp lệ |
|---|---|---|
| Boa vs V8 trên engine khuôn bế | `tmp/bench_boa/src/main.rs` (boa_engine 0.21.1, `default-features = false` — **khớp `native/Cargo.toml:27`**) + `bench_node.mjs` | Nạp **đúng** `native/src/generated/dieline_engine.bundle.js` và gọi `__prynxGenerateDieline(json)` **đúng cách** `dieline_engine.rs::run_engine` làm: eval bundle một lần, sau đó gọi nhiều lần trên cùng `Context` |
| Đối chiếu output Boa ↔ V8 | `dump_node.mjs` + tham số dump của harness Rust | Loại giả thuyết lệch parity trước khi kết luận về hiệu năng |
| Tokenizer Python vs qpdf | `tmp/bench_boa/bench_tokenizer.py` | Chạy `ContentStreamTransformer.transform` production và `pikepdf.parse_content_stream` trên **cùng bytes** |
| LUT argmin + Bézier | `tmp/bench_boa/bench_py_hot.py` | Gọi trực tiếp `ReSeparationEngine.best_kept_only` và `_sample_bezier_contour` production |

**Giới hạn của số đo, ghi rõ để không bị dùng quá tay:**

1. Harness Boa gọi Boa **trực tiếp**, không qua PyO3 → HTTP → FastAPI. Đường thật chỉ có thể **bằng hoặc chậm hơn**, không nhanh hơn.
2. Tôi không gọi được qua Python: `.pyd` build bằng `maturin develop --release` nên `cfg!(debug_assertions)` tắt, đường bypass `DEV_MODE` trong `dieline_license.rs:49` không còn hiệu lực. Xác nhận bằng lỗi thật: `Dieline entitlement credentials are required`.
3. Đã kiểm phản biện "harness không build như production": chạy lại với `CARGO_PROFILE_RELEASE_LTO=thin` + `CODEGEN_UNITS=1` + `RUSTFLAGS=-C target-cpu=x86-64-v2` (đúng `build_production.ps1:734-736`) → `nest_grid` cho 51,0 / 52,8 / 61,8 ms qua 3 lượt, **không khác** bản `--release` thường (53–54 ms). Lượt đầu ra 85,5 ms là nhiễu do máy vừa xong rebuild.
4. Node 24 (V8) là **mốc đối chứng**, không phải đích đề xuất. Rust thật sẽ nhanh hơn V8 nữa, nhưng con số đó **chưa đo** và tôi không suy diễn.

---

## 3. Kiểm kê hiện trạng — cái gì ĐÃ ở Rust

Bốn crate, không có root workspace `Cargo.toml`. **Không crate nào có `[profile.release]`** — tuân thủ quy tắc bất di bất dịch #2; LTO chỉ qua env trong `build_production.ps1:734-736`.

| Crate | Loại | Kích thước src | Trách nhiệm | Chính sách |
|---|---|---:|---|---|
| `print_engine/` | `rlib`, thuần Rust | ~1,1 MB | PPE: thông dịch content stream (`content/interp.rs` 196 KB), không gian mực n-kênh (`ink.rs` 120 KB), ICC/ColorSpace (121 KB), codec ảnh (100 KB), font (76 KB), shading 1–7 (58 KB) | **Fail-closed** qua `core/print_engine/facade.py`; không có fallback Python |
| `imposition_core/` | `rlib`, thuần Rust | ~430 KB | `mixed_nesting/` (~285 KB): normalize → kernel fixed-point Clipper2 → NFP → multi-start + refine → validate. Cộng grid/sticker/shape/orchestrator (~144 KB) | Fail-closed (`mixed_nesting_service.py:8-11`: *"Tuyệt đối không fallback"*) |
| `native/` | `cdylib` PyO3 | ~640 KB | Crate **duy nhất** có `pyo3`. 52 symbol export. Chứa `combine_image_pdf.rs` (89 KB, `lopdf`), `logo_engine/` (~300 KB), `print_engine_py.rs` (facade PPE), `mixed_nesting_py.rs` | Hỗn hợp — xem §RS.06 |
| `desktop/src-tauri/` | `rlib` `app_lib` | ~770 KB | 57 Tauri command; `lib.rs` 309 KB (7.055 dòng); `pdf_engine/render_worker.rs` 172 KB là file **duy nhất** `use print_engine::` | — |

Đồ thị phụ thuộc: `imposition_core` và `print_engine` là lá; `native/` phụ thuộc cả hai; `src-tauri` chỉ phụ thuộc `print_engine`.

**Nhận xét:** biên Rust hiện tại đặt đúng chỗ về mặt kiến trúc. Vấn đề không phải "thiếu Rust" mà là **hai chỗ lệch**: một engine tính toán bị bỏ ngoài (khuôn bế, §RS.01) và một số hợp đồng Rust đã có nhưng không ai dùng (§RS.05).

---

## 4. Phát hiện — có bằng chứng, chờ duyệt

### §RS.01 — [CONFIRMED] P1 / L — Engine khuôn bế chạy trong JS interpreter; đường tương tác chạm 380 ms và tỉ số chậm tăng theo số khuôn/tờ

**Kiến trúc (bằng chứng mã):**

- `native/src/dieline_engine.rs:3` `use boa_engine::{Context, Source}`; `:15` `include_str!(concat!(env!("OUT_DIR"), "/dieline_payload.txt"))`
- `native/build.rs:29` — payload sinh từ `native/src/generated/dieline_engine.bundle.js`
- `desktop/vite.dieline.config.ts:9` — bundle đó build từ `src/lib/dieline/sidecarEntry.ts`, format IIFE
- `desktop/src/lib/dieline/sidecarEntry.ts` — gắn `globalThis.__prynxGenerateDieline`
- `dieline_engine.rs:105-116` — `ENGINE_CONTEXT` là `thread_local` + `Box::leak` (chú thích trong mã giải thích: tránh race khi teardown GC heap của boa)
- `backend/app/api/routes/dieline.py:22` — `ThreadPoolExecutor(max_workers=1, thread_name_prefix="prynx-dieline")`, buộc phải vậy vì context không `Send`

Nghĩa là: `native/src/dieline_engine.rs` chứa **không một phép hình học nào**. Nó chỉ giải mã AES-GCM payload theo claim `rk` của license, rồi eval JS. Hình học nằm ở 78 file TS trong `desktop/src/lib/dieline/` (`nestingEngine.ts` 63,5 KB, `HangingWindowBox.ts` 50,4 KB, `PizzaBox.ts` 47,4 KB, `GableBox.ts` 46,6 KB, `contourValidator.ts` 34,8 KB…).

**Số đo — cùng bundle, cùng request, cùng máy:**

| Ca | Node 24 (V8, JIT) | Boa (interpreter) | Tỉ số |
|---|---:|---:|---:|
| `eval` bundle (một lần, warmup) | 3,3 ms | 86–98 ms | ~27× |
| Preview (`includeNesting: false`) | 0,5 ms | 6,1 ms | 12× |
| Nesting `grid` | 1,1 ms | 53–54 ms | ~48× |
| Nesting `smart` | 1,4 ms | 65,6 ms | 47× |

**Đường cong theo số khuôn/tờ** (tờ 1090×1450, `nestingMode: smart`, thu nhỏ khuôn dần):

| Khuôn/tờ | Node | Boa | Tỉ số |
|---:|---:|---:|---:|
| 12 | 1,8 ms | 97,2 ms | 54× |
| 20 | 2,0 ms | 117,0 ms | 58× |
| 40 | 2,1 ms | 151,7 ms | 72× |
| 63 | 2,9 ms | 240,8 ms | 83× |
| 104 | 3,2 ms | **380,1 ms** | **119×** |

Node gần như phẳng (1,8 → 3,2 ms) trong khi Boa tăng 4× (97 → 380 ms). Đây chính là vòng O(n²) của `layoutHasCollision` (`nestingEngine.ts:723-743`) bị trả giá ở tốc độ interpreter: hằng số thuật toán nhỏ, nhưng hằng số *mỗi phép* lớn gấp trăm lần.

**Vì sao đây là đường tương tác (phần nâng mức nghiêm trọng):**

`useBoxStore.ts:283-291` — `setNestingConfig` gọi `scheduleGeneration(set, get, { includeNesting: true })`. `scheduleGeneration` mặc định `delayMs = 70` (`useBoxStore.ts:72`). `setNestingConfig` được nối vào **26 chỗ** trong `NestingPanel.tsx`, trong đó có `onChange` của input số:

khổ tờ rộng `:121`/`:126`, cao `:144`/`:149`; `sleeveSheet` `:195`/`:200`/`:218`/`:223`; `gripperMargin` `:258`; `dieGap` `:274`; lề trên/dưới/trái/phải `:295`/`:310`/`:324`/`:338`; preset tờ `:32`/`:174`; `nestingMode` grid/smart `:52`/`:58`; `trayNestingMode` `:72`/`:78`; toggle gripper `:240`; `rotation` `:357`; hướng tờ `:372`/`:378`.

Với 104 khuôn/tờ: mỗi lượt gõ một chữ số vào ô `dieGap` sinh một job 380 ms, debounce 70 ms, nối đuôi một thread. Hàng đợi tụt hậu khoảng 5×.

**Đã loại giả thuyết lệch parity:** dump kết quả từ cả hai engine trên `req_nest_grid` — **byte-identical** (21.942 ký tự, JSON deep-equal, cả 662 số thập phân trùng khớp). Chênh 87 "byte" tôi thấy lúc đầu là do so byte UTF-8 (`s.len()` phía Rust) với số ký tự UTF-16 (`.length` phía JS) — **không phải finding**, đã loại.

**Ghi chú về `nativeFixtureParity.test.ts`:** test này không kiểm parity hình học (không cần — một bản mã, hai môi trường); nó chỉ chốt fixture request có cùng tập khoá với `DEFAULT_PARAMS`. Golden master và regression test chạy trong Vitest (Node/V8), tức **cùng mã nhưng khác engine so với production**. Số đo ở trên cho thấy output trùng khớp, nên hiện tại đây chưa phải rủi ro — nhưng nếu bao giờ port kernel sang Rust thì đúng đây là chỗ phải dựng oracle parity thật.

**Đề xuất — ba lựa chọn, đề nghị làm theo thứ tự:**

**(a) Đừng chạy việc đó 26 lần — S, không cần Rust.** Tách nesting khỏi debounce chung: control nesting dùng debounce dài hơn (hoặc chỉ chạy khi input `onBlur`/commit thay vì mỗi `onChange`), và/hoặc tách nesting thành request riêng khỏi `generate`. Đây là nơi thu được phần lớn cảm nhận người dùng với blast radius nhỏ nhất. **Làm cái này trước, rồi đo lại** — có thể sau đó (b) không còn cần thiết ở mức P1.

**(b) Port kernel hình học sang Rust, giữ chiến lược ở TS — M.** Boa cho phép đăng ký native function. Đăng ký một hàm host duy nhất nhận **cả mảng** vị trí (một lần vượt biên cho mỗi chiến lược ứng viên, **không** phải mỗi cặp — vượt biên trong vòng O(n²) sẽ phản tác dụng), rồi tính bên Rust. Bốn hàm đáng chuyển, đều là hình học thuần không mang nghiệp vụ hộp:

- `layoutHasCollision` `nestingEngine.ts:723-743`
- `isSelfIntersecting` `:116-134`
- `offsetPolygon` + `miterOffset` `:231-286` / `:166-229`
- `convexHull` `:136-164`

`imposition_core` **đã có** hạ tầng cần thiết: kernel fixed-point Clipper2, NFP, collision, spatial index. Đây là tái dùng, không phải viết mới.

Giữ nguyên ở TS: `calcSLBInterlock`, `calcEnvelopeInterlock`, `calcPizzaInterlock`, `calcSmart`, `calcProfileInterlock` — đó là logic nghiệp vụ theo loại hộp, port sang Rust sẽ đụng golden master (`__snapshots__/regression.test.ts.snap` một mình 558 KB) mà lợi ít.

**(c) Không đề xuất:** thay Boa bằng V8 (`rusty_v8`) — thêm ~40 MB vào installer đang ~461–486 MB, và mất tính chất "binary không chứa mã engine" mà `dieline_engine.rs:9-13` xây có chủ đích cho chống crack.

**Ghi chú phụ (không thuộc phạm vi lô này):** `desktop/src/lib/mockup3d/foldLive.ts` **rỗng trên đĩa** dù vẫn được tham chiếu (`SolidPanelMesh.tsx:769`, và `useFrame` ở `:838` đọc `foldLive.version`). Chưa xác định là file bị xoá nội dung hay lỗi đồng bộ worktree. Cần kiểm riêng — nếu thật rỗng thì đường animation gập đang dựa vào một module trống.

---

### §RS.02 — [CONFIRMED] P2 / M — Tokenizer content stream của `channel_remover` là lexer Python duyệt từng byte, thông lượng 1,4 MiB/s

**Bằng chứng mã:** `ContentStreamTransformer.transform` (`channel_remover.py:888`, vòng chính từ `:928`) tự viết lexer PDF, **không** dùng `pikepdf.parse_content_stream` (grep 0 match trong file). Mỗi byte đi qua một vòng interpreter Python: `while i < n: c = data[i:i+1]` — mỗi lần cắt tạo một object `bytes` mới. Có `while` lồng riêng cho comment `:936-939`, literal string `:941-955`, hex string `:957-968`, `/Name` `:975-982`, token `:984-989`, inline image `:1008-1018`. Đường phân loại **số** là `try: float(tok) / except ValueError` — tức mọi toán tử (không phải số) đều đi qua một exception.

**Số đo** (so với lexer C++ qpdf qua `pikepdf.parse_content_stream` trên **cùng bytes**):

| Content stream | Lexer Python | qpdf (C++) | Tỉ số |
|---|---|---|---:|
| 2.000 op / 372,8 KiB | 245,4 ms — **1,48 MiB/s** | 42,2 ms — 8,62 MiB/s | 5,8× |
| 10.000 op / 1.868,5 KiB | 1.312,3 ms — **1,39 MiB/s** | 259,5 ms — 7,03 MiB/s | 5,1× |

**So sánh này thiên vị phía Python theo hướng có lợi cho nó**, và tôi ghi rõ để không bị dùng quá tay: phía Python còn làm cả phép biến đổi màu (4.000 và 20.000 `ColorHit`), còn qpdf chỉ tokenize. Con số dùng được là **trần thông lượng 1,4 MiB/s**, không phải tỉ số 5×.

**Vì sao "chuyển sang pikepdf" KHÔNG phải cách sửa:** lexer này viết tay **có chủ đích**. Nó thu `edits: list[tuple[int, int, bytes]]` theo **khoảng byte** (`num_operands` giữ `(value, start, end)`) để ghép lại content stream chỉ thay đúng những byte của toán hạng màu, giữ nguyên tuyệt đối phần còn lại. `parse_content_stream` + `unparse_content_stream` sẽ **ghi lại toàn bộ** stream — đúng thứ mà kiến trúc an toàn màu của dự án tránh. Nên ở đây Rust là đường duy nhất giữ được cả tốc độ lẫn tính chất byte-minimal.

**Trạng thái hiện tại:** 0 tag `PERF`, 0 song song hóa, 0 lời gọi Rust trong cả file.

**Chưa đo:** kích thước content stream thật của file khách bao bì. 1,4 MiB/s nghĩa là một stream 5 MB mất ~3,6 s/trang đơn luồng. Cần đo trên corpus thật để xếp đúng mức trước khi bỏ effort M.

---

### §RS.03 — [CONFIRMED] P2 / S — argmin ΔE trên LUT là vòng Python; sửa bằng numpy, KHÔNG cần Rust

**Bằng chứng mã:** `ReSeparationEngine.best_kept_only` (`channel_remover.py:396`), vòng `:405-412`:

```python
for cmyk, lab in lut:
    delta_e = self.delta_e_cie76(target_lab, lab)
```

`delta_e_cie76` (`:286`) là toán scalar. Không numpy, không KD-tree. Kích thước LUT do `_build_lut` `:358` quyết định: `product(grid, repeat=len(kept_indices))` `:375-376`. Hàm được gọi **một lần cho mỗi màu phân biệt** trong tài liệu.

**Số đo** (`kept_channels=("C","M","Y")`):

| `grid_step` | LUT | Dựng LUT | argmin/màu | 500 màu phân biệt |
|---|---:|---:|---:|---:|
| 10,0 | 1.331 điểm | 29,6 ms | 0,23 ms | 0,11 s |
| **5,0 (mặc định)** | 9.261 điểm | 38,6 ms | **1,41 ms** | **0,70 s** |
| 2,0 | 132.651 điểm | 301,7 ms | **21,38 ms** | **10,69 s** |

**Kết luận:** ở mặc định đây là P2 nhẹ. Vách đá ở `grid_step=2` là thật nhưng chỉ chạm khi người dùng hạ bước lưới. Và **không cần Rust**: LUT là mảng cố định đã cache (`_LUT_CACHE`), phần *dựng* đã batch native qua `_to_lab_batch` `:319`; chỉ phần *tìm* là Python. Chuyển sang `np.argmin` trên mảng Lab (N×3) là một thay đổi nhỏ, cùng kết quả, và giữ được quy tắc chọn ứng viên đầu tiên khi đồng ΔE (dùng `argmin` vốn trả index nhỏ nhất). Effort S, blast radius một hàm.

---

### §RS.04 — [CONFIRMED] P2 / M — `pont_collision` gọi Shapely O(N²) từ vòng Python sâu tới 4 tầng; **chưa có số đo mới**

**Bằng chứng mã:** `backend/app/workers/pont_collision.py` — 23 lời gọi Shapely, **0 numpy**, **0 tag PERF**, không song song hóa.

- `detect_collisions` `:288-320` — depth 2 (`items × zones`), mỗi lượt `translate` + `intersects` + `intersection().area`
- `check_internal_collision` `:349-381` — depth 2; docstring `:349-351` ghi nguyên văn: *"trước đây dựng lại 961× gây O(N²) Shapely → 30s"*
- `_try_local_pair_flips` `:920-949` — **depth 4** tại `:935-936`; mỗi vòng gọi lại `detect_collisions` (bản thân đã O(items×zones)) + `_creates_sticker_overlap` (O(N))
- `_has_any_sticker_overlap` `:968-980` — depth 2, N²/2 đầy đủ; docstring tự nhận *"O(N²) chấp nhận được"* vì chỉ chạy một lần
- `apply_shift` `:337-347` — comment ghi *"apply_shift bị gọi tới 961×/hàng"*

**Tôi KHÔNG đo được trong đợt này** vì cần fixture placement tem thật (số tem/tờ, hình polygon thật, vùng cấm ốc/pont thật) — dựng dữ liệu giả sẽ cho số vô nghĩa. Bằng chứng hiện có chỉ là số đã ghi trong chính mã nguồn từ đợt sửa trước.

**Vì vậy tôi để P2 và ghi rõ là chưa nghiệm thu.** Bước đúng: đo trước trên một job tem bế thật, rồi mới quyết Rust. Lưu ý sẵn: mẫu ở đây là "vòng Python, thân GEOS", nên nếu N thật chỉ hàng trăm thì phần lớn thời gian nằm trong GEOS (C++) và Rust chỉ ăn phần điều phối — lợi ít hơn vẻ ngoài. Ngược lại nếu N lên hàng nghìn thì tổng số predicate mới là vấn đề, và lúc đó câu trả lời có thể là **spatial index** (`imposition_core/src/mixed_nesting/spatial.rs` đã có) chứ không phải viết lại từng phép.

---

### §RS.05 — [CONFIRMED] P3 / S — Bốn hợp đồng đã port nhưng 0 caller

Đây **không** phải cơ hội tăng tốc. Ghi vào đây vì nó nằm đúng trên biên Rust/Python và là nợ bảo trì cộng bề mặt tấn công (mọi symbol PyO3 export ra đều gọi được từ Python).

| Symbol | Nơi định nghĩa | Bằng chứng chết |
|---|---|---|
| `NfpSolver` (class) | `native/src/nfp_solver.rs` + `imposition_core/src/nfp.rs`, đăng ký `native/src/lib.rs:172` | grep `NfpSolver` trên `backend/`, `desktop/src/`, `scripts/` → **0 kết quả** |
| `set_ocg_visibility` (Rust) | `native/src/lib.rs:33`, `layers.rs` | 0 caller. Các hit `set_ocg_visibility` trong `edit.py:1033`/`:1307`, `edit_session.py:962` là **hàm Python của `edit_session`, trùng tên**, không liên quan |
| `get_ocg_layers` (Rust) | `native/src/lib.rs:32` | `rust_bridge.py:241` — comment tường minh *"Always use pikepdf for OCG listing"*; đường Rust không bao giờ chạy |
| `solve_nfp_layout` (Python) | `backend/app/workers/sticker_imposer_pkg/nfp_placer.py:24` | Chỉ tự tham chiếu trong cùng file (`:24`/`:41`/`:56`/`:95`/`:103`) |

Nesting thật đi đường `MixedNestingRun` → `imposition_core/src/mixed_nesting/*`. `native/src/lib.rs:10-12` ghi rõ hai nhánh này **độc lập, không gọi lẫn nhau**.

**Đề xuất:** xoá cả bốn, hoặc nếu muốn giữ `NfpSolver` làm điểm mở rộng thì ghi lý do vào comment và thêm test khoá — hiện tại nó không có cả hai.

---

### §RS.06 — [CONFIRMED] P2 / S — Fallback Python trong `rust_bridge` đổi **ngữ nghĩa**, không chỉ chậm hơn

Không phải finding hiệu năng, nhưng nằm đúng trên biên Rust/Python nên thuộc phạm vi audit này.

`backend/app/core/rust_bridge.py` — 6 hàm, mẫu chung `try Rust → except Exception → logger.warning → Python`. Rust ở đây là **fast path tuỳ chọn**, Python là đường đảm bảo. Vấn đề: ba fallback **không tương đương** đường Rust.

| Hàm | Fallback làm gì khác |
|---|---|
| `_fallback_delete_objects` `:181` | **Xoá TẤT CẢ ảnh XObject, bỏ qua hoàn toàn `indices`** — ngữ nghĩa khác hẳn "xoá object thứ i" |
| `_fallback_get_objects` `:73` | Dùng **MediaBox** làm bbox cho mọi ảnh → mất bbox thật (đúng lỗi mà `pdf-object-edit` đã đi sửa) |
| `_fallback_render_svg` `:145` | Render raster rồi nhúng base64 vào `<image>` → **mất hoàn toàn vector**, dù hàm tên là `render_page_svg` |

Vì mọi nhánh `except Exception` (`:68`, `:141`, `:176`, `:216`) nuốt lỗi và chỉ `logger.warning`, một lần Rust hỏng sẽ **âm thầm** đổi hành vi thay vì báo lỗi. Đối chiếu: `imposition_rust_policy.require_rust()` và `print_engine/facade.py` đều **fail-closed** — `rust_bridge` là chỗ duy nhất còn fail-open.

**Đề xuất:** hoặc cho `rust_bridge` fail-closed như hai chỗ kia (nhất quán chính sách), hoặc giữ fallback nhưng bắt buộc surface cảnh báo lên caller và cấm fallback ở các đường ghi. Cần quyết định sản phẩm, không phải sửa cơ học.

---

## 5. Nghi vấn đã triage — KHÔNG phải ứng viên, không được "tối ưu"

1. **[HẠ CẤP bằng số đo] Lấy mẫu Bézier `shape_classifier`.** Ban đầu tôi xếp đây là ứng viên (Python thuần, 0 numpy, 0 cv2, 0 tag PERF, port từ JSX, mật độ 1 mẫu/3 pt cung). Đo xong: `_sample_bezier_contour` chạy **1,57–1,60 M điểm/s** — 200 cung → 3.000 điểm mất 1,88 ms; 1.000 cung → 15.000 điểm mất 9,58 ms. Khuôn bao bì thật nằm trong khoảng đó, tức 2–10 ms. **Không đáng port.**
2. **[EXPECTED] `image_comparator`, `comparison_engine`, `sticker_source_pipeline`, `logo_rebuild`.** Đã vectorized bằng OpenCV/NumPy; `image_comparator` **đã gọi Rust** (`fast_diff_mask_gray` tại `:575`, `:1319`, `:1615`). `comparison_engine` có 13 tag PERF và comment `:1552-1555` ghi số đo: compare + encode = 66% + 4,8% thời gian job, đã nằm trong mã native. Cách tăng tốc ở đây là song song hóa (§P25.1, đã có chủ quản), **không** phải viết lại.
3. **[EXPECTED] `pdf_actions_native.py`.** 263 lời gọi pikepdf/qpdf. Các vòng depth 3–4 là **duyệt đồ thị object PDF**, không phải số học; chi phí nằm trong qpdf/zlib và mọi vòng đều phải qua biên pikepdf. Rust lợi rất ít.
4. **[EXPECTED] `sticker_engine.py`.** Vòng sâu nhất repo (depth 5 tại `:2748-2760`), nhưng 30 tag PERF cho thấy công việc O(n²) đã được đẩy vào GEOS — đặc biệt phép Hausdorff đã thay bằng bất đẳng thức tam giác + `buffer`/`covers`, lặp lại ở 5 chỗ. Đã có `ProcessPoolExecutor` `:11610` + cap worker theo RAM `:11695`.
5. **[EXPECTED] `mockup3d/panelSolid.ts`.** `tryBuildWatertight` `:259-283` lặp 5 góc × `ExtrudeGeometry` + `isWatertight` cho mỗi panel, nhưng bọc `useMemo` nên chỉ dựng lại khi tham số hộp/độ dày đổi — **không** chạy mỗi frame. `useFrame` (`SolidPanelMesh.tsx:838`) có chốt bỏ qua theo `version`. Đã có 3 tag PERF §DT3D-004.
6. **[EXPECTED] `print_engine`, `imposition_core/mixed_nesting`, `logo_engine`.** Đã là Rust. Không có gì để chuyển.
7. **[EXPECTED] `_DIELINE_EXECUTOR` `max_workers=1`.** Audit `2026-08-13` mục 4 đã xếp đây là chủ đích ("warm Boa context") và tôi xác nhận: context Boa không `Send`, đây là ràng buộc thật, không phải cap tuỳ tiện. Nó **khuếch đại** §RS.01 nhưng bản thân không phải bug — sửa đúng là giảm việc và/hoặc bỏ Boa, không phải nới `max_workers`.
8. **Không có `[profile.release]` trong bất kỳ `Cargo.toml`** — đã kiểm cả 4 crate; chỉ có `[profile.dev]` ở `src-tauri` (`:84`/`:86`/`:88`, opt-level cho `image` và `pdfium-render`). Tuân thủ quy tắc #2.

---

## 6. Lộ trình đề xuất — chờ duyệt, mỗi lô ≤5 file

Xếp theo (tác động × độ an toàn). Mỗi lô verify xong mới sang lô kế; benchmark trước/sau trên **cả** máy mạnh (không được chậm đi) lẫn giả lập máy yếu.

### Lô R-A — Giảm số lượt nesting (§RS.01a) — ưu tiên cao nhất, KHÔNG cần Rust
1. `desktop/src/stores/useBoxStore.ts` — tách đường nesting khỏi debounce chung; control nesting dùng debounce riêng dài hơn hoặc chạy khi commit giá trị.
2. `desktop/src/components/dieline-tool/NestingPanel.tsx` — các input số chuyển `onChange` → commit (`onBlur`/Enter) cho nhánh gửi `includeNesting: true`.
3. Test: gõ liên tiếp vào `dieGap` chỉ sinh **một** lượt nesting; đổi `nestingMode` vẫn phản hồi ngay; kết quả nesting không đổi.

**Gate:** với ca 104 khuôn/tờ, một chuỗi 5 lần gõ chỉ sinh 1 job thay vì 5; kết quả JSON không đổi so với trước lô.

### Lô R-B — Đo lại rồi mới quyết Rust (§RS.01b)
Sau R-A, đo lại đúng ba ca (12 / 63 / 104 khuôn/tờ) trên app thật. **Nếu vẫn còn cảm nhận trễ** thì mới mở lô port kernel:
1. `imposition_core/src/` — export 4 hàm hình học thuần (collision theo mảng, self-intersect, offset polygon, convex hull) tái dùng kernel Clipper2 sẵn có.
2. `native/src/dieline_engine.rs` — đăng ký host function nhận **cả mảng** (một lần vượt biên cho mỗi chiến lược ứng viên).
3. `desktop/src/lib/dieline/nestingEngine.ts` — gọi host function khi có, giữ đường TS làm tham chiếu.
4. Oracle parity: cùng input → cùng output giữa đường TS và đường Rust, **trên corpus 12 loại hộp**, trước khi đổi default. Không `-u` golden master.

### Lô R-C — argmin ΔE bằng numpy (§RS.03)
1. `backend/app/core/channel_remover.py` — `best_kept_only` dùng `np.argmin`; giữ quy tắc chọn ứng viên đầu tiên khi đồng ΔE.
2. Test: kết quả trùng khớp đường cũ trên cả 3 `grid_step`; đo lại 21,38 ms → kỳ vọng dưới 1 ms.

### Lô R-D — Dọn hợp đồng chết (§RS.05)
1. `native/src/lib.rs` + `native/src/nfp_solver.rs` + `imposition_core/src/nfp.rs` — xoá `NfpSolver`, `set_ocg_visibility`, `get_ocg_layers` (hoặc giữ kèm lý do + test).
2. `backend/app/workers/sticker_imposer_pkg/nfp_placer.py` — xoá.
3. Gate: `cargo check` sạch; grep xác nhận 0 caller; `maturin develop --release` xong thì backend test liên quan vẫn xanh.

### Lô R-E — Quyết định chính sách `rust_bridge` (§RS.06)
Cần **quyết định sản phẩm trước khi code**: fail-closed cho nhất quán, hay giữ fallback nhưng surface cảnh báo. Tôi không tự chọn vì nó đổi hành vi khi thiếu native.

### Lô R-F — Đo trước, quyết sau
- §RS.02 tokenizer: đo kích thước content stream thật trên corpus file khách bao bì → xếp lại mức → mới quyết effort M.
- §RS.04 `pont_collision`: đo trên job tem bế thật → phân biệt "GEOS chiếm phần lớn" (thì dùng spatial index) với "số predicate là vấn đề" (thì port).

---

## 7. Điều kiện nghiệm thu tổng

1. Máy 32 GB/16 luồng: không tính năng nào chậm đi ở bất kỳ đường nào khác sau mỗi lô.
2. Giả lập máy yếu (env cap): hành vi như trước lô; không thêm cap vô điều kiện mới (soi bằng scanner `RESOURCE_CAP_WITHOUT_RAM_SIGNAL`).
3. Không golden/snapshot nào bị `-u`. Riêng lô R-B: phải có oracle parity TS ↔ Rust trên 12 loại hộp **trước** khi đổi default.
4. Không đặt `[profile.release]` vào bất kỳ `Cargo.toml` (quy tắc #2).
5. Mỗi chỗ sửa gắn tag truy vết `PERF (audit 2026-08-29 §RS.xx)`.
6. Harness benchmark được promote từ `tmp/` sang `scripts/` (version-control) — đây đúng bài học §PA.R2 của `BAO_CAO_RE_AUDIT_HIEU_NANG_LO_P_A_2026-08-13.md`: benchmark dùng để nghiệm thu mà nằm trong `tmp/` bị gitignore thì mất.
7. Cập nhật `PRYNX_MASTER_AUDIT_MATRIX.md` (W5 cho khuôn bế, W7 cho hiệu năng) và viết `docs/NEN_TANG_RUST_FIXES_2026-08-29.md` theo từng lô.

---

## 8. Phụ lục — tái lập số đo

Harness hiện ở `tmp/bench_boa/` (gitignore). Giữ lại để tái lập; cần promote sang `scripts/` khi lô được duyệt.

```powershell
# 1) Boa vs V8 trên engine khuôn bế
cd d:\pdfcompare\tmp\bench_boa
cargo build --release --offline
$B = "d:\pdfcompare\native\src\generated\dieline_engine.bundle.js"
node bench_node.mjs $B req_nest_grid.json 9          # V8
.\target\release\bench_boa.exe $B req_nest_grid.json 9   # Boa

# Đường cong theo số khuôn/tờ
foreach ($i in 0..4) { .\target\release\bench_boa.exe $B "scale_$i.json" 5 }

# 2) Đối chiếu output Boa <-> V8 (phải byte-identical)
node dump_node.mjs $B req_nest_grid.json out_node.json
.\target\release\bench_boa.exe $B req_nest_grid.json 1 out_boa.json

# 3) Tokenizer + LUT + Bézier
cd d:\pdfcompare\backend
.\venv\Scripts\python.exe d:\pdfcompare\tmp\bench_boa\bench_tokenizer.py
.\venv\Scripts\python.exe d:\pdfcompare\tmp\bench_boa\bench_py_hot.py
```

Các file request: `req_preview.json` (`includeNesting: false`), `req_nest_grid.json`, `req_nest_smart.json`, `scale_0..4.json` (tờ 1090×1450, `nestingMode: smart`, khuôn nhỏ dần → 12/20/40/63/104 khuôn/tờ). Tất cả sinh từ `native/tests/fixtures/dieline_default_request.json`.

Điều kiện khi đo: HEAD `8bc0a21`, `boa_engine 0.21.1` `default-features = false` (khớp `native/Cargo.toml:27`), bundle `dieline_engine.bundle.js` 151.023 byte (mtime 2026-08-27), Node v24.13.0, `.pyd` build 2026-08-28.

---

**Chốt duyệt đề nghị:** duyệt **R-A → R-C → R-D** trước (ba lô nhỏ, blast radius hẹp, R-A giải quyết phần lớn triệu chứng người dùng và **không cần Rust**). Sau R-A thì đo lại rồi mới quyết **R-B** — có thể lúc đó việc port kernel không còn ở mức P1. **R-E** cần quyết định sản phẩm. **R-F** là đo trước, chưa phải lô sửa.

Câu trả lời ngắn cho câu hỏi gốc: phần nặng của PrynX đã ở Rust; chỗ duy nhất còn đáng chuyển là kernel hình học của khuôn bế, và ngay cả ở đó thì bước đầu tiên nên là *bớt gọi* chứ không phải *viết lại*.
