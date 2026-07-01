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
- [ ] Với "bug truyền sai tham số / sai giá trị": đã xác minh có CONSUMER trên
      đường live ĐỌC giá trị đó (giá trị sinh ra nhưng không ai đọc = moot, hạ severity).
- [ ] Trước khi nói "test/lệnh không chạy được / thiếu dep": đã thử bằng venv
      dự án (`backend\venv\Scripts\python.exe`) — không kết luận từ python global.
- [ ] Đã làm lượt sâu NGAY từ đầu, không đợi user hỏi lại mới đào kỹ.

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

---

## 13. Bài học phiên audit shape-detection (chống tái phạm CỤ THỂ)

> Ba lỗi thật đã xảy ra; ghi lại để KHÔNG lặp. Đây là cụ thể hoá của §1, §2, §0.

### 13.1 Severity = correctness × REACHABILITY × CONSUMPTION (không chỉ correctness)

Một finding "đúng ở mức code" CHƯA chắc là lỗi production. Phải nhân thêm 2 yếu tố:

- **Reachability:** đoạn code đó có nằm trên đường chạy live không (§1.4)?
- **Consumption:** với lỗi kiểu "gán/truyền SAI một giá trị", phải tìm xem **ai
  ĐỌC** giá trị đó. Nếu giá trị được sinh ra nhưng **không consumer live nào đọc**
  → lỗi là **moot** (P4/cosmetic), KHÔNG phải P0.

> Bài học đắt: đã xếp `effective_body_w_ratio = bigEndAxisFrac` lên **P0** và dẫn
> chứng bằng `NupGridSolver.effectiveW` (TS). Nhưng (a) TS đó là orphan, và (b)
> solver Python LIVE (`asymmetric_layouts.py`) chỉ đọc `waistRatio/bigEndFirst/
> bigEndAxisFrac` — **không hề đọc** `effective_body_w_ratio`. ⟹ thực chất moot.
> Quy tắc: trước khi gắn severity cho "bug truyền tham số", **grep ngược consumer**
> của ĐÚNG key/biến đó trên ĐÚNG engine live, rồi mới chấm điểm.

Hệ quả thao tác: với mỗi finding về dữ liệu/tham số, ghi thêm dòng
`Consumer (live): <file:line đọc giá trị>` hoặc `Consumer: KHÔNG có → moot`.

### 13.2 venv-first là quy tắc CỨNG, không phải gợi ý

- **CẤM** kết luận "thiếu dep / test không chạy được / module not found" khi mới
  chỉ thử bằng `python` toàn cục. Bước 0 trước khi chạy bất kỳ lệnh Python nào:
  tìm interpreter dự án (`backend\venv\Scripts\python.exe`; nếu không có thì
  `where python` + đọc README/run_dev.bat) và DÙNG nó.
- Nếu một lệnh "không chạy được", coi đó là **nghi vấn của chính mình** cần truy
  nguyên (sai interpreter? sai cwd? thiếu PYTHONPATH?), KHÔNG phải kết luận về dự án.

> Bài học: báo "thiếu `hypothesis`, không chạy được PBT" trong khi
> `backend\venv` có sẵn `hypothesis 6.155.3` — chạy lại bằng venv: **13 passed**.

### 13.3 Độ sâu mặc định = SÂU; không đợi bị hỏi "kỹ chưa"

- Lượt audit ĐẦU TIÊN đã phải trace-to-ground-truth (§1) + verify consumer (§13.1)
  + chạy test bằng venv (§13.2). KHÔNG nộp bản nông rồi chờ user phản hồi mới đào.
- Nếu phạm vi quá lớn để làm hết trong một lượt → nói rõ phần nào `[VERIFIED]`,
  phần nào còn `[SUSPECTED]` + kế hoạch verify, thay vì im lặng để lại lỗ hổng.
- Khi đã lỡ kết luận sơ sài: **rút lại công khai** (§0.4) kèm severity đã hiệu
  chỉnh, đừng để trôi.

### 13.4 Quy trình rút gọn cho mọi finding (dán vào báo cáo)
```
[VERIFIED|SUSPECTED] <severity> <mô tả>
  Sink/đường chạy: <entry → ... → file:line>
  Consumer (live): <file:line đọc giá trị>  | hoặc: KHÔNG → moot
  Bằng chứng: <đọc code / lệnh đã chạy bằng venv + kết quả>
```

---

## 14. Bài học phiên Production-Audit (2026-06-26) — chống tái phạm CỤ THỂ

> Bảy lỗ hổng đã xảy ra THẬT trong một phiên audit toàn dự án. Mỗi mục gắn với
> sự kiện thật; đây là cụ thể hoá của §0, §12, §13.

### 14.1 Test ĐỎ ≠ lỗi production
Trước khi gắn severity cho một test fail, PHẢI phân loại nó là:
(a) lỗi correctness production, (b) lỗi **test-harness** (test tự sai), (c) **test-drift /
mock cũ** (production đúng, kỳ vọng test lỗi thời), (d) **flaky / không tất định**.
Cách phân loại = §1 trace-to-ground-truth: đọc xem *code-under-test THỰC SỰ ĐỌC dữ
liệu nào*.
> Bài học: gắn 🔴 "validator bỏ sót lỗ hở" cho test paper_bag fail, NHƯNG validator
> chỉ đọc `model.allPaths` còn test tiêm lỗi vào `panel.paths` (bản sao clip) → no-op.
> Đó là lỗi test-harness, KHÔNG phải lỗi production. Cùng tên test về sau LẠI lộ một
> lỗi production thật (overlap hình học) — nên (a)…(d) không loại trừ nhau.

### 14.2 PBT seed ngẫu nhiên: 1 lần xanh KHÔNG phải bằng chứng
Với property test seed ngẫu nhiên (fast-check/hypothesis không pin seed), một run xanh
chỉ là "may seed", KHÔNG chứng minh pass. Phải chạy NHIỀU lần (hoặc pin seed) mới kết
luận. Ngược lại, một fail **flaky** là TÍN HIỆU lỗi thật phải đào tới cùng — CẤM dập
bằng `-u` (update snapshot) hay nâng tolerance.
> Bài học: overlap paper_bag chỉ fail 2/10 lần → suite "xanh" một lần tạo an toàn giả;
> đào ra lỗi hình học thật (glueVat vượt crease → tab tự cắt & chồng).

### 14.3 Supply-chain: quét MỌI hệ sinh thái; "chưa cài" không phải kết luận
Repo có Rust/npm/pip thì phải chạy ĐỦ `cargo audit` + `npm audit` + `pip-audit`. Thiếu
tool → CÀI rồi chạy (mirror venv-first §13.2), không được kết luận "không quét được".
Dependency khai báo nhưng KHÔNG dùng vẫn mang CVE → grep call-site, nếu 0 thì đề xuất gỡ.
> Bài học: `cargo audit` chưa từng chạy ở các audit trước → bỏ sót `lopdf 0.34` (7.5
> HIGH) và `pyo3` buffer-overflow. lopdf còn là dep KHÔNG dùng (gỡ hẳn được).

### 14.4 Không tin claim subagent / báo cáo cũ — reproduce đúng con số
Mọi kết luận từ sub-agent hoặc báo cáo audit cũ là `[SUSPECTED]` cho tới khi TỰ chạy lại
artifact và xác minh ĐÚNG cặp/số/dòng (không chỉ "kết luận đúng hướng").
> Bài học: subagent báo cặp overlap "glue_flap∩bottom_glue_flap 201mm²" — nhưng cặp đó
> bị `ancestorRelated` loại trừ; cặp gây fail THẬT là `bottom_glue_flap∩lip_glue_flap
> = 0.1333mm²`. Chỉ lộ ra khi tự chạy đúng test.

### 14.5 Audit phải KHÔNG phá môi trường dev của người dùng
CẤM `taskkill` / kill tiến trình node/python, dừng dev server, hay sửa global state mà
người dùng đang chạy. Chỉ chạy verify ở background process riêng; dọn process do CHÍNH
mình tạo, không đụng của người khác.
> Bài học: một subagent kill các tiến trình node "để đo sạch" → tắt luôn Vite dev server
> của user (`ERR_CONNECTION_REFUSED`, dynamic import 3D fail).

### 14.6 Chạy verify CÔ LẬP + đối soát số liệu mâu thuẫn
Chạy suite verify khi KHÔNG có run khác đụng cùng file/snapshot. Nếu 2 lần đo ra số khác
nhau → truy nguyên TRƯỚC khi báo cáo, đừng chọn số đẹp.
> Bài học: vitest lần đầu 703/1, lần sau 698/6 — do process zombie `vitest -u` chạy song
> song làm bẩn snapshot/đo lệch.

### 14.7 Release reproducibility là tiêu chí GO (mở rộng §12.3)
Production-readiness yêu cầu artifact build từ cây ĐÃ COMMIT, sạch:
- `git status` phải sạch — file vá chưa commit = build từ checkout sạch THIẾU vá = 🔴 chặn.
- MỌI lockfile phải tracked (kể cả của crate phụ, vd `imposition_core/Cargo.lock`).
- Build script cho artifact giao khách phải **fail-fast** khi thiếu dep bundle bắt buộc
  (pdfium/Ghostscript…) thay vì chỉ `WARNING` rồi build tiếp (ship artifact hỏng âm thầm).
> Bài học: 146 file (gồm vá bảo mật) chưa commit; `build_production.ps1` chỉ WARNING khi
> thiếu pdfium/Ghostscript.

---

## 15. Bài học phiên Packaging / Release-only (2026-06-30) — chống tái phạm CỤ THỂ

> Bối cảnh: "bản DEV chạy ngon, bản RELEASE (đã đóng gói NSIS) hỏng đủ thứ" — tách
> nền vỡ ảnh, mở PDF crash React #300, 403 sidecar token, không render trang/thumbnail,
> Bình Tem `Failed to fetch`. Tốn RẤT nhiều lượt vì cứ đoán & sửa lớp ngọn. Tất cả là
> lỗi **release-only**: thứ chỉ bật ở bản đóng gói mà DEV bỏ qua. Đây là cụ thể hoá §0,
> §1, §7, §8.

### 15.1 DEV ≠ RELEASE: phải test trên BẢN ĐÃ CÀI, không chỉ `tauri dev`
Mọi lớp hardening/đóng gói sau đây **chỉ chạy ở release** nên DEV không bao giờ lộ lỗi:
- `#[cfg(not(debug_assertions))]`: `SetProcessMitigationPolicy`, integrity check, anti-debug.
- **CSP** trong `tauri.conf.json` (dev nới lỏng/không ép như release).
- Tài nguyên bundle (resource/sidecar) đặt ở vị trí KHÁC dev (working-dir, đường dẫn).
- DevTools bị tắt ở release → KHÔNG có console để xem lỗi.
⟹ Khi user báo "release lỗi mà dev ngon", **CẤM** kết luận từ việc chạy `tauri dev`. Phải
build, cài, chạy bản thật, và đọc lỗi qua **log file** (xem §15.6).

### 15.2 Đọc ĐÚNG mã lỗi theo TỪNG đường dẫn — đừng gộp
`LoadLibraryExW` trả mã khác nhau theo path: **126** = ERROR_MOD_NOT_FOUND (không thấy
file) ≠ **577** = ERROR_INVALID_IMAGE_HASH (file CÓ nhưng bị chính sách chữ ký chặn).
> Bài học đắt: panic log ban đầu chỉ thấy "126" ở path KHÔNG tồn tại → đoán "thiếu
> pdfium.dll", sửa bundle + đường dẫn nhiều lượt vẫn lỗi. Khi log từng path mới thấy path
> CÓ file báo **577** — root cause thật là chính sách chữ ký, không phải thiếu file. Quy
> tắc: log mã lỗi + `exists()` cho TỪNG ứng viên path, đừng kết luận từ dòng panic đầu tiên.

### 15.3 ProcessSignaturePolicy(MicrosoftSignedOnly) chặn MỌI DLL bên thứ 3 không ký
`SetProcessMitigationPolicy(ProcessSignaturePolicy, MicrosoftSignedOnly)` (anti-DLL-inject)
chặn nạp DLL không ký bởi Microsoft → `pdfium.dll` (và mọi native DLL bên thứ 3) bị từ
chối (577) → render chết. DLL đã nạp vào tiến trình thì policy KHÔNG gỡ ra.
⟹ **Warmup nạp các DLL hợp lệ TRƯỚC khi bật policy**; vẫn chặn được DLL lạ inject về sau.
Khi thêm bất kỳ native dep mới (DLL) vào tiến trình chính → phải kiểm lại policy này.

### 15.4 Native DLL: bundle làm resource + định vị bằng đường dẫn TUYỆT ĐỐI
- DLL phải được khai báo trong `bundle.resources` của `tauri.conf.json` (nếu không sẽ KHÔNG
  vào installer dù dev chạy được vì dev đọc từ cây nguồn).
- Định vị bằng **đường dẫn tuyệt đối từ `std::env::current_exe()`** (`<exe_dir>`, `<exe_dir>/bin`),
  KHÔNG dùng path tương đối `"./bin/"` — release có working-dir khác (thư mục cài), path
  tương đối resolve sai.

### 15.5 CSP phải có ĐỦ origin nội bộ Tauri + custom protocol (lỗi release-only kinh điển)
CSP ép ở release sẽ chặn các origin mà DEV cho qua. Phải liệt kê đủ trong từng directive:
- `connect-src`: `ipc:` + `http://ipc.localhost` (**kênh IPC trả binary — invoke trả
  `tauri::ipc::Response` đi qua đây; thiếu → JS nhận rỗng → blob hỏng → `<img>` vỡ ÂM THẦM,
  KHÔNG có CSP error cho chính cái blob**), `http://tauri.localhost`, `asset:`/`http://asset.localhost`
  (fetch file qua `convertFileSrc` — Bình Tem/Imposition/Combine), backend host, Supabase,
  origin kiểm tra internet (`gstatic`, `1.1.1.1`).
- `img-src`: `http://tile.localhost` (custom protocol tile — phải để cả HOST, scheme `tile:`
  không đủ), `blob:`, `data:`, `asset`/`tauri.localhost`.
⟹ Quy tắc: mỗi custom protocol (`tile.localhost`, `asset.localhost`, `ipc.localhost`) là MỘT
origin riêng — phải khai báo tường minh ở ĐÚNG directive (connect-src cho fetch/IPC, img-src
cho ảnh). Khi thêm protocol/handler mới → cập nhật CSP ngay.

### 15.6 Chẩn đoán release KHÔNG console: log ra FILE + dùng đúng tín hiệu
Release không có DevTools → phải tự ghi log file để chẩn đoán:
- Rust: `std::panic::set_hook` → `%APPDATA%\<App>\logs\rust_panic.log` (bắt "Task panicked").
- Frontend: command Rust ghi file + listener `securitypolicyviolation` (cho biết CHÍNH XÁC
  directive + blockedURI bị CSP chặn) + bắt `error` của `<img>`.
- Xác minh artifact: tile JPEG render ra đĩa → đọc **magic header** (`FF D8 FF`) để biết bytes
  hợp lệ → tách bạch "backend render hỏng" vs "frontend hiển thị hỏng".
⟹ KỶ LUẬT: log chẩn đoán là TẠM. **Gỡ sạch trước khi ship** — đặc biệt log ghi đĩa trong
hot-path (mỗi tile/thumbnail) gây chậm rõ rệt (đồng bộ I/O mỗi lần render). (Liên hệ §9.)

### 15.7 KHÔNG `.unwrap()`/`.expect()` trong `spawn_blocking` / hot-path render
Panic trong `spawn_blocking` → Tauri trả lỗi mờ "Task panicked", CHE root cause. Phải trả
`Result` + `?` để lỗi thật (vd "không nạp được pdfium 577") nổi lên log. Khi audit native/
render path: grep `.unwrap()|.expect(` trên đường chạy nóng = nghi vấn che lỗi.

### 15.8 Sidecar mồ côi / khoá file: nhiễu khi cài & chạy lại
- **403 "invalid sidecar token"** có thể do **sidecar phiên cũ còn sống** giữ cổng (vd 8321)
  với token cũ ≠ token phiên mới. Trước khi đào sâu auth: kiểm tra tiến trình mồ côi +
  cổng (`Get-NetTCPConnection -LocalPort`), kill sạch, mở lại app cho spawn sidecar mới.
- **"Error opening file for writing ...dll"** lúc cài = file **đang bị khoá** bởi tiến trình
  đang chạy (app cũ, HOẶC chính lệnh test `LoadLibrary` của mình chưa `FreeLibrary`). Tìm
  tiến trình giữ module (`Get-Process | … $_.Modules.FileName -eq <dll>`), kill, rồi Retry.
- "invalid sidecar token" cũng xuất hiện khi token RỖNG (frontend ký hụt). Phân biệt token
  rỗng vs token sai bằng log phía backend; đừng mặc định là sai cấu hình.
> Lưu ý self-inflicted: lệnh PowerShell `LoadLibrary(pdfium.dll)` để "test load" đã KHOÁ
> file dll → installer không ghi đè được suốt mấy lượt. Test load DLL phải `FreeLibrary`
> hoặc chạy trong tiến trình dùng-một-lần.

### 15.9 React "Minified error #300" ở release = rules-of-hooks (early-return trước hooks)
Crash chỉ ở release vì bản minified mới bung lỗi. Nguyên nhân thường gặp: `return` sớm
(vd `if (loadError) return …`) đặt TRƯỚC các `useState/useEffect/useMemo` → số hooks đổi
giữa các lần render. Sửa: dời MỌI early-return xuống SAU toàn bộ hooks. Khi thấy #300 ở
release → soi component vừa đụng tới, tìm return/điều kiện nằm trên hooks.

### 15.10 File từ Tauri picker có thể là blob RỖNG (size giả) — đọc bytes thật từ path
Object `File` do Tauri tạo có thể `size > 0` nhưng nội dung blob rỗng (đọc `.slice(0,1)` ra
0 byte). Phải đọc bytes thật qua `@tauri-apps/plugin-fs readFile(path)` rồi tạo Blob. Triệu
chứng: ảnh/preview "vỡ" ở release mà dev (file input web thật) lại ổn.
