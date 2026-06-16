# Requirements Document

## Introduction

**Gửi Máy Bế (Cut Export / Send to Cutter)**


Tính năng cho phép Prynx tạo **dữ liệu cắt** từ kết quả bình bài (Bình Tem Bế, Bình Bế Rớt CNC) và đưa tới **máy bế/máy cắt** — thay thế vai trò của các plugin hãng (Cutting Master, CutStudio, GoSign...) vốn chỉ cài được vào Corel/Illustrator.

Bản chất kỹ thuật đã xác minh qua nghiên cứu:
- Máy bế nhận một **chuỗi lệnh "nhấc dao / hạ dao / đi tới X,Y"** (HPGL/GP-GL/U-D) hoặc một **file vector** (DXF/PDF-EPS spot-color/SVG) mà phần mềm máy tự dịch, hoặc **G-code** cho máy CNC.
- Dữ liệu gốc Prynx cần chỉ là **đường cắt (polyline) + vị trí dấu định vị (ốc)** — Prynx đã trích được đường bế từ file nguồn qua `nup_diecut.extract_page_die_cut_polygon` (Shapely Polygon), cộng hình học pont/ốc và layout bình.
- Mỗi hãng/đời máy khác nhau ở "phương ngữ" (lệnh, đơn vị, gốc toạ độ, cơ chế dấu, kênh truyền) → cần **kiến trúc Profile máy** + nhiều **Emitter** + nhiều **Transport**, để thêm máy mới = khai báo cấu hình, không sửa lõi.

Tham chiếu đặc tả thật: script Illustrator của người dùng cho máy **Yuty/Skycut A3 Max** (`scripts/illustrator/dev campuchia v5.6.jsx`, module `exportCutLayerToPLT`, ~dòng 15390–16965) — đã reverse-engineer trọn vẹn định dạng PLT (U/D, 40 PLU/mm, `IN/FSIZE/CMD:32/TB26/CMD:35`, khớp dấu bằng khung FSIZE).

### Mục tiêu thiết kế (3 trục mở rộng độc lập)
1. **Machine Profile** — hồ sơ khai báo phương ngữ của một máy.
2. **Emitter** — bộ sinh đầu ra: `command-stream` (HPGL-family) | `vector-file` (DXF/PDF-EPS/SVG) | `gcode`.
3. **Transport** — kênh đưa ra: `file` (.plt/.dxf/.nc) | `serial (COM)` | `usb` | `lan (TCP)`.

### Lộ trình pha (để cắt phạm vi nghiệm thu)
- **Pha 1** — Emitter vector-file (DXF / PDF-EPS spot-color / SVG): phủ gần như mọi máy qua phần mềm đi kèm. Không cần máy thật.
- **Pha 2** — Emitter command-stream + Transport LAN/file: profile Yuty/Skycut (port từ JSX) + Generic HPGL; gửi thẳng máy.
- **Pha 3** — Bế khớp bản in (registration/FSIZE) đầy đủ; hiệu chỉnh trên máy thật.
- **Pha 4** — Quản lý/Thêm profile máy mới + import mẫu file thật để đối chiếu.

---

## Glossary

- **Đường cắt / Cut path**: polyline kín mô tả viền bế của một con tem/khuôn.
- **Ốc / Registration mark**: dấu in kèm để máy dò và căn cắt khớp bản in.
- **Bế khớp bản in / Print-and-cut**: cắt theo viền của hình ĐÃ IN, dùng ốc để bù lệch/xoay/co giãn.
- **PLU (Plotter Unit)**: đơn vị toạ độ của máy. Yuty/HPGL = 40 PLU/mm (1016 PLU/inch).
- **Profile máy**: bộ khai báo phương ngữ (dialect lệnh, đơn vị, gốc toạ độ, cơ chế dấu, dao, kênh truyền).
- **Emitter**: thành phần dịch mô hình cắt nội bộ → một định dạng đầu ra cụ thể.
- **Transport**: kênh đưa đầu ra tới máy (file/serial/usb/lan).
- **Mô hình cắt nội bộ (Cut Model)**: biểu diễn trung gian không phụ thuộc máy: danh sách polyline + nhãn dao + vị trí ốc + khung khổ.

---

## Requirements

### Requirement 1: Trích xuất mô hình cắt nội bộ từ kết quả bình
**User Story:** Là người vận hành, sau khi bình Tem Bế hoặc Bế Rớt, tôi muốn Prynx lấy được toàn bộ đường cắt và vị trí ốc của cả tờ đã bình, để chuyển sang máy mà không phải vẽ lại.

#### Acceptance Criteria
1. WHEN một phiên bình (Bình Tem Bế hoặc Bình Bế Rớt CNC) hoàn tất THEN hệ thống SHALL dựng được một Cut Model gồm: danh sách đường cắt (polyline đã làm phẳng — nguồn từ `nup_diecut.extract_page_die_cut_polygon` / hình học pont/CNC), vị trí/loại ốc, khung khổ giấy, và nhãn dao (nếu có) cho từng đường.
2. WHERE đường cắt là bezier THE hệ thống SHALL làm phẳng thành đoạn thẳng với sai số ≤ 0.2mm và nén điểm thừa (RDP) ở ngưỡng ~0.03mm.
3. THE hệ thống SHALL biểu diễn toạ độ Cut Model theo một hệ chuẩn nội bộ (đơn vị mm, gốc xác định) độc lập với máy, để Emitter tự đổi sang hệ của máy.
4. WHERE bình ở chế độ nhiều con/nhiều cụm THE Cut Model SHALL giữ đúng vị trí từng con theo layout đã bình (không tự căn lại), để cắt khớp bản in.
5. THE Cut Model SHALL gắn nhãn nhóm/lớp/ô đường cắt và ốc theo ĐÚNG tên cấu hình trong cài đặt ốc/boong định vị (`PontConfig.groupName`/`itemName`/`layerName`/`layerInfoName`) — đây là hợp đồng đặt tên mà khâu sinh lệnh dựa vào để nhận diện đường cắt và ốc (tương tự ràng buộc `MarkLine`/`MKLINE` trong script JSX). Đặt tên không khớp SHALL được phát hiện và báo lỗi.
6. IF không có đường cắt hợp lệ nào THEN hệ thống SHALL báo lỗi rõ ràng và KHÔNG sinh đầu ra rỗng.

### Requirement 2: Kiến trúc Machine Profile
**User Story:** Là chủ xưởng có nhiều loại máy TQ khác nhau, tôi muốn thêm/chọn máy theo hồ sơ cấu hình, để hỗ trợ máy mới mà không phải sửa lõi phần mềm.

#### Acceptance Criteria
1. THE hệ thống SHALL định nghĩa một schema Machine Profile gồm tối thiểu: tên máy, loại Emitter, **độ phân giải `resolution_plu_per_mm` (bắt buộc, không giả định)**, gốc toạ độ + cờ lật/đổi trục (flipY/swapXY), cơ chế dấu định vị (xem Requirement 4), cấu hình dao (lực/tốc/offset/overcut — mặc định KHÔNG nhúng, để panel máy điều khiển), dấu phân cách lệnh, quy ước tên file, và cấu hình Transport mặc định.
2. WHEN người dùng chọn một Profile THEN mọi đầu ra SHALL được sinh theo đúng các trường khai báo trong Profile đó.
3. THE hệ thống SHALL nạp được nhiều Profile và cho phép chọn Profile đang dùng.
4. THE hệ thống SHALL cung cấp sẵn tối thiểu 2 Profile: **Yuty/Skycut** (command-stream U/D) và **Generic HPGL** (command-stream PU/PD).
5. IF một Profile thiếu trường bắt buộc hoặc giá trị không hợp lệ THEN hệ thống SHALL từ chối nạp và báo lỗi cấu hình cụ thể (không tạo file sai âm thầm).
6. THE độ phân giải SHALL theo từng máy/cấu hình (vd Graphtec GP-GL chọn được 0.10/0.05/0.025/0.01 mm/step; phổ biến 1016 steps/inch = 0.025mm = 40 PLU/mm) — sai PLU sẽ làm hình bị phóng/thu sai tỉ lệ, nên Profile phải khai báo đúng. [đã xác minh: tài liệu Graphtec/Caldera]

### Requirement 3: Emitter vector-file (Pha 1, phủ phổ quát)
**User Story:** Là người dùng máy chưa có profile lệnh, tôi muốn xuất file vector chuẩn để nạp vào phần mềm đi kèm máy, để dùng được ngay với hầu hết máy.

#### Acceptance Criteria
1. THE hệ thống SHALL xuất được Cut Model ra **DXF** với đường cắt là polyline/spline kín.
2. THE hệ thống SHALL xuất được **PDF/EPS** với đường cắt tách khỏi nội dung in, đặt trên **một layer/spot-color đặt tên cấu hình được** (mặc định `CutContour`) — nhãn này CHỈ cần cho trường hợp bàn giao file vào phần mềm bên thứ ba để chúng nhận diện đường cắt.
3. THE hệ thống SHALL xuất được **SVG** với đường cắt là path, có thể phân lớp theo dao.
4. WHERE Profile yêu cầu vẽ ốc THE file vector SHALL chứa các dấu định vị đúng vị trí Cut Model.
5. THE đầu ra vector-file SHALL giữ đúng tỉ lệ kích thước thật (1:1 theo mm) khi mở trong phần mềm máy.

### Requirement 4: Emitter command-stream + khớp dấu (Pha 2–3)
**User Story:** Là người dùng máy Yuty/Skycut hoặc máy HPGL, tôi muốn Prynx sinh thẳng lệnh máy (kèm khớp dấu), để cắt khớp bản in mà không cần phần mềm trung gian.

#### Acceptance Criteria
1. WHEN Profile là Yuty/Skycut THEN hệ thống SHALL sinh chuỗi theo đúng cú pháp đã verify: header `IN`, `FSIZE<W>,<H>`, `CMD:32,<W>,<H>,360,360;`, `CMD:18,1;`, `CMD:103,5;`, `CMD:35,<tool>,<pressure>,<offset>;`, `TB26,<W>,<H>`; thân lệnh `U<x>,<y>`/`D<x>,<y>`; footer `U0,0 @ @`; đơn vị 40 PLU/mm, gốc dưới-trái Y lên.
2. WHEN Profile là Generic HPGL THEN hệ thống SHALL sinh `IN;SP1;` + `PU<x>,<y>;`/`PD<x>,<y>;` + kết thúc `PU;`.
3. WHERE Cut Model có vị trí ốc THE Emitter command-stream SHALL tính khung khớp dấu (vd `FSIZE`/`TB26` cho Yuty) từ bounding box tâm các ốc — nhận diện ốc theo ĐÚNG tên cấu hình trong cài đặt ốc/boong (không hardcode), để khớp hợp đồng đặt tên ở Requirement 1.5.
4. THE Emitter command-stream SHALL đọc THẲNG toạ độ đường cắt từ Cut Model để phát `U/D` (Yuty) hoặc `PU/PD` (HPGL) — KHÔNG phụ thuộc spot-color hay nhãn màu (Prynx tự biết đường nào là đường cắt từ layout bình, tương tự script đọc layer khuôn).
5. WHERE Profile khai báo blade offset/overcut THE hệ thống SHALL áp đúng vào chuỗi lệnh.
6. WHERE Profile bật song đạo (dual-head) THE hệ thống SHALL phát lệnh chuyển đầu dao và định tuyến đường cắt theo nhãn dao (trái/phải/chung).
7. THE chuỗi lệnh sinh ra cho máy Yuty SHALL khớp về cấu trúc với file PLT do script JSX gốc tạo trên cùng đầu vào (kiểm chứng bằng đối chiếu mẫu).
8. THE hệ thống SHALL hỗ trợ 3 chế độ khớp dấu khai báo trong Profile:
   - **(a) Cảm biến onboard / khung**: host chỉ khai báo khung dấu (vd `FSIZE`/`TB26` cho Yuty; ARMS cho Graphtec; OPOS cho Summa), máy tự dò bằng cảm biến. Áp dụng cho máy Yuty của người dùng. [đã xác minh]
   - **(b) Dò dấu thủ công 3–4 điểm + affine**: người vận hành rê dao tới từng ốc (bằng phím trên máy), Prynx **tính ma trận affine** (xoay/tỉ lệ/trượt) rồi **bẻ toạ độ đường cắt cho khớp bản in** — KHÔNG cần computer vision, KHÔNG cần phần mềm hãng. Đây là chế độ phủ rộng nhất cho máy TQ. [đã xác minh: SignCut/SignLab/SignMaster dùng cách này]
   - **(c) Computer vision (camera tự dò)**: ngoài phạm vi giai đoạn này; đặt nền Profile để bổ sung sau.
9. WHERE dùng chế độ (b) THE hệ thống SHALL áp ma trận affine lên toàn bộ đường cắt trước khi phát lệnh, đảm bảo cắt khớp với tờ đã in dù lệch/xoay/co giãn.

### Requirement 5: Transport (đưa đầu ra tới máy)
**User Story:** Là người vận hành, tôi muốn lưu file hoặc bắn thẳng job qua mạng LAN, để phù hợp cách kết nối ở xưởng.

#### Acceptance Criteria
1. THE hệ thống SHALL lưu đầu ra ra **file** với đuôi đúng loại (`.plt`/`.dxf`/`.svg`/`.pdf`/`.nc`) và quy ước tên theo Profile (vd tên mã vạch để máy tự quét).
2. WHERE máy hỗ trợ LAN THE hệ thống SHALL gửi đầu ra qua **TCP tới IP:port cấu hình được** và báo trạng thái gửi (thành công/lỗi/timeout).
3. WHERE người dùng chọn cổng COM/serial THE hệ thống SHALL gửi qua serial với baud cấu hình được.
4. WHEN gửi thất bại (mất kết nối, timeout) THEN hệ thống SHALL báo lỗi rõ và KHÔNG để job "treo im lặng".
5. WHERE gửi qua serial THE hệ thống SHALL áp **flow control (RTS/CTS hoặc XON/XOFF) và tiết lưu tốc độ gửi** để tránh tràn buffer máy với job lớn. [đã xác minh: cách InkCut xử lý]
6. THE việc gửi qua mạng SHALL chỉ tới đích do người dùng cấu hình (không gửi dữ liệu ra ngoài mạng nội bộ ngoài ý muốn).

### Requirement 6: Tích hợp vào luồng bình bài
**User Story:** Là người dùng, sau khi bình xong tôi muốn một nút "Gửi máy bế" ngay tại chỗ, để đi thẳng từ bình bài sang cắt.

#### Acceptance Criteria
1. WHERE phiên đang ở chế độ Bình Tem Bế hoặc Bình Bế Rớt CNC THE giao diện SHALL hiển thị hành động "Xuất/Gửi máy bế".
2. WHEN người dùng kích hoạt hành động THEN hệ thống SHALL cho chọn Profile máy + Emitter + Transport (hoặc dùng mặc định đã lưu) rồi thực thi.
3. THE hệ thống SHALL đảm bảo dữ liệu cắt gửi máy dùng **cùng hệ toạ độ và cùng vị trí ốc** với file in tương ứng, để cắt khớp bản in.
4. WHERE người dùng đã cấu hình mặc định THE hành động SHALL chạy một chạm (không hỏi lại) nhưng vẫn cho xem trước trước khi gửi.

### Requirement 7: Quản lý & onboarding máy mới
**User Story:** Là người hỗ trợ kỹ thuật, tôi muốn thêm máy mới bằng cách điền cấu hình và đối chiếu một file mẫu thật, để mở rộng nhanh mà không đoán mò.

#### Acceptance Criteria
1. THE hệ thống SHALL cho phép tạo/sửa/lưu Profile máy qua giao diện hoặc file cấu hình.
2. WHERE người dùng cung cấp một file đầu ra mẫu thật của máy (vd `.plt` do phần mềm gốc xuất) THE hệ thống SHALL hỗ trợ đối chiếu cấu trúc với đầu ra Prynx sinh ra để dò khác biệt.
3. THE hệ thống SHALL không cho lưu Profile thiếu trường bắt buộc.
4. THE tài liệu SHALL mô tả quy trình "onboarding máy mới": lấy mẫu → đối chiếu → điền profile → test.

### Requirement 8: An toàn & tin cậy
**User Story:** Là chủ xưởng, tôi muốn job cắt chính xác và không hỏng vật tư, để tránh lãng phí.

#### Acceptance Criteria
1. WHEN đầu ra được sinh THEN hệ thống SHALL cho **xem trước** (preview) bố cục đường cắt + ốc trước khi lưu/gửi.
2. IF kích thước khổ/khung vượt giới hạn máy khai báo trong Profile THEN hệ thống SHALL cảnh báo trước khi gửi.
3. THE hệ thống SHALL ghi log đủ để truy vết một job cắt (profile, emitter, transport, thời điểm, kết quả).
4. THE đầu ra SHALL ổn định/đơn định: cùng đầu vào + cùng profile → cùng kết quả (để đối chiếu và kiểm thử).
5. WHERE gửi qua LAN/serial THE hệ thống SHALL không chặn UI (chạy nền, có thể huỷ).

### Requirement 9: Tuân thủ pháp lý & tái dùng mã nguồn mở
**User Story:** Là chủ sản phẩm thương mại, tôi muốn tránh rủi ro pháp lý khi tham khảo OSS và reverse-engineer giao thức máy, để phát hành Prynx an toàn.

#### Acceptance Criteria
1. THE dự án SHALL chỉ **tham khảo cách làm** từ OSS copyleft (InkCut GPLv3, inkscape-silhouette GPLv2, libcutter GPLv2) — KHÔNG sao chép trực tiếp mã GPL vào sản phẩm đóng; nếu cần tái dùng SHALL tách thành tiến trình/thành phần riêng tuân thủ giấy phép.
2. WHERE reverse-engineer giao thức máy THE dự án SHALL ưu tiên nguồn hợp pháp: tài liệu hãng công khai, đặc tả mở, và bắt gói lệnh từ thiết bị của chính người dùng.
3. THE tài liệu profile SHALL ghi nguồn gốc đặc tả từng máy để truy vết.

### Requirement 10: Trích đường cắt mạnh từ PDF đã bình bất kỳ (Corel/Illustrator/Prynx...)
**User Story:** Là người dùng coi Prynx như Acrobat thay thế, tôi muốn mở MỘT file PDF đã bình sẵn (xuất từ CorelDRAW/Illustrator/RIP/Prynx) và lấy đúng đường cắt để gửi máy bế, mà không cần bình lại trong Prynx.

#### Acceptance Criteria
1. THE hệ thống SHALL trích đường cắt từ một trang PDF bất kỳ bằng cách **đệ quy vào Form XObject** (nghệ thuật đặt lồng) và **áp ma trận đặt (CTM)** để ra toạ độ tuyệt đối đúng trên tờ.
2. THE hệ thống SHALL nhận diện đường cắt theo NHIỀU chiến lược, ưu tiên: (a) **lớp OCG** có tên khớp mẫu cấu hình (`Result_Cutline*`, `CutContour`, `Thru-cut`, `Kiss-cut`, `Cut`, `Die`, `Crease`...); (b) **spot-color** đặt tên (Separation/DeviceN: `CutContour`/`Thru-cut`...); (c) heuristic stroke mảnh không tô (fallback cuối).
3. THE danh sách tên lớp/spot nhận diện SHALL **cấu hình được** (bổ sung mẫu mới không sửa lõi).
4. WHERE một trang có N con tem đặt bằng XObject THE số đường cắt trích ra SHALL khớp số con thực tế (không đếm nhầm dấu định vị/ốc).
5. THE hệ thống SHALL **loại trừ** các đối tượng KHÔNG phải đường cắt: dấu định vị/ốc (lớp `MarkLine`/`Marks*`), khung/nền full-trang, dấu xén.
6. IF không nhận diện được đường cắt theo bất kỳ chiến lược nào THEN hệ thống SHALL báo rõ "không tìm thấy lớp/đường cắt" + gợi ý chọn lớp thủ công, KHÔNG đoán liều (vd lấy nhầm ốc).
7. THE kết quả trích SHALL đơn định và có thể đối chiếu (cùng file → cùng số đường + toạ độ).

---

## Phạm vi & Ngoài phạm vi

**Trong phạm vi:** sinh dữ liệu cắt (vector-file + command-stream HPGL/U-D), khớp dấu chế độ (a) khung/cảm biến onboard + (b) thủ công 3–4 điểm + affine, transport file + LAN + serial, profile Yuty/Skycut + Generic HPGL, tích hợp nút trong luồng bình.

**Ngoài phạm vi (giai đoạn này):**
- Khớp dấu bằng **computer vision/camera tự dò** (chế độ (c)) — chỉ đặt nền profile, làm sau.
- Hoàn thiện handshake riêng từng hãng cao cấp (Graphtec ARMS / Summa OPOS tự động đầy đủ) — cần thiết bị thật để hiệu chỉnh.
- Sinh G-code đầy đủ cho CNC router/dao rung tiếp tuyến (đặt làm Emitter mở rộng pha sau; trước mắt xuất DXF cho CAM hãng xử lý).
- Điều khiển thời gian thực/giám sát trạng thái máy (chỉ gửi job, không điều khiển vận hành).

## Giả định & Rủi ro
- **Giả định:** máy TQ phổ biến nhận HPGL hoặc nhập được file vector (DXF/PDF-EPS); Prynx đã có hình học đường cắt + ốc từ các tính năng bình.
- **Rủi ro (đã hiệu chỉnh theo nghiên cứu):**
  - Phương ngữ lệnh + **độ phân giải PLU khác nhau** giữa máy (GP-GL cấu hình 0.01–0.10mm/step) → giảm thiểu bằng trường `resolution_plu_per_mm` trong profile + đối chiếu file mẫu thật.
  - **Print-and-cut**: với máy có cảm biến onboard (Yuty FSIZE) hoặc dò thủ công 3 điểm + affine → khả thi không cần phần mềm hãng/CV. Với máy CHỈ dùng camera host-warp → cần CV (ngoài phạm vi).
  - Hiệu chỉnh lực/tốc/offset dao + sai số dò dấu cần **máy thật** để tinh chỉnh.
  - Giấy phép GPL của OSS tham khảo → xem Requirement 9.
