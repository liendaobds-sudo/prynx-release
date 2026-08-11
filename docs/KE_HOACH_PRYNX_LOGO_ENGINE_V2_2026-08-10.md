# Kế hoạch phát triển — PrynX Logo Engine v2

**Ngày lập:** 2026-08-10  
**Trạng thái:** Chờ duyệt; chưa sửa mã engine  
**Phạm vi:** Lõi vector hóa logo riêng của PrynX, tích hợp dần vào tính năng `logo_rebuild` hiện có  
**Nguyên tắc:** Clean-room; chỉ tham khảo hành vi/kiến trúc Inkscape, không sao chép hoặc chuyển ngữ mã GPL  
**Cờ phát hành:** Tiếp tục `HOLD/NO-GO` cho tới khi qua đủ cổng artifact, runtime và holdout

Tài liệu này kế thừa kế hoạch MVP `KE_HOACH_PHAT_TRIEN_PHUC_HOI_VECTOR_LOGO_2026-07-29.md` và các
lô A–E đã ghi trong `LOGO_REBUILD_FIXES_2026-08-09.md`; không xây lại phần đã hoàn thành.

## 1. Quyết định điều hành

PrynX không thay toàn bộ tính năng Logo hiện tại. Các phần đã có bằng chứng và tiếp tục được giữ:

- scheduler, RAM reservation, cancel và lifecycle;
- crop, nắn phối cảnh, palette do người dùng xác nhận và loại nền;
- dirty-session, Save SVG, định tuyến nhiều tab;
- zoom/pan/A-B/overlay và complexity panel;
- hợp đồng kích thước vật lý mm;
- output-QC `ready | review | rejected`;
- i18n, accessibility và production fail-closed.

Logo Engine v2 chỉ thay phần lõi từ ảnh RGBA đã chuẩn hóa tới hình học vector và metadata QC. VTracer
được giữ làm **engine đối chứng/fallback** trong giai đoạn chuyển tiếp; không xóa trước khi engine riêng
đạt parity và có runtime/artifact proof.

## 2. Baseline hiện tại

Đường chạy đang dùng:

```text
LogoRebuildWorkspace
  → logoRebuildApi.ts
  → routes/logo_rebuild.py
  → heavy_job_scheduler
  → workers/logo_rebuild.py
  → native/logo_vectorizer.rs
  → VTracer trả chuỗi SVG
  → Python parse + cleanup + QC chuỗi SVG
  → API response
  → preview/save SVG
```

Điểm mạnh hiện tại:

- hai mode đã được giới hạn đúng bằng chứng: `monochrome` và `fixed_palette`;
- fixed palette dùng Cutout, tránh lớp màu chồng dư;
- native chạy ngoài GIL, có cancel và panic boundary;
- backend kiểm topology/QC, kích thước mm và artifact cuối;
- UI không cho xuất khi `rejected`, yêu cầu xác nhận khi `review`.

Khoảng trống Engine v2 phải đóng:

1. Native trả chuỗi SVG nên backend phải parse lại để hiểu hình học và QC.
2. Không có IR trung gian giữ outer/hole, fill/stroke, winding và provenance.
3. Callback progress của VTracer hiện bị bỏ qua; UI chỉ biết trạng thái tổng.
4. Chưa có profile centerline cho chữ ký/nét mảnh và profile pixel-art có kiểm soát.
5. Chưa có corpus holdout logo khách kèm vector gốc đủ để chốt chất lượng.
6. Chưa có artifact/runtime proof trên Tauri, Illustrator/CorelDRAW/Inkscape và bản cài sạch.

## 3. Mục tiêu và ngoài phạm vi

### 3.1 Mục tiêu lõi

- Viết lõi vector hóa riêng bằng Rust, không phụ thuộc mã Inkscape/Potrace/AutoTrace/Libdepixelize.
- Dùng một mô hình vector trung gian có cấu trúc trước khi ghi SVG.
- Tách rõ `preprocess → trace → postprocess → QC → writer`.
- Hỗ trợ ít nhất silhouette và flat-color bằng thuật toán riêng trước khi thêm profile khác.
- Giữ compound counter của O/P/R/B, dấu tiếng Việt và màu nhấn nhỏ.
- Có progress/cancel theo phase, kết quả deterministic và cost estimate theo engine.
- So preview với artifact render lại; không suy chất lượng từ object trung gian.

### 3.2 Ngoài phạm vi Engine v2 lõi

- Không tự dựng lại phần logo đã bị che/mất.
- Không đoán font thương hiệu rồi thay outline.
- Không xử lý logo ảnh chụp/gradient phức tạp như artwork phẳng.
- Không làm trình biên tập vector tổng quát kiểu Inkscape/Illustrator.
- Không mở production chỉ vì unit test xanh.
- Không thêm AI/cloud hoặc gửi ảnh ra ngoài.
- Không làm round-trip project PrynX trong giai đoạn lõi; đây là roadmap riêng sau GO export-SVG.

## 4. Ranh giới clean-room và giấy phép

Nguồn Inkscape được khảo sát tại commit
`eb8e143091e1f8e1618433fd83e7d7c1d8e2af40`. Phần lớn source là
`GPL-2.0-or-later`, binary tổng thể theo `COPYING` là `GPL-3.0-or-later`.

Quy tắc bắt buộc:

1. Chỉ ghi nhận hành vi, bất biến, input/output và ý tưởng kiến trúc.
2. Không copy hoặc dịch mã, comment, constant, cấu trúc control-flow hay fixture của Inkscape.
3. Không dùng adapter Potrace/AutoTrace/Depixelize từ Inkscape trong PrynX.
4. Thuật toán được đặc tả bằng ngôn ngữ riêng, dựa trên kiến thức/paper gốc và phép đo của PrynX.
5. Mọi dependency mới phải audit license trước; ưu tiên MIT/Apache-2.0/BSD.
6. Dependency GPL/LGPL/MPL không được thêm vào binary phát hành nếu chưa có quyết định pháp lý riêng.
7. `THIRD_PARTY_NOTICES.md` và lockfile phải được cập nhật khi dependency thực sự thay đổi.
8. Bản clone tham khảo chỉ nằm ở thư mục tạm, không vendor vào repo.

## 5. Kiến trúc mục tiêu

```text
Ảnh RGBA đã chuẩn hóa + hợp đồng palette/mm/selection
  ↓
PreprocessArtifact
  - alpha/visible mask
  - indexed palette map
  - connected components
  - warnings + cost estimate
  ↓
Profile Router
  ├─ SilhouetteTracer
  ├─ FlatColorTracer
  ├─ CenterlineTracer       (sau core GO)
  └─ PixelArtTracer         (tùy chọn, sau core GO)
  ↓
VectorScene
  - layers/paint
  - fill rings + hole tree
  - open strokes + width
  - line/cubic segments
  - coordinate system + provenance
  ↓
Postprocess
  - topology normalization
  - corner classification
  - curve fitting/simplify theo sai số
  - duplicate/degenerate removal
  ↓
QualityReport
  - topology + complexity
  - raster fidelity
  - color/small-accent fidelity
  - physical-size contract
  ↓
SvgWriter
  ↓
SVG artifact + structured metrics
```

### 5.1 Quyền sở hữu theo tầng

| Tầng | Trách nhiệm |
|---|---|
| Frontend | Chọn file/vùng/profile, chỉnh palette/mm, hiển thị progress và QA |
| Backend | Decode/EXIF/ICC, scheduler/RAM, hợp đồng API, quản lý job và artifact |
| Rust native | Preprocess vector, trace, topology, curve fitting, QC hình học và SVG writer |
| Release | Ghim engine/capabilities, smoke ABI và production fail-closed |

Backend tiếp tục decode/ICC bằng Pillow ở giai đoạn đầu để tránh đổi hai biến lớn cùng lúc. Chỉ chuyển
decode vào Rust nếu benchmark chứng minh lợi ích và có lô riêng.

## 6. Mô hình VectorScene

IR tối thiểu:

```text
VectorScene
  canvas_px: width × height
  layers[]
    paint: solid RGBA
    geometry:
      FillRegion
        rings[]
          role: outer | hole
          winding: cw | ccw
          segments: line | cubic
      hoặc StrokePath
        closed: bool
        width_px
        segments: line | cubic
  physical_size_mm: optional pair
  provenance
    profile
    settings hash
    engine version
  metrics
```

Bất biến:

- hệ tọa độ duy nhất: gốc trên-trái, pixel-space; writer chịu trách nhiệm xuất SVG;
- ring không tự cắt, không NaN/Inf, không suy biến;
- outer/hole được lưu rõ, không suy lại chỉ từ thứ tự path;
- màu khác nhau không bị union hoặc simplify chung;
- open stroke không bị tự đóng thành fill;
- `VectorScene` không chứa XML/SVG string;
- cùng input + settings + engine version cho cùng scene hash.

## 7. Thiết kế các profile

### 7.1 SilhouetteTracer — core MVP

Áp dụng cho logo đơn sắc, con dấu và chữ đậm.

Pipeline dự kiến:

1. nhận binary/alpha mask đã xác định polarity;
2. connected-component labeling;
3. contour extraction trên lưới half-pixel;
4. giải quyết saddle/diagonal theo connectivity tường minh;
5. dựng cây outer/hole;
6. phân loại corner;
7. fit line/cubic theo error tolerance;
8. QC topology và raster lại.

### 7.2 FlatColorTracer — core MVP

Áp dụng cho logo 1–12 màu do người dùng xác nhận.

- ánh xạ pixel về palette bằng không gian màu phù hợp, không dùng RGB distance thuần;
- alpha=0 không tham gia palette;
- bảo vệ màu nhấn nhỏ có vùng liên kết và chroma đủ rõ;
- mỗi pixel thuộc đúng một nhãn màu;
- vùng màu sinh theo cutout, không có lớp tổng chồng bên dưới;
- background là nhãn tường minh và bị loại trước writer;
- trace từng nhãn nhưng chuẩn hóa biên chung để hạn chế khe/hở do làm tròn.

### 7.3 CenterlineTracer — sau core GO

Áp dụng cho chữ ký, line-art và nét bút.

- skeleton/medial representation;
- prune nhánh ngắn có bảo vệ đầu nét;
- ước lượng độ rộng từ distance field;
- trả `StrokePath`, không giả thành fill kín;
- fit curve theo sai số pháp tuyến và continuity;
- từ chối nếu mask là mảng fill lớn không phù hợp centerline.

### 7.4 PixelArtTracer — tùy chọn

Chỉ áp dụng cho ảnh nhỏ, cạnh sắc, ít anti-alias.

- phát hiện pixel-art bằng số màu, edge sharpness và block consistency;
- trace biên cell/grid theo nhãn màu;
- resolve kết nối chéo có quy tắc;
- cho phép output góc vuông hoặc bo có kiểm soát;
- không hard-cap 256 px; admission theo cost/RAM và đặc tính ảnh.

## 8. Corpus và oracle

### 8.1 Corpus bắt buộc

| Nhóm | Tối thiểu | Ground truth |
|---|---:|---|
| Silhouette có counter | 12 | vector gốc hoặc SVG tự dựng |
| Chữ Việt có dấu | 12 | vector gốc |
| Flat-color 2–4 màu | 15 | vector gốc + palette |
| Flat-color 5–12 màu | 10 | vector gốc + palette |
| Màu nhấn dưới 1% | 8 | mask/màu vùng nhấn |
| JPEG/noise/halo | 10 | vector gốc hoặc raster sạch |
| Centerline | 10 | stroke/vector gốc, chỉ dùng khi làm profile |
| Pixel-art | 8 | grid/palette gốc, chỉ dùng khi làm profile |
| Ca phải từ chối | 15 | lý do từ chối đã duyệt |

Ảnh khách thật không nhất thiết commit vào repo. Có thể lưu ngoài repo với manifest gồm hash, quyền sử
dụng, profile, kích thước, nhãn và kết quả baseline. Test tự động trong repo ưu tiên fixture synthetic
sinh bằng code để tránh bản quyền và giảm số file.

### 8.2 Chỉ số

- **Topology:** số component/hole, Euler characteristic, self-intersection, winding/fill-rule.
- **Raster fidelity:** IoU/MAE và distance biên; render ít nhất 4× cho cạnh cong nhỏ.
- **Color:** DeltaE trên vùng phẳng, recall của màu nhấn nhỏ, không tính RGB ẩn dưới alpha=0.
- **Complexity:** path, node, node/chu vi, tiny-path ratio và byte SVG.
- **Determinism:** scene hash/artifact hash ổn định sau khi bỏ metadata biến thiên.
- **Performance:** p50/p95, peak RSS, cancel latency, queue latency và time-to-first-preview.
- **Physical:** `viewBox`, tỷ lệ và cặp mm parse lại từ artifact.

Không dùng một điểm quality tổng để che lỗi topology. Sai counter, mất dấu hoặc sai kích thước mm là
fail độc lập dù tổng điểm cao.

## 9. Các giai đoạn và cổng duyệt

### G0 — Đặc tả clean-room và baseline

Đầu ra:

- spec `VectorScene` và coordinate contract;
- manifest corpus/holdout;
- baseline VTracer hiện tại trên cùng corpus;
- tiêu chí GO/NO-GO theo từng profile;
- audit dependency/license.

**Cổng:** chủ dự án duyệt spec và corpus trước khi viết tracer riêng.

### G1 — IR + legacy adapter, không đổi output

Đầu ra:

- module `logo_engine` và `VectorScene`;
- VTracer vẫn là engine thực thi nhưng nằm sau interface mới;
- scene/result có version và provenance;
- output hiện tại không thay đổi ngoài metadata deterministic đã duyệt.

**Cổng:** toàn bộ regression hiện tại xanh; artifact VTracer trước/sau adapter parity.

### G2 — Silhouette + flat-color engine riêng

Đầu ra:

- preprocess/index map;
- contour/topology;
- curve fit/simplify;
- hai profile core không dùng VTracer;
- writer và QC có cấu trúc.

**Cổng:** synthetic topology 100%; holdout không mất counter/dấu/màu nhấn; không tệ hơn VTracer trên
fidelity và giảm hoặc giữ hợp lý complexity.

### G3 — Tích hợp backend và progress

Đầu ra:

- ABI native trả structured result + SVG artifact;
- backend không parse SVG để suy lại các metric native đã biết;
- progress theo phase, cancel terminal đúng một lần;
- fallback VTracer chỉ dùng khi cờ dev tường minh bật.

**Cổng:** backend/API regression xanh; queue/cancel/RAM test đủ ba tier.

### G4 — Frontend QA và runtime

Đầu ra:

- profile/capabilities/progress trong workspace;
- preview mask/index-map tùy chọn phục vụ chẩn đoán;
- runtime Home → file → preview → cancel → save;
- SVG mở 1:1 trong ít nhất hai phần mềm chế bản.

**Cổng:** Mức 3 runtime cho workflow chính; artifact mở lại đúng mm/màu/topology.

### G5 — Centerline, pixel-art và release

Centerline và pixel-art là profile độc lập, chỉ bắt đầu sau core G2–G4. Mỗi profile có corpus, cổng và
release flag riêng. Không để profile mới chặn phát hành core silhouette/flat-color đã đạt.

## 10. Chia lô triển khai

Mỗi lô tối đa 5 file. Hết lô phải verify và cập nhật log trước khi sang lô kế.

### Lô A — Facade và VectorScene, 5 file

1. `native/src/logo_engine/mod.rs` — interface/profile router.
2. `native/src/logo_engine/scene.rs` — IR và invariant.
3. `native/src/logo_engine/request.rs` — request/version/settings hash.
4. `native/src/logo_vectorizer.rs` — adapter tương thích ABI cũ.
5. `native/src/lib.rs` — đăng ký facade/capabilities.

Không đổi hành vi sản phẩm. Unit test đặt trong module mới để không tăng file.

### Lô B — Preprocess và màu, 5 file

1. `native/src/logo_engine/preprocess.rs`.
2. `native/src/logo_engine/color.rs`.
3. `native/src/logo_engine/scene.rs`.
4. `native/src/logo_engine/mod.rs`.
5. `native/src/logo_engine/preprocess_tests.rs`.

### Lô C — Contour và topology, 5 file

1. `native/src/logo_engine/contour.rs`.
2. `native/src/logo_engine/topology.rs`.
3. `native/src/logo_engine/scene.rs`.
4. `native/src/logo_engine/mod.rs`.
5. `native/src/logo_engine/topology_tests.rs`.

### Lô D — Curve fit và simplify, 5 file

1. `native/src/logo_engine/curve_fit.rs`.
2. `native/src/logo_engine/simplify.rs`.
3. `native/src/logo_engine/scene.rs`.
4. `native/src/logo_engine/mod.rs`.
5. `native/src/logo_engine/curve_fit_tests.rs`.

### Lô E — Hai profile core, 5 file

1. `native/src/logo_engine/profiles/mod.rs`.
2. `native/src/logo_engine/profiles/silhouette.rs`.
3. `native/src/logo_engine/profiles/flat_color.rs`.
4. `native/src/logo_engine/mod.rs`.
5. `native/src/logo_engine/profile_tests.rs`.

### Lô F — Writer và QC artifact, tối đa 5 file

1. `native/src/logo_engine/svg_writer.rs`.
2. `native/src/logo_engine/qc.rs`.
3. `native/src/logo_engine/mod.rs`.
4. `native/src/logo_engine/artifact_tests.rs`.
5. `native/Cargo.toml` chỉ khi dependency render/test mới đã qua audit license và benchmark build.

Không thêm dependency chỉ để lấp đủ file. Mặc định ưu tiên primitives đã có trong PrynX.

### Lô G1 — ABI structured result, tối đa 4 file

1. `native/src/logo_engine/result.rs`.
2. `native/src/logo_vectorizer.rs`.
3. `native/src/lib.rs`.
4. `native/src/logo_engine/api_tests.rs`.

### Lô G2 — Backend dùng structured result, 5 file

1. `backend/app/workers/logo_rebuild.py`.
2. `backend/app/workers/logo_svg_cleanup.py`.
3. `backend/app/schemas/logo_rebuild.py`.
4. `backend/app/api/routes/logo_rebuild.py`.
5. `backend/tests/test_logo_rebuild.py`.

`logo_svg_cleanup.py` chưa xóa ngay; giữ validator artifact độc lập cho tới khi parity đủ bằng chứng.

### Lô H — Progress và frontend contract, 5 file

1. `desktop/src/lib/logoRebuildApi.ts`.
2. `desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx`.
3. `desktop/src/components/preprocess-tools/LogoRebuildWorkspace.test.tsx`.
4. `desktop/src/i18n/locales/vi.json`.
5. `desktop/src/i18n/locales/en.json`.

### Lô I — Centerline native, 5 file, chỉ sau core GO

1. `native/src/logo_engine/skeleton.rs`.
2. `native/src/logo_engine/profiles/centerline.rs`.
3. `native/src/logo_engine/profiles/mod.rs`.
4. `native/src/logo_engine/mod.rs`.
5. `native/src/logo_engine/centerline_tests.rs`.

Backend/frontend cho centerline phải là các lô riêng, không chen vào Lô I.

### Lô J — Pixel-art, để sau

Chỉ lập file list sau khi có corpus và quyết định sản phẩm. Không dùng giới hạn 256 px của Inkscape;
cost gate phải theo RAM/cấu trúc ảnh và máy `>=16 GB` giữ full công suất.

### Lô K — Release smoke

Không dự kiến sửa `build_production.ps1` nếu engine vẫn nằm trong `pdfcompare_native`; maturin hiện đã
đóng gói crate này. Chỉ mở lô sửa build khi smoke chứng minh thiếu artifact/dependency. Nếu phải sửa,
phạm vi tối đa gồm:

1. `build_production.ps1`.
2. `desktop/src-tauri/build.rs`.
3. `desktop/src-tauri/src/main.rs`.
4. `THIRD_PARTY_NOTICES.md`.
5. self-test pipeline liên quan.

Không đặt `[profile.release]` trong `Cargo.toml`; LTO chỉ qua env của pipeline production.

## 11. Ma trận verify theo lô

| Lô | Verify hẹp bắt buộc |
|---|---|
| A | `cargo fmt --check`, `cargo check --locked`, Rust scene/ABI unit tests, legacy artifact parity |
| B | alpha/palette/small-accent/color-distance synthetic; deterministic hash |
| C | O/P/R/B, nested holes, touching corner, saddle, self-intersection, all-transparent |
| D | line/circle/cubic/corner; max error, tangent continuity, node regression |
| E | silhouette + 2/4/8/12 màu, background cutout, dấu Việt, counter |
| F | parse SVG, render lại, topology/MAE/IoU/mm, empty/NaN/oversize reject |
| G1/G2 | PyO3 ABI, panic boundary, cancel, backend API, old/new engine parity |
| H | typecheck, workspace/i18n/routing, stale revision, cancel/progress terminal |
| I | open-stroke, branch prune, width estimate, không tự đóng path |
| K | maturin dev, Nuitka sidecar, Tauri installer, offline clean-user smoke |

Sau mọi thay đổi Rust:

1. `cargo test` phạm vi Logo;
2. `cargo check --locked`;
3. `maturin develop --release` trước backend integration;
4. backend Logo regression;
5. desktop Logo regression + typecheck nếu contract thay đổi;
6. runtime Tauri cho workflow chính.

## 12. Chính sách hiệu năng

- Không hard-cap worker, độ phân giải hoặc chất lượng cho mọi máy.
- Máy `<8 GB` được giảm mạnh và cảnh báo.
- Máy `8–16 GB` được giảm nhẹ theo byte budget thực.
- Máy `>=16 GB` giữ full quality/concurrency khi RAM thực đủ.
- Mỗi profile khai báo `estimate_cost(width, height, colors, components)`; scheduler quyết định admission.
- Preview nhẹ không được xếp sau job nặng nếu có thể dùng artifact preprocess đã cache.
- Cache chỉ dùng key content hash + settings + engine version; cache stale phải bị loại.
- Cancel latency mục tiêu dưới 250 ms tại các checkpoint Rust; không hứa nếu dependency/final writer không
  thể bị ngắt, nhưng phải ghi rõ phase đang chặn.

Benchmark tối thiểu trên ba hồ sơ RAM và ít nhất hai lớp CPU. Hồi quy máy mạnh là lỗi chặn merge.

## 13. Cổng GO production

Chỉ đề xuất bật cờ production khi đồng thời đạt:

1. Core silhouette/flat-color không phụ thuộc VTracer ở đường chính.
2. Counter/hole topology đạt 100% corpus bắt buộc.
3. Không mất dấu Việt hoặc màu nhấn nhỏ trong holdout đã duyệt.
4. Structured result và SVG artifact thống nhất; validator độc lập không phát hiện lệch.
5. Cancel/queue/RAM qua ba tier, máy mạnh không bị giảm vô điều kiện.
6. SVG mở đúng 1:1 trong ít nhất hai phần mềm chế bản.
7. Tauri runtime Home → nhận file → preview → QA → cancel → save đạt.
8. Installer sạch chạy offline và engine capabilities đúng.
9. Dependency/license/NOTICE hoàn chỉnh; không có mã hoặc fixture GPL sao chép.
10. VTracer fallback có quyết định rõ: giữ dev-only hoặc gỡ ở lô riêng sau parity.

Centerline và pixel-art không phải điều kiện GO của core nếu UI/copy không quảng bá hai profile đó.

## 14. Ước lượng

| Giai đoạn | Ngày công ước lượng |
|---|---:|
| G0 spec/corpus/baseline | 3–5 |
| G1 IR + legacy adapter | 3–5 |
| G2 contour/topology/curve + hai profile core | 10–16 |
| G3 backend/ABI/progress | 4–7 |
| G4 frontend/runtime/artifact | 4–7 |
| Hardening/release core | 4–6 |
| Centerline sau core GO | 5–8 |
| Pixel-art tùy chọn | 4–6 |

Core Engine v2 dự kiến **28–46 ngày công**, chưa gồm centerline/pixel-art. Đây là ước lượng kỹ thuật,
không phải cam kết lịch; corpus và số lỗi topology thực tế quyết định thời gian.

## 15. Rủi ro và phương án

| Rủi ro | Phương án |
|---|---|
| Viết engine mới kém VTracer | Giữ fallback/benchmark song song; không đổi default trước G2 |
| Curve fit giảm node nhưng méo chữ | Gate bằng max boundary error + holdout chữ Việt |
| Biên chung các màu tạo khe | Shared boundary normalization trước fit curve |
| Cleanup Rust và Python lệch | Chạy validator độc lập song song tới khi parity đủ lâu |
| IR/ABI làm tăng copy RAM | Benchmark serialized/typed result; SVG vẫn sinh trong Rust |
| Centerline bị dùng nhầm cho fill | Classifier + user profile + fail-closed suitability check |
| Dependency mới làm build chậm | Ưu tiên code local/primitives có sẵn; benchmark dev/release trước nhận dep |
| GPL contamination | Clean-room record, không vendor/copy, audit diff và NOTICE từng lô |
| Scope phình thành vector editor | Giữ editor ngoài core; chỉ thêm thao tác phục vụ QA/in ấn |

## 16. Chốt duyệt

Tài liệu này là kế hoạch, chưa cho phép sửa mã. Bước tiếp theo sau khi chủ dự án duyệt là **G0/Lô A
đặc tả + facade**, không bắt đầu đồng thời contour, frontend và centerline.

Mỗi lô phải:

- tối đa 5 file;
- có baseline đỏ/xanh hoặc artifact parity trước sửa;
- verify hẹp rồi hồi quy Logo;
- cập nhật log `docs/LOGO_ENGINE_V2_FIXES_2026-08-10.md`;
- dừng nếu có hồi quy chất lượng, RAM hoặc runtime.
