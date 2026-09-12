# Báo cáo audit luồng license/recovery runtime — 2026-09-12

## 1. Phạm vi và mức bằng chứng

- **Audit unit:** cài/nâng cấp PrynX → nhập key mới → Edge V3 challenge/proof → activation → native commit → credential/engine gate.
- **Mode:** deep audit + security/release review; giai đoạn khảo sát chỉ đọc. Sau khi chủ dự án yêu cầu xử lý, đã áp một lô diagnostics tối thiểu vào desktop; không reset key/seat, không đọc secret, không deploy và không build release.
- **Thời điểm:** 2026-09-12, Asia/Bangkok.
- **PrynX:** HEAD `40e8265e611c798962a786e8ff22e93ec350a351`.
- **PrintSolutions:** HEAD `93fd6155f5a57d3c4ccc995cd5cce57112850411`, working tree có thay đổi license/Edge/migration chưa commit.
- **Threat model:** `docs/audit/PRYNX_THREAT_MODEL.md` snapshot 2026-09-04.
- **Công cụ/bằng chứng:** đọc source + line trace, `rg`, git metadata, SHA-256 artifact, metadata/log Windows, kiểm DPAPI an toàn không in plaintext, kiểm public-key literal giữa client/backend. Supabase CLI production read-only đã thử nhưng transport/profile không hoàn tất; không có mutation.
- **Lô đã áp dụng:** `desktop/src/stores/useAuthStore.ts` — phân loại và ghi mã phase an toàn qua `log_frontend_error`; không thay đổi quyết định fail-closed hay protocol.

## 2. Kết luận điều hành

Ảnh lỗi không phải câu trả lời “key sai”. Với source hiện tại, thông báo được tạo sau khi frontend đã nhận và parse token V3, tại `desktop/src/stores/useAuthStore.ts:1916–1924`, khi IPC `commit_license_renewal` thất bại.

Web admin hiện `1/1` là phù hợp với thứ tự code: server finalize activation trước, sau đó mới ký/trả token; desktop mới verify và ghi DPAPI/cache. Khi desktop thất bại, server không có compensating release. Đây là lỗi **tính nguyên tử và khả năng chẩn đoán của giao dịch**, không phải bằng chứng reset server sai.

Trên profile Windows đã kiểm tra, HWID và DPAPI không hỏng; nhưng EXE đang chạy không khớp hash build ghi trong manifest và manifest tự ghi `GIT_DIRTY=yes`, `EXE_SHA256=NOT_VERIFIED_INSTALL_PAYLOAD`, `RUNTIME_VERIFIED=no`. Đây là finding artifact đã xác nhận, giải thích được hiện tượng máy bị/máy không bị nếu artifact/profile khác nhau, nhưng chưa tự chứng minh sub-cause token/native cụ thể.

## 3. Trace dọc có bằng chứng

1. **Entry UI:** `desktop/src/components/auth/LoginScreen.tsx:36` gọi `changeLicenseKey`.
2. **Coordinator:** `desktop/src/stores/useAuthStore.ts:1857–1894` bắt đầu renewal, chạy V3 `action: 'recover'`.
3. **Edge:** `supabase/functions/license-verify/index.ts:792–945` xử lý prove; gọi `finalize_prynx_device_challenge_v3` ở `:917`.
4. **DB writer:** `D:/printsolutions-main/supabase/migrations/20260904120000_prynx_device_authority_v3.sql:573–645` re-activate/insert activation, đặt `protocol_floor=3`, `device_trust='cng-key-proof'`, rồi trả `VALID`.
5. **Token writer:** Edge ký token sau finalize tại `supabase/functions/license-verify/index.ts:306–378,643–678`; private key production đến từ secret `LICENSE_SIGNING_KEY` (`:319`).
6. **Native commit:** frontend gọi `commit_license_renewal` tại `useAuthStore.ts:1916`; Tauri nối sang `license_renewal.rs:338–368` rồi `security.rs:4262–4311`.
7. **Native checks:** `register_validated_key_inner` kiểm token Ed25519, device/receipt/clock anchor và ghi cặp credential; trust anchor public key nằm ở `security.rs:1433–1456`.
8. **Error sink:** frontend catch ở `useAuthStore.ts:1922` bỏ toàn bộ lỗi native và chỉ hiện một câu chung. Không có release activation server trong nhánh này.

## 4. Findings

### §SEC.LICRT.01 — P1/M — Activation server không có compensating release khi native commit fail

- **Lifecycle:** Discovered → Triaged → **Confirmed, lô 1 đã áp dụng diagnostics; root cause chưa đóng**.
- **Bằng chứng:** finalize DB xảy ra ở bước 4 trước token/native ở bước 5–7; UI catch xảy ra ở `useAuthStore.ts:1922`; admin quan sát `1/1`.
- **Tác động:** seat có thể mồ côi; reset/unblock lặp lại không sửa lỗi cục bộ và làm nhiễu trạng thái recovery.
- **Root cause:** giao dịch server activation và client credential không cùng transaction; thiết kế hiện chỉ rollback client credential.
- **Proof:** `[VERIFIED-SOURCE]` + `[VERIFIED-OBSERVATION]` `1/1`; chưa cần secret production để chứng minh thứ tự.
- **Remediation đề xuất:** thiết kế trạng thái pending/receipt hoặc release bù có ràng buộc device/challenge; không xóa activation trực tiếp bằng SQL. Chờ duyệt trước khi sửa/deploy.

### §SEC.LICRT.02 — P1/M — Artifact đang chạy không khớp provenance manifest trên profile lỗi

- **Lifecycle:** Discovered → Triaged → **Confirmed cho profile này, lô 1 diagnostics đã áp dụng; root cause chưa đóng**.
- **Bằng chứng:** `Ban_Phat_Hanh/release-manifest.txt:3–4,22–23,35` ghi build EXE `0f4969…`, dirty source và `RUNTIME_VERIFIED=no`; EXE đang chạy `C:/Users/Khanh Pham/AppData/Local/PrynX/pdf-inspector.exe` có SHA-256 `e7783788…`.
- **Tác động:** không thể kết luận máy đang chạy đúng frontend/native/manifest pair; khác artifact là lời giải thích có bằng chứng cho “máy bị/máy không bị”.
- **Giới hạn:** hash khác không tự chứng minh token signature sai; cần exact inventory của payload installer và good/bad machine.
- **Remediation đề xuất:** chặn phát hành khi EXE payload chưa được hash đối chiếu; clean-build/install/smoke profile sạch rồi mới ghi `RUNTIME_VERIFIED=yes`.

### §SEC.LICRT.03 — P1/S — Mất nguyên nhân native tại UI và log release

- **Lifecycle:** Discovered → Triaged → **Confirmed, lô 1 đã áp dụng diagnostics; root cause chưa đóng**.
- **Bằng chứng:** catch rỗng tại `useAuthStore.ts:1922`; native có nhiều lỗi phân biệt ở `license_renewal.rs:237–264` và `security.rs:4262–4311` nhưng không được trả nguyên nhân an toàn cho support. `PrynX.log` profile lỗi chỉ có HWID/startup; `security.log` chỉ có các lần token cũ `License token expired`, không có phase commit.
- **Tác động:** không phân biệt được DPAPI/CAS, token signature, receipt/CNG, anchor hay renewal owner; support phải reset server mù.
- **Remediation đề xuất:** ghi enum phase/error code đã whitelist, không ghi key/token; UI hiển thị mã hỗ trợ ổn định. Đây là lô desktop/native riêng, chờ duyệt.

### §SEC.LICRT.04 — P1/M — Parity secret ký production chưa chứng minh

- **Lifecycle:** Discovered → Triaged → **Needs validation [EXTERNAL]**.
- **Đã kiểm:** public key literal trong desktop và backend source khớp; Edge source dùng secret ngoài `LICENSE_SIGNING_KEY`.
- **Chưa kiểm:** public key suy ra từ secret production và bundle Edge đang live. Supabase CLI read-only thử ngày 2026-09-12 gặp `TransportError`/profile telemetry; không đọc secret, không deploy.
- **Exploit/故障 hypothesis:** secret production bị rotate hoặc lệch trust anchor → Edge vẫn finalize/`VALID`, native từ chối chữ ký mọi token mới; đúng mẫu `1/1 + generic commit error`.
- **Bước xác minh:** derive public key trong môi trường quản trị, chỉ so fingerprint với anchor `security.rs:1433`; không đưa private key vào log/chat.

### §SEC.LICRT.05 — P2/M — Migration/Edge live provenance và history drift

- **Lifecycle:** Discovered → Triaged → **Needs validation [EXTERNAL]**.
- **Bằng chứng local:** PrintSolutions working tree có Edge/shared/migration quota modified/untracked; tài liệu 2026-09-08 ghi migration history drift và Edge live version/source chưa đối chiếu bundle.
- **Giới hạn:** vì ảnh đi tới `commit_license_renewal`, không dùng finding này làm nguyên nhân trực tiếp nếu chưa có status/phase live.
- **Remediation:** reconcile migration history, chốt một Edge authority, kiểm bundle hash read-only trước deploy; không `db push`/deploy thử trên production.

### Hypothesis đã bác bỏ trên profile được kiểm

- **DPAPI file hỏng/không giải mã được:** bác bỏ; credential/token/clock files tồn tại, DPAPI pair và anchor đọc được, anchor không ở tương lai. Không in plaintext.
- **HWID legacy collect hỏng:** bác bỏ cho lượt hiện tại; `PrynX.log` ghi `collect OK`, `DISK_V2_VERIFIED`.
- **Key cụ thể sai hoặc reset chưa đủ:** không phù hợp với việc key mới cũng đi cùng lỗi commit và server ghi `1/1`; vẫn không suy thành production-wide proof.

## 5. Coverage / proof gap

- **Đã phủ:** Login/change-key → Edge V3 → SQL finalize → token signing source → Tauri coordinator → native token/receipt/DPAPI path → manifest/log/profile evidence.
- **Chưa phủ:** remote Edge bundle/version hiện tại; secret signing production; activation row/challenge row cụ thể của khách; clean installer extraction/install trên VM; good-vs-bad EXE pair; native error code từ đúng lượt runtime.
- **Không thực hiện:** build, test destructive, reset/release seat, `db push`, deploy Edge, đọc secret/key/token, commit/push.
- **Mức bằng chứng:** source `TRACED`; profile artifact `ARTIFACT-PARTIAL`; runtime license end-to-end `HOLD`, chưa `RUNTIME`.

## 6. Thứ tự xử lý tiếp theo — chưa áp dụng

1. **Ops read-only:** đối chiếu SHA-256 EXE trên một máy tốt và máy lỗi; đối chiếu public-key fingerprint từ secret production với anchor nhúng.
2. **Lô B (server contract):** thiết kế compensating release/pending activation có challenge/device binding; không xóa row thủ công.
3. **Lô C (release):** gate exact installer payload ↔ EXE ↔ native identity ↔ manifest, clean-install smoke và chỉ nâng `RUNTIME_VERIFIED` khi đạt.

## 7. Verify lô diagnostics

- `cd desktop && npm run typecheck`: đạt.
- `npx vitest run src/stores/useAuthStore.dielineKeyStatus.test.ts src/lib/licenseProtocolV3.test.ts src/stores/licenseToken.test.ts`: **3 file / 124 test đạt**.
- `git diff --check`: đạt.
- Không build/cài release và chưa chạy lại thao tác license thật; mã phase mới chỉ được xác nhận bằng typecheck/test, chưa có log runtime sau bản build mới.

**Audit verdict:** `TRACED + ARTIFACT-PARTIAL · LÔ 1 APPLIED · ROOT CAUSE HOLD`. Findings còn lại (artifact provenance, signing-secret parity, activation compensation) chưa được tự động đóng.

## 8. Build 2.0.1 và chốt runtime

- Pipeline `build_production.ps1 -NoOpenExplorer` đã chạy đúng rule release, không deploy/đổi secret.
- Installer: `Ban_Phat_Hanh/PrynX_2.0.1_x64-setup.exe`, SHA-256 `6983f3cc7ff74b6f8713f3ce148aa8ae1fd9e5f217f2f23d2634bea67b2fec08`.
- Native/sidecar/frontend hash đã được ghi vào manifest; full QA đã đạt trước bước Tauri/NSIS.
- Verifier cài tạm chưa chạy được vì máy đang có process PrynX tồn tại; verifier dừng đúng thiết kế và không kill process có sẵn. Manifest giữ `EXE_SHA256=NOT_VERIFIED_INSTALL_PAYLOAD`, `RUNTIME_VERIFIED=no`.
- Vì vậy installer **chưa được gọi là runtime-verified/public-ready**; cần đóng toàn bộ PrynX đang chạy rồi chạy lại `scripts/verify_installed_artifact.ps1`.
