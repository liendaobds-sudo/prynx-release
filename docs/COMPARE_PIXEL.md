# So sánh PDF — Pixel-first (kiểm in)

## Mục tiêu

Đối chiếu **những gì in ra nhìn thấy** giữa bản mẫu và bản sửa / bản bình.

- **Nguồn sự thật:** render trang → so pixel (`ImageComparator`)
- **Không** dùng OCR hay text layer để quyết định ĐẠT / KHÔNG ĐẠT
- **Có vùng pixel khác = KHÔNG ĐẠT** (sai 1 chữ / 1 chi tiết cũng là lỗi)
- **% giống hình (SSIM)** chỉ **tham khảo**, không phải điểm “còn bao nhiêu % ổn”

So **chữ thuần** (text layer): dùng tool **So sánh văn bản** / QC riêng.

## Luồng kỹ thuật

```
Upload A/B → POST /api/jobs/compare
  → run_comparison_pipeline
  → render PDF (pypdfium2) @ DPI
  → ImageComparator.compare
       • 1:1 + pad + (optional) align
       • absdiff + threshold (STRICT/NORMAL/LOOSE)
       • morph + contour + micro-diff rescue
       • Case A: scale cùng aspect
       • Case B: imposition — match 1-up trên N-up, so pixel TỪNG bản
  → PageResult + print_verdict
```

## Tolerance

| Mức | Ngưỡng absdiff | Ghi chú |
|-----|----------------|---------|
| **STRICT** | 0 | Proof / nhãn nhỏ. Không registration. Morph nhẹ (không OPEN). |
| **NORMAL** | 13 | **Khuyến nghị in.** Bỏ anti-alias nhỏ. Align lệch render. |
| **LOOSE** | 38 | Chỉ lệch lớn. Có thể bỏ sót chữ xám nhạt — không dùng proof cuối. |

## DPI

| DPI | Khi nào |
|-----|---------|
| **300** | Khuyến nghị — chi tiết nhỏ, nhãn tem |
| **150** | Nhanh hơn, file lớn |

`min_contour_area` scale theo DPI (trần ×2) + **micro-diff rescue** để không nuốt glyph nhỏ (vd `test/goc.pdf` vs `binh.pdf`).

## Imposition (1-up vs tờ N-up)

1. `matchTemplate` tìm vị trí / góc xoay / scale  
2. **So pixel từng instance** với template (cùng tolerance)  
3. Micro-rescue trên từng bản  
4. `failed_instances` / `total_instances` trong summary  

## Kết quả UI / API

- `print_verdict`: `ĐẠT` | `KHÔNG ĐẠT`
- `total_diff_count`: số vùng lỗi
- `visual_similarity` / `average_similarity`: SSIM (tham khảo)
- `compare_method`: `"pixel"`
- `verdict_detail`: mô tả ngắn theo chuẩn in

## Regression fixtures

- `test/goc.pdf` + `test/binh.pdf` — nhãn outline, sửa vài chi tiết  
- `tests/test_compare_engine.py` — unit pixel / imposition / tolerance  
- `tests/test_compare_pipeline.py` — pipeline end-to-end  

## Checklist vận hành

1. Restart backend/desktop sau khi pull  
2. So `goc` vs `binh` → KHÔNG ĐẠT, ≥1 lỗi  
3. So cùng một file hai lần → ĐẠT, 0 lỗi  
4. Proof cuối: **NORMAL hoặc STRICT + 300 DPI**  
