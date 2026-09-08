# NHẬT KÝ SỬA UX BẢN QUYỀN

**Ngày:** 2026-09-08  
**Báo cáo:** `docs/BAO_CAO_AUDIT_LICENSE_MODAL_2026-09-08.md` và
`docs/BAO_CAO_AUDIT_LICENSE_UX_2026-09-08.md`

## Lô 1 — Transient verification không còn khóa toàn màn hình

- `desktop/src/stores/useAuthStore.ts`
  - Thêm `isTransientLicenseOutcome()` để phân biệt lỗi hạ tầng/cục bộ với
    `server_rejected`/`device_limit`.
  - Lỗi transient tự xếp retry 10 phút; không tạo burst vượt quota challenge.
  - `retryValidation()` bỏ lượt khi đang có thao tác license khác.
  - Offline token hợp lệ tự xóa `isLicenseLocked` và `lockReason` cũ.
  - `NETWORK_ERROR`/`RATE_LIMITED` không có token offline hợp lệ giữ đúng outcome
    transient, không hiện nhầm thông báo “phiên đã hết hạn”.
- `desktop/src/components/auth/LicenseLockOverlay.tsx`
  - `anchor_*` và network lỗi hiện banner `role=status`, không phủ workspace và
    không gợi nhập key mới. `native_error`/`persistence_error` vẫn hard-lock vì
    có thể là lỗi cache ký hoặc lưu credential chưa bền vững.
  - Retry có `try/catch/finally`, không kẹt loading hoặc unhandled rejection.
- `desktop/src/App.tsx`
  - Không mount LoginScreen khi đã có key; tránh LoginScreen ẩn chồng overlay và
    giành focus/input.
- `desktop/src/stores/useAuthStore.dielineKeyStatus.test.ts`
  - Regression transient classification, auto-retry sau backoff và clear stale
    lock khi offline token hợp lệ.
- `desktop/src/components/auth/LicenseLockOverlay.test.tsx`
  - Regression banner không chặn và retry reject không kẹt UI.

## Verify

- License store + LockOverlay: **74 passed**.
- Full frontend Vitest: **3460 passed, 2 skipped**.
- Typecheck và Vite build: đạt.
- Native signer vẫn fail-closed; bản sửa chỉ thay đổi UX/recovery của renderer.

## Còn lại

- Revocation grace 5 phút chưa được nối vào production branch terminal; đây là
  lô riêng để tránh thay đổi chính sách thu hồi trong cùng patch.
- Cooldown rate-limit chưa có đồng hồ đếm ngược trên banner; hiện retry interval
  tự tôn trọng cooldown.
- Chưa smoke Tauri packaged với sleep/resume, proxy/VPN và lỗi quyền DPAPI.
