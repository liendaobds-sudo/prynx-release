# Implementation Plan: Mở khoá engine khuôn bế (`dieline-engine-unlock-fix`)

## Overview

**Mục tiêu duy nhất sau khi user chốt lại phạm vi: bản phát hành kế tiếp không bao giờ ship ở trạng thái engine khuôn bế không mở được.** Mục tiêu "khôi phục dịch vụ cho máy đang cài rc.9" đã bị bỏ khỏi spec. Không task nào còn tồn tại để cứu bản đang kẹt; mọi task chỉ phục vụ bản sau.

Sáu lô ở Design §I giữ nguyên **nội dung kỹ thuật**, nhưng đổi **thứ tự** thành `3 → 1 → 2 → 4 → 5`, và Lô 0 hạ từ chốt chặn xuống tùy chọn.

**Vì sao Lô 0 không còn là chốt chặn.** Mục đích duy nhất của Lô 0 là **định tuyến**: lô 1 bắt đầu từ §C (thiết kế lại cổng tốc độ) hay từ §E (dựng lại migration). Nhưng Design đã kết luận tường minh ở mục *Cân bằng bằng chứng*: **cả §C và §E đều bắt buộc theo 2.3 và 2.6, bất kể nhánh nào đúng.** Khi lô 1 làm cả hai thì nhánh nguyên nhân không quyết định điều gì trong phạm vi sửa nữa — nó chỉ còn quyết định "cái gì được tính là bằng chứng đã sửa xong", và bằng chứng đó nay do probe của Lô 3 cấp ở Mức 3. Lô 0 vì thế mất vai trò chốt chặn, được giữ lại như task `[TÙY CHỌN]` để người vận hành có bằng chứng hậu kiểm. **Nó không chặn lô nào.**

**Vì sao Lô 3 lên đầu.** Probe ở release gate là thứ **duy nhất** trực tiếp thoả mục tiêu mới: nó biến điều kiện ship từ "đã khoá engine" thành "đã khoá engine VÀ server mở được nó" (1.7, 2.7). Nó cũng nằm hoàn toàn trong repo `d:\pdfcompare` nên viết được ngay, không cần production, không cần chờ hai repo đồng bộ.

**Hệ quả vận hành — đọc trước khi vào Lô 3.** Sau khi Lô 3 vào, `build_production.ps1` sẽ **fail** cho tới khi phía server cấp được `rk` cho `app_version` của bản đang build. **Đó là mục đích của lô này, không phải tác dụng phụ.** Nhưng nó có nghĩa: Lô 1 và Lô 2 **vẫn bắt buộc**, và vẫn cần người vận hành áp migration lên production rồi deploy `license-verify`; không làm thì **không đóng gói được bản mới**. Có `-SkipDielineActivationProbe` cho chẩn đoán offline, nhưng `-Release` **không bao giờ** được dùng switch đó.

**Hai test đi trước bản vá.** Task 3 (khám phá bug condition, phải ĐỎ) và task 4 (baseline preservation, phải XANH) chạy trên code **chưa sửa**, nằm ngoài thân lô nhưng dùng ngân sách file của lô 1 và lô 4. Chúng đi trước bản vá tương ứng — task 3 trước Lô 1/Lô 2, task 4 trước Lô 2/Lô 4. Task 3 khoá vào **hợp đồng đích của Lô 2**, nên nó **không chặn task 2 (Lô 3)** và task 2 cũng không chặn nó.

**Mức bằng chứng.** Từ máy dev cao nhất là **Mức 2** (test tự động), vì build dev luôn nhúng payload plaintext nên C(X) không tái lập được. **Mức 3** (runtime) chỉ đạt ở máy phát hành + Supabase production, qua probe của Lô 3.

## Chia lô và ngân sách file

Thứ tự thi hành đọc từ trên xuống.

| Thứ tự | Lô | Task | Repo | File | Số file |
|---|---|---|---|---|---|
| — | 0 `[TÙY CHỌN]` | 1 | — | không ghi file | 0 |
| 1 | 3 | 2 | `d:\pdfcompare` | `build_production.ps1` (sửa), `scripts/release_secret_store.ps1` (sửa), `scripts/setup_release_probe_license.ps1` (mới), `scripts/dieline_activation_probe.py` (mới) | 4 |
| 2 | 1 | 3, 4, 5 | `d:\printsolutions-main` | `supabase/migrations/20260826120000_prynx_rk_grant_rebuild.sql` (mới), `supabase/migrations/security-manifest.json` (sửa), `src/dielineResourceKeyGate.test.ts` (mới) | 3 |
| 3 | 2 | 6 | `d:\printsolutions-main` | `supabase/functions/license-verify/index.ts` (sửa), `src/securityAuditRound2.test.ts` (sửa), `src/dielineResourceKeyGate.test.ts` (bổ sung) | 3 |
| 4 | 4 | 4, 7 | `d:\pdfcompare` | `native/src/dieline_engine.rs` (sửa), `native/src/lib.rs` (sửa), `backend/app/api/routes/dieline.py` (sửa), `backend/tests/test_dieline_engine_status.py` (mới) | 4 |
| 5 | 5 | 8 | `d:\pdfcompare` | `desktop/src/stores/licenseToken.ts` (sửa), `desktop/src/stores/useAuthStore.ts` (sửa), `desktop/src/components/dieline-tool/DielineTool.tsx` (sửa), `desktop/src/stores/licenseToken.test.ts` (sửa), `desktop/src/stores/useAuthStore.dielineKeyStatus.test.ts` (mới) | 5 |

Lệch nhỏ so với Design §I, cố ý: repo `d:\pdfcompare` đặt test store **cạnh file** (`licenseToken.test.ts`), không có thư mục `desktop/src/stores/__tests__`. Lô 5 theo quy ước đang có của repo.

## Quy ước đánh dấu

- `[TÙY CHỌN]` — không chặn lô nào, không phải điều kiện để đóng spec. Chạy được bất cứ lúc nào, kể cả sau khi đã sửa xong.
- `[VẬN HÀNH]` — **agent không được tự chạy**. Giao người vận hành, cần chốt xác nhận tường minh trước khi chạy.
- `[PROD]` — chạm Supabase production. Rủi ro cao. Luôn đi kèm `[VẬN HÀNH]`.
- `[GHI]` — có tác dụng phụ, đổi trạng thái đang đo.
- `*` — task test tách riêng (property test).
- Repo ghi ở mỗi task; `d:\pdfcompare` = app/native/backend/desktop, `d:\printsolutions-main` = Edge Function + migration + test bảo mật.

## Tasks

- [ ] 1. `[TÙY CHỌN]` Lô 0 — chẩn đoán nhánh nguyên nhân để hậu kiểm (không ghi file)
  - **Lô này không còn là chốt chặn và không chặn lô nào.** Lý do: mục đích duy nhất của nó là định tuyến lô 1 bắt đầu từ §C hay §E, nhưng Design đã kết luận cả §C (cổng tốc độ) và §E (dựng lại migration) đều **bắt buộc theo 2.3 và 2.6 bất kể nhánh nào đúng**. Lô 1 làm cả hai ⇒ nhánh không còn quyết định phạm vi sửa ⇒ Lô 0 mất vai trò chốt chặn
  - Giá trị còn lại: bằng chứng hậu kiểm cho người vận hành — biết **thật sự** nhánh nào đã xảy ra, để hồ sơ sự cố không dừng ở suy đoán và để phát hiện nhánh C (sự cố dữ liệu) nếu có
  - Sản phẩm của lô: một mục kết luận ghi vào báo cáo audit, nêu nhánh + bằng chứng + bước nào chưa đo được và vì sao
  - Bỏ được toàn bộ lô này mà không ảnh hưởng lô 1–5; khi bỏ thì task 9.3 phải ghi rõ nhánh nguyên nhân **chưa** xác định và vì sao điều đó không chặn mục tiêu
  - _Requirements: 1.2, 2.2_

  - [ ] 1.1 Xác nhận tầng client của C(X) — chỉ-đọc, cục bộ, không rủi ro
    - Đọc `DIELINE_LOCKED` trong release manifest của bản rc.9 đã cài (repo `d:\pdfcompare`)
    - Đối chiếu `version` giữa `desktop/package.json` và `desktop/src-tauri/tauri.conf.json` (repo `d:\pdfcompare`)
    - Đếm số phiên bản khác nhau trong 30 ngày: `git log --since=30.days -p -- desktop/src-tauri/tauri.conf.json` (repo `d:\pdfcompare`) — con số này là counterexample số học cho nhánh A
    - Xong khi: có ba con số ghi vào báo cáo. Hai chuỗi version lệch ⇒ nhánh C thắng, ghi lại và không cần đo production
    - _Requirements: 1.1, 2.2_

  - [ ] 1.2 Xác nhận token còn thiếu `rk` ở thời điểm đo — chỉ-đọc, cục bộ
    - Giải mã `%APPDATA%\PrynX\prynx_token.dat` trong bộ nhớ, in **tên** claim đã sắp xếp và độ dài; tuyệt đối không in giá trị claim nào
    - Không chạy trên máy khách nếu chưa được đồng ý
    - Xong khi: có danh sách tên claim. Nếu đã có `rk` ⇒ ghi rõ sự cố đã tự hết do server đổi trạng thái; phạm vi các lô còn lại **không đổi**, vì chúng chống tái diễn chứ không cứu máy đang kẹt
    - _Requirements: 1.1, 2.2, 3.5_

  - [ ] 1.3 `[VẬN HÀNH][PROD]` Phép đo nhánh — `security_logs` ngày 26/08
    - Truy vấn chỉ-đọc theo đặc tả chốt 0.3 của Design; agent chuẩn bị câu truy vấn, **người vận hành chạy**
    - **Bẫy phải nói trước khi đọc kết quả:** `logSecurityEvent` dedupe 5 phút theo `(event_type, ip)` / `(event_type, license_key)`. Sáu lần lỗi trong hai phút để lại **nhiều nhất một hàng**. Không kết luận "chỉ xảy ra một lần" từ số hàng, và không kết luận "không xảy ra" nếu cửa sổ tìm hẹp hơn 5 phút
    - Xong khi: có một trong bốn kết quả (`rk_cap_exceeded` / `rk_claim_failed_closed` / `rk_legacy_fallback` / rỗng) kèm `created_at` và `details`
    - _Requirements: 1.2, 1.4, 2.2_

  - [ ] 1.4 `[VẬN HÀNH][PROD]` RPC có trong schema cache không — chỉ chạy khi 1.3 ra `rk_claim_failed_closed`
    - `GET {SUPABASE_URL}/rest/v1/` với `apikey` service-role, User-Agent kiểu backend; tìm path `/rpc/claim_rk_grant` trong tài liệu OpenAPI
    - **CẤM:** không thăm dò bằng `POST /rest/v1/rpc/claim_rk_grant`. RPC đó **ghi** — gọi thử sẽ tiêu một suất cấp khoá của license thật và làm đổi chính trạng thái đang đo. Lệnh cấm này áp cho cả agent và script
    - Xong khi: kết luận B1 (không có path) hay B2 (có path, còn lệch chữ ký/quyền)
    - _Requirements: 1.5, 1.6, 2.2_

  - [ ] 1.5 `[VẬN HÀNH][PROD]` Trạng thái bảng khoá và cột `legacy_fallback`
    - `GET /rest/v1/release_resource_keys?select=app_version,legacy_fallback,revoked_at,created_at&...` theo chốt 0.5; **không** select `resource_key`
    - Xong khi: phân biệt được B3 (HTTP 400 / 42703), nhánh C (không có hàng cho rc.9, hoặc `revoked_at` đã set, hoặc nhiều hàng), hay `keyRowExists` được xác nhận
    - Ghi lại số hàng `legacy_fallback = true`. Lớn hơn 1 ⇒ mở hồ sơ điều tra riêng: fail-closed đã bị nới
    - _Requirements: 1.5, 1.6, 2.2, 3.9_

  - [ ] 1.6 Ghi nhận nhánh kết luận vào báo cáo
    - Ghi nhánh + bằng chứng + mức bằng chứng đạt được. **Kết luận này không đổi phạm vi hay thứ tự của lô nào** — đó là cả điểm của việc hạ Lô 0 xuống tùy chọn
    - **Nhánh A** (chạm trần) ⇒ ghi nhận rằng phần thật sự sinh ra bản vá trong lô 1 là `claim_rk_grant_v2` với luật tốc độ; phần `create table … if not exists` / `add column if not exists` chỉ là hội tụ schema
    - **Nhánh B (B1/B2)** ⇒ ghi nhận rằng phần thật sự sinh ra bản vá là dựng lại đủ object; luật tốc độ vẫn cần vì trần cũ vẫn sai bản chất
    - **Nhánh B3** ⇒ ghi nhận cột `legacy_fallback` là mắt vỡ thật; đổi ngưỡng là vô nghĩa khi mọi `select` đều lỗi
    - **Nhánh C** ⇒ **mở việc riêng ngoài spec này**: thiếu hàng khoá hoặc nhiều hàng khoá cho cùng bản là **sự cố dữ liệu**, không bản vá code nào sửa được. Lô 1 vẫn chạy vì unique index `(product_id, app_version, resource)` là thứ ngăn nó tái diễn
    - **Bất biến không đảo được theo nhánh nào:** bundle của lô 2 gọi `claim_rk_grant_v2`, nên object của lô 1 phải tồn tại trên production **trước** khi deploy lô 2. Deploy ngược thứ tự sẽ đẩy mọi request vào fail-closed `rk` cho toàn bộ khách hàng
    - _Requirements: 1.2, 2.2, 3.12_

- [ ] 2. Lô 3 — probe kích hoạt ở release gate (repo `d:\pdfcompare`)
  - **Đi đầu, không phụ thuộc lô nào.** Chặng 2 của probe tự đủ và chạy được với bundle Edge đang chạy trên production **hôm nay** — không cần server đổi gì. Chặng 1 dung thứ phiên bản nên cũng không cần lô 2
  - Đây là thứ đã thiếu khi rc.9 ship: điều kiện ship trước đây chỉ là "binary đã mã hoá", không phải "có ai mở được nó"
  - **Cảnh báo vận hành:** từ lúc lô này vào, `build_production.ps1` fail cho tới khi server cấp được `rk` cho `app_version` đang build. Đó là mục đích. Hệ quả: lô 1 và lô 2 vẫn bắt buộc, và vẫn cần người vận hành áp migration + deploy Edge, nếu không thì không đóng gói được bản mới

  - [ ] 2.1 Viết `scripts/dieline_activation_probe.py`
    - Chặng 2 theo Design §F: gọi `pdfcompare_native.generate_dieline_json` trên wheel đã staged với fixture `native/tests/fixtures/dieline_default_request.json`, khẳng định `dieline.panels` không rỗng
    - **Chặng 2 là chốt bắt buộc và tự đủ:** lấy token thật từ `license-verify` rồi chạy engine trên wheel đã staged. Phép này **không cần server đổi gì** — nếu server không cấp `rk` thì `authorize_dieline` trả `resource_key = None`, `engine_source()` ném, lệnh fail ⇒ build dừng. Không có cách nào nó đạt mà `rk` sai hoặc thiếu
    - Nhận token / license key / machine_id **qua biến môi trường**, không qua argv (argv của process khác đọc được bằng WMI trên Windows)
    - In đúng một dòng trạng thái dạng `dieline_activation_probe=ok claims=… panels=… rk_len=32`: chỉ **tên** claim đã sắp xếp, số panel, độ dài khoá. Không token, không license key, không `rk`, không hash license
    - Exit code khác 0 khi bất kỳ khẳng định nào fail
    - Xong khi: `python -m py_compile scripts/dieline_activation_probe.py` sạch và task 2.4 xanh
    - _Requirements: 2.7, 3.5_

  - [ ] 2.2 Nối probe vào `build_production.ps1`
    - Đặt trong Step 1a: sau cổng capability của wheel đã staged, **trước** `$script:DIELINE_LOCKED = …` và `Remove-Item Env:PRYNX_DIELINE_KEY_B64`
    - **Chặng 1 — kiểm bổ trợ, dung thứ phiên bản.** POST `license-verify` bằng **anon key công khai** (`verify_jwt = true`); probe không nhận secret `sb_secret_`. Khẳng định: `status = 'VALID'`, **và** token trả về **có tên claim `rk`** (đọc được ngay hôm nay, không cần trường mới nào). Nếu phản hồi **có** trường `rk_status` ⇒ thêm khẳng định `rk_status = 'granted'`; nếu **không có** (bundle Edge chưa lên lô 2) ⇒ **bỏ qua khẳng định đó, không fail**
    - **Ghi chú thiết kế phải đặt tại chỗ trong script:** đây là **dung thứ có chủ đích** cho cửa sổ lệch phiên bản giữa hai repo (Edge Function deploy độc lập với installer), **không phải nới lỏng cổng**. Cổng thật là chặng 2 — nó không dung thứ gì. Sau khi lô 2 deploy, chặng 1 **tự siết chặt thêm** mà không phải sửa probe
    - `machine_id` cố định dành riêng cho probe; probe **không** ghi gì vào `release_resource_keys`
    - Chính sách fail: `-Release` ⇒ throw; build nội bộ mặc định cũng throw, có `-SkipDielineActivationProbe` cho chẩn đoán offline; build plaintext bỏ qua probe
    - Manifest ghi `DIELINE_ACTIVATION_PROBE = ok | skipped | plaintext` cạnh `DIELINE_LOCKED`; public release từ chối mọi giá trị khác `ok`
    - Dọn trong `finally`: xoá file script tạm ở `$env:TEMP` và `Remove-Item Env:PRYNX_PROBE_*`
    - Không đặt `[profile.release]` vào Cargo.toml ở bất kỳ bước nào
    - Xong khi: script parse sạch, task 2.4 xanh
    - _Requirements: 1.7, 2.7, 3.5, 3.7_

  - [ ] 2.3 Thêm nguồn license TEST vào kho DPAPI
    - `scripts/release_secret_store.ps1`: thêm `Get-PrynXReleaseProbeLicense` đọc **file kho riêng** `…\PrynX\ReleaseSecrets\probe.clixml`; không thêm field vào kho hiện tại (`Get-PrynXReleaseSupabaseSecret` từ chối nạp khi `SchemaVersion` khác 1)
    - `scripts/setup_release_probe_license.ps1` (mới): nhập license TEST vào kho DPAPI CurrentUser, không echo giá trị, không ghi ra log
    - Xong khi: hai script parse sạch; chạy thật trên máy phát hành thuộc task 2.5
    - _Requirements: 2.7, 3.5_

  - [ ]* 2.4 Viết test tĩnh chống rò bí mật cho lô 3
    - **Property 4: No-Secret-Leak** - Không giá trị bí mật nào rời khỏi vùng cho phép
    - **Validates: Requirements 2.7, 3.5**
    - Khẳng định trên nội dung file: probe không nhận secret qua argv; không có `Write-Host`/`print` nào in biến chứa token, license key hay `rk`; có `finally` xoá file tạm và biến môi trường; `build_production.ps1` vẫn `Remove-Item Env:PRYNX_DIELINE_KEY_B64` trước Nuitka/Tauri/NSIS
    - Khẳng định riêng cho dung thứ phiên bản: chặng 1 **có** kiểm `status = 'VALID'` và **có** kiểm tên claim `rk`; khẳng định `rk_status` nằm sau một điều kiện "trường có tồn tại" chứ không phải điều kiện vô điều kiện — để không ai vô tình siết nó thành hard-fail trước khi lô 2 deploy, và cũng để không ai nới chặng 2
    - **Property 2: Preservation** — khẳng định khối `Step 1a-pre` giữ nguyên hành vi khoá bất biến theo bản: gặp hàng có sẵn thì dùng lại, nhiều hàng thì throw, và probe không thêm đường ghi nào vào `release_resource_keys`
    - Xong khi: test/kiểm tĩnh xanh
    - _Requirements: 3.5, 3.7_

  - [ ] 2.5 `[VẬN HÀNH][PROD][GHI]` Chạy probe thật trên máy phát hành
    - **Agent không chạy task này.** Cần kho DPAPI phát hành, license TEST, mạng, và một wheel đã khoá
    - Tác dụng phụ phải nói trước: gọi `license-verify` trên production bằng license TEST ⇒ tiêu **một** suất activation vĩnh viễn cho `machine_id` cố định của probe, tiêu một suất cấp khoá cho cặp `(license TEST, app_version)`, có thể chèn `security_logs`. Không bao giờ dùng license khách
    - Chạy `powershell build_production.ps1` trên máy phát hành, chỉ khi người dùng yêu cầu
    - Đây là **fix check ở Mức 3** duy nhất: `license-verify` → token → `generate_dieline_json` trên wheel staged → `dieline.panels` không rỗng
    - Nếu chạy **trước** khi lô 1+2 lên production: kết quả mong đợi là **fail ở chặng 1 hoặc chặng 2**, và đó là bằng chứng cổng hoạt động đúng — không phải lý do để nới probe. Ghi lại rồi đi tiếp lô 1
    - Xong khi: manifest ghi `DIELINE_ACTIVATION_PROBE = ok`, dòng trạng thái probe không chứa giá trị bí mật nào
    - _Requirements: 2.1, 2.7_

  - [ ] 2.6 Verify lô 3
    - Chạy được từ máy dev: `python -m py_compile scripts\dieline_activation_probe.py`; parse tĩnh hai file `.ps1` bằng `[System.Management.Automation.Language.Parser]::ParseFile` (không thực thi, không tác dụng phụ); test tĩnh của task 2.4
    - Không chạy được từ máy dev, ghi rõ vào báo cáo: probe đầy đủ cần kho DPAPI phát hành + license TEST + mạng + wheel đã khoá ⇒ chỉ máy phát hành; `build_production.ps1` chỉ chạy khi user yêu cầu; C(X) end-to-end cần artifact đã đóng gói nên máy dev dừng ở **Mức 2**
    - Ghi thêm một proof gap riêng của lô này: trước khi lô 2 deploy, khẳng định `rk_status = 'granted'` **chưa** được thực thi ở chặng 1 (trường chưa tồn tại). Độ phủ trong cửa sổ đó do chặng 2 gánh toàn bộ
    - Xong khi: kết quả dán vào báo cáo, proof gap ghi lại
    - _Requirements: 3.11_

- [ ] 3. Viết test khám phá bug condition (TRƯỚC bản vá server ở lô 1 và lô 2)
  - **Property 1: Bug Condition** - License hợp lệ trên bản đã khoá phải nhận được khoá engine
  - **Validates: Requirements 2.1, 2.3, 2.7**
  - **QUAN TRỌNG:** test này phải ĐỎ trên code chưa sửa; đỏ là bằng chứng bug tồn tại. **Không sửa test, không sửa code khi nó đỏ.**
  - **MỤC TIÊU:** dựng danh sách counterexample ở Mức 2 mà không cần chạm production
  - **Vị trí trong thứ tự:** test này khoá vào **hợp đồng đích của lô 2**, nên nó đi trước lô 1 và lô 2. Nó **không chặn task 2 (lô 3)** và task 2 cũng không chặn nó — hai mũi độc lập, khác repo
  - **Phạm vi PBT thu hẹp:** bug tất định nên khoá vào ca cụ thể `app_version = 1.0.0-rc.9`, `plan = pro`, hàng khoá tồn tại — không sinh ngẫu nhiên
  - File: `d:\printsolutions-main\src\dielineResourceKeyGate.test.ts` (mới, thuộc ngân sách lô 1) — test tĩnh trên nội dung file, vì máy không có `deno` để chạy thật bundle Edge
  - Nội dung assertion (viết theo hợp đồng ĐÍCH, nên đỏ hết trên code chưa sửa): bundle `supabase/functions/license-verify/index.ts` tham chiếu `claim_rk_grant_v2`; bundle không còn dùng `RK_VERSION_CAP`/`RK_WINDOW_DAYS` làm điều kiện chặn; bundle có đủ 7 giá trị `rk_status`; nhánh `rkAllowed === true` mà `lookupResourceKey` trả null có ghi `rk_key_row_missing`; `security-manifest.json` có `20260826120000_prynx_rk_grant_rebuild.sql` trong `required_migrations` và `deployment_guards['license-verify'].remote_migration_version = '20260826120000'`; tồn tại file `.sql` trong `supabase/migrations` định nghĩa `claim_rk_grant`
  - Chạy: `npm run test:run -- src/dielineResourceKeyGate.test.ts` (repo `d:\printsolutions-main`, **chỉ Windows thật**)
  - **KẾT QUẢ MONG ĐỢI: ĐỎ.** Ghi lại từng assertion đỏ thành một counterexample có tên
  - Counterexample số học đi kèm: chạy `git log --since=30.days -p -- desktop/src-tauri/tauri.conf.json` (repo `d:\pdfcompare`) và so số phiên bản khác nhau với trần 5. Lệnh này chỉ-đọc, cục bộ, **không** phụ thuộc task 1.1 — Lô 0 đã hạ xuống tùy chọn nên task này phải tự lấy con số
  - Xong khi: test đã viết, đã chạy, danh sách counterexample đã ghi vào báo cáo
  - _Requirements: 1.3, 1.4, 1.5, 1.6_

- [ ]* 4. Viết test preservation theo lối quan sát-trước (TRƯỚC bản vá ở lô 2 và lô 4)
  - **Property 2: Preservation** - Mọi input ngoài bug condition giữ nguyên hành vi
  - **Validates: Requirements 3.1, 3.2, 3.3, 3.6, 3.7, 3.8, 3.10**
  - **QUAN TRỌNG:** quan sát hành vi trên code **chưa sửa** rồi mới viết kỳ vọng. Không suy kỳ vọng từ đọc code — chính lối suy đó đã tạo ra bug này
  - Phần Rust (repo `d:\pdfcompare`, `native/src/dieline_engine.rs`, chỉ thêm trong `#[cfg(test)] mod tests`, thuộc ngân sách lô 4): mở rộng khuôn mẫu `locked_payload_needs_the_right_key` thành vòng lặp có seed cố định ≥100 vòng — khoá đúng luôn mở được; đảo bất kỳ một bit của khoá luôn bị từ chối; AAD (version) khác luôn bị từ chối; `None` luôn bị từ chối. Dùng LCG/xorshift trong test, **không** thêm dependency vào `native/Cargo.toml`
  - Phần bảng quyết định cổng cấp khoá (repo `d:\printsolutions-main`, cùng file `src/dielineResourceKeyGate.test.ts`): dựng mirror thuần của bảng quyết định `plan × features × app_version × trạng thái RPC × trạng thái hàng khoá` và **duyệt vét cạn** miền hữu hạn này (không lấy mẫu ngẫu nhiên: repo printsolutions không có `fast-check`, thêm dependency là ngoài phạm vi lô). Ghi kỳ vọng đúng như bundle **chưa sửa** quyết định, kèm assertion tĩnh ghim mirror vào các nhánh literal đang có trong bundle
  - Baseline không cần viết mới, chỉ chạy và ghi số: `backend\venv\Scripts\python -m pytest tests\test_dieline_error_classification.py` (repo `d:\pdfcompare`) và `cd native && cargo test` **không** đặt `PRYNX_DIELINE_KEY_B64` (`payload_kind_matches_build_env` xanh = build plaintext vẫn nạp engine không cần `rk`)
  - **KẾT QUẢ MONG ĐỢI: XANH trên code chưa sửa.** Đây là baseline để so sau khi sửa
  - Xong khi: test đã viết, đã chạy xanh, các ô quan sát được đã ghi lại
  - _Requirements: 3.1, 3.2, 3.3, 3.6, 3.8_

- [ ] 5. Lô 1 — migration dựng lại + đăng ký manifest (repo `d:\printsolutions-main`)
  - **Không chờ Lô 0.** Lô này làm đủ cả §C (cổng tốc độ trong `claim_rk_grant_v2`) và §E (hội tụ schema + dựng lại RPC) trong cùng một file migration, vì cả hai bắt buộc theo 2.3 và 2.6 bất kể nhánh nào đúng
  - Cần task 3 đỏ và task 4 xanh trước: không sửa trước khi có test đỏ đúng chỗ và baseline xanh

  - [ ] 5.1 Viết `supabase/migrations/20260826120000_prynx_rk_grant_rebuild.sql`
    - Header ghi rõ file này thay thế hai migration đã mất khỏi repo (`20260726090000_release_resource_keys.sql`, `20260726140000_prynx_rk_grant_cap.sql`) và sẽ không dựng lại nguyên bản
    - Hội tụ schema idempotent cho `release_resource_keys` và `prynx_rk_grants` theo bảng cột trong Design §E; unique index `(product_id, app_version, resource)` và unique trên `resource_key`
    - `drop function if exists` theo **đúng chữ ký** `claim_rk_grant(text, text, text, integer, integer)` trước khi tạo lại; giữ v1 làm lớp mỏng; thêm `claim_rk_grant_v2` với tham số mới; cả hai `security definer` + `set search_path` + `revoke execute`/`grant execute`; kết file `notify pgrst, 'reload schema';`
    - **KHÔNG backfill `legacy_fallback = true`.** Chạy lại backfill 30/07 sẽ đánh legacy cho toàn bộ hàng rc.4→rc.9 và mở lại đúng nhánh fail-open mà 30/07 đã đóng. Đặt chú thích cảnh báo ngay tại dòng `add column if not exists legacy_fallback`
    - Không `drop table`, không `truncate`, không `alter column … type`, không `update … resource_key`
    - `license_hash` là SHA-256 hex; không bao giờ lưu license key thô
    - Xong khi: file tồn tại, đọc lại thấy đủ các ràng buộc trên, task 5.3 xanh
    - _Requirements: 2.3, 2.5, 2.6, 3.5, 3.7, 3.9_

  - [ ] 5.2 Đăng ký vào `supabase/migrations/security-manifest.json`
    - Thêm `20260826120000_prynx_rk_grant_rebuild.sql` vào `required_migrations`; `deployment_guards["license-verify"].remote_migration_version = "20260826120000"` + cập nhật `reason`; `audit` bump `2026-08-26`; `edge_after_migrations` không đổi
    - **Tên trong manifest và file `.sql` phải cùng lô này**: test "clean checkout phải có đủ migration bảo mật trước khi deploy Edge" duyệt `required_migrations` rồi `existsSync` từng tên — lệch lô là lô 1 tự làm đỏ chính nó
    - Hai migration đã mất **không** đăng ký (file không tồn tại ⇒ test đỏ); vết của chúng nằm ở header task 5.1
    - Xong khi: `npm run test:run -- src/securityAuditRound2.test.ts` xanh ở test clean-checkout
    - _Requirements: 1.6, 2.6_

  - [ ]* 5.3 Viết test tĩnh cho migration
    - **Property 3: Fail-closed** - Cổng khoá tài nguyên không bao giờ mở khi hạ tầng lỗi
    - **Property 4: No-Secret-Leak** - Không giá trị bí mật nào rời khỏi vùng cho phép
    - **Validates: Requirements 2.4, 2.5, 3.5, 3.9**
    - File: `src/dielineResourceKeyGate.test.ts` (bổ sung vào file của task 3)
    - Property 3: file `.sql` có `if not exists` cho mọi lệnh tạo; **không** chứa `drop table` / `truncate` / `update … resource_key`; **không** chứa lệnh gán `legacy_fallback = true`; có `security definer` + `set search_path`; có `revoke execute … from public, anon, authenticated` và `grant execute … to service_role`; có `pg_advisory_xact_lock`
    - Property 4: file `.sql` không chứa cột nào lưu license key thô; sổ cấp chỉ có `license_hash`
    - Xong khi: `npm run test:run -- src/dielineResourceKeyGate.test.ts` — nhóm assertion migration xanh (nhóm assertion bundle của task 3 vẫn đỏ tới hết lô 2, đúng như thiết kế)
    - _Requirements: 2.5, 3.5, 3.7, 3.9_

  - [ ] 5.4 `[VẬN HÀNH][PROD][GHI]` Áp migration lên production rồi xác minh chỉ-đọc
    - **Agent không chạy task này.** Agent chỉ giao file `.sql` + ba lệnh xác minh chỉ-đọc 1–3 của Design §E ở dạng sẵn dùng
    - Thứ tự bắt buộc: áp migration → xác minh 1 (OpenAPI có **cả** `/rpc/claim_rk_grant` và `/rpc/claim_rk_grant_v2`) → xác minh 2 (`release_resource_keys` HTTP 200, số hàng `legacy_fallback = true` **vẫn bằng 1**) → xác minh 3 (`prynx_rk_grants` HTTP 200, rỗng là đúng)
    - Xác minh 2 là chốt chống hồi quy fail-open: lớn hơn 1 ⇒ dừng, không sang lô 2, mở điều tra
    - Xong khi: cả ba xác minh đạt và được ghi lại. Thiếu bất kỳ mục nào ⇒ **không deploy lô 2**
    - _Requirements: 2.2, 2.6, 3.9_

  - [ ] 5.5 Verify lô 1
    - Chạy được từ máy dev: `npm run test:run -- src/dielineResourceKeyGate.test.ts src/securityAuditRound2.test.ts` (repo `d:\printsolutions-main`) — **chỉ Windows thật**, `node_modules` chứa binary Windows
    - Không chạy được từ máy dev, ghi rõ vào báo cáo: (a) áp migration và ba bước xác minh — cần secret service-role, là hành động rủi ro cao, người vận hành thực hiện; (b) không có `psql`/Supabase CLI trong PATH nên **không** kiểm được cú pháp SQL bằng cách thực thi, độ phủ hiện có chỉ là test tĩnh trên nội dung file; (c) C(X) không tái lập được trên máy dev vì build dev luôn plaintext ⇒ mức bằng chứng cao nhất của lô này là **Mức 2**
    - Xong khi: kết quả test đã dán vào báo cáo, danh sách proof gap đã ghi, task 5.4 đã đạt
    - _Requirements: 3.11_

- [ ] 6. Lô 2 — Edge Function + test (repo `d:\printsolutions-main`)
  - Chỉ bắt đầu sau khi task 5.4 đạt: bundle mới gọi `claim_rk_grant_v2`, object phải tồn tại trước
  - Lô này là điều kiện để `build_production.ps1` (đã có probe từ lô 3) đóng gói được bản mới

  - [ ] 6.1 Sửa `supabase/functions/license-verify/index.ts`
    - Thêm trường `rk_status` (7 giá trị enum theo Design §D) **chỉ** ở nhánh `result.status === 'VALID'`; không đưa `rk_status` vào token
    - Gọi `claim_rk_grant_v2` với cửa sổ/ngưỡng của luật tốc độ; bỏ `RK_VERSION_CAP`/`RK_WINDOW_DAYS` khỏi vai trò điều kiện chặn
    - Thêm `logSecurityEvent` với `event_type: 'rk_key_row_missing'` ở nhánh `rkAllowed === true` mà `lookupResourceKey` trả null — bịt điểm mù nhánh C
    - Giữ **nguyên byte-for-byte** ba mệnh đề bị đóng băng bởi `src/securityAuditRound2.test.ts` dòng 36–42: `query = query.eq('legacy_fallback', true)`, biểu thức ternary `event_type: resourceKey ? 'rk_legacy_fallback' : 'rk_claim_failed_closed'`, và việc bundle **không** chứa `claim_rk_grant failed (fail-open)`
    - Giữ nguyên tên ba event cũ (`rk_cap_exceeded`, `rk_legacy_fallback`, `rk_claim_failed_closed`); danh tính luật mới đặt trong `details`
    - `rk_status` không chứa giá trị khoá, license key thô, hash license, bộ đếm hay ngưỡng
    - Xong khi: task 3 chuyển từ đỏ sang xanh, task 6.2 và 6.3 xanh
    - _Requirements: 2.3, 2.4, 2.5_

  - [ ] 6.2 Bổ sung assertion vào `src/securityAuditRound2.test.ts`
    - **Property 3: Fail-closed** - Cổng khoá tài nguyên không bao giờ mở khi hạ tầng lỗi
    - **Validates: Requirements 2.4, 2.5, 3.9**
    - **Chỉ bổ sung `expect` mới. Ba literal ở dòng 36–42 giữ nguyên byte-for-byte, không sửa, không nới, không xoá**
    - Thêm: bundle gọi `claim_rk_grant_v2`; bundle không dùng `RK_VERSION_CAP`/`RK_WINDOW_DAYS` làm điều kiện chặn; bundle có đủ 7 giá trị `rk_status`; nhánh null của `lookupResourceKey` khi `rkAllowed === true` có ghi `rk_key_row_missing`; migration mới có trong `required_migrations` và `remote_migration_version` khớp tiền tố phiên bản của tên file
    - Xong khi: `npm run test:run -- src/securityAuditRound2.test.ts` xanh toàn file, kể cả 5 test cũ
    - _Requirements: 2.4, 2.6, 3.9, 3.10_

  - [ ]* 6.3 Cập nhật bảng quyết định preservation sang trạng thái sau vá
    - **Property 2: Preservation** - Mọi input ngoài bug condition giữ nguyên hành vi
    - **Validates: Requirements 3.3, 3.6, 3.10**
    - File: `src/dielineResourceKeyGate.test.ts`
    - Duyệt vét cạn miền hữu hạn của task 4 và khẳng định: `rk` chỉ xuất hiện đúng những ô mà bản gốc **cũng** cấp, **cộng** đúng các ô mà bản gốc từ chối **chỉ vì** trần 5 bản/30 ngày. Mọi ô khác giữ nguyên kết quả baseline
    - Khẳng định riêng: `plan = free`/thiếu `packaging.dieline` ⇒ `not_entitled`; không gửi `app_version` ⇒ `not_requested` và hình dạng token không đổi; RPC lỗi + hàng không legacy ⇒ `infra_unavailable` và **không** có `rk`
    - **Property 4: No-Secret-Leak** — với mọi phản hồi sinh ra từ bảng, chuỗi JSON không chứa giá trị khoá, license key thô hay hash license
    - Thêm property idempotence luật tốc độ: N lần xin khoá cho **cùng** `(license, app_version)` trong cửa sổ ⇒ số bản distinct luôn là 1, không lần nào bị từ chối (chống bẫy heartbeat 5 phút tự đốt hạn mức)
    - Xong khi: file xanh toàn bộ, kể cả nhóm assertion của task 3
    - _Requirements: 2.3, 3.3, 3.5, 3.6, 3.10_

  - [ ] 6.4 Xác nhận test khám phá task 3 đã xanh
    - **Property 1: Expected Behavior** - License hợp lệ trên bản đã khoá phải nhận được khoá engine
    - **QUAN TRỌNG:** chạy lại **đúng** test của task 3, không viết test mới
    - `npm run test:run -- src/dielineResourceKeyGate.test.ts` (repo `d:\printsolutions-main`)
    - **KẾT QUẢ MONG ĐỢI: XANH** — mọi counterexample ghi ở task 3 đã hết. Ghi rõ đây là fix check ở **Mức 2**; Mức 3 do probe lô 3 (task 2.5) đảm nhiệm
    - _Requirements: 2.1, 2.3, 2.6_

  - [ ] 6.5 `[VẬN HÀNH][PROD][GHI]` Deploy `license-verify`
    - **Agent không chạy task này.** Máy dev không có `deno` lẫn Supabase CLI trong PATH
    - Điều kiện tiên quyết: task 5.4 đã đạt cả ba xác minh. Deploy bằng Supabase CLI **2.110.0** đã pin checksum
    - Kiểm thứ tự rollout **chỉ trên staging, không bao giờ trên production**: deploy bundle trước migration để xác nhận nó fail-closed đúng cách (`rk_status = 'infra_unavailable'`, token vẫn cấp, không crash), rồi áp migration và xác nhận chuyển sang `granted`. Đây là bài kiểm cho chính rủi ro đảo thứ tự; bỏ qua được nếu không có staging, khi đó ghi thành proof gap
    - Xong khi: deploy xong, một lần gọi thật bằng license TEST trả `rk_status = 'granted'` (chỉ ghi trạng thái, không ghi giá trị)
    - Sau task này, chặng 1 của probe lô 3 **tự siết chặt** thêm khẳng định `rk_status = 'granted'` mà không cần sửa `scripts/dieline_activation_probe.py` hay `build_production.ps1`
    - _Requirements: 2.1, 2.2, 2.6_

  - [ ] 6.6 Verify lô 2
    - Chạy được từ máy dev (**chỉ Windows thật**): `npm run test:run -- src/securityAuditRound2.test.ts src/dielineResourceKeyGate.test.ts`, `npm run typecheck` (repo `d:\printsolutions-main`)
    - Không chạy được từ máy dev, ghi rõ: (a) **Deno typecheck cho bundle Edge** — không có `deno` trong PATH, `tsconfig.app.json` chỉ phủ `src/` chứ không phủ `supabase/functions`, nên độ phủ bundle là **test tĩnh trên nội dung file**, không phải typecheck; chốt runtime duy nhất là deploy staging; (b) deploy Edge và mọi truy vấn production — người vận hành; (c) mức bằng chứng từ máy dev vẫn là **Mức 2**
    - Xong khi: kết quả dán vào báo cáo, proof gap ghi lại, task 6.4 xanh
    - _Requirements: 3.11_

- [ ] 7. Lô 4 — trạng thái engine: native + backend (repo `d:\pdfcompare`)
  - Cần task 4 (baseline preservation phần Rust) xanh trước khi sửa `native/src/dieline_engine.rs`

  - [ ] 7.1 Thêm `dieline_engine_status` vào native
    - `native/src/dieline_engine.rs`: hàm trả `{ locked, payload_version }` tính **chỉ** từ `split_payload()` — không nhận khoá, không giải mã, không thể fail trên build đã khoá
    - `warm_dieline_engine` / `warm_engine` **không đổi**: vẫn `return Ok(())` ngay khi `engine_is_locked()`
    - `native/src/lib.rs`: đăng ký pyfunction cạnh hai pyfunction dieline hiện có
    - Không thêm chuỗi lỗi mới — hai test tự trích literal ở `backend/tests/test_dieline_error_classification.py` (19 + 6 chuỗi) phải xanh **mà không cần sửa**; nếu đỏ, đó là tín hiệu đã thêm thông điệp lỗi ngoài dự kiến
    - Xong khi: `cd native && cargo test` xanh cả hai lượt (không khoá; có khoá dùng một lần qua `PRYNX_DIELINE_KEY_B64`)
    - _Requirements: 1.8, 2.8, 3.2_

  - [ ] 7.2 Thêm test Rust cho hàm trạng thái
    - **Property 2: Preservation** - Mọi input ngoài bug condition giữ nguyên hành vi
    - **Validates: Requirements 3.2**
    - `dieline_engine_status()` trả `locked = true` trên payload đã khoá, `false` trên plaintext, và **không ném** ở cả hai trường hợp; `warm_engine()` vẫn no-op trên payload đã khoá
    - Chạy lại property test crypto của task 4 để xác nhận không hồi quy
    - Xong khi: `cargo test` xanh cả hai lượt, không warning mới thuộc code vừa thêm
    - _Requirements: 3.1, 3.2_

  - [ ] 7.3 Thêm `GET /api/dieline/engine-status` vào backend
    - `backend/app/api/routes/dieline.py`: trả `{ locked, license_key_present }`, luôn 200, không bao giờ 403 vì lý do khoá; đặt **cùng router** để vẫn thừa hưởng `require_feature`
    - `license_key_present` phản ánh token **của chính request này** có `rk` hay không — chỉ trạng thái có/không, không bao giờ giá trị
    - `_classify_native_failure()` **không đổi**
    - Nếu chạm PDFium trong thread thì bọc `pdfium_guard()`; endpoint này không cần, nêu ở đây để không bỏ sót khi sửa file
    - Xong khi: task 7.4 xanh
    - _Requirements: 2.8, 3.3, 3.8_

  - [ ] 7.4 Viết `backend/tests/test_dieline_engine_status.py`
    - **Property 4: No-Secret-Leak** - Không giá trị bí mật nào rời khỏi vùng cho phép
    - **Validates: Requirements 2.8, 3.5**
    - 200 kèm `locked`/`license_key_present` đúng cho ba ca: token có `rk`, token không `rk`, không token; vẫn bị `require_feature` từ chối với license Free
    - Body phản hồi không chứa giá trị `rk`, token hay license key — chỉ boolean
    - Test phải chạy được khi native chưa rebuild (monkeypatch lời gọi native), để không buộc `maturin develop --release` mỗi lần chạy suite
    - **Property 2: Preservation** — warmup vẫn im lặng: trên payload đã khoá, `warm_dieline_engine()` trả Ok và không ghi dòng nào chứa `Dieline engine` vào log
    - Xong khi: `backend\venv\Scripts\python -m pytest tests\test_dieline_engine_status.py tests\test_dieline_error_classification.py` xanh
    - _Requirements: 1.8, 2.8, 3.5, 3.8_

  - [ ] 7.5 Verify lô 4
    - Chạy được từ máy dev: `cd native && cargo test` (hai lượt: không khoá, và có khoá dùng một lần qua `PRYNX_DIELINE_KEY_B64`); `backend\venv\Scripts\python -m pytest tests` (so số test với baseline 3373 trước lô)
    - Không chạy được từ máy dev, ghi rõ: đường đi thật của endpoint trên artifact đã khoá cần wheel đã staged ⇒ chỉ máy phát hành; C(X) không tái lập được trên máy dev vì build dev luôn plaintext ⇒ **Mức 2**
    - Xong khi: kết quả dán vào báo cáo; hai test tự trích chuỗi literal xanh mà không phải sửa
    - _Requirements: 3.8, 3.11_

- [ ] 8. Lô 5 — phát hiện sớm phía client (repo `d:\pdfcompare`)
  - Sau lô 2 (đọc `rk_status`) và sau lô 4 (gọi endpoint trạng thái)

  - [ ] 8.1 Thêm `hasResourceKey` vào `desktop/src/stores/licenseToken.ts`
    - `LicenseTokenClaims.hasResourceKey: boolean` tính bằng `typeof raw.rk === 'string' && raw.rk.length > 0`
    - **Chỉ trạng thái có/không.** Module này đang cố ý không expose `rk`; giữ nguyên ranh giới đó
    - Xong khi: task 8.4 xanh
    - _Requirements: 2.8, 3.5_

  - [ ] 8.2 Thêm `dielineKeyStatus` vào `desktop/src/stores/useAuthStore.ts`
    - Gán từ `response.rk_status` ở **mọi** nhánh của `validateLicense`; các nhánh không có câu trả lời mới từ server (lỗi mạng, `RATE_LIMITED`, offline-grace theo `exp`) gán `'unknown'`
    - Bundle Edge chưa lên lô 2 thì không có trường `rk_status` ⇒ cũng gán `'unknown'`, không crash, không banner sai
    - `saveTokenToDPAPI` và `ensureKeyRegisteredInRust` **không đổi**
    - Xong khi: task 8.4 xanh
    - _Requirements: 2.4, 2.8_

  - [ ] 8.3 Thêm banner không chặn vào `desktop/src/components/dieline-tool/DielineTool.tsx`
    - Gọi endpoint trạng thái **một lần mỗi phiên** khi mở công cụ, không phải lúc khởi động app
    - `locked && !license_key_present` ⇒ banner cố định phía trên panel tham số, **không chặn** panel; hai hành động: "Kiểm tra lại bản quyền" (gọi `validateLicense()`) và "Liên hệ hỗ trợ" (copy `APP_VERSION` + `dielineKeyStatus`, không secret)
    - Toast 403 giữ nguyên làm đường cuối
    - Text UI tiếng Việt, thuật ngữ ngành in; gắn tag truy vết `UIUX (audit 2026-08-26 dieline-engine-unlock)`
    - Xong khi: task 8.4 và 8.5 xanh
    - _Requirements: 1.8, 2.8_

  - [ ]* 8.4 Viết test cho tầng client
    - **Property 4: No-Secret-Leak** - Không giá trị bí mật nào rời khỏi vùng cho phép
    - **Validates: Requirements 2.8, 3.5**
    - `desktop/src/stores/licenseToken.test.ts` (bổ sung): `readLicenseTokenClaims` trả `hasResourceKey` đúng cho token có/không `rk`, và **không** để lộ trường giá trị nào; dùng `fast-check` (đã có trong `desktop/package.json`) sinh payload token ngẫu nhiên, ≥100 vòng, khẳng định không khoá nào rò ra object trả về
    - `desktop/src/stores/useAuthStore.dielineKeyStatus.test.ts` (mới): `validateLicense` gán `dielineKeyStatus` đúng cho từng `rk_status`, gán `'unknown'` ở nhánh lỗi mạng / `RATE_LIMITED` / offline-grace, và gán `'unknown'` khi phản hồi **không có** trường `rk_status`
    - Đây là **toàn bộ** độ phủ cho đường banner: trạng thái `locked && !license_key_present` không tái lập được trên bản mới cài với server đã sửa, nên chuyển trạng thái banner dừng ở **Mức 2** và phải ghi thành proof gap ở task 8.5
    - Xong khi: `npx vitest run src/stores` xanh
    - _Requirements: 2.4, 2.8, 3.5_

  - [ ] 8.5 Verify lô 5
    - Chạy được **chỉ trên Windows thật** (repo `d:\pdfcompare`, thư mục `desktop`): `npm run typecheck`, `npx vitest run src/stores src/components/dieline-tool`, `npm run test` toàn bộ, `npm run lint`
    - Không chạy được từ máy dev nếu agent làm việc từ xa: `node_modules` chứa binary Windows, chạy trong VM/CI Linux cho kết quả sai ⇒ giao user chạy và dán kết quả
    - Proof gap phải ghi rõ: **chuyển trạng thái banner end-to-end không kiểm được** — nó cần một token thật thiếu `rk`, mà trên bản mới cài với server đã sửa thì token luôn có `rk`. Không dựng lại điều kiện đó chỉ để kiểm banner. Độ phủ dừng ở test đơn vị của task 8.4 (**Mức 2**)
    - Test đỏ trong lần chạy full suite phải chạy lại cô lập trước khi gọi là hồi quy
    - Xong khi: kết quả dán vào báo cáo, so với baseline trước lô
    - _Requirements: 3.11_

- [ ] 9. Checkpoint — bảo đảm mọi test xanh và ghi đúng mức bằng chứng

  - [ ] 9.1 Chạy lại ma trận verify đầy đủ theo Design §Testing Strategy
    - `backend\venv\Scripts\python -m pytest tests`; `cd native && cargo test` (hai lượt); `cd desktop && npm run typecheck && npm run test && npm run lint`; `cd d:\printsolutions-main && npm run test:run` + `npm run typecheck`
    - Xác nhận lại: test khám phá của task 3 xanh (**Property 1**), baseline preservation của task 4 vẫn xanh (**Property 2**), assertion fail-closed xanh (**Property 3**), assertion không-rò-bí-mật xanh (**Property 4**)
    - Có câu hỏi phát sinh thì hỏi user, không tự nới assertion để cho xanh
    - _Requirements: 3.11, 3.12_

  - [ ] 9.2 `[VẬN HÀNH]` Kiểm runtime trên bản mới cài
    - **Agent không chạy task này.** Cài installer của bản **mới đóng gói** (đã qua probe lô 3) trong profile sạch, kích hoạt bằng license TEST, mở công cụ khuôn bế, tạo một khuôn RTE mặc định
    - Lặp lại với license Free để xác nhận đường từ chối entitlement vẫn đúng (3.3)
    - Không kiểm chuyển trạng thái banner ở đây: nó cần một token thật thiếu `rk`, chỉ có trên máy đang kẹt — mà cứu máy đang kẹt đã ra khỏi phạm vi spec. Ghi thành proof gap theo task 8.5
    - Xong khi: chuỗi này đạt thì mới được ghi **Mức 3** cho tầng app; chưa đạt thì ghi rõ dừng ở Mức 2
    - _Requirements: 2.1, 2.8_

  - [ ] 9.3 Ghi báo cáo bằng chứng và proof gap còn lại
    - Ghi mức bằng chứng từng lô, và danh sách kiểm chưa chạy được kèm lý do: Deno typecheck (không có `deno` trong PATH), cú pháp SQL thực thi (không có `psql`/Supabase CLI), mọi truy vấn/deploy production (người vận hành), probe đầy đủ (máy phát hành), tái lập C(X) end-to-end (build dev luôn plaintext), chuyển trạng thái banner (cần token thiếu `rk`, ngoài phạm vi), vitest/tsc/eslint (chỉ Windows thật)
    - Nhánh nguyên nhân: nếu Lô 0 đã chạy thì ghi kết luận của task 1.6 kèm bằng chứng. Nếu **bỏ** Lô 0 thì ghi rõ nhánh **chưa** được xác định, và vì sao điều đó không chặn mục tiêu — cả §C và §E đều đã làm trong lô 1 nên nhánh không quyết định phạm vi sửa
    - Không in giá trị token, license key hay khoá `rk` ở bất kỳ đâu trong báo cáo — chỉ tên claim, độ dài, trạng thái có/không
    - _Requirements: 2.2, 3.5, 3.11_

## Task Dependency Graph

```json
{
  "waves": [
    { "wave": 1, "tasks": [2], "description": "Lô 3 — release gate: probe kích hoạt thật. Không phụ thuộc lô nào, nằm hoàn toàn trong d:\\pdfcompare, là thứ duy nhất trực tiếp thoả mục tiêu 'bản sau không lỗi'" },
    { "wave": 2, "tasks": [3, 4], "description": "Test khám phá (phải ĐỎ) và baseline preservation (phải XANH) trên code chưa sửa — đi trước lô 1, lô 2, lô 4" },
    { "wave": 3, "tasks": [5], "description": "Lô 1 — migration + manifest; kết thúc bằng ba xác minh chỉ-đọc của người vận hành" },
    { "wave": 4, "tasks": [6], "description": "Lô 2 — bundle Edge + assertion; deploy chỉ sau khi lô 1 đã áp và xác minh đạt" },
    { "wave": 5, "tasks": [7], "description": "Lô 4 — trạng thái engine ở native + backend" },
    { "wave": 6, "tasks": [8], "description": "Lô 5 — phát hiện sớm phía client" },
    { "wave": 7, "tasks": [9], "description": "Checkpoint + kiểm runtime trên bản mới cài + báo cáo bằng chứng" }
  ],
  "optional": [
    { "tasks": [1], "description": "Lô 0 — chẩn đoán hậu kiểm. TÙY CHỌN, không chặn wave nào, chạy được bất cứ lúc nào kể cả sau khi đã sửa xong" }
  ]
}
```

```
(1) Lô 0 [TÙY CHỌN] — độc lập, không chặn wave nào, bỏ được mà không ảnh hưởng lô 1–5

2 (Lô 3, độc lập) ─ 3 (test ĐỎ) ─ 4 (test XANH) ─ 5 (Lô 1) ─ 6 (Lô 2) ─ 7 (Lô 4) ─ 8 (Lô 5) ─ 9 (checkpoint)
```

- **Task 2 (Lô 3) không phụ thuộc lô nào.** Chặng 2 của probe tự đủ: token thật từ `license-verify` → `generate_dieline_json` trên wheel đã staged → `dieline.panels` không rỗng. Chạy được với bundle Edge trên production hôm nay. Chặng 1 dung thứ phiên bản nên cũng không cần lô 2. Đặt đầu vì là thứ duy nhất trực tiếp thoả mục tiêu.
- **Task 3 và 4 không chặn task 2, và task 2 không chặn chúng** — hai mũi độc lập, khác repo. Chúng đi trước bản vá tương ứng: task 3 trước lô 1/lô 2, task 4 trước lô 2/lô 4.
- Task 5 (Lô 1) cần 3 và 4: không sửa trước khi có test đỏ đúng chỗ và baseline xanh. **Không** cần Lô 0.
- Task 6 (Lô 2) cần 5.4 (object phải tồn tại trên production trước khi bundle gọi nó) — thứ tự này **không đảo được theo nhánh nào**.
- Task 7 (Lô 4) độc lập về file với 5 và 6 nhưng đặt sau để giữ đúng quy tắc một lô một lần verify.
- Task 8 (Lô 5) cần 6 (đọc `rk_status`) và 7 (gọi endpoint trạng thái).
- Task 1 (Lô 0) tùy chọn, chạy song song hoặc bỏ; kết luận của nó chỉ vào báo cáo, không đổi phạm vi lô nào.

## Notes

- **Mục tiêu duy nhất là bản sau không lỗi.** Không task nào còn phục vụ việc cứu máy đang cài rc.9. Task chẩn đoán bằng license TEST (chốt 0.6 của Design) đã bị bỏ khỏi Lô 0 — probe của Lô 3 (task 2.5) làm đúng việc đó theo cách tái dùng được, vừa là phép đo vừa là chốt chặn tái diễn.
- **Hệ quả vận hành của Lô 3:** từ lúc task 2 vào, `build_production.ps1` fail cho tới khi server cấp được `rk` cho `app_version` đang build. Lô 1 và Lô 2 vẫn **bắt buộc**; người vận hành vẫn phải áp migration (5.4) và deploy Edge (6.5), nếu không thì không đóng gói được bản mới. `-SkipDielineActivationProbe` chỉ dùng cho chẩn đoán offline; `-Release` **không bao giờ** dùng nó.
- **Dung thứ phiên bản ở chặng 1 không phải nới cổng.** Cổng thật là chặng 2 và nó không dung thứ gì. Chặng 1 chỉ bỏ qua khẳng định `rk_status = 'granted'` khi trường chưa tồn tại trong phản hồi (bundle Edge chưa lên lô 2); nó **vẫn** khẳng định `status = 'VALID'` và **vẫn** khẳng định token có tên claim `rk`. Sau 6.5, chặng 1 tự siết chặt mà không phải sửa probe.
- **Task giao người vận hành, agent không tự chạy:** 1.3, 1.4, 1.5 (tùy chọn), 2.5, 5.4, 6.5, 9.2. Gồm toàn bộ truy vấn Supabase production, chạy probe kích hoạt thật, áp migration production, deploy Edge Function, và kiểm trên bản mới cài.
- **Cấm tuyệt đối:** `POST /rest/v1/rpc/claim_rk_grant` để thăm dò. RPC đó ghi — nó tiêu một suất cấp khoá và làm đổi chính trạng thái đang đo.
- **Không backfill `legacy_fallback = true`** trong task 5.1. Chạy lại backfill 30/07 sẽ đánh legacy cho toàn bộ hàng rc.4→rc.9 và mở lại đúng nhánh fail-open đã đóng. Sau khi áp migration, `count(*) where legacy_fallback` phải vẫn bằng 1.
- **Tên migration trong `security-manifest.json` và file `.sql` phải cùng lô 1.** Test clean-checkout duyệt `required_migrations` rồi `existsSync` từng tên; lệch lô là lô 1 tự làm đỏ chính nó.
- **Ba chuỗi literal ở `d:\printsolutions-main\src\securityAuditRound2.test.ts` dòng 36–42 giữ nguyên byte-for-byte.** Chỉ bổ sung `expect` mới. Đây là lý do thiết kế giữ nguyên tên `rk_cap_exceeded`, `rk_legacy_fallback`, `rk_claim_failed_closed` và biểu thức ternary trong `logSecurityEvent`.
- **Không in giá trị token, license key hay khoá `rk`** ra stdout/stderr, log, manifest, status JSON, argv process con, test hay báo cáo. Chỉ tên claim, độ dài, trạng thái có/không.
- Test khám phá của task 3 sẽ ĐỎ suốt từ khi viết tới hết lô 2. Đó là chủ đích. Không `skip`, không nới để suite xanh sớm.
- `native/Cargo.toml` không thêm dependency (property test dùng vòng lặp có seed); `d:\printsolutions-main` không thêm `fast-check` (miền hữu hạn nên duyệt vét cạn); `desktop` dùng `fast-check` đã có sẵn.
- Không đặt `[profile.release]` (LTO/codegen-units) vào Cargo.toml ở bất kỳ task nào.
- Comment và text UI tiếng Việt; thông báo lỗi UI đi qua khoá i18n, không hardcode trong `lib/`.
- vitest, tsc và eslint chỉ chạy trên máy Windows thật của dự án. Không kết luận từ kết quả chạy trong VM/CI Linux.
- Mức bằng chứng cao nhất từ máy dev là **Mức 2**. Mức 3 chỉ đạt qua task 2.5 và 9.2. Mọi báo cáo phải ghi đúng mức đã đạt, không làm tròn lên.
