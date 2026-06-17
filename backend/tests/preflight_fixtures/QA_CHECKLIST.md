# Preflight QA Checklist — Manual + Automated

Bộ kiểm thử chuẩn cho tính năng Preflight (`D:\pdfcompare`).

## A. Chạy tự động (bắt buộc trước mỗi release)

```powershell
cd D:\pdfcompare\backend

# 1. Sinh lại fixture PDF (nếu đổi generator)
.\venv\Scripts\python.exe tests\preflight_fixtures\generate_fixtures.py

# 2. Golden tests — 17 fixture PDF
.\venv\Scripts\python.exe -m pytest tests\preflight_golden -v

# 3. Regression suite Preflight
.\venv\Scripts\python.exe -m pytest tests\test_preflight_engine.py tests\test_image_dpi_props.py tests\test_placed_size_props.py tests\test_tac_threshold_props.py tests\test_tac_props.py tests\test_tac_bbox_props.py -v
```

**Pass criteria:** 0 failed (skipped OK: `17_tac_heavy_cmyk.pdf` khi thiếu Ghostscript).

---

## B. Bộ PDF fixture tự động (`tests/preflight_fixtures/pdfs/`)

| File | Rule kỳ vọng | Ghi chú QA manual |
|------|----------------|-------------------|
| `01_clean_blank.pdf` | BLEED_MISSING | Thiếu TrimBox — đúng báo CTP |
| `02_rgb_colorspace.pdf` | COLOR_RGB_DETECTED | Highlight RGB trên viewer |
| `03_live_text.pdf` | TEXT_DETECTED | Bbox text; thử Khóa Font |
| `04_font_not_embedded.pdf` | FONT_NOT_EMBEDDED | Bbox font trên viewer |
| `05_page_size_mismatch.pdf` | PAGE_SIZE_MISMATCH | Trang 2 khác khổ trang 1 |
| `06_opi_linked_image.pdf` | IMAGE_NOT_EMBEDDED | OPI / link ảo |
| `07_indexed_palette.pdf` | GIF_IN_PDF | Palette 256 màu |
| `08_low_res_image.pdf` | IMAGE_LOW_RES | DPI ~5–50, bbox ảnh |
| `09_high_dpi_image.pdf` | IMAGE_HIGH_DPI | DPI >600 |
| `10_overprint.pdf` | OVERPRINT_DETECTED | Thử Overprint Preview |
| `11_transparency.pdf` | TRANSPARENCY_DETECTED | Thử Flatten |
| `13_multipage_15.pdf` | BLEED_MISSING, không INTERNAL_ERROR | MP 15 trang <5s |
| `14_progressive_jpeg.pdf` | Manual — PROGRESSIVE_JPEG | File ReportLab; dùng JPEG progressive thật (C3) |
| `15_pdf_version_old.pdf` | PDF_VERSION_MISMATCH | Header PDF 1.2 |
| `16_object_off_page.pdf` | OBJECT_OFF_PAGE | Text ngoài trang |
| `17_tac_heavy_cmyk.pdf` | TAC_EXCEEDED (optional) | Cần Ghostscript |

Chi tiết kỳ vọng: `expected_rules.json`.

---

## C. QA manual — file thật từ khách (bắt buộc 1 lần/sprint)

Đặt file vào `tests/preflight_fixtures/manual_samples/` (tự tạo, không commit file khách nếu nhạy cảm).

### C1. Checklist từng file

| # | Việc kiểm | Pass? | Ghi chú |
|---|-----------|-------|---------|
| 1 | Upload file → PreflightTab → Chạy **16 rules** | ☐ | Không crash, có báo cáo |
| 2 | PreflightTool (sidebar) — cùng file, cùng rules | ☐ | Kết quả khớp Tab |
| 3 | Click từng issue → highlight bbox trên viewer | ☐ | Bbox đúng vị trí |
| 4 | Rule `IMAGE_LOW_RES` — DPI mô tả khớp ~thực tế | ☐ | So Photoshop |
| 5 | Rule `FONT_NOT_EMBEDDED` — đúng font lỗi | ☐ | Không nhảy font khác |
| 6 | Fix `CONVERT_TO_CMYK` → inspect lại | ☐ | RGB biến mất |
| 7 | Fix `OUTLINE_FONTS` → TEXT_DETECTED biến mất | ☐ | |
| 8 | Fix `DOWNSCALE_IMAGES` → HIGH_DPI giảm | ☐ | |
| 9 | `TAC_EXCEEDED` + đổi threshold 280/320 | ☐ | Cảnh báo thay đổi |
| 10 | File **15+ trang** — thời gian chấp nhận được | ☐ | Log MP worker |

### C2. Loại file nên có trong `manual_samples/`

| Loại | Nguồn | Rule mong đợi |
|------|-------|---------------|
| Illustrator Place Link | .ai → PDF | IMAGE_NOT_EMBEDDED (XMP) |
| Corel spot + RGB mix | .cdr → PDF | COLOR_RGB + COLOR_SPOT |
| File in offset 300dpi chuẩn | Khách OK | 0 error, có thể vài warning |
| File lỗi thật từ RIP | Lịch sử lỗi | Khớp rule đã biết |
| PDF 200+ trang | Catalogue | Không INTERNAL_ERROR |
| JPEG Progressive thật | Export Photoshop/AI | PROGRESSIVE_JPEG bắt đúng |

### C3. XMP Linked (không auto được)

Pikepdf strip XMP khi save → fixture `06b_xmp_linked_manual` chỉ kiểm **bằng file Illustrator thật**:

1. Xuất PDF có Place Link từ AI
2. Chạy Preflight rule `IMAGE_NOT_EMBEDDED`
3. **Pass:** báo linked / OPI / XMP

---

## D. UI regression checklist

| # | Màn hình | Kiểm tra | Pass? |
|---|----------|----------|-------|
| 1 | PreflightTab | 16 rules hiển thị, chọn/bỏ chọn | ☐ |
| 2 | PreflightTab | `TAC_EXCEEDED` có trong list | ☐ |
| 3 | PreflightTool | 16 rules, mô tả low-res **200 DPI** | ☐ |
| 4 | Cả hai | `tac_threshold: 300` gửi trong API | ☐ |
| 5 | Output Preview | Overprint toggle hoạt động | ☐ |
| 6 | Soft Proof panel | Render không lỗi | ☐ |

---

## E. Khi FAIL — quy trình

1. Ghi file PDF + `rules` đã chọn + screenshot báo cáo
2. Chạy CLI debug:
   ```powershell
   .\venv\Scripts\python.exe -c "
   from app.core.preflight_engine import PreflightEngine
   r = PreflightEngine().run(r'PATH\TO\file.pdf')
   for i in r.issues: print(i.rule_id, i.page, i.description[:80])
   "
   ```
3. So với `expected_rules.json` nếu là fixture auto
4. Sửa code → chạy lại section A → cập nhật manifest nếu đổi hành vi **có chủ đích**

---

## F. Sign-off

| Vai trò | Tên | Ngày | Automated | Manual C1 | UI D |
|---------|-----|------|-----------|-----------|------|
| Dev | | | ☐ | ☐ | ☐ |
| QA / In ấn | | | ☐ | ☐ | ☐ |

**Chỉ sign-off khi:** golden 0 fail + manual C1 ≥8/10 + không INTERNAL_ERROR trên file thật.