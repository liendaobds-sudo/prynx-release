# BÁO CÁO AUDIT — MODAL “KHÔNG THỂ XÁC MINH BẢN QUYỀN”

**Ngày:** 2026-09-08  
**Repo/revision:** `D:\\pdfcompare`, branch `codex/pre-release-audit-2026-08-04`, HEAD `ea4e863`  
**Chế độ:** security/UX audit chuẩn, read-only; không dùng secret thật, không gọi production.  
**Input:** ảnh người dùng cung cấp (modal hiển thị “Chưa có checkpoint thời gian tin cậy”).  
**Trạng thái:** Lô 1 đã triển khai sau khi được duyệt; còn các lô UX/license khác.  
**Phạm vi:** `App.tsx` → `LicenseLockOverlay` → `useAuthStore.validateLicense/checkSession/startHeartbeat` → native clock anchor.  
**Ngoài phạm vi:** Supabase production/Edge thật, DPAPI blob thật trên máy khách, packaged installer và thay đổi license server.

## 1. Kết luận điều hành

Modal xuất hiện không đồng nghĩa license đã hết hạn hay bị thu hồi. Với đúng câu
trên ảnh, trạng thái là **anchor_missing**: một lượt xác minh gặp lỗi tạm thời
trong khi máy chưa có checkpoint thời gian tin cậy.

Có một lỗi UX/availability đã xác minh:

1. `validateLicense()` gọi `failClosed()` và đặt `isLicenseLocked=true` cho lỗi
   anchor/network.
2. Sau đó `startHeartbeat()` không chạy vì chỉ được gọi khi validate thành công.
3. Nhánh tạo `retryInterval` lại yêu cầu `!isLicenseLocked`, trong khi validate
   vừa đặt cờ này thành `true`; vì vậy retry tự động không bao giờ được tạo.
4. Khi đã khóa, focus handler cũng chủ động thoát sớm. Người dùng phải bấm
   “Thử lại ngay” thủ công; nếu app khởi động lại trong cùng điều kiện, modal lại
   xuất hiện.

Đây giải thích trực tiếp trải nghiệm “hay xuất hiện bảng này”. Các trạng thái
terminal thật (`EXPIRED`, `BLOCKED`, `MACHINE_REVOKED`, `DEVICE_LIMIT`) cần khóa
cứng; lỗi mạng/anchor tạm thời nên dùng trạng thái **đang chờ xác minh** hoặc
banner không chặn toàn màn hình.

## 2. Chuỗi tái hiện logic

```text
App mount
  → checkSession()
  → load DPAPI key/token
  → validateLicense()
  → load_clock_anchor = missing/unavailable
  → Edge/native request lỗi mạng hoặc rate-limit
  → ensureOfflineAnchor() = false
  → failClosed(anchor_missing/anchor_unavailable)
  → isLicenseLocked = true
  → LicenseLockOverlay phủ toàn màn hình
```

Sau bước cuối:

```text
heartbeat chưa được start
focus handler: if (isLicenseLocked) return
retry interval: chỉ tạo nếu (!isLicenseLocked)  // điều kiện không thể đúng
```

## 3. Findings

### §SEC.LIC.1 — Retry tự động bị vô hiệu sau lỗi tạm thời (**P1, confidence 0,99, [VERIFIED]**)

**Bằng chứng:**

- `desktop/src/stores/useAuthStore.ts:1196-1203`: `failClosed()` luôn đặt
  `licenseValid=false`, `isLicenseLocked=true` cho mọi outcome lỗi.
- `desktop/src/stores/useAuthStore.ts:1405-1413`: lỗi `NETWORK_ERROR`/
  `RATE_LIMITED` gọi `ensureOfflineAnchor()`; anchor thiếu/hỏng trả false và
  khóa ngay.
- `desktop/src/stores/useAuthStore.ts:1848-1852`: focus handler trả về ngay khi
  `get().isLicenseLocked`.
- `desktop/src/stores/useAuthStore.ts:1861-1869`: retry interval chỉ được tạo
  sau validate thất bại khi `!get().isLicenseLocked`; điều kiện này mâu thuẫn
  với `failClosed()` nên không đạt được ở nhánh anchor/network.
- Test hiện tại `desktop/src/stores/useAuthStore.dielineKeyStatus.test.ts:533-546`
  xác nhận anchor thiếu làm lock, nhưng chưa có test chứng minh retry tự động
  hoặc recovery không cần reload.

**Tác động:** mạng chập chờn hoặc sidecar/PowerShell chưa sẵn sàng ở lần đầu
khởi động biến thành modal khóa cứng; app không tự hồi phục dù server đã hoạt động
trở lại.

### §SEC.LIC.2 — Lỗi tạm thời bị trình bày như trạng thái chặn toàn app (**P1, confidence 0,98, [VERIFIED]**)

**Bằng chứng:**

- `desktop/src/App.tsx:346-354` luôn mount `LicenseLockOverlay` cạnh Login/AppInner.
- `desktop/src/components/auth/LicenseLockOverlay.tsx:98-100` chỉ kiểm
  `isLicenseLocked`, không phân biệt `anchor_missing`, `anchor_unavailable`,
  `network_error` với trạng thái terminal.
- `desktop/src/components/auth/LicenseLockOverlay.tsx:136-144` dùng
  `fixed inset-0`, `aria-modal=true`, backdrop và chặn toàn bộ giao diện.

**Tác động:** người dùng thấy ổ khóa và phải nhập key khác dù key chưa được
server xác nhận là sai. Đây là lỗi trust/UX nghiêm trọng, dù chưa phải bypass
security.

### §SEC.LIC.3 — Startup retry lại tạo cùng modal ở mỗi lần mở app (**P1, confidence 0,96, [VERIFIED]**)

**Bằng chứng:**

- `desktop/src/App.tsx:292-303` gọi `checkSession()` mỗi lần main app mount.
- `desktop/src/stores/useAuthStore.ts:1113-1148` luôn nạp key/token rồi gọi
  `validateLicense()` khi có credential.
- Nếu lượt đó gặp lỗi trước khi native ghi anchor, `:1167-1173` giữ key nhưng
  đặt lại `isLicenseLocked=true`; lần khởi động sau lặp nguyên chuỗi.

**Tác động:** máy mới, máy vừa nâng cấp hoặc máy bị lỗi quyền DPAPI/PowerShell
không có cơ hội tự tạo checkpoint nếu lần đầu không online hoàn hảo.

### §SEC.LIC.4 — Nút “Thử lại ngay” có thể không làm gì nhưng không báo lý do (**P2, confidence 0,95, [VERIFIED]**)

**Bằng chứng:**

- `desktop/src/stores/useAuthStore.ts:1490-1494`: `retryValidation()` trả về
  im lặng khi `rateLimitedRetryAfterMs` chưa hết.
- `desktop/src/components/auth/LicenseLockOverlay.tsx:102-106,169-176` chỉ có
  loading boolean; không hiển thị thời điểm retry kế tiếp hoặc trạng thái
  cooldown.

**Tác động:** người dùng bấm nút nhiều lần nhưng không biết đang bị cooldown
5 phút; cảm giác app bị hỏng hoặc key bị từ chối.

### §SEC.LIC.5 — Copy UI mâu thuẫn với hành vi runtime (**P2, confidence 0,97, [VERIFIED]**)

**Bằng chứng:**

- `LicenseLockOverlay.tsx:162-166` hiển thị chuỗi “Hệ thống tự động kiểm tra
  định kỳ” cho mọi lỗi không-terminal.
- Nhưng `startHeartbeat()` chỉ được gọi sau validate thành công
  (`useAuthStore.ts:1174-1176`); sau lock, focus và retry interval đều không
  tạo được theo §SEC.LIC.1.

**Tác động:** thông báo hứa một cơ chế tự phục hồi đang không chạy.

### §SEC.LIC.6 — Anchor phụ thuộc vào lượt native registration online (**P2, confidence 0,91, [VERIFIED] code / [EXTERNAL] runtime**)

**Bằng chứng:**

- `desktop/src-tauri/src/security.rs:1139-1159`: anchor chỉ được cập nhật trong
  `register_validated_key` khi có online proof hợp lệ.
- `security.rs:3447-3475`: release bắt buộc anchor hợp lệ trước khi ký request;
  missing/corrupt/unavailable đều fail-closed.
- `security.rs:3478-3533`: lỗi APPDATA/DPAPI/PowerShell được phân loại
  unavailable/corrupt; chưa có bằng chứng packaged runtime thật trên máy khách
  trong phiên này.

**Tác động:** quyền file, PowerShell bị chặn, hoặc native registration lỗi có thể
  khiến checkpoint không bao giờ được tạo/cập nhật; cần telemetry an toàn để
  phân biệt các nguyên nhân này thay vì bắt người dùng nhập key lại.

## 4. Những gì đã xác minh và chưa xác minh

**Đã xác minh:**

- Code path và điều kiện mở modal như trên.
- Test license/overlay hiện có: `75 passed`.
- Các test hiện tại cố ý bảo vệ fail-closed cho anchor thiếu/hỏng; đây là control
  chống dùng offline không có bằng chứng thời gian, không phải bằng chứng rằng UX
  khóa cứng là phù hợp.

**Chưa xác minh ([EXTERNAL]):**

- File `prynx_clk.dat` trên máy người dùng có tồn tại hay không, kích thước và
  quyền DPAPI.
- Log native/Edge tại thời điểm modal xuất hiện.
- Hành vi Tauri packaged sau khi sidecar vừa khởi động, sleep/resume, đổi mạng,
  VPN/proxy hoặc Windows clock service chưa sẵn sàng.
- Trạng thái production Edge/RPC và rate-limit thật.

## 5. Đề xuất sửa theo lô (chưa triển khai)

### Lô 1 — Tách trạng thái tạm thời khỏi hard lock (≤5 file)

1. `desktop/src/stores/useAuthStore.ts`
2. `desktop/src/components/auth/LicenseLockOverlay.tsx`
3. `desktop/src/App.tsx`
4. `desktop/src/stores/useAuthStore.dielineKeyStatus.test.ts`
5. `desktop/src/components/auth/LicenseLockOverlay.test.tsx`

Đề xuất:

- Chỉ `server_rejected`, `device_limit` và clock rollback thật mới dùng
  `isLicenseLocked` phủ toàn màn hình.
- `anchor_missing`, `anchor_unavailable`, `network_error`, `rate_limited` chuyển
  sang `licenseVerificationPending`/banner không chặn; vẫn giữ native signer
  fail-closed, không mở quyền trái phép.
- Khởi động retry có backoff khi lỗi tạm thời; không tạo challenge dồn dập và
  vẫn tôn trọng cooldown server.
- Khi online proof thành công, tự đóng banner/modal và start heartbeat.

### Lô 2 — Telemetry chẩn đoán an toàn và recovery test (≤5 file)

1. `desktop/src/stores/useAuthStore.ts`
2. `desktop/src-tauri/src/security.rs`
3. `desktop/src/stores/useAuthStore.dielineKeyStatus.test.ts`
4. test native clock-anchor tương ứng

Chỉ ghi enum + timestamp/latency + phase (`load_anchor`, `challenge`, `prove`,
`register`) — tuyệt đối không ghi key/token/path nhạy cảm. Thêm test sleep/resume,
anchor missing + online thành công, network down rồi tự hồi phục, rate-limit và
anchor write permission failure.

## 6. Chốt audit

Đây là finding UX/availability đã được xác minh bằng code và test hiện có; chưa
phải kết luận license server hay key khách hàng sai. Lô 1 đã được triển khai;
kết quả nằm trong `docs/LICENSE_UX_FIXES_2026-09-08.md`. Còn kiểm tra mức 3 trên
Tauri thật bằng chuỗi: mở app → rút mạng/khởi động sidecar chậm → nối mạng lại
→ app tự hồi phục mà không yêu cầu nhập key lần nữa.
