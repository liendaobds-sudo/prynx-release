# Bình tem bế nhiều tờ — nhật ký triển khai
Ngày: 2026-09-19

Kế hoạch: BAO_CAO_AUDIT_BINH_TEM_BE_NHIEU_TO_2026-09-19.md.
Người dùng đã duyệt bằng yêu cầu "làm đi" sau khi nhận danh sách 5 lô.

## Lô A1 — nền kế hoạch số lượng và chốt không xuất thiếu

Trạng thái: ĐÃ SỬA VÀ KIỂM THỬ BACKEND. Chưa hoàn tất toàn bộ luồng nhiều tờ; chưa nối hệ số lặp vào solver/handover hiện hành. Chờ xác nhận runtime trước lô tiếp theo theo prynx-audit-workflow.

### 5 file của lô

1. backend/app/core/nesting_order_plan.py (mới)
2. backend/app/workers/nup_true_shape_nesting.py
3. backend/tests/test_nesting_order_plan.py (mới)
4. backend/tests/test_nesting_order_export_gate.py (mới)
5. docs/BINH_TEM_BE_NHIEU_TO_FIXES_2026-09-19.md (file này)

### Thay đổi

- Kế hoạch số lượng bất biến, rút hệ số lặp bằng ước chung thật; không làm tròn SL riêng từng loại.
- Nhận danh sách bố cục cơ sở đã có identity, tính số lần in và tổng SL thực; không tự suy/gộp hình học.
- Tách template_count và physical_sheet_count.
- Snapshot JSON và fingerprint gồm đơn hàng, số lần in, identity hình học và thống kê; từ chối dữ liệu bị lệch, kể cả true/1/1.0.
- Kiểm đếm placements độc lập với validation.valid và stats.
- Chặn export Bình tem bế / quantity_fulfillment nếu thiếu/thừa SL, trùng instance, mẫu lạ hoặc ledger không khớp.
- Chốt đặt trước writer ở cả đường solve mới và đường nạp manifest từ preview; không ghi artifact hoặc commit session thiếu.
- Không thay semantics S&R, CNC và autofill của các luồng khác.
- Giữ cơ chế recipe identity lossless sẵn có của nesting_imposition_render.py; không tạo thuật toán gộp hình học thứ hai.

### Bằng chứng

Baseline test trước sửa: 2 test FAIL vì cả hai đường xuất vẫn gọi writer khi mới có 6/72 mẫu; 4 test còn lại PASS.

Sau sửa:
- 42 test mới của kế hoạch/identity/cổng export đạt.
- Toàn bộ nhóm liên quan: 202 passed, 1 cảnh báo Pydantic deprecation có sẵn, 35,40 giây.
- Test handover tiến trình thật ban đầu bị sandbox chặn Windows pipe; đã xin quyền và chạy lại ngoài sandbox đạt.
- git diff --check đạt cho file production đã sửa.
- Không sửa golden/snapshot cũ để ép test xanh.

Lệnh tổng:
```
backend/venv/Scripts/python.exe -B -m pytest -q --tb=short -p no:cacheprovider tests/test_nesting_order_plan.py tests/test_nesting_order_export_gate.py tests/test_nup_true_shape_nesting_entry.py tests/test_nesting_session_handover.py tests/test_nesting_production_pipeline.py tests/test_nesting_cnc_pipeline.py tests/test_nesting_preview_jobs.py tests/test_nesting_finishing_parity.py
```

Ca kế hoạch (không phải đo sức chứa hình học):
- Fixture đã phân 72 loại vào 8 bố cục, mỗi bố cục 9 loại: SL=1 -> 8 bố cục / 8 tờ.
- Cùng fixture SL=100 -> 8 bố cục / 800 tờ / 7.200 tem; đối soát riêng đủ 100 từng loại.
- 73 loại -> 9 bố cục, loại cuối không mất.
- a=5, b=3 -> bố cục ab in 3 lần, tờ bù a in 2 lần; tổng đúng từng loại.
- Lưu/đọc kế hoạch giữ nguyên kết quả và identity; sửa số lần in/thống kê/identity bị từ chối.

Probe native thật với request quantity của file 72 mẫu:
- Native trả placedCount=7, unplacedCount=65, sheetCount=1, terminationReason=deadline, elapsedMs=5850.
- Chốt mới trả: "Đơn hàng chưa đủ: mới xếp 7/72 tem, còn thiếu 65 tem. Chưa thể xuất file sản xuất; hãy tiếp tục tính hoặc kiểm tra khổ giấy và thiết lập xếp."
- Đây là bằng chứng chốt SL, KHÔNG phải bộ xếp đã tạo đủ 72 mẫu.
- Hai integration test kiểm chốt entrypoint xác nhận writer/commit không được gọi khi thiếu.

### Mức hoàn thành / phần còn lại

- Đã kiểm tự động và gọi native thật, chưa thao tác trên cửa sổ desktop đang mở.
- Không đổi giao diện, không build native, không phát hành, không commit.
- Bộ kế hoạch số lượng mới chưa thay request/job identity native đang dùng. Chỉ cổng kiểm đủ SL đã được nối vào production.
- Lô tiếp theo cần dựng phương án nền nhiều tờ đủ hàng; các lô UI/preview/report và áp hệ số lặp vào handover vẫn còn.
- Không được báo tính năng "72 mẫu xếp đủ nhiều tờ" hoàn thành từ các test số lượng thuần ở lô này.

### Kiểm runtime dành cho chủ dự án

Với bản dev đã nạp mã mới: Bình tem bế -> N-Up -> Xếp tự do -> SL mỗi loại=1.
Nếu lượt preview vẫn thiếu mẫu do deadline, khi thực thi phải báo rõ số còn thiếu và không tạo PDF sản xuất thiếu hàng.
Đơn hàng đầy đủ vẫn đi đường xuất cũ. Bước chờ giữa các lô sau đó đã được người dùng bỏ bằng yêu cầu "làm hết luôn đi".

## Hoàn thiện B–E — người dùng yêu cầu làm liên tục

Chỉ đạo mới: "làm hết luôn đi". Theo yêu cầu này, không dừng chờ xác nhận giữa các lô; vẫn chia thay đổi nhỏ và tự kiểm chứng.

### B. Phương án nền đủ số lượng

- Thêm imposition_core/src/mixed_nesting/baseline/quantity_seed.rs; nối vào baseline production quantity, baselineVersion=14.
- Seed dùng khung bao bảo thủ để dựng phương án đầy đủ nhanh, nhưng giữ nguyên contour và miền xoay; chỉ nhận seed qua validator hình học thật.
- Không áp vào autofill/S&R. Trường hợp có zone hoặc seed không tìm được phương án vẫn đi NFP cũ, không suy ra vô nghiệm từ bbox.
- Số lượng có hệ số chung được thử theo bố cục cơ sở; chỉ lặp khi không còn chỗ dùng được. Nếu còn chỗ trống hoặc vượt giới hạn tờ, dàn toàn bộ số lượng để tránh nhân giấy thừa.
- Native vẫn công bố ĐẦY ĐỦ placements/instanceId/sheetIndex cho đơn hàng gốc. Không thay manifest bằng một bản cơ sở thiếu số lượng.
- Kiểm 72/9 -> 8 tờ; 72 x 100 -> 800 tờ/7.200 con; 73 loại có tờ cuối; 2 loại x 100 không bị biến thành 100 tờ mà dùng 23 tờ ở fixture 9 con/tờ.
- Không giảm worker trên máy mạnh, không tắt cancel/validator, không thêm LTO.

### B bổ sung. Admission bộ nhớ

- Gặp lỗi thật ở ca 7.200 tem: công thức cũ nhân instance_count x max_sheets, báo hơn 15 GB.
- Kiểm native: mỗi placement thuộc một tờ; validator tạo spatial grid từng tờ rồi bỏ, không có ma trận instance x số tờ.
- Mô hình v5 tính contour theo quantity có trọng số, placement ledger, header tờ và geometry per-worker; giữ check RAM và NFP cache budget.
- Fixture 72 loại x 100, 16 CPU / 32 GB: vẫn grant 15 worker, ước lượng khoảng 3.149 MB.
- Test RAM tier, góc tự do, số lượng và giới hạn admission tiếp tục đạt.

### C. Đầu vào giao diện

- Profile Bình tem bế mới mặc định SL=1 và Xếp tự do, kể cả mở trực tiếp hoặc chuyển từ cắt xén.
- Không ghi đè profile cũ hay SL của công cụ khác.
- Thêm MỤC ĐÍCH: Đủ số lượng · Tự chia nhiều tờ / Lấp đầy một tờ mẫu.
- Xóa ô SL trong chế độ đủ lượng không âm thầm đổi sang một tờ. Khi tạm chọn lấp đầy rồi quay lại, khôi phục SL trong cùng tài liệu; đổi tài liệu không phục hồi SL của file cũ.
- ID control riêng từng component/tab. Không thay mặc định S&R, CNC, cắt xén.
- Profile cũ SL=0 vẫn thể hiện rõ là Lấp đầy một tờ mẫu; người dùng chọn Đủ số lượng để chuyển sang workflow mới.
- Nếu global SL dương nhưng mọi override đều 0, báo không có mẫu cần giao, không đổi ngầm sang autofill.

### D. Preview mọi bố cục

- Dùng production_sheet_recipes chung với writer, dựa trên partId + pose f64 lossless + RenderBundleHash.
- Trả sheets[] cho tất cả bố cục đại diện, runCount từng bố cục và orderSummary (số bố cục / số tờ vật lý / yêu cầu / đã xếp).
- totalItems của preview đơn hàng là số con trên bố cục đang hiển thị, không phải tổng số tem toàn đơn hàng.
- Giao diện đổi được từng bố cục và hiển thị số lần in, ví dụ "Bố cục 1/8 · In 100 tờ".
- Chốt thiếu lượng trước khi công bố preview như một kết quả sản xuất.
- Nếu diện tích mẫu chắc chắn vượt một tờ hoặc zone chia đều, trả hướng dẫn chọn Đủ số lượng/Xếp tự do thay vì lỗi thử lại chung. Đây chỉ là điều kiện cần, không kết luận hình vừa tờ từ diện tích đơn thuần.

### E. Export, report và handover

- Tái dùng cơ chế recipe có sẵn của writer; không nhân bản thuật toán gộp hình học.
- Unique export chứa các bố cục đại diện cùng số lần in. Expanded export chứa đúng mọi tờ vật lý, với mặt in/CUT tương ứng.
- Report phân biệt số bố cục và số tờ, có số lần in cho từng bố cục.
- Preview/export cùng manifestId và layout fingerprint. Đơn hàng gốc vẫn nằm trong request và native manifest đầy đủ, nên không cần nới provenance hoặc thêm metadata ngoài hash để áp hệ số lặp.
- Số lượng khác nhau được đối soát đúng từng loại; không làm tròn/in dư tự động.
- Số recipe tối thiểu không được cam kết cho mọi bài: các pose tối ưu khác nhau có thể tạo recipe khác. Test expanded kiểm đúng tổng tờ; test 72 x 100 vẫn khóa đúng 8 recipe x 100.

### Kiểm chứng cuối

- Rust: 112 test đạt (50 lib + 8 deadline/budget + 13 rotation + 41 solver).
- Frontend: 151 test đạt trong 7 file; TypeScript typecheck đạt.
- Backend: lượt chốt cuối 359 passed, 1 skipped, 1 cảnh báo Pydantic deprecation có sẵn; 77,15 giây.
- Test mới có native THẬT và PDF writer THẬT: 72/9, 72 x 100, 73 loại, expanded 18 x 2, SL riêng 10/20/30 và override toàn 0.
- Một assert của test expanded ban đầu ép 2 recipe nhưng solver hợp lệ chọn 4 pose-layout khác nhau. Đã sửa test đúng mục tiêu 4 tờ vật lý, không đổi production để ép test. Ca 72 x 100 vẫn kiểm cố định 8 bố cục/800 tờ.
- Đổi expected baselineVersion 13 -> 14 là có chủ đích; không cập nhật golden hình học mù.
- Đã build wheel release-dev bằng maturin (không LTO), cài vào backend/venv. Native capabilities xác nhận baselineVersion=14.
- Pip giữ lại thư mục native cũ đang bị process mở khóa; không cưỡng bức xóa/kill process. Có bản sao native cũ tại workspace tmp/m72-native-backup.
- Không commit, push, đóng gói installer hoặc phát hành; giữ nguyên thay đổi không liên quan của người dùng.

### File 72 mẫu thực

Cấu hình: A3 lỡ 320 x 430, lề 5, hở 2, boong 5 mm cách mép 7 mm, SL=1, Xếp tự do.
- Đủ 72/72, không unplaced.
- 3 bố cục: 30 + 29 + 13 mẫu; mỗi bố cục in 1 lần.
- PDF: 6 trang = 3 trang in + 3 trang CUT, khoảng 303 MB (nguồn khoảng 302 MB).
- Native validator valid=true, version=2.
- Preview và export cùng manifest b008ea52d43cc052096a9050e2c19e02.
- Preview khoảng 14,04 giây; tổng build/preview/export khoảng 66,91 giây trong lượt QA. Không coi đây là cam kết thời gian trên mọi máy.
- Đã render bằng Poppler và xem đủ 6 trang: in/CUT khớp vị trí, đủ boong; không thấy chồng lấn/cắt cụt do bản bình.
- Output QA: D:/printsolutions-main/product/xep quan ao/output/pdf/sticker-72-multisheet.pdf.

### Đính chính mô tả lô A1

Writer cũ đã có chốt từ chối manifest.unplaced. Baseline test A1 dùng writer giả, chứng minh entrypoint vẫn gọi writer khi thiếu, KHÔNG chứng minh writer thật từng xuất PDF thiếu. Chốt mới của A1 bổ sung đếm độc lập từng loại/instance, kiểm thống kê và thông báo rõ trước writer.

### Kết luận

Các lô mã nguồn B–E đã hoàn tất cùng lô A1 trước đó. Đã cài native mới vào venv dev và kiểm phiên bản 14, không còn chốt chờ duyệt giữa các lô. Các fixture nghiệm thu và file thực đều được kiểm; không commit/phát hành. Cần nạp lại backend nếu process đang mở vẫn giữ DLL cũ.

### Giới hạn xác minh

Đã kiểm backend/native thật, artifact và UI tự động. Chưa thao tác trên cửa sổ desktop đang mở. Nếu phiên cũ đang giữ DLL, cần restart backend dev để nạp native mới; không tự đóng ứng dụng hoặc làm mất file đang xử lý.

## Cập nhật theo yêu cầu mới: bỏ Mục đích, N-Up trống SL = 1

Yêu cầu người dùng thay thế thiết kế Mục đích trước đó. Đã gỡ hoàn toàn control, state nhớ mode và các key i18n của control này; không chuyển nó vào thiết lập nâng cao.

- Dàn nhiều mẫu tem bế: SL chung trống/0 -> 1 mỗi loại; nhập số lượng thì dùng số đó. SL riêng được giữ; map toàn 0 của profile trống cũ được hiểu như chưa nhập.
- Không tự chọn autofill một tờ cho N-Up. Bình trang/S&R giữ ngữ nghĩa riêng trước đó.
- Lưới đơn giản dùng sticker_grid_order.py chung cho preview/export: lưới hàng/cột đều theo kích thước bao lớn nhất, đặt từng loại liên tiếp theo thứ tự trang rồi chuyển tờ.
- Không gọi true-shape nesting, offset/bin packing hay ghép vùng trên nhánh simple_auto.
- Chia cụm/vùng không áp dụng cho lưới đơn giản; UI vô hiệu hóa control khi chọn lưới, không xóa giá trị đã nhớ cho cách xếp khác.
- Giữ đường bế thật, nhíp, boong và hướng được phép. Worker kiểm lại bbox/boong nhưng không recenter/đổi hướng/bỏ mẫu sau khi plan lưới đã chốt.
- Những trang nhân bản đang materialize từ nguồn một trang có đủ nhãn logic trong preview; trường hợp không thể suy ra an toàn yêu cầu chờ PDF làm việc hoàn tất.
- Sửa nguồn SL hiệu dụng ở cả preview và export, giữ đúng tập trang đã chọn.
- Nhánh tối ưu cũ bổ sung sheetsNeeded còn thiếu trong response.

### Nguyên nhân lưới vẫn chạy ghép/nesting

Log thực 21:47–21:51: request gửi đúng simple_auto, nhưng backend đi is_nup_multi và exporter ghi strategy_used=Zone-Based N-Up with Interlocking. Predicate true-shape đã kiểm đúng optimal_auto; lỗi nằm ở nhánh ghép nhiều mẫu legacy không phân nhánh theo cách xếp. Bản sửa không chỉ đổi nhãn hay sửa dropdown.

### Kiểm chứng

- 252 test backend liên quan đạt; 199 test UI/định tuyến/profile đạt; TypeScript đạt.
- Test chủ động làm lời gọi MixedNestingRunHandle và compute_sticker_layout_for_page lỗi nếu nhánh lưới chạm tới: các ca lưới vẫn xuất PDF thành công.
- Fixture 72 loại: trống/1 -> 72 con; SL=2 -> 144 con. Danh sách placement là A,A,... rồi B,B,... đúng thứ tự nguồn.
- File thực hiện tại: Temp/PrynX-dev/results/sticker_84a47a12.pdf, 72 trang, khoảng 36,8 MB.
- Simple grid, SL trống, A3 lỡ 320 x 430, lề 5, hở 2, boong 5 mm: 4 tờ = 20 + 20 + 20 + 12 con.
- Kiểm đếm PDF có đúng 72 artwork; 8 trang gồm 4 in + 4 CUT; 0 lời gọi nesting trong probe.
- Preview và plan export có cùng absX/absY trong dung sai 0,002 pt. Đã xem đủ 8 PNG render.
- Probe preview + dựng plan khoảng 0,81 s, tổng xuất khoảng 2,14 s trong lượt đo này; không so trực tiếp với file cũ khác dung lượng.
- Output: D:/printsolutions-main/product/xep quan ao/output/pdf/sticker-simple-72.pdf.
- Không đổi Rust/DLL trong lượt này, không commit hoặc phát hành. Chưa thao tác trực tiếp trên cửa sổ desktop đang mở.
