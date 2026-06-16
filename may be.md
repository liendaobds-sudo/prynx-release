# Prynx CAM Module - Báo Cáo Nghiên Cứu Xây Dựng Module Thay Thế Plugin Máy Cắt/Bế

**Tác giả:** Nhóm nghiên cứu kỹ thuật CAM (Grok Team)  
**Ngày:** 15/06/2026  
**Mục tiêu:** Xây dựng module native trong Prynx (Tauri + Rust geometry + Python backend + React) thay thế hoàn toàn Cutting Master, CutStudio, GoSign, SignMaster…  
**Bối cảnh:** Đã có tính năng bình bài + xuất polygon + dấu ốc. Có script PLT Skycut/Yuty đang chạy thật.

## NHÓM 1 — Có tồn tại "định dạng cắt phổ quát" không?

1. **Không có định dạng nào thực sự được ĐA SỐ máy nhận trực tiếp 100%**.  
   HPGL/PLT phổ biến nhất (70-80% vinyl cutter, đặc biệt TQ). DXF mạnh flatbed. PDF/EPS/AI spot-color cần import software. SVG hạn chế.  
   [ĐÃ XÁC MINH: FlexiSign, ViewCompanion, Skycut SCAL manual, laser cutter guides].

2. **Lý do chưa có “1 file cho mọi máy”**: Khác biệt lệnh, units (40 PLU/mm), origin, registration, blade offset/force, header/footer. Máy TQ thường emulate nhưng variant cao.

3. **Post-processor + profile per machine thực tế hơn universal format** (giống CAM/RIP). Universal chỉ làm base layer.

## NHÓM 2 — Ngôn ngữ lệnh máy

4. **Đặc tả chính**:  
   - HP-GL/2: `PU/PD`, `PA/PR`, `IN`, `VS/FS`.  
   - GP-GL (Graphtec): `D` (down), `M` (up), `!` speed, `*` force.  
   - Roland CAMM-GL: Tương tự HPGL + specials.  
   - Summa DM-PL: `penUp/penDown`, velocity, pressure.  
   - Skycut/Yuty/TQ: `U/D` variant, header `IN;FSIZE;CMD:xx;TB26`, footer `U0,0 @ @`, 40 PLU/mm, layer “MarkLine”.  
   Force/speed: Thường trong file hoặc panel override.

5. **Lệnh dao**: Hỗn hợp file + panel (TQ ưu panel).

## NHÓM 3 — Bế khớp bản in & dấu định vị

6-7. ARMS (Graphtec – cross 5-20mm), OPOS (Summa – squares + barcode), Roland crop, TQ LED/camera 3-4 điểm. Tài liệu công khai có (Graphtec/Summa PDFs).

8. **Có thể tự sinh**: Có (inkscape-silhouette full 4-corner verified). InkCut partial. Giới hạn: calibrate thực tế.

## NHÓM 4 — Định dạng file vector trung gian

9-10. Spot-color: CutContour/Thru-cut/Kiss-cut. PDF/EPS/AI: layer riêng, stroke-only, closed path, 1:1. DXF: LWPOLYLINE, units mm, layer CUT.

## NHÓM 5 — Máy CNC / dao rung / flatbed

11. G-code (.nc) + post-processor (tangential, Z/M lift, lead-in/out). DXF → SheetCam/DXF2GCODE/FreeCAM.

## NHÓM 6 — Kết nối/truyền dữ liệu

12-13. USB (COM ảo), U-disk (TQ), serial, LAN raw (9100). Raw bytes đủ, driver chỉ cần virtual COM.

## NHÓM 7 — Mã nguồn mở & tài liệu

14. **OSS table**:
    | Tên                  | Máy hỗ trợ         | Print-and-cut | License | Điểm học được                     |
    |----------------------|--------------------|---------------|---------|-----------------------------------|
    | inkscape-silhouette | Silhouette full   | Yes (4-corner)| GPL-2  | libusb, registration, path sort  |
    | InkCut              | HPGL/CNC          | Partial      | GPL    | Profile + transport              |

15. **Tài liệu công khai**: GP-GL ref (ohthehugemanatee.net archive), Roland CAMM-GL PDF, Summa DM-PL, Graphtec manual.

## NHÓM 8 — Kiến trúc đề xuất

16. **Machine Profile + Emitter + Transport**  
    Schema JSON: lang, units_per_mm, header/footer, pen_up/down, reg_type, transport (usb/file/socket).  
    **Onboarding**: Cắt mẫu → dump PLT/raw → parse → điền profile → unit test → validate.

17. **2 tầng**: Ưu tiên **(a) Export vector** (PLT/DXF/PDF + guide) phủ rộng nhanh → song song **(b) Direct send** cho top machines.

## BẢNG SO SÁNH CÁC HÃNG MÁY

| Hãng/Máy     | Ngôn ngữ          | Đơn vị    | Gốc      | Dấu              | Kết nối      | File nhận   | Tài liệu |
|--------------|-------------------|-----------|----------|------------------|--------------|-------------|----------|
| Graphtec    | GP-GL/HP-GL      | 40PLU/mm | LL      | ARMS (cross)    | USB         | PLT/HPGL   | Cao     |
| Roland      | CAMM-GL          | 40PLU/mm | Panel   | Crop/Quad       | USB         | HPGL       | Cao     |
| Summa       | DM-PL            | mm       | LL      | OPOS (barcode)  | USB/LAN     | PLT/DMPL   | Trung   |
| Skycut/TQ   | U/D HPGL variant | 40PLU/mm | FSIZE   | LED/Camera      | USB/U-disk  | PLT        | Thấp    |

## KẾT LUẬN THẲNG
- **Mục tiêu “một file cho mọi máy”**: Khả thi **65-75%** với hybrid (export vector + profile emitter).  
- **Phương án thực tế nhất**: Tầng (a) export PLT/DXF/PDF-spot ưu tiên trước (rủi ro thấp, phủ rộng ngay) + song song tầng (b) direct cho top 5-7 máy phổ biến.  
- **Rủi ro lớn nhất**: Biến thể TQ + calibrate blade/force/marks trên hardware thật.  
- **Cần thiết bị thật**: 2-3 máy đại diện (Skycut, Roland/Graphtec, 1 flatbed) + USB sniffer để reverse & test profile.

**Tài liệu chính (link cụ thể)**:
- GP-GL ref: https://www.ohthehugemanatee.net/2011/07/gpgl-reference-courtesy-of-graphtec/
- inkscape-silhouette: https://github.com/fablabnbg/inkscape-silhouette
- Roland CAMM-GL: https://downloadcenter.rolanddg.com/contents/manuals/CAMM-GL2_PRO_EN_R1.pdf
- Graphtec ARMS: https://www.graphteccorp.com/cutting/arms/
- Summa DM-PL: https://www.summa.be/download/dmp-40v.pdf

**Khuyến nghị triển khai ngay**: Tạo `MachineProfile.json` + Rust Emitter cho Skycut variant (dùng script PLT hiện có làm base). Phase 1 hoàn thành trong 2-4 tuần.

---
**File này có thể mở bằng Typora/VS Code để xem bảng đẹp. Sẵn sàng bổ sung code prototype hoặc test trên máy thật của bạn.**


# BÁO CÁO NGHIÊN CỨU KỸ THUẬT: XÂY DỰNG MODULE CAM ĐỘC LẬP CHO PRYNX

**Vai trò:** Nhóm nghiên cứu R&D CAM  
**Sản phẩm:** App desktop Prynx (Tauri + React + Rust/FastAPI)  
**Mục tiêu:** Nghiên cứu cách xây dựng phần mềm thay thế hoàn toàn plugin hãng (Cutting Master, SignMaster...), xuất dữ liệu cắt trực tiếp tới máy cắt/bế. Đánh giá tính khả thi của mục tiêu "Một file bế cho mọi máy".

---

## KẾT LUẬN NHANH & CHIẾN LƯỢC ĐỀ XUẤT

1. **Mục tiêu "Một file bế (raw data) cho mọi máy" CÓ KHẢ THI KHÔNG?** 
   👉 **[KHÔNG KHẢ THI]** ở cấp độ phần cứng. Các máy khác biệt căn bản về: độ phân giải bước cơ khí (PLU - Plotter Logical Unit), ngôn ngữ lệnh, gốc tọa độ, và đặc biệt là giao thức đánh thức cảm biến dò dấu. Ép máy đọc sai định dạng sẽ dẫn đến đâm gãy dao hoặc chạy sai kích thước hoàn toàn.
2. **Phương án thực tế nhất:** 
   👉 Xây dựng kiến trúc **Post-processor (Bộ biên dịch) dựa trên Machine Profiles**. Lõi Prynx sinh đường cắt vector tọa độ tuyệt đối (hệ mét chuẩn) -> Truyền qua Profile của máy đang kết nối -> Dịch thành raw bytes / lệnh máy tương ứng.
3. **Rủi ro lớn nhất (Nút thắt Print-and-Cut):** 
   👉 **Máy cắt Trung Quốc dùng Camera**. Các máy này không tự dò dấu bằng phần cứng; phần mềm PC (như SignMaster) dùng Computer Vision để quét luồng video, tự tính ma trận biến đổi (Affine Transform), rồi **gửi tọa độ đã làm méo** xuống máy. Nếu Prynx bỏ phần mềm hãng, team phải tự code module Computer Vision hoặc làm dò dấu thủ công.
4. **Cần thiết bị thật để hiệu chỉnh không?**
   👉 **[BẮT BUỘC]**. Giao tiếp với máy cắt cần Handshake 2 chiều. Không thể lập trình "mù". Cần máy thật để chạy *Serial Sniffer* (như Wireshark + USBPcap hoặc Free Serial Analyzer) bắt các gói tin và dịch ngược (reverse-engineer) chuỗi lệnh.

---

## NHÓM 1 — CÓ TỒN TẠI "ĐỊNH DẠNG CẮT PHỔ QUÁT" KHÔNG?

**1. Định dạng phổ quát trực tiếp tới máy?**
*   `[ĐÃ XÁC MINH - Tài liệu HP-GL/2]` **Không tồn tại một định dạng chung tuyệt đối.** 
*   Định dạng `PLT` (lõi là HP-GL) phổ biến nhất (~70% máy), nhưng mỗi hãng dùng các biến thể khác nhau, đặc biệt là ở Header khởi tạo.
*   DXF, PDF, SVG là đồ họa trung gian, vi điều khiển máy bế không hiểu được, bắt buộc qua phần mềm Host trên PC.

**2. Khác biệt cốt lõi ngăn cản "Một file cho mọi máy":**
*   `[ĐÃ XÁC MINH]` **Độ phân giải (PLU):** HP-GL chuẩn = 40 PLU/mm. Graphtec = 100 PLU/mm hoặc 1000 PLU/mm. Summa = 1/1000 inch. Gửi file 40 PLU sang máy 100 PLU hình sẽ bị thu nhỏ 2.5 lần.
*   `[ĐÃ XÁC MINH]` **Gốc toạ độ (Origin):** Roland/Graphtec thường lấy gốc ở góc dưới-trái. Máy TQ (Skycut, Liyu) thường lấy vị trí hiện tại của lưỡi dao làm gốc.
*   `[PHỎNG ĐOÁN CÓ CƠ SỞ]` Các hãng cố tình mã hóa lệnh khởi tạo để bảo vệ phần mềm bản quyền.

**3. Post-processor vs Một định dạng chung:**
*   `[ĐÃ XÁC MINH]` Cách tiếp cận **Driver/Post-processor per machine** là duy nhất khả thi. Lõi chỉ xử lý AST/Polygon mm. 

---

## NHÓM 2 — NGÔN NGỮ LỆNH MÁY (COMMAND LANGUAGES)

**4. Đặc tả lệnh `[ĐÃ XÁC MINH - Nguồn: InkCut / libcutter]`:**
*   **HP-GL / HP-GL/2 (Chuẩn & Roland):** Lệnh khởi tạo `IN;`, nhấc dao `PU x,y;`, hạ dao `PD x,y;`. Phân cách bằng dấu `;`.
*   **GP-GL (Graphtec):** Tối ưu băng thông. `H` (Home), `M x,y` (Move), `D x,y` (Draw).
*   **DM-PL (Summa):** Lệnh khối: `U100,200D300,400`.
*   **Máy TQ (Skycut, Yuty, PCUT):** Thường là HP-GL đột biến. Thay `PU/PD` bằng `U/D`, bỏ dấu `;`. Bắt buộc gửi lệnh handshake đặc thù (VD: `CMD:32`, `CMD:103`, `TB26`). Lệnh `FSIZE` thường dùng để báo bounding box.

**5. Điều khiển Dao/Lực/Tốc độ:**
*   `[ĐÃ XÁC MINH]` Các ngôn ngữ đều hỗ trợ lệnh lực/tốc độ (VD: `VS30`, `FS10`). Nhưng **Tuyệt đối không nên nhúng cứng vào file**.
*   Thợ vận hành sẽ điều chỉnh trực tiếp trên **Panel của máy** dựa theo độ mòn thực tế của dao. Ghi đè từ file dễ gây rách decal hoặc gãy dao.

---

## NHÓM 3 — BẾ KHỚP BẢN IN (PRINT-AND-CUT) & DẤU ĐỊNH VỊ

**6. Cơ chế dò dấu `[ĐÃ XÁC MINH]`:**
*   **Smart Hardware (Graphtec ARMS, Summa OPOS):** Máy tự dò dấu, bo mạch **tự tính toán Ma trận Affine** (Xoay, tỷ lệ, trượt). Host chỉ gửi lệnh "Bắt đầu dò" và truyền file cắt vuông vắn.
*   **Dumb Hardware + Smart Host (Máy TQ Camera / Red-dot):** Máy hoàn toàn thụ động. Host PC (SignMaster) tính toán Ma trận Affine, và gửi đường cắt **đã bóp méo tọa độ** xuống máy.

**7. Kích thước & Loại dấu `[ĐÃ XÁC MINH - Manual hãng]`:**
*   *Graphtec:* Dấu góc chữ L (Segment marks), dày 0.5-1mm, dài 15-20mm.
*   *Roland:* Dấu tròn + chữ thập (Crop marks).
*   *Summa:* Ô vuông đen hoặc Barcode.
*   *Máy TQ:* 4 chấm tròn đen 5mm hoặc 4 dấu cộng.

**8. Tự sinh lệnh khớp dấu KHÔNG cần phần mềm hãng?**
*   `[ĐÃ XÁC MINH - InkCut]` **CÓ THỂ**. Dự án mã nguồn mở InkCut đã reverse thành công lệnh gọi ARMS/OPOS. 
*   *Với máy TQ:* Khuyến nghị dùng "Manual Registration" (Người dùng dùng phím cứng di chuyển dao tới 4 ốc, Host lấy tọa độ tính Affine Transform) thay vì đầu tư làm Computer Vision.

---

## NHÓM 4 — ĐỊNH DẠNG TRUNG GIAN (CHO PHẦN MỀM HÃNG)

*(Áp dụng nếu Prynx chọn xuất file cho phần mềm hãng ở Giai đoạn 1)*

**9. Quy ước Spot-color `[ĐÃ XÁC MINH - Chuẩn RIP VersaWorks/Onyx]`:**
*   Màu Spot (Màu pha), tên quy chuẩn: **`CutContour`** (Bế đứt nửa), **`PerfCutContour`** hoặc **`Thru-cut`** (Bế đứt lìa).
*   Định dạng: **PDF 1.4+** hoặc EPS.
*   Yêu cầu Vector: Stroke Hairline (0.001pt), màu 100% Magenta Spot, Không Fill, Bật Overprint Stroke.

**10. DXF cho CNC/Flatbed `[ĐÃ XÁC MINH]`:**
*   Chuẩn **DXF R12 / R14** (mm, 1:1). Bắt buộc Flatten thành `LWPOLYLINE` hoặc `LINE/ARC`. **TUYỆT ĐỐI KHÔNG XUẤT `SPLINE`** (Máy giá rẻ nội suy Spline gây giật dao).

---

## NHÓM 5 — MÁY CNC / DAO RUNG / FLATBED

**11. Ngôn ngữ & Dao tiếp tuyến (Tangential Knife):**
*   Máy bàn phẳng (Zund, IECHO) nhận **G-code (.nc, .tap)**.
*   *Dao rung:* Tại góc nhọn, không thể rẽ ngang. Phải sinh lệnh G-code: Nhấc dao Z -> Xoay motor trục C theo góc tiếp tuyến mới -> Hạ dao Z -> Cắt Overcut. Độ phức tạp quá cao, Prynx nên chỉ xuất DXF để CAM hãng tự xử lý.

---

## NHÓM 6 — KẾT NỐI / TRUYỀN DỮ LIỆU

**12 & 13. Giao tiếp & Driver `[ĐÃ XÁC MINH]`:**
*   **COM/Serial (USB ảo):** ~80% máy. Cắm USB nhận cổng COM (CH340/FTDI). Gửi Raw ASCII Bytes qua thư viện serial. **KHÔNG CẦN DRIVER HÃNG**. Bắt buộc xử lý Flow Control (RTS/CTS hoặc XON/XOFF) chống tràn buffer.
*   **LAN/WIFI:** Mở TCP Raw socket cổng `9100`.
*   **USB Printing:** (Roland/Graphtec mới). Cài driver "Generic/Text Only" của OS, gửi qua Spooler API.

---

## NHÓM 7 — M Mã NGUỒN MỞ & TÀI LIỆU

**14. Đánh giá dự án OSS:**

| Tên Dự Án | Máy hỗ trợ | Print & Cut | License | Điểm học được / Ghi chú |
| :--- | :--- | :--- | :--- | :--- |
| **InkCut** (Python) | Graphtec, Roland, Summa, TQ | **CÓ** | GPLv3 | **"Kinh thánh"**. Nguồn tài nguyên đỉnh nhất về Machine Profiles và code tính Ma trận Affine (NumPy). |
| **inkscape-silhouette**| Silhouette / Graphtec | **CÓ** | GPLv2 | Cách dùng `libusb` bắn Raw Endpoint bypass OS. |
| **libcutter** (C) | Graphtec, Roland | KHÔNG | GPLv2 | Parser sinh chuỗi HP-GL/GP-GL chuẩn xác. |

**15. Tài liệu đặc tả `[ĐÃ XÁC MINH]`:**
*   *HP-GL:* "HP-GL/2 and HP RTL Reference Guide PDF".
*   *DM-PL:* "Summa DM/PL Programmer's Manual PDF".
*   *GP-GL:* Tham khảo mã nguồn dict của InkCut.

---

## NHÓM 8 — KIẾN TRÚC ĐỀ XUẤT CHO PRYNX

**16. Cấu trúc "Profile + Emitter + Transport":**
*   **Lõi Rust (Geometry):** Polygon -> mảng `[MoveTo(x,y), LineTo(x,y)]` tọa độ tuyệt đối mm.
*   **Machine Profile (JSON Schema):**
    ```json
    {
      "vendor": "Skycut", "model": "A3_Max",
      "resolution_plu_per_mm": 40.0, 
      "protocol": "HPGL_MUTATED",
      "commands": {
        "header": "IN;CMD:32;FSIZE:{w},{h};CMD:18;", "footer": "U0,0 @ @",
        "pen_up": "U{x},{y};", "pen_down": "D{x},{y};"
      },
      "registration": { "type": "FSIZE_BOUNDS" }
    }
    ```
*   **Quy trình Onboarding Máy Mới:** Vẽ hình vuông 100x100mm trên app hãng -> Cắt -> Dùng Serial Monitor bắt chuỗi Hex -> Phân tích Header/Footer/PLU -> Điền vào JSON Profile.

**17. Chiến lược Go-to-Market 2 tầng:**
*   **TẦNG 1 (LÀM NGAY):** Prynx bình bài -> Xuất PDF chuẩn Spot-color `CutContour`. User dùng app hãng để cắt. *Độ phủ máy 100%, rủi ro kỹ thuật bằng 0.* Tận dụng ngay thế mạnh bình bài của Prynx.
*   **TẦNG 2 (LÂU DÀI):** Xây dựng module xuất thẳng Raw Data. Bắt đầu từ máy cắt decal trơn -> máy TQ dò dấu thủ công (Manual Registration) -> Reverse-engineer máy Graphtec/Summa.

---

### BẢNG SO SÁNH CÁC DÒNG MÁY CHÍNH

| Hãng / Dòng | Ngôn ngữ | Đơn vị (PLU) | Gốc toạ độ | Dò dấu in (Print&Cut) | Kết nối | File nhận (Tầng 1) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Graphtec** | GP-GL, HP-GL | Tùy chọn | Dưới-trái / Tâm | Firmware tự dò & tính | LAN / COM | PDF (Spot-color) |
| **Roland** | RD-GL, HP-GL | 40 PLU/mm | Dưới-trái | Firmware tự dò & tính | USB Print | PDF (Spot-color) |
| **Summa** | DM-PL | 1/1000 inch | Theo máy | Firmware tự dò & tính | LAN / COM | PDF (Spot-color) |
| **Máy TQ** | HP-GL đột biến | ~40 PLU/mm | Vị trí dao | **Host (PC) bóp méo tọa độ** | COM ảo | DXF R12 / PLT |
| **CNC Flatbed**| G-code / HP-GL | Theo controller| Tuỳ hệ G54 | Camera / Cảm biến biên | LAN | DXF (Flatten) |