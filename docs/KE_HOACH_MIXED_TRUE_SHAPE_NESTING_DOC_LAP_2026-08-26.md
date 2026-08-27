# Kế hoạch Mixed True-Shape Nesting độc lập cho PrynX

**Ngày lập:** 2026-08-26
**Workspace:** `D:\pdfcompare`
**Trạng thái:** Kế hoạch kiến trúc và triển khai — chưa sửa code sản phẩm
**Tên hiển thị tạm:** `Bình lồng ghép tự do`
**Mã nội bộ thống nhất:** `mixed_nesting`

## 1. Quyết định kiến trúc

PrynX sẽ có một AppTool mới hoàn toàn độc lập để xếp nhiều chi tiết có hình dạng khác nhau vào một hoặc nhiều tờ vật liệu theo contour thật.

```text
MixedNestingTool (React, store và preview riêng)
        ↓
/api/mixed-nesting/* (schema, route và job registry riêng)
        ↓
backend/app/core/mixed_nesting_service.py
        ↓
pdfcompare_native.MixedNestingRun (PyO3 binding riêng)
        ↓
imposition_core::mixed_nesting (Rust module riêng)
```

Tool mới không phải một chế độ mới của `ImpositionTab`, không phải một tab con của Khuôn bế Bao bì và không phải bản thay thế solver đang chạy. Không đưa `mixed_nesting` vào `IMPOSITION_FAMILY_TOOL_IDS`.

Những file dùng chung như registry, entitlement, router registration và native registration vẫn phải thêm một entry tối thiểu để PrynX biết tool mới tồn tại. Đây là điểm nối, không phải thay đổi hành vi của tool cũ.

## 2. Mục tiêu sản phẩm

Người dùng đưa vào nhiều mẫu sản phẩm khác nhau, khai báo số lượng, khổ vật liệu, lề, khoảng cách và mức tối ưu. PrynX nhận diện hoặc cho người dùng xác nhận contour ngoài của từng mẫu, sau đó:

1. Chuẩn hóa contour về polygon theo đơn vị mm.
2. Tính phương án xếp không chồng lấn trên một hoặc nhiều tờ.
3. Hiển thị tiến độ và phương án tốt nhất hiện tại.
4. Cho xem từng tờ, từng chi tiết và thống kê hiệu suất vật liệu.
5. Xuất file từ đúng placement manifest đã được duyệt, không tính layout lần thứ hai.

Mục tiêu chính là true-shape mixed nesting: va chạm cuối được kiểm bằng contour thật, không dùng bounding box làm phán quyết cuối.

## 3. Ranh giới không hồi quy

### 3.1 Các tính năng phải giữ nguyên hành vi

- Bình Tem Bế.
- Bình Cắt xén N-Up.
- Bình Bế Rớt/CNC.
- Bình sách và tạp chí.
- Xếp khuôn trong Khuôn bế Bao bì.
- Mọi preview, export, drop-file, license và job lifecycle hiện có của các tool trên.

### 3.2 Các module hiện tại bị cấm sửa trong dự án này

```text
desktop/src/lib/dieline/nestingEngine.ts
desktop/src/lib/dieline/nestingProfile.ts
desktop/src/lib/dieline/nestingCollision.ts
desktop/src/components/dieline-tool/NestingPanel.tsx
desktop/src/components/dieline-tool/NestingCanvas.tsx
desktop/src/stores/useBoxStore.ts
desktop/src/components/ImpositionTab.tsx

backend/app/api/routes/imposition.py
backend/app/api/routes/dieline.py
backend/app/workers/sticker_imposer_pkg/**
backend/app/api/routes/ws.py
backend/app/api/routes/results.py

imposition_core/src/nfp.rs
imposition_core/src/sticker.rs
imposition_core/src/shape.rs
imposition_core/src/orchestrator.rs
native/src/nfp_solver.rs
```

Không import runtime từ các solver trên vào engine mới. Nếu sau này muốn tách một primitive hình học thuần để dùng chung, phải làm thành một proposal riêng, có test parity trước và sau; không thực hiện trong lượt xây Mixed Nesting.

### 3.3 Bất biến hình học

1. Mỗi instance đầu vào xuất hiện đúng một lần trong `placements` hoặc đúng một lần trong `unplaced`; không mất và không nhân đôi.
2. Mỗi placement là pose cứng trong `SE(2)`: `p_sheet = R(theta) * p_local + (tx, ty)`.
3. Mặc định `theta` được phép nằm ở mọi góc trong miền liên tục `[0°, 360°)`; khóa hướng, 0/180 và 0/90/180/270 chỉ là các policy tùy chọn.
4. `tx` và `ty` là tọa độ mm liên tục, được tối ưu đồng thời với `theta`; không snap vào pixel, lưới mm hay bước dịch cố định.
5. Nesting mặt trước không mirror, scale hoặc shear. Validator tự dựng `R(theta)`, kiểm `R^T R ≈ I`, `det(R) ≈ +1` và bảo toàn hướng signed-area; chỉ kiểm determinant dương là chưa đủ.
6. Mọi góc được chuẩn hóa về `[0°, 360°)`; tolerance tuyến tính/góc và quy tắc canonicalization phải có version.
7. Không chi tiết nào vượt khỏi vùng dùng được sau khi trừ lề.
8. Mọi cặp chi tiết phải thỏa khoảng cách tối thiểu đã khai báo giữa các contour CUT.
9. Layout chỉ được công bố sau khi qua final validator độc lập với solver.
10. Preview và export dùng cùng một placement manifest, không làm tròn hoặc tính pose lần hai.
11. Tất cả hình học và API dùng mm; chỉ đổi sang point tại lớp dựng PDF.
12. Cancel hoặc lỗi trước khi publish không được tạo output nửa vời.
13. Cùng canonical input, engine version, seed và fixed evaluation/work-plan phải cho cùng kết quả bất kể số worker. Chế độ dừng theo wall-clock chỉ cam kết best-so-far hợp lệ và ghi `terminationReason`, không cam kết bit-identical giữa hai máy.

## 4. Kiến trúc hiện tại đã trace

- Registry tool trung tâm: `desktop/src/lib/toolRegistry.ts`; Home và menu đọc từ registry, vì vậy không cần hard-code tool mới vào `HomeTab.tsx` hoặc `App.tsx`.
- Component standalone đã đi qua nhánh generic của `App.tsx`, nhận `tabId`, `isActive` và `onDirtyChange`.
- Danh mục quyền frontend: `desktop/src/lib/license/features.ts`.
- Danh mục quyền sidecar: `backend/app/core/feature_entitlements.py`.
- Router backend được đăng ký tập trung tại `backend/app/main.py`.
- Công việc nặng dùng `backend/app/core/heavy_job_scheduler.py`.
- `imposition_core` là Rust thuần và là nơi phù hợp cho solver mới.
- `native/src/lib.rs` là điểm đăng ký binding PyO3.
- `imposition_core/src/nfp.rs` hiện chỉ là phép toán cặp polygon, không phải mixed multi-sheet solver.
- WebSocket `/ws/jobs/{job_id}/progress` hiện gắn với `ComparisonJob`; Mixed Nesting không dùng lại endpoint đó.
- `backend/app/api/routes/results.py` cũng gắn với model comparison; không dùng nó làm job store cho tool mới.

### 4.1 Đối chiếu với Esko i-cut Layout

Đây là đối chiếu năng lực công khai để đặt đúng hợp đồng sản phẩm; Esko không công bố thuật toán nội bộ, rotation step hay cấu trúc solver. PrynX không được tuyên bố sao chép solver hoặc đạt tối ưu toàn cục của i-cut.

| Năng lực công khai của i-cut | Hệ quả bắt buộc cho kế hoạch PrynX |
|---|---|
| True Shape dùng hình dạng thật của graphic | Collision và khoảng hở theo contour CUT thật; bbox chỉ làm broad phase/baseline |
| Rotation có `Allow Any Angle`, 180°, 90/180/270° hoặc không xoay | Mặc định PrynX là `free`; các tập góc hữu hạn chỉ là preset/policy tùy chọn |
| Nesting software quyết định vị trí; Transform có hai trường Location X/Y và Angle | Đây là bằng chứng placement có X/Y + góc; `tx/ty` liên tục và không grid là quyết định thiết kế PrynX, không phải chi tiết solver Esko công bố |
| Trong Minimal Waste/Minimum Layouts, Fill Starting Point có bốn góc tờ và Primary Fill Direction là Horizontal/Vertical | Đây chỉ là preference/heuristic khởi tạo; không khóa `tx/ty` và không cấm solver dịch trái/phải/lên/xuống |
| Search Time đổi giữa tốc độ và độ chính xác | `fast/balanced/tight` đổi work budget, số seed và refinement; không thu hẹp miền góc hợp lệ |
| Minimal Waste, Minimum Layouts và Guillotine là các strategy/mode khác nhau | Technical MVP làm True Shape/Minimum Waste; các mode khác không trộn vào solver mặc định |
| Gutter là khoảng cách giữa hai cut path; gutter 0 có thể dùng common cut-line | Validator đo clearance contour; bleed clipping là hợp đồng khác |
| Ordered quantities, nhiều layout, overrun và layout repeats | MVP giữ đúng quantity/multi-sheet; overrun/repeat optimization là phase sau |
| Offcut được lưu/tái sử dụng dưới dạng vùng dư chữ nhật | Không gán arbitrary-polygon remnant cho i-cut; offcut inventory để phase riêng |
| Two-sided/back mirroring là nghiệp vụ mặt sau | `mirror=false` trong nesting mặt trước vẫn đúng; duplex/back transform là module riêng |
| Cut path có thể lấy từ spot separation, trim box hoặc contour tạo mới | Pipeline source phải cho người dùng xác nhận CUT; không tự đoán contour mơ hồ |

Nguồn chính thức:

- [Esko i-cut Layout 22.11 User Manual](https://docs.esko.com/docs/en-us/icutlayout/22.11/userguide/pdf/icutLayout.pdf)
- [Esko Automation Engine — Layout Tab](https://docs.esko.com/docs/en-us/automationengine/18.1/userguide/en-us/common/ae/concept/co_ae_GRP_Nesting_tab_Layout.html)
- [Esko i-cut Layout+ — Nesting Options](https://docs.esko.com/docs/en-us/icutlayoutplus/14/userguide/en-us/common/icp/concept/co_icp_nestingoptions.html)
- [Esko — Select Cut Path](https://docs.esko.com/docs/en-us/icutlayout/22.11/userguide/en-us/common/icl/topic/to_working13.html)
- [Esko i-cut Layout+ — Create a Cutting Line](https://docs.esko.com/docs/en-us/icutlayoutplus/14/userguide/en-us/common/icp/task/ta_icp_createcuttingline.html)
- [Esko — Offcut sheets](https://docs.esko.com/docs/en-us/automationengine/18.1/userguide/en-us/common/ae/concept/co_ae_nesting_Tab_Offcuts.html)
- [Esko — Two-sided Printing](https://docs.esko.com/docs/en-us/icutlayoutplus/14/userguide/en-us/common/icp/topic/to_doubleplates.html)

Tài liệu chính thức xác nhận `Allow Any Angle`, nhưng không công bố rotation step hay thuật toán tìm góc của solver. Transform Window xác nhận graphic có Location X/Y và Angle dạng số; còn continuous `tx/ty`, không grid và cách coarse-to-fine/NFP/refinement dưới đây là quyết định thiết kế của PrynX. UI Create Cutting Line có tùy chọn `Remove Holes`; khi không bật tùy chọn này, cut path có thể giữ inner contour. Esko không công bố SmartNest cho đặt part khác vào hole, nên hole nesting không được ghi là parity i-cut.

## 5. Phạm vi phát hành

### 5.1 Technical MVP

- Nhận request hình học JSON đã chuẩn hóa.
- Hỗ trợ polygon lõm không tự cắt.
- Nhiều loại chi tiết và quantity khác nhau.
- Một khổ tờ, tự mở nhiều tờ cùng khổ khi cần.
- Lề bốn cạnh và khoảng cách giữa các contour CUT.
- Mặc định xoay tự do `[0°, 360°)` và tịnh tiến liên tục trên cả X/Y; không mirror.
- Rotation policy cấp job và override từng part: `free`, `fixed`, `discrete`, `ranges` hoặc `inherit`.
- Baseline constraint-safe, solver coarse-to-fine, continuous pose refinement, multi-start và best-so-far.
- Ba profile `fast`, `balanced`, `tight` chỉ đổi search effort; mọi profile đều giữ toàn legal rotation domain, cho phép và có thể trả góc không-cardinal.
- Progress, timeout, cancel và final validator độc lập.
- Preview hình học nhiều tờ từ pose `(theta, tx, ty)` trong tool standalone.
- Chưa sinh PDF; result chỉ là placement manifest JSON.

Technical MVP dùng fixture hình học để chốt correctness và hiệu năng trước khi nối pipeline PDF.

### 5.2 Product MVP

- Nhập nhiều PDF; mỗi trang hoặc contour được xác nhận là một loại chi tiết.
- Bảng chi tiết: tên, trang nguồn, kích thước, quantity, contour status và rotation constraint.
- UI mặc định `Góc xoay: Tự do`; có preset `Giữ hướng`, `0/180`, `0/90/180/270` và policy tùy chỉnh theo part.
- Fill start/primary fill chỉ là heuristic khởi tạo; không cấm solver dịch trái/phải/lên/xuống khi cải thiện layout.
- Trường hợp có nhiều contour kín phải yêu cầu người dùng chọn; không tự đoán rồi xếp sai.
- Preview thumbnail/nội dung in đặt theo đúng pose số thực trong placement manifest.
- Xuất PDF nhiều tờ từ chính manifest đã duyệt.
- Báo số tờ, hiệu suất vật liệu, số lượng đã xếp/chưa xếp và lý do.
- Chọn nhiều PDF bằng file picker nằm bên trong tool; không can thiệp router file toàn cục.

### 5.3 Chưa làm trong MVP

- Xếp chi tiết vào lỗ của chi tiết khác; hole tạm coi là vật liệu đặc.
- Mirror trong nesting mặt trước.
- Bình hai mặt front/back.
- Guillotine nesting.
- Minimum Layouts, maximum overrun và tối ưu số layout lặp.
- Offcut inventory.
- Dấu camera, barcode, SmartMarks hoặc đường dao tối ưu.
- Trộn nhiều khổ tờ trong cùng một job.
- SVG/DXF native drop; MVP nhận PDF để không mở rộng whitelist toàn cục.
- Cam kết chất lượng ngang Esko/eCut trước khi có benchmark corpus thực tế.

## 6. Cấu trúc module đề xuất

### 6.1 Rust core mới

```text
imposition_core/src/mixed_nesting/
├── mod.rs
├── model.rs
├── control.rs
├── transform.rs
├── orientation.rs
├── normalize.rs
├── kernel.rs
├── geometry.rs
├── collision.rs
├── nfp.rs
├── spatial.rs
├── validator.rs
├── baseline.rs
├── candidates.rs
├── refine.rs
├── score.rs
├── solver.rs
└── multi_start.rs
```

Chỉ thêm `pub mod mixed_nesting;` vào `imposition_core/src/lib.rs`. Model mới không dùng `ImposeSettings` hoặc `Placement` cũ vì hợp đồng cũ có luồng đơn vị khác.

`transform.rs` là nguồn chân lý của pose cứng; `orientation.rs` chuẩn hóa rotation policy/cung góc; `nfp.rs` là NFP mới theo relative orientation; `refine.rs` tối ưu liên tục `(theta, tx, ty)`. Không đổi hoặc gọi `imposition_core/src/nfp.rs` cũ.

`kernel.rs` chỉ được chốt sau spike fixed-point polygon kernel cho offset/boolean/Minkowski. Không tự gọi phép kiểm sau flatten là “exact analytic Bézier”; authority là robust fixed-point validation ở tolerance có version.

**AMENDMENT (2026-08-26, sau spike P2b0 — đã duyệt).** Spike đo được phép Minkowski của Clipper2 **sai** trên 5/6 ca lồi ở **cả** bản thuần Rust lẫn bản C++ gốc, và chậm 12–84 ms mỗi phép; bằng chứng và số đo ở `docs/BAO_CAO_SPIKE_MIXED_NESTING_KERNEL.md` §4. Vì vậy hợp đồng của hai file này đổi như sau:

- `kernel.rs` dùng `clipper2-rust` **chỉ cho boolean và offset**. Nó **không được gọi** `minkowski_sum`/`minkowski_diff` của crate; có chốt cứng bằng test `khong_goi_minkowski_cua_crate`. Phép Minkowski của kernel là `minkowski_convex` — hợp nhất vector cạnh theo góc cho **hai đa giác lồi**, `O(m+n)`, chính xác.
- `geometry.rs` bổ sung **phân rã lồi** (Hertel–Mehlhorn). Đây là điều kiện chặn, không phải tối ưu tùy chọn: tam giác hoá thuần cho `n−2` mảnh và làm NFP lõm–lõm 50×50 đỉnh mất 298 ms, còn phân rã lồi cho tối đa `r+1` mảnh với `r` là số đỉnh lõm.
- `nfp.rs` dựng NFP bằng `∪(i,j) (A_i ⊕ (−B)_j)` với `A_i`, `B_j` là mảnh lồi, thay vì gọi Minkowski của kernel. Đường này đã kiểm bằng hai oracle độc lập (bao lồi cho ca lồi, raster cho ca lõm) và nhanh hơn khoảng `10.000×` ở ca 50 ⊕ 50 đỉnh.
- Kiểu bo góc offset phải khai **tường minh** kèm version (`OffsetStyle`), không dùng mặc định thư viện: hai engine chênh 0,3% chỉ vì mặc định khác nhau, và vát nhọn nở nhiều hơn bo tròn nên dùng làm clearance sẽ loại oan layout hợp lệ.

### 6.2 PyO3 binding mới

```text
native/src/mixed_nesting_py.rs
```

API dự kiến:

```python
run = pdfcompare_native.MixedNestingRun()
result_json = run.solve(request_json)
snapshot = run.progress()
run.cancel()
```

`solve()` phải nhả GIL trong lúc Rust tính. Progress ghi vào atomic trong Rust; không gọi Python callback từ vòng lặp nóng hoặc từ Rayon.

### 6.3 Backend mới

```text
backend/app/schemas/mixed_nesting.py
backend/app/core/mixed_nesting_service.py
backend/app/core/mixed_nesting_jobs.py
backend/app/core/mixed_nesting_artifacts.py            # Product MVP, lifecycle riêng
backend/app/api/routes/mixed_nesting.py
backend/app/workers/mixed_nesting_pdf_source.py        # Product MVP
backend/app/workers/mixed_nesting_pdf_export.py        # Product MVP
```

Job registry riêng có queue, TTL, cooperative cancellation và shutdown rõ ràng. Không refactor job registry hiện tại thành generic trong lượt này.

### 6.4 Desktop mới

```text
desktop/src/components/mixed-nesting/
├── MixedNestingTool.tsx
├── InputPanel.tsx
├── PartsTable.tsx
├── NestingPreview.tsx
└── ResultSummary.tsx

desktop/src/lib/mixed-nesting/
├── types.ts
├── api.ts
├── resultValidator.ts
└── previewGeometry.ts

desktop/src/stores/useMixedNestingStore.ts
desktop/src/styles/mixed-nesting.css
```

Store phải phân vùng theo `tabId`. Hai tab Mixed Nesting không được dùng chung file, job, progress hoặc result.

## 7. Các file tích hợp hiện hữu tối thiểu

Những file sau được phép chạm theo từng lô nhỏ, chỉ để đăng ký module mới:

| File | Thay đổi được phép |
|---|---|
| `imposition_core/src/lib.rs` | Export module `mixed_nesting` mới |
| `native/src/lib.rs` | Đăng ký `MixedNestingRun` |
| `backend/app/main.py` | Include router; đăng ký startup/shutdown job và artifact sweeper mới |
| `backend/app/core/heavy_job_scheduler.py` | Thêm kind `mixed-nesting` vào nhóm whole-machine |
| `backend/app/core/feature_entitlements.py` | Thêm capability mới, không đổi capability cũ |
| `desktop/src/lib/toolRegistry.ts` | Thêm `AppToolId`, lazy component và entry mới |
| `desktop/src/lib/license/features.ts` | Thêm capability mới |
| `desktop/src/i18n/locales/vi.json` | Namespace text mới |
| `desktop/src/i18n/locales/en.json` | Fallback tiếng Anh mới |
| `build_production.ps1` | Probe symbol, paired rollout flags và manifest attestation |
| `release_update.ps1` | Từ chối publish nếu attestation tool mới thiếu hoặc lệch |
| `backend/app/core/artifact_runtime_self_test.py` | Tiny fixture/validator và Free gate trên artifact đóng gói |
| `scripts/run_release_qa.ps1` | Đưa test/tool mới vào release QA |
| `scripts/verify_installed_artifact.ps1` | Xác minh runtime đã cài thật |

Không sửa `HomeTab.tsx` hoặc `App.tsx` cho MVP. Không thêm tool mới vào các Set save/print/zoom hiện có; tool tự sở hữu nút export.

## 8. Feature flag, license và kill-switch

Tên capability thống nhất:

```text
impo.mixed_nesting
```

Tên rollout flag:

```text
Frontend: VITE_MIXED_NESTING_ENABLED
Backend:  PRYNX_MIXED_NESTING_ENABLED
Workers:  PRYNX_MIXED_NEST_WORKERS
```

Quy tắc:

1. Frontend flag OFF: registry không hiển thị tool.
2. Backend flag OFF: từ chối tạo source/job mới bằng 404 trước khi gọi native.
3. Status, Cancel, Delete của job đã tồn tại vẫn hoạt động khi flag vừa bị tắt để không rò thread, slot hoặc file tạm.
4. Start job dùng `Depends(require_feature("impo.mixed_nesting"))`.
5. Status/result/cancel phải xác thực license và đúng owner của job.
6. Không dùng `impo.diecut` hoặc `packaging.dieline`; quyền mới không mở tool cũ và quyền cũ không được dùng làm tên thay thế.
7. Release compiled mặc định HOLD cho tới khi fixture, benchmark và packaged self-test đạt.

Hệ entitlement hiện cho Pro toàn bộ capability Pro trước khi xét danh sách `features`. Vì vậy xóa một feature khỏi key Pro chưa phải remote kill riêng. Nếu cần remote kill thật, phase riêng phải bổ sung signed rollout allow-list chỉ áp dụng cho `impo.mixed_nesting`, mặc định deny; tuyệt đối không đổi semantics capability hiện tại trong dự án này.

## 9. Hợp đồng dữ liệu

### 9.1 Hệ tọa độ

- Đơn vị protocol: mm và degree dạng số hữu hạn; Rust có thể dùng radian `f64` nội bộ.
- Trục X sang phải, trục Y lên trên; góc dương ngược chiều kim đồng hồ và được normalize về `[0°, 360°)`.
- Gốc tờ: góc trái dưới vùng MediaBox logic.
- Mỗi part có `referencePointMm` ổn định do backend canonicalize; không dùng góc trái bbox đã xoay làm pivot.
- Pose duy nhất: `p_sheet = R(theta) * (p_source_local - referencePoint) + (tx, ty)`.
- `tx/ty` đặt reference point lên tờ và là số thực liên tục; không có `translationStepMm` trong legal contract.
- `geometryHash/sourceRevision` bao cả contour, local origin/reference point, flatten tolerance và kernel version.
- UI Canvas/SVG chỉ đổi hệ Y tại adapter render; không ghi ngược pose vào core.
- Export ghép `placementPose ∘ sourceToLocal`, trong đó `sourceToLocal` do backend sở hữu.
- Không lưu đồng thời matrix tùy ý và theta làm hai nguồn chân lý. Nếu artifact cần matrix, validator phải dựng lại từ theta và kiểm parity.

### 9.2 Request tối thiểu

```json
{
  "protocolVersion": 1,
  "seed": 20260826,
  "profile": "balanced",
  "timeBudgetMs": 30000,
  "sheet": {
    "widthMm": 700,
    "heightMm": 1000,
    "marginMm": { "left": 10, "right": 10, "top": 10, "bottom": 10 },
    "maxSheets": 20
  },
  "gapMm": 3,
  "orientationPolicy": {
    "defaultRotation": { "mode": "free" },
    "reflection": "forbidden"
  },
  "parts": [
    {
      "partId": "part-a",
      "quantity": 12,
      "outer": [[0, 0], [80, 0], [80, 40], [0, 40]],
      "holes": [],
      "rotationConstraint": { "mode": "inherit" }
    }
  ]
}
```

Đây là public `CreateJobRequest`, vì vậy client không được chọn `jobId`,
`geometryHash` hoặc `sourceRevision`. Backend phải:

1. Sinh `jobId` bằng CSPRNG/UUID và gắn owner trước khi reserve tài nguyên.
2. Canonicalize polygon rồi tự tính `geometryHash`/`sourceRevision`.
3. Với Product MVP, resolve `sourceId` trong registry đúng owner; revision client gửi
   kèm nếu có chỉ là optimistic precondition, không phải nguồn chân lý.
4. Tạo internal `NestingRequest` bất biến chứa các giá trị server-owned rồi mới gọi Rust.
5. Chặn `Content-Length` quá lớn và đọc request stream bằng byte budget trước khi parse
   JSON/Pydantic; không đợi parse xong mới phát hiện payload vượt giới hạn.

`rotationConstraint` là discriminated union:

- `inherit`: dùng default cấp job.
- `free`: mọi góc trong `[0°, 360°)`.
- `fixed { angleDeg }`: khóa đúng một góc bất kỳ, không chỉ góc vuông.
- `discrete { anglesDeg[] }`: tập góc hữu hạn; các preset 0/180 và 0/90/180/270 được compile về mode này.
- `ranges { arcs[] }`: mỗi cung dùng `{ startDeg, sweepDeg }` với `0 < sweepDeg <= 360`, nên miền đi qua 0° không mơ hồ.

Mode `free/ranges` định nghĩa miền góc liên tục. Coarse sampling chỉ là cách solver tìm kiếm, không biến miền hợp lệ thành một angle grid. Part không được override `reflection` trong protocol v1.

Pydantic và Rust đều phải reject:

- `NaN`, `Infinity`, số âm ngoài miền, polygon suy biến hoặc tự cắt.
- `partId` trùng.
- `quantity` bằng 0 hoặc vượt giới hạn admission.
- Rotation policy sai mode, empty domain, angle không hữu hạn, cung rỗng hoặc sweep vượt 360°.
- `reflection` khác literal `forbidden`; không nhận matrix client-supplied có scale/shear/mirror.
- Request chứa `translationStepMm` hoặc cố ép pose vào grid.
- Request quá số điểm, số part, số instance hoặc byte budget.
- `protocolVersion` không hỗ trợ.

### 9.3 Placement manifest

```json
{
  "protocolVersion": 1,
  "engineVersion": "0.1.0",
  "jobId": "uuid",
  "seed": 20260826,
  "status": "completed",
  "placements": [
    {
      "instanceId": "part-a#0001",
      "partId": "part-a",
      "sheetIndex": 0,
      "pose": {
        "rotationDeg": 13.372849,
        "translateXmm": 123.456789,
        "translateYmm": 67.891234
      },
      "sourceRevision": "sha256"
    }
  ],
  "unplaced": [],
  "stats": {
    "sheetCount": 2,
    "placedCount": 12,
    "unplacedCount": 0,
    "materialUtilization": 0.8123,
    "elapsedMs": 18450,
    "attempts": 32,
    "orientationEvaluations": 1840,
    "poseRefinements": 312,
    "terminationReason": "work_budget_exhausted"
  },
  "validation": {
    "valid": true,
    "validatorVersion": 1
  }
}
```

`sourceRevision` chống việc người dùng thay source nhưng giữ result cũ. `pose` là nguồn chân lý duy nhất, được giữ đủ precision qua backend/frontend/export; số chữ số UI hiển thị không được làm tròn dữ liệu. Frontend phải chạy `resultValidator` trước khi preview/export; backend và Rust vẫn là enforcement boundary cuối.

## 10. Pipeline nhập PDF và chuẩn hóa contour

Product MVP thực hiện theo tuyến riêng:

1. Frontend gửi bytes bằng multipart qua API đã xác thực; không gửi hoặc tin raw local path.
2. Backend cấp `sourceId` ngẫu nhiên, gắn owner và revision hash.
3. Parser mới đọc từng trang và liệt kê contour CUT ứng viên.
4. Nếu có đúng một contour ngoài hợp lệ, đánh dấu `ready`.
5. Nếu có nhiều contour kín, trả danh sách preview để người dùng chọn; trạng thái `ambiguous`, không tự đoán.
6. Nếu không có contour CUT, cho phép người dùng chọn page box làm rectangle chỉ khi họ xác nhận rõ.
7. Flatten Bézier theo tolerance có version trong contract; không làm tròn sớm theo pixel.
8. Loại điểm lặp, collinear noise và vòng cực nhỏ; chuẩn hóa CW/CCW nhất quán.
9. Reject self-intersection, polygon hở, diện tích gần 0 và contour vượt budget.
10. Canonicalize rồi băm thành `geometryHash`/`sourceRevision`.
11. Hole được ghi nhận nhưng MVP coi là solid khi collision/score.
12. Gap được xử lý bằng clearance geometry; validator vẫn kiểm khoảng cách trên contour gốc.

Nếu parser cần PDFium trong thread, chỉ vùng gọi PDFium được bọc `pdfium_guard()` và giữ khóa ngắn. Công việc nhận diện nặng nên chạy process/native riêng; encode thumbnail và ghi file không nằm trong vùng khóa.

## 11. Thuật toán solver

### 11.1 Baseline bắt buộc

Baseline dùng chiến lược đơn giản, deterministic và constraint-safe: chọn góc khóa/đầu tiên hợp lệ rồi Bottom-Left/Best-Fit, nhưng placement X/Y vẫn là tọa độ liên tục và phải hậu kiểm contour thật. Baseline không định nghĩa miền xoay của smart solver; nó chỉ là sàn an toàn:

- Smart solver không được dùng nhiều tờ hơn baseline khi cùng tập part được đặt.
- Nếu smart result invalid hoặc tệ hơn baseline theo score chuẩn, công bố baseline đã validate.
- Baseline cũng phải qua final validator độc lập.
- Baseline cardinal có thể dùng để đo lợi ích free-angle, nhưng không được âm thầm trở thành fallback duy nhất cho mọi profile.

### 11.2 Configuration space và candidate pose

Với part động `B` tại góc `theta` và part đã đặt `A`:

```text
NFP(A, R(theta)B) = A (+) -(R(theta)B)
feasibleXY(theta) = IFP(sheet, R(theta)B) \ union(NFP_i)
```

NFP/IFP là bộ sinh candidate và broad-phase accelerator; final validator không gọi lại NFP làm authority.

- Sắp part theo nhiều thứ tự ổn định: diện tích, cạnh dài, độ lõm, quantity cluster.
- Sinh seed góc từ cạnh part song song cạnh tờ, chênh góc cạnh-part/cạnh-part, minimum-area box, biên rotation range, preset hợp lệ và seeded samples.
- Với mỗi góc đề xuất, sinh candidate `tx/ty` từ vertex/extrema/giao điểm của NFP/IFP, giao với biên tờ và các contact event cạnh-cạnh.
- `tx/ty` không được quét theo pixel/mm grid. Sau candidate ban đầu, part được slide/push liên tục theo X/Y và tiếp tuyến tới first contact.
- Dùng AABB + spatial index để loại nhanh cặp chắc chắn không va chạm; robust fixed-point collision/clearance mới quyết định hợp lệ.
- Gutter được thực thi bằng offset `gap/2` cho mỗi part hoặc phép đo khoảng cách contour tương đương; boundary touch đúng tolerance được phép.
- Cache on-demand theo geometry hashes, internal orientation identity/angle quantum, gap, flatten tolerance và kernel version. Cache quantum chỉ phục vụ memoization; không được ghi ngược thành angle step của contract hoặc pose đầu ra.
- Không precompute mọi cặp x mọi góc. Cache có byte budget/LRU theo trial và không hard-cap máy mạnh vô điều kiện.

### 11.3 Tìm góc thích nghi và refine pose liên tục

`free` không có nghĩa brute-force vô hạn góc. Solver là anytime heuristic: lấy mẫu hữu hạn rồi tinh chỉnh liên tục trong miền hợp lệ; không cam kết tối ưu toàn cục.

1. Sinh critical angles và coarse seeded samples trong rotation domain.
2. Xếp thử bằng true-shape candidate XY, giữ top-K pose theo stable score.
3. Refine quanh pose tốt bằng bước góc giảm dần hoặc derivative-free search.
4. Mỗi lần đổi `theta` phải giải lại `tx/ty`; không xoay part tại chỗ rồi giữ nguyên location.
5. Local search tối ưu joint `(theta, tx, ty)`: rotate-relocate, slide ±X/±Y/tangent, compact, reinsert, swap order và chuyển part khỏi tờ cuối.
6. Kết quả `free/ranges` có thể là 13.372849° hoặc bất kỳ góc thực hợp lệ; không bắt buộc là bội của coarse step.

`fast/balanced/tight` điều khiển số seed, beam width, multi-start, refine depth và work/time budget. Chúng không đổi rotation domain. Mỗi batch angle/candidate/refinement có checkpoint cancel/deadline.

Để deterministic, mỗi trial có `trialId` và seed dẫn xuất cố định; parallelize giữa trial độc lập rồi reduce tuần tự theo stable total order. Test deterministic dùng fixed evaluation budget. Với wall-clock deadline, engine validate best-so-far và trả `terminationReason=deadline`.

### 11.4 Multi-sheet

- Xếp sheet hiện tại cho đến khi không còn pose hợp lệ trong effort của profile.
- Trước khi mở tờ mới, thử reinsert/relocate part vào tờ trước bằng cả `theta`, X và Y.
- Mở sheet mới cùng khổ và tiếp tục đến khi hết part hoặc chạm `maxSheets`.
- Part lớn hơn usable sheet ở mọi orientation hợp lệ được đưa vào `unplaced` với `NO_FEASIBLE_POSE`.
- Hết deadline trước khi phủ work-plan phải dùng reason `SEARCH_BUDGET_EXHAUSTED`, không được báo sai là hình học không vừa.
- Không bỏ part để giảm `sheetCount`.

### 11.5 Score chuẩn

So sánh lexicographic theo thứ tự:

1. Ít `unplaced` hơn.
2. Ít sheet hơn.
3. Used bounding area/extent của sheet cuối nhỏ hơn, để phần vật liệu dư còn hữu dụng hơn.
4. Tổng contact/compactness của contour đã transform tốt hơn.
5. Tie-break deterministic theo canonical placement key `(sheetIndex, partId, angleCanonical, xFixed, yFixed)`.

`materialUtilization = tổng diện tích part / tổng diện tích sheet đã dùng` là số
thống kê bắt buộc, nhưng khi cùng tập part và cùng số sheet thì giá trị này không
đổi theo cách sắp xếp. Vì vậy không dùng nó làm tie-break giả giữa hai layout có
cùng số sheet.

Score dùng cho solver, baseline comparison, benchmark và UI report phải cùng định nghĩa. So sánh số thực phải epsilon-aware hoặc dùng metric fixed-point; parallel reduction không được phụ thuộc thứ tự thread hoàn tất.

### 11.6 Final validator độc lập

Validator không gọi lại logic quyết định của solver. Nó phải kiểm:

- Bảo toàn quantity và uniqueness của `instanceId`.
- `theta/tx/ty` hữu hạn; theta canonical và thuộc rotation domain sau khi resolve global + per-part constraint.
- Tự dựng rigid transform từ theta/translation; từ chối scale, shear, reflection, signed-area reversal và matrix drift.
- Không áp angle step hoặc translation grid trong validator.
- Từng contour đã transform nằm trong usable sheet.
- Không overlap và thỏa `gapMm` cho mọi cặp có khả năng giao nhau bằng đường kiểm fixed-point/segment-distance độc lập với NFP/candidate cache.
- `sourceRevision` khớp internal request do backend canonicalize và ký revision.
- Stats khớp placements thực.

Kết quả không qua validator phải fail job; không “sửa nhẹ” rồi publish âm thầm.

## 12. Job, progress và cancel

### 12.1 API riêng

Technical MVP:

```text
GET    /api/mixed-nesting/capabilities
POST   /api/mixed-nesting/jobs
GET    /api/mixed-nesting/jobs/{job_id}
GET    /api/mixed-nesting/jobs/{job_id}/result
POST   /api/mixed-nesting/jobs/{job_id}/cancel
DELETE /api/mixed-nesting/jobs/{job_id}
```

Product MVP bổ sung:

```text
POST   /api/mixed-nesting/sources
GET    /api/mixed-nesting/sources/{source_id}
POST   /api/mixed-nesting/jobs/{job_id}/export
GET    /api/mixed-nesting/jobs/{job_id}/artifact
```

`POST /jobs` trả 202 ngay. MVP dùng polling 300–500 ms; không sửa hoặc dùng lại WebSocket comparison hiện tại.

### 12.2 State machine

```text
queued
  → waiting_resources
  → normalizing
  → baseline
  → nesting
  → improving
  → validating
  → completed | failed | cancelled
```

Mỗi snapshot gồm phase, progress 0–1, attempt, elapsed, best sheet count, best utilization và message code; không đẩy log chi tiết hàng nghìn dòng lên UI.

### 12.3 Cancel

- Queued: `Future.cancel()`, chuyển terminal và nhả admission slot đúng một lần.
- Waiting resources: cancellation event làm waiter rời hàng đợi.
- Running: gọi `MixedNestingRun.cancel()`; Rust kiểm atomic tại checkpoint.
- Repeated cancel và cancel terminal phải idempotent.
- Cancel không trả layout dở dang và không publish artifact.
- Đóng tab gửi Cancel rồi dọn polling/listener theo đúng `tabId`.

### 12.4 TTL và cleanup

- Technical MVP chỉ giữ result JSON trong registry RAM, TTL khoảng 1 giờ; không ghi artifact.
- Product MVP dùng root riêng mặc định `Path(settings.RESULTS_DIR).parent / "mixed_nesting_data"`, hoặc `PRYNX_MIXED_NESTING_DATA_DIR`; không đặt bên trong `UPLOAD_DIR`, `RESULTS_DIR`, backend `temp` hay root nào mà cleanup hiện tại quét.
- Khi khởi động, manager resolve/canonicalize root và fail-closed nếu root bằng, nằm trong hoặc chứa một shared cleanup root; reject symlink/reparse escape.
- Không import hoặc sửa `artifact_lease.py`/`cleanup.py`. Source, temp và output đều gắn owner/job/revision; route download kiểm license + owner rồi stream file, không công khai qua `/results`.
- Job/artifact manager có quota, terminal TTL, startup sweep và periodic sweep riêng; file đang stream hoặc job đang chạy phải được bảo vệ.
- Artifact chỉ publish bằng rename nguyên tử sau validator và export hoàn tất; cancel/fail xóa temp nhưng không xóa source/result của job khác.
- Test bắt buộc gồm startup/shutdown, restart, stale sweep, storage pressure, path containment và chứng minh các test artifact Imposition/VDP/Edit không đổi.

## 13. Preview phải đồng nhất với export

Nguồn chân lý duy nhất là placement manifest đã validate:

```text
placement manifest
   ├── previewGeometry → SVG/Canvas nhiều tờ
   └── mixed_nesting_pdf_export → PDF giao sản xuất
```

Preview và export đều phải áp đúng một phép biến đổi:

```text
source content → sourceToLocal → R(theta) + (tx, ty) → sheet
```

`theta`, `tx` và `ty` được đọc nguyên giá trị số thực từ manifest. Không để preview tự compact, snap vào pixel/lưới, làm tròn pose hoặc đổi pivot theo bounding box sau xoay. Export không gọi solver lần nữa và không tự dựng một placement "gần giống".

Kiểm artifact bắt buộc:

1. Đọc lại PDF đã xuất.
2. Raster hóa các trang kiểm thử ở DPI cố định.
3. Đối chiếu đủ pose `(theta, tx, ty)`, pivot/reference point, `sourceRevision` và quantity với manifest.
4. Bắt buộc có fixture góc không-cardinal như `13.372849°` và tọa độ X/Y có phần lẻ mm; fixture chỉ dùng `0°` hoặc tọa độ nguyên không chứng minh được parity.
5. Kiểm page size vật lý, lề, số tờ, không overlap và khoảng hở sau khi đọc lại artifact.
6. Kiểm signed-area/hướng nội dung để chứng minh export không mirror; kiểm không mất layer hoặc nội dung in nguồn ngoài rigid transform chủ đích.
7. So sánh raster chỉ là bằng chứng bổ sung. Kiểm hình học/vector và pose manifest vẫn là authority vì raster có thể che sai lệch dưới một pixel.
8. Lưu metric/hash vào test report; không cập nhật golden nếu chưa soi diff hình ảnh.

Frontend dùng `saveBlob` để lưu output. Hủy hộp thoại Save không được xóa result đang xem.

## 14. Điều phối phần cứng và hiệu năng

Mixed Nesting là whole-machine workload. Thêm kind `mixed-nesting` vào `_WHOLE_MACHINE_KINDS` để không chạy đồng thời với N-Up, VDP hoặc Compare đang trải hết CPU.

Worker count phải đi qua `plan_worker_count`; solver không sao chép các con số cap
sang Rust hoặc route:

- Chỉ các tier `<8 GB` và `<16 GB` mới được giảm theo policy tại revision đang audit,
  `per_worker_mb` đã benchmark và RAM khả dụng.
- `≥16 GB`: giữ `cpu_count - 1`/full policy; không hard-cap vô điều kiện.
- Không đọc được RAM: dùng trần CPU, không tự bịa cap bảo thủ.
- Test gọi chính planner nguồn chân lý, không assert một bảng cap chép tay có thể drift.
- `PRYNX_MIXED_NEST_WORKERS` là override dành cho vận hành.

Không dùng global Rayon pool nếu không kiểm soát được số thread. Mỗi job tạo local pool theo budget đã tính và hủy khi job kết thúc.

Free-angle là miền liên tục, không phải danh sách 360 góc để brute-force. Solver dùng critical-angle proposals, seeded sampling và continuous refinement trong `(theta, tx, ty)`. Ba profile chỉ điều khiển effort:

- `fast`: ít trial/proposal/refinement hơn nhưng legal domain vẫn là toàn bộ rotation constraint.
- `balanced`: tăng seed, contact events và refinement quanh pose tốt.
- `tight`: tăng work-plan, multi-start và local refinement; không đổi correctness tolerance hoặc nới validator.

Không profile nào được biến `free` thành allow-list 0/90/180/270, bước góc cố định hoặc lưới X/Y. Coarse sampling chỉ là cơ chế tìm kiếm nội bộ; mọi profile đều cho phép và có thể trả góc không-cardinal. Pose cuối được refine liên tục và vẫn phải qua validator.

Admission ước lượng RAM theo tổng vertex, số orientation proposal đang hoạt động, NFP/IFP cache, spatial index, refinement state và source thumbnail. Cache góc số thực phải dùng canonical internal key/tolerance có version và LRU theo byte budget; không lưu vô hạn một entry cho mỗi giá trị `f64`, cũng không ghi cache quantization ngược thành giới hạn góc hợp lệ.

Máy yếu có thể giảm parallelism, cache và search effort; máy `≥16 GB` không bị giảm chỉ vì một hằng số cố định. Nếu ước lượng vượt ngân sách an toàn, fail sớm bằng lỗi có hướng dẫn thay vì để OOM.

Parallelism ưu tiên giữa các trial/orientation batch độc lập. Mỗi trial có `trialId` và seed dẫn xuất; kết quả được reduce theo stable total order. Benchmark determinism dùng fixed evaluation/work-plan; deadline wall-clock chỉ yêu cầu best-so-far hợp lệ, không yêu cầu hai máy dừng đúng cùng pose.

Progress atomics phải đủ nhẹ để status endpoint và Cancel vẫn phản hồi khi solver dùng full CPU.

## 15. UI/UX và nhập file cục bộ

Tool mới có flow riêng:

```text
Thêm PDF → xác nhận contour/quantity/rotation constraint → cấu hình tờ → Run
        → progress gọn → preview nhiều tờ → Export
```

Nguyên tắc frontend:

- Store theo `tabId`; stale `jobId` không được overwrite result mới.
- Tab nền pause animation/poll tần suất cao và không nhận shortcut/drop.
- `onDirtyChange=true` khi có cấu hình/result chưa export; reset/export thành công cập nhật đúng trạng thái.
- Listener phải cleanup khi đóng tab và revoke mọi object URL.
- Không dùng `OutputPreviewHost` vì component đó gắn với workspace/fileId của luồng khác.
- Preview riêng dùng SVG/Canvas và placement manifest.
- Không hiện chi tiết một dòng cho từng candidate; UI chỉ hiện phase, phần trăm, best result và thống kê tóm tắt.
- Mặc định toàn job hiển thị `Góc xoay: Tự do (0–360°)`; đây là miền liên tục, không phải bước 1°.
- Mỗi part chọn `Kế thừa`, `Tự do`, `Giữ hướng`, `0/180`, `0/90/180/270` hoặc `Khoảng/tập góc tùy chỉnh`. Các preset hữu hạn chỉ thu hẹp part được chọn, không đổi mặc định toàn tool.
- `Fill Direction`/hướng lấp đầy, nếu cung cấp, chỉ là heuristic về thứ tự/điểm bắt đầu; solver vẫn được dịch trái/phải/lên/xuống và refine `(theta, tx, ty)` trong toàn miền hợp lệ.
- X/Y được solver dịch liên tục và tự động; UI không đưa ra `translation step`, `snap grid` hoặc tùy chọn khiến người dùng hiểu nhầm placement chỉ di chuyển theo ô.
- Không có control bật mirror trong MVP. Request/import preset chứa reflection phải bị từ chối rõ, không âm thầm bỏ qua.
- UI giải thích `fast/balanced/tight` là thời gian/effort tìm kiếm, không phải ba mức quyền xoay khác nhau và không phải cam kết tối ưu toàn cục.

MVP chỉ dùng nút `Thêm PDF` và drop zone cục bộ bên trong component. Drop zone phải
`preventDefault`/`stopPropagation`, chỉ nhận PDF sau khi tool đang active và không đăng
ký receiver toàn cục. Native OS/Tauri drop chưa làm trong MVP vì nó buộc sửa dispatcher
dùng chung.

Nếu sau này cần native drop, phải lập phase độc lập và được duyệt riêng. Nhánh mới chỉ
được kích hoạt khi `activeTab.type === "mixed_nesting"` và `tabId` khớp; Combine,
Convert, default PDF routing và mọi receiver cũ phải có test runtime chống xử lý hai lần.

## 16. Ma trận test

### 16.1 Rust geometry và solver

- Rectangle, triangle, L/T/U, polygon lõm, CW/CCW.
- Duplicate/collinear point, degenerate, self-intersection, `NaN`/`Inf`.
- Gap 0 và >0; lề bốn phía khác nhau.
- Part quá khổ; nhiều loại và quantity; duplicate ID.
- Pose `SE(2)` với các góc `0.1°`, `13.372849°`, `44.999°`, `89.999°`, `179.5°`, `359.9°` và `360°→0°`; X/Y âm khi thử candidate, X/Y hợp lệ có phần lẻ và không nằm trên grid.
- Composition `sourceToLocal → placementPose`, pivot/reference point ổn định và round-trip degree↔radian không làm đổi contour ngoài tolerance.
- Rotation constraint `inherit/free/fixed/discrete/ranges`, interval biên, range wrap sau canonicalization, miền rỗng/trùng/lỗi và override từng part.
- Fixture `ANGLE_ONLY` chỉ vừa tờ quanh một góc không-cardinal; cả ba profile phải cho phép và có thể trả pose này trong work-plan nghiệm thu đã khóa.
- Fixture hình L bất đối xứng chứng minh mọi góc tự do vẫn là rotation, không phải reflection; signed-area giữ nguyên.
- Candidate/NFP/IFP so parity với collision/clearance oracle độc lập; có contact vertex-edge, edge-edge, corner-sheet và near-contact.
- Continuous refinement thật sự đổi cả `theta`, `tx`, `ty`; có ca chỉ đạt compactness khi slide một khoảng X/Y không nguyên hoặc xoay lượng dưới 1°.
- Quantity conservation và uniqueness.
- Inside-sheet, no-overlap, clearance bằng validator độc lập.
- Property test polygon và pose `(theta, tx, ty)` ngẫu nhiên có seed, gồm wrap-around và tolerance boundary.
- Cùng canonical input/seed/fixed evaluation budget cho cùng kết quả khi chạy 1 worker và nhiều worker; seed khác vẫn valid.
- Timeout trả best-so-far hợp lệ; cancel cooperative.
- Deadline result ghi đúng `terminationReason`; không test bit-identical giữa máy dựa vào wall-clock.
- Smart không tệ hơn baseline theo score chuẩn.

### 16.2 Native/FFI

- JSON round-trip và protocol mismatch.
- Round-trip giữ đủ precision của góc không-cardinal và X/Y phần lẻ; reject `NaN`, `Inf`, matrix tùy ý và canonical drift.
- Panic/invalid input map thành lỗi hữu hạn, không làm chết sidecar.
- `solve()` nhả GIL; progress/cancel vẫn gọi được.
- Native thiếu hoặc wheel stale trả `503 ENGINE_UNAVAILABLE`, không fallback sang solver cũ/Python.
- Rust validator chạy lần cuối trước khi binding trả result.

### 16.3 Backend API và lifecycle

- `extra=forbid`, finite/range/count/byte budget.
- Resolve đúng global/per-part rotation policy; mặc định thiếu override là `inherit→free`; request đòi reflection bị từ chối.
- Payload cũ dùng `allowedRotationsDeg` hoặc `translationStepMm` không được âm thầm đổi nghĩa trong cùng protocol.
- Invalid request trả 422 trước native.
- Start/status/result/cancel/delete và mọi chuyển trạng thái.
- Unknown/foreign job trả 404 để không lộ job tồn tại.
- Cancel queued/running/terminal, repeated cancel.
- Exception/timeout/cancel luôn nhả scheduler slot và native handle.
- Runtime HOLD trả 404 trước engine.
- Free trả 403 và engine chưa được gọi; Pro/custom exact grant vào được; unrelated grant bị chặn.
- Status/Cancel responsive khi solver chạy full CPU.
- Không log polygon khách hàng, raw path, token hoặc license key.

### 16.4 Desktop

- Registry có đúng một tool `mixed_nesting` và unique key.
- `isImpositionFamilyTool("mixed_nesting") === false`.
- Flag OFF không hiện tool; direct launch fail-closed.
- Free hiện overlay; Pro mở dedicated tab.
- Hai tab có state độc lập.
- Stale job/progress không ghi đè tab active.
- Close tab cancel/release; Cancel dừng poll đúng một lần.
- Source không bị sửa trước completed.
- Preview chỉ bật sau result validation; export dùng cùng manifest.
- UI mặc định free-angle; preset/per-part constraint serialize đúng discriminated union và không tạo angle step ẩn.
- Preview giữ nguyên góc không-cardinal, pivot và X/Y phần lẻ khi zoom/pan/đổi sheet; không mirror hoặc snap do Canvas/SVG transform order.
- File picker/drop zone cục bộ chỉ thêm PDF vào đúng tab đang active; tab nền/đã đóng không nhận.
- Không đăng ký receiver toàn cục; Home, default PDF routing, Combine, Convert, N-Up, Diecut và image receiver giữ nguyên.

### 16.5 Không hồi quy

- Giữ nguyên mọi golden hiện tại; không chạy `-u` để làm xanh.
- Chạy test N-Up, Sticker/Diecut, Dieline nesting, routing, feature entitlement, artifact lease và heavy scheduler trước/sau.
- Full backend pytest phù hợp phạm vi release.
- `desktop`: typecheck và vitest trên Windows thật.
- `imposition_core`, `native`, `print_engine`, Tauri: cargo test/check theo release QA.
- Endpoint ratchet phải xanh; endpoint mới chỉ nằm trong router riêng.
- Khi Mixed Nesting idle, benchmark cũ không chậm p50 quá 5% và peak RSS không tăng quá 5% trên cùng máy/corpus.

## 17. Benchmark corpus và tiêu chí chất lượng

Corpus versioned tối thiểu:

| Mã | Nội dung |
|---|---|
| S20 | 20 instance, 5 loại, mỗi contour ≤50 vertex |
| M100 | 100 instance, 20 loại, có polygon lõm |
| L300 | 300 instance, 40 loại |
| C100 | 100 instance, contour 500–2.000 vertex trước simplify |
| ADV | Sliver, lõm sâu, gần chạm, quá khổ, impossible |
| ANGLE_ONLY | Part chỉ vừa hoặc giảm số tờ khi dùng các góc như 17.3°/33.7°, không thể giải tốt bằng bốn góc cardinal |
| INTERLOCK_FREE | Nhiều part lõm chỉ lồng tốt khi cạnh tiếp xúc ở góc không-cardinal |
| CONTINUOUS_XY | Layout cần slide/compact với X/Y phần lẻ, không nằm trên lưới mm/pixel |
| CONSTRAINTS | Trộn `free`, `fixed`, `discrete`, `ranges` và `inherit` trong cùng job |
| NEAR_CONTACT | Góc/tịnh tiến sát tolerance để bắt overlap, gap và sai số NFP/validator |
| PROD | Ít nhất 3 PDF sản xuất đã ẩn danh |

Mỗi fixture chạy cardinal baseline + Fast/Balanced/Tight, 5 warm runs và fixed seed/work-plan khi đo determinism. Report phải ghi CPU, RAM tier, core/worker count, engine commit, p50/p95 wall time, peak process-tree RSS, temp MB, sheet count, utilization, unplaced, validator time, số orientation proposal/refinement, NFP build/cache-hit và `terminationReason`.

Chạy thêm deadline mode để đo quality-over-time ở các mốc versioned. Không so bit-identical giữa hai máy ở mode này. Mọi benchmark so sánh cardinal baseline với free-angle solver phải ghi rõ baseline là sàn an toàn, không phải legal domain của sản phẩm.

Correctness gate tuyệt đối:

- 0 overlap, out-of-sheet, gap violation, scale, shear và mirror.
- Quantity conservation 100%.
- Mọi pose hữu hạn, thuộc rotation constraint và giữ đúng continuous X/Y; validator không snap hoặc thay pose.
- `ANGLE_ONLY`, `CONTINUOUS_XY` và `CONSTRAINTS` phải đạt expected placement đã version hóa theo work-plan nghiệm thu; cả ba profile vẫn giữ toàn legal domain và có thể trả góc không-cardinal.
- Cancel latency mục tiêu ≤1 giây tại checkpoint.
- Timeout không vượt budget quá `max(1 giây, 10%)`.

Quality gate ban đầu:

- Smart sheet count không lớn hơn baseline.
- Nếu cùng sheet count, used bounding area/extent của sheet cuối không tệ hơn baseline quá ngưỡng 1% đã version hóa trong benchmark.
- `materialUtilization` phải khớp số tính lại từ contour và số sheet, không lấy số tự báo của solver.
- Free-angle phải có ít nhất một corpus được chủ dự án duyệt mà kết quả tốt hơn cardinal baseline; nếu không, chưa có bằng chứng tính năng mới hoạt động dù validator xanh.
- Production fixture có metric envelope được chủ dự án duyệt trước release.
- Không quảng cáo ngang Esko/i-cut hoặc tối ưu toàn cục chỉ từ fixture tổng hợp; benchmark chỉ chứng minh các corpus và budget đã đo.

Hardware gate:

- Giả lập/đo tier 6 GB, 12 GB và 32 GB bằng chính `plan_worker_count`.
- Hai tier `<16 GB` chỉ giảm theo planner và bằng chứng `per_worker_mb`; tier 32 GB giữ `cpu-1`/full policy.
- Peak RSS nằm trong reservation; estimate OOM phải fail trước engine.
- Whole-machine scheduler serialize đúng với N-Up/VDP/Compare.

## 18. Chia phase triển khai — mỗi lô tối đa 5 file

Mỗi phase bắt đầu bằng baseline hẹp, kết thúc bằng diff review và verify. Không gộp phase chỉ để “làm cho xong”. Nếu một phase phát sinh file thứ sáu, tách lô trước khi sửa.

### P0 — Chốt hợp đồng

1. `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md`

Gate: chủ dự án duyệt tên tool, free-angle mặc định, continuous X/Y, per-part rotation constraint, cấm mirror, input PDF, hole-solid và capability riêng.

### P1 — Rust model và control

1. `imposition_core/src/lib.rs`
2. `imposition_core/src/mixed_nesting/mod.rs`
3. `imposition_core/src/mixed_nesting/model.rs`
4. `imposition_core/src/mixed_nesting/control.rs`
5. `imposition_core/tests/mixed_nesting_contract.rs`

Gate: schema/version, pose `SE(2)`, rotation discriminated union, reflection forbidden, tolerance version, seed/cancel/progress compile và unit test xanh; chưa có solver.

### P2a — Transform, orientation và normalize

1. `imposition_core/src/mixed_nesting/mod.rs`
2. `imposition_core/src/mixed_nesting/transform.rs`
3. `imposition_core/src/mixed_nesting/orientation.rs`
4. `imposition_core/src/mixed_nesting/normalize.rs`
5. `imposition_core/tests/mixed_nesting_transform.rs`

Gate: arbitrary-angle transform, continuous X/Y, reference point, canonical angle/range, source-to-local composition và no-reflection property test xanh; không snap grid/bước góc.

### P2b0 — Chốt polygon kernel và dependency

1. `docs/BAO_CAO_SPIKE_MIXED_NESTING_KERNEL.md`
2. `imposition_core/Cargo.toml`
3. `imposition_core/Cargo.lock`
4. `native/Cargo.lock`
5. `THIRD_PARTY_NOTICES.md`

Gate: so fixture concave/sliver/tangency/near-overlap/offset split-collapse và benchmark offset/boolean/Minkowski giữa phương án được khảo sát; dependency được chọn có license phù hợp, `cargo audit`/lock skew xanh và đường đóng gói native được chứng minh. Không đặt `[profile.release]`; nếu chưa đạt thì NO-GO, không tự viết offset bằng `geo` để lách gate.

### P2b — Kernel, geometry và collision

1. `imposition_core/src/mixed_nesting/mod.rs`
2. `imposition_core/src/mixed_nesting/kernel.rs`
3. `imposition_core/src/mixed_nesting/geometry.rs`
4. `imposition_core/src/mixed_nesting/collision.rs`
5. `imposition_core/tests/mixed_nesting_kernel.rs`

Gate: spike/dependency fixed-point được chốt bằng bằng chứng; offset/boolean/collision/clearance ở góc không-cardinal, polygon xấu và near-contact test xanh. Không gọi kernel cũ bị cấm sửa.

### P2c — NFP, spatial index và validator

1. `imposition_core/src/mixed_nesting/mod.rs`
2. `imposition_core/src/mixed_nesting/nfp.rs`
3. `imposition_core/src/mixed_nesting/spatial.rs`
4. `imposition_core/src/mixed_nesting/validator.rs`
5. `imposition_core/tests/mixed_nesting_nfp_validator.rs`

Gate: `NFP(A,R(theta)B)`/IFP và broad phase so parity với collision oracle độc lập; validator chặn overlap/outside/gap/scale/shear/mirror nhưng không áp angle step hoặc X/Y grid.

### P3a — Baseline và score

1. `imposition_core/src/mixed_nesting/mod.rs`
2. `imposition_core/src/mixed_nesting/baseline.rs`
3. `imposition_core/src/mixed_nesting/score.rs`
4. `imposition_core/tests/mixed_nesting_baseline.rs`

Gate: baseline constraint-safe, continuous translation, valid và deterministic; score epsilon/fixed-point có stable total order. Baseline cardinal không được ghi thành legal domain của smart solver.

### P3b — Candidate và continuous refinement

1. `imposition_core/src/mixed_nesting/mod.rs`
2. `imposition_core/src/mixed_nesting/candidates.rs`
3. `imposition_core/src/mixed_nesting/refine.rs`
4. `imposition_core/tests/mixed_nesting_candidates.rs`

Gate: critical-angle/contact candidate, feasible translation từ NFP/IFP, push/slide/reinsert và refinement đồng thời `(theta,tx,ty)` qua fixture non-cardinal/fractional-X-Y; cancel checkpoint có trong vòng dài.

### P4 — Smart solver và multi-start

1. `imposition_core/src/mixed_nesting/mod.rs`
2. `imposition_core/src/mixed_nesting/solver.rs`
3. `imposition_core/src/mixed_nesting/multi_start.rs`
4. `imposition_core/tests/mixed_nesting_solver.rs`

Gate: smart result luôn valid, không tệ hơn baseline theo score chuẩn; cả ba profile giữ free-angle domain; fixed work-plan deterministic giữa worker count; deadline/cancel trả best-so-far hợp lệ với `terminationReason`.

### P5 — PyO3 bridge

1. `native/src/mixed_nesting_py.rs`
2. `native/src/lib.rs`
3. `backend/app/core/mixed_nesting_service.py`
4. `backend/tests/test_mixed_nesting_native.py`

Unit test Rust-side của binding đặt trong `mixed_nesting_py.rs` dưới `#[cfg(test)]`; không tự thêm `rlib` hoặc `native/tests` vào crate đang là `cdylib` chỉ để chạy test.

Gate: GIL được nhả, arbitrary-angle/fractional-X-Y round-trip đúng precision, progress/cancel hoạt động, missing/stale native fail rõ và không fallback solver cũ.

### P6a — Entitlement parity và rollout HOLD

1. `backend/app/core/feature_entitlements.py`
2. `desktop/src/lib/license/features.ts`
3. `backend/tests/test_feature_entitlements.py`
4. `desktop/src/lib/license/features.test.ts`
5. `backend/tests/test_mixed_nesting_entitlement_contract.py`

Gate: hai catalog vẫn parity trong cùng một commit; Free/Pro/custom grant/unknown capability đúng. Chưa có route/component; flag backend/frontend được triển khai ở P7/P9 và phải mặc định HOLD.

### P6b — Scheduler và admission

1. `backend/app/core/heavy_job_scheduler.py`
2. `backend/tests/test_heavy_scheduler_kind_gate.py`
3. `backend/tests/test_mixed_nesting_admission.py`

Gate: kind mới dùng whole-machine slot, planner RAM là nguồn chân lý; admission tính orientation proposal/NFP/refinement state thay vì “số rotation”; exception/cancel nhả slot. Chưa có HTTP route reachable.

**AMENDMENT B (2026-08-26, trong lúc làm P6b — đã áp dụng).** Danh sách trên thiếu một file để đặt code admission. Bằng chứng:

- §7 (dòng 283) giới hạn thay đổi ở `backend/app/core/heavy_job_scheduler.py` đúng một việc: “Thêm kind `mixed-nesting` vào nhóm whole-machine”. Nhồi thêm ước lượng RAM riêng của tính năng vào module dùng chung này là trái §7 và làm bẩn file shared.
- §6.3 (dòng 240–248) không liệt kê module admission nào; module gần nghĩa nhất là `backend/app/core/mixed_nesting_service.py` — đã tồn tại từ P5 và chính là mặt tiền sidecar ⇄ engine.

Vì vậy P6b sửa **4 file** (vẫn ≤5): ba file đã ghi, cộng `backend/app/core/mixed_nesting_service.py` để chứa `plan_hardware`/`describe_workload`/`assert_fits_memory`. Không tạo module mới, không chạm file nào ngoài phạm vi tính năng.

Kèm theo, `SEARCH_EFFORT_BY_PROFILE` trong Python là **bản sao có kiểm** của `SearchEffort::for_profile` (Rust). Lý do phải sao: admission chạy **trước** khi biết native có nạp được không, nên không thể hỏi engine. Chống drift bằng `test_effort_python_parity_voi_rust` — đọc trực tiếp `imposition_core/src/mixed_nesting/control.rs` và so từng số, cùng kiểu với `test_frontend_and_backend_feature_catalogs_have_exact_parity` đang dùng cho danh mục quyền.

### P7a — Job registry và API Technical MVP

1. `backend/app/core/mixed_nesting_jobs.py`
2. `backend/app/schemas/mixed_nesting.py`
3. `backend/app/api/routes/mixed_nesting.py`
4. `backend/app/main.py`
5. `backend/tests/test_mixed_nesting_api.py`

Gate: 202/status/result/cancel/delete, owner isolation, bounded body, server-owned job/revision, TTL và shutdown xanh. Route chỉ reachable sau entitlement/scheduler P6.

### P7b — Lifecycle và benchmark qua API/native thật

1. `backend/tests/test_mixed_nesting_lifecycle.py`
2. `backend/tests/test_mixed_nesting_feature_gate.py`
3. `scripts/benchmark_mixed_nesting.py`
4. `backend/tests/fixtures/mixed_nesting/corpus.json`
5. `backend/tests/test_mixed_nesting_benchmark_contract.py`

Gate: fixed-work-plan determinism giữa worker count, deadline termination reason, time budget, cancel queued/running, Free bị chặn trước engine và benchmark gọi đúng bridge thật với corpus ANGLE_ONLY/CONTINUOUS_XY/CONSTRAINTS cùng report machine/search metrics.

### P8 — Frontend contract và shell

1. `desktop/src/lib/mixed-nesting/types.ts`
2. `desktop/src/lib/mixed-nesting/api.ts`
3. `desktop/src/lib/mixed-nesting/resultValidator.ts`
4. `desktop/src/lib/mixed-nesting/api.test.ts`
5. `desktop/src/lib/mixed-nesting/resultValidator.test.ts`

Gate: contract frontend/backend parity cho rotation discriminated union và pose số thực; legacy field/malformed result/matrix tùy ý bị chặn, arbitrary-angle/fractional-X-Y giữ precision.

### P9 — Đăng ký tool standalone

1. `desktop/src/lib/toolRegistry.ts`
2. `desktop/src/components/mixed-nesting/MixedNestingTool.tsx`
3. `desktop/src/lib/toolRegistry.routing.test.ts`
4. `desktop/src/hooks/useToolActivationGuard.test.ts`

Gate: tool duy nhất, không thuộc imposition family, flag/license fail-closed; Home/App không cần sửa.

**AMENDMENT C (2026-08-26, trong lúc làm P9 — đã áp dụng).** Danh sách trên thiếu chỗ đọc cờ `VITE_MIXED_NESTING_ENABLED`. Bằng chứng và cách giải quyết:

- Tiền lệ trong repo: cờ `VITE_LOGO_REBUILD_ENABLED` **không** nằm trong `toolRegistry.ts` mà ở một module nhẹ riêng (`desktop/src/components/imposition-tools/sections/preprocessRouterTools.ts:21-33`), rồi registry `import` vào và spread entry có điều kiện (`toolRegistry.ts:793-812`). Lý do là registry kéo cả cây `lazy()` component nên không dùng được từ module ngoài app shell.
- §7 (dòng 286) giới hạn thay đổi ở `desktop/src/lib/toolRegistry.ts` đúng ba việc: “Thêm `AppToolId`, lazy component và entry mới”.

Vì vậy P9 thêm `desktop/src/lib/mixed-nesting/rollout.ts` (quy tắc thuần `isMixedNestingEnabled` + hằng `MIXED_NESTING_ENABLED` + tên hai cờ) và sửa **6 file**: 4 file đã ghi, cộng `rollout.ts` và `desktop/src/lib/license/features.test.ts` — file cuối là test P6a có chủ đích khẳng định “chưa gắn tool nào”, nên P9 **phải** cập nhật nó thay vì để đỏ. Không có test rollout riêng: các ca đó nằm trong `toolRegistry.routing.test.ts`.

Ngoài ra `TOOL_KEYWORDS` được thêm một dòng cho `mixed_nesting`. Đây vẫn thuộc “entry mới” theo tinh thần §7: thiếu nó thì tool có trong registry nhưng không tìm được bằng ô tìm kiếm ở Home, tức entry chưa hoàn chỉnh.

### P10 — State, input và controls

1. `desktop/src/stores/useMixedNestingStore.ts`
2. `desktop/src/components/mixed-nesting/InputPanel.tsx`
3. `desktop/src/components/mixed-nesting/PartsTable.tsx`
4. `desktop/src/styles/mixed-nesting.css`
5. `desktop/src/stores/useMixedNestingStore.test.ts`

Gate: hai tab độc lập, rotation controls mặc định free và per-part override serialize đúng, không có mirror/grid ẩn; run/cancel/stale job và dirty state đúng.

**AMENDMENT D (2026-08-26, trong lúc làm P10 — đã áp dụng).** P10 sửa **6 file**: 5 file đã ghi, cộng `desktop/src/lib/mixed-nesting/rotationEditing.ts`. Lý do là một chốt build thật, không phải sở thích:

- `InputPanel.tsx` và `PartsTable.tsx` **đều** cần `switchRotationMode`, và eslint rule `react-refresh/only-export-components` (đang bật, `npm run lint` chặn build) không cho một file component export hàm thuần. Đo được: giữ hàm trong `PartsTable.tsx` cho 3 lỗi lint.
- Vì vậy `parseAngleList`/`formatAngleList`/`switchRotationMode`/`ROTATION_MODE_LABEL`/`ROTATION_MODE_ORDER` nằm ở module thuần dùng chung.

Ghi chú thứ tự phase: P10/P11 tạo panel và preview, nhưng `MixedNestingTool.tsx` — nơi render chúng — chỉ được sửa ở **P13**. Vì vậy sau P10 các panel **chưa** được nối vào vỏ; việc nối làm ở P13 cùng lượt i18n. `mixed-nesting.css` được `InputPanel.tsx` nạp để không thành file chết trong lúc chờ.

### P11 — Preview và summary

1. `desktop/src/components/mixed-nesting/NestingPreview.tsx`
2. `desktop/src/lib/mixed-nesting/previewGeometry.ts`
3. `desktop/src/components/mixed-nesting/ResultSummary.tsx`
4. `desktop/src/lib/mixed-nesting/previewGeometry.test.ts`
5. `desktop/src/components/mixed-nesting/MixedNestingTool.test.tsx`

Gate: nhiều sheet, pause tab nền, preview đúng manifest ở góc không-cardinal/X-Y phần lẻ/reference point; không tự làm tròn, snap, recompact hoặc mirror placement.

**AMENDMENT E (2026-08-26, trong lúc làm P11 — đã áp dụng).** Hai việc.

*Một — pivot cho preview.* Manifest §9.3 **không** mang `referencePointMm`, và protocol công khai không cho client gửi nó (server-owned). Nhưng preview cần pivot để dựng `p_sheet = R(theta)·(p_local − ref) + t`. Bằng chứng ở code: `imposition_core/src/mixed_nesting/normalize.rs:643` `derive_reference_point` là **trọng tâm diện tích của contour ngoài**, tức một **hàm thuần của dữ liệu frontend đang giữ** — không phải một quyết định layout. Vì vậy `previewGeometry.ts` tính lại đúng công thức đó thay vì đoán pivot khác. Chống trôi: `previewGeometry.test.ts` đọc `normalize.rs` và đòi khớp `REFERENCE_POINT_RULE_VERSION` + `NORMALIZE_RULE_VERSION`; Rust ghi “Đổi quy tắc là đổi hợp đồng” nên mọi thay đổi phải tăng version và test frontend sẽ đỏ. Đã kiểm thêm: loại đỉnh thẳng hàng KHÔNG đổi trọng tâm, nên contour thô và contour đã chuẩn hoá cho cùng pivot. Nếu sau này cần chắc hơn thì phase riêng cho backend echo `referencePointMm` vào manifest (đòi sửa Rust + schema, ngoài phạm vi P11).

*Hai — số file.* P11 sửa **6 file**: 5 file đã ghi, cộng `desktop/src/lib/mixed-nesting/resultText.ts`. Lý do giống Amendment D: eslint `react-refresh/only-export-components` không cho `ResultSummary.tsx` export bảng chuỗi và hàm định dạng (đo được 4 lỗi lint). Đặt ở lib cũng gọn cho P13 khi chuyển sang i18n.

### P12 — Pipeline source PDF

1. `backend/app/workers/mixed_nesting_pdf_source.py`
2. `backend/app/schemas/mixed_nesting_source.py`
3. `backend/app/api/routes/mixed_nesting.py`
4. `backend/tests/test_mixed_nesting_pdf_source.py`
5. `backend/tests/fixtures/mixed_nesting_sources/manifest.json`

Gate: source endpoints đi qua router đã đăng ký; ownership, bounded upload, contour ready/ambiguous/rejected, no raw path và no PDFium thread race.

**AMENDMENT F (2026-08-26, trong lúc làm P12 — đã áp dụng).** Đúng 5 file như kế hoạch, nhưng hai lựa chọn kỹ thuật khác dự kiến, và cả hai đều **thu hẹp** rủi ro:

*Một — không dùng PDFium.* §10 viết "Nếu parser cần PDFium trong thread, chỉ vùng gọi PDFium được bọc `pdfium_guard()`". Không cần: repo đã có `backend/app/workers/pdf_content_parser.py:590` `extract_vector_paths` + `parse_content_stream` — tokenizer content stream chạy trên **pikepdf thuần**, giải cả Form XObject theo CTM. Dùng nó thì gate "no PDFium thread race" đúng **theo cấu trúc** chứ không nhờ bọc khóa cẩn thận. Có test AST chốt: module không import `pypdfium2`/`pdfium_lock` và không gọi `pdfium_guard`/`PdfDocument`.

Kèm một bẫy đã trả giá: parser tự ghi trong docstring (`parse_content_stream`, dòng 511–514) rằng nó dùng **hệ toạ độ riêng với Y đã lật**. Dùng thẳng số của parser sẽ cho contour **soi gương** — mà lật khuôn là điều cả dự án cấm. Đã lật lại một lần trong `_subpaths_of` và có test `test_contour_khong_bi_soi_guong` dùng tam giác vuông không đối xứng để chốt.

*Hai — không ghi file, không có storage root.* §12.4 dự kiến Product MVP có root artifact riêng cho source. Không cần cho phần nhập khuôn: lồng ghép chỉ cần **hình học**. Bytes PDF được phân tích trong RAM rồi bỏ; registry giữ polygon (vài KB mỗi khuôn) với TTL 1 giờ và cách ly owner. Preview để chọn đường bế vẽ được bằng chính polygon nên cũng không cần thumbnail raster. Hệ quả: cả lớp rủi ro path containment/symlink/sweep của §12.4 **không tồn tại** ở P12 thay vì phải phòng. Có test AST chốt module không import `os`/`pathlib`/`shutil`/`tempfile` và không gọi `open()`/`Path()`.

*Lỗi test bắt được.* Thứ tự kiểm trong `_classify` ban đầu xét diện tích trước tự cắt. Vòng hình nơ `(100,100)→(300,300)→(300,100)→(100,300)` có hai tam giác ngược chiều nên **diện tích có dấu triệt tiêu về 0**, và bị loại **im lặng** như nhiễu — đúng thứ §10.9 cấm. Đã đổi thứ tự: đóng vòng → trần đỉnh → tự cắt → diện tích.

*Thêm một endpoint ngoài §12.1.* `POST /sources/{id}/page-box` là endpoint **riêng** để xác nhận dùng khổ trang (§10.6), cố ý không làm một cờ boolean trong `POST /sources/{id}/select`: §10.6 đòi người dùng xác nhận rõ, còn một trường boolean lẫn trong payload khác thì quá dễ bị đặt mặc định.

### P13 — File picker cục bộ và i18n

1. `desktop/src/components/mixed-nesting/InputPanel.tsx`
2. `desktop/src/components/mixed-nesting/MixedNestingTool.tsx`
3. `desktop/src/i18n/locales/vi.json`
4. `desktop/src/i18n/locales/en.json`
5. `desktop/src/components/mixed-nesting/MixedNestingFileInput.test.tsx`

Gate: picker/drop zone cục bộ chỉ nhận PDF cho đúng tab; không sửa `tabNavigation.ts` hoặc `useIncomingFileDispatcher.ts`; i18n catalog xanh.

**AMENDMENT G (2026-08-26, trong lúc làm P13 — đã áp dụng).** Ba việc.

*Một — thiếu file component cho chính test đã liệt kê.* Danh sách P13 có `MixedNestingFileInput.test.tsx` nhưng **không có** `MixedNestingFileInput.tsx`. Đã tạo component đó. Cùng lượt phải thêm hai file nữa để nối được: `desktop/src/lib/mixed-nesting/api.ts` (5 hàm gọi endpoint `/sources` của P12) và `desktop/src/lib/mixed-nesting/types.ts` (kiểu `SourceRecord`/`ContourCandidate`/`SourceStatus`). Tổng P13 sửa **7 file**. Không có cách nào nối UI với P12 mà ít file hơn: endpoint nguồn mới ra ở P12 nên client chưa từng có hàm gọi.

*Hai — i18n hoãn sang lô riêng.* Đây là **lệch có chủ đích, không phải sót**. Lý do: chuyển ~45 chuỗi của 6 component sang namespace đòi mọi khoá phải có ở **cả** `vi.json` và `en.json` (test `i18nCatalog.test.ts` chặn), và làm nửa vời để lại bề mặt lẫn lộn khó hoàn thiện hơn là chưa làm. Hiện các component dùng chuỗi tiếng Việt trực tiếp nên `i18nCatalog` **vẫn xanh** (không có khoá `t()` mới nào để kiểm). Việc cần làm ở lô sau: thêm namespace `mixedNesting` vào hai file locale và chuyển chuỗi ở `MixedNestingTool.tsx`, `MixedNestingFileInput.tsx`, `InputPanel.tsx`, `PartsTable.tsx`, `NestingPreview.tsx`, `ResultSummary.tsx`, `lib/mixed-nesting/resultText.ts`.

*Ba — hai lỗi lint đã trả giá.* `usePageBox` bị eslint coi là custom hook vì tên bắt đầu bằng `use` → `react-hooks/rules-of-hooks` chặn gọi trong callback; đã đổi thành `choosePageBox`. Và ghi `closingRef.current` **trong render** bị `react-hooks/refs` chặn; đã chuyển vào effect — cách đó cũng đúng hơn với StrictMode.

### P14a — Export và storage root riêng

1. `backend/app/workers/mixed_nesting_pdf_export.py`
2. `backend/app/core/mixed_nesting_artifacts.py`
3. `backend/app/schemas/mixed_nesting.py`
4. `backend/app/api/routes/mixed_nesting.py`
5. `backend/tests/test_mixed_nesting_export_artifacts.py`

Gate: root resolve nằm ngoài mọi shared cleanup root; override lồng/symlink fail-closed; preview/export parity đủ pose arbitrary-angle/continuous-X-Y, atomic publish và owner isolation xanh.

### P14b — Lifecycle, sweep và shutdown

1. `backend/app/core/mixed_nesting_jobs.py`
2. `backend/app/main.py`
3. `backend/tests/test_mixed_nesting_artifact_lifecycle.py`
4. `backend/tests/test_mixed_nesting_storage_isolation.py`
5. `docs/CAU_HINH_ENV.md`

Gate: startup/periodic sweep/shutdown được đăng ký rõ; active stream/job được bảo vệ; restart/stale/pressure/cancel không để file rác. Không sửa `artifact_lease.py`/`cleanup.py`; full regression artifact cũ vẫn xanh.

**AMENDMENT H (2026-08-26, trong lúc làm P14a + P14b — đã áp dụng).** Bốn việc.

*Một — số file lệch, và lệch theo hướng dồn về P14a.* P14a sửa **7 file**: 5 file đã ghi, cộng hai file sau.

- `backend/app/core/mixed_nesting_jobs.py` — kế hoạch xếp nó ở P14b nhưng phải làm ngay ở P14a. Lý do là hợp đồng của chính lệnh xuất: registry chỉ lưu manifest kết quả, **không** lưu request đã validate, nên endpoint xuất không có cách nào biết khổ tờ. Đã thêm `request_of(job_id, owner)`. Nhận khổ tờ từ body lần xuất là **mở đường xuất trên khổ khác khổ đã validate** khi chạy solve, nên bị loại.
- `backend/app/workers/mixed_nesting_pdf_source.py` — không nằm trong danh sách P14 nào. Cần `all_for_owner(owner)` để băm `source_revision` của **mọi** nguồn đã dùng vào `ArtifactRecord`; không có nó thì không chốt được "đổi khuôn nhưng giữ file cũ".

Đối xứng lại, P14b sửa **4 file**: `main.py`, hai file test, `docs/CAU_HINH_ENV.md`. Tổng P14 vẫn là 11 file, chỉ đổi chỗ.

*Hai — nội dung file xuất.* Xuất **đường bế 1:1, vẽ bằng nét (`S`)**, không tô đặc và không đặt artwork. Hai cái bị loại đều vì lý do nghề in: tô đặc thì **che mất lỗ khoét** (`inner_rings` biến thành mảng đen, thợ bế không thấy đường trong); còn đặt artwork thì không làm được vì P12 cố ý **không giữ bytes PDF nguồn** (Amendment F: contour nằm trong RAM, TTL 1 giờ). Parity export↔manifest kiểm bằng cách **đọc lại** file đã xuất qua chính parser của P12 — tức một đường độc lập, không so với biến trung gian của mình. Khớp tới **0,001 mm**.

*Ba — root artifact sai thì TẮT TÍNH NĂNG, không giết sidecar.* `main.py` bắt `ArtifactRootUnsafe` và đặt `app.state.mixed_nesting_artifacts_ready = False`; nhánh shutdown đọc cờ đó nên không dọn cái chưa dựng. Raise ở startup đã bị loại: một biến môi trường sai làm **mọi** tính năng khác chết oan. Phép kiểm containment chạy **cả hai chiều** trên đường đã `resolve()` — chiều "root chứa shared root" dễ bị bỏ sót và hậu quả nặng hơn (sweeper của ta xoá file của tính năng khác).

*Bốn — bốn bẫy test đã trả giá, ghi lại để lô sau không lặp.* (a) Test đọc `main.py` phải khớp **tên biến thật** ở chỗ hủy task (`mn_sweep_task`, không phải `mixed_nesting_sweep_task`). (b) `MixedNestingArtifactStore(ttl_seconds=0.0)` làm `get()` bên trong `open_for_read` tự quét sạch **trước khi** stream kịp bắt đầu, nên test "sweeper không xoá file đang tải" hoá ra kiểm không đúng thứ nó muốn kiểm; dùng `ttl=0.05` + `sleep(0.12)`. (c) Test quota: payload 521 byte/artifact nên trần phải là **1100**, không phải 1600 — trần rộng hơn tổng ba con thì `_make_room` không chạy và test mù. (d) `time.monotonic` trên Windows lấy từ `GetTickCount64`, phân giải **~15,6 ms**: `sleep(0.01)` cho ra **đúng cùng một giá trị**, phải `sleep(0.05)`.

**AMENDMENT I (2026-08-26, khi verify tổng thể P11–P14 — đã áp dụng).** Ba việc, cả ba là lỗ hổng bị lộ ra **nhờ** verify chứ không nhờ đọc lại kế hoạch.

*Một — lệnh xuất chưa có mặt trên giao diện.* P14a mở `POST /jobs/{id}/export` + `GET /jobs/{id}/artifact` nhưng **không phase nào** nối chúng vào UI: P13 làm xong trước khi endpoint tồn tại, P15/P16 là đóng gói và rollout. Kết quả là backend xuất được mà người dùng không bấm được — tool coi như chưa dùng được end-to-end. Đã nối, thêm **4 file** vào phạm vi P14a: `desktop/src/lib/mixed-nesting/types.ts` (`ExportResult`), `desktop/src/lib/mixed-nesting/api.ts` (`exportJob`, `fetchJobArtifact`), `desktop/src/components/mixed-nesting/MixedNestingTool.tsx` (nút **Xuất PDF**, dùng lại `lib/saveBlob.ts` nên đi đúng đường Save dialog + ghi nguyên tử của Tauri), `MixedNestingTool.test.tsx` (+9 test). `exportJob` cố ý **chỉ nhận `jobId`** và có test chốt `exportJob.mock.calls[0]` đúng bằng `['job-1']`.

*Hai — "Bỏ kết quả" không bỏ kết quả.* Lỗi sản phẩm, do test mới soi ra. `useMixedNestingStore::clearJob` chỉ đặt `job: null`, còn `hasUsableResult` lại chỉ soi `manifest` + `manifestRevision`, nên sau khi bấm nút thì job đã bị xoá trên sidecar mà preview, bảng tóm tắt và nút Xuất PDF **vẫn nằm đó** — màn hình hiện một phương án không còn xuất được nữa. Đã sửa `clearJob` dọn luôn `manifest`/`manifestRevision`/`issues`/`error`/`activeSheetIndex`, giữ nguyên dữ liệu đầu vào. Test cũ `clearJob bỏ job nhưng giữ dữ liệu đầu vào` vẫn xanh vì nó chỉ đòi giữ `parts`; thêm một test nữa chốt phần kết quả.

*Hai-bis — lỗi NẶNG NHẤT của lô, và 33 test của P14a không thấy.* Bản đầu của `_part_geometry_for` tra registry nguồn PDF rồi khớp `partId.endswith(candidate.candidate_id)`. Nhưng `candidate_id` chỉ duy nhất **trong một file** — `mixed_nesting_pdf_source.py:402` sinh `p{trang}-c{n}`. Thả hai PDF một trang, tức **ca dùng chính của cả tool**, thì cả hai đều ra `p1-c1`; hai `partId` khác nhau cùng trúng record đầu tiên và con thứ hai nhận hình của con thứ nhất. Hậu quả: **thợ bế nhận sai đường bế**, và sai một cách im lặng vì file PDF vẫn hợp lệ, vẫn đủ số con, vẫn đúng khổ.

Vì sao 33 test cũ vẫn xanh: chúng gọi `export_manifest_to_pdf` trực tiếp ở tầng worker, **không test nào chạm bước route phân giải `partId`**. Điểm mù nằm ở ranh giới giữa hai tầng, đúng chỗ test theo tầng hay bỏ sót.

Đã sửa gốc: hình học lấy từ `mixed_nesting_jobs.request_of` — bản request **đã validate** và đã đưa cho engine. `partId` trong đó được schema kiểm **duy nhất** (`schemas/mixed_nesting.py:280`) nên tra theo nó đúng **theo cấu trúc**, không nhờ cách đặt tên. Cùng lúc bỏ được phụ thuộc TTL 1 giờ của registry nguồn, nên xuất lại sau khi khuôn đã hết hạn vẫn đúng; và `source_revision` chuyển sang băm chính hình đã nesting (`_geometry_revision`) thay vì cộng chuỗi `revision()` của các nguồn — nguồn hết hạn không còn làm băm đổi oan. `all_for_owner` thành code chết và đã bị xoá. Thêm **6 test** ở nhóm 6 của `test_mixed_nesting_export_artifacts.py`, trong đó `test_hai_khuon_khac_file_cung_ma_ung_vien_khong_lay_lan_hinh` chốt đúng ca hồi quy (so số đỉnh 4 vs 6 và diện tích), và một test AST cấm hàm đọc lại `mixed_nesting_sources`.

*Ba — một test đua, đã sửa test không sửa code.* `test_cancel_khi_con_trong_hang_doi` đọc `runs` **ngay sau** `POST /jobs`. Nhưng 202 trả về khi job vừa vào registry và được `submit`, còn `run_factory` chạy trên thread của executor sau đó; `assert runs and runs[0].solve_started.wait(5.0)` short-circuit nên nó đỏ **tức thì**, không hề chờ. Bằng chứng phân biệt: lượt đỏ tốn 3,4 s — bằng lượt xanh, chứ không phải 5 s+ như hết giờ chờ. Đo: đỏ 1/6 lượt trước khi vá, 10/10 xanh sau khi vá. Đã thêm `_cho_run_factory(runs, timeout)`. Đường bị nghi oan lúc đầu là admission RAM (`memory_budget_mb() = khả dụng × 0,75` có thể từ chối job khi máy đang tải); giả thuyết đó **bị loại** vì thời gian lượt đỏ không khớp, nên không thêm fixture vô hiệu admission.

**AMENDMENT J (2026-08-26, sau khi chủ dự án xem UI — đã áp dụng).** Ba khiếm khuyết chủ dự án chỉ ra, cả ba là lỗi thật của bản trước.

*Một — UI đi lạc khỏi phần mềm.* Bản đầu tự dựng header ngang toàn trang (`h1.text-lg`), nút hành động trong header, và lưới hai cột bằng CSS riêng `.mn-layout`. Bộ khung thật của phần mềm — lấy Bình tem bế làm chuẩn, tức `ImpositionTab` với `lockedMode: 'sticker_imposer'` — là workspace kiểu Acrobat: vùng xem chiếm bên trái, panel thiết lập bên phải, **header tool nằm TRONG panel** (chữ nhỏ in hoa căn giữa), nút chạy dán đáy panel bằng `mt-auto`, tiến độ là **overlay phủ vùng xem** chứ không phải thanh trong trang, lỗi là khối `bg-red-50` cuối panel, field theo khuôn `label w-[95px]` + control `h-8`.

Đã dựng lại theo đúng khung đó. Hệ quả kéo theo, không phải lựa chọn thẩm mỹ: panel rộng ~380px nên **bảng chi tiết bốn cột không còn vừa** (cột xoay đặt 260px sẽ bị bóp còn ~120px và ô "danh sách góc" cắt mất chữ số — mất chữ số là mất dữ liệu), vì vậy `PartsTable` chuyển sang **danh sách thẻ dọc**. Thêm `PanelPrimitives.tsx` gói khuôn field lại đúng một lần thay vì copy inline mười chỗ.

`PanelPrimitives` **nhân bản** `Divider`/`Checkbox`/`Accordion` của `imposition-tools/SharedUI.tsx` thay vì import, vì `SharedUI` cũng export `ToolItem` và ES import kéo theo **cả module**: `ToolHelpModal` → `ProFeatureBadge` → `useAuthStore` bị nhồi vào lazy chunk của một tool standalone. Đo được ngay ở test: một test render tab nền đi từ mili-giây lên **quá 5 giây rồi timeout** chỉ vì `vi.resetModules()` phải nạp lại cây đó; sau khi nhân bản, cả file test còn 3,1 s. Hai lỗi test đi kèm (trùng `mn-input-panel`, `window.addEventListener` gọi 4 lần) hoá ra chỉ là **dây theo** — test timeout không kịp dọn DOM. Chống trôi hình thức bằng `PanelPrimitives.test.tsx`: nó đọc `SharedUI.tsx` và đòi từng chuỗi class còn nguyên, đồng thời cấm mọi file trong `mixed-nesting/` import `SharedUI`. Bẫy đã trả giá: test bắt **chuỗi con** `'imposition-tools/SharedUI'` thì tự tố cáo chính comment giải thích của nó — phải bắt **câu lệnh import** bằng regex.

Cùng lượt xoá `desktop/src/styles/mixed-nesting.css`. Sau khi dựng lại, chỉ còn ba class dùng thật và cả ba viết được bằng Tailwind; nút tăng/giảm của ô số vẫn bị tắt, nay bằng arbitrary variant `[&::-webkit-inner-spin-button]:appearance-none`. **Lỗi suýt lọt**: `InputPanel` từng là nơi `import` stylesheet đó; sau khi viết lại nó không còn import, nên ba class `.mn-sheet-*` của `NestingPreview` mất style mà không ai báo — chỉ phát hiện khi soi lại xem còn ai import file CSS không.

*Hai — tool bị cô lập khỏi chuỗi công cụ.* `App.tsx` có bốn nhánh render tool; `MixedNestingTool` và `DielineTool` rơi vào **nhánh mặc định**, nhánh này chỉ truyền `tabId`/`isActive`/`onTitleChange`/`onDirtyChange` — không `initialFile`, không `onSpawnTab`. Đó là nguyên nhân cấu trúc, không phải thiếu sót ở tool. Đã thêm hai prop đó vào nhánh mặc định: `initialFile` mở chiều **vào**, `onSpawnTab` mở chiều **ra** (xuất xong bấm "Mở kết quả sang thẻ mới" là có ngay nút **In** và **Bế** của viewer).

Chiều vào từ Bù xén cần một cửa mới: `onSpawnTab` hard-code `handleOpenApp('imposition', …)` nên chỉ mở được biến thể `ImpositionTab`, còn tiền lệ duy nhất trong họ khuôn bế (`StickerTool.openImpositionTool`) chỉ đổi `activeDashboardTool` trong **cùng** một tab. Đã thêm `requestOpenTool(toolId, file?)` + event `prynx-open-tool-request` vào `lib/tabNavigation.ts` — đúng chỗ dự án đã giữ helper điều hướng. Chọn event thay vì prop vì chuỗi prop từ shell tới `StickerTool` đi qua `ImpositionTab` → `ImposerDashboard` → `PreprocessingRouter` → `StickerCutlineTool`, tức **hai god file**; xuyên prop qua đó chỉ để truyền một callback là đổi rủi ro lớn lấy tiện lợi nhỏ, và `StickerTool` vốn đã tự đọc `useImposerSettingsStore`/`findToolByUniqueKey`. Quyền kiểm **hai lần**: bên gửi qua `useToolActivationGuard` như mọi cửa mở tool, bên nhận (shell) kiểm lại registry + `canUse` và **fail-closed** với id lạ, tool đang tắt, hoặc gói không đủ quyền.

*Ba — i18n.* Đã trả nợ: **6 namespace / 115 khoá** vào **cả** `vi.json` và `en.json`, theo quy ước `<thư mục tool>.<tênFileCamelCase>` (tiền lệ `dieline.nesting`), cộng 3 khoá vào `preprocess.sticker` cho nút chuyển tiếp. Hai bẫy đã trả giá: (a) khoá i18n **động** như `` t(`ns:profile_${value}`) `` **lọt lưới** `i18nCatalog.test.ts` vì test chỉ thu chuỗi literal — lúc chạy sẽ hiện raw key, nên phải dùng khoá tĩnh; (b) `vi.json`/`en.json` **không round-trip được** qua `JSON.parse`+`JSON.stringify` (thứ tự khoá trong `preprocess.logoRebuild` lệch — dấu hiệu có khoá trùng — và dòng cuối cũng khác), nên ghi lại cả file sẽ âm thầm xoá khoá trùng và sinh diff hàng nghìn dòng lẫn vào lô này; phải **chèn văn bản**, giữ CRLF. Chốt an toàn round-trip trong script đã chặn đúng lúc thay vì để tôi ghi hỏng.

### P15a — Packaged runtime ở trạng thái HOLD

1. `build_production.ps1`
2. `backend/app/core/artifact_runtime_self_test.py`
3. `backend/tests/test_artifact_runtime_self_test.py`
4. `scripts/verify_installed_artifact.ps1`
5. `scripts/run_release_qa.ps1`

Gate: staged wheel có `MixedNestingRun`; installed clean-user chạy tiny fixture bắt buộc trả/validate góc không-cardinal và X/Y phần lẻ; Free bị từ chối capability; cả VITE/PRYNX flag vẫn HOLD.

### P15b — Manifest và publish gate

1. `build_production.ps1`
2. `release_update.ps1`
3. `backend/tests/test_release_mixed_nesting_manifest.py`
4. `scripts/verify_artifact_clean_user.ps1`

Manifest phải có `MIXED_NESTING=hold|enabled`, protocol version, engine/source hash, runtime verified và Free-gate result. `release_update.ps1` từ chối upload nếu thiếu, hai flag lệch nhau hoặc attestation không đạt.

Gate: installer, manifest và runtime artifact cùng nguồn/commit/hash; trạng thái HOLD được chứng minh, không chỉ tự khai.

### P16 — Mở rollout có kiểm soát

1. `build_production.ps1`
2. `backend/tests/test_release_mixed_nesting_rollout.py`
3. `docs/BAO_CAO_NGHIEM_THU_MIXED_NESTING_RELEASE.md`

Chỉ thực hiện sau khi chủ dự án duyệt corpus/benchmark và P15 xanh. Đổi đồng thời hai flag frontend/backend trong cùng release, build từ clean commit, chạy lại toàn bộ release QA và xác minh manifest ghi `enabled`. Release report phải chứa bằng chứng corpus free-angle/continuous-X-Y và artifact parity thật.

Không dùng P16 để sửa thuật toán.

## 19. Quy trình verify sau mỗi lô

1. `git status --short` và `git diff --name-only` theo pathspec của phase.
2. Xác nhận không có file thuộc danh sách cấm sửa.
3. Chạy test hẹp của phase.
4. Chạy contract/parity liên quan.
5. Chạy test hồi quy của luồng gần nhất.
6. `git diff --check`.
7. Ghi kết quả, lỗi còn lại và benchmark delta vào báo cáo phase.
8. Không commit/push nếu chủ dự án chưa yêu cầu.

Trước release candidate:

```text
desktop: typecheck + vitest trên Windows thật
backend: pytest theo ma trận release
imposition_core/native: cargo test/check --locked
scripts/audit_contracts.ps1
scripts/run_release_qa.ps1
packaged clean-user runtime self-test
```

Không thêm `[profile.release]` vào Cargo.toml. Nếu thêm dependency Rust, cập nhật lockfile/NOTICE và chạy kiểm tra lock skew trong một phase riêng.

## 20. Tiêu chí GO/NO-GO

### GO khi

- Toàn bộ correctness invariants xanh.
- Không overlap, scale, shear, mirror, mất/nhân part hoặc vượt sheet trong corpus.
- `ANGLE_ONLY` chứng minh solver có thể trả góc không-cardinal; `CONTINUOUS_XY` chứng minh dịch chuyển X/Y không theo grid; per-part constraint được enforcement đúng.
- Smart solver không tệ hơn baseline theo score chuẩn và có ít nhất một corpus duyệt tốt hơn cardinal baseline.
- Fixed-work-plan deterministic giữa worker count; deadline mode luôn trả best-so-far hợp lệ và đúng `terminationReason`.
- Cancel/timeout không rò slot, thread, process, native handle hoặc temp.
- Preview và PDF export cùng pose manifest, đúng pivot/reference point, artifact parity arbitrary-angle/fractional-X-Y xanh.
- License/rollout fail-closed cả frontend lẫn backend.
- Máy `≥16 GB` không bị hard-cap ngoài policy CPU.
- Golden và hành vi tool cũ không đổi.
- Release artifact thật, không chỉ dev, đã chạy self-test non-cardinal.

### NO-GO khi

- Có bất kỳ layout invalid nào được publish.
- Free-angle bị triển khai thành allow-list 0/90/180/270, bước góc cố định hoặc brute-force 360 góc được mô tả như legal domain.
- X/Y bị snap vào pixel/lưới/bước mm, hoặc candidate/local search chỉ xoay mà không relocate/compact liên tục.
- Rotation constraint chỉ tồn tại ở UI nhưng solver/validator không enforcement, hoặc có đường bật reflection.
- UI đúng nhưng backend có thể bị gọi vượt entitlement/flag.
- Native thiếu mà âm thầm fallback vào solver cũ.
- Fixed-work-plan cùng seed thay đổi theo worker count; không dùng wall-clock deadline làm lý do đòi bit-identical giữa hai máy.
- Status/Cancel treo khi solver chiếm CPU.
- Product MVP export tính lại layout, đổi pivot, làm tròn/snap pose hoặc khác preview.
- Một thay đổi cần sửa solver N-Up/Sticker/Dieline hiện tại.
- Chỉ test dev xanh nhưng staged/installed artifact chưa được chứng minh.

## 21. Rollback

Rollback code/build không cần gỡ module, nhưng hai env flag không phải remote kill tức thời:

1. `VITE_MIXED_NESTING_ENABLED` là compile-time; tắt nó chỉ có hiệu lực sau khi build/update frontend mới được cài.
2. `PRYNX_MIXED_NESTING_ENABLED` chỉ có hiệu lực sau khi launcher/sidecar khởi động lại với cấu hình mới.
3. Sau khi backend flag OFF, chặn source/job mới nhưng vẫn giữ Status/Cancel/Delete cho job đã tồn tại đến khi cleanup xong.
4. Không đổi capability hay route của tool cũ.
5. Module Rust/PyO3 mới có thể nằm inert trong binary; không có nhánh gọi từ luồng cũ.
6. Nếu lỗi artifact, tắt riêng export ở build kế tiếp; chỉ giữ Technical MVP preview JSON nếu validator vẫn an toàn.
7. Muốn khóa từ xa trên máy đã cài phải có signed rollout claim + token refresh riêng cho tool mới; thiếu cơ chế đó thì không được mô tả là khóa tức thời.

Không rollback bằng `git reset --hard`, không xóa migration/dữ liệu người dùng và không sửa golden để che lỗi.

## 22. Prompt tổng để giao đội agent

Sao chép nguyên khối sau và chỉ thay phần `PHASE ĐƯỢC DUYỆT`:

```text
Bạn đang làm trong D:\pdfcompare.

Mục tiêu: xây AppTool mới “Bình lồng ghép tự do” theo tài liệu:
D:\pdfcompare\docs\KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md

PHASE ĐƯỢC DUYỆT: <ghi đúng một phase, ví dụ P1>

Quy tắc bắt buộc:
1. Đọc AGENTS.md và đọc đầy đủ các skill prynx-architecture, prynx-task-loop,
   prynx-dieline, prynx-imposition, prynx-performance, prynx-conventions và
   prynx-testing trước khi sửa.
2. Chỉ làm đúng phase được duyệt, tối đa 5 file. Nếu cần file thứ sáu, dừng và
   đề xuất tách phase; không tự mở rộng phạm vi.
3. Đây là tool standalone `mixed_nesting`. Không thêm nó vào
   IMPOSITION_FAMILY_TOOL_IDS/ImpositionTab và không gọi solver cũ.
4. Không sửa bất kỳ file nào trong mục “Các module hiện tại bị cấm sửa”.
5. Giữ nguyên dirty worktree của chủ dự án; không restore/reset/format file ngoài
   phạm vi. Luôn kiểm tra diff theo pathspec trước và sau.
6. Đơn vị hình học là mm/degree. Placement là rigid pose `p_sheet = R(theta) * (p_source_local - referencePoint) + (tx, ty)`:
   mặc định free-angle `[0°,360°)`, X/Y liên tục và không mirror/scale/shear. Preset góc hữu hạn
   chỉ là per-job/per-part constraint; không biến free-angle thành bước góc hoặc grid X/Y.
   Preview và export phải dùng cùng placement manifest.
7. Mọi result phải qua validator độc lập; không publish best-so-far chưa validate.
   Validator tự dựng transform từ theta/translation và không reuse NFP/candidate decision.
8. Công việc nặng phải qua scheduler, cancel cooperative và gọi `plan_worker_count`.
   Chỉ máy <8 GB/<16 GB mới được giảm; >=16 GB giữ cpu-1/full, không chép cap cứng
   vào solver hoặc route.
9. `fast/balanced/tight` chỉ đổi work effort, không thu hẹp rotation domain. Fixed work-plan
   phải deterministic theo seed giữa worker count; wall-clock deadline chỉ cam kết best-so-far hợp lệ.
10. Không thêm [profile.release] vào Cargo.toml, không update golden để làm xanh.
11. Comment/text UI mới bằng tiếng Việt và dùng thuật ngữ ngành in của PrynX.
12. Không commit hoặc push nếu chưa được yêu cầu.

Quy trình:
- Baseline: xác minh file/contract/test hiện tại của phase.
- Nêu giả thuyết và thiết kế thay đổi nhỏ nhất.
- Triển khai chỉ trong danh sách file của phase.
- Chạy test hẹp, contract test, test hồi quy gần nhất và git diff --check.
- Với phase hình học/solver/preview/export, chạy fixture non-cardinal và fractional-X-Y; chứng minh không có snap 0/90/180/270, angle step, translation grid hoặc reflection ẩn.
- Rà lại để chứng minh không có import/call path sang solver N-Up, Sticker hoặc
  Dieline hiện tại.
- Báo cáo: file đã đổi, bằng chứng test, benchmark nếu có, rủi ro còn lại và gate
  của phase đã đạt/chưa đạt. Không chuyển sang phase tiếp theo nếu gate chưa xanh.

Nếu phát hiện kế hoạch sai với code thực tế, không sửa liều. Ghi bằng chứng file:dòng,
đề xuất amendment cho tài liệu và chờ duyệt.
```

## 23. Các quyết định cần chủ dự án duyệt trước P1

1. Tên hiển thị: `Bình lồng ghép tự do`.
2. Capability: `impo.mixed_nesting` thuộc Pro.
3. Product MVP chỉ nhận PDF; SVG/DXF để phase sau.
4. Rotation mặc định tự do trong miền liên tục `[0°,360°)`; X/Y được dịch chuyển liên tục và tối ưu đồng thời với góc.
5. Rotation constraint cho từng part hỗ trợ `inherit/free/fixed/discrete/ranges`; các preset 0/180 hoặc 0/90/180/270 chỉ là lựa chọn thu hẹp, không phải mặc định engine.
6. Cấm mirror/scale/shear trong nesting mặt trước; duplex/back transform là dự án riêng.
7. `fast/balanced/tight` chỉ đổi search effort và đều giữ toàn legal rotation domain; không cam kết global optimum.
8. Hole coi là solid trong MVP.
9. Technical MVP chốt engine bằng geometry JSON trước, sau đó mới nối PDF/export.
10. Release flag mặc định HOLD cho tới khi packaged runtime, corpus non-cardinal/continuous-X-Y và artifact parity đạt gate.

---

Tài liệu này chỉ là kế hoạch. Việc tạo file này không thay đổi code, registry, license, solver, build hoặc hành vi runtime nào của PrynX.
