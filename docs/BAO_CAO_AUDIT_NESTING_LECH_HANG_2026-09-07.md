# Nesting S&R lệch hàng - chẩn đoán 2026-09-07

> Người dùng đã duyệt triển khai S&R nesting lặp ổn định, giữ xếp dàn nhiều mẫu tự do. Nhật ký: `NESTING_ROW_DRIFT_FIXES_2026-09-07.md`. Phần chẩn đoán bên dưới giữ nguyên làm baseline; phê duyệt không có nghĩa đã sửa xong.

> Cập nhật sau triển khai R1–R3: lõi periodic S&R đã bỏ đường công bố greedy tự do và giữ sàn 69/71/58/31 trên artifact thật; kết quả build/native/artifact được ghi tại `docs/audit/NESTING_ROW_DRIFT_R2_R3_EVIDENCE_2026-09-07.json`. Phần GUI/Tauri/installer vẫn là cổng RUNTIME chưa nghiệm thu.

## Phạm vi và kết luận

Người dùng xác nhận tốc độ đã khá tốt nhưng layout càng lên các hàng trên càng lộn xộn, yêu cầu xem trang 6/7/8 của `D:/pdfcompare/test/test nesting.pdf` và ba ảnh CUT. Đợt này chỉ chẩn đoán, chưa sửa thuật toán. Dừng chốt nghiệm thu chiến dịch hiệu năng trước khi xử lý phản hồi chất lượng này.

HEAD: `79f05a399cb1669e6fb7cd1b84babfcbc7e3aebc`. Working tree có các lô hiệu năng và thay đổi frontend của tác vụ khác; giữ nguyên tất cả. Source PDF SHA-256: `efcde4f0a16aca0a5a54ee2d952945afe2eb70dd2073bc9ff59ee87292b257ab`.

**[VERIFIED] Vị trí không đều đã có trong manifest của artifact kiểm tra; không phải PDF cộng dồn phép biến đổi làm lệch từng hàng.** Nét CUT được đọc trực tiếp từ PDF và đối chiếu toàn bộ đỉnh với pose/ring manifest, sai số tối đa dưới `5e-10 pt`. Cả bốn trang chỉ dùng góc `0/180`, không có xoay góc lẻ tăng dần. Điều này không có nghĩa layout đáp ứng yêu cầu đều hàng.

**[CONFIRMED] §NESTROW.1 / P1 / effort M-L: S&R chưa bảo đảm mẫu lặp khi công bố layout.** Code có candidate tuần hoàn, nhưng vẫn có đường giữ greedy không tuần hoàn nếu candidate đó không được tạo/chấp nhận, rồi khóa baseline hợp lệ làm kết quả cuối. Phạm vi xác nhận là hở hợp đồng đều hàng của S&R và artifact có cùng biểu hiện; chưa khẳng định một guard cụ thể là nguyên nhân duy nhất ở mọi trang.

## 1. Đối chiếu đúng trang và artifact

Ảnh 3 khớp contour trang 6 (Well Done - trứng); ảnh 2 khớp trang 7 (Good Job - nấm). Ảnh 1 hình hoa khớp trang **12** (Great Job), không gán cưỡng bức thành trang 8. Vẫn kiểm thêm trang 8 (Extremely Good - tia sét) theo yêu cầu bằng văn bản.

Đọc artifact có sẵn, không solve lại và không gia hạn kho source/manifest:

- `C:/Users/Khanh Pham/AppData/Local/Temp/prynx_manifest_F_w9s0raol/before.pdf`
- `C:/Users/Khanh Pham/AppData/Local/Temp/prynx_manifest_F_w9s0raol/after.pdf`
- `result.json` và bốn manifest tương ứng trong `runtime-data/manifests` cùng thư mục.

Đây là artifact benchmark F cùng source hiện hành, có cùng kiểu lệch hàng với ảnh người dùng; chưa chứng minh là chính job GUI vừa xuất. Source binding trong manifest xác nhận page index, không suy số trang chỉ từ thứ tự file.

| Trang nguồn | Trang CUT trong PDF 26 trang | Số tem | Góc 0/180 | Số đỉnh CUT đã so |
|---|---|---:|---|---:|
| 6 | 12 | 66 | 33/33 | 12.144 |
| 7 | 14 | 66 | 33/33 | 7.260 |
| 8 | 16 | 57 | 29/28 | 8.379 |
| 12 (ảnh hoa) | 24 | 29 | 15/14 | 21.257 |

Tổng **49.040 đỉnh** khớp với pose/ring đã transform. Cả bốn trang CUT không có toán tử `cm` hoặc `Do`; không có CTM/Form ẩn làm thay đổi operands đã so. Decoded CUT stream trước/sau F bằng nhau ở cả bốn trang. Đây chỉ là A/B **F**, không được dùng thay kiểm PDF trước D/E. Mốc `valid=true` trong manifest là kết quả đã lưu, lượt này không chạy lại native validator.

Poppler đã render và main agent đã xem đầy đủ source 6/7/8/12, CUT 12/14/16/24. Trong ảnh CUT, dải đáy tương ứng các pose có Y nhỏ; không đảo trục để suy ra khớp bằng công thức đơn thuần.

## 2. Dữ liệu chứng minh mất nhịp

Trang 6: các pose 0 độ đầu tại X `30,894261 / 113,157375 / 195,420489 / 277,683603 mm` đều có Y `26,419581 mm`, bước X `82,263114 mm`. Phía trên đã xuất hiện các pose 0 độ tại Y `68,520764`, `84,163962`, `100,165301 mm`; không chỉ có một hàng được dịch chung từ hàng dưới. Pose đầy đủ nằm trong các manifest được dẫn trong evidence; JSON báo cáo trích 14 pose đầu mỗi trang. Không dùng vài điểm để kết luận không tồn tại bất kỳ lattice toán học nào.

Thống kê thăm dò theo **tọa độ điểm tham chiếu pose**, không phải thuật toán phân đoạn hàng vật lý:

| Nguồn | Dải đáy dùng để khảo sát | Tem / số mức Y dải đáy | Tem / số mức Y phía trên |
|---|---|---|---|
| 6 | Y < 35 mm | 7 / 2 | 59 / 58 |
| 7 | Y < 35 mm | 7 / 3 | 59 / 59 |
| 8 | Y < 35 mm | 6 / 2 | 51 / 50 |
| 12 | Y < 60 mm | 5 / 2 | 24 / 24 |

Không gọi các con số trên là số hàng. Chúng đi cùng raster và pose để chứng minh hiện tượng không thể được giải thích đơn giản bằng việc PDF vẽ lệch nhưng manifest vẫn là các hàng đều.

## 3. Đường chạy và điểm hở

Entry: `ImposerDashboard` / `GridPreview` -> route preview trong `backend/app/api/routes/imposition.py` -> `nesting_preview_capacity` -> preview session / production pipeline -> `nup_true_shape_nesting.py:861` tạo job một mẫu với `step_repeat_single_sheet` -> native `multi_start::solve` -> `baseline` -> manifest -> projector / `nesting_imposition_render` -> PDF.

### Lõi xếp

- `imposition_core/src/mixed_nesting/baseline.rs:1921`: dựng candidate greedy trước. Vòng tại `2178/2225` chọn lại vị trí hợp lệ theo Y/X cho từng tem; kết quả tại `2307` mang `periodic_motif=false`.
- `baseline.rs:1931`: có thể trả ngay sau greedy khi tới deadline, trước lượt lattice.
- `baseline.rs:989` và `1017`: lattice một hướng phải tìm được prefix lặp đúng bước ngang ở hàng đầu và hàng kế. Dung sai tuyến tính rất nhỏ; không tìm thấy thì trả không có candidate.
- `baseline.rs:1962`: lattice chỉ thay incumbent nếu không giảm số tem.
- `baseline.rs:2012` và `2054`: phương án greedy luân phiên 0/180 có thể thắng theo `LayoutScore`. Nếu motif cứng không dựng được hoặc không giữ đủ số tem, vẫn có thể chọn alternate tự do. Candidate đều cặp ở `1414` dùng envelope cặp và kiểm sàn số lượng tại `1514/1845`.
- `imposition_core/src/mixed_nesting/score.rs:181`: điểm so lượng tem/số tờ/vùng bao/compactness/canonical key, không có tiêu chí sai lệch nhịp hàng.
- `imposition_core/src/mixed_nesting/multi_start.rs:622`: khóa mọi baseline S&R có validation hợp lệ, **không yêu cầu `periodic_motif=true`**. Dòng `763` không chạy thêm portfolio khi đã khóa.

Hệ quả: hợp lệ về va chạm/ràng buộc hình học không đồng nghĩa đã giữ mẫu lặp chế bản. Tên baseline hoặc comment “S&R authoritative” không phải bằng chứng đã chọn motif đều.

### Phân biệt với lỗi vẽ/cộng dồn

- `backend/app/workers/imposition_affine.py:140`: mỗi pose tính trực tiếp `T(tx,ty) * R * T(-reference)`.
- `backend/app/workers/imposition_pdf_form.py:892`: mỗi placement artwork có `q ... cm ... Do Q`; không để CTM placement trước chảy sang placement sau.
- `backend/app/workers/nesting_imposition_render.py:400`: CUT đổi từng ring mm sang pt trực tiếp.
- D chỉ tái dùng dữ liệu part/side bất biến; pose vẫn parse từng occurrence tại `nup_artwork.py:1534`. E giữ occurrence và thứ tự instance; F giữ thứ tự input, không lấy thứ tự hoàn tất thread làm thứ tự output.

Chưa tìm được dòng D/E/F trực tiếp cộng dồn drift. Không quy hết nguyên nhân cho hoặc miễn trừ toàn bộ D/E chỉ dựa trên benchmark F; kết luận mạnh ở lượt này là **artifact CUT theo đúng pose không đều đã lưu**.

## 4. Có phải vì thế mà tính lại nhiều lần?

Cả bốn manifest đã lưu đều `selectedCandidate.kind=baseline`, `trialsRun=0`, `poseRefinements=0`, kết thúc `sheet_full`. Stats attempts lần lượt `370 / 387 / 395 / 194`; đây là số lần thử trong solver, không phải số request preview hoặc số lần gọi toàn bộ solve.

Như vậy chưa có bằng chứng engine lặp lại whole-solve để sửa các hàng bị lệch. Greedy phải kiểm vùng khả thi mới cho từng tem; dựng được một mẫu lặp cố định có cơ hội giảm việc đó, nhưng cần A/B để chứng minh. Không hứa phần trăm nhanh hơn và không coi tăng budget là cách sửa mặc định.

## 5. Chỗ chưa chứng minh

- Manifest chưa serialize subcandidate hoặc lý do loại motif; chưa biết chính xác candidate bị loại bởi prefix, va chạm, sàn số tem hay deadline ở từng trang.
- Lattice xiên đúng cũng có thể dịch pha theo hàng (`origin + c*u + r*v`), nên bản sửa phải phân biệt mẫu xiên hợp lệ với đặt từng tem không giữ nhịp; không chỉ ép mọi Y bằng nhau.
- Incremental Clipper có lịch sử sai khác cỡ `1e-6`; chưa có bằng chứng đó là nguyên nhân của các độ lệch mm nhìn thấy. Không chỉ nới tolerance để “sửa”.
- Test lattice hiện hữu `mixed_nesting_baseline.rs:871` dùng fixture/góc cố định; helper control không deadline tại `243`. Chưa thay thế ca thực 0/180 dưới production budget.
- Chưa đo số tem đạt được với một motif đều mới trên đúng bốn hình; không tự chấp nhận giảm sức chứa để làm ảnh trông đẹp.
- GUI acceptance đã mở lại sau khi người dùng thử xác minh license thành công, nhưng người dùng dừng Computer Use bằng Esc trước khi hoàn tất. Chưa nâng `RUNTIME`; không tự điều khiển app trong đợt chẩn đoán ảnh này.

## 6. Phương án sửa đề xuất - chờ duyệt

Đây là thay đổi thuật toán/kết quả ngoài các lô tăng tốc S1/B-F, áp chốt duyệt hình học của `audit-rules.md` và `prynx-audit-workflow`.

1. Khóa fixture thực 6/7/8 và 12, cùng sheet/gap/marks/cardinal domain/budget; ghi lý do candidate motif bị loại ở probe/test để xác định đúng nhánh.
2. Tìm basis/motif 0/180 trực tiếp từ contour/quan hệ tiếp xúc; không chỉ trông chờ greedy đã tình cờ tạo đủ hai hàng đều. Dựng các tem bằng tọa độ tuyệt đối theo mẫu lặp, giữ cả quan hệ láng giềng chéo.
3. Khi công bố S&R, phân biệt kết quả thực sự giữ motif với fallback tự do. Giữ sàn số lượng, gap, biên tờ và né ốc; không âm thầm giảm số tem hoặc thay tiêu chí chung của N-up/free-gang.
4. Verify mỗi lô tối đa 5 file: test actual contours + production budget, final validator, preview/manifest/PDF cùng pose, raster bốn trang, A/B thời gian và sức chứa; RAM >=16 GB giữ toàn công suất.

Chưa có production patch, test update, native rebuild hoặc commit trong đợt chẩn đoán này. Probe đọc-only đã chạy bằng venv (sau sửa đường import của harness), exit 0. Script và số đo đầy đủ được lưu tại `docs/audit/NESTING_ROW_DRIFT_EVIDENCE_2026-09-07.json`; PNG khảo sát giữ tạm ở `tmp/pdfs/nesting-row-drift-20260907` để so sau khi sửa.
