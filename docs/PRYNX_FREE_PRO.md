# PrynX Free/Pro — ma trận quyền và quy trình phát hành

## Ma trận đã triển khai

### Free

- Xáo trộn, resize một file, tách, quản lý trang, ghép PDF.
- Khóa/mở khóa, metadata, nén cơ bản, watermark, Header & Footer.
- Word/Excel/Google Docs sang PDF từng file.
- So sánh văn bản.

### Pro

- Trim & Shift; resize và Office theo lô/thư mục.
- Preflight, chuyển màu, hairlines, trapping, cutline/bleed, PDF/X.
- Data Merge, numbering, cover numbering.
- Booklet, N-Up, bình tem bế, CNC.
- Khuôn bao bì, tách nền, upscale, so sánh PDF pixel.

N-Up hiện được khóa theo toàn bộ công cụ. Nếu sau này cần N-Up Free 2-up/4-up, phải tách capability trong màn hình N-Up; không nên giả lập bằng giới hạn số trang.

## Tương thích key cũ

- Migration đặt plan=pro cho toàn bộ key hiện hữu.
- Token thiếu plan (token cũ/offline) được desktop và sidecar hiểu là Pro.
- Chỉ key được quản trị viên đặt rõ free mới nhận quyền Free.
- features[] cho phép cấp ngoại lệ một tính năng mà không tạo gói mới.

## Trình tự bật trên production

1. Chạy migration 20260718_prynx_free_pro_entitlements.sql.
2. Deploy edge function license-verify; xác nhận response/token có plan và features.
3. Tạo một key Free thử nghiệm và kiểm tra cả online lẫn mở lại app offline.
4. Build desktop với VITE_FEATURE_GATING_ENABLED=true và PRYNX_FEATURE_GATING_ENABLED=true.
5. Phát hành theo nhóm nhỏ trước khi cập nhật toàn bộ khách hàng.

Không đảo thứ tự: bật desktop trước server có thể làm sai quyền. Token có TTL 72h để khách hợp lệ không bị khóa sau cuối tuần hoặc kỳ nghỉ ngắn, đồng thời giới hạn độ trễ thu hồi khi máy khách offline (audit 2026-07-25 rút từ 7 ngày).
