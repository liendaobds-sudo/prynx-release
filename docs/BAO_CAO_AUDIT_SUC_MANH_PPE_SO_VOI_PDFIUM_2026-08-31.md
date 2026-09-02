# BÁO CÁO AUDIT SỨC MẠNH PPE SO VỚI PDFIUM — 2026-08-31

> Phạm vi: semantic render, fail-loud/provenance, differential corpus và hiệu năng Viewer
>
> Baseline: source hiện tại sau khi lỗi Pattern × Glyph đã được sửa và verify
>
> Trạng thái: **REPORT-ONLY — PRODUCTION HOLD — chờ duyệt trước khi sửa**
>
> Giới hạn thay đổi của lượt này: chỉ tạo báo cáo; không sửa source, không cập nhật golden/snapshot, không build installer, không stage/commit/reset

## 1. Kết luận điều hành

PPE **không yếu hơn PDFium theo một trục duy nhất**; hai engine mạnh ở hai nhiệm vụ khác nhau:

- **PPE mạnh hơn cho chế bản/in**: giữ mô hình mực CMYK/spot/DeviceN, bản kẽm, TAC, overprint/knockout, ICC/softproof và có hợp đồng diagnostics để từ chối kết quả không đáng tin.
- **PDFium mạnh hơn cho tương thích hiển thị**: độ phủ feature PDF rộng, font/Type3/CMap, annotation, xử lý file lỗi và khả năng dựng một artifact “giống trình đọc PDF phổ biến”.
- PDFium chỉ được dùng trong audit này làm **oracle geometry/coverage/compatibility**, không làm oracle RGB/màu in. Ghostscript chỉ được dùng làm **oracle bản kẽm/TAC ở development**, không đề xuất đưa trở lại runtime hoặc release.

Audit phát hiện:

| Mức | Đã xác nhận | Nội dung |
|---|---:|---|
| P0 | **0** | Chưa có bằng chứng crash, corruption hay sai toàn bộ pipeline ở mức P0 |
| P1 | **7** | Sai semantic hoặc lệch contract có artifact; phần lớn vẫn trả `Ready` sạch |
| P2 | **6** | Tương thích/provenance/test-gap/gate-risk quan trọng nhưng phạm vi hoặc tác động thấp hơn |
| P1-candidate | **3** | Source trace đáng lo nhưng chưa đủ fixture + artifact để nâng thành finding đã xác nhận |
| P3 backlog | **4 nhóm** | Độ phủ semantic còn thiếu, chưa có bằng chứng production artifact trong lượt này |

Rủi ro chính không phải là PPE chưa hỗ trợ mọi PDF. **Unsupported nhưng fail-loud là chấp nhận được. Rủi ro lớn là mất/sai nội dung nhưng vẫn trả `Ready`, `ink_unsound=false`**, khiến mode `hybrid` không thể chuyển sang PDFium và người dùng không được cảnh báo.

Kết quả corpus hiện có vẫn tốt: golden 53 file có 52 PASS + 1 khác biệt có chủ ý + 0 FAIL; preflight 18 file có 17 PASS + 1 unsupported fail-loud + 0 FAIL. Tuy nhiên các suite này chủ yếu kiểm feature riêng lẻ và whole-page plate/TAC, nên không bắt được các tích như `Pattern × ImageMask`, Type3 `d1`, depth boundary, explicit `/Mask`, page-box fallback hoặc lệch option giữa native và HTTP PPE.

**Khuyến nghị:** duyệt **Lô A — fail-loud shield** trước. Mục tiêu là chặn artifact sai khỏi trạng thái `Ready` trước khi lần lượt hoàn thiện semantic. Mỗi lô sau duyệt giữ phạm vi tối đa 5 file và verify xong mới sang lô kế.

## 2. Phạm vi, tiêu chí và mức bằng chứng

### 2.1 Phạm vi đã audit

- PPE Rust: page descriptor, content interpreter, graphics state, color/pattern, image sampler, font/Type3, stream decode, transparency/group và `RenderWarnings`.
- Viewer/Tauri worker: lựa chọn engine, option `/View`, annotation, phân loại `Ready`/`Unsupported`, fallback.
- PyO3 + backend: `render_softproof`, facade/session và contract HTTP PPE.
- Corpus/test: `print_engine/golden/fixtures`, preflight fixtures, Viewer manifest, fixture tối giản sinh tạm và một PDF thật.
- Hiệu năng: core PPE release probe trên PDF thật, 30 process lạnh × 2 lượt render/session ở 96 DPI.

Không sửa production source trong audit này. Lỗi Pattern × Glyph đã được sửa ở lượt trước và được coi là baseline hiện tại; báo cáo gốc là `docs/BAO_CAO_AUDIT_VIEWER_PATTERN_TEXT_2026-08-31.md`.

### 2.2 Quy ước bằng chứng

| Nhãn | Ý nghĩa |
|---|---|
| **CONFIRMED** | Có fixture hoặc file thật, đường chạy reachable và artifact/diagnostics đo được |
| **TRACED** | Source/contract đã lần theo được nhưng chưa có artifact đủ để định lượng tác động |
| **SUSPECTED** | Khoảng trống static hợp lý nhưng chưa được phép gọi là bug production |
| **REFUTED** | Probe bác bỏ giả thuyết ban đầu hoặc buộc hạ mức |

Một scanner hit, operator chưa thấy hoặc code smell **không đủ** để ghi `CONFIRMED`. Với màu, chênh RGB giữa PPE và PDFium cũng không tự động là bug vì PPE cố ý đi qua ICC/ink space khác lane display.

### 2.3 Nguyên tắc xếp mức

- **P0:** crash/corruption hoặc sai không thể kiểm soát trên luồng cốt lõi, cần chặn release ngay.
- **P1:** mất/sai nội dung nhìn thấy, sai mực/box/contract hoặc false-clean có thể đi tới người dùng.
- **P2:** compatibility/provenance/test/performance risk có thật nhưng cần input hiếm hơn, tác động thấp hơn hoặc chưa phải regression.
- **P3:** backlog độ phủ; cần fixture và ưu tiên sản phẩm trước khi triển khai.

## 3. Kiến trúc hai lane và vì sao false-clean nguy hiểm

| Bề mặt | Engine/lane | Vai trò |
|---|---|---|
| Thumbnail, display, print-preview compatibility | PDFium | Hiển thị rộng, nhanh, tương thích với PDF ngoài thực tế |
| Accurate Viewer / prepress | PPE | ICC, mực, bản kẽm, TAC, Output Preview và provenance |

Các điểm hợp đồng đã trace:

1. `PRYNX_VIEWER_ENGINE_MODE` mặc định là `current`.
2. `hybrid` chỉ fallback PDFium khi PPE được phân loại là capability **`Unsupported`**.
3. `ppe-only` và lỗi PPE không thuộc capability fail-closed; không tự chuyển PDFium.
4. Native worker chưa start có thể fallback sang **HTTP PPE**, không phải PDFium.
5. Native PPE dùng option softproof + optional content `/View` + annotation bật tại `desktop/src-tauri/src/pdf_engine/render_worker.rs:1474-1491`.
6. Python binding dựng `RenderOptions::softproof()` nhưng không expose `/View`/annotation tại `native/src/print_engine_py.rs:327-470`; backend gọi contract đó tại `backend/app/core/print_engine/facade.py:520-575`.

Lỗ hổng soundness cốt lõi:

- `print_engine/src/error.rs`: `RenderWarnings::ink_unsound()` chỉ xét `dropped_objects`, `unsupported_transparency`, `hidden_content_risk` và `approximated_colorspaces`.
- `skipped_ops` đơn thuần không làm `ink_unsound=true`.
- `desktop/src-tauri/src/pdf_engine/render_worker.rs::classify_unsupported_warnings` chỉ phản ứng với các counter/cờ/cảnh báo đã biết.

Do đó một nhánh bỏ object nhưng chỉ ghi `skipped_ops`, hoặc không ghi gì, vẫn có thể trở thành `Ready`. Đây là mẫu chung đứng sau nhiều P1 bên dưới.

## 4. Ma trận sức mạnh PPE so với PDFium

| Họ năng lực | PPE | PDFium | Kết luận audit |
|---|---|---|---|
| CMYK, Separation, DeviceN, bản kẽm | Giữ mô hình mực và xuất plate; golden spot/CMYK khớp GS | Lane PrynX dùng raster display; không dùng làm plate oracle | **PPE mạnh hơn cho prepress** |
| TAC, overprint, knockout | Có số liệu TAC/plate và fixture overprint/knockout đạt | Dựng appearance tốt nhưng không phải hợp đồng TAC/plate của sản phẩm | **PPE mạnh hơn cho kiểm soát mực** |
| ICC/output profile/softproof | Chủ đích theo profile, intent, ink space | Tối ưu display compatibility; RGB không phải chuẩn đối chiếu màu in | **PPE phù hợp hơn với accurate lane** |
| Vector, path, clip, transform cơ bản | Corpus hiện tại tốt; có diagnostics | Engine trưởng thành và độ phủ rộng | Gần ngang ở feature cơ bản; **PDFium rộng hơn ở biên** |
| Text/font/CMap/Type3 | Pattern-filled glyph đã sửa; có provenance font thay thế; còn lỗi Type3 `d1` và backlog vertical CMap | Mạnh hơn về font/Type3/CMap compatibility | **PDFium mạnh hơn về breadth** |
| Tiling/shading/pattern | Axial/radial/mesh/tiling và Pattern × Glyph hiện đạt; còn lỗi Pattern × ImageMask | Độ phủ tổ hợp rộng hơn | PPE mạnh về plate semantics; **PDFium mạnh về tổ hợp feature** |
| Image/SMask/explicit Mask | DCT/CCITT/SMask và plate image tốt; explicit `/Mask` stream đang sai | Dựng explicit mask đúng trong probe | **PDFium mạnh hơn về compatibility mask** |
| Transparency/group/blend | Nhiều fixture blend/group/soft mask khớp GS; có thể fail-loud khi ink semantics không chắc | Độ phủ visual rộng | Không có oracle chung; PPE tốt cho ink khi supported, PDFium tốt cho appearance |
| OCG/optional content | Native `/View` dựng đúng; `/Print` cũng có semantic riêng | Hỗ trợ display OCG trưởng thành | PPE có năng lực nhưng **contract native/HTTP đang lệch** |
| Annotation/form | Native dựng `/AP`; chưa synthesize `/Text` thiếu `/AP` | Dựng `/AP` và synthesize icon phổ biến | **PDFium mạnh hơn** |
| PDF lỗi/repair | Có một số recovery, nhưng nested stream có false-clean | Probe cho thấy repair malformed stream tốt hơn | **PDFium mạnh hơn**; PPE phải fail-loud nếu không repair |
| Diagnostics/provenance | Có `degraded`, `ink_unsound`, counters, colorspace/font provenance | PrynX không dựa vào PDFium cho cùng hợp đồng prepress | **Kiến trúc PPE mạnh hơn**, nhưng các gap P1 phải đóng |
| Page boxes | Expose Media/Crop/Trim/Bleed/Art nhưng fallback đang sai | Default crop trong probe đúng | **PDFium đúng hơn ở ca thiếu box** |
| Hiệu năng Viewer | Core warm P95 hiện vượt manifest gate; chưa đo installed/WebView | Chưa chạy benchmark đối xứng trong audit này | **Chưa đủ dữ liệu để xếp hạng định lượng** |

Kết luận ma trận: **không thay PPE bằng PDFium vô điều kiện** và cũng không coi PPE là renderer phổ quát. Kiến trúc đúng là giữ hai lane, nhưng PPE phải fail-loud đáng tin cậy trước khi `Ready` được xem là artifact accurate.

## 5. Danh sách finding đã xếp hạng

### 5.1 Tổng hợp P1/P2

| ID | Mức | Trạng thái | Finding | Artifact chính |
|---|---:|---|---|---|
| PPE-A01 | **P1** | **CONFIRMED** | Form depth 13 bị bỏ nhưng vẫn `Ready` | PPE mất `6.400/6.400` dark px |
| PPE-A02 | **P1** | **CONFIRMED** | `Pattern × ImageMask` bị bỏ sạch | PPE mất `3.200` px, không warning |
| PPE-A03 | **P1** | **CONFIRMED** | Nested Form stream lỗi recoverable bị bỏ false-clean | PPE mất `6.400` px, PDFium vẫn dựng |
| PPE-A04 | **P1** | **CONFIRMED** | Native Viewer và Python/HTTP PPE dùng contract khác nhau | OCG `25.600→0` px; annotation `/AP` `9.600→0` px |
| PPE-A05 | **P1** | **CONFIRMED** | Explicit image `/Mask` stream bị bỏ qua | PPE tô thừa `3.200` px |
| PPE-A06 | **P1** | **CONFIRMED** | Type3 `d1` xử lý như colored `d0` | PPE `d1` và `d0` cùng RGB hash |
| PPE-A07 | **P1** | **CONFIRMED** | Trim/Bleed/Art thiếu box fallback thẳng MediaBox | PPE `100×100`, đúng phải theo CropBox `80×80` |
| PPE-B01 | P2 | **CONFIRMED** | `/Text` annotation thiếu `/AP` biến mất sạch | PDFium synthesize `336` px; PPE `0` |
| PPE-B02 | P2 | **CONFIRMED** | Stack `q` sâu 257 bị cap im lặng, restore sai state | PPE ra đen, PDFium ra đỏ trên `6.400` px |
| PPE-B03 | P2 | **CONFIRMED provenance** | Thiếu resource `Do`/`sh`/`gs` có thể không ghi diagnostics | PDFium cũng bỏ; chưa có compatibility divergence |
| PPE-B04 | P2 | **CONFIRMED provenance** | Warning colorspace của page transparency group bị thất lạc | Artifact probe chưa khác control |
| PPE-B05 | P2 | **CONFIRMED test gap** | Corpus thiếu cross-feature/boundary/local-ROI assertions | Hai corpus xanh nhưng không bắt 7 P1 |
| PPE-B06 | P2 | **CONFIRMED gate-risk** | Core warm P95 vượt gate Viewer 650 ms | `767,875 ms`, cao hơn `117,875 ms` (`18,1%`) |

Không có P0. Ba P1-candidate static được tách riêng ở §9 để không trộn suy đoán với finding có artifact.

## 6. Chi tiết finding P1

### PPE-A01 — Form depth overflow mất nội dung nhưng `Ready`

- Fixture: `form_depth_13_overflow.pdf`, SHA-256 `DCD114B3CEF3EDA6AE6D0EE9F97DDF0C2837509B536823F267A1004D46F8ECA5`.
- Đối chứng depth 12: PPE và PDFium đều có `6.400` dark px.
- Depth 13: PDFium vẫn có `6.400` px; PPE có `0`, `dropped_objects=0`, `ink_unsound=false`, chỉ ghi `skipped_ops=[Do (lồng quá sâu)]` và worker vẫn trả `Ready`.
- Source: `print_engine/src/content/interp.rs:674-678`; soundness tại `print_engine/src/error.rs` và classifier worker.

Giới hạn recursion là cần thiết để bảo vệ tài nguyên; lỗi không phải “có cap”, mà là **đụng cap sau khi object visible bị bỏ nhưng không chuyển thành capability unsupported/ink-unsound**.

### PPE-A02 — Pattern làm paint cho ImageMask bị bỏ sạch

- Fixture: `pattern_stencil.pdf`, SHA-256 `6DCA61DF2AEF86CCB8459FE5928D0E47F091BCEDAAE1353D29162F93D7A5CC78`.
- PDFium dựng `3.200` dark px; PPE `0`, không warning, `Ready`.
- Source: nhánh `draw_image` quanh `print_engine/src/content/interp.rs:2640-2644`; `make_paint` không thể tạo solid paint cho `ColorSpace::Pattern` tại `print_engine/src/color/space.rs:425-432`.

ImageMask phải dùng current paint xuyên qua stencil. Với Pattern, engine phải paint pattern trong mask hoặc fail-loud; trả nền trắng sạch là sai hợp đồng.

### PPE-A03 — Nested stream decode/recovery không nhất quán và false-clean

- Fixture: `form_flate_raw_ops.pdf`, SHA-256 `EF11ABBB55E3DD8F0555CBBFD4EE1B90AAD82820C19573D99655F8E57C954480`.
- Stream nested Form khai `/FlateDecode` nhưng payload có thể recovery như raw operators.
- PDFium dựng `6.400` dark px; PPE `0`, không warning, `Ready`.
- Các đường decode/fallback liên quan: `print_engine/src/page.rs:468-470`; `print_engine/src/content/interp.rs:1911-1914`, `2163-2164`, `3463-3468`; `print_engine/src/shading/mod.rs:180-184`.

PPE không bắt buộc phải repair mọi PDF lỗi giống PDFium. Nhưng nếu không repair được nested stream thì phải báo unsupported/dropped; **không được biến lỗi decode thành trang sạch**.

### PPE-A04 — Native Viewer và Python/HTTP PPE không cùng render contract

Hai fixture xác nhận cùng một root contract:

1. `ocg_view.pdf`, SHA-256 `E272056655CA518BEE86370570D205908B46D57902198BEC88A704C86310F12D`:
   - native Viewer `/View`: `25.600` dark px;
   - Python binding mặc định `/Print`: `0` px;
   - cả hai diagnostics sạch.
2. `annotation_ap.pdf`, SHA-256 `335FF725B6EF33434587D5F547C71C4C82CD53281797AB383457903A65FD9745`:
   - native annotation bật: `9.600` dark px;
   - Python binding annotation tắt: `0` px;
   - cả hai diagnostics sạch.

Source:

- native Viewer option: `desktop/src-tauri/src/pdf_engine/render_worker.rs:1474-1491`;
- binding: `native/src/print_engine_py.rs:327-470`;
- backend production call: `backend/app/core/print_engine/facade.py:520-575`.

Vì native-before-start có thể fallback HTTP PPE, cùng thao tác Viewer có thể đổi artifact chỉ do transport/lifecycle, không do file hay mode người dùng. Đây là P1 contract parity, không phải tranh luận `/View` hay `/Print` đúng tuyệt đối cho mọi consumer.

### PPE-A05 — Explicit image `/Mask` stream bị bỏ qua

- Fixture: `explicit_image_mask.pdf`, SHA-256 `843BF773BEE2166EB2B6C4093C88E060643165D1C4B042959F046AA396F8FD7F`.
- PPE tô toàn vùng `6.400` dark px; PDFium áp mask và chỉ tô `3.200` px; PPE thừa đúng `3.200` px.
- PPE vẫn `Ready`, không warning.
- Source: `print_engine/src/image/sampler.rs:493-507` chỉ xử lý `/Mask` dạng array; `/Mask` stream đi qua sạch.

Đây là sai coverage chứ không chỉ sai RGB. Nếu chưa triển khai mask stream, cần fail-loud trước; sau đó mới hoàn thiện semantic decode/composite.

### PPE-A06 — Type3 `d1` không triệt màu nội bộ CharProc

- Fixture `type3_d1.pdf`, SHA-256 `BEEDF46E363E37BC23E2E1C2F0EEED9294AAB0C794A628BD8DDF3CD1BE565638`.
- Control `type3_d0_control.pdf`, SHA-256 `D1733AED40C41624CF5E4D94A8979F7928149DE5AC2F5F13912B1950AA753587`.
- PDFium: `d1` dùng màu đen từ caller; `d0` giữ màu xanh nội bộ.
- PPE: `d1` và `d0` cho cùng RGB hash `BB4FB19D09E000EA06DD94F0F67471E220434763274CC91B15A17AF338AA4F86`, đều theo màu nội bộ; diagnostics sạch.
- Source: `print_engine/src/content/interp.rs:1141-1144` coi cả `d0` và `d1` như no-op dù comment đã nêu color suppression của `d1`.

Đây là semantic bắt buộc của uncolored Type3 glyph; ảnh hưởng màu/mực và có thể chạm logo/ký hiệu chuyên dụng.

### PPE-A07 — Page-box fallback không theo CropBox

- Fixture SHA-256 `349E3D4DF91513C1C1555DED591F6127C60058FFAD8AA3DD1193336DD9E0756A`.
- Khai `MediaBox=100×100`, `CropBox=80×80`, không khai Trim/Bleed/Art.
- PPE: Media `100×100`, Crop `80×80`, nhưng Trim/Bleed/Art đều `100×100`, diagnostics sạch.
- Quy tắc fallback cần theo CropBox; PDFium default crop trong probe là `80×80`.
- Source: `print_engine/src/page.rs::PageDescriptor::target` quanh `:76-83` default từng box thiếu trực tiếp về MediaBox.

Sai box có thể làm sai vùng cắt/chừa xén hoặc kích thước output prepress, nên xếp P1 dù fixture tối giản không đo màu.

## 7. Chi tiết finding P2

### PPE-B01 — Annotation thiếu `/AP`

- `text_annotation_no_ap.pdf`, SHA-256 `109B2460F8C7B5B367C594EBCE7002D7245C01D3C96203305706B3A72719DD15`.
- PDFium synthesize icon `/Text` `336` px; native PPE với annotation bật vẫn `0`, `Ready`.
- Source: `print_engine/src/page.rs:350-420`; hiện chỉ một số nhánh như Widget gọi diagnostics unsupported.

Đây là compatibility Viewer, không nhất thiết là ink correctness, nên P2. PPE có thể synthesize appearance hoặc báo rõ annotation chưa dựng; không nên giả vờ parity.

### PPE-B02 — Graphics-state stack cap làm restore sai

- `q_depth_257.pdf`, SHA-256 `2E6BA7F0EEEE188BE14073C41D936185287909207B292B5D1E8E0544E49D752D`.
- PPE silently bỏ lần `q` thứ 257, sau đó restore lệch và tô đen; PDFium restore đúng state đỏ; vùng khác `6.400` px.
- PPE chỉ ghi `Q (không cân)` về sau, vẫn `Ready`.
- Source: `print_engine/src/content/gstate.rs:165-196`, `MAX_STATE_DEPTH=256`, `save()` return im lặng.

Không nên bỏ cap vô điều kiện. Cần fail-loud ngay tại overflow và giữ state deterministic.

### PPE-B03 — Resource thiếu không có provenance

Các ca `Do`, `sh`, `gs` thiếu entry hoặc resource dictionary có thể đi qua sạch tại các gate quanh `print_engine/src/content/interp.rs:711-714`, `962-971`, `2113-2136`. Probe xác nhận PDFium cũng bỏ các malformed resource tương ứng, nên không có cơ sở gọi đây là P1 compatibility. Tuy vậy PPE nên ghi provenance phù hợp khi operator visible không resolve được.

### PPE-B04 — Warning page-group bị thất lạc

`print_engine/src/page.rs:711-733` tạo/nhận warning cục bộ khi xử lý colorspace transparency group nhưng không bảo toàn đầy đủ vào kết quả cuối. Probe `page_group_calrgb.pdf` SHA-256 `CC2E6839689F366D79C08D180D82892EAE65329A52CDDBC342B5DD0491F4E1BD` cho artifact giống DeviceRGB control trong cả PPE và PDFium, nên chỉ giữ P2 provenance; không tuyên bố sai màu đã xác nhận.

### PPE-B05 — Corpus xanh nhưng thiếu interaction coverage

Các fixture hiện có đã bảo vệ tốt từng feature, nhưng chưa khóa:

- Pattern làm paint cho ImageMask;
- explicit `/Mask` stream;
- Type3 `d1` so với paired `d0` control;
- Form depth ngay dưới/trên cap;
- `q/Q` ngay dưới/trên cap;
- malformed nested stream + fail-loud;
- fallback Trim/Bleed/Art về CropBox;
- option parity native `/View` + annotation với Python/HTTP PPE;
- local ROI/object-presence thay vì chỉ whole-page TAC/mean.

Đây là lý do 52/53 + 17/18 corpus verdict hợp lệ nhưng vẫn không phủ các P1 mới.

### PPE-B06 — Warm P95 là gate-risk, chưa phải regression

Manifest `docs/VIEWER_ENGINE_CORPUS_2026-08-10.json` đặt `maxP95TotalMs=650`. Core probe hiện tại cho warm P95 `767,875 ms`, vượt `117,875 ms` (`18,1%`). Tuy nhiên phép đo không phải installed Tauri/WebView, không dùng runtime PNG encoder và chưa có historical same-machine/same-fixture baseline; do đó chỉ được gọi **gate-risk**, không được gọi regression hoặc slowdown so với PDFium.

## 8. Bằng chứng corpus, test và hiệu năng

### 8.1 Tool/self-test và Rust regression hiện hành

| Lệnh/gate | Kết quả |
|---|---|
| `backend\venv\Scripts\python.exe -B scripts\ppe_viewer_shadow_report.py --self-test` | `self-test: PASS` |
| `backend\venv\Scripts\python.exe -B scripts\ppe_viewer_baseline.py --self-test` | `{"ok": true, "schemaVersion": 2}` |
| `cargo test --locked --manifest-path "print_engine\Cargo.toml" --test render_tiling_pattern --test render_text` | `render_tiling_pattern` **24/24**, `render_text` **16/16** |

Pattern × Glyph đã có regression sau bản sửa trước. `Pattern × ImageMask` là tổ hợp khác và chưa được khóa.

### 8.2 Golden/corpus differential

Các lệnh chính:

```powershell
backend\venv\Scripts\python.exe -B scripts\ppe_golden_compare.py "print_engine\golden\fixtures" --dpi 100 --color-managed --json "%TEMP%\prynx-ppe-gs-golden-100dpi.json"
backend\venv\Scripts\python.exe -B scripts\ppe_golden_compare.py "backend\tests\preflight_fixtures\pdfs" --dpi 100 --color-managed --json "%TEMP%\prynx-ppe-gs-preflight-100dpi.json"
```

| Corpus | Tổng | PASS | Khác có chủ ý / fail-loud | FAIL |
|---|---:|---:|---:|---:|
| `print_engine/golden/fixtures` | 53 | 52 | 1: `oc_print_state_off.pdf` | **0** |
| `backend/tests/preflight_fixtures/pdfs` | 18 | 17 | 1: `14_progressive_jpeg.pdf` unsupported có `dropped_objects=1`, `ink_unsound=true` | **0** |

Golden chứng minh PPE hiện mạnh ở CMYK, spot, Separation, overprint, knockout, blend/group, soft mask, axial/radial/mesh/tiling và TAC khi feature được hỗ trợ. Nó không chứng minh mọi tổ hợp PDF đều đúng.

### 8.3 Probe tối giản PPE–PDFium

Bằng chứng tạm đã đối chiếu:

- `%TEMP%\prynx_ppe_pdfium_audit_20260831\probe-report.json` — 18 probe chính, native Viewer contract, 72 DPI, annotation bật.
- `%TEMP%\prynx_ppe_contract_probe_20260831\contract-report.json` — native `/View`/annotation so với Python binding.
- `%TEMP%\prynx_ppe_semantic_probe2_20260831\probe2-report.json` — UserUnit, explicit Mask, Type3, q-depth.
- `%TEMP%\prynx_ppe_pagebox_probe_20260831\pagebox-report.json` — fallback page boxes.

Runner probe hình học/diagnostics được dựng tạm với dependency resolution riêng vì temp project không thể dùng project `Cargo.lock`; nó lấy `lcms2 6.2.0` thay vì `6.1.1` trong lock dự án. Vì vậy report chỉ dùng runner này cho **coverage/geometry/status/provenance**, không dùng chênh RGB nhỏ làm color oracle. Golden và perf chính thức ở trên/dưới đều chạy project `--locked`.

### 8.4 Core performance baseline

Fixture thật:

- `test\0 Trang bia.pdf`;
- kích thước `14.403.853` byte;
- SHA-256 `C74663A54A85B433D0F330FF78748ED0C31F7856A54F7EE6373939C4327995DD`;
- 30 process lạnh, mỗi session render 2 lần, 96 DPI, output `794×1123`;
- release diagnostic build từ project lock; Viewer options `/View`, annotation bật, overprint simulation tắt.

| Chỉ số | P50 | P95 |
|---|---:|---:|
| Mở session lạnh | `11,861 ms` | `13,117 ms` |
| First render total/proxy | `1.316,685 ms` | `1.471,185 ms` |
| Warm render total/proxy | `708,110 ms` | `767,875 ms` |
| Peak working set | `481,188 MiB` | `482,723 MiB` |

Giới hạn bắt buộc khi diễn giải:

- scope JSON là `ppe-core-baseline-not-end-to-end-viewer`;
- không đo bootstrap, IPC, Blob, WebView decode, compositor, FSP/FCVF hoặc blank-gap;
- `encode_ms` dùng RGB/flate2 PNG proxy, không phải runtime `Image::PngEncoder`;
- peak memory chỉ của process probe PPE, không phải toàn cây ứng dụng;
- “cold” là process/RenderSession mới, không xóa Windows file cache;
- chưa có benchmark PDFium đối xứng và chưa có baseline lịch sử cùng máy/cùng fixture.

Không được dùng số này để tuyên bố PPE chậm hơn PDFium bao nhiêu hoặc đã regression. Nó chỉ chỉ ra gate Viewer 650 ms cần đo end-to-end chính thức.

## 9. Static backlog, giả thuyết chưa đủ bằng chứng và nội dung đã bác bỏ

### 9.1 Ba P1-candidate chưa được nâng thành finding

| ID | Mức tạm | Trạng thái | Source trace | Điều còn thiếu |
|---|---:|---|---|---|
| PPE-S01 | P1-candidate | **SUSPECTED** | Named/predefined Type0 CMap bị identity hóa tại `print_engine/src/text/font.rs:620-636`; chưa thấy đầy đủ `Identity-V`, `DW2/W2` | Fixture CJK ngang/dọc, paired oracle và artifact text geometry |
| PPE-S02 | P1-candidate | **SUSPECTED** | Chưa thấy áp `/DefaultGray`, `/DefaultRGB`, `/DefaultCMYK` | Fixture resource-default colorspace + plate/ICC oracle |
| PPE-S03 | P1-candidate | **SUSPECTED** | `/UserUnit` chưa thấy được tiêu thụ đầy đủ | Probe `/UserUnit 2` hiện cho cùng wrapper output `100×100`; cần kiểm page geometry/API khác |

Ba mục này đáng ưu tiên làm fixture nhưng **không được cộng vào 7 P1 confirmed**.

### 9.2 P3 backlog

1. PatternType 2 `/ExtGState` và `TilingType` chưa đầy đủ.
2. Một số ExtGState key còn thiếu; `/BM` array hiện ưu tiên item đầu thay vì negotiation đầy đủ.
3. Lab parameters và ICC `/Alternate`/`/Range` chưa đầy đủ.
4. Content operator `ri` hiện cố ý no-op cho nominal ink; cần sản phẩm quyết định khi mở rộng rendering-intent semantics.

### 9.3 Giả thuyết đã refute/hạ mức

| Giả thuyết ban đầu | Kết luận sau probe |
|---|---|
| Form transparency group có `/CS` lỗi sẽ false-clean | **REFUTED**: runtime đặt `unsupported_transparency=true`, worker trả `Unsupported` |
| `/UserUnit 2` chắc chắn gây artifact sai | **CHƯA XÁC NHẬN**: wrapper PPE/PDFium cùng output `100×100` |
| Thiếu `Do`/`sh`/`gs` là P1 compatibility so với PDFium | **HẠ P2 provenance**: PDFium cũng bỏ malformed resource trong probe |
| Page-group CalRGB chắc chắn làm sai màu | **HẠ P2 provenance**: artifact bằng DeviceRGB control trong cả hai engine |
| Chênh RGB giữa PPE và PDFium là lỗi màu PPE | **BÁC BỎ làm tiêu chí chung**: hai engine đi qua color contract khác nhau |

## 10. Kế hoạch lô sửa sau duyệt — tối đa 5 file/lô

### Lô A — Fail-loud shield trước semantic breadth — **5 file**

Mục tiêu: mọi object visible bị bỏ do depth/decode/pattern-mask/explicit-mask/annotation unsupported phải làm kết quả không còn `Ready` sạch; không nới cap vô điều kiện và không bịa màu/appearance.

1. `print_engine/src/content/interp.rs`
2. `print_engine/src/page.rs`
3. `print_engine/src/image/sampler.rs`
4. `print_engine/tests/render_page.rs`
5. `print_engine/tests/render_image.rs`

Acceptance chính: các fixture PPE-A01/A02/A03/A05 và annotation unsupported tương ứng phải hoặc render đúng, hoặc trả `dropped_objects`/`ink_unsound`/capability `Unsupported`; không còn false-clean. Đây là lô nên duyệt đầu tiên vì nó làm `hybrid` có cơ hội bảo vệ người dùng trước khi hoàn thiện mọi semantic.

### Lô B — Parity native Viewer ↔ Python/HTTP PPE — **tối đa 4 file**

1. `native/src/print_engine_py.rs`
2. `backend/app/core/print_engine/facade.py`
3. `backend/app/core/ppe_viewer_session.py` nếu routing cần truyền option tại đây
4. `backend/tests/test_ppe_viewer_session.py`

Expose/truyền rõ optional-content usage và annotation flag theo consumer; không đổi mặc định của consumer print/preflight một cách ngầm. Hai fixture OCG và annotation `/AP` phải cho artifact/diagnostics parity giữa native và HTTP Viewer.

### Lô C — Semantic ImageMask/explicit Mask — **4 file**

1. `print_engine/src/content/interp.rs`
2. `print_engine/src/image/sampler.rs`
3. `print_engine/tests/render_image.rs`
4. `print_engine/tests/render_tiling_pattern.rs`

Triển khai Pattern paint xuyên stencil và explicit `/Mask` stream đúng coverage/clip/matrix; giữ regression Pattern × Glyph đã có. Nếu semantic chưa đủ, fail-loud từ Lô A vẫn phải tồn tại.

### Lô D — Type3 `d1` và graphics-state boundary — **tối đa 4 file**

1. `print_engine/src/content/interp.rs`
2. `print_engine/src/content/gstate.rs`
3. test Type3 tập trung mới hoặc `print_engine/tests/render_text.rs`
4. `print_engine/tests/render_page.rs`

Phải bảo toàn cap chống tài nguyên, phát warning tại đúng điểm overflow, và khóa paired `d1`/`d0` bằng màu caller/nội bộ. `print_engine/tests/render_text.rs` đang có thay đổi ngoài audit; khi triển khai phải merge có chủ đích hoặc dùng test chuyên biệt, tuyệt đối không overwrite/reset.

### Lô E — Page-box fallback và chuẩn hóa stream decode — **thiết kế lại trước khi sửa, tối đa 5 file**

Phạm vi ứng viên:

1. `print_engine/src/page.rs`
2. `print_engine/src/pdf.rs`
3. `print_engine/src/content/interp.rs`
4. `print_engine/src/shading/mod.rs`
5. một test file tập trung

Hai root page-box và decode không được gộp liều chỉ để đủ lô. Trước triển khai phải chốt helper decode dùng chung và test plan; nếu review cho thấy coupling thấp, tách E1/E2, mỗi lô vẫn ≤5 file.

## 11. Ma trận verify bắt buộc sau mỗi lô

| Gate | Tiêu chí đạt |
|---|---|
| Targeted Rust/backend test | Test mới + test bị ảnh hưởng xanh; dùng project lock |
| Differential fixture | Local ROI/coverage/box/color-state đúng, không chỉ whole-page mean |
| Negative/fail-loud | Feature chưa hỗ trợ không được đồng thời mất/sai object và `Ready` sạch |
| Diagnostics contract | `dropped_objects`, `ink_unsound`, `degraded`, `skipped_ops` và worker status nhất quán |
| Golden 53 | Không có FAIL mới; không bless snapshot nếu hình học không đổi có chủ đích |
| Preflight 18 | Giữ unsupported progressive JPEG fail-loud; không hạ provenance |
| Native/HTTP parity | Cùng Viewer options cho cùng artifact hoặc sai khác được khai báo rõ theo consumer |
| Viewer shadow chính thức | Đủ 11 entries/14 pages, ≥5 ready pairs/page, không unsupported/error ngoài manifest |
| Tauri installed smoke | `current`, `hybrid`, `ppe-only`, native và HTTP fallback trên bản release |
| Performance | Đo cùng fixture/máy; không hard-cap máy mạnh; chỉ giảm tài nguyên theo RAM `<8 GB`/`<16 GB`, máy `≥16 GB` giữ full |
| Acrobat/physical print | So appearance và plate/TAC trên asset đại diện trước release |

## 12. Blocker và khoảng trống bằng chứng còn lại

1. **Chưa có Viewer shadow log hiện tại.** Không thể tuyên bố official rollout gate đạt.
2. Manifest `docs/VIEWER_ENGINE_CORPUS_2026-08-10.json` có 11 entries/14 pages nhưng asset bắt buộc `customer-cmyk-primary` không nằm trong repo. Cần `PRYNX_VIEWER_CORPUS_CMYK` trỏ đúng file SHA-256 `95F38CF429FE7DD7C6500043CE308FD2E87E80A2290217D428FE0C68C6098184`. Repo-only chỉ chạy được 10 entries/10 pages.
3. Chưa có installed-release/Tauri end-to-end baseline, WebView FSP/FCVF, blank-gap hoặc PDFium benchmark đối xứng.
4. Chưa có máy vật lý RAM thấp/trung bình để verify policy tài nguyên; không được suy ra hard cap từ máy audit.
5. Chưa rerun Acrobat trên toàn bộ probe và chưa có physical-print evidence.
6. Temp geometry runner dùng dependency resolution khác project lock; không dùng nó cho kết luận màu tinh tế.
7. Working tree đang có rất nhiều thay đổi của người dùng/luồng khác; mọi lô sửa phải bảo toàn chúng và chỉ chạm file đã duyệt.

## 13. Chốt duyệt

- **Audit:** hoàn tất trong phạm vi đã nêu.
- **Production source:** chưa sửa trong lượt báo cáo này.
- **P0:** 0.
- **P1 confirmed:** 7.
- **P2:** 6.
- **P1-candidate static:** 3, chưa được gọi là bug đã xác nhận.
- **Official Viewer shadow/installed release/physical print:** chưa đủ bằng chứng, không tuyên bố đạt.
- **Trạng thái:** **PRODUCTION HOLD — chờ người dùng duyệt lô sửa**.

Đề nghị chốt: **duyệt Lô A — fail-loud shield (5 file)** trước. Sau khi Lô A verify đầy đủ mới xin duyệt Lô B; không triển khai song song các lô semantic còn lại.
