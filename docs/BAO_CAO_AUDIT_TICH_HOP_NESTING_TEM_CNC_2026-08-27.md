# BÁO CÁO AUDIT TÍCH HỢP NESTING VÀO BÌNH TEM BẾ / BÌNH CNC

**Ngày:** 2026-08-27
**Trạng thái:** CHỜ DUYỆT — mới audit, chưa sửa mã nguồn
**Phạm vi:** tính năng Bình lồng ghép tự do, Bình tem bế và Bình bế rớt/CNC
**Mức bằng chứng:** trace dọc mã nguồn + test tự động + benchmark bridge native trên corpus tổng hợp hiện có

## 1. Kết luận điều hành

Ý định sản phẩm đúng là **bổ sung một thuật toán xếp mới vào mục “Cách xếp” của Bình tem bế và Bình CNC**, không phải tạo thêm một công cụ sản xuất độc lập.

Kết luận audit:

1. **Nên tích hợp.** Lõi `mixed_nesting` bằng Rust có nhiều phần đáng giữ: chuẩn hóa hình học, kiểm tra va chạm, NFP/IFP, sinh ứng viên, validator, score, manifest xác định và bộ test tương đối dày.
2. **Không nên nối nguyên công cụ độc lập vào Imposition.** Công cụ hiện tại có UI, job, parser và exporter riêng; exporter chỉ vẽ đường contour, không xuất được artwork, mặt sau CNC, boong, dấu canh và báo cáo sản xuất.
3. **Điểm ghép đúng là tầng tạo placement.** Bình tem bế/CNC tiếp tục sở hữu resolver nguồn, preview, writer, artifact lifecycle và báo cáo. Kernel mới chỉ nhận hình học/quantity/tờ/vùng cấm và trả về một placement manifest đã kiểm chứng.
4. **Giá trị sớm nhất nằm ở bài toán nhiều mẫu.** Bình tem bế một mẫu đã có thuật toán shape-aware; nhánh nhiều mẫu của Tem bế và CNC hiện chủ yếu pack bounding box bằng MaxRects.
5. **Có thể triển khai an toàn theo hai nấc:**
   - Nấc 1: true-shape nesting với các góc rời rạc `0/90` hoặc `0/90/180/270`, giữ renderer hiện tại. Khả thi cao, rủi ro vừa.
   - Nấc 2: góc tự do thật sự, sau khi nâng placement/render contract, artwork, clipping, đường bế, preview và phản chiếu mặt sau. Khả thi nhưng effort lớn, rủi ro cao.
6. **Chất lượng “tối ưu” chưa được chứng minh trên dữ liệu sản xuất.** Corpus hiện chỉ có bốn case tổng hợp; benchmark chưa cho thấy giảm số tờ hay cải thiện layout trên corpus đó. Cần A/B với corpus Tem/CNC thật trước khi rollout.

Không phát hiện P0. Có các blocker P1 phải giải quyết trước khi bật trong production.

## 2. Phạm vi và baseline audit

- Baseline được khảo sát trên branch `codex/pre-release-audit-2026-08-04`, HEAD `47afe41`.
- Worktree đã có nhiều thay đổi của đội ngũ trước audit; phần Mixed Nesting phần lớn chưa commit. Audit không quy kết toàn bộ diff hiện tại cho một commit cụ thể.
- Chỉ file báo cáo này được tạo trong lượt audit; không sửa source, snapshot hoặc cấu hình rollout.
- Chưa chạy ứng dụng Tauri end-to-end và chưa kiểm installer/release artifact.

## 3. Ba audit unit và live trace

### 3.1. Bình lồng ghép tự do hiện tại

Luồng thực tế:

```text
MixedNestingTool
→ useMixedNestingStore / mixed-nesting/api
→ POST /mixed-nesting/jobs
→ mixed_nesting_jobs
→ mixed_nesting_service
→ PyO3 binding
→ imposition_core::mixed_nesting
→ placement manifest
→ poll/result/preview
→ exporter/artifact riêng
```

Bằng chứng chính:

- UI gọi job: `desktop/src/components/mixed-nesting/MixedNestingTool.tsx:263-272`.
- API client: `desktop/src/lib/mixed-nesting/api.ts:212-227`.
- Route tạo job: `backend/app/api/routes/mixed_nesting.py:261-281`.
- Job runner: `backend/app/core/mixed_nesting_jobs.py:229-282,318-366`.
- Native bridge: `native/src/mixed_nesting_py.rs:103-200`.
- Multi-start: `imposition_core/src/mixed_nesting/multi_start.rs:108-281`.
- Export/artifact riêng: `backend/app/api/routes/mixed_nesting.py:584-657`.

Thiết kế standalone là chủ đích của implementation hiện tại:

- Kế hoạch mô tả AppTool độc lập: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md:9-27`.
- Registry ghi rõ công cụ standalone, không thuộc Imposition: `desktop/src/lib/toolRegistry.ts:24-26,589-603`.
- Release mặc định HOLD nhưng môi trường development tự mở: `desktop/src/lib/mixed-nesting/rollout.ts:37-40`, `backend/app/api/routes/mixed_nesting.py:89-120`.

### 3.2. Bình tem bế

Luồng thực tế:

```text
GridPreview / ImposerDashboard
→ processHandlers
→ POST /imposition/nup-start
→ _launch_impose_job
→ run_nup_engine
→ layout + finalize + artwork writer
→ artifact/status/download hiện hữu
```

Bằng chứng chính:

- Bộ chọn hiện tại: `desktop/src/components/imposition-tools/sections/GridSettingsSection.tsx:502-515`.
- Type `gridStrategy`: `desktop/src/components/imposition-tools/types.ts:144-157`.
- Preview payload: `desktop/src/components/imposition-tools/sections/GridPreview.tsx:1533-1617`.
- Execute payload: `desktop/src/components/imposition-tools/ImposerDashboard.tsx:1520-1588`.
- Frontend gọi job: `desktop/src/lib/processHandlers.ts:248-445`.
- Backend job: `backend/app/api/routes/imposition.py:850-1085`.
- Single-design/S&R đã shape-aware: `backend/app/workers/sticker_imposer_pkg/layout_compute.py:22-100,202-528`.
- `optimal_auto` hiện xếp hạng candidate grid/L-shape/NFP cho một loại, không phải mixed nesting tổng quát: `backend/app/workers/sticker_imposer_pkg/orchestrator.py:75-310,333-522`.
- Multi-design vẫn dùng bbox/MaxRects: `backend/app/workers/nup_engine.py:1987-2076,2106-2194`; preview tương ứng tại `backend/app/api/routes/imposition.py:2635-2704`.

### 3.3. Bình bế rớt/CNC

Luồng thực tế:

```text
tool cnc_imposer
→ ImpositionTab / processHandlers
→ POST /imposition/nup-start
→ scheduled_job("nup") + process con
→ nup_engine
→ cnc_render
→ Front / [Back] / Cut
→ artifact/status/download hiện hữu
```

Bằng chứng chính:

- Tool/mode: `desktop/src/lib/toolRegistry.ts:552-562`.
- Frontend flow: `desktop/src/components/ImpositionTab.tsx:3075-3192`, `desktop/src/lib/processHandlers.ts:203-369`.
- Backend scheduling/artifact: `backend/app/api/routes/imposition.py:589-659,690-823,1088-1139,1193-1213`.
- Render: `backend/app/workers/cnc_render.py:290-578`.
- Gang CNC dùng MaxRects theo trim bbox; polygon nesting được ghi là cải tiến tương lai: `backend/app/workers/cnc_layout.py:25-88,103-360`.
- Nhánh “Dàn nhiều mẫu” không dùng `gridStrategy` để chọn true-shape solver: `backend/app/workers/cnc_render.py:350-357,381-475`.
- Một unit sản xuất gồm `[Front, Back, Cut]` hoặc `[Front, Cut]`: `backend/app/workers/cnc_render.py:194-287`.

## 4. Findings

Quy ước effort: **S** nhỏ, **M** vừa, **L** lớn, **XL** xuyên tầng.

| ID | Mức | Bằng chứng | Finding | Tác động | Effort |
|---|---|---|---|---|---|
| NEST-01 | P1 | CONFIRMED | Tính năng được dựng thành AppTool/capability/job/export riêng, trái với mục tiêu mới là một strategy trong Tem bế/CNC. | Trùng pipeline, trải nghiệm rời rạc, không hưởng contract sản xuất hiện hữu. | M |
| NEST-02 | P1 | CONFIRMED | Exporter standalone chỉ stroke contour bằng toán tử PDF `S`; parser đã bỏ artwork nguồn. Xem `backend/app/workers/mixed_nesting_pdf_export.py:165-201,245-265`. | Artifact không phải file bình Tem/CNC có thể sản xuất. | L nếu cố cứu exporter; S nếu chỉ giữ làm lab |
| NEST-03 | P1 | CONFIRMED | Mixed solver trả `rotationDeg` và pose liên tục, còn placement/render hiện tại chủ yếu dùng `isRotated`/`isRotated180`. Xem `imposition_core/src/mixed_nesting/model.rs:1130-1179`, `backend/app/workers/imposition_finalize.py:13-79`, `backend/app/workers/nup_artwork.py:1146-1263`. | Không thể cắm thẳng free-angle mà vẫn giữ artwork/cutline đúng. | XL |
| NEST-04 | P1 | CONFIRMED | Request solver chỉ có sheet, một `gapMm`, orientation và parts; thiếu fixed obstacles/boong/dấu canh. Xem `imposition_core/src/mixed_nesting/model.rs:534-553`. CNC hiện có `exclude_zones`: `backend/app/workers/cnc_layout.py:103-128`. | Có thể tạo placement va boong/marks hoặc không biểu diễn đúng gap X/Y. | L |
| NEST-05 | P1 | CONFIRMED | Multi-design Tem bế và CNC hiện pack bbox; đây là seam có giá trị của solver mới. Single-design Tem bế đã shape-aware. | Nếu thay toàn bộ solver sẽ tăng phạm vi và nguy cơ hồi quy không cần thiết. | M |
| NEST-06 | P2 | CONFIRMED | Search hiện greedy theo instance + đổi thứ tự/multi-start; chưa có reinsert/swap/move khỏi tờ cuối như kế hoạch. Xem `solver.rs:132-248`, `multi_start.rs:152-210`, kế hoạch `:500-518`. | Chưa đủ cơ sở quảng bá là tối ưu toàn cục. | L |
| NEST-07 | P2 | CONFIRMED | Hardware planner tính/log số worker nhưng không truyền xuống native; job executor một thread và multi-start loop tuần tự. Xem `mixed_nesting_jobs.py:158-163,326-345`, `mixed_nesting_py.rs:139-157`, `multi_start.rs:152-210`. | UI/benchmark có thể báo nhiều worker nhưng throughput solver không tăng. | M |
| NEST-08 | P2 | CONFIRMED (blocker kiến trúc, chưa phải lỗi hiện hữu) | Preview và export Tem/CNC có callsite riêng. Khi tích hợp solver có time budget, nếu hai callsite solve độc lập thì kết quả có thể lệch. | Phải persist và dùng chung manifest để bảo đảm preview-artifact parity. | M |
| NEST-09 | P2 | CONFIRMED | Corpus benchmark mới có bốn case tổng hợp, thiếu M100/L300/C100/ADV/INTERLOCK_FREE/NEAR_CONTACT và corpus production đã dự kiến. Stats cũng không chỉ rõ trial thắng là baseline hay smart solver. | Chưa chứng minh lợi ích về số tờ, độ chặt hoặc runtime sản xuất. | M |
| NEST-10 | P2 | CONFIRMED | Hai PDF cùng basename có thể sinh `partId` trùng; frontend cho chọn nhưng backend từ chối duplicate. Xem `desktop/src/components/mixed-nesting/MixedNestingTool.tsx:224-243`, `desktop/src/components/mixed-nesting/MixedNestingFileInput.tsx:38-41`, `backend/app/schemas/mixed_nesting.py:273-293`. | Lỗi UX trong standalone/lab; không phải blocker nếu bỏ entry độc lập. | S |
| NEST-11 | P2 | SUSPECTED | Gang CNC né keep-out rồi `_materialize_sheet` recenter; test chưa assert lại collision sau recenter. Xem `cnc_layout.py:211-235`, `test_cnc_mirror_and_exclude.py:96-105`. | Có nguy cơ placement sau dịch tâm quay lại vùng boong. Cần artifact/repro trước khi gọi là bug. | S điều tra, M sửa |
| NEST-12 | P3 | CONFIRMED | Mixed Nesting release đang HOLD nhưng dev tự bật. | Chưa phải lỗi production đã phát hành, nhưng dễ tạo cảm giác tính năng đã sẵn sàng. | S |

## 5. Đánh giá khả năng tích hợp

### 5.1. Khả thi theo phạm vi

| Phạm vi | Khả thi | Rủi ro | Nhận định |
|---|---:|---:|---|
| Tem bế nhiều mẫu, góc cardinal | Cao | Vừa | Có thể adapter manifest về contract placement hiện tại; giữ fallback MaxRects. |
| CNC nhiều mẫu, góc cardinal | Cao | Vừa | Có thể giữ nguyên Front/[Back]/Cut và mirror toàn tờ; bắt buộc truyền boong dưới dạng obstacles. |
| Tem bế/CNC góc tự do | Có | Cao | Phải nâng renderer/artifact xuyên tầng, không chỉ thêm một option UI. |
| Thay single-design Tem bế | Thấp về giá trị | Cao | Solver hiện tại đã shape-aware; chưa có bằng chứng kernel mới tốt hơn. |
| Dùng exporter standalone làm output sản xuất | Không phù hợp | Rất cao | Thiếu artwork, duplex, boong, marks, report và recipe. |

### 5.2. Kiến trúc đích đề xuất

```text
Bình tem bế / Bình CNC
        │
        ├─ Cách xếp hiện hữu
        └─ Nesting theo đường bế
                    │
                    ▼
        canonical geometry adapter
        - contour + quantity
        - sheet/margins/gap
        - boong/marks/keep-outs
        - rotation policy
                    │
                    ▼
        Rust mixed_nesting kernel
                    │
                    ▼
        validated placement manifest
        - input hash/revision/seed
        - sheet + instance + pose
        - validation + score + provenance
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
    Preview Imposition   Renderer Tem/CNC
                         Front/[Back]/Cut
```

Nguyên tắc bắt buộc:

- Thêm strategy mới, ví dụ `true_shape_nesting`, vào `gridStrategy`/“Cách xếp”; không nhét vào `groupingStrategy`.
- Chỉ hiện strategy này cho `sticker_imposer` và `cnc_imposer` **khi ở nhánh nhiều mẫu/gang**; không để giá trị mới chảy vào S&R/single-design trước khi các nhánh đó có contract tương ứng.
- Preview và export phải dùng **cùng một manifest**, không solve lại.
- Không submit `/mixed-nesting/jobs` lồng bên trong job `nup`. Cả hai đang dùng whole-machine slot; nested job có nguy cơ tự chờ hoặc oversubscribe. Kernel/service phải được gọi trực tiếp trong process N-Up sau admission.
- Chỉ một adapter sở hữu đổi `mm ↔ pt`, `y-up ↔ y-down`, `reference point/centroid ↔ writer origin`.
- Giữ nguyên resolver trang nguồn, `/Rotate`, TrimBox/die bbox và page-box hiện hữu.
- Solver không được tự phản chiếu polygon mặt sau CNC. Writer áp mirror toàn pose/tờ sau khi đã chốt placement mặt trước.
- Manifest phải được validator xác nhận đủ quantity, không overlap, đủ clearance và không chạm obstacles trước khi renderer nhận.
- Khi timeout, invalid hoặc kết quả không hơn baseline theo tiêu chí đã chốt, tự động fallback strategy hiện hành.

### 5.3. Contract còn thiếu

Input canonical tối thiểu cần có:

- `sheet`: usable rect, offset/margins và hệ tọa độ được khai báo rõ.
- `parts`: stable ID, source/page reference, quantity, polygon/holes, local reference point.
- `rotationPolicy`: cardinal hoặc danh sách/góc tự do có giới hạn.
- `clearance`: chốt rõ semantics của `gapX/gapY`; không âm thầm ép thành một `gapMm` nếu hai giá trị khác nhau.
- `fixedObstacles`: boong, dấu canh, vùng cấm và safety margin.
- `budget`: seed, time budget, quality profile và hardware plan.
- `baseline`: optional placement/score để thực thi guard “không kém cách xếp hiện hành”.

Output manifest tối thiểu cần có:

- `manifestId`, `revision`, `inputHash`, `engineVersion`, `seed`.
- Với từng instance: `partId`, `instanceId`, `sheetIndex`, `txMm`, `tyMm`, `rotationDeg`, `referencePoint` hoặc affine matrix chuẩn hóa.
- `validation`: quantity, in-bounds, overlap, clearance, obstacle collision.
- `score`: số tờ, số con đặt được, used extent/compactness, runtime.
- `provenance`: baseline hay smart trial nào thắng; lý do fallback nếu có.

## 6. Thành phần giữ, chuyển đổi và thu hồi

| Thành phần | Quyết định | Lý do |
|---|---|---|
| `imposition_core/src/mixed_nesting/` | Giữ và hoàn thiện | Đây là tài sản lõi: geometry, NFP/IFP, solver, validator, score. |
| Rust tests của Mixed Nesting | Giữ | Phủ contract/geometry/determinism hiện tại. |
| `native/src/mixed_nesting_py.rs` | Giữ, đổi thành bridge nội bộ | Dùng lại kernel, bổ sung contract/worker plan thật. |
| Schema/service backend Mixed Nesting | Chuyển thành adapter dùng chung | Tránh gọi route/job lồng; tái dùng validate/serialize phù hợp. |
| AppTool/capability/registry standalone | Thu hồi khỏi luồng sản xuất; có thể giữ lab ẩn | Sai tầng sản phẩm theo mục tiêu mới. |
| Store/UI standalone | Không mở rộng; chỉ giữ nếu cần lab | Trùng UX với Imposition. |
| PDF source parser standalone | Không dùng làm nguồn sự thật production | Có thể giữ cho lab/import; Imposition phải dùng resolver/contour hiện hữu. |
| Exporter/artifact standalone | Không dùng cho Tem/CNC | Chỉ có contour, thiếu nội dung sản xuất. |
| Preview/writer/artifact Tem/CNC | Giữ làm nguồn sự thật | Đã xử lý artwork, page boxes, marks, duplex, report và lifecycle. |
| MaxRects/strategy hiện hữu | Giữ làm baseline/fallback | Bảo toàn hành vi và làm đối chứng chất lượng. |

## 7. Kế hoạch sửa đề xuất theo lô nhỏ

Mỗi lô tối đa 5 file, verify xong mới sang lô tiếp theo. Danh sách dưới đây là kế hoạch sơ bộ; trước mỗi lô cần re-baseline vì worktree đang có thay đổi chưa commit.

### Lô 1 — Chốt contract production cho kernel

Mục tiêu: obstacles, gap semantics, provenance và validator.

- `imposition_core/src/mixed_nesting/model.rs`
- `imposition_core/src/mixed_nesting/validator.rs`
- `imposition_core/src/mixed_nesting/score.rs`
- một file test contract/validator hiện hữu
- một file fixture/corpus liên quan

Verify: Rust unit/property tests; case obstacle, quantity, gap, deterministic manifest và fallback provenance.

### Lô 2 — Chuẩn bị bridge/service và worker plan thật

Mục tiêu: chuẩn bị API nội bộ để các lô 4/5 gọi kernel mà không tạo nested job; làm hardware plan thật nhưng vẫn tuân thủ RAM-gating. Callsite N-Up/CNC chỉ được wiring tại lô tích hợp tương ứng.

- `native/src/mixed_nesting_py.rs`
- `backend/app/core/mixed_nesting_service.py`
- `backend/app/core/mixed_nesting_jobs.py`
- `backend/app/schemas/mixed_nesting.py`
- một file test service/native contract

Verify: backend/native tests, benchmark 1/2/N worker; máy `≥16 GB` không bị hard-cap; kết quả deterministic theo seed.

### Lô 3 — Strategy contract từ UI tới backend

Mục tiêu: thêm “Nesting theo đường bế” mà không đổi mặc định.

- `desktop/src/components/imposition-tools/types.ts`
- `desktop/src/components/imposition-tools/sections/GridSettingsSection.tsx`
- `desktop/src/components/imposition-tools/sections/GridPreview.tsx`
- `desktop/src/lib/processHandlers.ts`
- `backend/app/api/routes/imposition.py`

Verify: vitest payload/visibility, typecheck Windows, route schema tests; strategy chỉ hiện ở Tem bế/CNC.

### Lô 4 — Adapter chung và tích hợp Tem bế nhiều mẫu cardinal

Mục tiêu: canonical geometry → manifest → placement hiện hữu, dùng chung preview/export.

- một module adapter backend mới trong `backend/app/workers/`
- `backend/app/workers/nup_engine.py`
- `backend/app/api/routes/imposition.py`
- một file test layout Tem bế
- một file test preview/artifact parity

Verify: 0/90 hoặc 0/90/180/270, đủ quantity, multi-sheet, no-overlap, cùng manifest giữa preview/export; single-design không đổi.

### Lô 5 — Tích hợp CNC cardinal và keep-outs

Mục tiêu: true-shape gang CNC nhưng giữ writer Front/[Back]/Cut.

- `backend/app/workers/cnc_layout.py`
- `backend/app/workers/cnc_render.py`
- module adapter chung của lô 4
- `backend/tests/test_cnc_mirror_and_exclude.py`
- một file test CNC artifact/multi-template hiện hữu

Verify: boong như fixed obstacles, kiểm lại collision sau mọi translate/recenter, simplex/duplex, mirror mặt sau, CUT parity và multi-sheet.

### Lô 6 — Nâng renderer lên arbitrary angle

Chỉ thực hiện sau khi nấc cardinal đạt acceptance production.

- `backend/app/workers/imposition_finalize.py`
- `backend/app/workers/imposition_parity.py`
- `backend/app/workers/nup_artwork.py`
- `backend/app/workers/pdf_ops.py`
- một file test artifact arbitrary-angle

Verify: affine pose cho artwork + clipping + CUT; `/Rotate`/TrimBox; raster parity ở nhiều góc; không mất nội dung ngoài clip.

### Lô 7 — Rollout và thu hồi standalone

Mục tiêu: đưa strategy qua feature flag/canary; quyết định giữ standalone làm lab hay gỡ entry.

Tối đa 5 file registry/rollout/UI/test sau khi chốt sản phẩm. Không xóa kernel/test/fixture có giá trị.

## 8. Tiêu chí nghiệm thu

### 8.1. Đúng hình học và artifact

- 100% instance theo quantity hoặc trả trạng thái/fallback rõ ràng.
- Không overlap, không vượt usable sheet, đủ clearance và không chạm obstacles.
- Preview và PDF cuối dùng cùng `manifestId/revision/inputHash`.
- Tem bế: artwork, đường bế, marks và page box khớp pose.
- CNC simplex: `[Front, Cut]`; duplex: `[Front, Back, Cut]`; mặt sau mirror đúng toàn tờ và CUT theo mặt trước.
- Parse/raster kiểm artifact thật, không chỉ assert JSON/bbox.

### 8.2. Chất lượng nesting

So trực tiếp với `optimal_auto`/MaxRects hiện hành trên cùng input:

1. Feasibility và quantity là điều kiện cứng.
2. Ưu tiên giảm số tờ.
3. Khi số tờ bằng nhau, đo used extent/compactness hoặc khả năng chừa vùng hữu dụng; không dùng utilization đơn thuần vì với cùng số part và số tờ nó gần như bất biến.
4. Ghi rõ baseline hay trial nào thắng.
5. Không công bố “tối ưu” rộng hơn bằng chứng corpus.

Corpus tối thiểu cần bổ sung:

- Tem bế một mẫu làm control và nhiều mẫu 2/5/10+ loại.
- CNC simplex/duplex, có/không boong, contour lõm, lỗ, interlock, near-contact.
- Bộ cỡ S20, M100, L300 và stress case theo budget.
- PDF production đã ẩn danh, có `/Rotate`, TrimBox khác MediaBox và nhiều trang.
- Case thất bại có chủ đích để kiểm fallback.

### 8.3. Hiệu năng và phần cứng

- Tuân thủ quy tắc dự án: máy `<8 GB` và `<16 GB` mới giảm; máy `≥16 GB` giữ full công suất.
- Không hard-cap worker/cache/chất lượng vô điều kiện.
- Nếu dùng parallel multi-start, tạo local Rayon pool theo hardware plan; chứng minh worker plan thực sự đi vào execution.
- Đo wall time, peak RSS, số tờ và quality score; không chỉ log số worker dự kiến.
- Hỗ trợ cancel/progress cho case vài giây trở lên; không khóa UI.

## 9. Bằng chứng test và benchmark hiện tại

Kết quả ghi nhận trong lượt audit:

- Rust Mixed Nesting: **217/217 test xanh**.
- Backend Mixed Nesting: **336 passed, 2 skipped, 2 warnings**.
- Frontend Mixed + các điểm Imposition liên quan: **11 file, 300 test xanh**.
- Chưa chạy runtime Tauri và installer.

Benchmark qua native bridge trên máy 16 lõi, RAM 32 GB, engine `0.1.0`, corpus v2:

| Case | Fast | Balanced | Cardinal baseline | Kết quả chính |
|---|---:|---:|---:|---|
| ANGLE_ONLY | 0,3 ms | 1,9 ms | 0,1 ms | Nesting đặt 1; baseline đặt 0. |
| CONTINUOUS_XY | 37,5 ms | 300,3 ms | 130,6 ms | Đều 1 tờ / 4 con. |
| CONSTRAINTS | 337,7 ms | 2.994,1 ms | 1.251,4 ms | Đều 1 tờ / 10 con. |
| S20 | 2.288,8 ms | 9.147,9 ms | 3.750,5 ms | Đều 1 tờ / 20 con. |

Ở S20, Balanced không trả góc non-cardinal và không cải thiện số tờ/utilization. Kết luận hợp lệ chỉ là **chưa chứng minh lợi ích trên corpus này**, không phải solver luôn kém hơn.

## 10. Quyết định cần người dùng duyệt

Đề xuất phê duyệt hướng sau:

1. Xác nhận “Nesting theo đường bế” là strategy mới trong Bình tem bế và Bình CNC.
2. Ưu tiên multi-design/gang; không thay single-design Tem bế ở giai đoạn đầu.
3. Triển khai cardinal trước, arbitrary-angle sau.
4. Giữ standalone ở trạng thái HOLD/ẩn làm lab trong lúc chuyển đổi; không đầu tư tiếp vào exporter standalone.
5. Sau khi duyệt, sửa lần lượt từng lô tối đa 5 file và báo kết quả verify trước khi sang lô kế.

---

**Điểm dừng audit:** báo cáo này là chốt thứ nhất theo workflow. Không thực hiện sửa source cho tới khi người dùng duyệt phạm vi và thứ tự lô.
