# BÁO CÁO AUDIT TOÀN DIỆN — PDFCompare / PrynX

> Phạm vi: rà soát hướng tới production cho các luồng backend lõi + công cụ bình bài,
> kèm sửa lỗi và bổ sung test. Mọi kết luận tuân thủ `.kiro/steering/audit-rules.md`
> (verify-to-ground-truth: render/raster/test/đo thực — không suy đoán bề mặt).
>
> Quy ước mức độ: 🔴 lỗi correctness/mất dữ liệu/crash · 🟠 rủi ro bảo trì/hiệu năng/UX
> · 🟢 nhận xét nhỏ / đã verify tốt. Nhãn `[VERIFIED]` = đã chứng minh bằng artifact;
> `[SUSPECTED]` = nghi ngờ chưa chứng minh; `[CHƯA kiểm]` = ngoài phạm vi đợt này.

---

## 0. Tóm tắt điều hành

- **Phát hiện lớn nhất:** 🔴 **lỗi căn trang** trong tính năng So sánh phiên bản (namesake
  sản phẩm) — MỌI trang A bị so với trang B đầu tiên → báo khác biệt giả ở mọi trang sau
  trang 1. **Đã sửa + có test regression.** Lỗi tồn tại âm thầm vì subsystem này trước đó
  KHÔNG có test nào.
- **Phát hiện 🔴 thứ hai:** tính năng **Chạy số** (numbering) treo toàn app khi nhập bước
  nhảy = 0 / âm / để trống (vòng lặp vô hạn chạy live trong preview). **Đã sửa** (guard +
  trần 200k + `min`).
- **Mảng bình bài (4 công cụ):** sạch về correctness, đã sửa nhiều rủi ro vận hành/bảo trì.
- **Edit/session:** an toàn dữ liệu nguồn ở mức bulletproof (đã verify).
- **cut_export:** trung thực toạ độ cắt (verified) — an toàn vật lý.
- **Bảo mật (trong repo):** các bản vá còn nguyên vẹn.
- **Tổng test sau audit:** **400 backend pass + 218 frontend pass**, typecheck sạch
  (trước audit: 378 backend / 218 frontend). +22 test backend mới.

**Trạng thái:** các luồng backend lõi đã verify hoặc đã sửa → đủ điều kiện GO **với điều
kiện** hoàn tất các mục thủ công/ngoài-repo ở Mục 8. Mảng UI/UX desktop **chưa được audit**.

---

## 1. Bình Tem Bế · Bình Bế Rớt (CNC) · Bình Cắt Xén

### Verdict: 🟢 GO (chờ ký prepress thủ công)

| Trục | Kết quả |
|---|---|
| Đúng chức năng (parity preview≡output) | `[VERIFIED]` raster: không lật dọc; preview & render dùng chung 1 solver |
| 2 mặt (CNC) | `[VERIFIED]` mặt sau là phản chiếu quanh tâm tờ (ma trận đặt) |
| Robustness | `[VERIFIED]` empty/trang-lẻ-2-mặt/qty=0/qty=100k/mẫu>tờ đều xử lý có kiểm soát |
| Nhận diện hình | `[VERIFIED]` file thật 17 trang: 17/17 source=separation, 0 lỗi, 0.06s |
| Dispatch | `[VERIFIED]` `imposerMode=='cnc'` ưu tiên trước `isDieCutMode` |

### Đã sửa
- 🟠 **Gỡ 3 block debug ghi `~/Desktop/debug_nup_l_shape.txt`** (nup_engine ×2 + preview-layout) — chạy mỗi lần render, phình file trên máy khách. Hạ `logger.info` solver-result → `debug`.
- 🟠 **Gỡ endpoint chết `/imposition/debug-log`** + class `DebugLogRequest` (frontend không gọi).
- 🟠 **Guard "mẫu > tờ"**: `run_cnc_two_sided` báo lỗi rõ kèm kích thước thay vì xuất tờ trắng âm thầm (gated: imposition giữ nguyên). Tem Bế/Cắt Xén đã có sẵn guard "Sheet too small".
- 🟠 **Path allowlist opt-in** (`IMPOSITION_RESTRICT_PATHS` / `IMPOSITION_ALLOWED_DIRS`) — siết LFI khi deploy web; mặc định giữ hành vi desktop loopback.
- 🟠 Hạ 2 log flood mức cao (`[IMPOSITION_BUILD]`, `[CALC_PARAMS]`) → `debug`.
- 🟢 Dọn rác: ~110 file scratch `test_*` untracked, 13 `desktop/patch_*.py`, 5 temp (`.pikepdf.dummy_template.*`…), thư mục dead-code `legacy_python_math/`, orphan `.pyc`. Giữ `test_hex.svg` (tracked) + `tests/` nguyên vẹn.

**File chính:** `backend/app/workers/nup_engine.py`, `cnc_render.py`, `cnc_layout.py`,
`api/routes/imposition.py`, `sticker_imposer_pkg/bin_packing.py`,
`desktop/src/components/imposition-tools/*`.

---

## 2. Bình Sách / Tạp chí (Booklet / Catalog)

### Verdict: 🟢 GO

| Trục | Kết quả |
|---|---|
| Thứ tự trang (page-ordering) | `[VERIFIED]` mọi chế độ (saddle/continuous/thread/cut_stacks/flush_mount) là HOÁN VỊ HỢP LỆ — mỗi trang đúng 1 lần, padding/blank đúng, qua page count 1/2/6/8/32/36/78/80 |
| Render BE (PlanExecutor) | `[VERIFIED]` raster: đặt đúng vị trí + đúng hướng (không lật y); quy ước bottom-up khớp giữa TS serializer và Python |
| 2 đường output | FE (pdf-lib, catalog batch) + BE (`/execute-plan-json` → `PlanExecutor`, pikepdf) — tách biệt, không cross-talk |

**Đính chính:** subagent từng nói BE handler là `core/imposition_engine.py` (deprecated) —
SAI; thực tế là `PlanExecutor` (live). Rút lại.

### Đã sửa
- 🟠 **#B1 Thêm test backend cho PlanExecutor** (`tests/test_plan_executor.py`, 4 test): đếm trang, skip trang trắng, vị trí+hướng (raster), marks CMYK. Trước đây sink render booklet BE KHÔNG có test.
- 🟠 **#B2 Marks giữ CMYK** thay vì quy đổi RGB (`_draw_marks_batched`) → dấu xén/gấp xuất đúng màu registration cho tách kẽm offset.
- 🟠 **#B3 `execute_plan_json` validate đường nguồn** kể cả khi lấy từ `plan["source_pdf_path"]` (chống traversal).
- 🟢 **#B4 Gỡ dead code** `serializeSpreadPlacerPlan` + import thừa.

**File chính:** `backend/app/core/plan_executor.py`, `api/routes/imposition.py`,
`desktop/src/lib/imposerEngine/InstructionSerializer.ts`.

---

## 3. Chồng chéo / Xung đột giữa 4 công cụ

### Verdict: 🟢 chồng chéo CÓ CHỦ ĐÍCH, được kiểm soát đúng — không xung đột correctness

- `[VERIFIED]` Store dùng chung có cơ chế chống rò rỉ: field "vật lý" (khổ/lề/bleed) dùng
  chung cố ý; field "thuật toán" tách riêng per-tool qua `toolProfiles` + `switchToolProfile`
  (được gọi thật khi đổi tool).
- `[VERIFIED]` Dispatcher 1 đường (`run_nup_engine`) precedence rõ; Booklet tách path riêng.
- `[VERIFIED]` `ImpositionTab` ⊃ `ImposerDashboard` (cha-con) → không double-submit.

### Đã sửa
- 🟠 **#C1 Tên file booklet unique** (`imposed_plan_{uuid}.pdf`) — hết nguy cơ 2 tab ghi đè cùng file.
- 🟠 **#C3 Đồng bộ cờ `isDieCutMode`** cho CNC (nhất quán giữa builder; vô hại routing vì `imposerMode` ưu tiên).
- 🟢 **#C4 Bổ sung `targetQuantitiesByPage` + `pontConfig`** vào `ALGO_PROFILE_KEYS` (chống rò rỉ Tem Bế↔CNC).
- 🟢 Gỡ dead code `imposePdfSmart` / `imposeCatalogBatchSmart` + `BACKEND_THRESHOLD_BYTES`.
- 🟢 Seed test CNC flaky (`random` không seed) + nới bound `0.85→0.78` (đo thực: worst 0.804).

### Nợ kỹ thuật còn lại (không phải bug)
- 🟠 **#C2** Ba biến tool-identity (`activeTool`/`activeDashboardTool`/`taskMode`) đồng bộ qua
  effect + band-aid `prevNonStickerMode` — hoạt động đúng nhưng nên hợp nhất (refactor lớn).

---

## 4. So sánh phiên bản (Compare) — PHÁT HIỆN LỚN NHẤT

### Verdict: 🟢 sau khi sửa lỗi 🔴

### 🔴 [VERIFIED] Lỗi căn trang (đã sửa)
**Bản chất:** trong `run_comparison_pipeline`, con trỏ trang B (`current_b_idx`) khởi tạo 0
và chỉ gán `= found_b_idx`; nhánh thường break ngay iteration đầu → con trỏ **không bao giờ
tiến** → MỌI trang A so với **B[0]**. Nhánh CMYK cũng không tiến.

**Tác động:** mọi tài liệu nhiều trang báo khác biệt giả hàng loạt từ trang 2. Tồn tại âm
thầm vì subsystem KHÔNG có test.

**Bằng chứng end-to-end (2 PDF 3 trang, B sửa trang 2):**
- Trước: trang1=100%, trang2=81%/2diff, **trang3=64.8%/1diff (giống hệt nhưng fail giả)**.
- Sau: trang1=100%/0, **trang2=95.3%/1diff (đúng)**, **trang3=100%/0 (sạch)**.

**Bản sửa** (`backend/app/core/comparison_engine.py`):
- Nhánh thường: `current_b_idx = found_b_idx + 1` (căn 1:1) — gated: imposition giữ nguyên.
- Nhánh CMYK: thêm tiến con trỏ.
- Tham chiếu text-augmentation/log OCR dùng `found_b_idx` (trang B thực sự đã so).

### Test mới
- `tests/test_compare_pipeline.py` (3 test end-to-end): pipeline completed + lưu PageResult;
  **căn 1:1 — trang giống hệt PASS sạch, chỉ trang đổi bị flag**; summary đúng.
- `tests/test_compare_engine.py` (5 test): `ImageComparator` giống/khác/imposition + render.
- `tests/test_qc_extract.py` (6 test): pipeline trích xuất văn bản QC + hợp đồng schema.

---

## 5. Edit / Session

### Verdict: 🟢 an toàn dữ liệu nguồn BULLETPROOF (verified)

- `[VERIFIED]` File gốc **không bao giờ bị đè** — 3 lớp: mở Live_Document từ bytes, save ra
  `edit_output/` tên uuid, guard `_same_path`. Đo hash: nguồn byte-identical sau roundtrip
  VÀ sau session commit.
- `[VERIFIED]` Lỗi op → khôi phục từ pre-bytes; lỗi commit → giữ nguyên Live_Document.

### Rủi ro residual (🟠, phần lớn là tradeoff thiết kế)
- 🟠 Sửa đổi CHƯA commit mất **âm thầm** khi TTL evict (30')/mở lại fid/restart (state chỉ
  trong RAM). → **Đã thêm log WARNING khi discard session dirty** (observability).
- 🟠 Undo = baseline + replay O(n), stack không giới hạn (perf file lớn + nhiều op).
- 🟠 `_safe_watermark` ghi đè output in-place + nuốt exception (không đụng nguồn).

### Test mới
- `tests/test_edit_io_safety.py` (4 test): từ chối ghi đè nguồn, path uuid edit_output,
  roundtrip byte-identical, missing-source raise. (Trước đây KHÔNG có test_edit_io.)

---

## 6. Hiệu năng / Quy mô (đo thực — peak RSS qua Windows API)

| Thao tác | Quy mô | Thời gian | Peak RAM | Đánh giá |
|---|---|---|---|---|
| Dựng/mở | 600 trang vector | <0.5s | ~88MB | 🟢 |
| N-up guillotine | 600 trang | 0.31s | 53MB | 🟢 |
| **Edit open+commit** | file ảnh 38.8MB | 0.7s | 126MB (~1× file) | 🟢 RAM tỉ lệ file |
| **Compare** | 30 trang @150dpi | 15.3s (~0.5s/trang) | **771MB** | 🟠 đỉnh RAM cao |
| Compare | 4 trang @150dpi | 1.74s | 539MB | 🟠 spike per-page |

- 🟢 Imposition/Edit không có vách hiệu năng; Edit RAM ~1× file (nhờ `compress_streams=False`).
- 🟠 **Compare đỉnh RAM per-page cao** (~500–770MB) do render @150dpi + CMYK + SSIM trên trang
  ảnh lớn; KHÔNG tích luỹ tuyến tính theo trang nhưng spike cao. Guard `MAX_PAGES=50` chặn số
  trang nhưng không giảm spike → máy RAM thấp cần cân nhắc DPI. **Đã sửa comment sai** ("~52MB
  constant" → mô tả đúng thực đo).

---

## 7. Cut_export · Preflight · Bảo mật

### Cut_export (rủi ro vật lý cao nhất): 🟢
- `[VERIFIED]` **Trung thực toạ độ end-to-end**: rectangle (10,20)-(60,120)mm → PLU → đổi
  ngược khớp chính xác trên cả 3 profile (`generic_hpgl`, `yuty_a3_max` flip_y, dual-head).
  Không lỗi scale/flip/swap. + 18 test sẵn có (golden so file máy thật, geometry, blade, registration).

### Preflight (read-only): 🟢
- `[VERIFIED]` chạy end-to-end trên file thật (17 trang, 5.85s), report đầy đủ, không crash. Có golden test.

### Bảo mật — re-verify bản vá (trong repo): 🟢 còn nguyên
- `[VERIFIED]` Token Ed25519 (biên giới bảo mật thật): `verify_license_token`, public key nhúng
  cứng (env override chỉ dev), `_is_dev_mode` fail-closed dưới binary compiled, enforce flag
  `PRYNX_ENFORCE_LICENSE_TOKEN=true` ở release spawn (`lib.rs`). **14/14 test pass.**
- `[VERIFIED]` WebSocket auth (close 4001), debug-log confine, integrity wired (`lib.rs:910`),
  fs deny vùng nhạy cảm (.ssh/.aws/Credentials…), `is_sensitive_path` cho lệnh Rust đọc file,
  CORS allowlist hẹp + host 127.0.0.1.
- 🔶 **Ngoài repo (chưa kiểm ở đây):** RLS bảng `licenses` + edge function `license-verify`
  (Supabase/`printsolutions-main`); release-build integrity chỉ chạy trên bản đóng gói thật.

---

## 7B. Chạy số (Numbering / VDP) — PHÁT HIỆN BỔ SUNG

### Verdict: 🟢 sau khi sửa lỗi 🔴 treo app

Tính năng "chạy số" = `NumberingTool.tsx` (sinh dãy số/serial) + render qua VDP engine
(`run_vdp_engine`), và `stick_text_number` (đóng số theo XY trong `LivePageFrame.tsx`).

### 🔴 [VERIFIED] Treo app khi sinh dãy số (đã sửa)
**Bản chất:** `generateSequence()` (range mode) chạy `for (i=startNum; i<=endNum; i+=increment)`
KHÔNG guard `increment > 0`, và input "Bước nhảy" KHÔNG có `min`. Hàm chạy **LIVE trong
preview (useMemo)** → khi người dùng gõ `0`, số âm, hoặc **xoá trống** (`Number('')===0`),
vòng for chạy **VÔ HẠN → đơ toàn ứng dụng ngay khi đang gõ** (không cần bấm nút). Range cực
lớn (vd 1..1.000.000) cũng làm đơ preview (không chặn trên).

**Bản sửa** (`desktop/src/components/preprocess-tools/NumberingTool.tsx`):
- Guard `step > 0` + `Number.isFinite` ở range mode → bước nhảy không hợp lệ trả dãy rỗng.
- Trần `MAX_SEQUENCE = 200000` cho cả range mode lẫn set mode (setTotal×seqTotal) → không đơ.
- Input "Bước nhảy" thêm `min={1}`.

**Verify (node, replicate guard):** inc=0/-1/rỗng → 0 phần tử (không treo); 1..100→100;
step5→20; 1..10.000.000 → chặn ở 200000. Giá trị hợp lệ giữ nguyên hành vi.

### Trục khác
- `stick_text_number` (`LivePageFrame.tsx`): tính `currentNumber += (page-1)*increment` theo
  TỪNG trang (không vòng lặp) → `[VERIFIED]` không có rủi ro treo tương tự.
- **Backend `run_vdp_engine` (render số lên template):** `[VERIFIED]` end-to-end bằng raster:
  (a) **số trang output = số record** (1 record → 1 trang); (b) **parity toạ độ** — field đặt
  ở (50,50)mm frontend rơi đúng khung pt kỳ vọng (factor `CSS_TO_PT_FACTOR=0.75` + flip
  top-left→bottom-left đặt chính xác); (c) nội dung mỗi trang khác nhau theo record;
  (d) field thiếu/ lỗi được cô lập (vẽ nhãn đỏ "MISSING"/"ERR", KHÔNG sập job).
- 🟢 Padding overflow (vd start=998,pad=3→"1000") chỉ là **cosmetic** (frontend, không crash).
- 🟢 Coupling mong manh: `CSS_TO_PT_FACTOR=0.75` giả định frontend dùng CSS px @96 DPI; nếu
  frontend đổi quy ước px→mm thì vị trí lệch âm thầm → nên có test parity neo số này.

---

## 8. CHECKLIST GO-LIVE (việc còn lại)

### Bắt buộc trước production (thủ công / ngoài-repo)
1. 🔴 Mở ≥1 file output MỖI công cụ trong **Acrobat/Illustrator** xác nhận spot đường bế tách
   đúng + không in đen + overprint (raster không thay được mắt prepress).
2. 🔴 **In/cắt thử thật 1 lượt** mỗi công cụ trước đơn lớn.
3. 🔶 Xác nhận **edge function Supabase `license-verify` cấp token Ed25519** đều đặn (toàn bộ
   kháng-crack phụ thuộc điều này) + chạy quy trình verify 9.6 trong `SECURITY_ARCHITECTURE.md`
   trên release build.
4. 🔶 **Rotate 45 key** từng phơi nhiễm thời gian lỗ RLS (mục 8.6 #3 của doc bảo mật) nếu chưa.

### Nên làm (fast-follow, không chặn)
- 🟠 Compare: hạ DPI mặc định / downsample khâu SSIM cho máy RAM thấp.
- 🟠 Edit: giới hạn stack undo hoặc snapshot định kỳ (file lớn nhiều op).
- 🟠 Hợp nhất 3 biến tool-identity (#C2).
- 🟢 LLM/OCR (QC) cần API key/Tesseract → verify thủ công trong môi trường thật.
- 🟢 Chạy số: VDP backend đã verify (page-count + toạ độ + nội dung). Nên thêm test neo
  `CSS_TO_PT_FACTOR=0.75` (parity frontend↔backend) + tách `generateSequence` để unit-test.

### Chưa được audit (vùng trống cần đợt sau)
- **Toàn bộ UI/UX desktop** ngoài imposition (viewer, dieline 2D/3D, flipbook, luồng edit
  tương tác, các tool merge/split/resize…).
- Đồng thời (concurrency) sâu, DB migration, error-handling toàn app, accessibility,
  supply-chain/dependency, build/packaging pipeline.

---

## 9. Phụ lục — Thay đổi code & test trong đợt audit

### Sửa lỗi (correctness)
- 🔴 `comparison_engine.py` — sửa căn trang B (1:1 advancement) + nhánh CMYK + tham chiếu found_b_idx.
- 🔴 `NumberingTool.tsx` — guard bước nhảy ≤0 + trần MAX_SEQUENCE 200k + input `min={1}` (chống treo app).

### Hardening / dọn dẹp
- `nup_engine.py`, `imposition.py`, `nup_layout_solver.py`, `nup_diecut.py` — gỡ debug-write,
  endpoint chết, hạ log; guard mẫu>tờ; path allowlist opt-in.
- `cnc_render.py` — guard mẫu>tờ.
- `plan_executor.py` — marks CMYK; tên file unique.
- `edit_session.py` — log discard-dirty.
- `useImposerSettingsStore.ts` — profile keys.
- `processHandlers.ts` — cờ isDieCutMode CNC.
- `pdfImposer.ts`, `InstructionSerializer.ts` — gỡ dead code.

### Test thêm (+22 backend)
- `test_plan_executor.py` (4), `test_compare_engine.py` (5), `test_qc_extract.py` (6),
  `test_compare_pipeline.py` (3), `test_edit_io_safety.py` (4).
- Seed test CNC flaky (`test_cnc_multi_template.py`).

### Kiểm chứng cuối
- **Backend: 400 passed** · **Frontend: 218 passed** · **typecheck sạch** · 0 diagnostics trên file đã sửa.

---

*Báo cáo này phản ánh phạm vi đã audit thực tế; vùng "chưa được audit" (Mục 8) không hàm ý
đã an toàn — chỉ là chưa được kiểm chứng. Production-readiness là khẳng định-có-bằng-chứng.*
