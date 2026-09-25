# Sửa chất lượng và hiệu năng đường cắt — 24/09/2026

Người dùng duyệt toàn bộ bằng yêu cầu **“sửa hết đi”** sau
[báo cáo audit](BAO_CAO_AUDIT_CHAT_LUONG_HIEU_NANG_DUONG_CAT_2026-09-24.md).
Triển khai theo lô nhỏ có verify; không commit, build hay phát hành.

## Phạm vi đã áp dụng

| Finding | Thay đổi | Bằng chứng |
|---|---|---|
| CUT24.01 | AUTO dùng cùng reducer cho đường đã fit/bo tròn; xuất tái dùng memo preview | Hai integration test Binder2 trang12, original/round, cấm gọi lại solver và so từng lệnh SVG đọc từ PDF |
| CUT24.02 | Bỏ gate >100 cubic, hoàn nguyên subdivision trước fit | Cùng quỹ đạo16/128 đều còn7; mẫu scale3 đều còn15, vẫn kiểm band/topology/độ cong |
| CUT24.03 | Bỏ cap span12/24; quy hoạch động loại cạnh không thể cải thiện số lệnh; giữ seam | Polygon128/256 còn4; circle32 còn4–5 tùy seam được giữ |
| CUT24.04 | Xếp hạng mọi candidate hợp lệ theo độ liên tục/độ cong và số node; exact budget ưu tiên hơn fallback | Hai regression flower12/3 giữ budget0,29718mm, không khớp gãy/đoạn ngắn, jump độ cong <1e-6/mm |
| CUT24.05 | Seed dựng lười, tái dùng dữ liệu chiếu nguồn bất biến và seed gốc khi fallback | A/B cùng source73: kết quả56 khớp tuyệt đối;23,6577→16,5574s trong một phép đo |
| CUT24.06 | Scope runtime getter/setter BLAS và OpenCV theo ngân sách planner | NumPy/SciPy/OpenCV16→1→16; env giữ nguyên; phục hồi khi lỗi/hủy |
| CUT24.07 | Bỏ cache stat chết, hash nội dung thật; tái dùng digest trong một bước | Rewrite cùng size/mtime vẫn phát hiện; không nuốt NameError/I/O |
| CUT24.08 | Checkpoint hủy trong verifier và topology | Hủy sau metric đầu không tiếp tục metric2/distance; guard và độ sâu giữ nguyên |
| CUT24.D01 | Flatten sau CTM/UserUnit theo cận0,02mm; model/emitter giữ line/cubic | Cùng vòng4cubic, hai cách mã hóa PDF cùng4cubic ở PDF/SVG; protocol line sai lệch mẫu0,008179mm |
| NODE.1 | Frontend gửi denoise theo từng trang, giữ giá trị0 khi export | Vitest API/store và backend denoise cache/rebuild/đảo trang |
| Phản hồi UI | Hiển thị số neo và cận sai lệch thêm của preview hiện hành | Không hiện số đo frame cũ khi đang cập nhật; không thêm slider bắt người dùng cấu hình |

## Các chốt hình học

- Không nới dung sai, bỏ kiểm tự giao/lỗ/góc, giảm chất lượng theo số node hay hard-cap tài nguyên máy mạnh.
- Ngân sách fit nguồn raster và dung sai Simplify bổ sung là hai đại lượng khác nhau.
- Góc có chủ ý của artwork vẫn được bảo vệ; không ép mọi hình thành đường trơn.
- “Ít node” là tối ưu trong tập ứng viên đã chứng nhận, không phải chứng minh cực tiểu trên mọi đường Bézier.
- PDF/SVG hỗ trợ Bézier nên giữ primitive; protocol chỉ có line cần chia đoạn, còn sai số lượng tử của thiết bị.

## Nhật ký lô và kiểm thử

- [Lõi hình học](audit/CUTLINE_QUALITY_2026-09-24/fixes/geometry.md).
- [Hiệu năng, cache, hủy](audit/CUTLINE_QUALITY_2026-09-24/fixes/performance.md).
- [Hạ nguồn máy cắt](audit/CUTLINE_QUALITY_2026-09-24/fixes/downstream.md).
- Root lô parity:2test pass; lô frontend NODE.1:34test pass; lô lựa chọn C2:67test cũ và2regression mới pass.
- Frontend cuối: typecheck đạt;5file Vitest **129pass**; ESLint6file thay đổi đạt.
- Bốn lỗi baseline audit thuộc kỳ vọng số node lịch sử122/364/46. Chuyển sang hợp đồng thực: preview=PDF=ProcessPool, giảm so với nguồn/pairwise, cận sai lệch, không thêm gãy/đoạn ngắn. Không đổi snapshot/golden để ép xanh.

## PDF và đo lại kết quả

`fixes/verify_artifacts.py` tái dùng đúng harness audit; bằng chứng trước sửa không bị ghi đè. PDF sau sửa nằm ở `output/pdf/Cutline-quality-fixed-2026-09-24/`.

| Binder2 trang12 | Trước Simplify | AUTO sau sửa | Cận liên tục từ bộ kiểm | Đo mẫu dày độc lập |
|---|---:|---:|---:|---:|
| Giữ góc, offset2mm | 73 | 56 | 0,099376mm | 0,098029mm |
| Bo tròn, bleed2mm | 51 | 45 | 0,092625mm | 0,090178mm |

Hash pixel artwork khớp từng ca; SHA256 PDF nguồn vẫn `4c2a730ba4f0857847b46faf2e798f78c001f1615a8cd946686bcc53aa508c10`. Đã render/soi [hình đối chiếu neo](../output/pdf/Cutline-quality-fixed-2026-09-24/doi_chieu_neo_sau_sua.pdf). PDF giữ nguyên góc thật của nguồn.

Ca flower12 của live fitter giảm104→101node, nhảy độ cong6,15→xấp xỉ0/mm, lệch nguồn0,1524→0,2453mm trong budget0,29718mm. Chi phí chọn thêm candidate0,019→0,124s. Flower3 tương ứng16→15node và0,004→0,022s; ghi rõ đổi chất lượng lấy thời gian, không gọi fitter này nhanh hơn. Xem [đo live fitter](audit/CUTLINE_QUALITY_2026-09-24/fixes/live_fitter_measurement.md).

Phép đo tốc độ là N=1 trên cùng máy, không đại diện mọi PDF; bỏ cap span có thể tốn thêm thời gian để đạt ít node hơn. Cold export trang12 giữ góc trong lượt artifact là21,94s (có tác vụ kiểm thử khác trên máy), bo tròn2,63s; không đem so tỷ lệ với audit khác điều kiện. Chưa nghiệm thu Tauri GUI, binary đóng gói hoặc máy cắt vật lý.

## Kết quả kiểm tích hợp cuối

- Bộ backend937ca: **932pass,3skip,2fail do fixture PDF giả**,415,40s. Giữ nguyên XML lần đầu ở `fixes/backend_final.xml`.
- Sửa riêng fixture header PDF thành PDF hợp lệ, giữ parser thật và assertion cấm detect/fit lại. **Cả7ca dùng helper đạt**, gồm2ca lỗi ban đầu, đổi byte cùng size/mtime và snapshot/cache trên hai mức RAM. Không đổi production để né lỗi. XML `preview_fixture_consumers_recheck.xml` và [nhật ký](audit/CUTLINE_QUALITY_2026-09-24/fixes/preview_fixture.md).
- Tổng hợp ID test duy nhất sau lần kiểm lại: **934pass,3skip,0lỗi còn mở**. Ba skip thuộc artifact nghiên cứu trang12 cũ không có trên máy; các ca Binder2 thực hiện hành, AUTO/memo/ProcessPool đều chạy.
- Frontend: **129pass**, typecheck và ESLint phạm vi thay đổi đạt. Không cập nhật golden/snapshot.
- `git diff --check` đạt; các thay đổi Viewer/Settings/Tauri của task khác được giữ nguyên. Không chạm Rust nên không chạy Cargo/build sidecar cho đợt này.
- Manifest khóa hash source/PDF và đối chiếu đúng ID lỗi đã kiểm lại: [final_manifest.json](audit/CUTLINE_QUALITY_2026-09-24/fixes/final_manifest.json).

**CUT24.01–08, CUT24.D01 và NODE.1 đã áp dụng và xác minh ở mức SOURCE + AUTO + ARTIFACT trong phạm vi trên.** Việc nghiệm thu ứng dụng Tauri/bộ cài và dao vật lý vẫn cần lượt runtime riêng; chưa gọi kết quả này là kiểm máy thực tế.
