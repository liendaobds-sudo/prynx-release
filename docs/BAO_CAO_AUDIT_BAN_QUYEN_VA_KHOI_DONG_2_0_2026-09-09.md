# Audit bản quyền và khởi động PrynX 2.0 — 2026-09-09

## 1. Kết luận điều hành

**Bản cài 2.0 hiện tại: HOLD, không dùng làm bản giao khách. Chưa sửa code/build/deploy trong đợt audit này.**

Hai triệu chứng phải được tách riêng:

1. **“Cài xong mở không lên” đã có bằng chứng trực tiếp:** log ứng dụng ghi `PRYNX_FRONTEND_HASH not set at build time`. Native trả lỗi rồi `exit(1)` trước khi chạy xác minh license. Dấu vết biên dịch gần nhất thiếu cả hash frontend và sidecar; kịch bản NSIS gần nhất không đóng gói backend. Manifest trong thư mục phát hành không còn khớp installer cùng tên.
2. **“Web báo 1/1 nhưng nhập key không được”:** server ghi activation trước khi ký/trả token và trước khi desktop lưu DPAPI, xác minh native. Vì vậy 1/1 không chứng minh desktop đã kích hoạt thành công, cũng không chứng minh key không hợp lệ. Chưa có log lỗi native/DPAPI của đúng lượt nhập key để xác định nguyên nhân duy nhất trên máy này. Có một phụ thuộc HWID legacy thừa trong registration V3 cần kiểm ưu tiên.

Commit `5532fbd` chỉ sửa chọn action khi `validateLicense` đọc cached token và xử lý `RECOVERY_REQUIRED`. Hai màn nhập key gọi `changeLicenseKey`, là đường khác; không thể coi commit đó đã chữa đầy đủ lỗi nhập key mới. Nó cũng không sửa cấu hình build native.

Ngoài hai triệu chứng chính, audit xác nhận native khuôn bế còn giới hạn token V3 15 phút trong khi client/server đã chuyển sang 72 giờ, và hai checkout Edge đang lệch hợp đồng request.

## 2. Phạm vi, baseline và quyền thao tác

- Mode: audit theo luồng + review diff, kiểm artifact sẵn có và chạy kiểm thử cục bộ cô lập.
- PrynX HEAD: `641fdc46958b7a17365b9ef5685bedbf9f54e67e`; diff license: `5532fbdb27635a631ba6fd5f4d2318c8d23d1b0c^..5532fbdb27635a631ba6fd5f4d2318c8d23d1b0c`.
- PrintSolutions HEAD: `93fd6155f5a57d3c4ccc995cd5cce57112850411`.
- Bản full-build được manifest ghi nhận: `35e85c9a478a248aba82b2b3827cc94247635df8`, version `2.0.0`, `RUNTIME_VERIFIED=no`.
- Biên đã rà: Login/ChangeKey → store → Tauri IPC/CNG/DPAPI → Edge challenge/proof → SQL activation → token → native/backend consumers; EXE → integrity → sidecar và hợp đồng installer/manifest.
- Tài sản: key/token/activation slot, device authority, clock anchor, quyền Free/Pro và tính đầy đủ của bản cài.
- Threat model: `docs/audit/PRYNX_THREAT_MODEL.md`, đối chiếu tài liệu license ngày 08–09/09 và build/security audit trước. Tài liệu cũ không được dùng thay bằng chứng code.
- Không sửa credential, xóa key/token/HWID/CNG, nhả/reset slot, gọi activation thật, truy vấn DB production, chạy/cài lại app, dừng tiến trình, build release, deploy, commit hoặc push.
- Worktree đầu lượt đã có `docs/audit/CUTLINE_NODE_2026-09-09/`. Trong lượt có phiên khác sửa master matrix và tạo báo cáo giảm node; giữ nguyên các thay đổi đó. Đợt này chỉ ghi báo cáo này và bổ sung hàng `W8-U05` vào matrix.

### Quy ước bằng chứng

`[CONFIRMED]` trong bảng chính có artifact/log hoặc kiểm tra tự động tối thiểu. Kiểm predicate trích từ source không được gọi là chạy native/installer end-to-end. `[SUSPECTED]` không xếp severity; mô tả điều đã trace và phần chưa tái hiện. Mọi phát hiện chưa có bản vá: **Accepted → đề xuất → chờ duyệt**, chưa `Verified/Closed` theo nghĩa bản vá.

## 3. Đường chạy đã xác minh

### 3.1. Khởi động bản release

`desktop/src-tauri/src/main.rs` → `lib.rs:7752 run()` → setup/logger `:7887` → `verify_frontend_integrity` `:8008` → kiểm `option_env!("PRYNX_FRONTEND_HASH")` `:6827` → thiếu giá trị trả `Err` `:6829` → ghi lỗi/hộp thoại/`exit(1)` `:8011–8018`.

Chỉ sau đó mới đến sidecar startup `:8060` và `verify_sidecar_integrity` `:8118`. Thiếu hash sidecar cũng bị từ chối tại `:6776–6781`.

### 3.2. Nhập key → server ghi slot → desktop nhận hoặc từ chối

`LoginScreen.tsx:36` / `ChangeLicenseKeyPanel.tsx:63` → `useAuthStore.ts:1616 changeLicenseKey` → `:1661 runLicenseProtocolV3(action=recover)` → `licenseProtocolV3.ts:326` lấy CNG identity, challenge, proof → Edge `supabase/functions/license-verify/index.ts:914` gọi finalize RPC.

SQL ở repo PrintSolutions, `supabase/migrations/20260904120000_prynx_device_authority_v3.sql:622–644`, insert activation `is_active=true`; `:657–666` trả `VALID`. Edge `:935` mới gọi hàm cấp kết quả; `:641` ký token. Desktop tiếp tục kiểm response `useAuthStore.ts:1687`, lưu key/token `:1698/:1711`, native register `:1728`, rồi mới commit trạng thái `:1759`.

Native fail → rollback credential cũ `:1734–1748`. Đây không phải rollback transaction đã hoàn tất trên server. Admin hiển thị `current_activations/max_activations` ở `D:/printsolutions-main/src/components/admin/AdminLicenses.tsx:298`; phép đếm là activation active (`supabase/migrations/010_multi_machine_licenses.sql:32`).

**Phản chứng bắt buộc:** SQL `:573–601` tái sử dụng cùng CNG device đang active, không áp max-seat lần nữa. Vì thế 1/1 của chính device không tự chặn retry. Slot của key A cũng không làm key B hoàn toàn khác hết suất: query đếm theo `license_id`.

### 3.3. Startup, retry và đổi key không cùng đường

- `checkSession` nạp DPAPI rồi gọi `validateLicense`: `useAuthStore.ts:1181–1241`.
- Helper mismatch mới chỉ được dùng tại `:1333–1341`; cached token có `k` khác key hiện tại → chọn `enroll`.
- `changeLicenseKey` luôn dùng `recover` tại `:1665`. Đây **đúng hợp đồng**: SQL cho enroll/recover tạo mới khi còn seat (`:603–644`), native cần receipt recovery khi thay binding đang hoạt động.
- `validateLicense` có **cầu V2 có thời hạn** sau `DEVICE_LIMIT`: `:1466–1472` → `tryLegacyV2DrainAfterDeviceLimit` `:270–332`. Nó xin challenge mới, không cần token cũ nhưng cần HWID còn khớp và policy drain đang mở; native vẫn kiểm chữ ký/key/HWID/challenge. Không phải tự migrate legacy sang CNG, không phải bypass.
- Đường nhập key `changeLicenseKey` không gọi cầu V2 đó. Do vậy xóa credential rồi nhập lại một key legacy có thể khác với giữ key và retry/startup.

## 4. Phát hiện chính

| ID | Mức / effort | Trạng thái | Phát hiện |
|---|---|---|---|
| §SEC.LIC20.01 | P1 / S–M | CONFIRMED: log + artifact compiler | Release thiếu hash lúc biên dịch, tự thoát trước auth. |
| §SEC.LIC20.02 | P1 / S | CONFIRMED: artifact NSIS/config | Kịch bản installer gần nhất không đóng gói sidecar backend. |
| §SEC.LIC20.03 | P1 / S | CONFIRMED: SHA-256 thực | Manifest phát hành không khớp installer hiện có. |
| §SEC.LIC20.04 | P1 / M | CONFIRMED: predicate nguồn + trace | Native khuôn bế từ chối lease V3 72 giờ đang được cấp. |
| §SEC.LIC20.05 | P2 / S | CONFIRMED: source-method probe | Hướng dẫn nhập lại cùng key nhưng thao tác không chạy xác minh. |
| §SEC.LIC20.06 | P1 / M | CONFIRMED: parser hai repo | Deploy từ checkout web hiện tại sẽ từ chối request desktop mới. |

Tổng: **6 confirmed (5 P1, 1 P2); 2 nghi vấn cần runtime ở mục 5.** Đây chủ yếu là lỗi correctness/khả dụng và hợp đồng phát hành, không phải 6 lỗ hổng bypass bản quyền.

### §SEC.LIC20.01 — Thiếu cấu hình integrity trong binary release

- Log thật `C:/Users/Khanh Pham/AppData/Local/com.prynx.app/logs/PrynX.log:2–10`: chín lỗi ngày 09/09, mốc thô `06:37:31` đến `07:21:27`, cùng nội dung `PRYNX_FRONTEND_HASH not set at build time`.
- Compiler dep-info mới `desktop/src-tauri/target/release/deps/app_lib-8171d1b51086f5dd.d:272–275`, thời gian file 13:59:59: `PRYNX_FRONTEND_HASH`, `PRYNX_SIDECAR_HASH`, hai cờ feature đều không có giá trị.
- Dep-info lần full-build `app_lib-ab0bdffb38a76e52.d:272–275`, 11:07:28, có đủ hai hash; frontend hash khớp manifest 11:20.
- Binary đã cài chứa chuỗi lỗi thiếu hash, không chứa frontend hash của manifest full-build. Kiểm này chỉ đọc bytes, không chạy EXE.
- Consumer gây lỗi: `lib.rs:6829` → `:8018 exit(1)`, chưa đến license.

**Root cause đã đủ để giải thích app không mở:** artifact release thiếu input bắt buộc lúc compile. Chưa xác định lệnh build người dùng đã gõ; không quy lỗi riêng cho diff `5532fbd`, không suy thành antivirus/TPM hay key sai.

**Đề xuất:** dùng đúng pipeline có hash/config overlay; bổ sung gate đóng gói báo lỗi trước khi tạo installer, không đợi khách double-click. Giữ integrity fail-closed; không chữa bằng bỏ check hoặc đặt hash giả. Gate cần phân biệt packaging với debug/check/test để không phá QA hợp lệ.

### §SEC.LIC20.02 — Kịch bản installer không có backend

- `desktop/src-tauri/target/release/nsis/x64/installer.nsi` sinh lúc 14:02:59: `:618` copy EXE chính, `:620–748` copy resources, **không có bất kỳ entry copy `pdf-inspector-backend`**.
- Base config `desktop/src-tauri/tauri.conf.json:120` không khai `externalBin`; `tauri.prod.conf.json:6` và `tauri.release.conf.json:6` mới khai sidecar. Pipeline chuẩn gọi Tauri với overlay tại `build_production.ps1:2342`.
- Installer hiện tại dài **68.055.751 byte**; kích thước chỉ là tín hiệu hỗ trợ, không phải chứng minh chính.
- Thư mục đã cài vẫn có backend **419.079.168 byte**, thời gian file 11:00:26; SHA-256 khớp sidecar full-build cũ. Có backend trên máy nâng cấp không chứng minh installer mới cung cấp nó.

**Tác động:** recipe này không bảo đảm cold-install có backend; cập nhật trên máy cũ có thể che lỗi bằng file còn lại. Bằng chứng đạt generated-artifact; chưa giải nén độc lập installer hoặc cài trên user sạch nên không nâng thành nghiệm thu clean-install.

**Đề xuất:** không giao installer này; ràng buộc overlay/sidecar vào đường đóng gói và kiểm inventory trước/sau cài. Sửa duy nhất hash frontend chưa đủ.

### §SEC.LIC20.03 — Provenance không còn thuộc installer cùng tên

`Ban_Phat_Hanh/release-manifest.txt:3` ghi commit `35e85c9…`, giờ tạo 11:20:17, còn installer bị thay lúc 14:04:51.

| Artifact / giá trị | SHA-256 |
|---|---|
| Installer ghi trong manifest | `50b7f032f2958471f419bcc98e8cfb66fb05bdf5b493246dda75f6eb8abe016c` |
| Installer hiện tại ở `Ban_Phat_Hanh` và `target/release/bundle/nsis` | `272055c0a64d1123878bf7fb89d06f53da116f4cb89a497650f1904783decfe4` |
| EXE full-build ghi trong manifest | `ae305dcf975c280475fbea2953596555057771194e709bc6252c9a9622fe0b77` |
| EXE hiện ở `target/release` | `229983de2f903e5b27d13be315f101dc057386f96428e6b5e923468946f58c6b` |
| EXE đang cài | `80edf293e2ff1d53a8d8bd7fc060bd03482c9ec2a4e2d985b9cc315417b1746a` |
| Backend đang cài và staging | `5108dc4596c1cb41a71c0d06c4c2a05d07b196c6d3f94a0ee2f9a666499a11f2` |

Không suy EXE khác hash là bị can thiệp: manifest đã ghi rõ `EXE_SHA256=NOT_VERIFIED_INSTALL_PAYLOAD`. Kết luận chắc chắn là **manifest hiện tại không thể làm bằng chứng QA/provenance cho installer hiện tại**.

**Đề xuất:** định danh artifact theo từng lượt build, finalize/hash đúng file trước khi bàn giao. Không sửa tay manifest để hợp pháp hóa bản thiếu backend/hash; không dùng nhãn `RUNTIME_VERIFIED=yes` khi chưa cài/smoke sạch.

### §SEC.LIC20.04 — Native Dieline còn TTL 15 phút

- Client mặc định xin `259200` giây tại `desktop/src/lib/licenseProtocolV3.ts:319–342`.
- Edge/shared, frontend token parser, Tauri và backend đã cho 72 giờ: `supabase/functions/_shared/license_protocol_v3.ts:16`, `desktop/src/stores/licenseToken.ts:64`, `desktop/src-tauri/src/security.rs:781`, `backend/app/core/license_guard.py:671`.
- `native/src/dieline_license.rs:17` vẫn `15 * 60`; predicate `:392–397` từ chối `exp-iat > 900`.
- Chạy đúng biểu thức TTL trích từ source với thời gian tổng hợp: lease 900 → không bị chặn; lease 259200 → bị chặn. Chưa gọi native trên token ký thật/CNG thật. Test native `:654–663` còn assert 901 giây phải bị từ chối, tức test đang giữ chính sách cũ.
- Consumer thật: backend `api/routes/dieline.py:215–244` → native `dieline_engine.rs:203–213` → `authorize_dieline` → validator. `/engine-status` `dieline.py:191–211` chỉ nhìn payload/claim `rk`, không kiểm toàn bộ authorize nên trạng thái sẵn sàng chưa đủ.

**Tác động:** token 72 giờ dù còn hạn vẫn lỗi khi tạo khuôn, nếu vượt qua kiểm CNG trước đó. Chờ đến gần hết hạn không giúp vì `exp-iat` không đổi. Đây **không phải** nguyên nhân đóng app trước auth, cũng không rollback login theo call graph hiện tại.

**Đề xuất:** đồng bộ policy có version/compatibility ở mọi verifier, test 15 phút và 72 giờ, kiểm artifact native đã đóng gói. Không cập nhật snapshot hình học hoặc bỏ signature/entitlement.

### §SEC.LIC20.05 — Nhập lại cùng key là đường không làm gì

- `useAuthStore.ts:1557–1562` xử lý `RECOVERY_REQUIRED` bằng xóa token, giữ key và hướng dẫn “nhập lại license key”.
- `:1634–1637` trả `reason='same'` trước mọi challenge nếu nhập key đó.
- `ChangeLicenseKeyPanel.tsx:65–69` gọi `onSuccess`/đóng form khi gặp `same`; overlay quay về trạng thái khóa cũ.
- Probe trích chính method từ AST, mock scheduler/state và dùng key tổng hợp: `ok=false`, `reason=same`, **0 protocol calls**. Không thao tác key thật.

**Đề xuất:** hướng dẫn dùng đúng nút “Thử lại”, hoặc cho cùng-key đang khóa đi qua recovery đã được kiểm soát. Không báo thành công/đóng form như đã xác minh khi chưa làm gì. Thêm test component thật cho chuỗi này.

### §SEC.LIC20.06 — Hai nguồn deploy Edge không tương thích

- PrynX mirror: `supabase/functions/license-verify/index.ts:679–686` nhận field `offline_lease_seconds`.
- PrintSolutions: cùng handler ở `:646–655` chỉ cho field optional `app_version`. Script `D:/printsolutions-main/deploy_license_token.ps1:195` deploy từ checkout web.
- Client mới luôn gửi capability đó. Trích predicate `hasExactRequestKeys` và required/optional từ AST của **hai handler thật**, chạy với field tổng hợp:

| Source | Request V3 trước capability | Request desktop hiện tại |
|---|---|---|
| PrintSolutions HEAD `93fd615` | Nhận ở bước kiểm field | Từ chối ở bước kiểm field |
| PrynX mirror HEAD `641fdc4` | Nhận ở bước kiểm field | Nhận ở bước kiểm field |

Đây là hazard tái triển khai từ nguồn web, **không chứng minh production hiện chạy source cũ**. Hai hash file PrynX mirror khớp nhật ký deploy v22 ở `docs/LICENSE_TTL72H_FIXES_2026-09-09.md`; báo cáo migration ngày 08/09 về v20 đã bị supersede. Không gọi production trong lượt này để tái xác nhận bundle live.

**Đề xuất:** chốt một nguồn authority cho Edge/shared, đồng bộ và chạy contract compatibility trước deploy; kiểm bundle hash đã triển khai. Không tự deploy cả project hoặc đẩy migration để thử.

## 5. Nghi vấn ưu tiên — chưa quy là nguyên nhân trên máy người dùng

### §SEC.LIC20.S1 — Registration V3 vẫn bắt HWID legacy

**TRACED, Needs validation; không xếp severity mới khi chưa có negative test/native log đúng lượt.**

`security.rs:1046` gọi `get_hardware_id()?` vô điều kiện trước verify token V3. HWID resolver có thể fail do WMI, hồ sơ DPAPI cũ không giải mã được hoặc migration/ghi đĩa (`:718–736`). Trong khi V3 verifier `:1439–1481` dùng CNG `d/m/cnf`, không dùng HWID legacy để so machine claim.

Nếu lỗi đó xảy ra, server có thể đã ghi slot rồi client mới từ chối (`useAuthStore.ts:1734`). Đây là ứng viên giải thích “1/1 nhưng không áp dụng key”, **chưa phải kết luận về máy này**. Phản chứng: log debug lúc sau có `collect OK` và `DISK_V2_VERIFIED`; không chứng minh HWID hiện hỏng liên tục. Test JS không gọi `get_hardware_id` chỉ kiểm IPC bên ngoài, không thấy call bên trong Rust.

Bước tiếp theo: test V3 đăng ký với lỗi HWID legacy được inject nhưng CNG/token hợp lệ; thu native error phase/code đã che dữ liệu ở bản cài. Nếu chứng minh được, chỉ loại phụ thuộc legacy khỏi nhánh V3, giữ validation đó cho V1/V2. Không xóa hồ sơ HWID hoặc tạo device mới để “thử”, vì có thể mất quyền nhận lại slot.

### §SEC.LIC20.S2 — CNG fallback không đồng nhất ở native Dieline

**TRACED contract gap; cần runtime trên profile TPM/software riêng.**

Tauri `device_identity.rs:495–515` có Software KSP non-exportable fallback. Native Dieline `dieline_license.rs:240–274` chỉ mở Platform KSP, bắt hardware-backed; `:493–495` gọi resolver đó với mọi token V3. Máy dùng software key có thể nhận license nhưng không tạo khuôn. Lỗi TTL §04 có thể che lỗi provider này trên token 72 giờ.

Đề xuất test ma trận 15 phút/72 giờ × TPM/software; thống nhất resolver/policy nhưng giữ kiểm không export được private key và proof-of-possession. Chưa thay registry/CNG key thật, không tạo/xóa khóa trên máy đang dùng.

## 6. Hành vi có chủ đích và các kết luận không nên rút ra

- Xóa key/đăng xuất local không đồng nghĩa nhả slot server: `useAuthStore.ts:1112–1179`. Đổi key chỉ nhả slot cũ sau khi key mới đã commit (`:1782–1814`), best-effort. Legacy release cần token cũ hợp lệ; thiếu/hết hạn cần hỗ trợ có thẩm quyền, không được bỏ kiểm chữ ký.
- Legacy bearer token/HWID không đủ authority để tự gắn một CNG key mới vào slot cũ: migration V3 `:254–258` cố ý chặn. Có cầu V2 tạm thời trong **startup/retry**, không có bảo đảm tự nâng cấp V3 vô hạn. Câu “còn token V2 là nâng cấp êm” trong tài liệu 08/09 cần đọc cùng giới hạn này.
- Không reset key mới chỉ vì thấy 1/1. Retry cùng CNG device active không chiếm thêm slot; cần biết 1/1 là legacy, cùng CNG hay CNG khác trước khi xử lý quản trị.
- Không tìm được bypass mới đủ bằng chứng trong phạm vi lần này. Ed25519, product/key/device binding, challenge receipt, anchor và gate native/backend vẫn là control phải giữ. Không suy từ điều đó rằng toàn hệ thống an toàn hoặc không thể crack.
- Anti-debug đang log-only, không phải lời giải thích có bằng chứng cho lần app tự thoát. Không có lý do xóa token/clock anchor để sửa lỗi compile-time hash.
- Helper SHA-256 mới đã được so với Node crypto trên **260 chuỗi ASCII tổng hợp**, không có mismatch. Không quy lỗi crypto chỉ vì implementation dài; bộ probe này không phải chứng nhận crypto hay proof cho dữ liệu Unicode.

## 7. Kiểm thử đã chạy và khoảng trống

| Kiểm tra | Kết quả | Giới hạn |
|---|---|---|
| Vitest `useAuthStore.dielineKeyStatus.test.ts`, `licenseProtocolV3.test.ts`, `licenseToken.test.ts` | **104 passed**, 3 file, Vitest 4.1.6 | Tauri/Supabase được mock. |
| `backend/venv/Scripts/python.exe -B -m pytest -q -p no:cacheprovider tests/test_license_token.py` | **99 passed**, 28,72 giây, 2 cảnh báo deprecation | Test key tổng hợp, DB/clock tạm, Supabase mock; không chứng minh Rust native. |
| Hash helper mới vs Node SHA-256 | 260/260 ASCII khớp | Chỉ helper/predicate. |
| Same-key recovery method trích AST | `same`, 0 protocol call | Mock scheduler/state; chưa chạy component UI. |
| Predicate TTL native trích source | 900 nhận; 259200 từ chối | Chưa chạy Ed25519/CNG/native end-to-end. |
| Exact-field parser hai Edge source | Web source từ chối capability; mirror nhận | Không gọi RPC/deploy/live. |
| Log, compiler dep-info, NSIS recipe, SHA-256 artifact | Các kết quả mục 4 | Không cài lại hoặc tạo installer mới. |

Test đổi key thành công `useAuthStore.dielineKeyStatus.test.ts:1124–1182` dùng token fixture có hash key mặc định cũ với key mới tổng hợp, trong khi mock native chấp nhận. Vì vậy test xanh **không chứng minh cặp key/token thực được Rust chấp nhận**. Commit `5532fbd` chỉ đổi một dòng fixture, không thêm test cho các nhánh mismatch/`RECOVERY_REQUIRED`. Không có test riêng `ChangeLicenseKeyPanel` trong phạm vi tìm được.

Chưa chạy: typecheck/full-suite mới, cargo/native tests mới, cài trên profile sạch, tương tác lại key thật, production DB/Edge logs và đối chiếu bundle live. Không update snapshot, không rebuild native/sidecar/release. Không gọi kết quả này là `RUNTIME` nghiệm thu đầy đủ.

## 8. Đề xuất thứ tự xử lý — chờ duyệt

1. **A — Chặn artifact hỏng (§01–03):** bổ sung gate cấu hình packaging/overlay/inventory và kiểm manifest theo đúng installer; tối đa 5 file cho lô source/test. Sau khi chốt source mới mới xin chạy build đầy đủ. Không sửa tay hash, không nới integrity. Installer hiện tại giữ lại để đối chứng, chưa xóa.
2. **B — Xác định lỗi nhập key (§S1, §05):** thêm test native fault-injection/phase code an toàn, test same-key recovery và token fixture đúng key; sửa dependency HWID V3 nếu test chứng minh. Không reset seat thật; mỗi lô tối đa 5 file và verify xong mới tiếp.
3. **C — Đồng bộ native license (§04, §S2):** sửa policy 72 giờ cùng resolver CNG sau negative tests; giữ hỗ trợ token 15 phút; verify bản native được đóng gói, không chỉ Python/TS.
4. **D — Nguồn deploy và vận hành (§06):** thống nhất Edge/shared ở hai repo; kiểm tương thích cũ/mới và bundle live bằng quyền chỉ đọc. Việc deploy/reconcile migration/nhả slot phải được duyệt riêng.
5. **Nghiệm thu cuối:** Windows user/VM sạch; fresh key test + legacy seat test + cùng-key retry + đổi key rollback + offline 15 phút/72 giờ + tạo khuôn thật + đóng/mở lại. Đối chiếu installer/EXE/sidecar/native identity với manifest trước khi ghi runtime verified.

Theo `prynx-audit-workflow` và `prynx-security-review`, dừng ở báo cáo/phương án này, **chưa áp dụng bản vá hoặc build lại trước khi chủ dự án duyệt**.

## 9. Audit unit / matrix

`W8-U05`: Cài/nâng cấp PrynX 2.0 → mở app → nhận/đổi key → server activation → native registration → token bền vững → gọi engine có gate.

- Entry/handler/engine/writer/consumer: các chuỗi mục 3; writer server là SQL activation, writer client là DPAPI/anchor/cache; artifact là installer/manifest/credential, consumer là native signer/backend/Dieline.
- Hợp đồng: commit/hash/config; key SHA256[:16]; V2 HWID vs V3 CNG; `d/m/cnf/cid`; seat idempotency; TTL; proof/clock; rollback client không phải rollback server.
- Đã kiểm biên: same-key, khác token hash, TTL 900/259200, capability vắng/có, release config vắng/có, manifest stale. Legacy/new CNG và HWID lỗi chỉ trace, chưa thao tác tài khoản/device thật.
- Mức: **TRACED + AUTO-PARTIAL + ARTIFACT-PARTIAL · HOLD**; log lịch sử xác nhận lần release bị từ chối nhưng chưa phải nghiệm thu runtime hiện hành.
- Ngày/revision: 2026-09-09, hai HEAD ở mục 2. Bước tiếp: chủ dự án duyệt lô A/B và quyền smoke trong môi trường sạch; giữ nguyên key/token/seat đang có.
