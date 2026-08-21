# Báo cáo audit preview đường bế tem canonical — 2026-08-21

## Kết luận

Preview classic và file xuất đang không dùng cùng một artifact hình học. Preview
dựng Bézier trong session, nhưng `/pdf-tools/sticker-dieline` bỏ cache đó rồi
inspect, nhận diện và fit lại. Hệ quả là đường trên màn hình có thể khác CutContour
trong PDF, đồng thời người dùng phải chờ cùng một công việc nặng hai lần.

## Bằng chứng

- `sticker_cutline_preview.py` đã ghi `path_groups` vào
  `page.cutline_export_cache`, nhưng cache thiếu fingerprint, Alpha và mức denoise.
- `pdf_tools.py` luôn gọi `build_legacy_single_page_approved_contour()` ở nhánh
  một tem raster; helper này render, detect và fit lại từ đầu.
- `StickerTool.tsx` tắt hook preview khi `isProcessing=true`; cleanup của hook xóa
  session đúng lúc người dùng bấm **Thực thi**.
- Trên wrapper PDF của `Desktop\tải xuống.jpg` (2000×2000, khoảng 72 DPI), một
  lượt preview đo được khoảng 30 giây và 691 đoạn. Denoise 85 và 100 trả cùng
  fingerprint vì giới hạn vật lý hiện tại kẹp sigma ở khoảng 0,85 px.

## Phương án được duyệt từ yêu cầu trực tiếp của người dùng

1. Preview là nơi duy nhất nhận diện và fit đường bế.
2. Session lưu một artifact nguyên tử gồm Alpha, Bézier, revision, fingerprint,
   tham số hình học và số đo an toàn máy.
3. Frontend gửi session/revision/fingerprint khi Thực thi.
4. Backend fail-closed nếu artifact stale; không âm thầm nhận diện lại.
5. Session sống tới khi backend đã snapshot artifact.
6. Nới bộ lọc denoise theo lưới pixel nguồn ở DPI thấp, không thay cap worker và
   không giảm công suất máy mạnh.
7. Nhánh Tách nhiều tem/selection giữ nguyên pipeline riêng.

## Chốt verify

- Test đỏ: reuse artifact, stale revision, stale fingerprint và lifecycle session.
- Đo lại đúng file `Desktop\tải xuống.jpg`.
- So fingerprint/path preview với path đưa vào engine xuất.
- Chạy focused backend, frontend và typecheck trước khi báo hoàn tất.

## Kết quả sau sửa

- Preview và Thực thi dùng chung một artifact Alpha + Bézier; stale reference bị
  từ chối, không âm thầm detect/fit lại.
- Snapshot chạy ngoài event loop; selection/Tách nhiều tem vẫn dùng pipeline riêng.
- Trên đúng PDF do `pdf-lib` bọc từ `Desktop\tải xuống.jpg`: nhận diện 0,381 s,
  preview 0,635 s, Thực thi 1,210 s; đường bế 174 đoạn, 0 cusp.
- So với baseline khoảng 30 s/preview và thêm một lượt fit khi Thực thi, đường
  runtime chính nay hoàn tất preview khoảng một giây và bỏ toàn bộ lượt fit thứ hai.
