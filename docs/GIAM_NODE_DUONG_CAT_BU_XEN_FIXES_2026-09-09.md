# Giảm node đường cắt Bù xén - nhật ký triển khai 2026-09-09

> Cập nhật hiện tại: A1 backend, B1 classic và B2 rút gọn polyline đã có source
> + AUTO/ARTIFACT. B1 giảm trang 5 từ 279 line xuống 103 cubic; B2 giảm trang 4
> từ 927 xuống 555 lệnh, đoạn <0,25 mm từ 602 xuống 176, giữ 15 đường bao và
> sai lệch bổ sung dưới 0,02 mm. Chưa có Simplify tổng quát/slider và chưa nghiệm
> thu máy bế vật lý; không tuyên bố mọi đường đã hoàn toàn mượt.

## Phạm vi đã duyệt

Người dùng duyệt bằng yêu cầu “làm đi” sau báo cáo
`BAO_CAO_AUDIT_GIAM_NODE_DUONG_CAT_BU_XEN_2026-09-09.md`.

Thực hiện theo `prynx-audit-workflow`: lô nhỏ, verify riêng và chờ người dùng
xác nhận chạy thật trước lô kế tiếp. Không commit, build hoặc phát hành.

## Lô A1 - backend giữ Khử răng cưa khi xuất (§NODE.1)

**Đã sửa source và verify tự động/artifact; chờ xác nhận chạy thật để sang A2.**

File trong lô: ba file source, một file test và nhật ký này.

- `backend/app/schemas/sticker_sheet.py`: thêm `cutline_denoise` cho export
  toàn tài liệu và theo trang; kiểm miền 0-100, cho phép `None`.
- `backend/app/api/routes/sticker_sheet.py`: truyền global và giữ sự khác nhau
  giữa field theo trang bị bỏ và field được gửi tường minh. Không thay defaults
  của các field cũ.
- `backend/app/workers/sticker_sheet_export.py`: truyền denoise vào cache key,
  rebuild preview, export legacy/document và PNG fallback; đưa denoise vào khóa
  gom các trang tương thích.
- `backend/tests/test_sticker_cutline_export_denoise.py`: regression HTTP ->
  writer -> đọc lệnh cubic PDF; cache hit/miss; 0/50/100/tự động; nhiều trang,
  thứ tự lặp/đảo; validation và fallback.

### Hợp đồng

| Đầu vào | Hành vi |
|---|---|
| Global không gửi hoặc `null` | Tự động theo nguồn, tương thích caller cũ |
| Trang không gửi field | Kế thừa global |
| Trang gửi `null` | Tự động theo nguồn, kể cả global là số |
| `0` | Tắt cả denoise và presmooth tự động |
| Số dương đến 100 | Giữ mức đã yêu cầu |

Không dùng `or` hoặc ép `None` thành 0 ở biên hợp đồng. Worker hình học cấp thấp
nhận 0 chỉ khi cổng presmooth đã được xác định riêng; không lọc lần hai khi đã
có override Bézier hợp lệ. Caller cũ không gửi field giữ hành vi cũ, không tự
suy ý định từ cache mới nhất của trang.

### Bằng chứng đỏ -> xanh

Regression `test_export_denoise_giu_nguyen_lenh_cubic_pdf[cache-50.0-document]`
trước sửa: HTTP export trả thành công nhưng cubic khác preview, PDF thiếu 5
cubic (14 thay vì 19). Sau sửa: cùng test giữ đúng **từng lệnh cubic đã lượng tử
hóa**, không chỉ tổng số đoạn.

Probe độc lập source worker sau sửa: preview **19**, PDF **19**,
`canonical_unchanged=True`. Đã render PDF bằng Poppler 300 DPI và xem ảnh.
Không coi đây là nghiệm thu Tauri hoặc máy bế vật lý.

### Verify

- Bộ regression mới: **38 ca đạt**; gồm 4 ca bổ sung khóa segment/warning
  sau kiểm chéo độc lập.
- Typecheck Windows: đạt.
- Vitest Windows: 4 file / 60 test passed (API, store, sheet panel, classic preview).
- Bộ backend rộng gồm export denoise, sheet API, cutline preview/tuning,
  sticker E2E và artwork guard: **433 passed / 1 failed** trong sandbox
  (315,22 giây). Ca thất bại duy nhất là xuất 9 tem, Windows từ chối tạo pipe
  `ProcessPoolExecutor` với `WinError 5`.
- Đã xin quyền và chạy lại riêng ca 9 tem ngoài sandbox: **1 passed**
  (3,34 giây). Như vậy **434 ca khác nhau đã được xác minh đạt**, không gọi
  lượt full ban đầu là hoàn toàn xanh và không sửa worker để né giới hạn sandbox.
- Kiểm cú pháp bằng `compile` bốn file Python: đạt; `git diff --check`: đạt.
- Không sửa golden hoặc thuật toán fitter/độ cong/giảm node.

Lệnh backend rộng:

```powershell
.\venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_sticker_cutline_export_denoise.py tests/test_sticker_sheet_api.py tests/test_sticker_cutline_preview.py tests/test_sticker_cutline_tuning.py tests/test_sticker_engine_e2e.py tests/test_sticker_ai_artwork_guard.py
```

Lệnh chạy lại ngoài sandbox:

```powershell
.\venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_sticker_sheet_api.py::test_crop_true_keeps_nine_stickers_as_nine_pdf_pages
```

Hai warning Starlette/TestClient và Pydantic class-based config đã có trước,
không thuộc bản sửa này. Chưa chạy Tauri hoặc máy bế vật lý. PDF/PNG QA tạm
của probe được dọn sau khi xem; bộ test tái tạo được artifact tương ứng.

## Phần chưa triển khai

- **A2:** frontend vẫn chưa gửi denoise lúc export. A1 là backend tương thích
  trước, chưa thể gọi §NODE.1 đã hết từ nút xuất trên giao diện.
- **B:** chọn ứng viên đường cong tốt hơn; phải giữ incumbent khi không có ứng
  viên vừa ít node, vừa mượt hơn và không tăng sai lệch đo được.
- **C:** gộp Bézier có bound sai số so đường đầu vào bất biến; không cộng dồn
  dung sai qua các lần gộp, không phá G2/góc/lỗ hoặc sinh tự cắt.
- **D:** điều khiển giảm node và hiển thị trước/sau, sai số mm.

Chưa bật ngưỡng giảm node 0,02/0,05 mm. Chưa sửa code frontend, Rust, worker pool
hoặc chính sách tài nguyên. Các thay đổi build/license và tài liệu ngoài phạm vi
trong worktree thuộc công việc khác, được giữ nguyên.

## Chốt lô

A1 mới hoàn tất **phần backend**. Không tuyên bố nút xuất trong UI đã giữ
denoise cho đến khi A2 nối đầy đủ payload. Cần người dùng xác nhận thao tác
Bù xén/Tách nhiều tem/Xuất PDF hiện tại không phát sinh lỗi mới trước khi sang
lô A2 theo quy trình dự án. Giảm node B-C vẫn chưa được triển khai.

## Lô B1 - sửa đúng luồng PDF/PNG đã có biên trên Binder2

Người dùng đã xác nhận A1 không phát sinh lỗi và yêu cầu chuyển trọng tâm sang
PDF đã có biên; sau test `Binder2.pdf`, người dùng duyệt “tiến hành sửa đi”.

**Đã hoàn tất lô source + AUTO/ARTIFACT; chờ nghiệm thu thực tế trước lô tiếp.**

### Thay đổi (5 file trong lô)

1. `backend/app/workers/sticker_engine.py`: truyền `cutline_denoise` đầy đủ qua
   fan-out; các trang Alpha phù hợp không có snapshot dùng cùng hình học classic.
2. `backend/app/workers/sticker_source_pipeline.py`: helper
   `build_classic_alpha_page_contour` dùng Alpha render, mm round4, DPI thực X/Y,
   cùng ROI và fitter với preview; không tạo session hoặc gọi AI.
3. `backend/app/workers/sticker_cutline_preview.py`: trích helper ROI thuần
   `_cutline_instance_alpha_jobs`, dùng chung cho preview/worker; không đổi
   thứ tự instance, padding, fringe hay exact-shape của preview cũ.
4. `backend/tests/test_sticker_classic_binder2.py`: regression fan-out,
   synthetic point lẻ, lỗ thật/offset ±0,3 mm, bleed, snapshot, gate và Binder2;
   kèm entry tái tạo các PDF nghiệm thu.
5. Nhật ký này.

### Ranh giới an toàn

- Chỉ nhận `original/bleed`, `auto_safe/contour`, một ảnh Alpha phủ kín trang,
  đúng **một component trước lọc diện tích**. Không loại đảo nhỏ để giả thành
  một tem; các trang nhiều component tiếp tục giữ luồng cũ trong B1.
- Snapshot hợp lệ luôn thắng; không fit lại đè lên đường đã duyệt.
- Giữ nguyên page-box/rectangle/selection, hình ép `force_*`, vector,
  CutContour, nguồn không có Alpha và chế độ Alpha-inset cũ.
- Nguồn đã qua chốt một Alpha phù hợp nhưng fitter từ chối thì báo lỗi,
  không né oracle bằng cách quay lại polyline.
- Không chỉnh worker/RAM cap, không thêm dependency, không đổi RGB artwork
  render cũ. Bước lấy Alpha để dựng đường tách khỏi ảnh RGB dùng lấy màu.
- Đây là đồng bộ về đường canonical đang có, **chưa phải post-fit Simplify
  với dung sai 0,02/0,05 mm**, và chưa sửa bộ chọn G1/C2 tổng quát.

### Đỏ trước, xanh sau

Ba test `test_classic_fanout_giu_muc_khu_rang_cua` với 0/30/70 trước sửa đều
thất bại: `cutline_denoise` vắng trong kwargs tới `_process_parallel`. Sau sửa
giữ đúng cả ba giá trị. Assertion kiểm field vẫn nằm trong test, không chỉ
kiểm `success=True`.

Kiểm chéo phát hiện và đã gia cố thêm: không ghi đè hình ép, không nhận một
component sau khi bộ lọc đã xóa đảo, fail-closed sau khi nguồn được nhận, lỗ
thật trong fixture. Một lỗi vị trí block `__main__` của harness đã gây
NameError sau lượt artifact thử đầu; đã sửa và chạy lại toàn bộ bộ nghiệm thu
vào thư mục `B1-final` với exit 0, không dùng lượt thử đầu để chốt.

### Binder2 sau sửa

Mặc định `original/preserve`, offset/bleed 0, Khử răng cưa 30:

| Đại lượng | Trước B1 | Sau B1 |
|---|---:|---:|
| Trang 5 - line / cubic | 279 / 0 | **0 / 103** |
| Trang 5 - lệnh <0,25 mm | 172 | **0** |
| Trang 5 - lệnh ngắn nhất | 0,0301 mm | **0,5566 mm** |
| Toàn 13 trang - tổng lệnh | 3.259 | 3.100 |
| Toàn 13 trang - lệnh <0,25 mm | 1.511 | 1.215 |

Chỉ riêng trang 5 giảm 63,1% số lệnh. **Không** dùng tỷ lệ này cho toàn file;
toàn bộ Binder2 mới giảm khoảng 4,9% tổng lệnh ở mức 30.

- Xuất đủ 13 trang ở denoise 30 và 70, mỗi mức có ba trường hợp: không
  snapshot, snapshot trang 1, snapshot trang 5.
- Cả ba trường hợp ở cùng mức denoise có **13/13 hash đường cắt giống nhau**.
- Đã render 6 PDF / 78 trang bằng Poppler; pixel từng trang cũng giống nhau
  giữa các trạng thái Viewer. Đã xem contact sheet đại diện cả 13 trang cho
  mỗi mức (hai nhóm còn lại khớp pixel).
- SHA-256 Binder2 gốc trước/sau giữ nguyên
  `4c2a730ba4f0857847b46faf2e798f78c001f1615a8cd946686bcc53aa508c10`.

Artifact chuẩn nằm tại
`output/pdf/Binder2-classic-fixed-B1-final-2026-09-09/`, số đo trong `evidence.json`.
Bản để kiểm mặc định: `Binder2_denoise30_viewer0.pdf`.

```powershell
.\backend\venv\Scripts\python.exe -B backend/tests/test_sticker_classic_binder2.py --artifact-dir output/pdf/Binder2-classic-fixed-B1-final-2026-09-09
```

### Verify cuối

- Backend rộng: **429 passed**, 288,44 giây (classic Binder2, preview,
  tuning, source pipeline, engine E2E, parallel fallback, sheet API).
- Sau bổ sung hai ca bleed, bộ mục tiêu classic + A1 denoise:
  **66 passed**, 28,18 giây. Hai bộ có test trùng, không cộng 429+66 thành
  số test độc lập.
- Typecheck Windows: đạt; Vitest liên quan **4 file / 60 test passed**.
- Kiểm cú pháp bốn file Python và `git diff --check`: đạt.
- Warning Pydantic/Starlette có sẵn; không cập nhật golden.
- Chưa chạy GUI Tauri/Illustrator/driver/máy cắt; chưa build installer hoặc
  commit. Đây là bản sửa mã nguồn và PDF kiểm chứng, chưa gọi là đã phát hành.

### Phần còn mở và đánh đổi đã đo

- Trang 4 nhiều nhánh vẫn **927 line / 602 lệnh ngắn** ở mức 30; trang 3/9/11
  cũng còn polyline. Không gắn `machine-safe` cho toàn Binder2.
- Lựa chọn denoise đã có tác dụng thật trên các trang sau, nhưng không phải
  Simplify giữ nguyên đường: mức 70 có thể đổi số component, nổi bật trang 4
  15 -> 25 đường bao. Cần xử lý topology/chi tiết mảnh ở lô tiếp; không hứa
  kéo cao sẽ luôn tốt hơn hoặc luôn giảm node.
- Các cubic canonical như trang 5 vẫn có nhảy độ cong G1; giảm node và
  fairness tổng quát còn mở. Không ép C2 bằng cách nới sai số.
- Mỗi trang phù hợp có thêm một lượt render Alpha bên cạnh RGB cũ để giữ
  parity mà không đổi màu. Đo N=1 Binder2 sau sửa khoảng 8,8-9,1 giây so với
  baseline 6,1-6,3 giây; **có chi phí thời gian**, chưa gọi đây là tối ưu tốc độ.
  Cần đo/tái dùng raster có chốt màu ở lô hiệu năng riêng, không tăng worker
  hoặc giảm chất lượng để che chi phí.
- A2 export sheet và thanh Simplify riêng trên giao diện PDF vẫn chưa làm.

Theo chốt của `prynx-audit-workflow`, dừng sau B1 để người dùng xem bản PDF
đối chứng/kiểm chạy thực tế. Lô tiếp phải tập trung đường nhiều phần rời và
nhánh mảnh của PDF, không quay lại ưu tiên sheet thay cho vấn đề chính.

## Lô B2 - rút gọn đường polygon nhiều nhánh, có cận sai số

Người dùng yêu cầu “tiếp đi/tiếp” sau B1. **Đã có source + AUTO/ARTIFACT**, chưa
nghiệm thu Tauri/Illustrator/dao bế. Không coi B2 là đã hoàn tất toàn chiến dịch.

### Cách sửa

Module mới `backend/app/workers/cutline_polyline_reduction.py` xử lý **chính đường
vector polygon cuối cùng**. Không dò lại ảnh, không tăng denoise, không xóa
component và không đổi mask/bleed/artwork để đạt số node thấp.

- Chia nhịp tại góc từ 45 độ và giữ seam/điểm bắt đầu; thử gộp các đoạn liền
  nhau. Pin endpoint và hướng tiếp tuyến ngoài của nhịp được gộp.
- Fitter chỉ sinh ứng viên. Phân hoạch tham số tăng chặt rồi chia Bézier bằng
  de Casteljau; so convex hull của **đường hiệu** với từng line nguồn đã nâng
  bậc. Mỗi candidate luôn so với nguồn bất biến, không cộng dồn sai số merge.
- Nếu không có chứng nhận, giữ line cũ. Không tăng số đoạn ở bất kỳ chain nào.
- Ngân sách bổ sung **0,02 mm** đã trừ dự trữ lượng tử hóa `.4f` của cả đường
  cũ và mới; thêm chốt monotonic theo chord để bắt loop/cusp nhỏ nằm trong
  hành lang sai số. Đây không phải sai số tổng từ ảnh nguồn tới đường cuối.
- Kiểm topology trên **control đã lượng tử hóa đúng writer**: STRtree lọc
  cặp, tách convex hull, chia Bézier tiếp khi chưa phân giải. Cặp kề chỉ được
  miễn điểm chung nếu chứng minh hai hull nằm hai phía separator. Không bỏ
  qua cả cặp kề hoặc seam. Độ sâu chứng minh không đủ thì bỏ rút gọn, không
  nhận candidate bằng kiểm vài điểm.
- Kiểm đóng kín, winding, số ring, thứ tự lỗ/đường ngoài, nesting và clearance
  sau lượng tử hóa. Không `buffer(0)` hoặc union để sửa một kết quả lỗi.

Tích hợp ở writer của `sticker_engine.py` trước khi ghi `/CutContour`:
chỉ polyline `preserve/adaptive`, `original/bleed`, `auto_safe/contour` của PDF
một ảnh trực tiếp phủ trang. Loại canonical/approved, Alpha-source, đường cubic
đã fit, rectangle, selection, hình ép, Form/vector, annotation và tài nguyên
CutContour có sẵn. B2 không dùng cổng chỉ đọc resource cấp trang để kết luận
Form không có CutContour: nguồn có Form bị giữ nguyên bằng cổng ảnh trực tiếp.

Không gán lại `cut_poly`, `dieline_poly`, cache, mask hoặc vùng màu. Metadata
riêng `cutline_reduction` ghi trước/sau/cận sai số; bbox cũ vẫn mô tả hình học
trước bước này, không phải chứng minh bbox mới bằng tuyệt đối.

### Kết quả Binder2 - so đúng với B1

Khử răng cưa 30, offset/bleed 0, cùng nguồn và cùng tham số:

| Đại lượng | B1 | B2 |
|---|---:|---:|
| Trang 3 - tổng lệnh | 251 | **150** |
| Trang 3 - lệnh <0,25 mm | 158 | **46** |
| Trang 4 - tổng lệnh | 927 | **555** (350 line + 205 cubic) |
| Trang 4 - lệnh <0,25 mm | 602 | **176** |
| Trang 4 - đường bao | 15 | **15** |
| Toàn 13 trang - tổng lệnh | 3.100 | **2.627** |
| Toàn 13 trang - lệnh <0,25 mm | 1.215 | **677** |

Trang 4 giảm 40,1% tổng lệnh và 70,8% lệnh ngắn. Riêng đường cây phức tạp
517 -> 263 lệnh, đoạn ngắn 336 -> 46; diện tích 93,19910 -> 93,58626 mm²
(+0,4154%), vẫn một ring, không bỏ nhánh hoặc tách cây thành nhiều hình.

Kiểm độc lập trên vector đã lượng tử hóa, không chỉ tin cận do module trả:

- Sai lệch hai chiều lớn nhất đo được khoảng **0,0199126 mm**.
- Cận liên tục độc lập **≤0,0199825 mm**, dưới 0,02 mm: flatten cubic với
  cận 0,0000025 mm, chia line thích ứng và dùng cận Lipschitz khoảng cách
  trung điểm + nửa chiều dài đoạn. Cận module trên probe cùng trang là
  khoảng 0,0199951 mm, không gọi con số đó là độ lệch thực đo được.
- 15 ring giữ thứ tự/seam/winding, không cặp nào giao nhau; khoảng cách giữa
  các ring gần nhất giữ khoảng 0,931962 mm.
- Test trên writer thật so cả lệnh trước phần CUT và dữ liệu Form artwork
  (bỏ qua tên resource ngẫu nhiên), xác nhận B2 không thay nội dung ảnh in.

Ở denoise 70, B2 giữ đúng 25 đường bao đã có từ B1 trang 4; giảm 953 -> 556
lệnh và 615 -> 168 lệnh ngắn. **Không** gọi thay đổi 15 -> 25 giữa hai mức
denoise là do B2 hay là điều đã khắc phục: đó là thay đổi topology trước bước
rút gọn, vẫn thuộc việc cần xử lý tiếp.

### Artifact và verify

- Bộ PDF: `output/pdf/Binder2-classic-fixed-B2-2026-09-09/`.
  Bản kiểm mặc định: `Binder2_denoise30_viewer0.pdf`.
- `evidence.json`: 6 PDF ở denoise30/70, mỗi mức không snapshot/Viewer1/Viewer5;
  13/13 hash CUT khớp trong mỗi nhóm. Render 78 trang bằng Poppler: pixel cũng
  khớp khi đổi Viewer. Đã xem contact sheet đại diện cả 13 trang của mỗi mức.
- Hash Binder2 gốc giữ nguyên; không ghi đè các PDF B1/baseline.
- Backend hồi quy rộng: **474 passed**, hai warning Pydantic/Starlette có sẵn.
  Sau bổ sung gate Form và oracle test hiệu quả hơn, bộ mục tiêu cuối:
  **72 passed**. Hai bộ có trùng ca, không cộng thành tổng độc lập.
- Typecheck và Vitest Windows **4 file/60 test passed**; cú pháp Python và
  `git diff --check` đạt. Không golden update/commit/build/installer.
- Ba fail thử đầu là test harness: so float chính xác, cặp đường tưởng giao
  nhưng thực tế rời, tên Form ngẫu nhiên; đã sửa fixture/oracle, không nới
  dung sai sản phẩm. Fixture nested Form đầu dùng alias không độc lập gây
  trang trắng; đã dựng Form tường minh rồi ca loại trừ đạt.

### Hiệu năng và giới hạn

Probe reducer riêng trang 4 khoảng 0,8 giây, không thêm pool/cap/RAM gating.
Các lượt export B2 quan sát 8-13,5 giây, có chạy cùng verify nên **không đủ
làm A/B benchmark hay tuyên bố nhanh hơn B1**. Kiểm thử Hausdorff thô từng
chậm O(N²); đã thay riêng oracle test bằng bao phủ hai chiều trên polyline
lấy mẫu, còn certificate sản phẩm/kiểm độc lập vẫn giữ nguyên.

- Trang 4 còn **176 đoạn ngắn và 555 join >1 độ**; B2 giảm mật độ đổi hướng,
  chưa làm liên tục G1/G2 toàn đường. Không hứa máy chạy hoàn toàn mượt.
- Trang 9/11 mức30 chưa được rút gọn thêm vì các chốt bảo thủ từ chối. Không
  xóa lỗ/nhánh hay nới sai số để ép thành công.
- Lõi B2 hiện chỉ xử lý polyline cuối của nhánh classic; chưa áp lên cubic
  canonical đã duyệt và chưa có slider Simplify trên UI. Bước tiếp theo cần
  giải chốt đó riêng, không sửa đường preview sau lưng người dùng.
- Chưa chạy GUI native/Illustrator/dao thật. Theo `prynx-audit-workflow`, chờ
  nghiệm thu PDF B2 tại chốt lô trước khi mở rộng thuật toán/quyền điều khiển.

File trong lô B2: module mới, engine, test module mới, nhật ký này và delta
master matrix. Các thay đổi license/Tauri/i18n của công việc khác được giữ nguyên.

## Lô B3 - thanh Simplify cho PDF/PNG đã có biên

Người dùng yêu cầu tiếp tục sau B2. Lô này đưa điều khiển vào đúng `StickerTool`
(classic), không đưa vào `StickerSheetPanel` trước khi hợp đồng classic ổn định.

### Hợp đồng UI

- Thanh **Đơn giản hóa thêm (Simplify)** nhận 0–0,05 mm, bước 0,005 mm, mặc
  định 0 và không lưu vào localStorage; scope theo file/trang/instance.
- 0 = giữ baseline; số dương = sai lệch **bổ sung so đường vector hiện có**,
  không phải sai số tổng so Alpha.
- Đổi source/trang làm scope cũ mất hiệu lực; đường xem trước phải cập nhật
  xong mới bật Thực thi. Preview cũ không được gắn số liệu mới.
- Hiển thị `before_segments`, `after_segments` và `maximum_error_bound_mm` của
  frame hiện tại. Nếu candidate không đạt guard, số sau giữ nguyên số trước.
- Chế độ page-box/rectangle/đã có CutContour không bật Simplify; đổi kiểu nhận
  dạng khi đang chọn Simplify dương bị chặn để tránh xuất frame khác.

### Lõi và parity

`cutline_cubic_simplify.py` gộp các span Bézier liền kề trên đường baseline bất
biến. Candidate chỉ nhận khi: control-hull difference qua de Casteljau có cận
liên tục dưới budget sau `.4f`; chord không quay đầu; endpoint tangent/curvature
không xấu hơn theo metric; ring kín/winding/lỗ/nesting hợp lệ; control hull
không giao nhau sau lượng tử hóa. Không dùng sample thưa để chứng minh, không
gộp lặp từ kết quả đã gộp và không sửa mask/offset/màu.

Preview và writer gọi cùng hàm từ baseline; fingerprint/cache bind
`cutline_simplify_mm` (giá trị 0 giữ legacy hash). Recipe ghi field mới; bản ghi
cũ thiếu field giữ 0.

### Verify

- Backend target B3: **118 passed** (cubic simplifier, contract, Binder2, B2).
- Frontend Vitest: **90 passed / 5 file**, typecheck đạt.
- Artifact Binder2 `output/pdf/Binder2-Simplify-005-2026-09-09/`: six PDF
  (denoise30/70 × no snapshot/Viewer1/Viewer5), 13/13 CUT hash parity trong
  từng mức; output render được bằng Poppler. 0,05 mm giảm thêm được một số
  cubic ở các trang phù hợp; trang 4 nhiều nhánh vẫn giữ đường nếu candidate
  không qua continuity/topology, không ép giảm.
- Số đo artifact no-snapshot: denoise30 **2.597 lệnh / 675 lệnh ngắn**
  (B2: 2.627 / 677); denoise70 **2.412 / 182**. Trang 4 giữ B2 ở
  555 lệnh / 176 lệnh ngắn vì candidate thêm chưa chứng minh an toàn.
- Bản B3 render riêng trang 1 và 4 đã soi: artwork/màu không đổi, CUT bám đúng
  biên, không có trang trắng hoặc crop bất thường.
- Chưa chạy Tauri click-smoke, chưa nghiệm thu Illustrator/driver/máy bế,
  chưa build installer hoặc commit.

### Giới hạn còn lại

- B2 vẫn là nền rút polyline an toàn 0,02 mm trong classic; thanh B3 chỉ gộp
  thêm trên baseline đã duyệt và không cộng dồn sai số. Nhiều đoạn ngắn ở
  trang 4/9/11 có thể được giữ nguyên vì không chứng minh được phép gộp.
- B3 chưa có mục tiêu global tối thiểu node; không hứa slider 0,05 luôn giảm
  nhiều hơn 0,02. C2/G2 toàn đường và control máy thực vẫn cần pilot riêng.
- A2 export sheet và recipe playback đầy đủ canonical vẫn là phạm vi tiếp theo;
  B3 tập trung đúng PDF/PNG classic người dùng phản ánh.

Lô B3 dừng ở `AUTO + ARTIFACT`, chờ người dùng xem bản PDF/đường trong Illustrator
trước khi thay đổi thêm ngưỡng hoặc mở rộng sang nhiều component khó của Binder2.

## Lô B4 - refit toàn nhịp theo kiểu Potrace/VTracer

Người dùng xác nhận ảnh Illustrator là **đường bế trang 12 Binder2** và yêu cầu
lõi PrynX mạnh hơn Simplify của Illustrator. B4 thay bộ gộp cặp bằng candidate
refit toàn nhịp + DAG/shortest-path trên tập candidate đã chứng nhận; không gọi
đây là nghiệm tối ưu tuyệt đối trên mọi Bézier.

### Thiết kế

- Giữ đường cubic B3 làm baseline bất biến; lấy góc/cusp thật làm mốc, thử các
  span dài hơn bằng chord-length + Newton reparameterization.
- Candidate phải có control-hull error liên tục ≤ tolerance, chord không quay
  đầu, giữ endpoint/tangent, giữ ring/winding/lỗ/nesting và qua kiểm sau
  lượng tử hóa `.4f`.
- DP chọn ít segment hơn trong graph candidate; span ngắn fail không chặn span
  dài khác. Không copy Potrace/VTracer vào production và không thêm dependency.
- Motion guard không lấy p95 làm lý do từ chối chỉ vì mẫu số thay đổi; vẫn giữ
  max curvature/join, cusp và topology. Đây là guard chất lượng chuyển động,
  chưa phải chứng minh jerk máy bế liên tục.

### Page 12 - đúng mẫu ảnh Illustrator

Trang 12 có sáu ring; ring hoa là ring lớn 55 cubic, không phải toàn bộ 142 cubic
của trang. Ở offset 0, denoise30, tolerance 0,05 mm:

- toàn trang: **142 → 132 cubic**;
- ring hoa: **55 → 45 cubic** (-18,2%);
- mười góc ≥45° giữ nguyên vị trí;
- sai lệch hai chiều đo trên lệnh PDF: khoảng **0,048873 mm**;
- cận liên tục độc lập sau `.4f`: **≤0,049873 mm**;
- 6 component, winding/lỗ/khổ trang giữ nguyên;
- curvature max **3,02314 → 2,54965/mm**, curvature flips **48 → 40**;
- p95 curvature jump tăng nhẹ **1,93903 → 2,04877/mm**; không gọi mọi metric đều tốt hơn.

Ảnh người dùng có vẻ khớp toàn bộ thiết kế với offset khoảng +2 mm và xoay trong
Viewer hơn là ring hoa offset0; đây là suy luận đối chiếu ảnh, chưa phải setting
đã lưu. Probe offset2 riêng cho thấy 122 → 106 cubic ở tolerance0,05, nhưng
chưa dùng làm artifact mặc định.

### Binder2 13 trang - artifact B4

`output/pdf/Binder2-Simplify-global-final-005-2026-09-10/` giữ ba trạng thái
Viewer × hai mức denoise. Ở denoise30, no-snapshot:

- **2.597 (B3) → 1.896 lệnh** sau global refit;
- các trang 3/7/10/13 giảm đáng kể; trang 4 nhiều nhánh còn 530 cubic và
  165 lệnh ngắn dưới 0,25 mm, không bị ép gộp khi candidate chưa chứng minh;
- 13/13 hash CUT giữ nguyên giữa no-snapshot/Viewer1/Viewer5 trong từng mức;
- raster Poppler kiểm 78 trang parity; Binder2 SHA-256 không đổi.

Đây là bằng chứng cải thiện lớn hơn B3, nhưng chưa so trực tiếp với file
Illustrator sau Simplify vì chưa có SVG/PDF vector từ Illustrator làm ground truth.

### Verify và giới hạn

- Global/cubic/B2 target: **236 passed** ở lượt kiểm lõi; full nhóm source/classic
  trước B4 đạt 509/1 sandbox fail do WinError5 tạo pipe và ca đó chạy lại ngoài
  sandbox đạt 1/1. Frontend **90 passed/5 file**, typecheck đạt.
- Artifact B4 đã render và xem contact sheet; chưa click Tauri/Illustrator,
  chưa driver/máy bế, chưa build installer/commit.
- Giới hạn còn lại: DP hiện tối ưu trong candidate graph, không phải mọi spline;
  nhiều component/inflection vẫn bị giữ conservative; page12 p95 curvature
  còn tăng nhẹ. Lô kế tiếp cần benchmark với SVG/PDF Simplify thật của Illustrator,
  rồi mới chỉnh góc/tolerance mặc định.

## Phản hồi sau B4 và nghiên cứu 2026-09-10

Người dùng xác nhận đường vẫn không có cải thiện thị giác như mong đợi.
**Không coi B3/B4 đã hoàn thành mục tiêu Simplify như Illustrator.** Các số
test/node/certificate bên trên chỉ giữ nguyên giá trị trong phạm vi đã đo.

Lượt tiếp theo là nghiên cứu, không phải B5 production. Đã chạy Paper.js,
curve-fit-nd, VTracer và các probe spline, rồi thử solver có neo/hướng tay
nắm tự do + penalty bước nhảy độ cong. Trên outline thử trang12 bù2mm từ
PDF B3: 122→60 neo, sai lệch sau lượng tử đo0,088411mm, cận Hausdorff bảo thủ
0,093512mm; P95 nhảy độ cong21,045→1,269/mm. Main chạy lại đúng solver khớp
control points và kiểm độc lập, không chỉ nhận tóm tắt của agent.

Đây chưa đạt cap0,05mm, chưa khóa góc/cusp thật, chưa nối app/writer và chưa
nghiệm thu Illustrator/dao thật. Không tự đổi ngưỡng hay thay engine trong
lượt nghiên cứu. Xem [báo cáo và hướng triển khai](D:/pdfcompare/docs/BAO_CAO_AUDIT_SIMPLIFY_FAIRING_2026-09-10.md).
