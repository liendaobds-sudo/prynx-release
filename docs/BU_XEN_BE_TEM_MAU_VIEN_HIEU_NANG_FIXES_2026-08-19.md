# Fix log — Bù xén bế tem: màu viền và OOM ảnh không DPI — 2026-08-19

Đối chiếu với
`docs/BAO_CAO_AUDIT_BU_XEN_BE_TEM_MAU_VIEN_HIEU_NANG_2026-08-19.md`.

## Lô A — Hợp đồng màu nền và độ phủ nguồn màu

- `LegacyApprovedContour` mang thêm hai scalar
  `edge_background_rgb/edge_background_tolerance`; không mang mask NumPy qua
  route/process pool.
- Route chuyển hai scalar cùng Alpha + Bézier đã duyệt; payload cũ thiếu hai key
  vẫn hợp lệ.
- Engine chỉ dùng ngữ cảnh này cho sampler màu, không thay mask/hình học.
- Mọi candidate adaptive phải phủ tối thiểu 90% shell hình học chưa lọc màu.
  Candidate sạch nền đầu tiên theo thứ tự nông → sâu được chọn; vài pixel tối cục
  bộ không còn quyền đại diện cho cả chu vi.
- Candidate còn phải đạt mật độ nguồn tối thiểu 20% so với shell hình
  học. Guard này chặn cả speckle tối rời rạc nhưng vẫn giữ đường mực
  liên tục chỉ dày một pixel.
- Khi ảnh thấp DPI bị render phóng, sampler chỉ được thăm dò thêm đúng phần dịch
  do nội suy (`ceil(source_to_render - 1)`, đồng thời ≤ hai bề dày shell) nếu đã
  chứng minh còn halo nền; ảnh chạy lưới native không được vượt `max_peel_px`, và
  mọi candidate mở rộng vẫn phải qua guard 90%.
- Nếu không tìm được shell sạch đủ phủ, giữ nguồn ban đầu và phát cảnh báo thay vì
  âm thầm kéo nguồn thưa quanh tem.

## Lô B — Tách màu khỏi hình học và giữ lưới raster approved

- Legacy bridge chạy `_background_detection()` chỉ để lấy hai scalar màu nền.
  Kết quả nhị phân của `simple-bg` **không** được dùng làm Alpha/path hình học.
- Hình học một tem opaque tiếp tục dùng Alpha chuyển tiếp của AI như hợp đồng cũ.
  Đây là bắt buộc: trên file thật, dùng nhầm mask `simple-bg` đã tạo 11 đường/
  905 cubic (10 vòng rác); Alpha AI tạo đúng 1 đường/91 cubic, không vòng rác.
- Presmooth theo `boundary_source` thật thay vì hard-code `ai`.
- Chỉ nhánh approved `ai|simple-bg`, đồng thời được chứng minh là đúng một ảnh phủ
  kín trang, mới kẹp raster về lưới pixel nguồn. PDF Alpha/SMask, vector/mixed và
  luồng direct-engine giữ nguyên độ phân giải cũ.
- Giữ `skimage.find_contours` để bảo toàn nội suy subpixel; chỉ bỏ phần upscale giả.

## Lô D — Quan sát vận hành (phần trực tiếp của lỗi)

- Log `[STICKER_STAGE]` cho nguồn contour, kích thước raster, DPI thực, thời gian
  render, `find_contours` và tổng thời gian trang.
- Page metadata có `render_dpi`, `raster_width_px`, `raster_height_px`,
  `raster_seconds`, `find_contours_seconds`, `edge_sample_peel_px` và màu nền
  approved khi có.

## Bổ sung — Chế độ Tách nhiều tem

- Luồng giao diện thật `inspect → auto detect → confirm → export` dùng contract
  `alpha_path_overrides`, không dùng `approved_contour_overrides` của chế độ
  thường. Exporter nay đo nền phẳng trên RGB nguyên tấm và gắn hai scalar màu vào
  từng trang Alpha trung gian; engine dùng chúng riêng cho sampler màu bleed.
- `auto` vẫn giữ `simple-bg` khi thật sự nhận ra nhiều tem, tránh AI gộp/mất tem.
  Khi `simple-bg` chỉ nhận đúng một tem, pipeline chạy thêm Alpha AI và chỉ nhận
  hình học đó nếu AI vẫn trả một tem và IoU với silhouette chắc chắn đạt ≥0,80.
- Trên đúng `tải xuống.jpg`, artifact lỗi đi `simple-bg`, tạo 11 path/905 cubic và
  mất `edge_background_rgb`. Artifact cuối đi Alpha AI có kiểm tra, còn 1 path/93
  cubic, nhận nền `RGB(254,254,254)` và hoàn tất `7,237 s` ở lượt cache-hit.
- Render PDF cuối đã soi trực tiếp: cung tròn và hai đầu ribbon không còn bậc
  thang/móc. Ca hai tem nền trắng tiếp tục đi deterministic, không gọi AI.

Admission RAM liên-kind và provider/cache timing chi tiết của BiRefNet vẫn là
backlog rộng hơn. File đối chứng vẫn dùng AI để bảo toàn hình học, nhưng không còn
raster 28 Mpx; vì vậy lỗi OOM 214 MiB không quay lại.

## Verify

File thật: `C:\Users\Khanh Pham\Desktop\tải xuống.jpg`, SHA-256
`EA6B7C5865A48871C5A015481C975B930916BC4BE94E08EB44312B84F68640E6`.

- PDF frontend-equivalent: `tmp/audit_tai_xuong_frontend.pdf`.
- Output đối chứng: `tmp/audit_tai_xuong_fixed_output.pdf`.
- Preview: `tmp/audit_tai_xuong_fixed_preview.png`.
- Lượt cache-hit qua helper + engine production: approved `1,994 s`, engine
  `1,077 s`, tổng `3,636 s`; `boundary=ai`, nền `RGB(254,254,254)`, tolerance
  `12`.
- Lượt cold trong process sạch: approved AI `12,849 s` với DirectML và
  `12,322 s` khi ép CPU; cộng engine đo được khoảng `1,1–1,8 s`, tức tổng dự kiến
  khoảng `14–15 s`, không còn treo hơn một phút.
- Raster `2000×2000 @ 72 DPI`; `find_contours 0,0531 s`; sampler chọn peel `7`;
  không có warning.
- PDF cuối có đúng **1 CutContour/91 cubic**, không còn 11 đường/905 cubic và
  10 vòng rác của bản `simple-bg` hồi quy.
- Đọc lại XObject bleed của PDF: median `RGB(85,10,6)`; không còn median hồng
  nhạt `RGB(255,233,233)` trước sửa.
- Trước sửa: raster `5292²`, pad `5294²`, riêng float64 contour cần
  `213,825 MiB` và lỗi cấp phát. Sau sửa: contour chạy trên lưới `2000²`.

Test cuối đã đạt:

- Source pipeline + edge color + parallel fallback + cutline tuning: **123/123**.
- `backend/tests/test_sticker_engine_e2e.py`: **137/137**.
- Tổng phạm vi liên quan ở lượt cuối: **260/260**.
- Bổ sung chế độ nhiều tem: source pipeline **31/31**, API/session/preview/export/
  màu **167/167**, StickerEngine E2E **137/137**; tổng lượt mới **335/335**.

Trong lượt full đầu, ba hồi quy Alpha/SMask + custom 1600 mm đã được test bắt;
phạm vi source-grid sau đó được thu hẹp đúng nhánh approved. Lượt full kế tiếp bắt
thêm ca JPEG 72 DPI direct-engine thiếu coverage; sampler được bổ sung rescue có
guard 90%. Lượt full cuối đạt 137/137.
