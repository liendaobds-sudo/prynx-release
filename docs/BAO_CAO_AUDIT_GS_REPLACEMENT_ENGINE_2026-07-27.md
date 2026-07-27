# BÁO CÁO AUDIT KẾ HOẠCH VÀ HIỆN TRẠNG PPE / THAY THẾ GHOSTSCRIPT

**Ngày audit:** 2026-07-27  
**Repo / HEAD:** `1839cd5c4420eb211e6d612706522bc35e5bacd2`  
**Tài liệu đối chiếu:** `docs/PRYNX_GS_REPLACEMENT_ENGINE_PLAN.md`  
**Phạm vi:** PPE Rust, binding PyO3, facade/routing backend, action/PDF-X/no-GS path, golden/CI, telemetry gate và pipeline đóng gói.  
**Không thuộc phạm vi sửa:** audit này chỉ khảo sát và lập báo cáo; chưa thay đổi engine hay hành vi sản phẩm.

---

## 1. Kết luận điều hành

PPE **không phải scaffold hoặc kế hoạch trên giấy**. Crate Rust, binding PyO3, facade Python, routing PPE-first, golden fixture và các đường write bằng pikepdf đều tồn tại trên đường chạy thật. Các kết quả lõi quan trọng tái hiện được trên máy Windows hiện tại:

- Rust `print_engine`: **545 pass, 0 fail**.
- Backend chạy đúng từ thư mục `backend/`: **1372 pass, 0 skip, 0 fail**.
- Golden một-biến ở **72 DPI**: **50 PASS + 1 khác GS có chủ ý, 0 FAIL**.
- Golden một-biến ở **100 DPI**: **50 PASS + 1 khác GS có chủ ý, 0 FAIL**.
- Golden preflight 100 DPI: **17 PASS + 1 fixture JPEG stub chưa đủ tính năng, 0 FAIL**.
- Desktop typecheck: **PASS**.

Tuy nhiên, kết luận phát hành là:

> **NO-GO cho việc gỡ Ghostscript khỏi installer ở HEAD/worktree hiện tại.**  
> **GO để tiếp tục chạy PPE-first với Ghostscript fallback.**

Lý do chặn chính:

1. Có lỗi correctness P0 trên nút **Overprint Preview**: cờ Ghostscript đã chết làm hai ảnh so sánh giống hệt nhau và trả false-negative.
2. Thiết bị telemetry hiện **không thể tính** tiêu chí “≥95% job trong 30 ngày không cần GS”: nó chỉ ghi các lần có gọi GS, không có mẫu số tổng job/operation và không lọc cửa sổ 30 ngày.
3. Test “no Ghostscript” cho separations có thể xanh dù thực tế chạy `pdfium_approx`, và CI Windows chưa chạy toàn bộ survival/action/PDF-X suite với binding vừa build.
4. PPE hard-cap mặc định **512 MiB trên mọi máy**, trái bất biến phần cứng của dự án; đường flatten tự hạ 300→200→150→100 DPI vì cap này, kể cả máy mạnh.
5. Bản phát hành mặc định vẫn bundle GS; `PRYNX_ALLOW_GS_FALLBACK` vẫn bật; chưa có validator PDF/X độc lập và chưa có dữ liệu khách 30 ngày.
6. Release QA của worktree hiện tại chưa xanh: desktop có **6 test fail** (ngoài phạm vi PPE, chủ yếu dieline/API đang sửa dở).

---

## 2. Kiến trúc / đường chạy đã trace

### 2.1 Separations / TAC

`OutputPreviewTab` → `GET /api/preflight/separations/...` → `SeparationEngine.extract_separations()` → `print_engine.facade.separations()` → `pdfcompare_native.ppe_separations()` → `print_engine::page::render_page_managed()`.

Bằng chứng:

- Router preflight được mount thật tại `backend/app/main.py:218-221`.
- PPE được thử trước GS tại `backend/app/core/separations.py:250-273`.
- Facade truyền profile, font fallback và memory budget vào native tại `backend/app/core/print_engine/facade.py:280-305`.
- Binding export ba hàm PPE tại `native/src/lib.rs:29-31`; binding gọi crate tại `native/src/print_engine_py.rs:124-137`.
- TAC chỉ tin engine `ppe|ghostscript` tại `backend/app/core/preflight_rules/ink.py:28-34,187-210`.

### 2.2 Overprint Preview

`OutputPreviewTab.toggle()` → `POST /api/preflight/overprint-preview` → hai lần `run_hidden(gs...)` → so ảnh → UI chỉ dựng overlay khi `has_differences=true`.

Bằng chứng đường live:

- Consumer frontend tại `desktop/src/components/OutputPreviewTab.tsx:688-715`.
- Endpoint tại `backend/app/api/routes/preflight.py:1512-1646`.
- Overlay được dựng tại `desktop/src/components/workspace/LivePageFrame.tsx:2702-2709`.

### 2.3 Build / installer

`build_production.ps1` mặc định đặt `$BUNDLE_GS = $true`; chỉ tắt khi có `-NoGhostscript` hoặc `PRYNX_BUNDLE_GS=0` (`build_production.ps1:579-615`). Tauri vẫn bundle glob `binaries/gs/**/*` (`desktop/src-tauri/tauri.conf.json:100`). Thư mục `desktop/src-tauri/binaries/gs/` hiện có `bin/`, `lib/`, `Resource/`, `iccprofiles/`.

---

## 3. Đối chiếu sáu gate gỡ GS (§8)

| # | Gate | Kết quả audit | Bằng chứng / khoảng trống |
|---|---|---|---|
| 1 | ≥95% job prepress 30 ngày không cần GS | **FAIL — thiết bị đo chưa đủ** | `gs_usage.py` chỉ ghi event khi GS được gọi; không ghi tổng job/operation không-GS, không có job-id/operation-id và không lọc 30 ngày. Không thể suy ra phần trăm. |
| 2 | Sep + soft-proof + TAC PPE default, badge đúng | **PASS về code/lab** | PPE-first, cổng tin cậy và golden đều đạt. Chưa xác nhận trên installer no-GS đã cài. |
| 3 | ≥1 chuẩn PDF/X qua compliance độc lập | **FAIL** | Chỉ có validator nội bộ; chính kế hoạch thừa nhận còn thiếu Acrobat Preflight/validator độc lập tại §18.2. |
| 4 | Convert CMYK, Downscale, Embed non-GS | **PASS** | Test action/no-GS xanh; implementation object-level tồn tại. |
| 5 | Flatten/Outline có quyết định sản phẩm rõ | **CHƯA ĐẠT** | Flatten raster có warning; Outline chỉ 22/33 corpus. Kế hoạch vẫn ghi “chưa quyết” tại §18.1. |
| 6 | Build không copy GS + release QA xanh | **FAIL** | Build mặc định vẫn copy GS; worktree hiện có 6 test desktop fail. |

**Tổng:** đạt chắc **2/6**, chưa đạt **4/6**. Đây phù hợp với quyết định giữ GS fallback, không phù hợp với việc đổi release mặc định sang no-GS.

---

## 4. Phát hiện

### §4.1 — [VERIFIED] P0: Overprint Preview luôn có nguy cơ false-negative với GS 10.x — effort S

**Sink/đường chạy:** UI `OutputPreviewTab.tsx:700-713` → route `preflight.py:1512-1569` → `run_hidden()` → `has_differences` → overlay.

**Bằng chứng code:** route vẫn truyền `-dSimulateOverprint=false|true` tại `backend/app/api/routes/preflight.py:1546-1569`. Chính tài liệu PPE đã xác nhận cờ này bị GS 10.x loại bỏ ở §16.3d, nhưng fix chỉ được áp vào separations/golden, không áp vào endpoint live này.

**Bằng chứng thực thi trên `10_overprint.pdf`, GS 10.04.0:** 

- GS in cảnh báo: `-dSimulateOverprint={true|false} is no longer supported`.
- Hai output dùng cờ cũ có cùng SHA-256: `674FBB11765BC12D5C8B7CF6762277B12870D222DEA008242015F63FB49CEBDE`.
- Dùng API mới `-sOverprint=disable|simulate` trên cùng fixture tạo **43.785 pixel khác nhau >10**, `max_diff=35`.

**Ảnh hưởng:** UI có thể báo không có vùng thay đổi dù file thật có overprint. Đây là sai kết quả trên tính năng live, không phải nợ tài liệu.

**Đề xuất:** đổi sang API mới, kiểm `returncode` + stderr, thêm regression route trên `10_overprint.pdf`; cờ bị loại bỏ phải fail-loud.

### §4.2 — [VERIFIED] P1: telemetry không đo được gate “95% job / 30 ngày” — effort M

**Sink/consumer:** `run_hidden()` → `gs_usage.record_gs_call()` → `GET /api/system/gs-usage` → quyết định unbundle trong §8.1.

**Bằng chứng:** 

- `record_gs_call()` chỉ tăng `_total_calls` và ghi `{ts, reason}` khi **có** lệnh GS (`backend/app/core/gs_usage.py:67-88`).
- `summary()`/`read_log_summary()` chỉ trả `total_gs_calls`, `by_reason`, first/last timestamp (`gs_usage.py:92-129`).
- Không có tổng số job/operation đã chạy, nên các job không gọi GS hoàn toàn vô hình.
- `read_log_summary()` đọc từ đầu file tới `limit_lines`, không lọc `now-30d`.
- Endpoint chỉ trả đúng hai summary này (`backend/app/api/routes/system.py:92-106`).

**Ảnh hưởng:** từ dữ liệu hiện có chỉ biết “GS được gọi bao nhiêu lần và ở đâu”, không thể biết “bao nhiêu phần trăm job không gọi GS”. Claim §18.1 “thiết bị đo đã có, chỉ còn chờ 30 ngày” là quá mức.

**Đề xuất:** ghi một event kết thúc cho **mọi operation prepress** với `operation_type`, `used_gs: bool`, `ts` và ID ẩn danh cục bộ; endpoint hỗ trợ `days=30`, trả numerator/denominator và tách số operation khỏi số subprocess call.

### §4.3 — [VERIFIED] P1: test no-GS có thể xanh bằng engine xấp xỉ; CI chưa khóa survival suite với native mới — effort S–M

**Bằng chứng test:** `test_separations_ink_accurate_without_gs` chỉ assert `result.get("plates")` và số GS call bằng 0 (`backend/tests/test_no_ghostscript_survival.py:86-96`); nó không assert `engine == "ppe"` hoặc `accuracy` thuộc nhóm RIP.

**Xác minh chéo:** ép facade ném `PpeUnavailable`, đặt GS path không tồn tại rồi chạy đúng input TAC; kết quả là:

```text
engine=pdfium_approx, accuracy=approximate, plate_count=4
current_test_assertion_would_pass=True
```

Điều này đúng với fallback tại `backend/app/core/separations.py:301-345`.

**CI:** job Windows `ppe-native` build wheel thật nhưng chỉ chạy `test_ppe_native.py` và `test_ppe_facade.py` (`.github/workflows/ci.yml:138-178`). Survival/action/PDF-X/outline/routing suite chạy ở backend job Linux, nơi native có thể vắng và một số test PPE dùng `importorskip`.

**Khoảng phủ bị bỏ:** `test_no_ghostscript_survival.py` không gọi endpoint live `/preflight/overprint-preview`; khi không có GS endpoint này trả `success=False` (`preflight.py:1640-1646`). Vì vậy câu §19.1 “không còn đường nào gãy hẳn” không đúng nếu hiểu là toàn bộ chức năng UI.

**Đề xuất:** assert engine/accuracy cho separations và soft-proof; chạy toàn bộ survival/routing/action/PDF-X/outline tests trong job Windows sau khi cài wheel; thêm endpoint overprint vào inventory no-GS với hành vi sản phẩm được quyết định rõ.

### §4.4 — [VERIFIED] P1: hard-cap PPE 512 MiB trái bất biến “máy mạnh chạy hết công suất” — effort M

**Bằng chứng:** 

- Default cố định `PRYNX_PPE_MEMORY_BUDGET_MB = 512` tại `backend/app/config.py:78-82`.
- Facade luôn lấy giá trị này, không đọc RAM máy (`backend/app/core/print_engine/facade.py:126-133`) và luôn truyền vào native (`:292-303`).
- Native cũng default 512 (`native/src/print_engine_py.rs:45-66`) và thực thi budget thật.
- Flatten khi render không qua sẽ tự hạ DPI theo thang 300→200→150→100 (`backend/app/core/pdf_actions_native.py:1874-1902`).

**Ảnh hưởng:** máy ≥16 GB vẫn bị cùng ceiling như máy yếu; trang lớn có thể rơi GS hoặc bị raster thấp DPI dù còn rất nhiều RAM. Đây xung đột trực tiếp quy tắc bất di bất dịch của PrynX.

**Đề xuất:** dùng hardware profile chung: máy <8 GB giảm mạnh, 8–16 GB giảm nhẹ, ≥16 GB không hard-cap nhân tạo (hoặc budget theo phần RAM khả dụng với ceiling rất cao); env override vẫn thắng. Bổ sung test ba mức RAM và test flatten giữ 300 DPI trên máy mạnh giả lập.

### §4.5 — [VERIFIED] P1: release/unbundle gate hiện vẫn đỏ — effort phụ thuộc nhiều hạng mục

**Bằng chứng build:** 

- `$BUNDLE_GS = $true` mặc định (`build_production.ps1:579-581`).
- Nhánh no-GS tự ghi “chỉ dùng để kiểm thử, không phát hành cho khách” (`:607-615`).
- Nhánh mặc định copy GS và cảnh báo AGPL (`:615-634`).
- Bundle directory hiện có payload GS; NOTICE hiện liệt kê Ghostscript 10.04.0/AGPL.

**Bằng chứng QA hiện tại:** 

- TypeScript typecheck: PASS.
- Vitest: **120 file pass, 5 file fail; 1074 test pass, 6 fail, 2 skip**.
- Fail gồm 3 regression dieline/3D (`goldenMaster`, `regression`, `foldPrintOutward`) và 3 test API (`mergeManifest`, `upload`). Đây là thay đổi đang dở trong worktree, **không quy lỗi cho PPE**, nhưng vẫn làm `run_release_qa` đỏ.
- `scripts/gen_third_party_notices.py --check` hiện báo NOTICE lệch dependency. Build script có bước tự sinh lại nên đây là WARN của cây làm việc, không phải blocker vĩnh viễn.

**Kết luận:** không được dùng trạng thái test lõi PPE xanh để suy ra release QA xanh.

### §4.6 — [VERIFIED] P2: tài liệu là changelog chồng lớp, không còn là current-state plan đáng tin — effort S

**Bằng chứng:** 

- Header vẫn ghi **v2.9 / 2026-07-26** (`PLAN:4-5`) nhưng lịch sử mới nhất là **v4.2 / 2026-07-27** (`PLAN:1835-1841`).
- Tóm tắt điều hành vẫn dùng 25/31 @72 của v2.9 (`PLAN:23`), trong khi phần Phase 1 dùng 28/31 và fixture 51 file (`PLAN:288-303`).
- Bảng kiểm thử §16.4 còn ghi golden 43/44 và backend 1301 (`PLAN:1013-1035`); actual là 51 fixture và backend 1372.
- Gate Phase 2 ở phần đầu còn “4/6; flatten/outline dùng GS” (`PLAN:327-337`), trong khi §19 nói cả hai có đường non-GS một phần.
- Section `15. Lịch sử` nằm sau section 19; các đoạn cũ và mới mâu thuẫn nhưng không được đánh dấu superseded.

**Ảnh hưởng:** người đọc có thể lấy nhầm số/gate cũ, đặc biệt khi quyết định release.

**Đề xuất:** tách thành ba file/khối: `CURRENT_STATE` (một bảng SSOT), `ROADMAP`, `CHANGELOG`; header lấy version mới nhất; mọi số test/golden tự sinh từ artifact thay vì gõ tay.

### §4.7 — [VERIFIED] P2: bằng chứng golden/corpus lưu trong repo chưa đủ tái lập toàn bộ claim — effort S–M

**Bằng chứng:** 

- `print_engine/golden/fixtures/` hiện có 51 PDF và chạy lại đạt 51/51 ở 72/100 DPI.
- `baseline_gs_2026-07-25.json` chỉ có **44 record**; `baseline_fixtures_cm.json` chỉ có **20 record**.
- Không có corpus 33 PDF/129 trang hoặc manifest hash trong repo; tìm kiếm tên các file corpus chỉ thấy ghi chú/tài liệu.
- Không có artifact JSON hiện hành cho matrix 51 fixture × 72/100 DPI và corpus 33 PDF.

**Ảnh hưởng:** claim fixture công khai tái hiện được bằng lệnh, nhưng claim corpus 33 PDF/129 trang, performance p95 và 31/33 PDF/X không thể tái lập chỉ từ checkout hiện tại.

**Đề xuất:** nếu không thể commit PDF khách, commit manifest đã ẩn danh gồm SHA-256, số trang, nhóm capability, kết quả theo DPI/engine/version và script sinh report; cập nhật baseline JSON cho 51 fixture.

---

## 5. Điểm đã xác minh là tốt

1. **Crate tách riêng hợp lý:** `print_engine` là rlib thuần Rust; PyO3 chỉ nằm ở `native/`; không có `[profile.release]` trong Cargo.toml.
2. **Fail-loud ở cổng tin cậy:** `ink_unsound` và `geometry_approximate` được tách; TAC chỉ tin PPE/GS.
3. **Golden một-biến có giá trị:** 51 fixture hiện hành tái hiện đúng tại 72/100 DPI; fixture preflight cũng tái hiện đúng 17/18 + 1 stub.
4. **Test lõi dày và xanh:** Rust 545; backend 1372.
5. **Action/PDF-X native không chỉ là mock:** các module `pdf_actions_native.py`, `outline_text.py`, `pdfx_export.py` và test no-GS tồn tại, chạy thật.
6. **Build có nhánh no-GS và xử lý payload cũ:** nhánh `-NoGhostscript` xóa payload GS cũ trước khi bundle và sinh NOTICE phù hợp; vấn đề là gate/default chưa đổi, không phải thiếu cơ chế.

---

## 6. Thứ tự sửa đề xuất theo lô

Theo quy trình audit, **dừng ở đây chờ duyệt**; chưa tự sửa.

### Lô A — correctness + test gate (≤5 file)

1. Sửa Overprint Preview sang API GS mới, kiểm stderr/returncode.
2. Thêm regression endpoint trên `10_overprint.pdf`.
3. Siết assert engine/accuracy trong no-GS survival.
4. Mở rộng job CI Windows chạy survival/routing/action/PDF-X/outline sau wheel build.

### Lô B — telemetry gate thật (3–4 file)

1. Thêm operation-level event cho mọi prepress job, gồm cả `used_gs=false`.
2. Tổng hợp rolling 30 ngày, trả numerator/denominator/tỉ lệ theo operation type.
3. Test đa subprocess trong một job không làm sai mẫu số.

### Lô C — memory budget theo phần cứng (3–5 file)

1. Dùng hardware profile RAM chuẩn của dự án để chọn budget.
2. ≥16 GB không bị hard-cap 512 MiB.
3. Giữ env override và test ba tier RAM + flatten DPI.

### Lô D — SSOT tài liệu / evidence / release (≤5 file mỗi nhịp)

1. Tách current state khỏi changelog, cập nhật version 4.2.
2. Sinh baseline 51 fixture × 72/100 DPI.
3. Thêm manifest hash cho private corpus và result artifact.
4. Cập nhật text no-GS trong build script theo capability thật.
5. Sau khi frontend suite xanh, chạy `run_release_qa.ps1` và một build `-NoGhostscript` đã cài thật.

---

## 7. Lệnh verify đã chạy

```text
cargo test --quiet --manifest-path print_engine/Cargo.toml
→ 545 passed

cd backend
venv\Scripts\python.exe -m pytest -q
→ 1372 passed

scripts/ppe_golden_compare.py print_engine/golden/fixtures --dpi 72 --color-managed
→ 50 PASS + 1 khác GS có chủ ý

scripts/ppe_golden_compare.py print_engine/golden/fixtures --dpi 100 --color-managed
→ 50 PASS + 1 khác GS có chủ ý

scripts/ppe_golden_compare.py backend/tests/preflight_fixtures/pdfs --dpi 100 --color-managed
→ 17 PASS + 1 chưa đủ tính năng

cd desktop && npm run typecheck
→ PASS

cd desktop && npm run test -- --run
→ 120 file pass, 5 fail; 1074 test pass, 6 fail, 2 skip

scripts/gen_third_party_notices.py --check
→ FAIL: NOTICE lệch dependency hiện tại (build sẽ regenerate)
```

Không chạy full production build/installer và không chạy corpus khách 33 PDF vì artifact corpus không nằm trong repo. Không tuyên bố hai phần đó đã đạt.

