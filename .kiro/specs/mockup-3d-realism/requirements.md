# Requirements Document

## Introduction

Tính năng này nâng cấp khung xem hộp 3D và mockup hiện có trong ứng dụng desktop (React 19 + @react-three/fiber 9 + @react-three/drei 10 + three 0.184) để chất lượng hiển thị và trải nghiệm tiệm cận với các phần mềm/plugin mockup phổ biến (Pacdora, Boxshot, Adobe Dimension, Esko Studio, KeyShot, plugin mockup PSD). Toàn bộ tính năng chạy phía client trong trình duyệt WebGL, không gọi backend, không thu thập telemetry.

Mục tiêu chính gồm: panel có độ dày trông đặc và bù độ dày khi gập; ánh sáng và môi trường HDRI tạo độ chân thực; thư viện vật liệu/finish chọn được; quy trình đặt ảnh nghệ thuật chính xác (theo từng mặt hoặc canh theo dieline, có hỗ trợ bleed/safe-area, hướng đúng); xuất ảnh render; các preset trình bày (camera, nền, sàn, exploded view, overlay kích thước); và đảm bảo hiệu năng mượt cùng việc KHÔNG gây hồi quy cho dieline 2D, các generator và bộ kiểm thử hiện có.

Tài liệu này định nghĩa các yêu cầu theo mẫu EARS và quy tắc chất lượng INCOSE. Các giả định được đánh dấu rõ ràng trong phần "Giả định".

## Giả định

- **GĐ-1**: Hệ thống được nâng cấp là khung xem 3D `DielineScene3D` và bảng tham số `ParamPanel`; không thay đổi cấu trúc dữ liệu `Panel`/`DielineModel` do các generator tạo ra.
- **GĐ-2**: Đơn vị tọa độ dieline là milimét (mm); độ dày vật liệu lấy từ `params.T`.
- **GĐ-3**: Khi WebGL hoặc tài nguyên HDRI không khả dụng, Hệ thống vẫn phải hiển thị ở chế độ suy giảm chức năng (degrade gracefully) thay vì gây lỗi treo ứng dụng.
- **GĐ-4**: Ảnh nghệ thuật do người dùng cung cấp ở định dạng PNG, JPEG hoặc WebP và được nạp phía client qua object URL.
- **GĐ-5**: "Khung hình tương tác" được hiểu là tốc độ khung hình trung bình tối thiểu 30 FPS với số lượng panel điển hình (≤ 24 panel).
- **GĐ-6**: Việc thêm thư viện postprocessing là tùy chọn và chỉ thực hiện khi có lý do kỹ thuật rõ ràng; không bắt buộc cho phiên bản đầu.

## Glossary

- **Khung_Xem_3D**: Thành phần React render cảnh ba chiều của hộp dựa trên dieline, bao gồm Canvas, ánh sáng, camera và các panel gập.
- **Mockup**: Bản dựng 3D mô phỏng hộp thành phẩm có dán ảnh nghệ thuật và vật liệu, dùng để xem trước thiết kế.
- **Panel**: Một mặt phẳng của dieline có outline, đường cắt (CUT), đường cấn (CREASE) và quan hệ gập (pivotEdge, parent).
- **Độ_Dày_Vật_Liệu**: Bề dày của tấm bìa (`params.T`), tính bằng mm.
- **Bù_Độ_Dày_Nếp_Gập**: Cơ chế điều chỉnh vị trí/hình học panel khi gập để các panel không xuyên vào nhau hoặc hở khe do độ dày vật liệu.
- **Tường_Cạnh**: Bề mặt nối giữa mặt ngoài và mặt trong của panel dọc theo chu vi, tạo cảm giác panel đặc thay vì rỗng.
- **Vật_Liệu_Finish**: Thuộc tính bề mặt mô phỏng chất liệu và gia công, ví dụ kraft, SBS trắng, cán mờ, cán bóng, spot-UV, foil/metallic, dập nổi (emboss).
- **Môi_Trường_HDRI**: Bản đồ ánh sáng dạng ảnh độ động cao dùng để chiếu sáng theo ảnh (IBL) và tạo phản chiếu cho cảnh.
- **Ánh_Sáng_Tương_Phản**: Tổ hợp đèn studio, bóng đổ mềm và ambient occlusion/contact shadow nhằm tăng độ chân thực.
- **Ảnh_Nghệ_Thuật**: Hình ảnh thiết kế do người dùng tải lên để dán lên các mặt của hộp.
- **Bleed_Safe_Area**: Vùng tràn lề (bleed) và vùng an toàn (safe area) của ảnh nghệ thuật theo chuẩn in ấn.
- **Xuất_Ảnh_Render**: Chức năng kết xuất cảnh 3D thành tệp ảnh (PNG) ở độ phân giải do người dùng chọn.
- **Preset_Camera**: Các góc nhìn định sẵn (mặt trước, từ trên, isometric, phối cảnh trực giao/orthographic).
- **Exploded_View**: Chế độ tách rời các panel theo trục để quan sát cấu trúc hộp.
- **Overlay_Kích_Thước**: Lớp chú thích kích thước hiển thị trong không gian 3D.
- **Dieline_2D**: Bản vẽ kỹ thuật phẳng và chức năng canvas/xuất 2D hiện có.
- **Generator**: Mã sinh hình học dieline cùng các API công khai của nó.

## Requirements

### Yêu cầu 1: Panel đặc với độ dày và tường cạnh

**User Story:** Là người thiết kế bao bì, tôi muốn các panel hộp trông đặc và có màu cạnh giấy thật, để mockup không bị rỗng hay hở mép như hiện tại.

#### Tiêu chí chấp nhận

1. THE Khung_Xem_3D SHALL render mỗi Panel với mặt ngoài, mặt trong và Tường_Cạnh khép kín dọc theo toàn bộ chu vi của Panel, sao cho không tồn tại khe hở nhìn thấy được giữa mặt ngoài, mặt trong và Tường_Cạnh tại mọi điểm trên chu vi.
2. THE Khung_Xem_3D SHALL gán cho Tường_Cạnh một màu cạnh giấy chọn từ đúng hai giá trị: kraft và trắng, với giá trị mặc định là kraft.
3. IF màu cạnh giấy không được chỉ định hoặc nằm ngoài hai giá trị hợp lệ (kraft, trắng), THEN THE Khung_Xem_3D SHALL áp dụng màu mặc định kraft và tiếp tục render.
4. WHEN Độ_Dày_Vật_Liệu thay đổi sang một giá trị nằm trong khoảng từ 0,1 mm đến 50 mm, THE Khung_Xem_3D SHALL cập nhật bề dày hiển thị của tất cả Panel sao cho khoảng cách đo được giữa mặt ngoài và mặt trong bằng giá trị `params.T` với sai số không vượt quá 0,01 mm.
5. WHERE một Panel có lỗ khoét (holes), THE Khung_Xem_3D SHALL render Tường_Cạnh khép kín dọc theo cả chu vi ngoài và toàn bộ mép của mỗi lỗ khoét, sao cho không tồn tại khe hở nhìn thấy được tại các mép lỗ khoét.
6. IF Độ_Dày_Vật_Liệu bằng 0, nhỏ hơn 0, hoặc không xác định, THEN THE Khung_Xem_3D SHALL áp dụng giá trị độ dày mặc định 0,5 mm và tiếp tục render.
7. IF Độ_Dày_Vật_Liệu lớn hơn 50 mm, THEN THE Khung_Xem_3D SHALL giới hạn bề dày hiển thị ở 50 mm và tiếp tục render.

### Yêu cầu 2: Gập có bù độ dày

**User Story:** Là người thiết kế bao bì, tôi muốn các panel gập khít mà không xuyên vào nhau hay hở khe, để mô phỏng gập phản ánh đúng hộp thật.

#### Tiêu chí chấp nhận

1. WHEN tiến trình gập (foldProgress, miền giá trị từ 0 đến 1) thay đổi, THE Khung_Xem_3D SHALL áp dụng Bù_Độ_Dày_Nếp_Gập cho mọi Panel có quan hệ gập, với giá trị bù tỉ lệ theo Độ_Dày_Vật_Liệu (miền hợp lệ từ 0,01 mm đến 5,00 mm), trong vòng tối đa 16 mili-giây kể từ khi foldProgress thay đổi.
2. WHEN tiến trình gập đạt giá trị 1 (gập hoàn toàn), THE Khung_Xem_3D SHALL định vị các Panel kề nhau sao cho độ giao cắt thể tích (interpenetration) giữa mọi cặp Panel không vượt quá 5% Độ_Dày_Vật_Liệu.
3. WHEN tiến trình gập đạt giá trị 1, THE Khung_Xem_3D SHALL định vị các Panel tạo thành thành hộp sao cho khe hở giữa các mép kề nhau không vượt quá 5% Độ_Dày_Vật_Liệu.
4. THE Khung_Xem_3D SHALL tính Bù_Độ_Dày_Nếp_Gập chỉ dựa trên quan hệ gập hình học (pivotEdge, parent, depth) của Panel, và SHALL không sử dụng quy ước đặt tên Panel làm dữ liệu đầu vào cho phép tính.
5. WHILE áp dụng Bù_Độ_Dày_Nếp_Gập, THE Khung_Xem_3D SHALL giữ nguyên thứ tự gập và quan hệ gập hiện có (foldPhase, depth) của mọi Panel, không thay đổi giá trị foldPhase và depth.
6. IF một Panel có quan hệ gập nhưng thiếu hoặc không hợp lệ một trong các thuộc tính hình học (pivotEdge, parent, depth), THEN THE Khung_Xem_3D SHALL bỏ qua việc áp Bù_Độ_Dày_Nếp_Gập cho Panel đó, giữ nguyên vị trí gập cơ bản của Panel, và phát tín hiệu cảnh báo cho biết Panel nào thiếu dữ liệu hình học.

### Yêu cầu 3: Ánh sáng và môi trường chân thực

**User Story:** Là người thiết kế bao bì, tôi muốn cảnh 3D có ánh sáng studio và phản chiếu môi trường, để mockup trông như ảnh chụp sản phẩm.

#### Tiêu chí chấp nhận

1. THE Khung_Xem_3D SHALL render một Môi_Trường_HDRI cung cấp chiếu sáng theo ảnh (IBL) và phản chiếu cho toàn bộ vật liệu trong cảnh.
2. THE Khung_Xem_3D SHALL cung cấp tối thiểu ba preset Môi_Trường_HDRI dạng studio để người dùng chọn.
3. WHEN người dùng chọn một preset Môi_Trường_HDRI, THE Khung_Xem_3D SHALL áp dụng preset đó và hoàn tất cập nhật chiếu sáng cùng phản chiếu của cảnh trong vòng 1 giây (1000 ms).
4. THE Khung_Xem_3D SHALL áp dụng tone mapping cho toàn bộ khung hình được render.
5. THE Khung_Xem_3D SHALL render bóng đổ mềm (soft shadow) cùng contact shadow tiếp xúc tại vùng chân hộp tiếp giáp mặt nền.
6. IF tài nguyên Môi_Trường_HDRI không nạp xong trong vòng 10 giây hoặc trả về lỗi nạp, THEN THE Khung_Xem_3D SHALL chuyển sang chiếu sáng bằng đèn studio mặc định, giữ cảnh ở trạng thái render được, và hiển thị cho người dùng thông báo trạng thái cho biết việc nạp HDRI đã thất bại.

### Yêu cầu 4: Thư viện vật liệu và finish

**User Story:** Là người thiết kế bao bì, tôi muốn chọn chất liệu và kiểu gia công bề mặt, để xem trước thành phẩm với kraft, cán mờ, cán bóng, spot-UV hay foil.

#### Tiêu chí chấp nhận

1. THE Khung_Xem_3D SHALL cung cấp thư viện Vật_Liệu_Finish gồm tối thiểu 6 lựa chọn: kraft, SBS trắng, cán mờ (matte lamination), cán bóng (gloss lamination), spot-UV và foil/metallic.
2. WHEN người dùng chọn một Vật_Liệu_Finish, THE Khung_Xem_3D SHALL áp dụng giá trị roughness và metalness tương ứng (mỗi giá trị nằm trong khoảng 0.0 đến 1.0) cho bề mặt hộp và cập nhật ảnh xem trước trong vòng tối đa 1 giây.
3. WHERE người dùng chọn finish spot-UV, THE Khung_Xem_3D SHALL giới hạn vùng bóng theo mặt nạ (mask) do người dùng cung cấp, áp dụng hiệu ứng bóng tại các điểm ảnh có giá trị mask lớn hơn 50% và giữ nguyên độ nhám của bề mặt nền tại các điểm còn lại.
4. WHEN người dùng chọn một Vật_Liệu_Finish, THE Khung_Xem_3D SHALL áp dụng Vật_Liệu_Finish được chọn cho toàn bộ các Panel của hộp.
5. WHERE finish dập nổi (emboss) được chọn, THE Khung_Xem_3D SHALL render hiệu ứng nổi/lõm trên bề mặt theo mặt nạ do người dùng cung cấp, với độ cao nổi/lõm nằm trong khoảng 0.0 đến 5.0 mm.
6. IF mặt nạ (mask) do người dùng cung cấp cho spot-UV hoặc emboss không hợp lệ (sai định dạng ảnh hoặc kích thước không khớp với bề mặt áp dụng), THEN THE Khung_Xem_3D SHALL từ chối áp dụng mặt nạ, giữ nguyên Vật_Liệu_Finish hiện tại và hiển thị thông báo lỗi cho biết mặt nạ không hợp lệ.

### Yêu cầu 5: Quy trình đặt ảnh nghệ thuật

**User Story:** Là người thiết kế bao bì, tôi muốn đặt ảnh nghệ thuật đúng vị trí và hướng trên từng mặt hộp, để bản xem trước khớp với file in.

#### Tiêu chí chấp nhận

1. WHEN người dùng chọn chế độ đặt ảnh là per-face, THE Khung_Xem_3D SHALL gán Ảnh_Nghệ_Thuật vào đúng mặt hộp được chỉ định mà không ảnh hưởng tới các mặt còn lại.
2. WHEN người dùng chọn chế độ đặt ảnh là aligned-to-dieline, THE Khung_Xem_3D SHALL canh Ảnh_Nghệ_Thuật theo hệ tọa độ của Dieline_2D sao cho biên ảnh trùng với biên các vùng mặt tương ứng trên dieline với sai số không quá 1 px.
3. THE Khung_Xem_3D SHALL render Ảnh_Nghệ_Thuật trên mặt ngoài cùng hướng đọc với file in nguồn, không bị lật gương theo trục Y, sao cho nội dung chữ và hình trên bản xem trước đọc được theo cùng chiều với file in.
4. WHERE tùy chọn in mặt trong (inside print) được bật, THE Khung_Xem_3D SHALL cho phép người dùng đặt bản in mặt trong với Ảnh_Nghệ_Thuật, tỉ lệ và vị trí riêng, độc lập với cấu hình của mặt ngoài.
5. WHERE tùy chọn Bleed_Safe_Area được bật, THE Khung_Xem_3D SHALL hiển thị đường biên vùng bleed và đường biên vùng safe-area của Ảnh_Nghệ_Thuật dưới dạng hai chỉ dẫn trực quan phân biệt được với nhau.
6. THE Khung_Xem_3D SHALL cung cấp điều khiển tỉ lệ (scale) cho Ảnh_Nghệ_Thuật trong khoảng từ 10% đến 1000% so với kích thước gốc.
7. THE Khung_Xem_3D SHALL cung cấp điều khiển vị trí (offset) cho Ảnh_Nghệ_Thuật theo hai trục, trong khoảng từ -100% đến +100% kích thước của mặt chứa ảnh.
8. IF giá trị scale hoặc offset do người dùng nhập vượt ngoài khoảng cho phép, THEN THE Khung_Xem_3D SHALL giới hạn giá trị về biên gần nhất trong khoảng cho phép và giữ nguyên bản render hợp lệ trước đó.
9. IF Ảnh_Nghệ_Thuật không nạp được, THEN THE Khung_Xem_3D SHALL hiển thị bề mặt với Vật_Liệu_Finish đang chọn, hiển thị thông báo lỗi cho người dùng cho biết ảnh không nạp được, và giữ nguyên cấu hình scale/offset đã thiết lập.

### Yêu cầu 6: Xuất ảnh render

**User Story:** Là người thiết kế bao bì, tôi muốn xuất ảnh mockup ở độ phân giải tôi chọn, để gửi cho khách hàng hoặc đưa vào tài liệu.

#### Tiêu chí chấp nhận

1. WHEN người dùng yêu cầu Xuất_Ảnh_Render, THE Khung_Xem_3D SHALL kết xuất cảnh hiện tại thành tệp PNG hoàn toàn phía client mà không gọi tới backend.
2. THE Khung_Xem_3D SHALL cho phép người dùng chọn độ phân giải xuất từ danh sách định sẵn gồm 1x, 2x và 4x kích thước khung xem, với mức 1x được chọn làm mặc định.
3. WHEN người dùng yêu cầu Xuất_Ảnh_Render ở mức 1x, THE Khung_Xem_3D SHALL hoàn tất việc kết xuất PNG trong vòng tối đa 15 giây.
4. IF độ phân giải xuất sau khi nhân hệ số vượt quá 16384 pixel ở chiều rộng hoặc chiều cao, THEN THE Khung_Xem_3D SHALL giữ nguyên cảnh hiện tại và hiển thị thông báo lỗi cho người dùng biết kích thước xuất vượt giới hạn.
5. WHEN Xuất_Ảnh_Render hoàn tất, THE Khung_Xem_3D SHALL kích hoạt tải tệp PNG về máy người dùng phía client mà không gọi tới backend.
6. WHERE người dùng yêu cầu xuất mô hình, THE Khung_Xem_3D SHALL kết xuất tệp GLB của hộp ở trạng thái gập hiện tại và kích hoạt tải tệp GLB về máy người dùng phía client mà không gọi tới backend.
7. IF quá trình Xuất_Ảnh_Render tệp PNG thất bại, THEN THE Khung_Xem_3D SHALL giữ nguyên cảnh hiện tại và hiển thị thông báo lỗi cho người dùng biết quá trình xuất ảnh không thành công.
8. IF quá trình xuất tệp GLB thất bại, THEN THE Khung_Xem_3D SHALL giữ nguyên cảnh hiện tại và hiển thị thông báo lỗi cho người dùng biết quá trình xuất mô hình không thành công.

### Yêu cầu 7: Preset trình bày cảnh

**User Story:** Là người thiết kế bao bì, tôi muốn các góc nhìn và phông nền định sẵn cùng chế độ tách rời, để trình bày hộp một cách chuyên nghiệp.

#### Tiêu chí chấp nhận

1. THE Khung_Xem_3D SHALL cung cấp đúng bốn Preset_Camera gồm: mặt trước, từ trên, isometric và phối cảnh trực giao (orthographic).
2. WHEN người dùng chọn một Preset_Camera, THE Khung_Xem_3D SHALL chuyển camera đến góc nhìn tương ứng và hoàn tất chuyển cảnh trong vòng 500 mili-giây.
3. THE Khung_Xem_3D SHALL cung cấp tối thiểu hai preset nền/sàn để người dùng chọn phông cảnh.
4. WHEN người dùng chọn một preset nền/sàn, THE Khung_Xem_3D SHALL áp dụng phông cảnh tương ứng và giữ nguyên phông cảnh đó cho đến khi người dùng chọn preset khác.
5. WHERE người dùng bật Exploded_View, THE Khung_Xem_3D SHALL tách các Panel dọc theo trục pháp tuyến của chúng theo một hệ số tách rời điều chỉnh được trong khoảng từ 0.0 đến 5.0.
6. WHEN người dùng tắt Exploded_View, THE Khung_Xem_3D SHALL đưa toàn bộ các Panel về đúng vị trí lắp ráp ban đầu.
7. WHERE người dùng bật Overlay_Kích_Thước, THE Khung_Xem_3D SHALL hiển thị kích thước chiều dài, chiều rộng và chiều cao của hộp trong không gian 3D theo đơn vị mi-li-mét, làm tròn đến 0.1 mm.

### Yêu cầu 8: Hiệu năng và tính tương tác

**User Story:** Là người dùng, tôi muốn cảnh 3D luôn mượt khi gập và thao tác, để làm việc không bị giật.

#### Tiêu chí chấp nhận

1. WHILE hoạt ảnh gập đang chạy với số lượng Panel không quá 24, THE Khung_Xem_3D SHALL duy trì tốc độ khung hình trung bình tối thiểu 30 FPS, tính trung bình trên toàn bộ thời lượng của một lần hoạt ảnh gập.
2. WHEN người dùng thay đổi giá trị thanh trượt gập, THE Khung_Xem_3D SHALL kết xuất khung hình phản ánh giá trị mới trong vòng 100 ms tính từ thời điểm giá trị thay đổi.
3. WHEN dieline hoặc Ảnh_Nghệ_Thuật thay đổi, THE Khung_Xem_3D SHALL giải phóng các tài nguyên GPU (geometry, material, texture) không còn được tham chiếu trước khi cấp phát tài nguyên cho nội dung mới.
4. IF trình duyệt không hỗ trợ WebGL, THEN THE Khung_Xem_3D SHALL hiển thị thông báo cho biết trình duyệt không hỗ trợ WebGL và giữ cho ứng dụng vẫn phản hồi thao tác người dùng, không bị treo hay dừng đột ngột.

### Yêu cầu 9: Chống hồi quy và ràng buộc phía client

**User Story:** Là người bảo trì sản phẩm, tôi muốn bản nâng cấp 3D không phá vỡ dieline 2D, generator hay bộ kiểm thử hiện có, để hệ thống vẫn ổn định.

#### Tiêu chí chấp nhận

1. THE Khung_Xem_3D SHALL giữ hình học dieline do mọi Generator sinh ra ở trạng thái byte-identical (giống hệt từng byte) so với trước khi nâng cấp khi nhận cùng dữ liệu đầu vào.
2. THE Khung_Xem_3D SHALL giữ nguyên chữ ký API công khai (tên hàm, danh sách tham số và kiểu trả về) của mọi Generator, không thêm/đổi/bớt.
3. WHEN canvas Dieline_2D hoặc chức năng xuất 2D được gọi với cùng dữ liệu đầu vào, THE Khung_Xem_3D SHALL không làm thay đổi kết quả của chúng so với bản trước khi nâng cấp (byte-identical).
4. WHEN bộ kiểm thử dieline hiện có được chạy sau khi nâng cấp, THE Khung_Xem_3D SHALL bảo đảm 100% các test trước đó đang đạt vẫn đạt và không phát sinh test thất bại mới.
5. WHILE Khung_Xem_3D hoạt động, THE Khung_Xem_3D SHALL không phát sinh request nào tới backend và không gửi bất kỳ request telemetry nào (0 backend request, 0 telemetry request).
6. WHERE một thư viện postprocessing được thêm vào, THE Khung_Xem_3D SHALL chỉ sử dụng thư viện thuộc ngăn xếp three/r3f/drei hoặc tương thích với ngăn xếp đó.
7. IF một thư viện postprocessing không tương thích với ngăn xếp three/r3f/drei, THEN THE Khung_Xem_3D SHALL từ chối tích hợp thư viện đó và không kích hoạt hiệu ứng phụ thuộc vào nó.
