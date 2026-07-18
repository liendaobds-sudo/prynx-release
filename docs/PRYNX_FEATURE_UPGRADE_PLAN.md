# PrynX — Kế hoạch nâng cấp tính năng PDF (lib lõi, license tự do)

> **Nguyên tắc:** chỉ dùng thư viện lõi (không ghép app/repo lạ nguyên khối).
> **Bản quyền:** chỉ MIT / Apache-2.0 / BSD / ISC / Unlicense (và tương đương permissive).
> **Cấm:** GPL/AGPL/LGPL “dính” vào binary phân phối nếu không rà soát kỹ; cấm clone UI app PDF khác.
> **Free/Pro:** **chưa làm** — hoàn thiện tính năng trước, phân gói sau.

---

## 1. Mục tiêu

1. Mở rộng **công cụ xử lý PDF hàng ngày** (chữ ký stamp, khóa/mở khóa, nén, metadata…) trên cùng UX PrynX.
2. Ổn định / siết các tool prepress đã có (bình bài, tem bế, CNC, crop, copy trang…).
3. Giữ stack hiện tại: **Tauri + React + pdf-lib + pdfjs + pikepdf + pdfium (Rust)**.
4. Mọi dependency mới phải **permissive** và có thể ship trong installer thương mại.

---

## 2. Chính sách bản quyền (bắt buộc)

| Được dùng | Không dùng (mặc định) |
|-----------|------------------------|
| MIT, Apache-2.0, BSD-2/3, ISC, Zlib, Unlicense, CC0 (code) | GPL-2/3, AGPL, SSPL, Commons Clause |
| LGPL **chỉ** nếu dynamic-link & pháp lý đã duyệt (thường **tránh**) | “Source available” hạn chế thương mại |
| Code tự viết / fork MIT từ lib lõi | Copy nguyên repo app (Stirling-PDF UI, PDF24 clone…) |

**Quy trình thêm lib:**

1. Ghi tên package + license file vào PR.
2. Ưu tiên package đã có trong monorepo (pdf-lib, pikepdf, pdfium).
3. Không vendoring binary lạ không có license rõ.

**Stack lõi hiện có (đã OK cho commercial):**

- pdf-lib (MIT)
- pdfjs-dist (Apache-2.0)
- pikepdf (MPL-2.0 — permissive-ish, OK ship; không “GPL virus”)
- PyMuPDF/fitz nếu dùng: kiểm tra license AGPL vs commercial — **ưu tiên pikepdf/pdfium** thay vì kéo PyMuPDF AGPL vào path mới
- Tauri / Rust crates: theo `Cargo.toml` (thường MIT/Apache)

---

## 3. Nguyên tắc kỹ thuật

1. **Một entry = một tool** trong `toolRegistry` (hoặc submenu “Xử lý PDF”).
2. **UI PrynX** (toolbar + panel), không embed app ngoài.
3. **FE:** thao tác nhẹ (stamp, reorder) bằng pdf-lib khi đủ.
4. **BE/Rust:** encrypt, compress, batch nặng — pikepdf / pdfium / qpdf (nếu license Apache).
5. **Parity:** preview ≈ output; test characterization khi đụng imposition.
6. **Không** đụng Free/Pro gate cho đến khi backlog utility ổn định.

---

## 4. Lộ trình theo phase

### Phase A — Ổn định hiện trạng (nền) — **DONE**

- [x] Die detection stroke-only + page fallback (+ unit `test_die_stroke_only_policy`)
- [x] 1 Dao preview/layout + va chạm boong (RECTANGLE base_poly; `test_one_dao_shape_force_rectangle`)
- [x] Copy/move trang cross-file (vị trí + focus tab đích)
- [x] Crop / print / cluster leak fixes (+ regression tests cluster/die)
- [x] Tài liệu: `docs/PREPRESS_BUG_REPORT.md`

---

### Phase B — PDF Utility “văn phòng” — **DONE**

| # | Tính năng | Trạng thái |
|---|-----------|------------|
| B1 | Khóa PDF | **DONE** — tool `encrypt` + pikepdf |
| B2 | Mở khóa PDF | **DONE** — cùng tool |
| B3 | Chữ ký / con dấu ảnh | **DONE** — preset trên WatermarkTool |
| B4 | Nén PDF | **DONE** (sẵn) OptimizeTool |
| B5 | Watermark | **DONE** (sẵn) + preset B3 |
| B6 | Metadata | **DONE** — tool `metadata` |
| B7 | Xoay / xóa / extract | **DONE** + UX help + i18n xoay |
| B8 | Gộp / tách | **DONE** + gợi ý chéo Combine ↔ Split |

Hướng dẫn: `docs/PDF_UTILITIES_GUIDE.md`.

**Không làm (ngoài phạm vi):** PAdES/HSM, DRM, OCR cloud.

---

### Phase C — Prepress sâu hơn — **DONE (harden + tests)**

| # | Hạng mục | Trạng thái |
|---|----------|------------|
| C1 | Nhận diện khuôn stroke-only | **DONE** + unit tests |
| C2 | 1 Dao LETA RECTANGLE / trim page | **DONE** + unit tests |
| C3 | Cut export / máy bế | **Đã có** module `cut_export/` (giữ nguyên) |
| D1 | Numbering / VDP | **Đã harden** (commits trước + tests) |
| D2 | Dieline nest | **Đã có** tool Dieline / geometry (giữ nguyên) |

---

### Phase D — Free/Pro — **SCAFFOLD (gate TẮT)**

1. [x] Bảng feature id — `desktop/src/lib/license/features.ts` + `backend/app/core/feature_entitlements.py`
2. [ ] `license-verify` trả `plan` + `features[]` — **chờ server** (không đổi edge trong PR này)
3. [x] `canUse()` / `can_use_feature()` — **luôn true** khi `FEATURE_GATING_ENABLED=false`
4. [ ] Backend từ chối job Pro — **chưa bật** (tránh chặn user)

Bật gate sau: set `FEATURE_GATING_ENABLED=true` (FE+BE) + server trả `plan`.
**Không** thiết kế pricing UI trong scaffold này.

---

## 5. Cấu trúc code đề xuất (utility mới)

```
desktop/src/components/pdf-tools/     # UI tools (Encrypt, Stamp, Compress…)
desktop/src/lib/pdfTools/             # pdf-lib helpers
backend/app/api/routes/pdf_tools.py   # nếu cần sidecar
backend/app/workers/pdf_tools_engine.py  # đã có — mở rộng
```

Đăng ký Home qua `toolRegistry.ts` category `file` hoặc `util`.

---

## 6. Tiêu chí chấp nhận mỗi feature mới

- [ ] License dependency = permissive (ghi rõ trong PR)
- [ ] Không vendoring app ngoài
- [ ] i18n vi + en
- [ ] Test tối thiểu (unit hoặc 1 PDF fixture)
- [ ] Không phá imposition/viewer regression chính
- [ ] Tài liệu 5–10 dòng “cách dùng” trong PR description

---

## 7. Thứ tự triển khai đề xuất (sprint)

| Sprint | Việc |
|--------|------|
| S0–S3 | Utility encrypt / watermark preset / metadata — **DONE** |
| S4 | B7/B8 polish + guide — **DONE** |
| S5 | Phase C tests harden — **DONE** |
| S6 | Phase D feature ids + canUse scaffold (gate off) — **DONE** |
| Sau | Bật Free/Pro gate + server plan (khi chốt commercial) |

---

## 8. Bảng chấm repo / lib (2026-07-18)

> **Mục tiêu chấm:** gap còn lại sau audit trùng tool PrynX — chủ yếu **B1/B2 khóa-mở**, **B6 metadata**, **B3 preset chữ ký**.
> **Không chấm** để clone app full; chấm để chọn **engine** ship thương mại an toàn.
> **Điểm:** 1–5 mỗi cột (cao = tốt hơn cho PrynX). **Tổng /30**.

### 8.1 Tiêu chí

| Cột | Ý nghĩa |
|-----|---------|
| **License** | Ship installer thương mại đóng nguồn (MIT/Apache/BSD/MPL-ok; AGPL/GPL = 1) |
| **B1/B2** | Encrypt/decrypt + permissions (print/copy/modify) |
| **B6** | Docinfo / metadata R/W |
| **Stack fit** | Khớp Python BE + TS/pdf-lib FE hiện tại, không JVM/Go binary mới nếu không cần |
| **Overlap** | Tránh engine thứ 2 cho merge/split/nén đã có (cao = ít trùng / bổ sung đúng chỗ) |
| **Chi phí tích hợp** | Effort + rủi ro đóng gói Windows |

### 8.2 Ứng viên — lib / CLI (engine)

| # | Ứng viên | License | B1/B2 | B6 | Stack | Overlap | Tích hợp | **Tổng** | Quyết định |
|---|----------|---------|-------|-----|-------|---------|----------|----------|------------|
| 1 | **pikepdf** (đã có `==9.5.0` pin; runtime có `Encryption`/`Permissions`) | MPL-2.0 (QPDF core Apache) — ship OK | **5** API `Encryption(user, owner, allow=Permissions(...))` | **5** `docinfo` / XMP quen trong codebase | **5** BE write engine chính | **4** bổ sung encrypt, không thay nén | **5** zero dep mới | **29** | **CHỌN #1** cho B1/B2/B6 |
| 2 | **pypdf** (đã pin `==6.13.3`) | BSD-3-Clause | **4** `PdfWriter.encrypt` AES; decrypt OK; AES cần crypto extra | **3** metadata cơ bản | **4** pure Python, đã trong req | **3** trùng một phần merge/split path | **4** đã cài | **22** | **Dự phòng** nếu pikepdf kẹt edge-case; không engine chính |
| 3 | **qpdf** CLI/lib C++ | Apache-2.0 | **5** encrypt/decrypt/linearize mạnh | **3** inspect > editor UI | **2** binary native thêm | **3** | **2** ship DLL + path + version | **18** | **Không ship**; chỉ tham chiếu CLI nếu debug |
| 4 | **pdfcpu** (Go CLI) | Apache-2.0 | **5** encrypt/decrypt | **4** metadata CLI | **2** binary Go sidecar | **2** trùng merge/split/watermark | **2** +Go toolchain release | **17** | **Tham khảo ý CLI**; không embed |
| 5 | **pdf-lib** (FE đã có) | MIT | **1** không encrypt đầy đủ | **2** limited | **5** FE stamp | **5** đúng chỗ B3 stamp | **5** | **20** | **CHỌN** cho B3 preset chữ ký (ảnh), **không** B1/B2 |
| 6 | **Pillow** (thường đi với optimize) | HPND-ish permissive | 1 | 1 | 4 | 3 | 4 | — | Chỉ phụ trợ nén ảnh (B4 đã có) |

### 8.3 Ứng viên — app / framework full (UI)

| # | Ứng viên | License | B1/B2 | Feature breadth | Stack | Rủi ro thương mại | Tích hợp | **Tổng** | Quyết định |
|---|----------|---------|-------|-----------------|-------|-------------------|----------|----------|------------|
| A | **Stirling-PDF** | OSS core **MIT**; có lớp proprietary + pricing/user tier phía server | 4 (gọi lib dưới) | **5** all-in-one | **1** Java/Spring web app | **2** clone UI + bloat + model server ≠ Tauri desktop | **1** | **~14** | **LOẠI** — chỉ học *danh sách feature*, không ghép |
| B | **Sejda 2.x+ / SDK** | **AGPL-3.0** (commercial SDK trả phí) | 4 | 5 | 1 Java | **1** AGPL virus / phí | 1 | **~12** | **LOẠI** |
| C | **PDFsam Basic** (engine Sejda cũ) | Apache (Basic) / AGPL chain phức tạp | 2 | 3 merge-split | 1 Java | 2 | 1 | **~12** | **LOẠI** — PrynX đã có Combine/Split |
| D | **PyMuPDF (fitz)** | **AGPL** hoặc commercial license trả phí | 4 | 5 | 3 Python | **1** AGPL dính binary | 2 | **~15** | **LOẠI** path mới (policy plan đã cấm) |
| E | **OCRmyPDF** | MPL-2.0 | 1 | OCR | 3 | 3 | 3 | — | OCR PrynX tạm ẩn; không ưu tiên phase B |

### 8.4 Ma trận “gap PrynX × engine thắng”

| Gap | Engine thắng | Không dùng | Ghi chú |
|-----|--------------|------------|---------|
| B1 Khóa PDF | **pikepdf** `Encryption` + `Permissions` | Stirling UI, pdf-lib, PyMuPDF | User/owner + print/extract/modify flags |
| B2 Mở khóa | **pikepdf** open password → save plain | `ignoreEncryption` hiện tại chỉ *bỏ qua*, không phải tool “gỡ khóa” user-facing | |
| B3 Stamp chữ ký ảnh | **pdf-lib** qua **WatermarkTool** preset | Tool Home mới, app lạ | Trùng watermark — chỉ UX preset |
| B4 Nén | **Đã có** OptimizeTool | pdfcpu/qpdf nén song song | |
| B5 Watermark | **Đã có** WatermarkTool | — | |
| B6 Metadata | **pikepdf** `docinfo` (+ optional XMP) | App metadata full | Panel nhỏ xem/sửa/clear |
| B7 Trang | **Đã có** PageToolsPanel | — | |
| B8 Gộp/tách | **Đã có** Combine + Split | Sejda/PDFsam | |

### 8.5 Kết luận chấm (chốt)

1. **Implement B1/B2/B6 bằng pikepdf** — đã là write engine, API encrypt sẵn, không thêm dependency.
2. **pypdf** = fallback / đã pin — không nhân đôi pipeline.
3. **pdf-lib** = B3 preset chữ ký trên watermark.
4. **qpdf / pdfcpu** = học hành vi & test vector; **không** ship binary.
5. **Stirling / Sejda / PyMuPDF** = **không** ghép app/repo; license hoặc kiến trúc không khớp desktop Tauri thương mại.
6. **Không** mở sprint “import utility từ repo X” — chỉ **tự viết UI PrynX** gọi lib đã chấm.

### 8.6 Điểm tham chiếu nhanh (thang 10 cho “nên dùng ngay”)

| Ứng viên | Điểm /10 | Vai trò |
|----------|----------|---------|
| pikepdf | **9.5** | Engine B1/B2/B6 |
| pdf-lib | **7** (đúng job stamp) | B3 preset |
| pypdf | **7** | Dự phòng encrypt |
| qpdf | **5** | Dev/debug only |
| pdfcpu | **4.5** | Ý tưởng CLI only |
| Stirling-PDF | **2** | Feature checklist only |
| Sejda 2+ | **1** | AGPL — cấm |
| PyMuPDF | **1.5** | AGPL — cấm path mới |

---

## 9. Ngoài phạm vi (cố ý)

- Ghép Stirling-PDF / Sejda / app electron lạ
- Tính phí trong app trước khi xong utility
- Chữ ký số HSM/PAdES đầy đủ (trừ khi có spec + lib MIT/Apache rõ)
- Ship binary qpdf/pdfcpu “cho đủ tính năng” khi pikepdf đã cover

---

*Tài liệu này cập nhật khi chốt backlog sprint; Free/Pro chỉ mở Phase D.*
*Bảng chấm §8: 2026-07-18 — re-audit khi đổi major pikepdf/pypdf hoặc cần AES edge-case.*
