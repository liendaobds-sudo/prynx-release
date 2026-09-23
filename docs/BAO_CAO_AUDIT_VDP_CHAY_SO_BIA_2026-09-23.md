# Audit VDP → Chạy số → Bìa — 2026-09-23

Trạng thái: **AUDIT-ONLY / CHỜ DUYỆT SỬA**. Không sửa production code trong lượt này.

## 1. Phạm vi và baseline

- Repo: `D:\pdfcompare`.
- HEAD: `703ffc2604ad5e5ff0ef391d9684e05688693c2b` (`2026-09-21`). Working tree có thay đổi VDP chưa commit ở `backend/app/api/routes/vdp.py`, `backend/app/workers/vdp_engine.py`, `backend/app/workers/vdp_preview.py`.
- Luồng VDP: `DataMergeTool` / `NumberingTool` / `CoverNumberingTool` → `desktop/src/lib/api.ts` → `/api/vdp/*` → datasource/validator/preview → `vdp_engine.process_chunk` → PDF artifact + lease.
- Luồng chạy số: `NumberingTool.computeSequenceFromConfig` → `generateDataMatrix` → VDP job → PDF; preview text/live và `/vdp/preview` là các consumer khác nhau.
- Luồng bìa: `coverNumberingEngine` → `coverNumberingPlanner.planCoverLayout` → records theo tờ → VDP job; nguồn bìa có cả File native path-backed và chế độ trích trang từ một PDF chung.

### Commit history đối chiếu

- `2c08019`: VDP Tier-1 (CSV/XLSX/GSheet, conditions/rules, barcode/GS1, preview, validate, error report).
- `653121c`: đọc toàn bộ nguồn, multi-up, rotation canonicalization.
- `282f3b6`, `fb79dda`, `c8eb751`, `725db43`, `09f5055`: Type-on-Path/wave/S-curve, auto-fit, live preview và text picker.
- `8c8894c`: Numbering preview/output parity, group/sort, increment/set, smart extract.
- `73b0240`: PDFium Type0 live-text path, font normalization và các thay đổi VDP hiện hành.

## 2. Cải thiện đã xác minh

| Hạng mục | Bằng chứng | Trạng thái |
|---|---|---|
| Datasource CSV/XLSX/GSheet, delimiter/encoding, sheet selection | `vdp_datasource.py`, property tests `backend/tests/vdp/*datasource*`, route integration | `AUTO` |
| Conditions/rules/GS1/barcode/error gating | `vdp_conditions.py`, `vdp_validate.py`, `vdp_gs1.py`, property/regression tests | `AUTO` |
| Preview record, clamp index, field error rect | `vdp_preview.py`, `test_preview_properties.py`, route tests | `AUTO` |
| Native path-backed template/bìa | `CoverNumberingTool.nativePath.test.tsx`, `getFileArrayBuffer` path | `AUTO` |
| Numbering grouping/sort/increment/set và Cover planner X/Y/Z | `NumberingTool.tsx`, `coverNumberingEngine.ts`, `coverNumberingPlanner.ts`, frontend tests | `AUTO` phần logic; artifact PDF còn thiếu |
| Type0 text path và font cleanup | commit `73b0240`, `test_vdp_engine.py` Type0/dead-font tests | `AUTO` format; chưa đủ `ARTIFACT/RUNTIME` Illustrator |

Đã chạy lại trong working tree hiện tại:

```text
Backend VDP suite: 135 passed, 2 warnings
Frontend DataMerge/Cover/VdpAlign/vdpUtils: 26 passed
```

## 3. Findings chính

### VDP23.01 — P1 — Preview text và PDF output đi qua hai renderer khác nhau

**[CONFIRMED / TRACE + ARTIFACT lịch sử]**

- Preview: `backend/app/workers/vdp_preview.py:219` gọi trực tiếp `render_one_record` (ReportLab), sau đó rasterize PNG.
- Output: `backend/app/workers/vdp_engine.py:1470-1573` ưu tiên `PdfiumVdpTextRenderer` cho text thẳng; các field còn lại mới đi `render_one_record`.
- Vì vậy các thuộc tính như glyph metrics, rotation/pivot, horizontal auto-fit, line-height và baseline có thể khác giữa preview và PDF.
- `docs/BAO_CAO_AUDIT_VDP_CAN_GIUA_TRAN_KHUNG_2026-09-21.md` đã đo trên renderer hiện hành: rotation=90, lineHeight và autoFit cho bbox/vị trí khác nhau; test hiện tại chủ yếu kiểm primitive/property, chưa parse/raster final PDF của `process_chunk` để khóa parity.

Tác động: người dùng duyệt một ảnh đúng nhưng PDF in/đưa Illustrator có vị trí, chiều xoay hoặc độ nén chữ khác.

### VDP23.02 — P1 — Font yêu cầu có thể âm thầm rơi về Arial

**[CONFIRMED / SOURCE + LIVE CONSUMER]**

- `_resolve_system_font` hiện ghi cảnh báo và trả `None` khi không tìm thấy font.
- Nhưng `process_chunk` tại `backend/app/workers/vdp_engine.py:1495` gọi `_resolve_system_font('Arial')` khi font field không resolve được, rồi vẫn đưa field qua PDFium.
- Đây là consumer live; người dùng không nhận lỗi “font đã đổi”, chỉ nhận PDF hiển thị sai typeface. Audit font trước đó đã tái hiện resolver name-only trả Arial cho các font UTM có thật.
- Test hiện có kiểm resolver trả `None` cho tên không tồn tại, nhưng chưa khóa hậu điều kiện “không được dùng fallback Arial âm thầm trong output”.

### VDP23.03 — P1/P2 — Debug log hiện ghi dữ liệu khách hàng và đường dẫn font ở mức warning

**[CONFIRMED / SOURCE; security/privacy proof runtime còn thiếu]**

Working tree hiện thêm các log warning:

- `backend/app/api/routes/vdp.py:463`: log sample record đầu tiên (giá trị cột khách hàng).
- `vdp.py:540-551`: log `file_path`, tên field, `fontFile`, fontName, màu, cấu hình field.
- `vdp_engine.py:250,407-491,1553-1573`: log text/field, color, font path, content stream bytes/tail.
- `vdp_preview.py:176-185`: log field/font/color của preview.

VDP có thể chứa PII, mã sản phẩm, số seri và dữ liệu khách hàng. Warning production vừa làm lộ dữ liệu vào log vừa flood I/O trong vòng record/chunk. Các log này phải là `debug` có opt-in hoặc được redaction; không được ship nguyên trạng.

### VDP23.04 — P2 — Registry template đã làm sạch không có eviction

**[CONFIRMED / SOURCE]**

- `backend/app/api/routes/vdp.py:1285` tạo `_VDP_CLEANED_TEMPLATES` global dict.
- `_register_cleaned_template` tại `:1340` thêm entry sau mỗi lần pick/auto-detect.
- `_resolve_vdp_template_file` đọc map nhưng không có TTL/sweep; `_purge_old_jobs` chỉ dọn job VDP, không dọn map template.
- File vật lý có artifact lease/DB expiry nhưng dict trong process vẫn tăng và giữ path/name cũ; nhiều lần dùng text picker có thể làm state stale và phình RAM nhỏ nhưng liên tục.

### NUM23.01 — P1 — Shuffle số chạy làm preview và output khác nhau

**[CONFIRMED / SOURCE]**

- `NumberingTool.tsx:116-120` dùng `Math.random()` trong `computeSequenceFromConfig` khi `isShuffle=true`.
- Preview/live gọi `generateSequence`/`generateDataMatrix` ở các effect/useMemo (`:499`, `:613`, `:641`, `:718`); nút Generate gọi lại `generateDataMatrix` ở `:539`.
- Mỗi lần gọi tạo một hoán vị mới. Vì vậy preview có thể hiển thị số A/B nhưng file output sinh số C/D, dù grouping/sort đã được đồng bộ.
- Không thấy test khóa cùng seed/sequence snapshot cho chế độ shuffle.

Đây là lỗi correctness trực tiếp của tính năng chạy số, không chỉ khác hình preview.

### NUM23.02 — P2 — Tính lại dãy số nhiều lần trên UI, đặc biệt với trần 200.000 phần tử

**[CONFIRMED / SOURCE; cần benchmark runtime]**

`computeSequenceFromConfig` có thể sinh và Fisher–Yates shuffle tới 200.000 phần tử. `generateDataMatrix`, live store, `rawSequence`, preview lines và `/vdp/preview` đều có đường gọi lại; với shuffle còn vừa tốn CPU vừa đổi dữ liệu. Cần cache theo cấu hình bất biến và seed ổn định, không tự đặt cap mới.

### COVER23.01 — P2 — Artifact parity của Bìa chưa đủ bằng chứng

**[SUSPECTED / PROOF GAP]**

- `CoverNumberingTool` đã có planner X/Y/Z, distribution stack/sequential, multi-cluster và trích trang bìa path-backed.
- Test hiện tại chủ yếu kiểm đọc bytes native, lease và gọi job; chưa có artifact PDF kiểm toàn bộ ma trận: nhiều cluster × sort (Z/N/U/C) × stack/sequential × ô trống tờ cuối × single-file cover pages.
- Chưa gọi đây là bug correctness vì `coverNumberingEngine`/planner có property logic và chưa có artifact sai được tái hiện trong lượt này.

## 4. Điều đã kiểm và không coi là finding

- Validate DataMerge đã được gọi trước generate; XLSX/GSheet đọc full source riêng, không còn giới hạn 20 dòng preview khi sinh lô.
- `startVdpJobBackend`/route có feature allowlist `vdp.datamerge`, `vdp.numbering`, `vdp.cover_numbering` và job receipt.
- Cover path-backed bytes đã có test; không gán lỗi “0 trang” cũ cho current code.
- `MAX_VDP_ROWS=100000` và payload 256 MB là guard đã có; chưa đánh giá đây là đúng/đủ SLO cho mọi máy.

## 5. Coverage/proof gap

- Chưa mở Tauri app thật hoặc Illustrator/CorelDRAW để nghiệm thu live text, font và PDF/PNG parity.
- Chưa tạo artifact PDF mới trên đúng working tree cho Numbering shuffle, Cover planner và straight-text VDP.
- Chưa kiểm full matrix locale/Unicode tổ hợp, font CFF/TTF, font thiếu/variant, nhiều template pages, cancel/retry và clean restart.
- 135 backend + 26 frontend pass không đóng các finding parity/runtime trên vì test hiện tại chưa đo final PDF output tương ứng.

## 6. Đề xuất lô sửa (chờ duyệt)

1. **Lô A — parity renderer (≤5 file):** thống nhất layout primitive giữa preview và output, khóa rotation/autoFit/lineHeight bằng final-PDF raster.
2. **Lô B — font resolver/live text (≤5 file):** bỏ fallback Arial âm thầm, resolver chung theo face identity, lỗi rõ khi không tìm được font; chưa đụng font hệ thống.
3. **Lô C — logging/privacy (≤5 file):** hạ debug log VDP về debug/redact, bỏ sample row/font path/content bytes khỏi warning; bổ sung regression log policy.
4. **Lô D — numbering determinism (≤5 file):** seed/persist một sequence khi bật Shuffle, dùng cùng sequence cho live preview, `/vdp/preview` và generate; thêm test mismatch.
5. **Lô E — cleaned-template lifecycle + cover artifact:** sweep registry theo lease/TTL; tạo artifact matrix cho bìa trước khi sửa tiếp.

**Chốt duyệt:** Báo cáo này chỉ ghi bằng chứng. Chưa sửa production trong lượt audit.
