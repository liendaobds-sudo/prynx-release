# NHẬT KÝ SỬA — LEASE OFFLINE LICENSE 72 GIỜ

**Ngày:** 2026-09-09  
**Mục tiêu:** khách có thể dùng bản cài đã xác minh trong một cuối tuần mất mạng,
nhưng khi online vẫn heartbeat 10 phút và kiểm tra thu hồi bình thường.

## Chính sách đã áp dụng ở source

- V3 token mới: lease tối đa **72 giờ**.
- Token V3 cũ 15 phút vẫn được verifier chấp nhận.
- Challenge/proof online và clock-anchor recovery vẫn giữ cửa sổ ngắn; không mở
  rộng thành đường bootstrap offline.
- Native binding trong RAM vẫn có cache 8 giờ; heartbeat/đăng ký lại bằng token
  DPAPI và anchor hợp lệ, không giữ binding vô hạn.
- Token được cấp không vượt quá `expires_at` của license trên Edge.
- UI hiện trạng thái “Đang dùng phiên offline” và thời gian còn lại; hết lease sẽ
  chờ online, không bắt nhập lại key nếu key vẫn còn hợp lệ.

## Rollout tương thích

Client mới gửi capability `offline_lease_seconds=259200`; client cũ không gửi field
này nên Edge cấp lease legacy 900 giây. Vì vậy thứ tự phát hành bắt buộc là:

1. Deploy Edge/shared protocol trước.
2. Xác minh Edge vẫn cấp 900 giây cho request client cũ.
3. Sau đó phát hành desktop mới xin 72 giờ.

Không deploy Edge mới sau khi phát hành desktop mới, vì server cũ chưa biết field
capability và sẽ từ chối request challenge có field thêm.
Transcript canonical của client cũ không có dòng capability, nên challenge cũ đang
trong cửa sổ sống vẫn prove được sau khi Edge mới lên.

## File đã sửa

- `supabase/functions/_shared/license_protocol_v3.ts`
- `supabase/functions/license-verify/index.ts`
- `desktop/src/lib/licenseProtocolV3.ts`
- `desktop/src/stores/licenseToken.ts`
- `desktop/src/components/auth/LicenseLockOverlay.tsx`
- `backend/app/core/license_guard.py`
- `desktop/src-tauri/src/security.rs`

## Verify

- Backend token verifier: **99 passed**.
- Frontend token/protocol/auth/overlay: **110 passed**.
- Native `cargo check`: đạt; native security tests: **63 passed**.
- TypeScript typecheck và Vite build: đạt.
- TypeScript syntax parse Edge/shared bằng compiler local: đạt.
- Canonical transcript smoke: request legacy không có capability giữ format cũ;
  request mới bind `offline_lease_seconds=259200` vào challenge/proof.

## Giới hạn bằng chứng

- Chưa deploy Edge Function hoặc migration lên production.
- Chưa chạy Tauri packaged thật qua chuỗi Friday offline → Monday online,
  sleep/resume, proxy/VPN và clock service.
- Thu hồi khi máy hoàn toàn offline có thể trễ tối đa 72 giờ; đây là đánh đổi
  bắt buộc của chính sách cuối tuần.

## Deploy production — 2026-09-09

- Project: `ryvyuxjgdcvoxujqmggm` (`KhanhPVN123's Project`).
- Function: `license-verify`, deploy riêng, không `--prune`, không migration.
- Trước deploy: version `20`, bundle hash
  `cf1c793e193083e1bcbc73cc61a106cbfd8bb744ac182c7b1320889ff78de0ca`.
- Sau deploy cuối: version **22**, `status=ACTIVE`, `verify_jwt=true`, bundle hash
  `e068c7286080dad87b089780cf4f6c66082b7cd12f87b688a1afeb75ceab84cb`.
- Tải lại source sau deploy cho hash trùng local:
  `license-verify/index.ts` `490F5BDA11ED2405E4E8C652A18435B0B2DCB15C11FBDECEAF1DF37BCAAA1768`;
  shared protocol `8615082B8D24BE4B5DE24F637627A212CB9594F8F3C21F5B966C9ACC5B36A706`.
- Không gọi verify thật để tránh tiêu challenge/activation; smoke production cần
  chạy bằng license test được cấp riêng.
