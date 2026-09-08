# KIỂM TRA MIGRATION LICENSE PrynX — 2026-09-08

> Chế độ: **read-only qua Supabase CLI**. Không `db push`, không deploy Edge,
> không sửa dữ liệu và không đọc license key/token.

## 1. Project và công cụ

- Project ref lấy từ `supabase/.temp/linked-project.json`:
  `ryvyuxjgdcvoxujqmggm`.
- `D:\\pdfcompare\\supabase` hiện chỉ có snapshot Edge Function/CLI link, không có
  thư mục migration đầy đủ; vì vậy không dùng nó làm nguồn so sánh schema.
- Local migration source: `D:\printsolutions-main\supabase\migrations`.
- Supabase CLI kết nối remote thành công; CLI báo bản cài `v2.116.0` và có
  bản mới `v2.117.0`.

## 2. So sánh migration local/remote

`supabase migration list --project-ref ryvyuxjgdcvoxujqmggm --output-format json`
cho thấy remote đã có `20260904120000`, nhưng các file local sau đang không có
record tương ứng ở remote:

- `20260818250000_restart_affiliate_machine_commission.sql`
- `20260819090000_harden_purchase_pricing_entitlements.sql`
- `20260819091000_harden_order_access_and_idempotency.sql`
- `20260819092000_harden_affiliate_ledger.sql`
- `20260824110000_add_multi_tem_license_product.sql`
- `20260824120000_add_license_machine_unblock.sql`
- `20260828100000_prynx_activation_hardening.sql`
- `20260828110000_harden_qr_scan_grant.sql`

Ngoài ra local có **hai file cùng version `051`**:

- `051_add_multi_tem_license_product.sql`
- `051_fix_sepay_auto_confirm.sql`

CLI cũng bỏ qua `security-manifest.json` vì đây không phải tên migration hợp lệ.

`supabase db diff --linked` chưa chạy được vì Docker Desktop daemon không có
(`dockerDesktopLinuxEngine` không tồn tại). Phần schema ở mục 3 được xác nhận
thay bằng các truy vấn catalog `SELECT` chỉ đọc trên remote.

### Nhận định

Đây là **migration-history drift**, không đủ cơ sở kết luận schema remote thiếu
hết nội dung: một số object của migration 20260828 hiện vẫn tồn tại trên remote.
Tuy nhiên không được chạy `supabase db push` mù quáng; cần reconcile lịch sử và
kiểm tra dependency/idempotency từng file trước.

## 3. Schema và policy remote đã xác nhận

Truy vấn `SELECT` chỉ đọc xác nhận remote có:

- `license_activations.device_key_id`, `device_public_jwk`, `device_trust`,
  `device_key_epoch`, `protocol_floor`, `last_device_proof_at`.
- Bảng `prynx_device_challenges_v3` với challenge/proof/consume state.
- Hàm `prynx_caller_is_service_role`, `issue_prynx_device_challenge_v3`,
  `finalize_prynx_device_challenge_v3`, `verify_license`,
  `verify_license_guarded`.
- Policy PrynX hiện tại:
  - `minimum_issue_protocol = 2`;
  - `legacy_issue_until = 2026-09-11 23:30:39` giờ Bangkok;
  - lý do: rollout device authority v3, v2 chỉ drain trong cửa sổ có hạn.

## 4. Mức độ legacy đang tồn tại

Thống kê remote, không định danh khách hàng:

- License PrynX active: **30**; trong đó **1** đã quá hạn.
- Activation PrynX active với `protocol_floor=1`: **42**.
- Activation PrynX active với `protocol_floor=3`: **1**.
- Activation PrynX inactive: 2 (1 floor 1, 1 floor 3).

Điều này nghĩa là phần lớn seat PrynX vẫn là legacy. Client mới có thể nâng cấp
êm nếu còn token v2 hợp lệ và đúng máy; các ca mất token cũ/reinstall/đổi TPM có
thể gặp `DEVICE_LIMIT` hoặc cần recovery/reset.

## 5. Edge Function

`supabase functions list` xác nhận:

- `license-verify`: **ACTIVE version 20**, cập nhật `2026-09-04 18:10:00 UTC`.
- `license-release`: **ACTIVE version 3**.

Source local trong hai checkout có timestamp/kích thước khác nhau và mới hơn mốc
deploy nêu trên; chưa download source remote bằng API để đối chiếu bundle hash,
nên chưa thể kết luận source hiện tại đã được deploy hoàn toàn. Đây là proof gap
release, không tự suy là lỗi production.

## 6. Verdict phát hành

1. **Key cũ:** vẫn được server chấp nhận nếu license còn active; cửa sổ legacy v2
   hiện còn tới `2026-09-11 23:30:39 +07:00`.
2. **Nâng client mới:** không nên phát hành đại trà trước khi chạy test legacy
   activation trên máy thật/staging, đặc biệt key có seat `protocol_floor=1`.
3. **Migration:** remote đã có v3 object cần thiết, nhưng history drift + duplicate
   version `051` là cổng chặn quy trình; phải reconcile trước mọi `db push`/squash.
4. **Edge source/deploy:** cần chốt commit/bundle hash nào là bản production trước
   khi build installer.
