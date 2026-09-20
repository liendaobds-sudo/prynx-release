# Bình tem bế - nhật ký sửa BE.01–BE.08 (2026-09-20)

Trạng thái: đã triển khai đủ 8 nhóm được duyệt; SOURCE + AUTO + ARTIFACT. Chưa nghiệm thu GUI desktop/installer/máy bế. Người dùng yêu cầu “sửa hết đi”, cho phép tiếp tục các lô đã duyệt mà không dừng lại giữa từng lô.

## Kết quả theo finding

| Finding | Thay đổi | Bằng chứng sau sửa |
|---|---|---|
| BE.01 | N-Up nguyên tấm có boong chọn ô hợp lệ trước phân tờ; writer kiểm lại và không được bỏ mẫu âm thầm | 9 loại với boong 5 mm: sequential 5+4; cut_stacks 5+5, một bản in bù; preview/plan/PDF cùng danh tính và vị trí |
| BE.02 | Helper đối soát lượng của packer tính cả runCount; preview trả 422 và export dừng trước writer nếu thiếu | Mẫu 300x70 không vừa vùng 216x216 bị từ chối rõ “mẫu 2 thiếu 1”, không tạo PDF thành công thiếu mẫu |
| BE.03 | Manual dùng đúng rows/cols; có kế hoạch S&R riêng, batch capacity dùng cùng helper; chia cụm ẩn không tác động lane lưới | 10 mẫu manual 2x2 → 4+4+2. S&R 12 bản → một recipe 4 ô x3 lượt. Quá khổ/rows không hợp lệ báo lỗi |
| BE.04 | Chuẩn hóa unit/task/layout trong setter, profile, restore và preset; Dashboard có safety net; backend chặn stack layout ở Từng tem | Chuyển page_sheet cut_stacks→sticker mở lại SL, giữ 100 và SL riêng; tab/công cụ khác không bị sửa |
| BE.05 | Bỏ heuristic map toàn 0 thành trống; thiếu key/trống khác số 0 tường minh | SL chung None/chuỗi trống/0 + loại 0=0 chỉ in các loại còn lại; tất cả loại=0 bị từ chối |
| BE.06 | N-Up tối ưu một loại dùng kế hoạch lượng chung, vẫn gọi tiler tối ưu; tách capacity với số đã đặt | 0/1/2/30 bản đúng lượng; preview khớp CUT, report và artifact. Kiểm thêm xoay 90°/mm lẻ bằng raster |
| BE.07 | Report theo từng recipe thực và số lần in; summary đối soát requested/placed/extra. Cut-stack không đọc SL cũ bị khóa | 30 bản không còn ghi36; tờ bù ghi3. Cut-stack70/SL ẩn100 ghi yêu cầu70, đã xếp80, in bù10; không còn7000 |
| BE.08 | Gộp tờ theo nguồn + vị trí + kích thước + hướng; unique và expanded dùng cùng recipe | 30 bản/capacity9: preview2 recipe chạy3+1; unique2 cặp IN/CUT, expanded4 cặp; không bỏ tờ bù |

## Các file/biên chính

- backend/app/workers/nup_order_safety.py: chốt coverage tại packer/writer.
- backend/app/workers/sticker_nup_policy.py: lượng trống/0 và tổ hợp layout hợp lệ.
- backend/app/workers/sticker_grid_order.py: plan simple/manual, manual S&R, optimal N=1, page_sheet có boong; recipe/unique/runCount.
- backend/app/workers/sticker_order_report.py: report lấy từ placements x runCount.
- backend/app/workers/nup_engine.py, nup_process_chunk.py, nup_output_finalize.py: nối plan, safety gate, report snapshot và kết quả.
- backend/app/api/routes/imposition.py: dùng cùng plan trong preview và bảng capacity manual; lỗi cấu hình trả422.
- Desktop store/profiles.ts, nupSlice.ts, workspaceSlice.ts, ImposerDashboard.tsx, AdvancedSettingsSection.tsx: trạng thái theo unit và grouping hiệu lực.
- Thêm test sticker_order_safety / pont_order / quantity_policy / manual_order / single_order / order_report; store transition + Dashboard/panel integration.
- Giữ nguyên thay đổi không liên quan của người dùng/phiên khác, không commit hay phát hành.

## Các vòng hồi quy đã giải quyết

1. Test cũ coi N-Up trống là autofill: cập nhật theo yêu cầu một bản mỗi loại. Test autofill vẫn giữ ở đúng Bình trang/S&R.
2. Fixture map toàn0 không đại diện cho ô trống nữa: fixture lượng hoạt động khai1 hoặc bỏ key, giữ test loại0 riêng.
3. Unique không có nghĩa luôn đúng một tờ: giữ cả tờ bù khác hình học.
4. Lane mới phải giữ đăng ký artwork vào khuôn chung, không chỉ dùng bbox master. Đã nối homogeneous master cho simple/manual và kế thừa master trong manual S&R. Test đo diện tích mực raster thật và đúng một trang CUT chung.
5. Giữ dung sai hình học 1e-4 pt; test mới dùng contour top-down do preview trả thay vì lật absY bằng chiều cao transport có hệ số mm/pt khác. Mapper live được dùng ở nhánh kế hoạch; không nới tolerance để ép xanh.
6. Một lượt rộng handover process con thất bại khi file native trong venv có mtime cập nhật lúc06:47:50 trong khoảng chạy. Rerun riêng đạt; lượt nghiệm thu cuối gồm test này cũng đạt. Không gỡ gate manifest hoặc đổi native trong đợt sửa này.
7. Đã kiểm thêm preset/state cũ và preview các thumbnail nhân bản đang chờ materialize cho manual S&R; không đọc nhầm loại0 cho mọi thumbnail.

Các lượt kiểm theo lô có số ca chồng lấp; không cộng chúng vào tổng cuối.

## Nghiệm thu cuối

- Backend: **1005 passed**, 1 warning Pydantic class-based config có sẵn, 147,74 giây. Gồm toàn bộ ma trận đã audit + test mới, sheet-plan writer parity và Inking.
- Frontend: **342 passed / 28 file** trong imposition-tools.
- TypeScript: npm run typecheck đạt.
- git diff --check phạm vi sửa đạt; không update golden/snapshot hàng loạt.
- Không đổi Rust, worker cap hoặc cài native trong lượt này.

### File khách thật

Nguồn: C:/Users/Khanh Pham/AppData/Local/Temp/PrynX-dev/results/sticker_0ab357d0.pdf, 72 trang, 36.756.120 byte.

Cấu hình kiểm: tờ320x430 mm; lề8 mm; hở0; bleed0; boong tròn5 mm, cách mép7 mm; report bật; separate IN/CUT; unique bật.

- **Từng tem / simple_auto / SL trống:** 24+24+24, đủ72 loại và đúng72 artwork, 6 trang PDF (3 IN+3 CUT), 0 gọi nesting. Xếp theo khung đường bế thật, không theo ô trang70x70.
- **Nguyên tấm / cut_stacks:** 20+20+20+20, đủ72 loại,80 artwork,8 bản bù; 8 trang PDF (4 IN+4 CUT),0 gọi nesting. Sau gom cọc đúng1..72 rồi1..8.
- Đối chiếu source index của mọi Do trong PDF với preview; số lượng từng loại và vị trí plan khớp. Report PDF cộng ra đúng72/80.
- Render Poppler60dpi, đã xem đủ14 trang IN/CUT, không thiếu ô/khuôn, boong giữ đúng và report không đè artwork.
- Probe ban đầu đã giả định nhầm cả hai mode có4 tờ; sửa oracle lấy số tờ từ hình học. Không sửa thuật toán để ép Từng tem về20 ô.

Artifact:
- D:/printsolutions-main/product/xep quan ao/output/pdf/sticker-audit-fixed-72-simple.pdf
- D:/printsolutions-main/product/xep quan ao/output/pdf/sticker-audit-fixed-72-cut-stack.pdf

Probe: workspace/tmp/verify_sticker_audit_fixed.py; PNG: workspace/tmp/pdfs/sticker-audit-fixed/.

## Giới hạn và bàn giao

- Chưa thao tác trực tiếp trên cửa sổ desktop đang mở; chưa kiểm bản cài, Illustrator/CorelDRAW/Graphtec hoặc máy bế vật lý.
- Không phát biểu “toàn công cụ không còn bug”; chỉ đóng8finding đã xác nhận với phạm vi bằng chứng trên.
- Cần nạp lại preview/cấu hình trong app để kiểm tay; không tự restart/kill ứng dụng hoặc gửi lệnh in.
- Không đoán profile cũ có số0 là ý định trống: số0 đang hiển thị được giữ đúng là loại bỏ; người dùng có thể xóa ô để dùng lượng chung.

## Hồi quy MARGIN-PARITY: 72 loại, preview 4 tờ nhưng xuất 3 tờ

### Bằng chứng và nguyên nhân

- Ca khách: Bình tem bế / Nguyên tấm decal / N-Up lần lượt / optimal_auto; 72 loại, khổ nguồn 70x70 mm, giấy 320x430 mm, hở/bleed 0, boong 5 mm.
- Log job 4825041c lúc 14:08 ngày 20/09: preview_capacity=20 nhưng solver xuất capacity=24; vùng in được ghi là 304x414 mm.
- PDF lỗi nup_4825041c.pdf thực ra đủ 72 loại: 1..24, 25..48, 49..72. Không mất loại 61..72; engine tự đổi kế hoạch từ 4 sang 3 tờ.
- Nhánh planner mới đọc lề gốc trong settings, bỏ qua lề hiệu dụng đã được engine cộng phần dấu xén. Preview gửi lề hiệu dụng nên hai đầu lệch nhau. Bộ test trước đây dựng settings xuất từ request preview, vô tình che lỗi này.

### Bản sửa

- nup_engine chuyển bản sao settings chứa lề hiệu dụng của chính writer cho cả planner N-Up và manual S&R; không tính lại công thức, không cộng nhíp/dấu xén lần hai, không sửa settings gốc.
- sticker_grid_order ghi rõ hợp đồng lề đầu vào. Không đổi thuật toán nesting, hướng tem, chính sách số lượng, xếp chồng in bù hay source geometry.
- Test mới gửi lề gốc và include_marks cho export, gửi lề hiệu dụng cho preview. Phủ simple/optimal/manual, sequential/cut_stacks, tắt dấu xén, labels_only, lề đã hiệu dụng, lề bất đối xứng + nhíp, lưới manual vượt vùng in, PDF thật với cả guillotine/corners.

### Kiểm chứng

- Trước sửa: 2 test đầu thất bại đúng lỗi 3 != 4.
- Sau sửa: 13 test hồi quy mới đạt; bộ 28 file liên quan đạt **300 passed**, 1 warning Pydantic có sẵn, 23,53 giây. Sandbox chặn Named Pipe khi spawn worker; chạy lại ngoài sandbox thành công, không thay worker cap.
- Nguồn khách thật: C:/Users/Khanh Pham/AppData/Local/Temp/PrynX-dev/results/sticker_0fb7e451.pdf.
- Tái xuất qua writer sản xuất: **20+20+20+12**, đủ 72 loại đúng một lần; tờ cuối là loại 61..72; **8 trang PDF = 4 IN + 4 CUT**.
- Kiểm mọi source index và ma trận đặt artwork trong PDF khớp preview với dung sai 0,002 pt; report cuối đúng 12 mẫu, bố cục 4/4. Render Poppler và xem đủ 8 trang, gồm dấu xén, boong và khuôn cuối.
- Artifact: D:/printsolutions-main/product/xep quan ao/output/pdf/sticker-72-four-sheets-fixed.pdf.
- Probe: workspace/tmp/verify_sticker_margins_72.py. Không sửa file nguồn hoặc ghi đè PDF lỗi của khách.
- Chưa bấm lại trực tiếp trên cửa sổ desktop; chưa build bản cài/restart ứng dụng, chưa kiểm máy in/bế vật lý. Không đổi frontend/Rust nên không chạy lại typecheck/Cargo.
