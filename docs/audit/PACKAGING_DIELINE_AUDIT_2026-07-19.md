# Audit toàn diện Khuôn bế bao bì — 2026-07-19

## Kết luận

Tính năng khuôn bế đã được chuyển từ engine chạy trực tiếp trong WebView sang luồng có kiểm soát quyền ở ba lớp: API sidecar, token Ed25519 trong native Rust và bundle engine nhúng trong native. Các lỗi an toàn sản xuất, xếp khuôn, bất đồng bộ UI, xuất PDF khay/vỏ và rò tài nguyên 3D đã được xử lý.

Trạng thái: **đạt để tích hợp vào bản phát hành kế tiếp**, với điều kiện vẫn chạy quy trình build production chuẩn của dự án trước khi phát hành. Lần sửa này không đóng gói installer/release.

## Các vấn đề đã xử lý

| Mức | Vấn đề | Cách xử lý |
|---|---|---|
| Critical | `packaging.dieline` chạy hoàn toàn ở client, có thể gọi khi bypass UI | WebView chỉ gọi `/api/dieline/generate`; route yêu cầu entitlement; Rust xác minh lại chữ ký token, máy, key, product và feature trước khi chạy engine |
| Critical | Payload tùy ý có thể tạo số cực lớn, NaN hoặc vòng lặp xếp khuôn quá mức | Schema và giới hạn đồng nhất tại frontend, FastAPI và Rust; request/response có giới hạn byte; tối đa 20.000 placement |
| Critical | Heuristic xếp khuôn có thể chồng đường CUT thật | Kết quả được xác minh lại bằng silhouette CUT, spatial index và khoảng hở dao tối thiểu; khay/vỏ được kiểm riêng |
| High | Preview/PDF dùng quy ước xoay 90°/270° khác engine | Một hợp đồng biến đổi tọa độ dùng chung cho collision, preview SVG, PDF kỹ thuật và PDF sản xuất |
| High | Kết quả cũ có thể ghi đè kết quả mới khi thay thông số liên tục | Abort request cũ, version hóa phản hồi, chỉ nhận response mới nhất; model bị đánh dấu stale ngay khi tính lại |
| High | Có thể xuất/in model cũ hoặc model đang lỗi | Khóa nút xuất/in và phủ trạng thái stale cho tới khi response mới thành công |
| High | PDF “sản xuất” trước đây lẫn chú thích/kích thước và không có spot color chuẩn | Tách PDF kỹ thuật và PDF sản xuất; PDF sản xuất dùng `CutContour`, `Crease`, `Bleed`, DeviceCMYK Separation và overprint; chặn nếu CUT hở |
| High | Xếp khuôn khay/vỏ xuất nhầm toàn bộ model tại mỗi vị trí khay | Tách model khay và model vỏ; cùng vật liệu xuất một trang với hai nhóm; khác vật liệu xuất hai trang/khổ độc lập; áp dụng cả Ctrl+P |
| Medium | `gutter` nhỏ có thể làm yếu khoảng hở dao | Khoảng cách grid luôn là `max(gutter, dieGap)` |
| Medium | Canvas 3D render liên tục và DPR cao gây nóng/giật | `frameloop="demand"`, DPR giới hạn 1–1.5, pointer move được throttle bằng animation frame |
| Medium | Object URL/texture ảnh có thể tồn tại sau replace/reset | Không lưu blob URL vào undo history; revoke URL cũ; dispose texture và xóa cache loader |
| Medium | Ảnh mockup quá lớn gây tăng RAM/GPU | Giới hạn 25 MB, cạnh 8.192 px và 40 MP trước khi nạp |
| Medium | Bundle sidecar từng kéo theo public assets không cần thiết | Build sidecar dùng `publicDir: false`, dọn output trước build; output chỉ còn bundle engine khoảng 102 KB |

## Luồng quyền sau sửa

1. UI kiểm tra catalog Free/Pro để hiển thị công cụ.
2. WebView gửi request có chữ ký và license token tới sidecar.
3. FastAPI xác minh request, token và entitlement `packaging.dieline`.
4. Native Rust xác minh độc lập chữ ký Ed25519, hạn token, machine id, key hash, product và plan/feature.
5. Native mới chạy bundle engine và trả model đã qua giới hạn schema.

Bypass UI hoặc gọi trực tiếp API không còn đủ để mở engine bằng key Free.

## Xác minh cuối

- Frontend: **93 test files passed; 864 passed; 2 skipped** (hai fixture PDF trực quan chỉ chạy khi bật biến QA).
- Backend toàn bộ: **959 passed; 7 skipped**.
- Native Rust dieline: **5 passed; 0 failed**.
- API thật FastAPI → native debug: HTTP 200, `rte`, 13 panels, 6-up.
- TypeScript + Vite production web build: đạt.
- Sidecar bundle build: đạt; kiểm tra WebView không chứa protected engine entry: đạt.
- PDF production khay/vỏ: parse hợp lệ; combined 1 trang, split 2 trang; render Poppler cho thấy khay và vỏ nằm đúng nhóm/tờ.
- `git diff --check`: sạch.

## Việc không phải blocker

- Build còn cảnh báo chunk lớn và một số dynamic import không tách chunk; đây là nợ tối ưu chung của desktop, không làm sai khuôn bế.
- Rust còn cảnh báo API PyO3 cũ ở các module PDF/imposition khác; dieline test vẫn đạt.
- Bảo vệ native làm tăng đáng kể chi phí crack nhưng không thể biến ứng dụng desktop thành tuyệt đối không thể reverse-engineer. Quyền cuối vẫn dựa vào token có chữ ký và thời hạn phía server.
- Trước khi phát hành cần chạy quy trình `build_production.ps1` bình thường trên máy release; audit này chủ ý không tạo installer.
