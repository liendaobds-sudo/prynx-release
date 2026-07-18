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

### Phase A — Ổn định hiện trạng (nền)

- [ ] Die detection stroke-only + page fallback (đã có hướng; harden + test file thật)  
- [ ] 1 Dao preview/layout + va chạm boong (RECTANGLE base_poly)  
- [ ] Copy/move trang cross-file (vị trí đầu/cuối/trước/sau + focus tab đích)  
- [ ] Crop / print / cluster leak fixes regression suite  
- [ ] Tài liệu ngắn: “cách báo bug prepress”  

**Done when:** không còn crash/regression blocker trên luồng tem bế + viewer chính.

---

### Phase B — PDF Utility “văn phòng” (lib lõi)

Ưu tiên cao → thấp. Mỗi tool: UI Home + API + test + i18n vi/en.

| # | Tính năng | Lib gợi ý | Ghi chú |
|---|-----------|-----------|---------|
| B1 | **Khóa PDF** (user/owner password, restrict print/copy) | pikepdf | Encrypt chuẩn |
| B2 | **Mở khóa PDF** (khi biết mật khẩu) | pikepdf | |
| B3 | **Chèn chữ ký / con dấu ảnh** (stamp) | pdf-lib | Không quảng cáo “chữ ký số PAdES” nếu chưa làm cert |
| B4 | **Nén PDF** (images downsample tùy chọn) | pikepdf + pillow | |
| B5 | **Watermark** chữ/ảnh đơn giản | pdf-lib / pikepdf | Tái dùng ý watermark hiện có nếu có |
| B6 | **Metadata** (title, author, clear) | pikepdf | |
| B7 | **Xoay / xóa / extract trang** UX gọn | viewer + pdf-lib | Nhiều phần đã có — gói thành tool “trang” |
| B8 | **Gộp / tách** rõ ràng hơn | CombineTab + splitter | Đánh bóng UX, không app lạ |

**Không làm trong phase B:** ký số certificate đầy đủ, DRM, OCR cloud trả phí bắt buộc.

**Done when:** user Free-path làm được khóa/mở, stamp chữ ký ảnh, nén — trong 1 app PrynX.

---

### Phase C — Prepress sâu hơn (vẫn trước Free/Pro)

| # | Hạng mục | Ghi chú |
|---|----------|---------|
| C1 | Nhận diện khuôn / trim no-die ổn định | File mẫu golden |
| C2 | 1 Dao LETA: preview ≡ export | |
| C3 | Cut export / mở khuôn AI-Corel | Đã có hướng |
| D1 | Numbering / VDP harden | Test + docs |
| D2 | Dieline nest export | Chỉ lib geometry hiện có |

---

### Phase D — Free/Pro (SAU CÙNG)

Chỉ khi B + phần lớn C xong:

1. Bảng feature id (`pdf.encrypt`, `impo.diecut`, …).  
2. `license-verify` trả `plan` + `features[]` (ký token).  
3. UI badge + `canUse()`.  
4. Backend từ chối job Pro nếu thiếu entitlement.  

**Không** thiết kế pricing trong phase B–C.

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
| S0 | Merge/ổn định branch hiện tại (commit này) |
| S1 | B1 + B2 Khóa / mở khóa PDF |
| S2 | B3 Stamp chữ ký ảnh |
| S3 | B4 Nén + B6 Metadata |
| S4 | B5 Watermark + đánh bóng B7/B8 |
| S5+ | Phase C prepress |
| Sau | Phase D Free/Pro |

---

## 8. Ngoài phạm vi (cố ý)

- Ghép Stirling-PDF / Sejda / app electron lạ  
- Tính phí trong app trước khi xong utility  
- Chữ ký số HSM/PAdES đầy đủ (trừ khi có spec + lib MIT/Apache rõ)

---

*Tài liệu này cập nhật khi chốt backlog sprint; Free/Pro chỉ mở Phase D.*
