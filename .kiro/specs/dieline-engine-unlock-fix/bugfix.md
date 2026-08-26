# Bugfix Requirements Document

## Introduction

Công cụ **khuôn bế bao bì** (`packaging.dieline`) chết hoàn toàn trên bản phát hành đã cài `1.0.0-rc.9` (sidecar báo `1.0.0.900`). Người dùng bấm tạo khuôn, UI hiện toast đỏ kèm nút "Thử lại"; sửa số đo hay bấm lại đều không bao giờ hết lỗi.

Nguyên nhân đã đo được, không phải suy đoán:

- `%APPDATA%\PrynX\logs\app.log` ngày 2026-08-26 11:31–11:32 ghi sáu lần liên tiếp `RuntimeError: Dieline engine is locked: a valid license token is required` từ `app.api.routes.dieline`.
- Chuỗi đó phát ra ở `native/src/dieline_engine.rs::engine_source()`. Bản phát hành nhúng engine khuôn bế đã mã hoá AES-256-GCM (header `PRYNXENC1`, AAD = app version); khoá mở nằm ở claim `rk` trong token license đã ký. `resource_key == None` ⇒ ném đúng câu trên.
- Token tại `%APPDATA%\PrynX\prynx_token.dat` (DPAPI CurrentUser; chỉ đọc **tên** claim, không in giá trị) có `exp, k, m, p, plan` — **không có `rk`**. `plan = pro`, `features` rỗng, `exp` 2026-08-29 06:56 UTC, còn hạn. Token hợp lệ và đủ quyền; `resourceKeyAllowed('pro', null)` trả true nên cổng entitlement **không** phải thứ chặn. Khoá bị `license-verify` giữ lại phía server.
- Engine hình học đã được loại trừ: fuzz engine TS (đúng mã bundle vào Boa) 48.000 mẫu preview + 8.400 mẫu có nesting, đủ 12 boxType, quét toàn miền tham số theo min–max của ParamPanel, cộng khổ giấy / lề / dieGap / gutter / rotation / grid-smart / combined-split ⇒ 0 lần ném lỗi. Ba tầng allow-list (`runtimeValidation.ts`, `dieline_validation.py`, `dieline_request.rs`) đồng bộ, test mirror `backend/tests/test_dieline_validation_mirror.py` xanh.

Vì sao server không cấp `rk` — hai nhánh, cùng ra một kết quả, **chưa phân biệt được từ máy local** (proof gap: cần `security_logs` ngày 26/08 trên Supabase production):

- **Nhánh A — chạm trần chống thu gom khoá.** `d:\printsolutions-main\supabase\functions\license-verify\index.ts`: `RK_VERSION_CAP = 5` phiên bản khác nhau / `RK_WINDOW_DAYS = 30` cho mỗi license. Lịch sử `desktop/src-tauri/tauri.conf.json` 30 ngày qua có **7** phiên bản (rc.4 → rc.9). Cổng thiết kế cho "người dùng chạy một bản, thi thoảng update" đang bắn vào chính nhịp phát hành của dự án. `claim_rk_grant` trả false ⇒ `resourceKey` giữ null ⇒ token ký không có `rk`.
- **Nhánh B — RPC `claim_rk_grant` không tồn tại trong production.** Migration `20260726140000_prynx_rk_grant_cap.sql` được `docs/BAO_CAO_AUDIT_BAO_MAT_2026-07-30.md` ghi nhận là untracked từ 30/07; tìm lại hôm nay không có file nào trong `d:\printsolutions-main\supabase\migrations` chứa `rk_grant` hoặc `release_resource_keys`, và `security-manifest.json` không liệt kê chúng nên không test nào phát hiện việc thiếu. RPC thiếu ⇒ `rkClaimErr` ⇒ rơi về `lookupResourceKey(..., legacyFallbackOnly = true)`; hàng do `build_production.ps1` tạo không set `legacy_fallback` ⇒ trả null ⇒ fail-closed riêng `rk`.

**Đã vá trong phiên trước, nêu ở đây làm bối cảnh, KHÔNG lập lại thành việc cần làm:** `backend/app/api/routes/dieline.py` trước đây gộp mọi `RuntimeError` từ `pdfcompare_native` thành 422 "Không thể tạo khuôn với thông số này.", nên lỗi bản quyền hiện ra như lỗi số đo. Đã thêm `_classify_native_failure()` (403 cho engine chưa mở khoá/entitlement, 500 cho payload engine hỏng, 413 cho vượt giới hạn dữ liệu, 422 chỉ cho lỗi thông số thật), kèm `backend/tests/test_dieline_error_classification.py` gồm hai test chống lệch tự trích chuỗi lỗi literal từ `native/src/dieline_license.rs` (19 chuỗi) và `native/src/dieline_engine.rs` (6 chuỗi). 3373 test backend pass. Sau bản vá, thông báo đã đúng bản chất — nhưng công cụ khuôn bế **vẫn không dùng được**, vì khoá engine vẫn không được cấp.

Phạm vi spec này là phần còn lại, chia ba nhóm: (1) mở khoá cho máy đang kẹt và chẩn đoán được nhánh A hay B trước khi ra tay; (2) sửa gốc phía server để không tái diễn; (3) chặn ở cổng phát hành để không ship bản không ai mở được. File thuộc hai repo: `d:\pdfcompare` (app, Rust native, `build_production.ps1`, backend, desktop) và `d:\printsolutions-main` (Edge Function `license-verify`, `supabase/migrations`, `security-manifest.json`, `src/securityAuditRound2.test.ts`). Mọi thao tác chạm Supabase production (RPC, `release_resource_keys`, `security_logs`, deploy Edge Function) là **hành động rủi ro cao**, phải có chốt xác nhận của người vận hành và không được tự động chạy.

## Bug Analysis

### Current Behavior (Defect)

Hành vi hiện tại, tính cả bản vá phân loại lỗi backend đã áp.

1.1 WHEN người dùng tạo khuôn bế trên bản phát hành đã khoá engine (payload `PRYNXENC1`) mà token license không có claim `rk` THEN `engine_source()` ném `Dieline engine is locked: a valid license token is required`, backend trả 403 và công cụ khuôn bế không dùng được ở bất kỳ bộ thông số nào — sửa số đo hay bấm "Thử lại" không đổi kết quả.

1.2 WHEN người vận hành cần biết vì sao `rk` bị giữ lại THEN hệ thống không cho phép chẩn đoán từ máy người dùng: phản hồi `license-verify` không mang thông tin nào về việc `rk` bị từ chối, và phân biệt `rk_cap_exceeded` (nhánh A) với `rk_claim_failed_closed` / `rk_legacy_fallback` (nhánh B) chỉ làm được bằng cách đọc trực tiếp `security_logs` trên Supabase production.

1.3 WHEN một license xin khoá cho nhiều hơn `RK_VERSION_CAP = 5` phiên bản khác nhau trong `RK_WINDOW_DAYS = 30` ngày THEN `claim_rk_grant` trả false, `license-verify` không tra `release_resource_keys` và ký token không có `rk` — trong khi nhịp phát hành của chính dự án đã tạo 7 phiên bản trong cùng cửa sổ, nên người dùng cập nhật bình thường bị khoá oan.

1.4 WHEN `license-verify` từ chối `rk` (vượt trần hoặc fail-closed) THEN phản hồi vẫn là `status: VALID` kèm token ký bình thường, không có trường nào cho client hoặc ops biết khoá engine bị giữ lại, nên sự cố chỉ lộ ra ở tầng Rust sau khi người dùng đã bấm tạo khuôn.

1.5 WHEN RPC `claim_rk_grant` không tồn tại hoặc lỗi trên Supabase production THEN `license-verify` đi nhánh `rkClaimErr` → `lookupResourceKey(..., legacyFallbackOnly = true)`; hàng khoá do `build_production.ps1` tạo không set `legacy_fallback` nên trả null, và mọi bản phát hành mới mất `rk` một cách im lặng.

1.6 WHEN kiểm tra repo `d:\printsolutions-main` THEN không có migration nào định nghĩa `claim_rk_grant`, `release_resource_keys` hay cột `legacy_fallback`; `supabase/migrations/security-manifest.json` không liệt kê chúng trong `required_migrations` lẫn `deployment_guards['license-verify']`, nên test "clean checkout phải có đủ migration bảo mật trước khi deploy Edge" vẫn xanh dù chốt chặn phát hành này đã treo từ 30/07.

1.7 WHEN `build_production.ps1` đóng gói một bản phát hành THEN script chỉ fail-fast ở bước **đẩy** khoá lên `release_resource_keys`, không kiểm bước **cấp** khoá, nên một bản đã khoá vẫn ship được trong khi server đang từ chối trả `rk` — đúng những gì xảy ra với rc.9.

1.8 WHEN bản đã cài khởi động hoặc xác thực license với token thiếu `rk` THEN không có kiểm tra sớm nào phát hiện trạng thái đó: `warm_dieline_engine` cố ý no-op ở bản đã khoá, nên trạng thái "engine bị khoá" chỉ được phát hiện bởi chính người dùng lúc bấm tạo khuôn.

### Expected Behavior (Correct)

2.1 WHEN người dùng tạo khuôn bế trên bản phát hành đã khoá engine và license hợp lệ, còn hạn, đủ quyền `packaging.dieline` THEN hệ thống SHALL cấp token có claim `rk` khớp `app_version` đang chạy, engine SHALL giải mã được và khuôn bế SHALL được tạo bình thường.

2.2 WHEN người vận hành cần xác định nhánh A hay nhánh B gây thiếu `rk` THEN hệ thống SHALL cung cấp quy trình chẩn đoán phân biệt được hai nhánh bằng bằng chứng đo được (event_type trong `security_logs`, sự tồn tại của RPC, trạng thái hàng khoá của đúng `app_version`), và mọi bước chạm Supabase production SHALL được đánh dấu rủi ro cao kèm chốt xác nhận của người vận hành trước khi chạy — không tự động thực thi.

2.3 WHEN một license xin khoá cho nhiều phiên bản khác nhau theo nhịp cập nhật bình thường, kể cả trên 5 bản trong 30 ngày, trên cùng một máy THEN cổng chống thu gom khoá SHALL cấp `rk` bình thường; đồng thời cổng SHALL vẫn từ chối khi cùng một license đòi khoá cho nhiều phiên bản khác nhau trên nhiều `machine_id` trong cửa sổ ngắn (dấu hiệu thu gom khoá), và thiết kế SHALL biện luận tường minh đánh đổi giữa hai mục tiêu này.

2.4 WHEN `license-verify` buộc phải từ chối `rk` THEN phản hồi SHALL mang trạng thái tường minh dạng enum lý do (không chứa giá trị khoá, không chứa license key thô) để client báo đúng bản chất và ops truy vết được, và hệ thống SHALL ghi `security_logs` với event_type phân biệt được nguyên nhân.

2.5 WHEN RPC `claim_rk_grant` lỗi hoặc không tồn tại THEN hệ thống SHALL coi đây là sự cố hạ tầng và báo tường minh (log server-side + trạng thái trong phản hồi) chứ không âm thầm cấp token thiếu `rk`, và SHALL giữ nguyên fail-closed riêng khoá tài nguyên — không được đổi sang fail-open.

2.6 WHEN kiểm tra repo `d:\printsolutions-main` THEN migration định nghĩa `claim_rk_grant` (cùng `release_resource_keys` và cột `legacy_fallback` nếu chúng cũng thiếu) SHALL tồn tại trong `supabase/migrations/`, SHALL được liệt kê trong `security-manifest.json` ở cả `required_migrations` và `deployment_guards['license-verify'].remote_migration_version`, và SHALL có cách xác minh RPC thật sự tồn tại trong production trước khi deploy `license-verify`.

2.7 WHEN `build_production.ps1` đóng gói bản phát hành đã khoá engine THEN release gate SHALL probe kích hoạt thật: gọi `license-verify` bằng license test, đọc token trả về, khẳng định có claim `rk` và khoá đó mở được đúng payload engine của bản đang build; probe SHALL fail-fast khi thiếu `rk` hoặc khoá không khớp, và SHALL không in giá trị token / license key / khoá ra terminal, log hay manifest.

2.8 WHEN bản đã cài xác thực license hoặc warmup engine trên một bản đã khoá mà token không có `rk` THEN hệ thống SHALL phát hiện ngay tại thời điểm đó và SHALL báo đúng bản chất kèm hướng xử lý (làm mới bản quyền, liên hệ hỗ trợ với phiên bản đang dùng), thay vì để người dùng phát hiện bằng cách bấm tạo khuôn.

### Unchanged Behavior (Regression Prevention)

3.1 WHEN token license hợp lệ và có `rk` đúng bản THEN hệ thống SHALL CONTINUE TO giải mã engine bằng AES-256-GCM với AAD = app version và tạo khuôn bế như hiện tại.

3.2 WHEN binary được build không có khoá (dev/CI, payload `PRYNXRAW1`) THEN hệ thống SHALL CONTINUE TO nạp engine plaintext và chạy không cần `rk`; test `payload_kind_matches_build_env` và `locked_build_unlocks_only_with_issued_key` trong `native/src/dieline_engine.rs` SHALL CONTINUE TO xanh.

3.3 WHEN license plan `free` hoặc không có feature `packaging.dieline` THEN hệ thống SHALL CONTINUE TO từ chối công cụ khuôn bế qua `require_feature` và SHALL CONTINUE TO không cấp `rk`.

3.4 WHEN đọc claim `rk` THEN hệ thống SHALL CONTINUE TO chỉ đọc sau khi đã verify đủ chữ ký Ed25519, `exp`, `m` (hwid), `k`, `p` và plan/features, và `rk` SHALL CONTINUE TO chỉ tồn tại trong payload đã ký để client không thể tự thêm hoặc đổi khoá.

3.5 WHEN bất kỳ code, test, log, manifest hay tài liệu nào chạm tới token, license key hoặc khoá `rk` THEN hệ thống SHALL CONTINUE TO không ghi giá trị ra log, đĩa, binary, argv hay báo cáo — chỉ được ghi tên claim, độ dài hoặc trạng thái có/không.

3.6 WHEN client không gửi `app_version`, hoặc tra `release_resource_keys` lỗi THEN hệ thống SHALL CONTINUE TO cấp token license bình thường và không chặn kích hoạt, để bản cũ nhúng engine plaintext vẫn dùng được.

3.7 WHEN khoá cho một `app_version` đã tồn tại THEN `build_production.ps1` SHALL CONTINUE TO dùng lại khoá bất biến đó thay vì ghi đè hoặc rotate, SHALL CONTINUE TO từ chối build khi tìm thấy nhiều hàng khoá cho cùng bản, và SHALL CONTINUE TO xoá `PRYNX_DIELINE_KEY_B64` cùng secret Supabase khỏi env trước khi chạy Nuitka/Tauri/NSIS.

3.8 WHEN lỗi tạo khuôn thật sự do thông số hoặc do generator ném THEN backend SHALL CONTINUE TO trả 422 "Không thể tạo khuôn với thông số này."; bản vá `_classify_native_failure()` trong `backend/app/api/routes/dieline.py` và bộ `backend/tests/test_dieline_error_classification.py` (gồm hai test chống lệch trích chuỗi literal từ Rust) SHALL CONTINUE TO xanh.

3.9 WHEN chạy `d:\printsolutions-main\src\securityAuditRound2.test.ts` THEN test "chỉ fallback rk cho release legacy khi claim RPC lỗi" SHALL CONTINUE TO khẳng định không có nhánh fail-open cho `rk`; nếu thiết kế đổi tên event hoặc cấu trúc nhánh thì test này SHALL được cập nhật trong cùng lô sửa, không được xoá hoặc nới để cho xanh.

3.10 WHEN `license-verify` xử lý một yêu cầu THEN các cổng bảo mật hiện có SHALL CONTINUE TO hoạt động nguyên trạng: chặn `license_machine_blocks` / `MACHINE_REVOKED` trước `verify_license_edge` và kiểm lại sau RPC, fail-closed khi tra entitlement lỗi, siết `app_version` theo regex SemVer-ish, dedupe `security_logs`, và mask license key khi ghi log.

3.11 WHEN verify thay đổi THEN quy trình kiểm thử SHALL CONTINUE TO tuân thủ ràng buộc môi trường của dự án: vitest/tsc chỉ chạy trên máy Windows thật, backend chạy bằng `backend/venv` + pytest, và báo cáo SHALL CONTINUE TO ghi rõ test nào chưa chạy được cùng lý do.

3.12 WHEN triển khai các nhóm sửa chữa THEN quy trình SHALL CONTINUE TO theo hai chốt của dự án: báo cáo trước, chờ duyệt, rồi sửa theo lô tối đa 5 file, mỗi lô verify xong mới sang lô kế.
---

# Bugfix Design Document

## Overview

Bug: bản phát hành đã khoá engine khuôn bế nhận được token license hợp lệ **không có claim `rk`**, nên `dieline_engine.rs::engine_source()` không có khoá để giải mã payload `PRYNXENC1` và công cụ khuôn bế chết hoàn toàn. Khoá bị giữ lại ở phía server (`license-verify`), không phải ở client.

Chiến lược sửa gồm năm phần, cố ý **không** đụng vào lõi mật mã (AES-256-GCM + AAD = app version) và **không** nới fail-closed của `rk`:

1. **Chẩn đoán trước, sửa sau.** Có hai nhánh nguyên nhân cùng cho ra một kết quả quan sát được; mỗi nhánh cần bản vá đầu tiên khác nhau. Không viết dòng sửa nào trước khi phép đo quyết định trả lời.
2. **Đổi bản chất cổng chống thu gom khoá** từ "đếm số bản trong 30 ngày" sang "chặn theo tốc độ trong cửa sổ ngắn" — vì nhịp phát hành thật của dự án (7 phiên bản/30 ngày) lớn hơn trần (5), nên cổng đang bắn vào khách hàng thật thay vì kẻ thu gom.
3. **Dựng lại migration đã mất** (`claim_rk_grant`, `release_resource_keys`, cột `legacy_fallback`) theo cách idempotent, và đăng ký vào `security-manifest.json` để khoảng trống provenance này không tái diễn im lặng.
4. **Thêm probe kích hoạt thật vào release gate** — điều kiện ship không còn là "đã khoá engine" mà là "đã khoá engine VÀ server mở được nó".
5. **Phát hiện sớm phía client** bằng một truy vấn trạng thái chỉ-đọc, giữ nguyên chủ đích no-op của `warm_dieline_engine`.

Bản vá phân loại lỗi backend (`_classify_native_failure`) đã áp trong phiên trước và nằm ngoài phạm vi thiết kế này; nó là lý do sự cố hiện ra đúng bản chất chứ không phải lý do sự cố được sửa.

## Glossary

- **Bug_Condition (C)**: điều kiện gây lỗi — payload engine ở dạng đã khoá nhưng token license hợp lệ không mang claim `rk`, trong khi license thực sự đủ quyền và khoá của đúng bản đó tồn tại trên server.
- **Property (P)**: hành vi đúng — token cấp cho một license đủ quyền phải mang `rk` khớp `app_version` đang chạy, và engine phải giải mã được payload của đúng bản đó.
- **Preservation**: mọi hành vi không thuộc C phải không đổi — lõi mật mã, build plaintext dev/CI, cổng entitlement Free/Pro, fail-closed riêng `rk`, tính bất biến của khoá theo bản, và quy tắc không ghi giá trị bí mật ra bất kỳ đâu.
- **`rk`**: claim trong payload token đã ký Ed25519, chứa khoá AES-256 mở engine dieline của **một** `app_version`. Nằm trong phần được ký nên client không thể tự thêm/đổi (`dieline_license.rs`, `license-verify/index.ts::signLicenseToken`).
- **`engine_source(resource_key)`** — `native/src/dieline_engine.rs`: nạp mã engine. Payload `PRYNXRAW1` → trả plaintext; payload `PRYNXENC1` → cần khoá, thiếu khoá thì ném `Dieline engine is locked: a valid license token is required`.
- **`authorize_dieline(token, hwid, license_key)`** — `native/src/dieline_license.rs`: verify chữ ký/`exp`/`m`/`k`/`p`/plan rồi mới đọc `rk`, trả `DielineGrant { resource_key }`.
- **`claim_rk_grant`**: RPC Postgres mà `license-verify` gọi trước khi tra khoá. Trả `true` = được cấp, `false` = bị cổng chống thu gom từ chối, lỗi = fail-closed riêng `rk`.
- **`lookupResourceKey`** — `license-verify/index.ts`: tra `release_resource_keys` theo `(product_id, app_version, resource='dieline_engine')` với `revoked_at IS NULL`; tham số `legacyFallbackOnly` thêm điều kiện `legacy_fallback = true`.
- **Nhánh A / B / C / D**: các giả thuyết nguyên nhân cho việc `rk` bị giữ lại — A = chạm trần chống thu gom, B = cổng không chạy được nên fail-closed (ba biến thể B1/B2/B3), C = không tìm thấy hàng khoá cho đúng bản (im lặng, không sinh log), D = thiếu chốt chặn ở release gate nên sự cố ship được. Chi tiết ở *Hypothesized Root Cause*.
- **Probe kích hoạt**: phép kiểm ở release gate gọi `license-verify` bằng license TEST rồi dùng token nhận được để chạy engine trong wheel native vừa staged.

## Bug Details

### Bug Condition

Bug xảy ra khi **hai tầng đồng thời thoả điều kiện**: client đang chạy binary đã khoá và nhận token không có `rk`; server thì đủ mọi dữ kiện để cấp `rk` nhưng vẫn không cấp. Tách hai tầng là bắt buộc vì mỗi tầng nằm ở một repo, một pipeline phát hành riêng, và phép đo để xác nhận từng tầng khác nhau.

**Formal Specification:**

```
FUNCTION isBugCondition(input)
  INPUT: input of type ActivationAttempt = {
           engine_payload,      // chuỗi nhúng lúc build (native/build.rs)
           token,               // token Ed25519 do license-verify ký
           hwid, license_key,   // định danh máy + key khách
           app_version,         // desktop/package.json -> body.app_version
           server_state         // trạng thái Supabase tại thời điểm verify
         }
  OUTPUT: boolean

  // ── Tầng 1 — CLIENT ────────────────────────────────────────────────────
  // native/src/dieline_engine.rs::split_payload / engine_is_locked
  payloadLocked := headerOf(input.engine_payload) = "PRYNXENC1"

  // native/src/dieline_license.rs::authorize_dieline — token qua HẾT các kiểm tra
  grant := authorize_dieline(input.token, input.hwid, input.license_key)
  tokenAccepted := grant IS Ok

  // native/src/dieline_engine.rs::engine_source — thiếu khoá thì ném
  keyMissing := tokenAccepted AND grant.resource_key = None

  clientArmed := payloadLocked AND tokenAccepted AND keyMissing

  // ── Tầng 2 — SERVER ───────────────────────────────────────────────────
  // supabase/functions/license-verify/index.ts (nhánh result.status === 'VALID')
  licenseValid  := input.server_state.verify_license_edge.status = "VALID"
                   AND NOT existsRow(license_machine_blocks, license, machine)

  entitled      := resourceKeyAllowed(plan, features) = true      // pro | dev | feature

  versionAccepted := input.app_version MATCHES /^[0-9A-Za-z][0-9A-Za-z.\-+]{0,63}$/

  keyRowExists  := EXISTS row IN release_resource_keys
                     WHERE product_id  = "prynx"
                       AND app_version = input.app_version
                       AND resource    = "dieline_engine"
                       AND revoked_at IS NULL

  // signLicenseToken(..., resource_key = null) => payload.rk = undefined
  rkWithheld    := claimNames(input.token) DOES NOT CONTAIN "rk"

  serverArmed := licenseValid AND entitled AND versionAccepted
                 AND keyRowExists AND rkWithheld

  RETURN clientArmed AND serverArmed
END FUNCTION
```

### Bản đồ C(X) → file:hàm từng mắt

| Mắt trong C(X) | File | Hàm / vị trí |
|---|---|---|
| `payloadLocked` | `d:\pdfcompare\native\src\dieline_engine.rs` | `split_payload()`, `engine_is_locked()` — header do `native/build.rs::write_payload` sinh |
| `tokenAccepted` | `d:\pdfcompare\native\src\dieline_license.rs` | `authorize_dieline()` — verify Ed25519, `exp`, `m`, `k`, `p`, plan/features |
| `keyMissing` | `d:\pdfcompare\native\src\dieline_engine.rs` | `engine_source()` nhánh `"PRYNXENC1"`, `resource_key.ok_or_else(...)` |
| lỗi lộ ra HTTP | `d:\pdfcompare\backend\app\api\routes\dieline.py` | `_classify_native_failure()` → 403 (đã áp, không sửa lại) |
| token tới client | `d:\pdfcompare\desktop\src\stores\useAuthStore.ts` | `validateLicense()` → `saveTokenToDPAPI()` → `ensureKeyRegisteredInRust()` |
| token qua Rust host | `d:\pdfcompare\desktop\src-tauri\src\security.rs` | `register_validated_key()` → `verify_license_token_internal()` (không đọc `rk`) |
| `licenseValid` | `d:\printsolutions-main\supabase\functions\license-verify\index.ts` | `supabase.rpc('verify_license_edge')` + hai lần kiểm `license_machine_blocks` |
| `entitled` | cùng file | `resourceKeyAllowed(plan, features)` |
| `versionAccepted` | cùng file | biến `safeVersion` (regex SemVer-ish) |
| cổng thu gom | cùng file | `supabase.rpc('claim_rk_grant', { p_cap: RK_VERSION_CAP, p_window_days: RK_WINDOW_DAYS })` |
| `keyRowExists` | cùng file | `lookupResourceKey()` → bảng `release_resource_keys` |
| `rkWithheld` | cùng file | `signLicenseToken(..., resourceKey)` — `rk: resource_key || undefined` |
| hàng khoá được tạo | `d:\pdfcompare\build_production.ps1` | khối `Step 1a-pre` (≈ dòng 488–632): GET rồi POST `release_resource_keys`, đặt `PRYNX_DIELINE_KEY_B64` |
| khoá vào binary | `d:\pdfcompare\native\build.rs` | `encrypt()` — AAD = `PRYNX_DIELINE_VERSION` = `$APP_VERSION` |

### Vì sao sửa một tầng là không đủ

**Chỉ sửa client — bất khả thi về mặt thiết kế.** Client không có nguồn nào để tự dựng `rk`: binary chỉ chứa ciphertext (`build.rs`), và `rk` nằm trong payload đã ký Ed25519 nên không thể tự thêm. Mọi cách "sửa" ở client để engine chạy được mà không có `rk` đều đồng nghĩa với một trong hai việc: ship engine plaintext, hoặc nhận khoá do phía không ký cung cấp. Cả hai xoá bỏ toàn bộ lý do tồn tại của lớp chống crack (vi phạm 3.1, 3.4). Tầng client vì thế chỉ có thể cải thiện **phát hiện và thông báo**, không bao giờ mở khoá.

**Chỉ sửa server — đúng nguyên nhân nhưng không đóng được sự cố.** Ba lý do:

- **Trễ do token đã lưu.** Máy đang kẹt giữ token trong DPAPI với TTL 72h; `warm_dieline_engine` cố ý no-op nên không có gì buộc lấy token mới. Sau khi server được sửa, người dùng vẫn thấy đúng lỗi cũ cho tới nhịp heartbeat kế (5 phút) hoặc lần mở app sau — mà không có gì nói cho họ biết chỉ cần chờ. Đây là phần việc của mục G.
- **Không chặn tái diễn.** `build_production.ps1` hiện chỉ fail-fast ở bước **đẩy** khoá, không kiểm bước **cấp** khoá (1.7). Server đúng hôm nay không bảo đảm bản kế ship được: chỉ cần một lần drift migration hoặc một lần đổi ngưỡng là lặp lại y nguyên. Đây là mục E + F.
- **Lệch phiên bản giữa hai repo.** Edge Function deploy độc lập với installer. Trong cửa sổ lệch đó, client mới có thể nói chuyện với bundle cũ và ngược lại. Xử lý bằng **hợp đồng phản hồi có enum** (mục D) chứ không bằng giả định hai bên ship cùng lúc.

Nói ngắn: nguyên nhân nằm ở tầng server, nhưng **bằng chứng, thông báo và chốt chặn tái diễn** nằm ở tầng client và release gate. Vá một tầng thì hoặc không sửa được gì (client), hoặc sửa được lần này và mù lần sau (server).

### Examples

- **Đo được trên rc.9 (26/08, 11:31–11:32):** token hợp lệ, `plan = pro`, `features` rỗng, `exp` 29/08 06:56 UTC, claim = `exp, k, m, p, plan`. Kỳ vọng: claim có thêm `rk`, engine giải mã, khuôn bế sinh ra. Thực tế: `engine_source()` ném `Dieline engine is locked…` sáu lần liên tiếp, backend 403, UI toast đỏ + "Thử lại" không bao giờ hết.
- **Người dùng đổi thông số** (L×W×D khác, boxType khác, khổ giấy khác): kỳ vọng khuôn khác nhau; thực tế lỗi y hệt ở mọi bộ thông số — vì lỗi xảy ra trước khi engine được nạp, không liên quan tham số.
- **Bấm "Thử lại" nhiều lần:** kỳ vọng thử lại giải quyết lỗi tạm; thực tế mỗi lần lại một dòng `RuntimeError` mới trong `app.log` vì token trong phiên vẫn là token thiếu `rk`.
- **Build dev (`maturin develop --release`, không có `PRYNX_DIELINE_KEY_B64`):** payload `PRYNXRAW1`, `engine_source(None)` trả plaintext, khuôn bế chạy bình thường. Đây là lý do lỗi không bao giờ xuất hiện trong vòng dev và mọi test Rust/vitest vẫn xanh — **C(X) chỉ đúng trên artifact đã đóng gói**.
- **Edge case, hành vi mong đợi giữ nguyên:** client cũ không gửi `app_version` → `lookupResourceKey` trả null → token không có `rk` → binary cũ nhúng plaintext vẫn chạy. Đây **không** phải bug (3.6); C(X) loại trường hợp này qua mắt `payloadLocked`.
- **Edge case, hành vi mong đợi giữ nguyên:** license `free` → `resourceKeyAllowed` false → không cấp `rk`, công cụ bị `require_feature` từ chối trước đó. Không phải bug (3.3); C(X) loại qua mắt `entitled`.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**

- Lõi mật mã engine: AES-256-GCM, nonce dẫn xuất trong `build.rs`, **AAD = app version**, khoá 32 byte bất biến theo từng bản (3.1). Không đổi thuật toán, không đổi header payload, không đổi cách sinh nonce.
- Build không khoá (`PRYNXRAW1`, dev/CI): nạp plaintext, không cần `rk`; `payload_kind_matches_build_env` và `locked_build_unlocks_only_with_issued_key` giữ xanh (3.2).
- Thứ tự đọc `rk`: chỉ sau khi chữ ký Ed25519, `exp`, cận tuổi thọ token, `m`, `k`, `p` và plan/features đều qua (3.4). `rk` chỉ tồn tại trong payload đã ký.
- Cổng entitlement: `free`/thiếu `packaging.dieline` vẫn bị `require_feature` từ chối và vẫn không được cấp `rk` (3.3).
- Fail-closed riêng khoá tài nguyên: RPC lỗi ⇒ **không** cấp `rk` cho bản mới; chỉ hàng đã đánh dấu `legacy_fallback = true` được nhận. Không có nhánh fail-open (3.9).
- Kích hoạt license không bị chặn bởi bất cứ chuyện gì liên quan `rk`: client không gửi `app_version`, hoặc tra bảng lỗi, thì token license vẫn cấp bình thường (3.6).
- Tính bất biến của khoá theo bản trong `build_production.ps1`: khoá đã có thì dùng lại, không rotate/ghi đè; nhiều hàng cho cùng bản thì từ chối build; xoá `PRYNX_DIELINE_KEY_B64` và secret Supabase khỏi env trước Nuitka/Tauri/NSIS (3.7).
- Phân loại lỗi backend `_classify_native_failure()` và `backend/tests/test_dieline_error_classification.py` (403/500/413/422, hai test tự trích chuỗi literal từ Rust) giữ nguyên và giữ xanh (3.8).
- Các cổng bảo mật hiện có của `license-verify`: chặn `license_machine_blocks` trước `verify_license_edge` **và** kiểm lại sau RPC, fail-closed khi tra entitlement lỗi, regex SemVer-ish cho `app_version`, dedupe `security_logs`, mask license key khi ghi log (3.10).
- Không ghi giá trị token / license key / `rk` ra log, đĩa, binary, argv, manifest hay báo cáo — chỉ được ghi tên claim, độ dài, hoặc trạng thái có/không (3.5).

**Scope:**

Mọi input **không** thoả C(X) phải hoàn toàn không bị ảnh hưởng, gồm:

- Bản dev/CI nhúng engine plaintext (không có `PRYNX_DIELINE_KEY_B64` lúc build).
- License `free`, license thiếu `packaging.dieline`, license hết hạn, máy bị `license_machine_blocks`.
- Client cũ không gửi `app_version`.
- Bản phát hành đã khoá **và** token đã có `rk` đúng bản — đường đi thành công hiện tại.
- Mọi lỗi tạo khuôn thật do thông số (`dieline_request.rs`, `dieline_validation.py`, `runtimeValidation.ts`) — vẫn 422 với câu tiếng Việt cũ.
- Mọi luồng license khác: `license-release`, đổi key, thu hồi có ân hạn, offline grace theo `exp` của token, anti-clockback.

Hành vi đúng cho input **thoả** C(X) được định nghĩa ở *Correctness Properties* — Property 1.

## Hypothesized Root Cause

Bốn giả thuyết. Cả bốn cùng cho ra một quan sát duy nhất ở client ("token không có `rk`"), nên **không phân biệt được từ máy người dùng** — đó là proof gap đã ghi ở 1.2.

### 1. Nhánh A — chạm trần chống thu gom khoá

`license-verify/index.ts`: `RK_VERSION_CAP = 5` phiên bản khác nhau trong `RK_WINDOW_DAYS = 30` ngày cho mỗi license. `claim_rk_grant` trả `false` ⇒ không tra bảng ⇒ token không có `rk`, kèm `security_logs.event_type = 'rk_cap_exceeded'`.

Bằng chứng ủng hộ, đo từ `git log -- desktop/src-tauri/tauri.conf.json`: bảy phiên bản khác nhau trong cửa sổ 30 ngày — rc.4, rc.5, rc.6, rc.7, rc.8, **rc.8.1**, rc.9 (rc.8.1 được xác nhận độc lập bởi chú thích ánh xạ version trong `build_production.ps1`: `rc.8.1=801 va rc.9=900`). 7 > 5. Máy kiểm thử/nội bộ chạy qua tất cả các RC là trường hợp trực tiếp chạm trần. Cổng được thiết kế cho giả định "người dùng chạy một bản, thi thoảng update" và giả định đó sai với chính nhịp phát hành của dự án.

### 2. Nhánh B — cổng không chạy được nên fail-closed

`claim_rk_grant` lỗi ⇒ `rkClaimErr` ⇒ `lookupResourceKey(..., legacyFallbackOnly = true)`. Hàng khoá do `build_production.ps1` tạo **không** set `legacy_fallback` ⇒ trả null ⇒ `security_logs.event_type = 'rk_claim_failed_closed'`. Ba biến thể, cùng hệ quả:

- **B1 — RPC không tồn tại.** Không file nào trong `d:\printsolutions-main\supabase\migrations\*.sql` chứa `rk_grant`, `release_resource_keys` hay `legacy_fallback` (đã quét toàn thư mục, 0 kết quả). `20260726140000_prynx_rk_grant_cap.sql` được `docs/BAO_CAO_AUDIT_BAO_MAT_2026-07-30.md` §SEC.2 ghi nhận là **untracked**, và `20260726090000_release_resource_keys.sql` được `docs/audit/SECURITY_AUDIT_2026-07-26.md` dẫn chiếu nhưng cũng không còn trong repo.
- **B2 — RPC tồn tại nhưng chữ ký/quyền lệch.** PostgREST phân giải RPC theo **tên tham số**; nếu hàm trên production có tập tham số khác `(p_license_hash, p_product_id, p_app_version, p_cap, p_window_days)`, hoặc `service_role` không còn `EXECUTE`, thì `supabase.rpc()` trả lỗi (PGRST202/42883/42501) — đi đúng nhánh `rkClaimErr`.
- **B3 — cột `legacy_fallback` không tồn tại.** `lookupResourceKey` **luôn** `select('resource_key, legacy_fallback')` ở cả hai đường đi. Cột thiếu ⇒ PostgREST trả 42703 ⇒ `error` ⇒ hàm trả null ⇒ `rk` mất kể cả khi `claim_rk_grant` trả `true`. Đây là biến thể nguy hiểm nhất vì nó **không** sinh event `rk_*` nào.

### 3. Nhánh C — không tìm thấy hàng khoá cho đúng `app_version` (im lặng hoàn toàn)

Nếu `claim_rk_grant` trả `true` mà `lookupResourceKey` trả null (không có hàng, `revoked_at` đã set, hoặc `maybeSingle()` gặp nhiều hàng), `license-verify` **không ghi log gì cả** — nhánh `rkAllowed === true` không có `logSecurityEvent`. Đây là điểm mù thật của code hiện tại.

Đã loại phần "lệch chuỗi phiên bản" bằng đo trực tiếp: client gửi `APP_VERSION` = `desktop/package.json`.version = `1.0.0-rc.9` (`desktop/src/lib/uiErrorDiagnostics.ts:6`), build ghi `app_version` = `desktop/src-tauri/tauri.conf.json`.version = `1.0.0-rc.9` (`build_production.ps1:342`). Hai chuỗi khớp. Con số `1.0.0.900` mà sidecar báo là `$NUMERIC_VERSION` (version resource Windows), không tham gia tra khoá. Phần còn lại của nhánh C (hàng khoá có thật sự tồn tại và chưa revoke không) vẫn cần đo trên production.

### 4. Nhánh D — không phải nguyên nhân, nhưng làm mọi nhánh trên khó thấy

`build_production.ps1` chỉ kiểm bước **đẩy** khoá lên bảng; không có bước nào kiểm bước **cấp** khoá. `DIELINE_LOCKED = yes` trong manifest chỉ chứng minh binary đã mã hoá, không chứng minh có ai mở được nó. Đây là lý do rc.9 ship được ở trạng thái không dùng nổi.

### Cân bằng bằng chứng — đọc thẳng, không nghiêng theo giả định

Yêu cầu đầu vào nêu "bằng chứng nghiêng về B". Đọc lại tài liệu trong repo thì **không nghiêng như vậy**, và điều này đổi thứ tự chẩn đoán:

- `docs/BAO_MAT_FIXES_2026-07-30.md`, mục **"Deploy production — 2026-07-30"**, ghi rằng người vận hành đã áp migration trên Supabase và cung cấp bằng chứng: `legacy_fallback` **tồn tại**, `claim_rk_grant` **tồn tại**, `anon/authenticated` không có quyền gọi RPC tra đơn, `service_role` có quyền, release key active tổng `1` / legacy `1`. `license-verify` sau đó deploy thành công lên version `13`.
- Đây là bằng chứng `[EXTERNAL]` (do người vận hành báo, chưa đo lại hôm nay), nên **không kết luận** rằng B1/B3 đã bị loại. Nhưng nó đủ để nói: *"RPC chắc chắn thiếu"* là một suy luận từ **repo**, không phải từ **production**. Việc file migration không có trong repo chứng minh một khoảng trống **provenance/tái lập** (đúng như 1.6 mô tả), không chứng minh đối tượng vắng mặt trên production.
- Ngược lại, nhánh A có một bằng chứng số học đo được ngay trong repo: 7 phiên bản/30 ngày > trần 5. Không cần truy cập production để xác nhận phép so sánh này.
- Một dữ kiện trong cùng đoạn đó lại ủng hộ B/C: ngày 30/07 chỉ có **1** hàng khoá và nó được đánh `legacy_fallback = true`. Mọi hàng do rc.4→rc.9 tạo sau đó **không** legacy. Nên nếu cổng lỗi, tất cả các RC mất `rk` cùng lúc — khớp với việc rc.9 chết hoàn toàn.

Kết luận về mức tin cậy: **A và B đều là giả thuyết sống**, A có bằng chứng nội bộ mạnh hơn B, B có bằng chứng nội bộ về provenance nhưng bằng chứng production ngược lại. Không đủ cơ sở xếp hạng chắc chắn ⇒ phép đo ở chốt 0.3 là bắt buộc trước khi sửa.

Điều này **không** đổi phạm vi bản vá: cả mục C (thiết kế lại cổng) và mục E (dựng lại migration) đều bắt buộc theo 2.3 và 2.6, bất kể nhánh nào đúng. Chẩn đoán quyết định **thứ tự** và quyết định **cái gì được tính là bằng chứng đã sửa xong**: nếu A, bằng chứng là cùng license/cùng bản giờ nhận được `rk`; nếu B, bằng chứng là RPC tồn tại và trả `true`.

## Quy trình chẩn đoán — chốt 0, làm trước mọi bước sửa

Nguyên tắc: **ưu tiên phép đo chỉ-đọc**; mọi bước chạm Supabase production là **RỦI RO CAO**, cần chốt xác nhận của người vận hành và **không được tự động chạy** bởi agent hay script.

### 0.1 — Xác nhận tầng client của C(X) (chỉ-đọc, cục bộ, rủi ro: không)

- **Đo cái gì:** `DIELINE_LOCKED` trong release manifest của bản rc.9 đã cài; `version` trong `desktop/package.json` và `desktop/src-tauri/tauri.conf.json`.
- **Kết luận được:** `DIELINE_LOCKED = yes` xác nhận `payloadLocked`. Hai chuỗi version khớp ⇒ loại biến thể "lệch chuỗi `app_version`" của nhánh C. Nếu lệch ⇒ dừng, nhánh C thắng, không cần đo production.
- **Rủi ro:** không. Không secret nào bị đọc.

### 0.2 — Xác nhận token thiếu `rk`, chỉ đọc tên claim (chỉ-đọc, cục bộ, rủi ro: thấp)

- **Đo cái gì:** `%APPDATA%\PrynX\prynx_token.dat` (DPAPI CurrentUser) — giải mã trong bộ nhớ, in **tên** claim đã sắp xếp và độ dài, không in giá trị.
- **Kết luận được:** xác nhận `rkWithheld` còn đúng ở thời điểm đo (token có thể đã được làm mới từ 26/08). Nếu claim đã có `rk` ⇒ sự cố đã tự hết do server đổi trạng thái ⇒ vẫn giữ nguyên phạm vi sửa (chống tái diễn) nhưng bỏ chốt 0.6.
- **Rủi ro:** thấp; phải bảo đảm không ghi giá trị ra terminal/file (3.5). Không chạy trên máy khách nếu chưa được đồng ý.

### 0.3 — Phép đo quyết định: `security_logs` ngày 26/08 (chỉ-đọc, **PRODUCTION — RỦI RO CAO**)

- **Đo cái gì:** `SELECT` trên `security_logs` cho `created_at` trong ngày 2026-08-26, `machine_id` = máy bị kẹt, `event_type IN ('rk_cap_exceeded', 'rk_claim_failed_closed', 'rk_legacy_fallback')`, lấy cả `details` và `created_at`.
- **Kết luận được:**
  - `rk_cap_exceeded` ⇒ **nhánh A**. `details` mang `app_version`, `cap`, `window_days` để đối chiếu.
  - `rk_claim_failed_closed` ⇒ **nhánh B** (chưa phân biệt B1/B2).
  - `rk_legacy_fallback` ⇒ nhánh B nhưng có hàng legacy trả lời — với rc.9 thì bất thường, nghĩa là ai đó đã backfill `legacy_fallback` rộng hơn mức 30/07, phải điều tra riêng.
  - **Không có cả ba** ⇒ **nhánh B3 hoặc C**: cổng chạy xong nhưng `lookupResourceKey` trả null im lặng. Chuyển sang 0.5.
- **Rủi ro:** chỉ đọc, không đổi dữ liệu; rủi ro thực nằm ở việc cầm secret service-role. Cần chốt xác nhận.
- **Bẫy đọc kết quả:** `INVALID_VERIFY_DEDUPE_SECONDS = 5 * 60` và `logSecurityEvent` dedupe theo `(event_type, ip)` hoặc `(event_type, license_key)` khi `source = 'server'`. Sáu lần lỗi trong hai phút sẽ để lại **nhiều nhất một hàng**. Không kết luận "chỉ xảy ra một lần" từ số hàng, và không kết luận "không xảy ra" nếu chỉ tìm trong cửa sổ hẹp hơn 5 phút.

### 0.4 — RPC có trong schema cache không (chỉ-đọc, **PRODUCTION — RỦI RO CAO**)

- **Đo cái gì:** `GET {SUPABASE_URL}/rest/v1/` với header `apikey` = secret service-role, User-Agent không giống browser (Supabase chặn `sb_secret_` khi UA giống renderer — xem `build_production.ps1:576-578`). Tìm path `/rpc/claim_rk_grant` trong tài liệu OpenAPI trả về.
- **Kết luận được:** có path ⇒ loại **B1**, còn lại B2 (chữ ký/quyền lệch). Không có path ⇒ **B1 xác nhận**.
- **Rủi ro:** chỉ đọc, không tác dụng phụ.
- **Cấm:** **không** thăm dò bằng cách `POST /rest/v1/rpc/claim_rk_grant`. RPC đó **ghi** (nó *claim* một suất cấp khoá); gọi thử sẽ tiêu một suất của license thật và làm thay đổi chính trạng thái đang đo.

### 0.5 — Trạng thái bảng khoá và cột `legacy_fallback` (chỉ-đọc, **PRODUCTION — RỦI RO CAO**)

- **Đo cái gì:** `GET /rest/v1/release_resource_keys?select=app_version,legacy_fallback,revoked_at,created_at&product_id=eq.prynx&resource=eq.dieline_engine&limit=200`. **Không** select `resource_key`.
- **Kết luận được:**
  - HTTP 400 kèm mã 42703 nhắc `legacy_fallback` ⇒ **B3 xác nhận**: mọi `lookupResourceKey` đều lỗi, `rk` mất trên cả hai đường đi, và không sinh event nào — khớp với kết quả rỗng ở 0.3.
  - HTTP 200 và có đúng một hàng `app_version = 1.0.0-rc.9`, `revoked_at = null` ⇒ loại phần còn lại của nhánh C, `keyRowExists` trong C(X) được xác nhận.
  - Không có hàng cho rc.9, hoặc `revoked_at` đã set, hoặc có nhiều hàng ⇒ **nhánh C**; nhiều hàng còn làm `maybeSingle()` lỗi nên phải xử lý như một sự cố dữ liệu riêng.
  - Số hàng `legacy_fallback = true` phải vẫn là **1** (khớp bằng chứng 30/07). Lớn hơn 1 ⇒ fail-closed đã bị nới, điều tra riêng.
- **Rủi ro:** chỉ đọc. Bảng có RLS deny-all nên bắt buộc dùng secret service-role từ kho DPAPI, không dùng anon key.

### 0.6 — Kích hoạt có kiểm soát bằng license TEST (**GHI — PRODUCTION — RỦI RO RẤT CAO**)

Chỉ chạy khi 0.3–0.5 không kết luận được, và chỉ sau chốt xác nhận tường minh.

- **Đo cái gì:** gọi `license-verify` với license **TEST** riêng (không bao giờ dùng license khách), `machine_id` cố định dành riêng cho probe, `app_version = 1.0.0-rc.9`; đọc **tên** claim trong token trả về.
- **Kết luận được:** phân biệt trực tiếp A/B/C trên đúng đường đi thật, vì lần gọi này để lại event mới trong `security_logs` không bị dedupe lẫn với ngày 26/08.
- **Rủi ro:** đây là **ghi**: tạo/cập nhật hàng activation, tiêu **một suất** cấp khoá của license TEST, có thể chèn `security_logs`. Nếu nhánh A đúng thì bản thân phép đo cũng đẩy license TEST gần trần hơn.
- **Ghi chú thiết kế:** đây chính là probe của mục F. Dựng F trước rồi dùng nó làm 0.6 thì phép đo không bị bỏ đi sau khi dùng một lần, và cùng một đoạn code vừa là chẩn đoán vừa là chốt chặn tái diễn.

### Thứ tự và điều kiện dừng

`0.1 → 0.2 → 0.3` (quyết định) `→ 0.4` (chỉ khi 0.3 ra `rk_claim_failed_closed`) `→ 0.5` (khi 0.3 rỗng, hoặc để xác nhận `keyRowExists`) `→ 0.6` (phương án cuối).

Không viết bản vá nào trước khi 0.3 trả lời, vì bản vá **đầu tiên** khác nhau: nhánh A ⇒ bắt đầu từ thiết kế lại cổng (mục C) vì cổng đang chặn oan và migration có thể vẫn nguyên; nhánh B ⇒ bắt đầu từ dựng lại migration (mục E) vì cổng chưa từng chạy nên đổi ngưỡng là vô nghĩa.

## Correctness Properties

Property 1: Bug Condition - License hợp lệ trên bản đã khoá phải nhận được khoá engine

_For any_ input mà bug condition đúng (`isBugCondition` trả true) — nghĩa là payload engine ở dạng `PRYNXENC1`, token qua hết mọi kiểm tra của `authorize_dieline`, license đủ quyền theo `resourceKeyAllowed`, `app_version` khớp regex và có hàng khoá chưa revoke cho đúng bản đó — hệ thống sau khi sửa SHALL cấp token mang claim `rk` là khoá 32 byte của đúng `app_version` ấy, `engine_source()` SHALL giải mã được payload bằng AAD = app version, và `generate_dieline_json` SHALL trả về `DielineModel` hợp lệ thay vì `Dieline engine is locked: a valid license token is required`.

**Validates: Requirements 2.1, 2.3, 2.7**

Property 2: Preservation - Mọi input ngoài bug condition giữ nguyên hành vi

_For any_ input mà bug condition **không** đúng (`isBugCondition` trả false), code sau khi sửa SHALL cho ra cùng kết quả như code trước khi sửa, giữ nguyên: build plaintext `PRYNXRAW1` nạp engine không cần `rk`; license `free`/thiếu `packaging.dieline` bị từ chối và không nhận `rk`; client không gửi `app_version` vẫn kích hoạt được và vẫn không nhận `rk`; token đã có `rk` đúng bản vẫn giải mã như cũ; lỗi thông số thật vẫn trả 422 với đúng câu tiếng Việt cũ; khoá đã tồn tại cho một bản không bị rotate hay ghi đè.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.6, 3.7, 3.8, 3.10**

Property 3: Fail-closed - Cổng khoá tài nguyên không bao giờ mở khi hạ tầng lỗi

_For any_ input mà cổng cấp khoá không kết luận được (RPC không tồn tại, lỗi quyền, lỗi truy vấn, hoặc tra bảng lỗi), hệ thống SHALL không đưa `rk` vào token cho bản phát hành mới, SHALL vẫn cấp token license bình thường để kích hoạt không bị chặn, SHALL ghi `security_logs` với `event_type` phân biệt được nguyên nhân, và SHALL trả về lý do dạng enum trong phản hồi. Không tồn tại đường đi nào biến lỗi hạ tầng thành việc cấp `rk`.

**Validates: Requirements 2.4, 2.5, 3.9**

Property 4: No-Secret-Leak - Không giá trị bí mật nào rời khỏi vùng cho phép

_For any_ đường đi mã nguồn, log, test, probe, manifest hay báo cáo được thêm hoặc sửa bởi bản vá này, hệ thống SHALL không ghi giá trị token, license key thô, hay khoá `rk` ra stdout/stderr, file log, release manifest, status JSON, argv của process con, hay tài liệu; chỉ được ghi tên claim, độ dài, hoặc trạng thái có/không.

**Validates: Requirements 2.7, 3.5**

### Truy vết các yêu cầu dạng quy trình

Bốn property trên phủ các yêu cầu **kiểm được bằng test**. Số còn lại là yêu cầu quy trình/hạ tầng, không phát biểu được dưới dạng property; chúng được truy vết trực tiếp tới mục thiết kế:

| Yêu cầu | Mục thiết kế phủ nó |
|---|---|
| 2.2 — quy trình chẩn đoán phân biệt được nhánh, chốt xác nhận cho mọi bước chạm production | *Quy trình chẩn đoán — chốt 0* (0.1 → 0.6) |
| 2.6 — migration tồn tại trong repo, đăng ký vào manifest, xác minh RPC trước khi deploy | *Fix Implementation § E* |
| 2.8 — phát hiện sớm trạng thái engine bị khoá kèm hướng xử lý | *Fix Implementation § G* |
| 3.11 — ràng buộc môi trường kiểm thử, ghi rõ test nào chưa chạy được | *Testing Strategy § Ma trận môi trường* |
| 3.12 — hai chốt, lô ≤ 5 file, verify từng lô | *Fix Implementation § I* |

## Fix Implementation

### C. Thiết kế lại cổng chống thu gom khoá

#### Hiện trạng và bất biến cần giữ

Cổng hiện tại: `RK_VERSION_CAP = 5` **số bản khác nhau** / `RK_WINDOW_DAYS = 30`, tính theo **license**. Bất biến phải giữ: `rk` fail-closed riêng (Property 3), token license luôn được cấp bất kể `rk` (3.6), và cổng phải nằm **trước** khi tra bảng khoá.

#### Bốn hướng đã xét

| Hướng | Nội dung | Đánh giá |
|---|---|---|
| 1 | Đếm theo cặp `(license, machine_id)` | **Loại** |
| 2 | Nới `RK_VERSION_CAP` | **Loại** |
| 3 | Tách ngưỡng cảnh báo khỏi ngưỡng từ chối | **Loại** |
| 4 | Chỉ chặn khi số bản khác nhau tăng bất thường trong cửa sổ ngắn | **CHỌN** |

#### Hướng đã chọn — hướng 4: chặn theo tốc độ, không theo tổng số

Thay quy tắc đếm-tổng bằng quy tắc tốc độ:

```
RK_BURST_WINDOW_MINUTES = 60
RK_BURST_VERSION_LIMIT  = 3     // số bản KHÁC NHAU MỚI được cấp trong cửa sổ
```

Ba luật phụ, đều bắt buộc để quy tắc có nghĩa:

- **Idempotent theo cặp `(license, app_version)`.** Xin lại khoá cho một bản **đã** được cấp không bao giờ tính thêm. Nếu thiếu luật này, heartbeat 5 phút của một máy bình thường sẽ tự đốt hết ngưỡng trong một giờ. Thực thi bằng khoá chính `(license_hash, product_id, app_version)` trên bảng sổ cấp.
- **Đếm theo license, không theo máy.** Đổi `machine_id` không reset bộ đếm (`machine_id` chỉ được lưu để ops thấy độ lan, không tham gia điều kiện chặn).
- **Serialize bằng advisory lock.** `pg_advisory_xact_lock` theo `license_hash` quanh đoạn đếm→chèn, để N request song song của cùng một license không cùng thấy "vẫn dưới ngưỡng" (cùng khuôn mẫu `verify_license_edge` đã dùng theo audit 26/07).

Không cần thêm event mới: khi bị chặn vẫn ghi `event_type = 'rk_cap_exceeded'` (giữ nguyên tên để truy vấn lịch sử ngày 26/08 và các assertion literal hiện có không vỡ), còn danh tính quy tắc đặt trong `details`: `{ rule: 'burst_v1', window_minutes, version_limit, app_version }`. Bản thân bảng sổ cấp **là** dấu vết audit: ops truy vấn nó bất cứ lúc nào để thấy một license đã xin khoá cho những bản nào, vào lúc nào, từ những `machine_id` nào — không cần thêm event telemetry định kỳ.

**Lý do chọn:** tốc độ chính là dấu vết của tấn công, còn tổng số thì không. Người dùng thật chỉ tăng thêm một bản mỗi lần **tải và cài** một build mới — cách nhau nhiều giờ tới nhiều ngày, kể cả trong ngày hotfix dày nhất của dự án (rc.9 → rc.8.1 → rc.9 là 2 bản khác nhau). Kẻ thu gom thì lặp `app_version` trong vài giây tới vài phút. Hai hành vi cách nhau 2–3 bậc độ lớn, nên ngưỡng có biên an toàn rất rộng ở cả hai phía: không có ca từ chối oan ở bất kỳ nhịp phát hành thực tế nào, mà đúng cái kẻ tấn công cần (nhiều khoá, nhanh) thì bị chặn.

**Lý do loại hướng 1 (đếm theo cặp `(license, machine_id)`):** không giải quyết được mệnh đề đầu của 2.3 và làm yếu mệnh đề sau. Người dùng thật cập nhật 7 bản trên **một** máy có số đếm y hệt khi đổi khoá đếm sang cặp — họ vẫn bị chặn. Ngược lại, kẻ tấn công được tặng một núm reset: mỗi `machine_id` mới là một hạn mức mới, chỉ bị chặn bởi `max_activations` (thường 2–3), tức nhân hạn mức thu gom lên gấp mấy lần. Đổi khoá đếm sang chiều mà attacker kiểm soát được là đi sai hướng.

**Lý do loại hướng 2 (nới cap):** chỉ dịch bức tường. Với 7 bản/30 ngày hôm nay, nới lên 10 sẽ phải nới lại lần sau khi nhịp RC dày hơn, và bất kỳ con số tĩnh nào cũng vừa chặn oan người dùng vừa vô nghĩa với kẻ tấn công biết chờ (5/30 ngày trong 6 tháng vẫn ra 30 khoá). Nó không loại bỏ **lớp** bug: "số bản trong 30 ngày" không phải dấu hiệu thu gom, nên mọi ngưỡng đặt trên nó đều sai bản chất.

**Lý do loại hướng 3 (tách ngưỡng cảnh báo/từ chối):** vẫn phải có một con số để **từ chối**, nên thừa hưởng nguyên vấn đề của hướng 2; còn tầng cảnh báo tự nó không từ chối gì nên không thoả mệnh đề thứ hai của 2.3 với tư cách một cổng. Nó là quan sát, không phải cổng. Thiết kế đã chọn có **đúng một** luật từ chối (tốc độ) và dùng sổ cấp làm dấu vết — khác với hướng 3 ở chỗ không tồn tại ngưỡng-từ-chối-theo-tổng nào cả.

#### Mô hình đe doạ cho hướng đã chọn

- **Kẻ tấn công có gì:** một license Pro hợp lệ (mua thật hoặc bị rò); anon key công khai của Supabase (đã nằm trong bundle frontend nên coi như công khai); khả năng gọi `license-verify` với `app_version` tuỳ ý và `machine_id` tuỳ ý — nhưng mỗi `machine_id` mới tiêu một suất activation, bị `verify_license_edge` giới hạn theo `max_activations` và serialize bằng advisory lock.
- **Kẻ tấn công lấy được gì:** với mỗi `(license, app_version)` được cấp, một khoá AES-256 mở payload engine dieline của **đúng bản đã phát hành đó**. Có khoá thì patch được binary bản đó để chạy engine mà không cần license.
- **Vẫn không làm được gì:** lấy khoá của bản **chưa build** (không có hàng trong bảng, `revoked_at`/không tồn tại đều trả null); dùng một khoá cho bản khác (AAD = version, cộng unique index trên `resource_key`); tự thêm/đổi `rk` trong token (chữ ký Ed25519, `rk` nằm trong payload đã ký); đọc khoá từ binary (chỉ ciphertext được ship).
- **Sau khi đổi:** thông lượng đi từ "5 bản/30 ngày, có trần tổng" sang "3 bản mới/giờ, không trần tổng". Tức là một kẻ kiên nhẫn cuối cùng vẫn gom được toàn bộ khoá của các bản **đã phát hành**.
- **Vì sao đánh đổi chấp nhận được:**
  1. Trần cũ **cũng không** ngăn được việc đó — 5 bản mỗi 30 ngày trong 6 tháng đã là ~30 khoá. Trần cũ chỉ làm chậm kẻ tấn công, đồng thời khoá cứng mọi khách hàng cập nhật bình thường. Hướng 4 giữ nguyên tính chất "chỉ làm chậm" nhưng bỏ được phần từ chối oan ⇒ chi phí tấn công không giảm đáng kể, chi phí cho khách hàng thật giảm về 0.
  2. Giá trị một khoá suy giảm theo thời gian: nó chỉ mở đúng một bản, và người dùng hợp pháp thì đi tiếp sang bản mới.
  3. Mỗi lần cấp đều để lại một hàng sổ khoá theo `license_hash`, nên hành vi thu gom **quy được về một license cụ thể**. Phản ứng đúng là thu hồi license đó và `revoked_at` các khoá bị ảnh hưởng — một control có thể mở rộng, khác với bộ đếm.
  4. Kẻ tấn công vốn đã có bản hợp pháp đang dùng được; lợi ích biên của việc thu gom là **phân phối lại**, và việc đó bị chặn bởi thu hồi license cộng với thực tế bản crack bị đóng băng ở một phiên bản.
  5. Chi phí của thiết kế cũ đã hiện thực hoá: mất trắng tính năng đầu tàu cho khách trả tiền trong suốt một nhịp RC bình thường (7 > 5, đo được). Tính khả dụng cho khách trả tiền nặng hơn một control chỉ có tác dụng trì hoãn.
- **Rủi ro còn lại (residual):** thu gom chậm vẫn khả thi; phát hiện dựa vào việc ops thực sự đọc sổ cấp. Không có cơ chế tự động thu hồi khi phát hiện — cố ý, vì tự động thu hồi license dựa trên một heuristic tốc độ là cách nhanh nhất để khoá oan khách hàng.
- **Fail-closed giữ nguyên:** RPC lỗi/không tồn tại ⇒ vẫn không cấp `rk` cho bản mới, chỉ hàng `legacy_fallback = true` được nhận (Property 3). Đổi quy tắc chặn **không** đi kèm bất kỳ nới lỏng nào ở nhánh lỗi.
- **Probe phát hành (mục F) không được miễn trừ.** Không thêm allow-list license nào. Probe chỉ tăng số bản khi **version thật đổi**; build lại cùng version dùng lại đúng hàng khoá cũ nên không tính thêm. Nếu một ngày cần bump version quá `RK_BURST_VERSION_LIMIT` lần, người vận hành nâng ngưỡng một cách tường minh — chứ không tạo đường vòng vĩnh viễn quanh cổng.

### D. Hợp đồng phản hồi khi từ chối `rk`

#### Enum lý do

Thêm trường `rk_status` vào phản hồi `license-verify`, **chỉ** ở nhánh `result.status === 'VALID'`:

| `rk_status` | Ý nghĩa | `security_logs.event_type` |
|---|---|---|
| `granted` | Token mang `rk` của đúng `app_version` | — (đường thành công, không ghi log) |
| `not_requested` | Client không gửi `app_version` (bản cũ) | — (3.6, hành vi cũ) |
| `not_entitled` | `resourceKeyAllowed` false (Free / thiếu feature) | — (3.3, hành vi cũ) |
| `no_key_for_version` | Cổng cho phép nhưng không có hàng khoá chưa revoke cho bản đó | `rk_key_row_missing` (**event mới**, bịt điểm mù nhánh C) |
| `burst_denied` | Cổng tốc độ từ chối | `rk_cap_exceeded` (giữ tên cũ, `details.rule = 'burst_v1'`) |
| `infra_unavailable` | RPC lỗi/không tồn tại, không có hàng legacy | `rk_claim_failed_closed` (giữ nguyên) |
| `legacy_fallback` | RPC lỗi nhưng hàng đã đánh dấu legacy, khoá vẫn cấp | `rk_legacy_fallback` (giữ nguyên) |

Ràng buộc nội dung:

- **Không** chứa giá trị khoá, **không** chứa license key thô, **không** chứa hash license.
- **Không** chứa bộ đếm hay ngưỡng (`cap`, `window`, số bản hiện tại). Các con số đó chỉ đi vào `security_logs.details` phía server. Lý do: đừng biến phản hồi thành công cụ đo cổng cho kẻ thu gom.
- `app_version` được echo lại thì vô hại (client tự gửi).
- Ba tên event cũ giữ **nguyên chuỗi** để lịch sử `security_logs` liền mạch và để assertion literal ở `securityAuditRound2.test.ts` không vỡ vì lý do không cần thiết.
- Residual đã cân: `no_key_for_version` cho kẻ tấn công biết một `app_version` có khoá hay không. Thông tin này họ **đã** suy được từ việc token có `rk` hay không, nên enum không thêm bề mặt mới. Đây là lý do chấp nhận.

#### Đường đi của trạng thái

```
license-verify (Edge, printsolutions)
  └─ response.rk_status  ─────────────────────────────────────────────────┐
     (KHÔNG đưa vào token — token chỉ có `rk` hoặc không, giữ 3.6)       │
                                                                          ▼
desktop/src/stores/useAuthStore.ts :: validateLicense()
  ├─ đọc response.rk_status → set state `dielineKeyStatus`
  │    · nhánh error / RATE_LIMITED / offline-grace → 'unknown' (không có câu trả lời mới)
  ├─ saveTokenToDPAPI(token)                       (không đổi)
  └─ ensureKeyRegisteredInRust(licenseKey)         (không đổi)
                                                   │
                                                   ▼
desktop/src-tauri/src/security.rs :: register_validated_key()
  · verify chữ ký / exp / cận tuổi thọ / m / k / p rồi cache binding
  · KHÔNG đọc và KHÔNG gate theo `rk` — cố ý. Gate ký request theo `rk` sẽ khiến
    user Free và build dev plaintext không ký được request nào (vỡ 3.2, 3.3).
                                                   │
                                                   ▼  (token đi kèm từng request)
backend/app/api/routes/dieline.py → pdfcompare_native.generate_dieline_json()
  └─ native/src/dieline_license.rs :: authorize_dieline() → DielineGrant.resource_key
       └─ native/src/dieline_engine.rs :: engine_source() → thiếu khoá thì ném
            └─ _classify_native_failure() → HTTP 403 + câu tiếng Việt  (đã có, không sửa)
                                                   │
                                                   ▼
desktop/src/components/dieline-tool/DielineTool.tsx
  · banner phát hiện sớm đọc `dielineKeyStatus` + trạng thái engine (mục G)
  · toast 403 giữ nguyên làm đường cuối
```

### E. Migration dựng lại

#### Tệp

`d:\printsolutions-main\supabase\migrations\20260826120000_prynx_rk_grant_rebuild.sql` (mới).

Header của file phải ghi rõ nó **thay thế** hai migration đã mất khỏi repo và sẽ không bao giờ được dựng lại nguyên bản: `20260726090000_release_resource_keys.sql` và `20260726140000_prynx_rk_grant_cap.sql`. Đây là bản vá cho khoảng trống provenance ở 1.6.

#### Schema suy ra (không đoán, có nguồn)

`release_resource_keys` — suy từ ba nguồn độc lập: các cột `build_production.ps1` thực sự đọc/ghi (`select=resource_key`; POST `product_id`, `app_version`, `resource`, `resource_key`), các cột `lookupResourceKey` thực sự query (`select('resource_key, legacy_fallback')`, filter `product_id`/`app_version`/`resource`, `.is('revoked_at', null)`), và mô tả trong `docs/audit/SECURITY_AUDIT_2026-07-26.md` ("6 columns, RLS enabled, no policy — service_role-only deny-all, unique index on `resource_key`"):

| Cột | Kiểu | Nguồn |
|---|---|---|
| `product_id` | `text not null` | build POST + filter Edge |
| `app_version` | `text not null` | build POST + filter Edge |
| `resource` | `text not null` | build POST + filter Edge (`'dieline_engine'`) |
| `resource_key` | `text not null` | build POST/GET; unique index (audit 26/07) |
| `revoked_at` | `timestamptz null` | `.is('revoked_at', null)` |
| `created_at` | `timestamptz not null default now()` | cột thứ 6 để khớp "6 columns" |
| `legacy_fallback` | `boolean not null default false` | thêm bởi migration 30/07 (`docs/BAO_MAT_FIXES_2026-07-30.md` §SEC.2) |

Thêm **unique** trên `(product_id, app_version, resource)`: bắt buộc, vì `lookupResourceKey` dùng `.maybeSingle()` (hai hàng ⇒ lỗi ⇒ null im lặng) và `build_production.ps1` dựa vào "nhiều hàng ⇒ từ chối build" (3.7).

`prynx_rk_grants` (sổ cấp, mới) — cần cho luật idempotent và cửa sổ tốc độ:

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `license_hash` | `text not null` | SHA-256 hex đầy đủ, Edge đã có `sha256Hex()`. **Không** lưu key thô (3.5) |
| `product_id` | `text not null` | |
| `app_version` | `text not null` | |
| `machine_id` | `text null` | chỉ để ops thấy độ lan; không tham gia điều kiện chặn |
| `granted_at` | `timestamptz not null default now()` | |
| PK | `(license_hash, product_id, app_version)` | luật idempotent |
| Index | `(license_hash, granted_at desc)` | truy vấn cửa sổ tốc độ |

#### Quy tắc idempotent — bảng đã CÓ trên production

Bảng và (theo bằng chứng 30/07) cột `legacy_fallback` đã tồn tại trên production, mang **khoá thật của các bản đã phát hành**. Migration phải hội tụ về schema đích mà không phá dữ liệu:

- `create table if not exists` cho cả hai bảng; sau đó `alter table … add column if not exists` cho **từng** cột, để một bảng có sẵn nhưng thiếu cột vẫn hội tụ mà không cần rewrite.
- **Không** `drop table`, `truncate`, `alter column … type`, và **không** `update resource_key` ở bất kỳ đâu (3.7).
- `alter table … add column if not exists legacy_fallback boolean not null default false` — và **không backfill**. Đây là điểm dễ sai nhất: migration 30/07 đã đánh `legacy_fallback = true` cho đúng nhóm hàng tồn tại lúc đó (bằng chứng: legacy = 1). Chạy lại backfill hôm nay sẽ đánh legacy cho toàn bộ hàng rc.4→rc.9 và **mở lại đúng nhánh fail-open mà 30/07 đã đóng**. File phải có chú thích cảnh báo tại chỗ, và người vận hành xác nhận `count(*) where legacy_fallback` vẫn bằng 1 sau khi áp.
- `alter table … enable row level security` (idempotent), **không** tạo policy; `revoke all on table … from public, anon, authenticated`; `grant all on table … to service_role`. Áp cho cả `prynx_rk_grants`.
- `create unique index if not exists` cho `resource_key` và cho `(product_id, app_version, resource)`. Nếu index thứ hai fail vì dữ liệu đã trùng ⇒ đó là một sự cố dữ liệu phải xử lý riêng (nhánh C), không được ép bằng cách bỏ index.

#### Hàm

- `drop function if exists public.claim_rk_grant(text, text, text, integer, integer);` **trước** khi tạo lại. Lý do: `create or replace` không đổi được tên tham số hay kiểu trả về; nếu bản trên production lệch ở một trong hai thì lệnh replace fail giữa migration. Drop theo **đúng chữ ký** cũng bảo đảm chỉ còn nhiều nhất một `claim_rk_grant`, tránh PostgREST báo nhập nhằng overload (PGRST203).
- Tạo lại `public.claim_rk_grant(p_license_hash text, p_product_id text, p_app_version text, p_cap integer, p_window_days integer) returns boolean` **giữ nguyên chữ ký cũ**, làm lớp mỏng bỏ qua `p_cap`/`p_window_days` và uỷ quyền cho luật tốc độ. Lý do: bundle `license-verify` đang chạy trên production (version 13) gọi đúng chữ ký này; giữ nó nghĩa là rollback Edge về bundle cũ vẫn hoạt động, và trong cửa sổ giữa migration và deploy không có ai bị fail-closed.
- Tạo `public.claim_rk_grant_v2(p_license_hash text, p_product_id text, p_app_version text, p_machine_id text, p_window_minutes integer, p_version_limit integer) returns boolean` — bundle mới gọi hàm này. Tên tham số mới nên PostgREST phân giải được, không nhập nhằng với v1.
- Cả hai: `security definer`, `set search_path = public, pg_temp`, `revoke execute … from public, anon, authenticated`, `grant execute … to service_role`. Thân hàm: `pg_advisory_xact_lock` theo `license_hash` → `insert … on conflict (license_hash, product_id, app_version) do nothing` nếu đã có thì trả `true` ngay (idempotent) → nếu là bản mới thì đếm số `app_version` distinct trong cửa sổ, so với ngưỡng, chèn hoặc trả `false`.
- Kết file: `notify pgrst, 'reload schema';` để PostgREST nạp hàm mới mà không phải đợi.

#### Xác minh RPC/bảng tồn tại trên production TRƯỚC khi deploy edge function

Thứ tự bắt buộc, giữ nguyên quy tắc rollout của 30/07 ("migration → xác minh → Edge deploy"). Toàn bộ bước xác minh là **chỉ-đọc**, chạy bởi người vận hành, mỗi bước là **RỦI RO CAO** vì chạm production:

1. `GET {SUPABASE_URL}/rest/v1/` (header `apikey` = secret service-role, User-Agent kiểu backend) → tài liệu OpenAPI phải chứa **cả** `/rpc/claim_rk_grant` **và** `/rpc/claim_rk_grant_v2`. Thiếu ⇒ schema cache chưa reload ⇒ **không deploy**.
2. `GET /rest/v1/release_resource_keys?select=app_version,legacy_fallback,revoked_at&product_id=eq.prynx&resource=eq.dieline_engine&limit=200` → phải HTTP 200 (chứng minh cột `legacy_fallback` tồn tại), và số hàng `legacy_fallback = true` phải vẫn là **1**.
3. `GET /rest/v1/prynx_rk_grants?select=license_hash&limit=1` → HTTP 200 (service role đọc được; kết quả rỗng là đúng).
4. Chỉ khi 1–3 đạt: deploy `license-verify` bằng Supabase CLI **2.110.0** đã pin checksum (control §SEC.4 của 30/07), rồi chạy probe mục F với license TEST làm chốt runtime.

Không đảo thứ tự: bundle mới gọi `claim_rk_grant_v2`; deploy trước migration sẽ đẩy **mọi** request vào nhánh `rkClaimErr` và fail-closed `rk` cho toàn bộ khách hàng — đúng sự cố đang sửa, nhưng trên diện rộng hơn.

#### Đăng ký vào `security-manifest.json`

`d:\printsolutions-main\supabase\migrations\security-manifest.json`:

- `required_migrations` thêm `"20260826120000_prynx_rk_grant_rebuild.sql"`. Test "clean checkout phải có đủ migration bảo mật" duyệt danh sách này và `existsSync` từng file ⇒ tên trong manifest và file migration **phải cùng một lô**.
- `deployment_guards["license-verify"].remote_migration_version` = `"20260826120000"`; `reason` cập nhật thành: RPC cấp khoá tài nguyên và cột fallback legacy phải tồn tại trước khi deploy bundle gọi chúng.
- `audit` bump `"2026-08-26"`.
- `edge_after_migrations` đã có `license-verify` — không đổi.
- Hai migration đã mất **không** đăng ký được (file không tồn tại thì test sẽ đỏ); vết của chúng nằm ở header file migration mới.

### F. Probe kích hoạt thật cho release gate

#### Đặt ở bước nào

Trong `d:\pdfcompare\build_production.ps1`, **Step 1a**, ngay sau khi cổng capability của wheel native đã staged đạt (chỗ đặt `$script:PpeNativeSha256`, ≈ dòng 795) và **trước** `$script:DIELINE_LOCKED = …` / `Remove-Item Env:PRYNX_DIELINE_KEY_B64` (≈ dòng 809–811).

Lý do chọn đúng chỗ này:

- Wheel đã staged vào `$nativeSiteDir` và `$env:PYTHONPATH` đã trỏ vào đó ⇒ probe chạy trên **đúng artifact sẽ đi vào sidecar**, không phải `.pyd` trong venv dev. Kiểm bất cứ thứ gì khác đều không chứng minh gì.
- Fail ở đây tốn ~2 phút; fail sau Nuitka + frontend + Tauri + NSIS tốn 30 phút trở lên.
- Đây đã là chỗ dự án đặt các cổng hợp đồng artifact khác (cổng PPE capability), nên không thêm khái niệm mới vào pipeline.
- `$lockDieline` từ Step 1a-pre còn trong scope ⇒ biết ngay build này là locked hay plaintext.
- Probe **không cần** `PRYNX_DIELINE_KEY_B64`: nó dùng khoá của **server**, và việc giải mã thành công tự chứng minh hai khoá bằng nhau. Không so sánh khoá trực tiếp ⇒ khoá không phải vào process probe.

#### Khẳng định "mở được" mà không in giá trị nào

Hai chặng, chặng sau mới là bằng chứng thật:

**Chặng 1 — server có cấp `rk` không.** POST `{SUPABASE_URL}/functions/v1/license-verify` với body `{license_key: <TEST>, machine_id: <cố định>, product_id: 'prynx', app_version: $APP_VERSION}`. Gateway có `verify_jwt = true` (`supabase/config.toml`) nên gửi `apikey` + `Authorization: Bearer` bằng **anon key công khai** (`VITE_SUPABASE_ANON_KEY` trong `desktop\.env`) — probe **không** cần và **không** được nhận secret `sb_secret_`. Khẳng định: `status -eq 'VALID'` **và** `rk_status -eq 'granted'`.

**Chặng 2 — khoá đó mở được payload của đúng bản đang build.** Chạy đúng đường đi thật trên wheel đã staged:

```
pdfcompare_native.generate_dieline_json(
    request_json,     # native/tests/fixtures/dieline_default_request.json — cùng fixture các test Rust dùng
    token, machine_id, license_key)
```

Khẳng định: trả về JSON có `dieline.panels` không rỗng. Chuỗi này chứng minh liền một mạch: token qua `authorize_dieline`, `rk` giải mã được payload `PRYNXENC1` với AAD = `$APP_VERSION`, Boa parse được engine, engine sinh được khuôn. Không có cách nào nó đạt mà `rk` sai.

`machine_id` là một giá trị **cố định dành riêng cho probe** (ví dụ `PRYNX-RELEASE-PROBE-01`). Điều này hợp lệ vì `authorize_dieline` **nhận** `hwid` làm tham số và chỉ so với claim `m`; module native không tự tính hardware id. Dùng một giá trị cố định nghĩa là probe tiêu đúng **một** suất activation vĩnh viễn, không sinh thêm mỗi lần build.

**Không in gì:** probe in đúng một dòng, ví dụ `dieline_activation_probe=ok claims=exp,k,m,p,plan,rk panels=14 rk_len=32`. Chỉ **tên** claim đã sắp xếp, số panel, và độ dài khoá sau khi decode (32 là hằng số thiết kế công khai, không phải thông tin về giá trị). Không token, không license key, không `rk`, không hash license.

**Không đưa secret vào argv.** Token/license key truyền cho process con **qua biến môi trường**, script probe nằm ở file tạm trong `$env:TEMP`, xoá trong `finally`, và `Remove-Item Env:PRYNX_PROBE_*` cũng trong `finally`. Đây là cùng bài học đã trả giá ở §SEC.3 ngày 30/07 (private key từng nằm trong process argv). Trên Windows, argv của process khác đọc được qua WMI; biến môi trường của process con thì không.

**Nguồn license TEST:** thêm accessor `Get-PrynXReleaseProbeLicense` vào `scripts/release_secret_store.ps1`, đọc **file kho riêng** (`…\PrynX\ReleaseSecrets\probe.clixml`) thay vì thêm field vào kho hiện tại — vì `Get-PrynXReleaseSupabaseSecret` từ chối nạp khi `SchemaVersion` khác 1, nên thêm field sẽ làm vô hiệu kho đã cấu hình trên máy phát hành.

#### Chính sách fail và ghi nhận

- `-Release`: thiếu `rk`, `rk_status` khác `granted`, hoặc chặng 2 fail ⇒ **throw**, không ship.
- Build nội bộ: mặc định cũng throw; có `-SkipDielineActivationProbe` cho chẩn đoán offline, đối xứng với `-AllowPlaintextDieline` đã có.
- Build plaintext (`$lockDieline` false): bỏ qua probe — không có gì để mở.
- Manifest ghi `DIELINE_ACTIVATION_PROBE = ok | skipped | plaintext` cạnh `DIELINE_LOCKED` (≈ dòng 1535), và public release từ chối mọi giá trị khác `ok` — đúng khuôn mẫu chốt `DIELINE_LOCKED -ne "yes"` ở dòng 1438.

#### Về việc tái dùng test Rust `locked_build_unlocks_only_with_issued_key`

**Đã cân nhắc và loại khỏi vai trò release gate.** Test đó chỉ chứng minh khoá trong `PRYNX_DIELINE_KEY_B64` mở được payload — một bất biến **cục bộ, offline**, và nó **đã xanh** trong khi rc.9 ship ở trạng thái không ai mở được. Nó không thể thấy phía server, nên không phải bằng chứng cho 2.7. Ngoài ra, gọi `cargo test` trong Step 1a sẽ biên dịch lại crate ở profile test với khoá trong env và để lại thêm một bản plaintext engine trong `target/` — thêm thời gian và thêm bề mặt secret, không thêm độ phủ.

Giữ nguyên test đó làm bất biến mật mã (nó đang gác 3.2). Ranh giới rõ ràng: **test Rust gác lõi mật mã; probe gác việc cấp khoá.**

### G. Phát hiện sớm phía client

#### Bất biến phải giữ

`warm_dieline_engine` **không đổi**: `warm_engine()` vẫn `return Ok(())` ngay khi `engine_is_locked()`. Chưa có token thì không có khoá, và warmup **không được** thất bại hay log lỗi mỗi lần khởi động — đó là chủ đích được ghi thẳng trong comment của hàm. Mọi phát hiện sớm phải đi qua một đường **khác**, không bao giờ thử giải mã.

#### Truy vấn trạng thái chỉ-đọc

- **Native:** thêm `dieline_engine_status()` vào `native/src/dieline_engine.rs`, trả `{ locked: bool, payload_version: str }`, tính **chỉ** từ `split_payload()`. Không nhận khoá, không giải mã, không thể fail trên build đã khoá. Không rò gì: header payload và version nằm sẵn trong binary, ai đọc file cũng thấy. Đăng ký trong `native/src/lib.rs` cạnh hai pyfunction dieline hiện có.
- **Backend:** `GET /api/dieline/engine-status` trong `backend/app/api/routes/dieline.py`, trả `{ locked, license_key_present }`, trong đó `license_key_present` phản ánh token **của chính request này** có `rk` hay không. Luôn 200, không bao giờ 403 vì lý do khoá — đây là truy vấn trạng thái, không phải tính năng bị gate. Endpoint nằm **cùng router** nên vẫn thừa hưởng `require_feature`: người dùng Free bị từ chối ở tầng entitlement như cũ và không cần banner này (giữ 3.3).
- **Token phía client:** `desktop/src/stores/licenseToken.ts` thêm `hasResourceKey: boolean` vào `LicenseTokenClaims`, tính bằng `typeof raw.rk === 'string' && raw.rk.length > 0`. **Chỉ trạng thái có/không**, không bao giờ trả giá trị — giữ đúng ranh giới hiện tại của module này (nó đã cố ý không expose `rk`) và giữ 3.5.
- **Store:** `useAuthStore` thêm `dielineKeyStatus` gán từ `response.rk_status` ở **mọi** nhánh của `validateLicense`; các nhánh không có câu trả lời mới từ server (lỗi mạng, `RATE_LIMITED`, offline-grace theo `exp`) gán `'unknown'`.

#### Thời điểm và hình thức

Kiểm khi **mở công cụ khuôn bế**, không phải lúc khởi động app: `DielineTool.tsx` gọi endpoint trạng thái **một lần mỗi phiên**; nếu `locked && !license_key_present` thì hiện **banner cố định, không chặn** ở trên panel tham số, gồm bản chất sự cố và hai hành động:

- **"Kiểm tra lại bản quyền"** → gọi `validateLicense()`; nếu server đã được sửa thì token mới có `rk` và banner tự mất.
- **"Liên hệ hỗ trợ"** → copy `APP_VERSION` + `dielineKeyStatus` (không secret).

Banner không chặn panel: nếu server được sửa giữa phiên, nhịp heartbeat 5 phút hoặc nút kiểm tra lại sẽ dọn nó.

**Vì sao không cảnh báo lúc khởi động:** sẽ làm ồn với người chưa bao giờ mở công cụ khuôn bế, và dựng lại đúng vấn đề "log lỗi mỗi lần khởi động" mà warmup no-op tồn tại để tránh (1.8). **Vì sao không để sidecar fail lúc khởi động:** sidecar chưa có token lúc đó — theo thiết kế.

### I. Chia lô theo thứ tự phụ thuộc

Tối đa 5 file mỗi lô (quy tắc hai chốt của dự án, 3.12). Mỗi lô verify xong mới sang lô kế.

**Lô 0 — chẩn đoán.** Không ghi file. Chạy chốt 0.1 → 0.6 ở mục *Quy trình chẩn đoán*. Người vận hành thực hiện các bước chạm production; agent không tự chạy. Điều kiện ra khỏi lô: biết nhánh A hay B/C.

**Lô 1 — migration + manifest** — repo `d:\printsolutions-main`:

| File | Trạng thái |
|---|---|
| `supabase/migrations/20260826120000_prynx_rk_grant_rebuild.sql` | mới |
| `supabase/migrations/security-manifest.json` | sửa |

Vì sao đi trước: bundle của lô 2 gọi `claim_rk_grant_v2`; object phải tồn tại trước. Manifest và file migration cùng lô vì test duyệt `required_migrations` và `existsSync` từng tên.

**Lô 2 — edge function + test** — repo `d:\printsolutions-main`:

| File | Trạng thái |
|---|---|
| `supabase/functions/license-verify/index.ts` | sửa (enum `rk_status`, gọi v2, event `rk_key_row_missing`) |
| `src/securityAuditRound2.test.ts` | sửa (thêm assertion, giữ nguyên 3 literal cũ) |

Deploy chỉ sau khi lô 1 đã áp **và** xác minh chỉ-đọc 1–3 ở mục E đạt.

**Lô 3 — release gate** — repo `d:\pdfcompare`:

| File | Trạng thái |
|---|---|
| `build_production.ps1` | sửa (probe trong Step 1a, switch `-SkipDielineActivationProbe`, dòng manifest) |
| `scripts/release_secret_store.ps1` | sửa (`Get-PrynXReleaseProbeLicense`, kho `probe.clixml` riêng) |
| `scripts/setup_release_probe_license.ps1` | mới (nhập license TEST vào kho DPAPI) |
| `scripts/dieline_activation_probe.py` | mới (chặng 2 + in một dòng trạng thái) |

Sau lô 2 vì probe khẳng định `rk_status = 'granted'` — trường chỉ tồn tại từ lô 2. Đặt trước lô 4/5 vì đây là thứ ngăn một bản không dùng được ship lần nữa.

**Lô 4 — trạng thái engine: native + backend** — repo `d:\pdfcompare`:

| File | Trạng thái |
|---|---|
| `native/src/dieline_engine.rs` | sửa (thêm `dieline_engine_status`; `warm_dieline_engine` **không đổi**) |
| `native/src/lib.rs` | sửa (đăng ký pyfunction) |
| `backend/app/api/routes/dieline.py` | sửa (endpoint `engine-status`; `_classify_native_failure` **không đổi**) |
| `backend/tests/test_dieline_engine_status.py` | mới |

**Lô 5 — phát hiện sớm phía client** — repo `d:\pdfcompare`:

| File | Trạng thái |
|---|---|
| `desktop/src/stores/licenseToken.ts` | sửa (`hasResourceKey`, chỉ trạng thái) |
| `desktop/src/stores/useAuthStore.ts` | sửa (`dielineKeyStatus` từ `rk_status`) |
| `desktop/src/components/dieline-tool/DielineTool.tsx` | sửa (banner không chặn) |
| `desktop/src/stores/__tests__` (test cho `dielineKeyStatus` + `hasResourceKey`) | mới |

Sau lô 2 (đọc `rk_status`) và sau lô 4 (gọi endpoint trạng thái).

## Testing Strategy

### Validation Approach

Hai pha. Pha một: dựng bằng chứng cho thấy bug tồn tại **trên code chưa sửa** và xác nhận (hoặc bác bỏ) nhánh nguyên nhân. Pha hai: chứng minh bản vá đúng cho input thoả C(X) và không đổi gì cho input ngoài C(X).

Đặc thù của bug này: **C(X) không tái lập được trên máy dev**. Build dev nhúng payload `PRYNXRAW1` nên `engine_source(None)` luôn thành công; muốn C(X) đúng phải có artifact đã khoá cộng một câu trả lời thật từ `license-verify`. Hệ quả: mức bằng chứng cao nhất đạt được từ máy dev là **Mức 2** (test tự động); **Mức 3** (runtime) chỉ đạt được ở máy phát hành + Supabase production. Mọi báo cáo phải ghi đúng mức đã đạt.

### Exploratory Bug Condition Checking

**Goal:** dựng counterexample trước khi sửa, và xác nhận/bác bỏ nhánh nguyên nhân. Nếu bác bỏ thì phải giả thuyết lại.

**Test Plan:** phần đo trên hệ thống thật đã được đặc tả đầy đủ ở mục *Quy trình chẩn đoán — chốt 0* (0.1 → 0.6) và **không lặp lại ở đây**. Phần bổ sung ở đây là hai test tự động chạy được ngay trên máy dev, tái lập C(X) mà **không** cần production:

**Test Cases:**

1. **Payload đã khoá + thiếu khoá (Rust, sẽ đỏ đúng chỗ mong đợi trên code chưa sửa).** Build `native/` với `PRYNX_DIELINE_KEY_B64` là một khoá 32 byte dùng một lần, rồi gọi `engine_source(None)` — phải ném đúng `Dieline engine is locked: a valid license token is required`. Đây là counterexample tối thiểu cho tầng client của C(X), và test `locked_build_unlocks_only_with_issued_key` **đã** khẳng định điều này. Nó xanh, và chính việc nó xanh chứng minh tầng client hoạt động đúng đặc tả ⇒ bug **không** nằm ở đây. Đây là bước bác bỏ, không phải bước xác nhận.
2. **Token thiếu `rk` đi hết đường backend (pytest).** Dựng token ký bằng keypair test không có claim `rk`, chạy qua `_classify_native_failure` với chuỗi lỗi literal của Rust ⇒ phải ra 403 với câu tiếng Việt về bản quyền, **không** phải 422. `backend/tests/test_dieline_error_classification.py` đã phủ và đã xanh. Cũng là bước bác bỏ.
3. **Cổng tốc độ/trần trên bundle Edge (vitest tĩnh, printsolutions).** Trên code chưa sửa, khẳng định `RK_VERSION_CAP = 5` và `RK_WINDOW_DAYS = 30` tồn tại trong bundle, và khẳng định 7 phiên bản trong `git log -- desktop/src-tauri/tauri.conf.json` vượt trần. Đây là counterexample **số học** cho nhánh A, dựng được hoàn toàn offline.
4. **Edge case — `lookupResourceKey` trả null im lặng.** Trên code chưa sửa, khẳng định nhánh `rkAllowed === true` **không có** lời gọi `logSecurityEvent` nào. Đây là bằng chứng cho điểm mù nhánh C/B3 và là lý do event `rk_key_row_missing` được thêm ở mục D.

**Expected Counterexamples:**

- Token hợp lệ, `plan = pro`, đủ hạn, đúng máy — nhưng tập claim là `exp, k, m, p, plan`, thiếu `rk` (đã đo trên rc.9).
- `engine_source()` ném ở nhánh `resource_key.ok_or_else(...)`, không phải ở nhánh giải mã ⇒ khoá **không đến**, chứ không phải khoá **sai**. Phân biệt này quan trọng: khoá sai sẽ ném `Dieline engine could not be unlocked for this license`.
- Nguyên nhân khả dĩ: chạm trần chống thu gom (nhánh A); RPC cổng lỗi/không tồn tại/lệch chữ ký (nhánh B1/B2); cột `legacy_fallback` thiếu làm mọi select lỗi (B3); không có hàng khoá cho đúng `app_version` (nhánh C).

### Fix Checking

**Goal:** với mọi input thoả bug condition, hàm đã sửa cho ra hành vi mong đợi.

**Pseudocode:**

```
FOR ALL input WHERE isBugCondition(input) DO
  token  := license_verify_fixed(input.license_key, input.machine_id,
                                 input.product_id, input.app_version)
  ASSERT token.rk_status = 'granted'
  ASSERT 'rk' IN claimNames(token)
  result := generate_dieline_json_fixed(input.request_json, token,
                                        input.machine_id, input.license_key)
  ASSERT result.dieline.panels IS NOT EMPTY
END FOR
```

Hiện thực của vòng lặp này chính là probe mục F. Đó là lý do probe được thiết kế như một phép kiểm tái dùng được, không phải một script dùng một lần: nó vừa là chốt phát hành, vừa là fix check duy nhất đạt Mức 3.

### Preservation Checking

**Goal:** với mọi input **không** thoả bug condition, hàm đã sửa cho ra đúng kết quả như hàm gốc.

**Pseudocode:**

```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT license_verify_original(input) = license_verify_fixed(input)
  ASSERT engine_source_original(input)  = engine_source_fixed(input)
END FOR
```

**Testing Approach:** property-based testing phù hợp cho preservation ở đây vì miền input là tổ hợp rời rạc và rộng: `plan × features × có/không app_version × payload locked/plaintext × trạng thái hàng khoá × trạng thái RPC`. Sinh tổ hợp tự động phủ được các ô mà unit test tay hay bỏ (ví dụ `plan = 'dev'` + `features = null` + `app_version` hợp lệ + RPC lỗi + hàng legacy). Với `engine_source`, quan hệ "khoá đúng mở được, khoá sai/thiếu bị từ chối" là property thuần, sinh khoá ngẫu nhiên là cách kiểm tự nhiên nhất — khuôn mẫu này đã có sẵn ở `locked_payload_needs_the_right_key`.

**Test Plan:** quan sát hành vi trên code **chưa sửa** cho từng ô của miền không-bug trước, ghi lại làm kỳ vọng, rồi mới viết property test. Không viết kỳ vọng từ đọc code — chính việc suy từ code đã tạo ra bug này (cổng được thiết kế theo một giả định về hành vi người dùng chưa từng được đo).

**Test Cases:**

1. **Build plaintext vẫn chạy.** Quan sát trên code chưa sửa: không có `PRYNX_DIELINE_KEY_B64` ⇒ `PRYNXRAW1` ⇒ engine chạy không cần `rk`. Sau vá phải giữ y nguyên; `payload_kind_matches_build_env` là chốt (3.2).
2. **Free/thiếu feature vẫn bị từ chối.** Quan sát: `resourceKeyAllowed('free', null)` false, `authorize_dieline` ném `Feature 'packaging.dieline' requires Pro`. Sau vá không đổi, và `rk_status` mới phải là `not_entitled` chứ không phải một lý do nào khác (3.3).
3. **Client cũ không gửi `app_version` vẫn kích hoạt được.** Quan sát: `safeVersion` undefined ⇒ bỏ qua toàn bộ khối `rk` ⇒ token cấp bình thường. Sau vá: `rk_status = 'not_requested'`, token **giống hệt** hình dạng cũ (3.6).
4. **Fail-closed khi cổng lỗi.** Quan sát: RPC lỗi + hàng không legacy ⇒ không có `rk`, token license vẫn cấp. Sau vá không đổi; chỉ thêm `rk_status = 'infra_unavailable'` (3.9, Property 3).
5. **Khoá bất biến theo bản.** Quan sát: `build_production.ps1` gặp hàng có sẵn thì dùng lại, gặp nhiều hàng thì throw. Sau vá không đổi — probe **không** được ghi gì vào `release_resource_keys` (3.7).
6. **Lỗi thông số vẫn 422.** `test_dieline_error_classification.py` giữ xanh, gồm cả hai test tự trích chuỗi literal từ `dieline_license.rs` (19 chuỗi) và `dieline_engine.rs` (6 chuỗi) — thêm `dieline_engine_status` vào Rust **không** thêm chuỗi lỗi mới, nên hai test này phải xanh mà không cần sửa. Nếu chúng đỏ, đó là tín hiệu bản vá đã thêm thông điệp lỗi ngoài dự kiến (3.8).
7. **Warmup vẫn im lặng.** Trên build đã khoá, `warm_dieline_engine()` trả Ok và **không** ghi dòng lỗi nào vào log — kiểm bằng cách chạy backend với payload đã khoá và không token, rồi khẳng định `app.log` không có dòng nào chứa `Dieline engine` (1.8, mục G).

### Unit Tests

- **Rust (`native/`):** `dieline_engine_status()` trả `locked = true` trên payload đã khoá, `false` trên plaintext, và **không** ném ở cả hai trường hợp; `warm_engine()` vẫn no-op trên payload đã khoá.
- **Backend (pytest):** `GET /api/dieline/engine-status` trả 200 kèm `locked`/`license_key_present` đúng cho: token có `rk`, token không `rk`, không token; và vẫn bị `require_feature` từ chối với license Free.
- **Frontend (vitest):** `readLicenseTokenClaims` trả `hasResourceKey = true/false` đúng và **không** để lộ trường giá trị nào; `validateLicense` gán `dielineKeyStatus` đúng cho từng `rk_status`, và gán `'unknown'` ở nhánh lỗi mạng / `RATE_LIMITED` / offline-grace.
- **Edge (vitest tĩnh, printsolutions):** bundle chứa đủ 7 nhánh enum; không nhánh nào ghi giá trị khoá hoặc license key thô vào response; `claim_rk_grant_v2` được gọi và `rk` vẫn fail-closed khi RPC lỗi.
- **Migration (vitest tĩnh):** file `20260826120000_prynx_rk_grant_rebuild.sql` chứa `if not exists` cho mọi lệnh tạo, **không** chứa `drop table`/`truncate`/`update … resource_key`, **không** chứa lệnh backfill `legacy_fallback = true`, có `security definer` + `set search_path`, có `revoke execute … from public, anon, authenticated` và `grant execute … to service_role`.

### Property-Based Tests

- **Preservation của `engine_source`:** sinh khoá 32 byte ngẫu nhiên và version ngẫu nhiên, mã hoá payload, rồi khẳng định — khoá đúng luôn mở được; khoá sai (đảo bất kỳ bit nào) luôn bị từ chối; AAD sai (version khác) luôn bị từ chối; `None` luôn bị từ chối. Bao trùm Property 2 cho tầng mật mã.
- **Preservation của cổng cấp khoá:** sinh tổ hợp `plan ∈ {free, pro, dev, rác}` × `features ∈ {null, [], ['*'], ['packaging.dieline'], rác}` × `app_version ∈ {undefined, hợp lệ, sai regex}` × `trạng thái RPC ∈ {true, false, lỗi}` × `hàng khoá ∈ {không có, có, có+legacy, đã revoke}` và khẳng định: `rk` chỉ xuất hiện đúng những ô mà bản gốc cũng cấp, cộng thêm các ô mà bản gốc từ chối **chỉ vì** trần 5/30 ngày. Đây là cách duy nhất phát biểu chính xác "bản vá chỉ mở thêm đúng phần bị chặn oan".
- **Idempotence của luật tốc độ:** sinh chuỗi N lần xin khoá cho **cùng** `(license, app_version)` trong cửa sổ, khẳng định số bản distinct đếm được luôn là 1 và không lần nào bị từ chối. Đây là property chống lại đúng cái bẫy đã suýt vào (heartbeat 5 phút tự đốt hạn mức).
- **Không rò bí mật:** với mọi phản hồi sinh ra từ tổ hợp trên, khẳng định chuỗi JSON không chứa giá trị khoá, license key thô, hay hash license (Property 4).

### Integration Tests

- **Toàn tuyến trên artifact đã khoá (Mức 3, máy phát hành):** probe mục F — `license-verify` → token → `generate_dieline_json` trên wheel staged → `dieline.panels` không rỗng.
- **Toàn tuyến trong app đã cài:** cài installer trong profile sạch, kích hoạt bằng license TEST, mở công cụ khuôn bế, tạo một khuôn RTE mặc định; rồi lặp lại với license Free để xác nhận đường từ chối entitlement vẫn đúng.
- **Chuyển trạng thái phía client:** với token thiếu `rk`, mở công cụ khuôn bế phải thấy banner (không thấy toast 403 trước khi bấm tạo); bấm "Kiểm tra lại bản quyền" sau khi server đã sửa phải làm banner mất và tạo khuôn thành công **mà không cần khởi động lại app**.
- **Thứ tự rollout:** trên staging, deploy `license-verify` **trước** migration để xác nhận nó fail-closed đúng cách (không crash, token vẫn cấp, `rk_status = 'infra_unavailable'`), rồi áp migration và xác nhận nó chuyển sang `granted`. Đây là bài kiểm cho chính rủi ro đảo thứ tự đã nêu ở mục E.

### Ma trận môi trường — chạy được gì từ máy nào

| Kiểm | Lệnh | Chạy từ máy dev? |
|---|---|---|
| Backend pytest | `backend\venv\Scripts\python -m pytest tests` | Có |
| Cú pháp Python nhanh | `python -m py_compile <file>` | Có |
| TS typecheck | `cd desktop && npm run typecheck` | **Chỉ Windows thật** |
| vitest PrynX | `cd desktop && npx vitest run src/stores` | **Chỉ Windows thật** |
| Rust native | `cd native && cargo test` (hai lượt: không khoá, và có khoá dùng một lần qua `PRYNX_DIELINE_KEY_B64`) | Có |
| vitest PrintSolutions | `npm run test:run -- src/securityAuditRound2.test.ts` | **Chỉ Windows thật** |
| Đóng gói + probe | `powershell build_production.ps1` | Chỉ máy phát hành, chỉ khi user yêu cầu |

**Không chạy được từ máy dev, và vì sao:**

- **Mọi phép đo/ghi trên Supabase production** (chốt 0.3–0.6, xác minh 1–3 của mục E, deploy Edge, áp migration): cần secret service-role và là hành động rủi ro cao ⇒ người vận hành thực hiện sau chốt xác nhận; agent không tự chạy.
- **Deno typecheck cho Edge Function:** `docs/BAO_MAT_FIXES_2026-07-30.md` ghi rõ máy không có `deno`/Supabase CLI trong PATH. Độ phủ hiện có cho bundle Edge là **vitest tĩnh trên nội dung file**, không phải typecheck. Đây là proof gap; chốt runtime duy nhất là deploy staging.
- **Probe kích hoạt đầy đủ:** cần kho DPAPI phát hành, license TEST, mạng, và một wheel đã khoá ⇒ chỉ máy phát hành.
- **Tái lập C(X) end-to-end:** cần artifact đã đóng gói; vòng dev luôn plaintext.
- **vitest/tsc/eslint:** `node_modules` chứa binary Windows; chạy trong VM/CI Linux cho kết quả sai. Agent làm việc từ xa phải giao user chạy và dán kết quả.

### Test literal bị đóng băng — phải cập nhật trong cùng lô

`d:\printsolutions-main\src\securityAuditRound2.test.ts`, test **"chỉ fallback rk cho release legacy khi claim RPC lỗi"** (dòng 36–42) khoá **ba chuỗi literal** đọc trực tiếp từ `supabase/functions/license-verify/index.ts`:

1. `"query = query.eq('legacy_fallback', true)"`
2. `"event_type: resourceKey ? 'rk_legacy_fallback' : 'rk_claim_failed_closed'"`
3. phủ định: bundle **không được** chứa `'claim_rk_grant failed (fail-open)'`

Hệ quả cho thiết kế: đổi tên event hoặc tái cấu trúc nhánh fallback sẽ làm test đỏ. Thiết kế này **cố ý giữ nguyên byte-for-byte** cả ba mệnh đề — đó là lý do mục D giữ `rk_cap_exceeded`, `rk_legacy_fallback`, `rk_claim_failed_closed` thay vì đổi tên cho "gọn", và giữ nguyên biểu thức ternary trong `logSecurityEvent`. Điều còn lại phải làm ở lô 2 là **bổ sung** assertion, không sửa và không nới ba mệnh đề trên:

- bundle gọi `claim_rk_grant_v2` và **không** còn tham chiếu `RK_VERSION_CAP`/`RK_WINDOW_DAYS` như điều kiện chặn;
- bundle có đủ 7 giá trị `rk_status`;
- nhánh `rkAllowed === true` mà `lookupResourceKey` trả null **có** ghi `rk_key_row_missing` (chốt cho điểm mù nhánh C);
- migration mới có mặt trong `required_migrations` và `deployment_guards['license-verify'].remote_migration_version` khớp tiền tố phiên bản của tên file.

Ngoài ra test **"clean checkout phải có đủ migration bảo mật trước khi deploy Edge"** duyệt `required_migrations` và `existsSync` từng tên ⇒ tên trong manifest và file `.sql` phải vào **cùng một lô** (lô 1), nếu không lô 1 tự làm đỏ chính nó.

3.9 nói rõ: nếu thiết kế đổi tên event hay cấu trúc nhánh thì test này **được cập nhật trong cùng lô sửa**, không được xoá hoặc nới để cho xanh. Thiết kế đã chọn con đường không cần đổi tên, nên khoản này chỉ còn áp dụng cho phần assertion bổ sung.
