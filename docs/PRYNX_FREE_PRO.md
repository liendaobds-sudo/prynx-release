# PrynX Free/Pro — ma trận quyền và quy trình phát hành

## Ma trận đã triển khai

### Free

- Xáo trộn, resize/crop một file, tách, quản lý trang, ghép PDF.
- Khóa/mở khóa, metadata, nén cơ bản, watermark, Header & Footer.
- Word/Excel/Google Docs sang PDF từng file.
- So sánh văn bản.

### Pro

- Trim & Shift; resize và Office theo lô/thư mục.
- Preflight (gồm Chữ & Font), chuyển màu, hairlines, trapping, cutline/bleed, PDF/X.
- Thư viện vật tư in.
- Data Merge, numbering, cover numbering.
- Booklet, N-Up, bình tem bế, CNC.
- Khuôn bao bì, tách nền, upscale, so sánh PDF pixel.

N-Up hiện được khóa theo toàn bộ công cụ. Nếu sau này cần N-Up Free 2-up/4-up, phải tách capability trong màn hình N-Up; không nên giả lập bằng giới hạn số trang.

## Tương thích key cũ

- Migration provisioning backfill **gói PrynX cũ** thành `pro` trước khi phát token mới, để khách đã mua không bị hạ nhầm.
- Token/response thiếu hoặc sai `plan` luôn rơi về `free` (fail-closed) ở website, desktop và sidecar.
- `features[]` chỉ cấp đúng từng `FeatureId`; grant N-Up không mở Booklet, grant Numbering không mở Data Merge.
- Crop dùng `pdf.crop` (Free). Chữ & Font dùng chung `prepress.preflight`; không tạo capability riêng.
- `pdf.optimize_advanced` đã bị xóa vì không có sản phẩm/consumer tương ứng; Optimize hiện là Free qua `pdf.optimize`.

## Nguồn quyền và các lớp cưỡng chế

- `desktop/src/lib/toolRegistry.ts` bắt buộc mọi tool đang bật có `featureId` typed. Home, menu, workspace, preset và Recipe dùng cùng registry/guard.
- Backend cưỡng chế capability cụ thể trước khi tạo job/artifact. Preflight và VDP không còn gate cả router bằng một quyền cha.
- Sidecar đã đóng gói luôn bật gate; env không thể tắt. Dev thường tắt để phát triển nhanh; chạy `run_dev.bat --gated` để bật đồng thời frontend và backend như bản đóng gói.
- Paper Library vẫn chạy trong WebView nên đây là rủi ro thương mại cục bộ đã chấp nhận, không phải biên chống crack. Component vẫn re-check quyền và phủ khóa khi downgrade.

## Trình tự bật trên production

1. Review/backup rồi áp đủ migration trong `supabase/migrations/security-manifest.json`, gồm `20260804070000_prynx_package_entitlements_required.sql`.
2. Deploy Edge Function `license-verify`; xác nhận response và signed token có đúng `plan`/`features` từ package đã mua.
3. Tạo key Free, Pro và custom grant thử nghiệm; kiểm cả online, offline và Pro → Free khi app đang mở.
4. Chạy dev-gated và test tự động; sau đó build nội bộ đầy đủ. Không còn đường `SkipNuitka` dùng sidecar cũ.
5. Installed-artifact smoke phải xác nhận manifest ghi hai gate bật, Python ABI/provenance đúng và signed Free bị từ chối một capability Pro.
6. Chỉ sau smoke nội bộ mới duyệt riêng việc phát hành công khai/upload GitHub.

Không đảo thứ tự và không suy đoán migration/Edge Function đã live chỉ vì code nằm trong repo. Token có TTL 72h để khách hợp lệ không bị khóa sau cuối tuần hoặc kỳ nghỉ ngắn, đồng thời giới hạn độ trễ thu hồi khi máy khách offline (audit 2026-07-25 rút từ 7 ngày).
