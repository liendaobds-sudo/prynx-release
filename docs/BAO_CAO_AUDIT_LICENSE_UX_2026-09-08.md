# BÁO CÁO AUDIT — CÁC VẤN ĐỀ UX CƠ CHẾ BẢN QUYỀN

**Ngày:** 2026-09-08  
**Repo/revision:** `D:\\pdfcompare`, branch `codex/pre-release-audit-2026-08-04`, HEAD `ea4e863`  
**Liên quan:** `docs/BAO_CAO_AUDIT_LICENSE_MODAL_2026-09-08.md`  
**Chế độ:** security/UX audit chuẩn, read-only; không gọi production và không dùng secret thật.  
**Phạm vi:** startup, login, lock overlay, expiry banner, đổi key, offline grace, heartbeat/retry.  
**Bằng chứng:** code hiện tại + `75 passed` ở test auth/license/overlay; ảnh modal người dùng cung cấp là bằng chứng runtime bên ngoài workspace (`[EXTERNAL]`).
**Trạng thái:** Lô 1 đã triển khai; các finding còn lại chờ lô riêng.

## 1. Tóm tắt

Ngoài lỗi modal `anchor_missing` đã ghi ở báo cáo trước, còn **6 điểm UX** có
bằng chứng code. Chúng không nên được xử lý bằng cách bỏ qua native/license gate;
native signer vẫn phải fail-closed. Vấn đề là cách trình bày và recovery ở renderer:

- lỗi tạm thời bị biến thành modal khóa toàn màn hình;
- retry tự động không chạy sau khi đã khóa;
- startup timeout có thể hiện màn nhập key khi lượt xác minh cũ vẫn đang chạy;
- LoginScreen và LockOverlay cùng tồn tại như hai modal `aria-modal` chồng nhau;
- nút thử lại bị cooldown nhưng không giải thích;
- lỗi bất ngờ có thể làm nút retry kẹt ở trạng thái loading.

## 2. Findings bổ sung

### §SEC.LICUX.1 — Startup timeout có thể hiện màn nhập key khi validate cũ còn chạy (**P2, confidence 0,96, [VERIFIED]**)

**Bằng chứng:**

- `desktop/src/App.tsx:250-253` đặt `SPLASH_AUTH_DEADLINE_MS = 15_000`.
- `desktop/src/App.tsx:307-315` cho splash thoát khi hết 15 giây dù `isChecking`
  vẫn còn `true`.
- `desktop/src/App.tsx:346-351` suy `isAuthenticated` chỉ từ
  `licenseKey && licenseValid`; khi validate chưa xong, LoginScreen được render.

**Tác động:** request native/Edge chậm hơn 15 giây có thể làm người dùng thấy
“nhập license key” hoặc modal khóa trong khi lượt kiểm tra key cũ chưa kết thúc.
Nhập key mới lúc đó sẽ xếp sau giao dịch cũ, tạo cảm giác app phản hồi sai hoặc
bắt nhập key lặp.

### §SEC.LICUX.2 — Hai modal `aria-modal` chồng nhau trong trạng thái lock (**P2, confidence 0,99, [VERIFIED]**)

**Bằng chứng:**

- `desktop/src/App.tsx:346-354` render đồng thời `LoginScreen` và
  `LicenseLockOverlay` khi `licenseKey` còn nhưng `licenseValid=false`.
- `desktop/src/components/auth/LoginScreen.tsx:52-57` có `role="dialog"`
  + `aria-modal="true"`.
- `desktop/src/components/auth/LicenseLockOverlay.tsx:136-143` cũng có
  `role="dialog"` + `aria-modal="true"` và phủ `fixed inset-0`.

**Tác động:** màn hình nhìn như một modal duy nhất nhưng trình đọc màn hình có
hai modal cùng lúc; focus/ESC và thứ tự điều hướng có thể rơi vào LoginScreen
ẩn phía sau. Nút “Nhập license key khác” của overlay vì thế cũng cạnh tranh với
màn nhập key nền.

### §SEC.LICUX.3 — Mất mạng sau lock không có recovery tự động (**P1, đã xác minh ở báo cáo trước**)

`useAuthStore.ts:1196-1203`, `:1405-1413`, `:1848-1869` tạo đúng mâu thuẫn:
`failClosed()` đặt `isLicenseLocked=true`, focus từ chối khi locked, còn retry
interval chỉ được tạo khi `!isLicenseLocked`. Xem chi tiết và chuỗi tái hiện tại
`BAO_CAO_AUDIT_LICENSE_MODAL_2026-09-08.md §SEC.LIC.1`.

### §SEC.LICUX.4 — Cooldown rate-limit bị im lặng (**P2, confidence 0,97, [VERIFIED]**)

**Bằng chứng:**

- `desktop/src/stores/useAuthStore.ts:1360-1365` đặt cooldown 5 phút sau
  `RATE_LIMITED`.
- `desktop/src/stores/useAuthStore.ts:1490-1494` trả `undefined` ngay khi còn
  cooldown, không trả trạng thái cho UI.
- `desktop/src/components/auth/LicenseLockOverlay.tsx:169-176` vẫn hiển thị
  nút “Thử lại ngay” như có thể thực hiện.

**Tác động:** người dùng bấm nhiều lần nhưng không có thay đổi hoặc giải thích;
không biết phải chờ bao lâu và dễ nghĩ key hỏng.

### §SEC.LICUX.5 — Retry không có `finally`, lỗi bất ngờ có thể kẹt nút (**P2, confidence 0,92, [SUSPECTED]**)

**Bằng chứng:**

- `desktop/src/components/auth/LicenseLockOverlay.tsx:102-106` đặt
  `setIsRetrying(true)`, `await retryValidation()`, rồi mới đặt false.
- Không có `try/finally`; nếu một exception ngoài các nhánh đã bắt trong store
  thoát ra, overlay giữ `isRetrying=true` vĩnh viễn cho tới khi unmount.

**Proof gap:** test hiện chỉ mock `retryValidation` resolve; chưa có test reject.

### §SEC.LICUX.6 — Thông điệp recovery gợi nhập key mới cho lỗi không liên quan key (**P2, confidence 0,98, [VERIFIED]**)

**Bằng chứng:**

- `LicenseLockOverlay.tsx:177-183` luôn hiển thị “Nhập license key khác”
  bên dưới nút retry, kể cả khi outcome là `anchor_missing`,
  `anchor_unavailable`, `network_error` hoặc `native_error`.
- `LicenseLockOverlay.tsx:120-126` chỉ đổi tiêu đề cho device-limit/server-rejected;
  lỗi tạm thời vẫn dùng tiêu đề “Không thể xác minh bản quyền”.

**Tác động:** người dùng bị hướng sang đổi key dù key chưa bị server từ chối;
đây là nguyên nhân dễ dẫn tới việc nhập lại key nhiều lần và phát sinh race
đổi-key/validate.

## 3. Các điểm đã kiểm tra nhưng chưa xếp finding mới

- `TrialExpiryBanner` đã là banner không chặn thao tác; chỉ hiện khi
  `licenseValid=true` và còn ≤7 ngày (`TrialExpiryBanner.tsx:29-31`). Chưa thấy
  bằng chứng nó là nguồn của modal toàn màn hình.
- `ChangeLicenseKeyPanel` giữ key cũ khi verify key mới thất bại
  (`useAuthStore.ts:1563-1572,1637-1641`), đây là hành vi đúng về an toàn; vấn đề
  là nó đang được đưa ra như lựa chọn đầu tiên cho lỗi mạng.
- Heartbeat đã có debounce 10 phút (`useAuthStore.ts:1826-1871`), nhưng debounce
  không giải quyết được dead retry sau hard lock (§SEC.LICUX.3).
- Không có bằng chứng token/key bị ghi vào log UI; các test hiện hành vẫn giữ
  nguyên control không echo secret.

## 4. Khuyến nghị và trạng thái triển khai

### Lô 1 — Tách transient verification khỏi hard lock (≤5 file) — **đã triển khai**

1. `desktop/src/stores/useAuthStore.ts`
2. `desktop/src/components/auth/LicenseLockOverlay.tsx`
3. `desktop/src/App.tsx`
4. `desktop/src/stores/useAuthStore.dielineKeyStatus.test.ts`
5. `desktop/src/components/auth/LicenseLockOverlay.test.tsx`

- Giữ `isLicenseLocked` toàn màn hình cho `server_rejected`, `device_limit` và
  clock rollback thật.
- Với network/anchor tạm thời: giữ key, giữ native signer fail-closed,
  hiển thị banner “đang chờ xác minh”, retry backoff có giới hạn và tự đóng khi
  proof online thành công.
- `native_error`/`persistence_error` vẫn giữ hard-lock vì có thể là lỗi cache ký
  hoặc credential chưa được lưu bền vững; chỉ bổ sung thông báo hành động rõ hơn.
- Khi `isChecking=true`, không mount LoginScreen/LockOverlay chồng nhau; sau
  timeout chỉ hiện trạng thái “đang kết nối lại”, không gợi đổi key ngay.
- Retry dùng `try/finally`, hiển thị cooldown kế tiếp thay vì nút giả lập có thể
  bấm nhưng không làm gì.

Kết quả thực tế: `anchor_*`/`network_error`/`rate_limited` hiện dùng banner và
retry 10 phút; `native_error`/`persistence_error` vẫn hard-lock. `App.tsx` không
mount LoginScreen khi đã có key, tránh hai modal và giành focus.

### Lô 2 — Regression UX/runtime (≤5 file)

- Test network down → tự hồi phục không reload.
- Test anchor missing + online proof → tạo anchor, đóng banner, heartbeat chạy.
- Test rate-limit → countdown/cooldown đúng, không tạo challenge dồn.
- Test retry reject → nút không kẹt loading.
- Test accessibility chỉ còn một `aria-modal` active.
- Smoke Tauri packaged: sidecar chậm, sleep/resume, đổi mạng, proxy/VPN.

## 5. Chốt

Có thêm vấn đề trải nghiệm đáng sửa, nghiêm trọng nhất là §SEC.LICUX.3 và
§SEC.LICUX.1. Lô 1 đã xử lý nhánh transient; chưa có bằng chứng key khách hàng
sai hoặc cần nhập lại. Các finding còn lại (deactivation/release seat, revocation
grace, TTL token, CTA gia hạn, locale và accessibility) vẫn là lô riêng.
