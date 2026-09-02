# Fuzz parser file không tin cậy — hướng dẫn vận hành

> Nguồn: pentest 2026-08-28 §ATK.04. Công cụ: `scripts/fuzz_parsers.py`.

## Vì sao cần

Sidecar PrynX mở file do khách đưa vào bằng ba thư viện C/C++ lớn:

| Thư viện | Đường vào | Chạy ở đâu |
|---|---|---|
| PDFium (qua `pypdfium2` / `pdfcompare_native`) | render, metadata, preview | **in-process** trong sidecar |
| qpdf (qua `pikepdf`) | `/upload` validate, preflight, mọi thao tác PDF | **in-process** |
| Pillow codec | ảnh upload, tách nền, upscale | **in-process** |

An toàn bộ nhớ **nội tại** của chúng không thể kết luận bằng đọc source. Đọc code chỉ
chứng minh được tầng Rust/Python của PrynX không có `unsafe` và không tự tính bound —
phần còn lại phải fuzz mới lộ. Một lỗi bộ nhớ ở đây nghĩa là "khách mở một PDF" có thể
thành crash sidecar, xấu nhất là chạy mã.

Đã giảm rủi ro bằng cách nâng parser lên bản có vá (xem `BAO_CAO_PENTEST_ATTACKER_2026-08-28.md`
§ATK.04). Fuzz là lớp còn lại: tìm lỗi **chưa ai vá**.

## Chạy

Từ thư mục `backend` (để dùng đúng venv):

```powershell
# Lượt nhanh (kiểm công cụ còn sống): ~10 giây
venv\Scripts\python.exe ..\scripts\fuzz_parsers.py --iterations 12

# Lượt thường, chạy theo lịch (vài phút)
venv\Scripts\python.exe ..\scripts\fuzz_parsers.py --iterations 500

# Lượt dài (qua đêm)
venv\Scripts\python.exe ..\scripts\fuzz_parsers.py --iterations 20000 --timeout 30

# Chỉ một parser
venv\Scripts\python.exe ..\scripts\fuzz_parsers.py --target qpdf

# Tái lập đúng một lượt đã chạy (lấy seed từ dòng đầu output)
venv\Scripts\python.exe ..\scripts\fuzz_parsers.py --seed 4242

# Dùng file thật của khách làm mẫu gốc (hiệu quả hơn mẫu tự sinh)
venv\Scripts\python.exe ..\scripts\fuzz_parsers.py --corpus D:\mau_pdf_that
```

**Khuyến nghị nhịp chạy:** một lượt `--iterations 500` sau mỗi lần nâng parser
(pypdfium2 / pikepdf / Pillow), và một lượt dài định kỳ (ví dụ mỗi tháng) với seed mới.
Truyền `--corpus` trỏ vào bộ PDF thật của nhà in cho kết quả sát thực tế hơn nhiều so
với mẫu tối giản tự sinh.

## Đọc kết quả

Script phân loại từng ca theo mã thoát của **process con**:

| Nhóm | Nghĩa | Có phải phát hiện? |
|---|---|---|
| `parse thành công` | parser đọc được file đã đột biến | Không |
| `từ chối sạch` | parser raise lỗi (PdfError, UnidentifiedImageError…) | **Không** — đây là hành vi ĐÚNG với file rác |
| `SẬP` | process con chết bất thường (ví dụ `0xC0000409`, access violation) | **CÓ** |
| `TREO` | vượt `--timeout` | **CÓ** (DoS tiềm năng) |

Mọi ca SẬP/TREO được lưu vào `tmp/fuzz_findings/` kèm file `.json` mô tả (seed, target,
mã thoát, đuôi stderr) để tái lập.

`exit code` của script: `0` = không phát hiện, `1` = có phát hiện. **Không dùng làm cổng
chặn build** — đây là công cụ điều tra.

## Khi có phát hiện

1. **Kiểm phiên bản trước tiên.** Parser đã ở bản mới nhất chưa? Rất nhiều ca là lỗi đã
   được vá ở thượng nguồn.
2. **Thu nhỏ ca tái lập** (bỏ dần byte cho tới khi vẫn còn sập) để có mẫu nhỏ nhất.
3. **Báo lên thượng nguồn** (`pypdfium2-team/pypdfium2`, `pikepdf/pikepdf`, `python-pillow/Pillow`).
   Không đăng công khai mẫu khai thác được nếu nó ảnh hưởng người dùng khác — theo kênh
   bảo mật của dự án đó.
4. **Nếu chưa có bản vá:** cân nhắc cách ly process cho đúng đường parse đó, hoặc chặn
   sớm dạng file gây lỗi ở tầng validate.

## Giới hạn phải nhớ

- **Không phát hiện ≠ an toàn.** Chỉ nghĩa là lượt fuzz đó chưa chạm tới lỗi. Đây là fuzz
  ngẫu nhiên có đột biến, **không có coverage feedback** (không phải libFuzzer/AFL++), nên
  hiệu quả thấp hơn fuzz chuyên dụng.
- Muốn nghiêm túc hơn: fuzz thượng nguồn bằng ASAN + libFuzzer trên chính binary PDFium/qpdf.
  Việc đó tốn hạ tầng và nằm ngoài phạm vi harness này.
- Harness chạy trên **build hiện tại của venv**, tức đúng thứ PrynX đang ship. Đổi phiên bản
  parser thì nên chạy lại.

## Tự kiểm công cụ

Harness vô dụng nếu nó không phát hiện được gì mà vẫn báo xanh. Cách kiểm nhanh: thay tạm
`_CHILD_SOURCE` bằng `import os; os.abort()` rồi chạy một ca — phải thấy `[SẬP]` và có file
lưu trong `--outdir`. Lần kiểm ngày 2026-08-28 đạt cả bốn phân loại (sập / treo / từ chối
sạch / parse OK).
