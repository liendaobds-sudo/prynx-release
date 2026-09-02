# BÁO CÁO AUDIT VIEWER MẤT LOGO TÔ BẰNG PATTERN — 2026-08-31

> Audit unit: **mở PDF → thumbnail có “Hikari Fresh” → vùng xem chính mất logo**
>
> File thật: `D:\pdfcompare\test\0 Trang bia.pdf`
>
> SHA-256: `C74663A54A85B433D0F330FF78748ED0C31F7856A54F7EE6373939C4327995DD`
>
> Baseline khi lập báo cáo: `HEAD 8bc0a219b2ec53cc9cc06adb4b9a7cd11c341dff`
>
> Trạng thái: **[FIXED + VERIFIED] Lô A đã triển khai; regression, full Rust suite, semantic re-review và artifact PDF thật đều đạt.**
>
> Các mục 1–11 ghi lại trạng thái và bằng chứng **trước khi sửa**; kết quả hậu triển khai được chốt tại §12.

## 1. Kết luận điều hành

Suy đoán của người dùng **đúng về bản chất**: logo mất vì phần chữ được tô bằng một Pattern. Chính xác hơn, PDF không dùng axial/radial shading trực tiếp cho logo; hai chuỗi `Hikari` và `Fresh` dùng một **Tiling Pattern `/PatternType 1` chứa ảnh CMYK** làm màu tô glyph.

Thumbnail đúng vì được raster bằng **PDFium**. Vùng xem chính ở nhánh màu chính xác dùng **PrynX Print Engine (PPE)** và PPE hiện bỏ toàn bộ glyph có pattern fill. Đây không phải lỗi CSS, lớp composite, cache, viewport hay font:

- PDFium và PPE được chạy ngoài UI, cùng trang, cùng `144 DPI`, cùng raster `1191×1685`;
- PDFium hiện logo, PPE mất logo;
- trên bản sao tạm, chỉ thay đúng hai lệnh pattern fill bằng CMYK phẳng thì cả hai engine đều hiện đúng cùng font, glyph, clip, matrix và transparency.

Nguyên nhân gốc nằm trong `print_engine/src/content/interp.rs`: path fill có nhánh chuyên biệt `pattern_for → paint_with_pattern`, còn `draw_glyph` chỉ gọi `make_paint`. `ColorSpace::Pattern` cố ý không tạo solid paint và trả `Ok(None)`, nên glyph bị bỏ im lặng.

Có thêm một finding P1 về tính trung thực: PPE vẫn công bố kết quả sạch (`degraded=false`, `ink_unsound=false`, không dropped object, không skipped op) dù đã mất logo. Vì vậy cơ chế hybrid/fail-loud hiện không thể tự chuyển engine hoặc cảnh báo người dùng.

## 2. Phạm vi và mức bằng chứng

### 2.1 Đường chạy live

| Bề mặt | Entry | Engine | Kết quả |
|---|---|---|---|
| Thumbnail | `desktop/src/components/acrobat/ThumbSidebar.tsx:273` → `render_pdf_page` | PDFium | Có logo |
| Viewer chính, display | `desktop/src/hooks/viewer/useTileRenderer.ts:478` → `render_pdf_page` | PDFium | Có logo |
| Viewer chính, accurate/PPE | `desktop/src/hooks/viewer/useTileRenderer.ts:581` → `render_ppe_page` | PPE | Mất logo |
| Composite cuối | `LivePageFrame.tsx` đưa nguyên PNG vào `<img>` | Không raster lại | Không thể tự xóa riêng logo |

Mode mặc định trong source là `current`, không phải luôn `ppe-only`; engine thực tế còn phụ thuộc mode và đánh giá color-risk. Finding đã được tái hiện trực tiếp trên PPE nên không phụ thuộc trạng thái UI, zoom, tile cache hay session audit W7-U10.

### 2.2 Mức bằng chứng

- Trace frontend → Tauri → renderer: **TRACED**.
- Parse object/resource/content stream của file thật: **ARTIFACT**.
- Raster cùng kích thước bằng hai engine: **ARTIFACT**.
- Đối chứng nhân quả chỉ đổi operator màu: **CAUSAL ARTIFACT**.
- Baseline test PPE hiện hành: **AUTO**.
- Chưa có click-smoke Tauri/installer sau bản sửa vì audit này chưa sửa code.

## 3. Fixture và cấu trúc PDF

- Dung lượng: `14.403.853` byte.
- PDF 1.7, một trang.
- `MediaBox`, `CropBox`, `TrimBox`, `BleedBox`: `[0 0 595.5 842.25]`.
- Form `/R95`, object `27 0 R`, chứa text thật `Hikari` và `Fresh`.
- Hai lần tô visible dùng chuỗi operator `/R26 cs /R94 scn`.
- `/R94`, object `24 0 R`, là `/PatternType 1` tiling pattern.
- Pattern chứa image CMYK `/R93`; hiệu ứng nhìn giống gradient đến từ nội dung ảnh trong pattern.

Chuỗi resource/operator quan trọng:

```text
Page/Form /R95
  └─ text “Hikari” + “Fresh”
       └─ /R26 cs /R94 scn
            └─ /R94: Tiling PatternType 1
                 └─ /R93: ảnh CMYK
```

Do đó cách gọi chính xác của lỗi là **pattern-filled text/glyph**, không phải lỗi tổng quát của mọi gradient PDF.

## 4. Tái hiện và đối chứng nhân quả

### 4.1 Raster độc lập ngoài UI

Cùng trang 1, `144 DPI`, output `1191×1685`:

| Engine | Logo “Hikari Fresh” | Trạng thái PPE |
|---|---|---|
| PDFium | Hiện đúng | Không áp dụng |
| PPE | Mất hoàn toàn | `degraded=false`, `ink_unsound=false` |

Việc PPE full-page cũng mất logo loại trừ giả thuyết tile origin hoặc clip viewport `(0,0)`. Logo đã thiếu trong PNG trước khi React/CSS nhận ảnh, nên compositor không phải nguyên nhân.

### 4.2 Đối chứng màu phẳng

Một bản sao tạm của PDF chỉ thay đúng hai lần:

```text
/R26 cs /R94 scn
```

bằng:

```text
0 1 1 0 k
```

Các thành phần sau được giữ nguyên:

- font `HFPGWF+Dingos-Bold`;
- glyph/text content;
- text matrix và transform;
- clip;
- transparency;
- vị trí và page boxes.

Kết quả: PDFium và PPE đều hiện `Hikari Fresh` màu đỏ. Đối chứng này bác bỏ font/glyph/clip/alpha và cô lập biến gây lỗi là **Pattern được dùng làm fill paint của text**.

### 4.3 Vì sao golden compare vẫn báo PASS

Lệnh audit:

```powershell
backend\venv\Scripts\python.exe scripts\ppe_golden_compare.py "test\0 Trang bia.pdf" --page 1 --dpi 100 --json "backend\.audit-tmp\viewer_pattern_logo_audit_20260831_plate_stats.json"
```

Kết quả tiêu biểu:

```text
verdict             = PASS
gs_max_tac_pct      = 318.824
ppe_max_tac_pct     = 318.8
ppe_dropped_objects = 0
ppe_skipped_ops     = []
ppe_degraded        = false
ppe_ink_unsound     = false
```

`PASS` không bác bỏ lỗi. Metric whole-page/TAC bị phần còn lại của trang làm loãng, trong khi logo là vùng nhỏ. Quan trọng hơn, interpreter không ghi warning khi bỏ glyph nên gate provenance/soundness không có tín hiệu để fail.

## 5. Nguyên nhân gốc trong source

### 5.1 Pattern được parse nhưng không đi đến glyph painter

1. `print_engine/src/content/interp.rs:901`: operator `scn` lưu `fill_pattern`.
2. Với path fill, `interp.rs:1308-1311` resolve pattern qua `pattern_for` rồi gọi `paint_with_pattern`.
3. Với text, `draw_glyph` tại `interp.rs:3833-3840` chỉ gọi `make_paint(stack, false)`; không có nhánh `paint_with_pattern` tương ứng.
4. `print_engine/src/color/space.rs:425-428`: `ColorSpace::Pattern` trả `Ok(None)` vì Pattern không thể biểu diễn như một solid paint thông thường.
5. `draw_glyph` không nhận được paint, không vẽ glyph và cũng không ghi dropped/skipped warning.

`ColorSpace::Pattern → Ok(None)` tự nó không phải lỗi: path renderer đã xử lý Pattern ở lớp cao hơn. Lỗi là text renderer không thực hiện cùng semantic dispatch.

### 5.2 Lỗ hổng soundness

`desktop/src-tauri/src/pdf_engine/render_worker.rs:1320-1366` chỉ fail-loud/fallback khi PPE đã phát ra warning hoặc cờ không tin cậy. Ca này trả đồng thời:

- `dropped_objects=0`;
- `skipped_ops=[]`;
- `degraded=false`;
- `ink_unsound=false`.

Vì vậy ảnh thiếu nội dung vẫn được gắn nhãn sạch. Chỉ thêm fallback ở worker không giải quyết được nếu interpreter tiếp tục im lặng.

## 6. Findings

| ID | Mức | Trạng thái | Finding | Bằng chứng |
|---|---:|---|---|---|
| §PTXT.1 | **P1** | **CONFIRMED** | PPE bỏ glyph được tô bằng Tiling Pattern | parse + raster + đối chứng màu phẳng + trace source |
| §PTXT.2 | **P1** | **CONFIRMED** | PPE trả trạng thái sạch dù đã mất nội dung visible | JSON diagnostics + trace worker |
| §PTXT.3 | P2 test gap | **CONFIRMED** | Test Pattern và text chạy riêng, không có tích `Pattern × Glyph` | baseline test suite |

### §PTXT.1 — P1 — Pattern-filled glyph bị bỏ

Ảnh hưởng đã chứng minh: viewer chính ở PPE/accurate lane có thể mất logo hoặc text nếu glyph dùng Pattern làm fill. Đây là lỗi correctness P1 vì artwork thương hiệu biến mất trong vùng duyệt nhưng thumbnail vẫn tạo cảm giác file đầy đủ.

Code path là generic cho glyph, nên phạm vi tiềm năng rộng hơn riêng font/file này. Tuy nhiên audit chưa tuyên bố đã chứng minh mọi tổ hợp font, stroke pattern, Type3, text render mode hoặc nested pattern; các tổ hợp đó phải nằm trong ma trận regression.

### §PTXT.2 — P1 — False-clean làm hybrid/fail-loud vô hiệu

Một renderer có thể chưa hỗ trợ đầy đủ operator, nhưng không được công bố artifact sạch sau khi bỏ nội dung visible. Ít nhất một trong các tín hiệu `dropped_objects`, `skipped_ops`, `degraded` hoặc `ink_unsound` phải phản ánh lỗi nếu pattern không resolve/render được.

Sửa semantic là ưu tiên. Diagnostics vẫn phải được bổ sung cho nhánh bất khả thi/unsupported để tránh tái diễn lỗi mất nội dung âm thầm.

### §PTXT.3 — P2 — Thiếu test tổ hợp

Baseline đã chạy:

```powershell
cargo test --manifest-path "print_engine\Cargo.toml" --test render_tiling_pattern --test render_text
```

Kết quả tại thời điểm probe:

- `render_tiling_pattern`: **15 passed**;
- `render_text`: **16 passed**.

Hai nhóm test xanh nhưng không có ca Pattern dùng làm màu của glyph. Đây là test-interaction gap: kiểm từng feature độc lập không đủ bảo vệ tích semantic giữa color space và text painting.

## 7. Các giả thuyết đã loại trừ

| Giả thuyết | Kết luận | Bằng chứng loại trừ |
|---|---|---|
| CSS/React che logo | Bác bỏ | Logo đã thiếu trong PNG PPE độc lập |
| Tile cache hoặc clip viewport | Bác bỏ | PPE full-page vẫn mất, PDFium cùng kích thước có |
| Font/glyph hỏng | Bác bỏ | Cùng font/glyph hiện khi đổi sang CMYK phẳng |
| Transparency/alpha | Bác bỏ | Giữ nguyên transparency trong đối chứng |
| Pattern resource không parse được hoàn toàn | Bác bỏ một phần | `scn` lưu pattern và path có implementation; thiếu dispatch riêng ở glyph |
| Thumbnail dùng bản PDF khác | Bác bỏ | Hai engine chạy trên cùng fixture/hash |

## 8. Phạm vi ảnh hưởng và giới hạn audit

Đã chứng minh:

- file mẫu nêu trên;
- trang 1;
- fill text bằng Tiling PatternType 1 chứa ảnh CMYK;
- PDFium đúng, PPE sai;
- diagnostics PPE false-clean.

Có rủi ro nhưng chưa được nghiệm chứng đầy đủ:

- pattern-filled text ở các PDF khác;
- pattern stroke của text;
- Type0/CIDFont, TrueType, Type3 và các text rendering mode khác nhau;
- nested pattern, uncolored tiling pattern, Pattern kết hợp DeviceN/Spot;
- các đầu ra khác cùng dùng PPE ngoài viewer.

Audit không kết luận PDFium luôn đúng hơn về màu. PDFium chỉ là oracle hiển thị cho object bị mất trong ca này. Không đề xuất fallback PDFium vô điều kiện vì sẽ phá mục tiêu accurate-color của PPE.

## 9. Phương án sửa sau khi được duyệt

### Lô A — Sửa semantic và khóa regression, tối đa 3 file

1. Trong `print_engine/src/content/interp.rs`, cho glyph fill/stroke đi qua semantic Pattern tương đương path painting; giữ đúng text matrix, glyph mask/outline, clip và text rendering mode.
2. Nếu Pattern không resolve hoặc không render được, ghi diagnostics fail-loud thay vì trả sạch.
3. Thêm regression tập trung vào `print_engine/tests/render_tiling_pattern.rs` hoặc test chuyên biệt mới:
   - PatternType 1 làm fill cho text phải tạo pixel visible trong vùng glyph;
   - đối chiếu local ROI, không chỉ whole-page mean/TAC;
   - kiểm solid text và path pattern cũ không hồi quy;
   - kiểm ít nhất Type0/CID hoặc TrueType theo đúng fixture tối giản.

Không nên sửa `ColorSpace::Pattern` thành một màu đặc giả: Pattern cần resource, matrix, cell và clipping riêng. Điểm sửa đúng là semantic dispatch tại painter.

### Lô B — Khóa hợp đồng soundness/worker nếu Lô A chưa đủ, tối đa 2 file

1. Thêm test rằng unresolved/unsupported text pattern tạo warning/cờ không tin cậy.
2. Xác nhận `render_worker.rs` từ chối hoặc fallback đúng khi nhận cờ đó.
3. Không fallback khi PPE đã render pattern đúng; tránh làm chậm hoặc đổi màu trên máy mạnh.

Dự kiến tổng phạm vi không quá năm file mỗi lô. Tại thời điểm lập báo cáo, working tree toàn repo không sạch và `print_engine/tests/render_text.rs` đang có thay đổi sẵn; không được ghi đè/reset thay đổi đó. Audit này chưa sửa bất kỳ production source nào.

## 10. Ma trận verify bắt buộc sau sửa

| Gate | Cách kiểm | Tiêu chí đạt |
|---|---|---|
| Unit Pattern × Glyph | Cargo regression mới | Glyph pattern tạo đúng vùng pixel visible |
| Regression Pattern | `render_tiling_pattern` | Toàn bộ test cũ + test mới xanh |
| Regression Text | `render_text` | Toàn bộ test hiện hành xanh |
| Exact fixture | PDFium và PPE cùng DPI/kích thước | Logo hiện ở PPE; geometry/clip không lệch |
| Local ROI | So vùng `Hikari Fresh` | Không còn vùng bị bỏ; không dựa riêng whole-page score |
| Soundness success | Đọc diagnostics PPE | Khi render đúng: không warning giả |
| Soundness failure | Fixture pattern lỗi/unsupported | Không được đồng thời false-clean và mất object |
| Tauri viewer | Mở file thật ở `current` và PPE/accurate | Thumbnail và viewer chính đều có logo |
| Display control | PDFium display lane | Không hồi quy |
| Performance | Đo cùng DPI trên máy hiện tại | Không đặt hard cap vô điều kiện; máy ≥16 GB giữ full |

Lệnh baseline tối thiểu:

```powershell
cargo test --manifest-path "print_engine\Cargo.toml" --test render_tiling_pattern --test render_text
```

Sau đó chạy artifact probe trên đúng SHA-256 của file thật. Golden whole-page chỉ là gate bổ sung; acceptance chính phải có assertion local ROI/object-presence và diagnostics.

## 11. Trạng thái chốt duyệt

- **Root cause:** đã xác nhận.
- **Production code:** chưa sửa.
- **Artifact tạm:** đã dọn toàn bộ 13 file mang tiền tố riêng `viewer_pattern_logo_audit_20260831`; fixture gốc giữ nguyên hash và dung lượng.
- **Master audit matrix:** chưa cập nhật trong lượt này để tránh đụng file đang có thay đổi của người dùng; sẽ cập nhật sau khi lô sửa được duyệt và verify.
- **Khuyến nghị:** duyệt Lô A trước; chỉ cần Lô B nếu diagnostics/fallback contract chưa được khóa đầy đủ trong cùng semantic fix.

Chốt cần người dùng duyệt: **triển khai sửa Pattern × Glyph và fail-loud theo các lô trên**, hay giữ audit ở trạng thái báo cáo-only.

## 12. Addendum hậu triển khai Lô A — 2026-08-31

### 12.1 Phạm vi thay đổi

Lô A đã hoàn tất trong đúng phạm vi ba file, không sửa worker và không đụng thay đổi sẵn có của người dùng trong `print_engine/tests/render_text.rs`:

- `print_engine/src/content/interp.rs`;
- `print_engine/tests/render_tiling_pattern.rs`;
- báo cáo này.

Thay đổi semantic chính:

1. Glyph TrueType dùng Pattern cho fill hoặc stroke đi qua cùng `paint_with_pattern` như vector path; solid text vẫn giữ painter cũ và text clip vẫn dùng toàn outline.
2. `cs/CS` xoá tên Pattern đã chọn của đúng paint lane, nên tên từ colorspace cũ không thể sống lại khi quay về `/Pattern` mà chưa có `scn/SCN` mới.
3. Pattern thiếu/hỏng chỉ tăng `dropped_objects` và `skipped_ops` khi target còn coverage sau `path ∩ clip ∩ soft mask`; object bị clip hoặc soft mask triệt hết không tạo cảnh báo oan.
4. Fill và stroke là hai paint lane độc lập: nếu cả hai cùng mất trên object visible thì diagnostics đếm chính xác hai lần, mỗi lane một lần.
5. Nội dung trong tiling cell kế thừa loại host của object ngoài cho Output Preview, nhưng vẫn chịu bộ lọc source colorspace; owner được scope và phục hồi sau mỗi cell.
6. `cur_depth` được phục hồi sau khi chạy tiling cell trước khi paint lane kế tiếp bắt đầu, tránh stroke của `Tr 2/6` bị depth-cap oan sau fill.
7. Mọi nhánh không dựng được Pattern visible đều fail-loud; không có fallback bịa Pattern thành màu đặc.

Không cần thay đổi `render_worker.rs`: hợp đồng hiện hữu đã xử lý `dropped_objects > 0`; lỗ hổng nằm ở interpreter không phát tín hiệu và đã được khóa tại nguồn.

### 12.2 Regression và review

`render_tiling_pattern.rs` dùng DejaVuSans nhúng bắt buộc và Pattern nửa bước để chống false-positive do solid fallback. Ma trận mới khóa:

- fill Pattern × glyph trong local ROI;
- stroke Pattern × glyph trong local ROI;
- Pattern thiếu phải không bịa mực và phải fail-loud;
- Pattern colorspace chưa chọn tên;
- Pattern → màu thường → Pattern không được dùng lại tên cũ, cho cả fill và stroke;
- missing Pattern ngoài clip phải giữ diagnostics sạch cho cả hai lane;
- `Tr 2` và `Tr 6` tại `max_form_depth = 1` phải paint đủ fill + stroke;
- exact dual-lane count;
- Output Preview `Show=Text` và các lane loại trừ;
- line-art bị ẩn không tạo warning resource oan.

Kết quả verify cuối:

| Gate | Kết quả |
|---|---|
| `cargo fmt --manifest-path "print_engine/Cargo.toml" -- --check` | PASS |
| `render_tiling_pattern` | **24/24 PASS** |
| `render_text` | **16/16 PASS** |
| `render_shading` | **21/21 PASS** |
| `cargo test --manifest-path "print_engine/Cargo.toml"` | PASS; 374 unit pass, 2 benchmark thủ công ignored, toàn bộ integration xanh |
| `git diff --check` trên hai file Rust | PASS |
| Semantic re-review `semantic-review/2026-08-31-173648-pr-local.md` | **APPROVED — 0 issue** |

Semantic re-review xác nhận đóng đủ ba blocker cuối: stale Pattern selection, false fail-loud khi coverage bằng 0 và `cur_depth` rò từ cell fill sang stroke sibling. Review cũng xác nhận happy path không có thêm lượt raster visibility.

### 12.3 Bằng chứng trên PDF thật

Fixture được kiểm lại ngay trước probe:

- đường dẫn: `test\0 Trang bia.pdf`;
- dung lượng: `14.403.853` byte;
- SHA-256: `C74663A54A85B433D0F330FF78748ED0C31F7856A54F7EE6373939C4327995DD`.

Golden đo mực ở `100 DPI`:

| Chỉ số | Kết quả |
|---|---:|
| Verdict | **PASS** |
| Ghostscript max TAC | `318.824%` |
| PPE max TAC | `318.8%` |
| Chênh TAC | `-0.024` điểm |
| Worst plate MAE | `0.056/255` |
| PPE provenance | `dropped_objects=0`, `ink_unsound=false`, `degraded=false`, `skipped_ops=[]` |

Probe release của source hiện tại ở trang 1, `144 DPI`, chế độ viewer cho raster `1191×1685` và trả:

```text
dropped_objects = 0
ink_unsound      = false
degraded         = false
skipped_ops      = 0
```

ROI logo pin theo raster, gốc trái-trên `[450, 20, 780, 205]`:

| Metric | PDFium | PPE |
|---|---:|---:|
| Foreground pixel | `21.418` | `21.288` |
| Cấu trúc được phía kia hỗ trợ trong dung sai 2 px | `100,0%` | `100,0%` |

Kết quả này chứng minh logo `Hikari Fresh` đã trở lại trong PPE và hình học hai chiều khớp PDFium ở vùng lỗi; không chỉ dựa vào whole-page TAC.

### 12.4 Chốt trạng thái và giới hạn

- §PTXT.1 Pattern-filled glyph: **FIXED + VERIFIED**.
- §PTXT.2 false-clean khi Pattern visible bị bỏ: **FIXED + REGRESSION LOCKED**.
- §PTXT.3 test-interaction gap: **CLOSED** cho TrueType fill/stroke, diagnostics, clip, Output Preview và depth boundary của Lô A.
- Lô B thay worker: **không cần thiết cho root cause này**.
- Manual click-smoke trong Tauri ở cả `current` và PPE/accurate chưa chạy trong lượt Rust/probe này; đây vẫn là gate UI trước release, không phải khoảng trống của artifact engine đã đo.
- `docs/PRYNX_MASTER_AUDIT_MATRIX.md` chưa cập nhật để tránh đụng cây thay đổi ngoài lô.
- Bảy file probe mang tiền tố `viewer_pattern_logo_fix_20260831` và một example audit tạm đã được dọn sau khi số liệu được chốt; fixture gốc được giữ nguyên.

**Kết luận:** Lô A đạt tiêu chí nghiệm thu ở cấp semantic renderer, diagnostics, regression và fixture thật. Không còn blocker trong semantic re-review.