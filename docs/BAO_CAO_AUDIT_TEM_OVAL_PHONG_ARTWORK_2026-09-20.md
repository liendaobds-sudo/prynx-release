# Audit tem oval bị phóng artwork sau hai ô đầu - 2026-09-20

Trạng thái: **chỉ audit, chưa sửa production**. Finding OVAL20.01 P1 [CONFIRMED], mức AUTO + ARTIFACT. Không nghiệm thu lại thao tác Tauri/bản cài.

## 1. Kết luận đúng ca khách

Lỗi nằm trong PDF xuất, không phải zoom của viewer, cũng không phải solver tự làm khuôn lớn hơn.

- Nguồn: C:/Users/Khanh Pham/AppData/Local/Temp/PrynX-dev/results/sticker_6419bca2.pdf, 123 trang.
- Kết quả: C:/Users/Khanh Pham/AppData/Local/Temp/PrynX-dev/results/nup_64e3aaa5.pdf, job 64e3aaa5, lúc 17:17 ngày 20/09.
- Thiết lập ghi trong log: Từng tem, N-Up sequential, optimal_auto, grouping=none, giấy 330x480 mm, hở 2x2 mm, bleed 0, vùng in 320x470 mm, khuôn master oval.
- 17 trang PDF = 16 trang IN + một trang khuôn chung. Tổng 128 artwork placements.
- **Chỉ hai placement giữ scale 1,000000. Cả 126 placement còn lại có scale 2,136893.**
- Hai ô đầu đúng **cùng lấy trang nguồn 1**, không phải hai trang nguồn khác nhau. Chuỗi source trên tờ đầu: 1,1,2,2,3,3,4,4.

Ảnh Poppler của nguồn trang 1 và 2 đều cho thấy hình tem đầy đủ cùng khổ. Ảnh Poppler của PDF xuất tờ 1 tái hiện đúng screenshot: hai ô đầu bình thường, từ ô thứ 3 artwork phóng lớn và bị khuôn oval cắt mất ngoại vi.

## 2. Bằng chứng hình học và nội dung

Tất cả trang nguồn có MediaBox/CropBox xấp xỉ 160x100 mm, Rotate=0. Trang đầu có CutContour; 122 trang còn lại không có đường bế thật, dùng khuôn kế thừa.

| Đại lượng | Trang nguồn 1 | Trang nguồn 2..123 |
|---|---:|---:|
| Bitmap nền nhúng ở các trang đã kiểm tài nguyên | 5000x3125 pixel | 5000x3125 pixel |
| Số path vector | 3 | 2 |
| Bbox artwork mà hàm hiện hành trả | 160,6957 x 101,3027 mm | 75,2007 x 17,7857 mm |
| Thành phần chi phối bbox | Có cả đường CutContour oval | Chỉ khung tên hình chữ nhật ở giữa |
| Scale đo từ content stream PDF | 1,000000 | 2,136893 |

Đã quét artwork_bbox của đủ 123 trang: đúng một bbox lớn và 122 bbox nhỏ. Đã đọc mọi /NupXo Do trên tất cả trang output để đếm scale và source index, không suy từ riêng screenshot.

Phép tính của registration:

```text
master_width / caption_width
= 160,6957458 / 75,2006656
= 2,1368926003
```

Đây chính là scale làm tròn 2,136893 được ghi trong PDF. Nghĩa là **213,69% kích thước gốc**, tăng khoảng 113,69%, không phải “tăng thêm 213%”.

Bbox nhỏ không phải bbox toàn bộ artwork: raster vẫn có ảnh nền chiếm gần trọn trang. Hàm vector-only bỏ qua nội dung bitmap vì đã tìm thấy path vector hợp lệ.

## 3. Đường chạy và nguyên nhân gốc

Source dưới D:/pdfcompare; HEAD kiểm tra 0c8a347e11dfb9857b2a31433cfebce3cedccbd0, đọc working tree hiện tại.

1. UI Từng tem / N-Up -> processHandlers -> /nup-start -> nup_engine.
2. nup_engine.py:1280-1340 xác định đúng một trang có khuôn và bật homogeneous_plan, master_page_idx=0. Log batch thực tế cũng ghi single_mold_fast_path master_page=0.
3. nup_process_chunk.py:1004-1020 gọi sticker_homogeneous.artwork_bbox cho mỗi trang và truyền kết quả thành homogeneous_clip.
4. **sticker_homogeneous.py:287-324 là điểm lỗi:** hợp bbox các vector path rồi return ngay khi có một path hợp lệ; chỉ raster fallback khi không có vector. Bitmap và text không phải vector path không được tính đầy đủ. Không loại CutContour khỏi tập “artwork”.
5. Trang đầu có CutContour bao gần trọn tem nên bbox tình cờ đúng. Trang sau chỉ có hai path của khung tên 75,2x17,8 mm nên hàm hiểu nhầm đó là toàn nội dung.
6. nup_artwork.py:1011-1110 đi nhánh homogeneous registration: show_pdf_page(clip=homogeneous_clip, keep_proportion=True), đồng thời dùng khuôn master làm out_clip_path.
7. pdf_ops.py:650-675 dùng kích thước clip để tính scale và lấy min hai trục; :690+ ghi cm và Do. Toàn artwork bị phóng theo bbox sai, rồi clip oval trên tờ cắt mất phần nằm ngoài khuôn.

Consumer live đã xác minh: homogeneous_clip thực sự điều khiển hệ số scale; đây không phải field chết hoặc khác biệt preview schematic. Hàm registration_for có scale_warning nhưng renderer live không gọi hàm đó để chặn/cảnh báo ca này.

## 4. Vì sao preview không báo lỗi

Preview đang mô tả hình khuôn, số ô và vị trí. Hình oval có thể vẫn đúng hoàn toàn trong khi artwork bên trong bị scale sai ở pha writer.

Do đó chỉ kiểm “8 ô/tờ”, kích thước khuôn hay tọa độ placements sẽ không phát hiện lỗi này. Cần kiểm thêm phép biến đổi artwork, clip nguồn và tài nguyên ảnh/VDP thực.

## 5. Hướng sửa đề xuất, chờ duyệt

Không nên chữa bằng cách chỉ tắt xoay, giảm scale cố định, sao chép bitmap trang 1 cho tất cả trang, hoặc thay toàn bộ artwork_bbox bằng MediaBox mà không phân biệt nghiệp vụ.

1. Với tài liệu VDP đã cùng khổ và cùng hệ tọa độ như ca này: kế thừa **hình học khuôn/clip**, giữ tỷ lệ và registration của artwork gốc; không dùng bbox của một chi tiết trang trí để tự co/phóng lại cả trang.
2. Nếu cần auto-fit cho nguồn chưa đăng ký cùng khuôn: đo đầy đủ painted content gồm image/Form/text/vector và loại hình học khuôn khỏi artwork bbox. Vector-first chỉ được dùng khi chứng minh nó bao đủ nội dung, không phải cứ có vector là bỏ raster.
3. Tách rõ clip để giới hạn vùng nhìn thấy với khung dùng để tính scale. Chặn hoặc báo rõ trường hợp scale bất thường, thay vì phóng hơn 2 lần mà vẫn báo thành công.
4. Giữ test cho trường hợp registration có chủ đích của nguồn khác khổ; không làm hỏng các job đang cần co-khít thật.
5. Thêm regression: nền bitmap + khung tên vector + dữ liệu text, chỉ trang đầu có CutContour; page boxes giống/khác nhau, Rotate 0/90, master không ở đầu, nhiều chunk và cả N-Up/S&R.
6. Nghiệm thu bằng nguồn thật: kiểm scale và nguồn của mọi ô, đọc/render IN và khuôn chung, đối chiếu nội dung từng bản VDP. Chưa hứa đã sửa hoặc file hiện tại có thể dùng sản xuất.

Phạm vi rà consumer sau sửa: nup_process_chunk homogeneous N-Up, nhánh manual/simple dùng chung registration, S&R master inheritance, default fallback geometry và renderer dùng pdf_ops.show_pdf_page. Không tự đổi thuật toán packing hoặc chính sách quantity trong cùng bản vá nếu chưa có bằng chứng.

## 6. Test và khoảng trống

Chạy 4 file hiện có: test_sticker_homogeneous.py, test_sticker_homogeneous_render.py, test_sticker_homogeneous_parity.py, test_sticker_homogeneous_integration.py, seed 20260920.

- Lượt đầu: 33 pass / 5 fail.
- Một fail là Hypothesis input-generation health-check chậm; chạy lại đúng test riêng: 1 pass.
- Bốn fail còn lại là các assertion quantity/routing (ví dụ muốn 4 artwork nhưng thực tế autofill nhiều ô). Chúng không chứng minh thêm bốn lỗi phóng ảnh; chưa sửa test hoặc kết luận nguyên nhân lịch sử của thay đổi ngoài phạm vi này.
- test_p9_vector_first_no_raster hiện khóa giả định có path vector là không cần raster; fixture không có bitmap nền + khung vector như file khách nên không bắt được lỗi này.
- Không có sửa source, không export lại file khách, không reset/kill/restart, không thay worker/RAM.

Quan sát bổ sung: output có 128 bản cho 123 trang nguồn, trong đó năm nguồn đầu xuất hai lần. Điều này giải thích hai ô đầu cùng nguồn master. Chưa kết luận riêng về số lượng đặt hàng khi chưa có đầy đủ SL riêng từng loại của request thực tế; không tự gộp vấn đề này với lỗi scale.

## 7. Dấu vết tái hiện

- Probe chỉ đọc: D:/printsolutions-main/product/xep quan ao/tmp/audit_oval_scale.py.
- Bằng chứng đầy đủ: cùng tmp/audit-oval-scale-evidence.json.
- Bản tóm tắt có SHA256 nguồn/kết quả: docs/audit/TEM_OVAL_SCALE_2026-09-20.json.
- PNG đã kiểm: workspace/tmp/pdfs/audit-oval-scale-20260920/source-001.png, source-002.png, output-sheet1.png.
- Các PDF nguồn/kết quả được giữ nguyên. Chưa có PDF “đã sửa” trong lượt này.
