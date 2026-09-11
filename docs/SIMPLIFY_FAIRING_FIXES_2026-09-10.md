# Nâng cấp Simplify neo tự do và độ cong — 2026-09-10

Người dùng duyệt triển khai sau prototype và chấp nhận thử dung sai bổ sung
tối đa **0,10 mm** để cải thiện đường gia công. Nâng cấp đã nối source/backend/
UI và có PDF thật; **chưa chạy GUI Tauri, chưa đóng gói installer, chưa thử dao**.
Không coi kết quả này là chứng minh hơn Illustrator.

## Kết quả trên đúng file mẫu

`D:/pdfcompare/test/Binder2.pdf`, trang 12, bù 2 mm, denoise 30, mode original,
giữ góc, bỏ nền trắng, auto_safe/adaptive. SHA256 nguồn vẫn là
`4c2a730ba4f0857847b46faf2e798f78c001f1615a8cd946686bcc53aa508c10`.

| Đại lượng | Tắt Simplify | Simplify 0,10 mm |
|---|---:|---:|
| Neo CUT trang 12 | 122 | **64** |
| P95 bước nhảy độ cong /mm | 21,0450 | **0,73155** |
| Bước nhảy độ cong lớn nhất /mm | 37,6236 | **1,00052** |
| Độ cong cực đại /mm | 59,4553 | **31,607** |
| Tổng neo 13 trang, cùng bù 2 mm | 829 | **521** |

- Trang 12: sai lệch hai chiều đo **0,08360354 mm**, cận độc lập sau PDF
  **0,08870350 mm**. Main đọc lại PDF bằng sampler khác và khớp số đo.
- Tất cả 13 trang qua kiểm band/góc/topology sau xuất; cận độc lập lớn nhất
  **0,09922503 mm ở trang 5**. Bốn trang gần ngưỡng được tinh chỉnh phép đo
  từ chord 0,01 xuống 0,001 mm; không nới tolerance. JSON giữ cả cận thô bị
  từ chối và cận tinh đạt để không đánh tráo chứng cứ.
- CUT trang 12 trong file đủ 13 trang trùng hash với PDF xuất riêng.
- Pixel artwork và phép đặt ảnh giữ nguyên. Trang 8 có MediaBox/CropBox mở
  rộng về trái **0,01963984 mm** theo bbox đường mới; không tuyên bố khổ mọi
  trang bất biến. Các trang 1/13 chưa giảm node, giữ nguồn khi cần.
- Thời gian một lượt đo: trang 12 xuất trực tiếp 19,83 giây; toàn 13 trang
  68,62 giây. Đây không phải benchmark UI realtime hoặc tốc độ dao.

## Các lô đã triển khai và kiểm

### A — lõi, 5 file

- `cutline_fair_seed.py`: seed thuần NumPy từ toàn cubic, không lấy riêng
  neo và không phụ thuộc DLL/thư mục nghiên cứu. Thử 1,1×/1×/1,25× theo thứ
  tự; dung sai seed không được dùng làm dung sai chấp nhận.
- `cutline_fair_simplify.py`: tối ưu vị trí neo, góc tiếp tuyến và hai độ dài
  handle; khóa vị trí và hai hướng tại góc mạnh/cusp hoặc góc nông cô lập.
  Penalty bước nhảy độ cong, cập nhật correspondence hai chiều.
- `cutline_fair_verify.py`: cận Hausdorff từ hull/flatten/Lipschitz; kiểm kín,
  winding và giao cắt liên tục bằng chia cubic/control hull. Kiểm độc lập
  cả vị trí, hai hướng và thứ tự cyclic của góc khóa. Độ cong cực trị được
  tìm qua nghiệm đa thức, không chỉ lấy mẫu thưa.
- Hai file test seed/guard. Lõi có **53 test đạt** ở chốt lô.

Nguồn bất biến; lỗi import/solver/số học trả nguồn cho nhánh bảo toàn. Dung
sai dưới bước UI 0,005 mm không chạy tái dựng tự do mà dùng nhánh gộp cũ;
không nới dung sai yêu cầu. Không thêm cap worker/RAM/chất lượng theo số neo.

### B — worker/canonical, 5 file

`cutline_cubic_simplify.py`, `sticker_engine.py`, `sticker_cutline_preview.py`,
`sticker_sheet_export.py`, test cubic:

- Trần chung 0,10 mm; thử fairing rồi fallback B4/B3 khi không chứng minh được.
  C2/chuỗi line không có bước nhảy độ cong tiếp tục đi nhánh bảo toàn.
- Đổi pt↔mm, phục hồi chính xác tọa độ góc, kiểm toàn nhóm/lỗ rồi **kiểm lại
  sau đúng translate/flip/.4f của writer**. Stats fairing lấy cận sau writer,
  không lấy residual của solver. Góc sau lượng tử dùng slack suy từ sai số
  control point, không nới góc tùy ý.
- Cache/fingerprint Simplify dương có salt `free-g1-v1`; giá trị 0 giữ hash
  legacy. Cache thuật toán cũ không thể xuất qua canonical chỉ vì fingerprint
  còn trùng. Thử file/page đổi, góc bị xóa, giao ring bên cạnh và lỗ ra ngoài
  exterior đều được kiểm fail-closed.
- Chốt lô: **80 test core+cubic**, cộng **27 test worker/canonical chọn lọc**.

### C — API/policy, 5 file

Ba schema preview/page-export/document-export và route multipart nhận 0–0,10;
policy TS đồng bộ, vẫn mặc định 0. JSON/worker từ chối ngoài khoảng; multipart
giữ hành vi clamp số hữu hạn đã có. Test explicit zero của trang, thừa kế,
recipe cũ và phiên bản cache: **65 backend + 18 policy test đạt**.

### D — slider và phản hồi muộn, 5 file

Slider thật lấy max từ policy; step 0,005 mm, mặc định tắt. UI→preview→Thực
thi/recipe truyền cùng mức 0,10. Phản hồi 0,05 trả muộn không thay được mức
0,10 hay mở khóa xuất sớm. VI/EN giải thích giảm neo + gợn độ cong và sai lệch
bổ sung. Chốt ban đầu: **91 Vitest + typecheck đạt**.

### E — trang PDF Alpha nhiều mảng, 5 file

Phát hiện từ nghiệm thu thật: **trang 12 không hỗ trợ canonical preview
classic một-vùng**. Manifest có nhiều instance, hook cũ từ chối và snapshot
backend cũng từ chối. Không bỏ chốt đó, không ép gộp Alpha, không lấy preview
tách từng mảng làm preview toàn thiết kế.

Thêm `directSimplifyOnly` chỉ cho PDF Alpha nhiều mảng đã nhận diện, loại
trang có CutContour sẵn. Đóng session nhận diện, không giữ SVG/canonical;
cho phép chọn Simplify rồi áp trên toàn trang khi **Thực thi**. UI cảnh báo
rõ chưa có preview chung. Lỗi nhận diện, nguồn khác, trang/file/instance đổi
hoặc phản hồi cũ không thể giữ quyền này. Nhánh một-vùng vẫn chờ canonical.

**Giới hạn còn thật:** không có parity preview↔export trang 12 vì preview
này chưa được hỗ trợ. `direct_canonical_cut_identical=null` trong evidence.
UI không giả mạo reference để đi qua snapshot guard. Chốt lô: **104 Vitest
+ typecheck đạt**.

### F — kiểm UI đúng trang 12 và chuẩn bị đóng gói

- UI regression dựng PDF 13 trang, trang 12 có sáu vùng Alpha: slider bật,
  0,10 mm tới Thực thi, không gọi preview tách vùng, không gửi canonical giả.
- `build_production.ps1` kiểm import/chạy solver nhỏ trước Nuitka và include
  rõ `scipy.optimize/spatial/sparse`. SciPy 1.12 đã là dependency sản phẩm;
  không cài thư viện mới. Chỉ parse PowerShell và chạy dependency smoke,
  **không chạy build**.

## Verify cuối

- **174 pytest đạt**: seed, verifier, cubic, global, polyline và contract.
- **105 Vitest đạt / 5 file**, Windows typecheck đạt.
- PowerShell parser, dependency solver smoke và các py_compile/diff-check đạt.
- PDF đọc lại bằng pikepdf; kiểm CTM/đơn vị/góc/sai lệch, render Poppler và
  soi trang 12 + contact sheet đủ 13 trang. Hash nguồn kiểm lại không đổi.
- Hai warning backend có sẵn: Pydantic class Config và Starlette/httpx.
- Không cập nhật golden, commit, build installer, chạy GUI hay kiểm máy bế.
  Không suy từ test hoặc PDF thành chứng nhận động lực học máy.

## Cách dùng và bằng chứng

Trong **Bù xén tạo đường cắt → Đơn giản hóa thêm (Simplify)**, chọn mức tới
0,10 mm. Trang một vùng chờ preview mới trước Thực thi. Trang nhiều mảng
Alpha như trang 12 hiển thị cảnh báo và áp khi Thực thi; xem PDF kết quả.
Đưa slider về 0 để giữ đường cơ sở. Bản cài sẵn không tự cập nhật từ source.

- [PDF đủ 13 trang](D:/pdfcompare/output/pdf/Binder2-fair-upgrade-2026-09-10/Binder2_all_pages_simplify_010mm.pdf).
- [PDF riêng trang 12](D:/pdfcompare/output/pdf/Binder2-fair-upgrade-2026-09-10/Binder2_page12_offset2_direct010.pdf).
- [Evidence JSON](D:/pdfcompare/output/pdf/Binder2-fair-upgrade-2026-09-10/evidence.json).
- [Đối chiếu neo từ PDF thật](D:/pdfcompare/output/pdf/Binder2-fair-upgrade-2026-09-10/Binder2_page12_nodes_before_after.png).
- Harness tái lập: `D:/pdfcompare/tmp/pdfs/fair-production-20260910/run_artifacts.py`.
  Không ghi đè artifact có sẵn; chọn `--directory` mới hoặc dùng `--resume`
  theo script. Canonical trang 12 được ghi là chưa hỗ trợ, không thay bằng trang khác.
- Nghiên cứu nền: [báo cáo](D:/pdfcompare/docs/BAO_CAO_AUDIT_SIMPLIFY_FAIRING_2026-09-10.md).

Mức bằng chứng: `AUTO + ARTIFACT` cho xuất trực tiếp; `AUTO` cho đường UI
direct-only và hợp đồng canonical một-vùng; chưa `RUNTIME` GUI/installer/dao.
