# CUT24.D01 — Máy cắt: giữ đường cong và cận mm

User duyệt sửa toàn bộ finding. Không commit; ownership `backend/app/workers/cut_export/**`.

## D1 — CTM và flatten có cận (4 file production/test)

- `geometry.py`: thay chia đều có hard-cap + RDP bằng chia đôi de Casteljau. Cận hiệu cubic/chord cùng tham số `0.75*max(norm(delta_control1),norm(delta_control2))`; đạt trên toàn đoạn, không chỉ mẫu. Dung sai mặc định0.02mm; không cắt bớt số bước vì máy mạnh/yếu.
- `cut_layer_extractor.py`: biến đổi control points qua CTM/Form/UserUnit trước khi flatten bằng đơn vịmm. Chuẩn hóa UserUnit vào tọa độ point vật lý và kích thước khung.
- `pdf_source.py`: không cộng thêm RDP0.03mm; giữ closed/hở và thứ tự vòng lỗ. Kích thước tờ tính UserUnit.
- `test_cutline_quality.py`: regression unit-coordinate+CTM, Form, UserUnit, đường hở, cubic vòng kín/quay đầu và dung sai không hữu hạn.

Verify D1: geometry, quality, pdf_source, extractor **44 passed /1.47s**. Chưa kết luận emitter giữ cubic ở lô này; D2–D3 tiếp tục mô hình primitive và writer.

Artifact D1: `downstream_D1/downstream_ctm_evidence.json`. Cùng4 cubic r100mm, cả2 cách biểu diễn CTM cho polyline sai lệch mẫu khoảng0.008179mm; ca normalized trước sửa là3.494355mm. D1 còn xuất line, chưa là kết quả cuối.

## D2 — primitive và registration (5 file production/test)

- `CutPath` giữ tuple primitive line/cubic và polyline tương thích protocol hiện có; primitive là nguồn sinh polyline có cậnmm. Snapshot kiểm points legacy để không phát primitive cũ nếu caller sửa trực tiếp points.
- Extractor giữ control points sau CTM, line/curve/rect/closed; source PDF đưa primitive vào model bằngmm. Vòng lỗ giữ thứ tự/winding, đường hở không bị ép kín.
- Registration affine biến đổi cả primitive và dựng lại polyline sau affine, để cận0.02mm không phình theo hệ sốscale.
- Regression gồm affine phản chiếu/shear/scale, hở, lỗ/winding, stale points. Verify **67 passed /2.50s**.

## D3 — PDF/SVG giữ cubic (4 file production/test)

- PDF emitter dùng curveTo; SVG dùng C và lật cả tay nắm theoY. Không tăng node khi format đích hỗ trợ curve.
- Protocol HPGL/PLT và DXF polyline dùng points đã flatten có cận. Test đọc lệnh máy sau affine, so sai số dưới0.02mm cộng cận làm tròn PLU `sqrt(2)/(2*resolution)`.
- Proof RAM tính thêm control point và snapshot points; không đổi policy cap/worker/RAM.
- Verify vector/command/registration/quality **45 passed /0.56s**. Một lần fail do fixture truyền `name` không phải field MachineProfile; sửa fixture theo schema thật, không nới oracle hay đổi production để test xanh.

## D4–D5 — chốt contour và primitive (mỗi lô ≤4 file)

- Parser giữ đúng `s` chỉ đóng subpath cuối, không ép đường hở có endpoint sát nhau thành đường kín; `v` sau đổi CTM giữ current point vật lý. Lỗi chứng nhận trong nested Form phải báo lỗi, không nuốt rồi bỏ mất một vòng.
- Primitive bị caller legacy thay points hoặc thay segments không được dùng như geometry còn hợp lệ.
- Vòng/lỗ cubic rất nhỏ vẫn phải còn winding: tính diện tích có dấu bằng tích phân đa thức cubic, giảm riêng dung sai flatten nếu polyline làm mất/đảo chiều vòng. Không bỏ vòng bé để giảm node.
- Full cut_export + kiểm SVG metadata: **201 passed /6.67s**, 2 warning Pydantic/Starlette có sẵn. Log `downstream_tests.txt`. `git diff --check` đạt (chỉ cảnh báo CRLF khi Git chạm file).

## Kết quả artifact cuối và phạm vi

`downstream_final/downstream_ctm_evidence.json` và4 PDF: cả physical coordinates lẫn normalized+CTM đều giữ **4 cubic →4 cubic,0 line** trong PDF tái xuất. Polyline dùng cho protocol có257 points, sai lệch mẫu khoảng **0.008179mm**; trước sửa normalized có12 line và sai lệch3.494355mm. Số đo mẫu không thay thế cận liên tục0.02mm trong thuật toán. SVG được test đọc lại đủ cubic/control points sau affine; command stream được kiểm sau lượng tử PLU.

Đã rà consumers: PDF/SVG giữ primitive; DXF LWPOLYLINE và HPGL/PLT dùng polyline được chứng nhận; registration tạo model mới và reflatten sau transform; reorder/song đạo đọc points rồi giữ nguyên path; inspect proof lưu model trong RAM và đã tính thêm phần dữ liệu primitive. Không sửa frontend, native, thiết bị hoặc protocol unsupported. Chưa chạy GUI/dao vật lý; không chứng nhận gia tốc/jerk hay tối ưu tuyệt đối số lệnh máy.

Review chốt metadata: đối chiếu HEAD cho thấy builder PDF trước đây mặc định mọi `block_id=0` và `tool_tag=None`, không phải block theo index. Giữ đúng0/None, source_names và nhãn sau affine; thêm regression, quality suite **24 passed /0.67s** (có chồng bộ201 ở trên). `CutPath.bounds()` chưa có consumer placement/driver production trong phạm vi đã trace nên không mở rộng sang bbox analytic ngoài yêu cầu.
