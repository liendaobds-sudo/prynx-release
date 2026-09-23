# Báo cáo audit toàn diện bù xén → đường cắt → Bình tem bế/CNC — 2026-09-23

Trạng thái: **AUDIT-ONLY / CHỜ DUYỆT SỬA**. Không sửa mã production trong lượt này.

## 1. Phạm vi và baseline

- Repo: `D:\pdfcompare`.
- HEAD commit: `703ffc2604ad5e5ff0ef391d9684e05688693c2b` (`2026-09-21`, PrynX 2.0.4).
- Working tree: **77 file tracked đang sửa + 13 file untracked**. Các thay đổi xuất ảnh/ICC, VDP, LiveLink và viewer không thuộc phạm vi chính được loại khỏi kết luận này, trừ khi chúng chạm trực tiếp contract bình bản.
- Lịch sử đối chiếu chính: `7de96fc` (preview đường bế/Simplify/Fairing), `d219a65` (bù xén lệch gương/page boxes), `8941dc0` (parity preview Tem/CNC), `19c334e` (session/manifest/đa tờ), `73b0240` (PrynX 2.0.4).
- Bằng chứng đọc/trace: `desktop/src/components/imposition-tools/**`, `desktop/src/lib/processHandlers.ts`, `backend/app/api/routes/imposition.py`, `backend/app/core/nesting_preview_capacity.py`, `backend/app/core/nesting_preview_session.py`, `backend/app/core/nesting_production_pipeline.py`, `backend/app/workers/nup_true_shape_nesting.py`, `nup_engine.py`, `nup_process_chunk.py`, `nup_artwork.py`, `nup_diecut.py`, `die_detection.py`, `cnc_render.py`, `cluster_tile_engine.py`.

### Đường chạy đã trace

1. **Bù xén/đường cắt:** `StickerTool`/`StickerCutlineTool` → working-file revision → `sticker_engine`/cutline preview → PDF có Trim/Bleed/MediaBox → `nup_engine`/`nup_process_chunk` → `place_one_artwork`/CUT writer.
2. **Nesting true-shape:** `ImposerDashboard`/`GridPreview` → `/preview-layout` hoặc preview-job → `build_nesting_preview` → `build_true_shape_nesting_job` → `solve_production_nesting_job` → RenderBundle/manifest → `nesting_imposition_render` → PDF Front/Back/Cut.
3. **CNC:** UI `cncFlipEdge`/`cncDuplexMarks`/cluster → request schema → `cnc_render` hoặc true-shape CNC → Front/Back/CUT + registration marks.

## 2. Tóm tắt điều hành

Các nâng cấp đã cải thiện rõ rệt việc giữ hình học nguồn, nhận diện nhiều đường bế/màu spot, lồng hình tròn, bàn giao manifest và parity finishing. Tuy nhiên working tree hiện **chưa an toàn để nghiệm thu production** vì có ba lỗi P1 mới nằm trên đường chạy thật:

1. Dashboard tự đổi `cut_stacks`/`ratio_stack` thành `sequential` trong hai lane hợp lệ.
2. Fast-path `targetQuantity=1` của preview N-Up trả duy nhất trang 0 dù contract định nghĩa số lượng chung áp cho mọi trang.
3. `bleed_mm` đã ảnh hưởng artwork clip/footprint nhưng bị bỏ khỏi `job_identity_key`, khiến đổi bù xén có thể tái sử dụng manifest/clip cũ.

Ngoài ra còn hai rủi ro P2: bù xén bất đối xứng bị ép theo trục nhỏ hơn và log preview đổi từ `debug` lên `info` trong route nóng. Chưa có bằng chứng Tauri runtime, bản cài hoặc thiết bị CNC vật lý trong lượt này.

## 3. Cải thiện đã xác minh

| Hạng mục | Thay đổi/đường chạy | Bằng chứng hiện có | Mức |
|---|---|---|---|
| Preview ↔ export/manifest | Session preview tạo manifest rồi handoff qua `job_identity_key`, RenderBundle và writer; finishing (pont, CUT, report, duplex) đi cùng contract | 517 test backend hẹp đạt; 147 test frontend imposition đạt; các artifact lịch sử trong `docs/BINH_TEM_BE_AUDIT_FIXES_2026-09-20.md` và `docs/BAO_CAO_AUDIT_PARITY_TEM_BE_CAT_XEN_CNC_2026-09-20.md` | AUTO + ARTIFACT lịch sử |
| Giữ bù xén true-shape | `nesting_production_pipeline.py:638-755` tạo `artworkClipPath`, footprint bao clip, và trừ phần bleed khỏi clearance để không đếm gap hai lần | Test helper trong `backend/tests/test_nesting_production_pipeline.py`; kiểm trực tiếp `derive_artwork_clip_path` cho clip 0,5 mm và 2 mm cho kết quả khác nhau | AUTO |
| Nhận diện đường bế nhiều màu/spot | `die_detection.py`, `pdf_content_parser.py`, `nup_diecut.py`, `nup_artwork.py` giữ `groups`, màu alternate Separation/DeviceN, lỗ khuôn và path Bézier gốc | `backend/tests/test_multi_color_die_cut.py`, test donut/spot/form XObject trong suite hẹp; không còn dùng polygon lấy mẫu để vẽ CUT | AUTO |
| Xếp hình tròn/elip | Thêm stagger theo cột và diagonal; collision guard kiểm cặp placement trước khi chọn candidate | `backend/tests/test_circle_vertical_stagger.py` và các test layout liên quan đạt | AUTO |
| Finishing/CNC preview | GridPreview đã nhận cluster cut CMYK/full-sheet/post-die marks, pont/guide, CNC duplex marks; backend truyền cùng field xuống writer | `GridPreview.pontMarks.test.tsx` đạt; test backend cluster/CNC/finishing trong lượt này đạt | AUTO/DOM; chưa runtime |
| Crop/origin và ảnh nguồn | `normalize_sticker_tight_crop_origin` chuẩn hóa gốc tight-crop; parser giữ màu spot alternate; source page cache giảm parse lặp | `test_sticker_page_canvas.py`, `test_multi_color_die_cut.py`, `test_sticker_homogeneous.py` đạt | AUTO |

Các mục trên không đồng nghĩa đã nghiệm thu GUI Tauri, release hoặc máy bế. Preview đúng không tự chứng minh mọi PDF output mới đúng nếu chưa parse/render artifact tương ứng.

## 4. Phát hiện đã xác nhận

### BXHAND23.01 — P1 — Dashboard nuốt lựa chọn Xếp chồng ở lane hợp lệ

**[CONFIRMED / AUTO + DOM]**

- Sink: `desktop/src/components/imposition-tools/ImposerDashboard.tsx:966-972`:

  ```ts
  if ((activeTool === 'sticker_imposer' || s.impositionUnit === 'sticker')
      && (s.layoutType === 'cut_stacks' || s.layoutType === 'ratio_stack')) {
      s.setLayoutType('sequential');
  }
  ```
- `impositionUnit='sticker'` là mặc định của store và cũng được dùng trong N-Up; vì vậy N-Up cắt xén không cần `activeTool='sticker_imposer'` vẫn bị ép về `sequential`.
- Khi `activeTool='sticker_imposer'` + `impositionUnit='page_sheet'`, điều kiện vế trái vẫn đúng; Nguyên tấm decal cũng bị ép về `sequential` dù profile/store cho phép `cut_stacks`.
- Probe DOM tạm mount **Dashboard thật + Zustand store thật** (đã dọn sau khi ghi bằng chứng): **2/2 ca đỏ**, đều nhận `sequential` thay vì `cut_stacks`. Bộ test hiện hữu 147/147 xanh vì chủ yếu kiểm store/section riêng, chưa mount Dashboard với trạng thái hợp lệ cần bảo toàn.
- Tác động: UI hiển thị/lưu một mode nhưng preview/export chạy mode khác; có thể đổi số tờ, thứ tự và quy tắc in bù.

**Đề xuất:** giới hạn safety effect theo đúng capability/lane; thêm regression mount Dashboard cho N-Up cắt xén và Nguyên tấm `page_sheet` với cả `cut_stacks` và `ratio_stack`.

### NEST23.01 — P1 — Fast-path quantity=1 làm rơi các trang còn lại khỏi preview

**[CONFIRMED / AUTO]**

- `backend/app/core/nesting_preview_capacity.py:362-386` coi `settings['targetQuantity'] == 1` là “một item tổng”, gọi `legacy_preview_for_page(0)` và trả ngay `cells[:1]`, `pageIdx=0`, không tạo session/manifest.
- Contract live ở `backend/app/workers/nup_true_shape_nesting.py:617-618` định nghĩa `targetQuantity` là **mặc định cho mọi trang tham gia**; override theo trang mới thay thế từng trang.
- Tái hiện trực tiếp bằng `build_nesting_preview`: request có ba trang CUSTOM, `target_quantity=1` và callback legacy thành công → kết quả `totalItems=1`, page duy nhất `[0]`. Cùng semantics với override `{0:1,1:1,2:1}` phải là ba mẫu.
- Tác động: preview báo thiếu hai mẫu/trang; export có thể đi đường job thật với nhiều `parts` nên preview ≠ output. Fast-path cũng bỏ session handoff, làm mất parity/provenance.

**Đề xuất:** chỉ fast-path khi đã chứng minh đúng một trang tham gia; nếu quantity chung áp nhiều trang, trả `sheets[]`/`placedByPage` theo toàn bộ trang hoặc bỏ fast-path và dùng session bình thường. Thêm test 3 trang: global=1, override 0/1, và S&R.

### NEST23.02 — P1 — `bleed_mm` không nằm trong cache identity

**[CONFIRMED / AUTO; artifact replay delegated còn proof gap runtime]**

- `ProductionNestingJobInput.bleed_mm` được thêm ở `backend/app/core/nesting_production_pipeline.py:176-180`; nó thay đổi clip/footprint/clearance tại `:628-650` và `:709-737`.
- `job_identity_key` tại `backend/app/core/nesting_preview_session.py:138-205` có gap, sheet-edge, obstacle và render specs nhưng **không đưa `job.bleed_mm` vào tuple**.
- Probe trực tiếp hai job cùng source/gap nhưng `bleed_mm=0.5` và `2.0`: `job_identity_key(a) == job_identity_key(b)` là `True`. Probe clip cho cùng polygon trả biên `±0.5` và `±2.0` khác nhau.
- Agent audit đã replay cache hit với hai artifact bleed khác nhau nhưng cùng session; bằng chứng artifact đó chưa được lưu trong repo của lượt này nên chưa nâng lên `ARTIFACT/RUNTIME` ở đây.
- Tác động: user đổi bù xén nhưng preview/export có thể lấy lại manifest cũ, làm vòng bù mất hoặc thừa mà không báo lỗi.

**Đề xuất:** thêm `float(job.bleed_mm)` vào `job_identity_key`, bổ sung regression assert cache miss + artifact clip khác nhau khi chỉ đổi bleed.

### BXHAND23.03 — P2 — Hở bất đối xứng bị ép theo trục nhỏ hơn

**[CONFIRMED / AUTO về dữ liệu; chất lượng artifact chưa khóa]**

- `_assemble_nesting_job` ghi một scalar `bleed_mm`; `solve_production_nesting_job` tính `retained_bleed_mm = min(gap_x/2, gap_y/2, bleed_mm)` tại `backend/app/core/nesting_production_pipeline.py:709-723`.
- Với gap X=4 mm, Y=2 mm, bleed nguồn=2 mm, ngân sách hợp lý là X=2/Y=1 mm nhưng contract hiện chỉ có một giá trị 1 mm cho cả hai trục. `derive_artwork_clip_path` buffer đồng đều nên mất 1 mm bù hợp lệ theo trục X.
- Không gây chồng lấn (đây là lựa chọn bảo thủ), nhưng không đạt mục tiêu giữ tối đa phần bù xén theo từng chiều và làm giảm chất lượng/sức chứa không cần thiết.

**Đề xuất:** chuyển retained bleed thành `AxisGapMm`/hai trục trong RenderBundle, clearance và clip; thêm artifact bất đối xứng trước khi sửa writer.

### PERF23.01 — P2 — Preview timing bị ghi ở INFO trong route nóng

**[CONFIRMED / SOURCE]**

- `backend/app/api/routes/imposition.py:2313-2316` đổi `_plog` từ `logger.debug` sang `logger.info`.
- `_plog` được gọi ở khoảng mười điểm mỗi request (`:2384`, `:2399`, `:2401`, `:2430`, `:2496`, `:2523`, `:2882`, `:4060`, `:4090`, `:4160`, `:4243`, `:4300`).
- Tác động: log production luôn phát sinh cho mỗi preview, tăng I/O/nhiễu và có thể kéo dài hot path dưới nhiều job. Quy tắc audit của repo yêu cầu trace trong vòng nóng dùng `debug` và guard.

**Đề xuất:** giữ timing chi tiết ở `debug`/telemetry opt-in; nếu cần INFO thì chỉ ghi một summary sau request và không format chuỗi ở mọi checkpoint.

## 5. Điều đã kiểm và không coi là bug mới

- Gap=0 làm clip sát đường bế là **control hình học có chủ đích**, không tự gọi là lỗi; lỗi trước đây là UI ẩn tham số/true-shape dùng clip sai. Xem `docs/BAO_CAO_AUDIT_BU_XEN_SANG_BINH_TEM_BE_2026-09-21.md`.
- Overlay/viền đỏ tắt khi đổi tool không chứng minh artwork bleed bị xóa; cần phân biệt SVG overlay với PDF output. Báo cáo cũ đã tái hiện mất bleed trong artifact sau bình, không gán cho mọi lần chuyển tab.
- True-shape chỉ auto-route khi đúng `optimal_auto` + CUSTOM/điều kiện rollout; không suy rộng rằng mọi hình/lane đều dùng native solver.
- Các claim parity lịch sử được giữ đúng phạm vi artifact đã kiểm; không nâng thành `RUNTIME` vì chưa chạy Tauri/bản cài/máy bế.

## 6. Verify trong lượt audit

### Backend

```text
517 passed, 1 Pydantic deprecation warning
```

Suite hẹp gồm nesting production/preview/session, CNC, finishing, clip/render, die detection, multi-color spot, circle stagger, sticker page canvas, homogeneous và shape classifier. Đây không phải full backend suite.

### Frontend

```text
npm run typecheck                 PASS
5 file targeted                  147 passed
audit Dashboard probe            2 failed (đỏ đúng 2 regression BXHAND23.01)
```

`git diff --check` còn **11 cảnh báo blank line ở EOF** trong các file đang sửa; không phải lỗi runtime nhưng phải dọn trước commit/lô sửa.

## 7. Coverage và proof gap

- Chưa chạy Tauri desktop thật, bản cài/release, native Windows drop/picker, nhiều tab, restart/reload session.
- Chưa build lại Rust/maturin hoặc bundle sidecar; chưa chạy `cargo check`/maturin cho thay đổi native (đợt này chủ yếu Python/TS).
- Chưa parse/render một PDF khách mới sinh ra bởi chính working tree sau các thay đổi hiện tại; artifact lịch sử trong `docs/` chỉ là bằng chứng cho commit/lô tương ứng.
- Chưa kiểm vật lý máy bế/CNC, Illustrator/CorelDRAW/Graphtec, dấu canh ngoài vùng artwork, dung sai cơ khí.
- Chưa chạy full `backend/tests` và full Vitest trong lượt này; 517/147 là suite hẹp.
- Test hiện hữu thiếu ma trận cache key theo bleed, quantity global nhiều trang, hở X/Y bất đối xứng, và mount Dashboard bảo toàn layout.

## 8. Thứ tự sửa đề xuất (mỗi lô ≤5 file, chờ duyệt)

1. **Lô A — parity UI (P1):** `ImposerDashboard.tsx` + test mount Dashboard. Sửa safety effect theo capability/lane.
2. **Lô B — quantity fast-path (P1):** `nesting_preview_capacity.py` + test preview route/3 trang. Không thay policy quantity chung.
3. **Lô C — bleed cache (P1):** `nesting_preview_session.py` + regression test cache miss + artifact clip.
4. **Lô D — asymmetric bleed (P2):** `nesting_production_pipeline.py`, `nup_true_shape_nesting.py`, schema/adapter/test artifact. Thiết kế contract hai trục trước khi sửa writer.
5. **Lô E — logging/hygiene (P2/P3):** hạ `_plog` về debug/summary; dọn 11 blank-line EOF trong đúng file đã duyệt.

**Chốt duyệt:** Không áp dụng các lô trên cho đến khi user xác nhận danh sách/ưu tiên. Báo cáo này chỉ ghi bằng chứng và đề xuất.
