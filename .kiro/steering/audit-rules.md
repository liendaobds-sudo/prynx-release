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

## 6. Lỗi HÌNH HỌC / TOẠ ĐỘ / PARITY (preview ≡ output) — bài học đắt giá

Đây là nhóm lỗi tốn NHIỀU lượt nhất vì dễ "tự chứng minh là đúng" bằng công thức
sai. Quy tắc bắt buộc khi đụng layout/bình/nesting/render/preview:

1. **XÁC MINH QUY ƯỚC TRỤC bằng THỰC NGHIỆM, không suy từ công thức.** Trước khi
   so 2 biểu diễn (preview vs output, A vs B), phải biết chắc mỗi bên dùng:
   - gốc toạ độ ở đâu (đỉnh-trái hay đáy-trái), y tăng lên hay xuống (top-down vs
     bottom-up), đơn vị (mm/point/px).
   - Cách XÁC MINH: render thật rồi **raster hoá** (vd pypdfium2) và đo "ô có toạ
     độ nhỏ nằm TRÊN hay DƯỚI". KHÔNG được giả định `y` là bottom-up rồi tính
     `sheet_h - (y+h)` để "chứng minh khớp" — chính giả định đó từng che mất việc
     output bị **lật dọc** suốt nhiều lượt.
   > Bài học: `build_cnc_front_layout` tính `original_cell_y` kiểu bottom-up,
   > nhưng `show_pdf_page` đọc Rect theo TOP-DOWN → output lật dọc so với preview.
   > Chỉ lộ ra khi raster hoá và đo vị trí thật.

2. **So bằng ARTIFACT THẬT, không chỉ bằng data trung gian.** "Dữ liệu khớp"
   (cùng số ô, cùng toạ độ trong log) KHÁC "hình khớp". Với lỗi thị giác, phải
   render output (PDF→ảnh) và đối chiếu trực tiếp; phân biệt **vị trí** (layout)
   với **loại hình** (preview vẽ hình schematic đã phân loại, output vẽ artwork
   thật — phân loại sai sẽ khác hình nhưng vị trí vẫn đúng).

3. **PARITY là ĐA TRỤC — phải khớp ĐỒNG THỜI:** (a) cùng INPUT (giá trị **và**
   thứ tự phép tính float), (b) cùng THUẬT TOÁN, (c) cùng QUY ƯỚC TOẠ ĐỘ,
   (d) cùng cách RENDER (frontend vẽ vs backend xuất). Sửa 1 trục có thể **lộ ra**
   sai ở trục kế. KHÔNG tuyên bố "đã khớp" cho tới khi xác minh end-to-end trên
   artifact thật.

4. **Float order-of-operations có thể LẬT quyết định rời rạc.** `(a-b)*k` và
   `a*k - b*k` lệch ~1e-13, đủ làm bin-packing "vừa/không vừa" thêm 1 ô → preview
   (frontend tính kiểu này) ≠ output (backend tính kiểu kia). Khi 2 đường tính
   cùng một đại lượng theo thứ tự khác nhau → **làm tròn/snap** ở biên (vd round
   6 chữ số) để triệt nhiễu.

5. **Nhánh điều kiện = bẫy regression.** Thêm nhánh đổi hành vi theo điều kiện
   (vd "có boong thì KHÔNG căn giữa") dễ làm 1 chế độ lệch chế độ kia. Ưu tiên
   MỘT đường nhất quán; nếu buộc phải có special-case, phải chứng minh nó giữ
   đúng bất biến của đường chung (vị trí, căn giữa, đối xứng).

6. **Mirror/lật 2 mặt = PHẢN CHIẾU, không phải XOAY.** Mặt sau duplex là ảnh
   phản chiếu quanh trục/tâm; dùng toggle xoay 180°/90° để "giả lập" sẽ sai với
   hình bất đối xứng. Phản chiếu phải quanh đúng tâm (tâm TỜ, không phải tâm rect
   trang nguồn — nếu trim lệch tâm sẽ bị dịch).

---

## 7. Khi QUAN SÁT của user mâu thuẫn với phân tích của mình

- Nếu user **lặp lại** "vẫn lỗi / vẫn lệch" trong khi mình "đã chứng minh khớp"
  → **giả định của mình gần như chắc chắn sai**, KHÔNG phải user nhìn nhầm.
  Dừng lặp lại lập luận cũ; **đổi phương pháp**: render artifact thật, raster,
  đo lại từ gốc. (Phản pattern: bám "log nói khớp" rồi bảo user nhìn kỹ lại.)
- Khi user chỉ vào một chi tiết cụ thể (vd "3 ô trên cùng lại nằm dưới"), DÙNG
  ngay chi tiết đó làm mốc kiểm chứng — nó là ground truth nhanh nhất.
- Nếu một hướng đã thất bại 2 lần, chẩn đoán lại ROOT CAUSE từ đầu (đo thực
  nghiệm), đừng vá tiếp lớp ngọn.

---

## 8. Instrument tại ĐƯỜNG CHẠY THẬT, không chỉ replicate

- Replicate hàm lõi in-process rồi thấy "khớp" có thể đánh lừa, vì đường thật
  còn qua tầng render/đổi toạ độ khác. Hãy **chèn log/đo tại đúng sink thật**
  (vd ghi placements thực render ra file để đối chiếu) thay vì chỉ gọi lại hàm
  con với input mình tự dựng.
- Khi cần debug lâu: ghi 1 file log gọn ra nơi dễ lấy (vd Desktop) chứa cả 2 phía
  (preview + output) + toạ độ từng phần tử → so trực tiếp. Gỡ sạch sau khi xong.

---

## 9. Kỷ luật logging (ảnh hưởng hiệu năng + nhiễu audit)

- Log debug/trace PHẢI dùng `logger.debug`, KHÔNG dùng `warning/error/info`.
  Log mức `warning`/`error` luôn xuất → flood console + tốn I/O mỗi item/candidate
  → kéo chậm rõ rệt ở vòng lặp nóng (nesting/collision/NFP).
- Vòng lặp in nhiều phần tử → guard bằng `if logger.isEnabledFor(logging.DEBUG)`
  để khỏi format f-string khi không cần.
- Khi audit hiệu năng: rà các log mức cao nằm trong vòng lặp nóng — đó thường là
  thủ phạm chậm dễ sửa.

---

## 10. So sánh "nhanh hơn / dày hơn" giữa 2 luồng tương tự

- Khi 2 tính năng làm việc giống nhau nhưng khác tốc độ/chất lượng rõ rệt → tìm
  xem chúng dùng **thuật toán khác nhau** không (vd bin-pack chữ nhật bbox vs
  nesting NFP đa giác). Đo bằng số thật (đếm item, %lãi) trên cùng dữ liệu, đừng
  kết luận "nesting không chạy" chỉ vì cảm giác — có thể lợi ích bị **pha loãng**
  bởi tầng khác (vd chia dải/zone) chứ thuật toán vẫn đúng.

---

## 11. Checklist tự kiểm trước khi gửi báo cáo

- [ ] Mỗi finding đều có `[VERIFIED]`/`[SUSPECTED]` rõ ràng.
- [ ] Mỗi nhãn 🔴/🟠 đều kèm bằng chứng code (file:line) + đã trace tới sink.
- [ ] Đã phân giải hết re-export/wrapper liên quan.
- [ ] Đã phân biệt live vs dead code.
- [ ] Claim về deps/môi trường đã chạy bằng venv của dự án.
- [ ] Đề xuất xóa đã nêu tracked/untracked + mức khôi phục.
- [ ] Không có nhãn nghiêm trọng nào chỉ dựa trên suy đoán bề mặt.
- [ ] (Layout/hình học) Đã xác minh QUY ƯỚC TOẠ ĐỘ bằng raster thực nghiệm, không
      bằng công thức giả định.
- [ ] (Parity) Đã so trên ARTIFACT THẬT (render/raster), khớp đủ 4 trục: input +
      thuật toán + toạ độ + render.
- [ ] (Float) Đã cân nhắc nhiễu order-of-operations ở quyết định rời rạc/biên.
- [ ] Quan sát của user không bị bác bằng "log nói khớp" — nếu mâu thuẫn đã đo lại.

---

## 12. Production Readiness (audit go/no-go cho cả dự án)

> Mục 0–11 dùng cho audit correctness một tính năng. Mục này dùng khi câu hỏi là
> "dự án đã SẴN SÀNG PHÁT HÀNH chưa?". Vẫn áp dụng verify-to-ground-truth: mọi
> nhãn 🔴/🟠 phải có bằng chứng (file:line / kết quả lệnh), tách
> `[VERIFIED]`/`[SUSPECTED]`. Một mục "đạt" chỉ khi đã CHỨNG MINH, không phải
> "thấy có vẻ ổn".

### 12.1 Secrets & Config
- Quét bí mật bị commit: `git ls-files | grep -iE '\.env$|secret|key|token|\.pem'`.
  `.env` thật **không được** tracked; chỉ `.env.example` (toàn placeholder) được phép.
  Nếu secret đã từng vào lịch sử → coi như **đã lộ**, phải xoay vòng key, không chỉ xoá file.
- Mọi config production phải đến từ biến môi trường / file ngoài repo, không hardcode.
- Phân biệt giá trị dev-default vs production-required; thiếu biến bắt buộc phải fail-fast khi khởi động.

### 12.2 Dependencies & Supply Chain
- Có lockfile và được commit? (`requirements.txt`/pinned, `package-lock.json`,
  `Cargo.lock`, `poetry.lock`). Version thả nổi (`>=`, `*`) trên đường production = 🟠.
- Quét lỗ hổng: `pip-audit`/`npm audit`/`cargo audit` nếu có; báo CVE mức cao.
- Tàn dư thư viện đã bỏ (vd `fitz`/PyMuPDF) còn sót trong deps/`.pyc` (đã có ở mục 3).

### 12.3 Build / Release / Anticrack
- Build production tái lập được từ script sạch (`build_production.ps1`,
  `release_update.ps1`) — không phụ thuộc trạng thái máy dev.
- Cơ chế license/anticrack (xem `HYBRID_ANTICRACK_REPORT.md`,
  `SECURITY_ARCHITECTURE.md`) phải được xác minh **chạy thật**, không chỉ tồn tại
  trên giấy: thử bypass đường tắt rõ ràng, kiểm tra fail-closed (lỗi check → CẤM, không cho qua).
- Artifact gửi khách (`DONG_GOI_GUI_KHACH.bat`) không kèm source nhạy cảm / secret / file tạm.

### 12.4 Error Handling & Observability
- Lỗi trên đường chạy thật được bắt và báo có ý nghĩa, không nuốt im (`except: pass`)
  cũng không lộ stacktrace/đường dẫn nội bộ ra người dùng cuối.
- Có nơi ghi log lỗi production (file/sink) để chẩn đoán sau sự cố.
- Tài nguyên (file handle, temp, process con) được giải phóng trên cả nhánh lỗi.

### 12.5 Tests & CI
- Test có chạy được bằng venv dự án và **đang xanh** (`pytest`, `npm run typecheck/build`,
  `cargo test`). Kết quả thật, dán output — không tự nhận "có test là đủ".
- CI (`.github/`) có chặn merge khi fail không, hay chỉ trang trí.
- Chỉ ra vùng lõi (imposition/parity/license) thiếu test hồi quy.

### 12.6 Data Safety
- Ghi đè / xoá dữ liệu người dùng có atomic + có đường khôi phục không.
- Xử lý input độc/ca biên đã nêu ở mục 2 (file 0 byte, unicode, đa trang, file lớn).

### 12.7 Kết luận GO / NO-GO
Chấm theo từng nhóm 12.1–12.6: **PASS / WARN / FAIL** kèm bằng chứng. Quy ước:
- **NO-GO** nếu có bất kỳ 🔴 nào: secret đã lộ, anticrack fail-open, mất/hỏng dữ liệu,
  crash trên đường chạy chính, build không tái lập được.
- **GO có điều kiện** nếu chỉ còn 🟠: liệt kê việc phải làm + mức rủi ro nếu ship luôn.
- **GO** nếu mọi nhóm PASS và test lõi xanh.
> Không được tuyên bố GO chỉ vì "không thấy lỗi" — phải đã CHỦ ĐỘNG kiểm từng nhóm trên.
