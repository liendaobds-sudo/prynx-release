# Preflight Test Fixtures

Bộ PDF chuẩn + golden tests + checklist QA manual.

## Quick start (một lệnh)

```powershell
cd D:\pdfcompare\backend
.\scripts\run_preflight_qa.ps1
```

Linux / CI:

```bash
cd backend && bash scripts/run_preflight_qa.sh
```

**Tự động trên GitHub:** job `Preflight QA` trong `.github/workflows/ci.yml` chạy mỗi khi push/PR lên `main`.

## Files

| Path | Mô tả |
|------|--------|
| `pdfs/` | 17 file PDF sinh tự động |
| `expected_rules.json` | Kỳ vọng `must_have` / `must_not_have` mỗi fixture |
| `generate_fixtures.py` | Script sinh lại PDF + manifest |
| `QA_CHECKLIST.md` | Checklist QA manual đầy đủ |
| `manual_samples/` | Đặt file PDF thật từ khách (không commit nếu nhạy cảm) |

## Lưu ý

- `17_tac_heavy_cmyk.pdf` — skip nếu thiếu Ghostscript
- `14_progressive_jpeg.pdf` — manual QA; unit test SOF2 trong `test_preflight_engine.py`
- XMP Illustrator linked — chỉ QA bằng file `.ai`/PDF thật (xem `QA_CHECKLIST.md` mục C3)