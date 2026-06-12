---
inclusion: manual
---

# Quy tắc Audit / Review (BẮT BUỘC)

> Kích hoạt file này bằng `#audit-rules` mỗi khi được yêu cầu "audit", "review",
> "đánh giá", "rà soát" một tính năng hoặc một vùng code.
>
> Mục tiêu: KHÔNG được kết luận sơ sài. Mọi nhận định phải truy đến tận cùng
> (verify-to-ground-truth) trước khi gắn mức độ nghiêm trọng.

---

## 0. Nguyên tắc cốt lõi

1. **Không suy đoán từ bề mặt.** Một dòng `import`, một tên hàm, một docstring
   KHÔNG đủ để kết luận hành vi. Phải đọc tới phần thân thực thi.
2. **Không gắn severity trước khi xác minh.** Cấm dùng nhãn 🔴/🟠/Nghiêm trọng
   cho tới khi đã chứng minh bằng code thật (đường chạy + thân hàm + dữ liệu).
3. **Tách bạch "đã xác minh" và "nghi ngờ".** Mỗi finding phải ghi rõ
   `[VERIFIED]` (đã đọc/chạy chứng minh) hay `[SUSPECTED]` (mới thấy dấu hiệu).
4. **Sai thì sửa ngay, không phòng thủ.** Nếu user hoặc bằng chứng mới phủ nhận
   một finding, rút lại công khai và ghi lý do.

---

## 1. Trace-to-ground-truth (quy trình bắt buộc)

Trước khi nói "X gây ra Y" hoặc "đường chạy là Z", phải đi HẾT chuỗi:

1. **Tìm entry point thật:** HTTP route / CLI / event handler / nút bấm UI.
2. **Lần theo từng mắt xích** tới nơi thực sự làm việc (sink): entry → handler →
   service → worker → hàm lõi. Ghi lại số dòng từng bước.
3. **Phân giải re-export / wrapper / alias ĐẾN CÙNG.** Khi gặp
   `from .x import f`, mở `x` ra xem `f` là bản gốc hay lại re-export tiếp.
   Module tên `*_old`, `*_pkg`, `thin wrapper`, `__init__ re-export` đặc biệt
   dễ đánh lừa.
4. **Xác nhận live vs dead:** một file/hàm chỉ "đáng lo" nếu nằm trên đường chạy
   thực. Kiểm tra: ai import nó? Đường chạy từ entry point có chạm tới không?
   File trong `sandbox/`, `old_*`, `*.bak`, file gitignored, file untracked rác
   thường là CHẾT — không tính là lỗi production.
5. Chỉ khi đã nối được entry → sink mới được phát biểu về hành vi/ảnh hưởng.

> Bài học thực tế: từng kết luận "preview ≠ output do khác solver" chỉ vì 2 file
> import khác alias — nhưng cả hai cùng re-export về một `orchestrator` (Rust).
> Lẽ ra phải mở file wrapper ra trước. ĐỪNG lặp lại.

---

## 2. Xác minh bằng thực thi (khi có thể)

- **Dùng đúng môi trường chạy** của dự án (vd `backend/venv/Scripts/python.exe`),
  KHÔNG dùng python global → kết quả import/deps sẽ sai lệch.
- Reproduce lỗi/crash bằng harness nhỏ với nhiều tổ hợp tham số + ca biên
  (rỗng, 0 byte, không contour, file lớn, unicode, đa trang).
- Build/typecheck/test thật: backend (`pytest`, import smoke test),
  frontend (`npm run typecheck`, `npm run build`).
- Dọn sạch file tạm/harness sau khi xong.

---

## 3. Phân biệt code sống / chết / trùng lặp

- Trùng lặp: nếu thấy 2 hàm cùng tên/cùng docstring, **diff chúng** (Compare-Object)
  rồi xác định khác biệt thực chất (bỏ qua dòng trống/format). Nói rõ là
  "trùng lặp gây rủi ro bảo trì" KHÁC với "gây sai kết quả" — chỉ gọi là bug
  correctness khi chứng minh được hai bên cho kết quả khác nhau trên đường chạy.
- Orphan `.pyc` (còn `__pycache__/x.cpython-*.pyc` nhưng mất `x.py`) → tàn dư,
  liệt kê để dọn.
- Dấu vết thư viện cũ (vd `fitz`/PyMuPDF, shim): tìm cả ở source, `.pyc`,
  requirements, và file sandbox/test.

---

## 4. An toàn khi đề xuất xóa / sửa

- Trước khi xóa: phân loại **tracked vs untracked** (`git ls-files`).
  - Tracked → khôi phục được bằng `git checkout` (rủi ro thấp).
  - Untracked + gitignored → **mất vĩnh viễn**, phải cảnh báo rõ và confirm.
- Xóa hàng loạt / blast radius rộng → liệt kê danh sách + confirm trước.
- Sửa nhạy cảm về kết quả (thuật toán layout, solver, parity) → trình bày diff
  dự kiến và xin xác nhận hướng trước khi áp dụng.

---

## 5. Định dạng báo cáo audit

```
## Kiến trúc / Đường chạy (đã trace)
<entry point> → ... → <sink>   (kèm file:line từng mắt xích)

## Phát hiện
[VERIFIED] 🔴/🟠/🟢 <mô tả> — bằng chứng: <file:line + cách đã chứng minh>
[SUSPECTED] <mô tả> — dấu hiệu: <...>; cần kiểm tra thêm: <...>

## Rút lại (nếu có)
<finding cũ> — lý do sai: <...>

## Đề xuất (ưu tiên + mức rủi ro)
```

Quy ước mức độ (chỉ gắn sau khi `[VERIFIED]`):
- 🔴 lỗi correctness / crash / mất dữ liệu trên đường chạy thật.
- 🟠 rủi ro bảo trì / hiệu năng / rác / nợ kỹ thuật.
- 🟢 nhận xét nhỏ, gợi ý cải thiện.

---

## 6. Checklist tự kiểm trước khi gửi báo cáo

- [ ] Mỗi finding đều có `[VERIFIED]`/`[SUSPECTED]` rõ ràng.
- [ ] Mỗi nhãn 🔴/🟠 đều kèm bằng chứng code (file:line) + đã trace tới sink.
- [ ] Đã phân giải hết re-export/wrapper liên quan.
- [ ] Đã phân biệt live vs dead code.
- [ ] Claim về deps/môi trường đã chạy bằng venv của dự án.
- [ ] Đề xuất xóa đã nêu tracked/untracked + mức khôi phục.
- [ ] Không có nhãn nghiêm trọng nào chỉ dựa trên suy đoán bề mặt.
