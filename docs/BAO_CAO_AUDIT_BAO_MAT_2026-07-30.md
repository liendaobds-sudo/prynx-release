# BÁO CÁO AUDIT BẢO MẬT PRYNX / PRINTSOLUTIONS — 2026-07-30

> Trạng thái: **Giai đoạn 2 — báo cáo để duyệt, chưa sửa mã nguồn**  
> Chế độ: audit chuẩn/sâu có giới hạn, chỉ đọc và phân tích tĩnh  
> Threat model: `docs/audit/PRYNX_THREAT_MODEL.md`  
> Quy trình: `prynx-security-review` + `prynx-audit-workflow`

## 1. Tóm tắt điều hành

Đợt rà soát xác nhận **6 finding Medium và 1 finding Low** đủ độ tin cậy để đưa vào backlog. Không phát hiện finding Critical/High mới đạt ngưỡng bằng chứng trong phạm vi đã đọc.

Các kiểm soát lõi của PrynX đã tiến bộ rõ: sidecar chỉ bind loopback, HTTP và WebSocket dùng HMAC theo method/path/credential với nonce dùng một lần, token license Ed25519 bị ràng buộc product/HWID/license, kết quả tĩnh dùng URL ký theo path, CSP không cho script mạng, updater có public key và các route nghiệp vụ đã có license/feature guard. Không tìm thấy bypass mới đủ bằng chứng trong chuỗi này.

Rủi ro ưu tiên nằm ở PrintSolutions và chuỗi phát hành:

1. Bản vá F6 trước đây chỉ sửa header IP ở Edge Function nhưng RPC `get_order_by_code` vẫn cho `anon` gọi trực tiếp và tự truyền/null `p_ip`; do đó rate-limit có thể bị bỏ qua hoàn toàn.
2. Cổng chống thu gom resource key `rk` cố ý fail-open khi RPC lỗi; migration tương ứng lại đang untracked, nên chính tình huống migration chưa deploy sẽ mở lại đường thu gom khóa.
3. Script deploy đưa private signing key vào command line của process con và tự tải/chạy Supabase CLI bản `latest` không pin/checksum.
4. Build PrynX có thể tải checkpoint PyTorch `.pth` không kiểm digest rồi gọi `torch.load`; với môi trường PyTorch không được chốt phiên bản/hành vi an toàn, đây là đường supply-chain tới thực thi mã trên máy build.
5. Chín migration bảo mật và nhiều thay đổi Edge Function hiện chưa nằm trong Git; không có bằng chứng workspace rằng production đã deploy đúng tập migration này.

Không có sửa code, deploy, migration, build release, test động, stage, commit hoặc push nào được thực hiện trong đợt audit.

## 2. Scan context

### 2.1 Revision và trạng thái workspace

| Repo | Branch | HEAD | Trạng thái tại thời điểm scan |
|---|---|---|---|
| `D:\pdfcompare` | `security/audit-2026-07-25` | `6ab59164322973beb9cd6037579019dd24138dc4` | 121 file tracked thay đổi/staged, 66 mục untracked |
| `D:\printsolutions-main` | `security/license-ttl-72h` | `0150b77b39f4ad6dd3994f90fea688d7cb1f6f41` | 72 file tracked thay đổi/staged, 148 mục untracked |

Hai worktree rất bẩn. Vì vậy báo cáo phân biệt rõ:

- **HEAD**: trạng thái đã được version-control ghi nhận.
- **Working tree**: thay đổi đang phát triển, có thể chưa review, chưa commit và chưa deploy.
- Finding dựa trên file modified/untracked không được coi là bằng chứng production đang chạy cùng nội dung.

### 2.2 Phạm vi đã rà

PrynX:

- FastAPI entrypoint, CORS, static result mount, health/startup: `backend/app/main.py`.
- License/HMAC/token/clock/feature guard: `backend/app/core/license_guard.py`.
- Inventory route HTTP và WebSocket trong `backend/app/api/routes/` và `backend/app/workers/cut_export/api.py`.
- Frontend request signing/interceptor: `desktop/src/lib/api.ts`.
- Tauri CSP, asset protocol, capabilities: `desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/capabilities/default.json`.
- Native IPC liên quan file, process, license, DPAPI và request signing: `desktop/src-tauri/src/lib.rs`, `security.rs`, `external_app.rs`.
- Build/release, CI, updater, dependency/model download: `build_production.ps1`, `.github/workflows/ci.yml`, các worker/model script liên quan.
- Secret scan tĩnh theo tên/pattern, chỉ trả tên file; không in giá trị bí mật.
- Đối chiếu threat model, hai báo cáo ngày 2026-07-26 và các phần kiến trúc bảo mật gần nhất.

PrintSolutions:

- Edge Functions `license-verify`, `license-release`, `order-lookup`, `bin-packing` và inventory remote import.
- Migration liên quan license verification, resource key, RPC/RLS/`SECURITY DEFINER`, order lookup và revoke quyền mặc định.
- Script deploy license token, `.gitignore`, file tạm và metadata token đã che.
- Trạng thái Git của các Edge Function/migration bảo mật.
- Secret scan tĩnh theo tên/pattern, không xuất giá trị.

### 2.3 Phương pháp và giới hạn an toàn

- Chỉ dùng đọc file, `git status/diff/log`, tìm kiếm tĩnh và giải mã **metadata không bí mật** của token cục bộ để kiểm tra `exp`/audience/binding.
- Không chạy code/test/workflow từ worktree chưa tin cậy.
- Không gọi endpoint production, không thử brute-force, không áp migration và không dùng token/key thật.
- Không chạy scanner gửi source ra ngoài, không cài thêm dependency.

## 3. Bản đồ trust boundary chính

| Boundary | Tài sản | Kiểm soát quan sát được | Kết luận audit |
|---|---|---|---|
| WebView → Tauri native | File người dùng, process, license token, sidecar secret | CSP, capability/deny-list, allowlist đuôi file, DPAPI, native token verification | Không thấy bypass mới đủ confidence; Ring-3 vẫn là accepted risk |
| WebView/localhost → FastAPI sidecar | PDF, kết quả, tính năng trả phí | Loopback, HMAC + nonce + method/path, Ed25519, feature gate | Không thấy bypass mới đủ confidence |
| FastAPI → Supabase | Trạng thái license | Token server-signed; production sidecar fail-closed | Không thấy regression mới trong code đã đọc |
| Client/Internet → Edge Function/RPC | Đơn hàng, license, resource key | Edge validation, service role, RLS/RPC, rate-limit | Có finding §SEC.1 và §SEC.2 |
| Máy build/deploy → upstream | Signing key, binary phát hành, model | TLS, một số dependency/model đã có checksum | Có finding §SEC.3–§SEC.5 |
| Git/migration → production DB | RLS, revoke, RPC, anti-harvest | Migration SQL | Có proof gap/finding vận hành §SEC.6 |

## 4. Bảng finding

| ID | Severity | Confidence | Evidence | Lifecycle | Tóm tắt |
|---|---|---:|---|---|---|
| §SEC.1 | Medium | 95% | `[VERIFIED]` | Reopened / Triaged | Gọi trực tiếp `get_order_by_code` cho phép tự chọn/null IP, bỏ qua rate-limit |
| §SEC.2 | Medium | 95% | `[VERIFIED]` + `[EXTERNAL]` | Triaged | `claim_rk_grant` lỗi thì fail-open và vẫn cấp `rk` |
| §SEC.3 | Medium | 95% | `[VERIFIED]` | Triaged | Private signing key được truyền trong process argv |
| §SEC.4 | Medium | 95% | `[VERIFIED]` | Triaged | Tải/chạy Supabase CLI `latest` không pin/checksum trước thao tác secret/deploy |
| §SEC.5 | Medium | 90% | `[VERIFIED]` | Triaged | Checkpoint `.pth` không kiểm hash được nạp bằng `torch.load` trên máy build |
| §SEC.6 | Medium | 95% repo / 50% production | `[VERIFIED]` + `[EXTERNAL]` | Needs validation | Chín migration bảo mật đang untracked; trạng thái deploy production chưa chứng minh |
| §SEC.7 | Low | 95% | `[VERIFIED]` | Triaged | Response/token đã hết hạn nằm trong `.temp` untracked nhưng không bị ignore |

## 5. Chi tiết finding

### §SEC.1 — Medium — Direct RPC bỏ qua rate-limit tra cứu đơn

- **Lifecycle:** Reopened / Triaged. Đây là biến thể chưa đóng của F6 ngày 2026-07-26.
- **Bằng chứng:**
  - `D:\printsolutions-main\supabase\migrations\053_fix_order_lookup.sql:28-38`: chỉ đếm/chặn khi `p_ip IS NOT NULL`.
  - `...\053_fix_order_lookup.sql:130`: `GRANT EXECUTE ... TO anon, authenticated`.
  - `D:\printsolutions-main\supabase\functions\order-lookup\index.ts:44-47`: Edge Function gọi cùng RPC bằng service role và truyền IP.
  - Không tìm thấy migration mới hơn `REVOKE` quyền `anon/authenticated` trên signature này.
- **Source → sink:** caller Internet có anon key → PostgREST RPC public → caller tự truyền `p_ip = null` hoặc giá trị mới mỗi request → query đơn hàng và dữ liệu masked.
- **Control bị bypass:** rate-limit được đặt trong RPC nhưng bucket lại là tham số do caller public kiểm soát.
- **Điều kiện khai thác:** biết endpoint/anon key (thông tin public của Supabase client) và có tập mã đơn để thử. Các đơn cũ entropy thấp làm tăng rủi ro; migration tăng entropy giảm rủi ro cho mã mới nhưng không sửa bypass.
- **Tác động:** enumerate trạng thái đơn, tên/email đã mask, số tiền, sản phẩm, trạng thái license/subscription; tạo tải DB và làm yếu “proof of possession” bằng mã đơn.
- **Đề xuất:** thu hồi quyền public của RPC nhận `p_ip`; chỉ Edge/service role được gọi. Nếu phải giữ RPC public cho compatibility, bỏ `p_ip` khỏi input public và lấy bucket từ request context tin cậy, đồng thời có rate-limit độc lập theo code/prefix.
- **Verify đề xuất:** test SQL quyền `anon_exec=false`; test Edge hợp lệ vẫn tra cứu được; test gọi RPC trực tiếp bị từ chối; test giới hạn cạnh tranh/concurrent.
- **Residual risk:** endpoint tra cứu đơn vẫn là public-by-design; cần entropy cao, dữ liệu trả về tối thiểu và giám sát abuse.

### §SEC.2 — Medium — Cổng chống `rk` harvesting fail-open

- **Lifecycle:** Triaged.
- **Bằng chứng:**
  - `D:\printsolutions-main\supabase\functions\license-verify\index.ts:333-350`: comment và code xác nhận khi `claim_rk_grant` lỗi thì gọi thẳng `lookupResourceKey` và vẫn cấp khóa.
  - `D:\printsolutions-main\supabase\migrations\20260726140000_prynx_rk_grant_cap.sql` đang untracked.
- **Source → sink:** client có license đủ quyền tự khai `app_version` → Edge gọi RPC chống-harvest → RPC thiếu/lỗi/quyền sai/DB lỗi → nhánh fail-open → đọc `release_resource_keys` → ký `rk` vào token.
- **Control bị bypass:** cap 5 version/30 ngày không còn tác dụng đúng lúc control phụ thuộc migration bị thiếu hoặc hỏng.
- **Điều kiện khai thác:** license Pro/dev hợp lệ và tạo được lỗi RPC hoặc production chưa có migration. Trạng thái production là proof gap.
- **Tác động:** thu gom khóa resource của nhiều release, làm mất lợi ích rotate khóa theo phiên bản; không tự tạo được license hay private signing key.
- **Đề xuất:** fail-closed **riêng việc cấp `rk`** khi claim lỗi, nhưng vẫn có thể trả token hợp lệ không chứa `rk`; phát log/metric có alert. Gate rollout bằng kiểm tra migration trước deploy Edge Function.
- **Verify đề xuất:** mock RPC error phải trả token không có `rk`; RPC true có `rk`; RPC false không có `rk`; license Free không bao giờ có `rk`.
- **Proof gap:** chưa truy vấn DB production nên chưa biết migration/RPC hiện có và Edge Function đang deploy revision nào.

### §SEC.3 — Medium — Private signing key xuất hiện trong process command line

- **Lifecycle:** Triaged.
- **Bằng chứng:** `D:\printsolutions-main\deploy_license_token.ps1:59-77` đọc private key vào `$privKey`, sau đó gọi `supabase secrets set "LICENSE_SIGNING_KEY=$privKey" ...`.
- **Source → sink:** file secret cục bộ → PowerShell string → argv của `supabase.exe`.
- **Điều kiện khai thác:** process/agent cùng máy có quyền quan sát command line, hoặc telemetry/EDR/process audit thu argv trong đúng cửa sổ deploy.
- **Tác động:** lộ private Ed25519 signing key cho phép tạo token license/resource-key hợp lệ cho tới khi rotate trust anchor.
- **Đề xuất:** dùng cơ chế stdin/env/file descriptor được Supabase CLI hỗ trợ mà không đặt giá trị vào argv; nếu CLI không hỗ trợ, dùng API/SDK với body qua HTTPS và redaction log. Xóa biến/key buffer best-effort sau dùng và document rotate/recovery.
- **Verify đề xuất:** capture process metadata trong fixture với secret giả và khẳng định secret không xuất hiện trong command line/log.
- **Residual risk:** biến môi trường của process con vẫn có thể bị cùng user/admin đọc; mục tiêu là loại persistence rộng trong argv/log, không tuyên bố bảo vệ khỏi admin máy build.

### §SEC.4 — Medium — Supabase CLI `latest` không có provenance/checksum

- **Lifecycle:** Triaged.
- **Bằng chứng:** `D:\printsolutions-main\deploy_license_token.ps1:18-35` gọi GitHub releases `latest`, chọn ZIP `windows_amd64`, tải, giải nén và sau đó thực thi; không pin version, không kiểm SHA-256/chữ ký.
- **Source → sink:** metadata/asset GitHub upstream → ZIP → `supabase.exe` → process có access token và thao tác signing secret/deploy.
- **Điều kiện khai thác:** compromise upstream/release asset/account/DNS-TLS trust chain hoặc artifact bị thay thế ở cache/local `.tools`.
- **Tác động:** thực thi mã trên máy deploy, đánh cắp credential/signing key, deploy Edge Function giả.
- **Đề xuất:** pin version cụ thể và SHA-256 đã review; tải vào file tạm, verify trước giải nén; từ chối binary local sai digest; tách bước bootstrap tool khỏi phiên có secret.
- **Verify đề xuất:** fixture ZIP sai hash phải fail trước `Expand-Archive`/execute; đúng hash pass.

### §SEC.5 — Medium — Nạp checkpoint PyTorch không kiểm digest trong release build

- **Lifecycle:** Triaged.
- **Bằng chứng:**
  - `D:\pdfcompare\backend\scripts\convert_realesrgan_onnx.py:24-26`: URL release asset `.pth`.
  - `...\convert_realesrgan_onnx.py:108-116`: nếu cache chưa có thì tải bằng `urlretrieve`, không hash; sau đó `torch.load`.
  - `...\convert_realesrgan_onnx.py:155-178`: chấp nhận file cache có sẵn chỉ theo tồn tại/tên rồi nạp.
  - `D:\pdfcompare\build_production.ps1:513-523`: release build chạy converter khi có torch.
  - `backend/requirements.txt:77-78`: torch chỉ là dependency máy build, không được chốt version trong lock/requirements của repo.
- **Source → sink:** upstream hoặc file cache `~/.u2net/*.pth` → `torch.load` trên máy build → mã chạy với quyền người build trong trường hợp checkpoint pickle độc hại/hành vi PyTorch không fail-safe.
- **Điều kiện khai thác:** upstream/cache bị thay thế và môi trường torch cho phép unpickle object không an toàn. Việc không pin torch làm hành vi `weights_only` không xác định từ repo.
- **Tác động:** compromise máy build, source/credential/release artifact; có thể dẫn tới phát hành binary bị cấy mã.
- **Đề xuất:** chốt SHA-256 cho cả ba `.pth`, verify cả file tải mới và cache trước nạp; dùng `torch.load(..., weights_only=True)` trên phiên bản torch đã pin/hỗ trợ; ưu tiên định dạng `safetensors` hoặc lưu artifact ONNX đã xác minh.
- **Verify đề xuất:** cache/tải sai hash phải bị xóa hoặc fail trước `torch.load`; unit test monkeypatch đảm bảo sink không được gọi; CI kiểm checksum constant.
- **Phản chứng đã kiểm:** ISNet/BiRefNet runtime hiện dùng `ensure_model(... expected_sha256=...)`; finding chỉ áp cho converter Real-ESRGAN `.pth`.

### §SEC.6 — Medium — Security migration drift ngoài version control

- **Lifecycle:** Needs validation.
- **Bằng chứng repo:** ít nhất chín migration bảo mật đang untracked trong PrintSolutions, gồm revoke public execute, server-side pricing, đóng public script access, MIME/audit, harden download, resource key, license audit fixes và `rk` cap. Ba Edge Function trọng yếu cũng đang modified.
- **Trust boundary:** working tree cá nhân → Git/CI/release/deploy → production database/Edge.
- **Tác động:** clean checkout hoặc máy deploy khác có thể thiếu control; review/rollback/reproduce không đáng tin; các lỗ đã “vá” trong workspace có thể vẫn tồn tại production.
- **Đề xuất:** trước mọi deploy, lập manifest migration bất biến, commit/review riêng, kiểm `supabase migration list`/schema digest trên project đích và có gate fail-closed khi Edge code phụ thuộc RPC chưa tồn tại. Không gộp áp migration tự động trong đợt audit này.
- **Proof gap:** không có quyền/bằng chứng production trong workspace để kết luận migration nào đã chạy. Vì vậy severity production không được nâng quá Medium và trạng thái giữ `[EXTERNAL]`.

### §SEC.7 — Low — Artifact token hết hạn không được ignore

- **Lifecycle:** Triaged.
- **Bằng chứng:**
  - `D:\printsolutions-main\supabase\.temp\tok.json` và `resp.json` là untracked.
  - `git check-ignore` không khớp rule nào.
  - Hai file có trường `token` dài 206 ký tự; metadata đã che xác nhận audience `prynx`, machine binding có mặt, không chứa `rk`.
  - `exp` lần lượt là `2026-07-29 06:44:07Z` và `2026-07-29 06:45:19Z`; cả hai đã hết hạn tại thời điểm audit.
- **Tác động:** hiện không còn là bearer token dùng được, nhưng commit/chia sẻ nhầm làm lộ metadata license/machine và tạo tiền lệ giữ response nhạy cảm trong repo.
- **Đề xuất:** ignore `supabase/.temp/` hoặc ít nhất `*.json` response nhạy cảm; fixture test phải dùng token giả; bổ sung pre-commit/CI secret scan.
- **Lưu ý:** audit không in, sao chép, xóa hoặc rotate các token này.

## 6. Finding đã bác bỏ / rủi ro đã chấp nhận / không báo lặp

### 6.1 Không xác nhận thành finding mới

- `bin-packing`: hiện bắt buộc Authorization, gọi subscription RPC fail-closed và có cap số item/tổng piece. CORS `*` không tự bypass bearer auth.
- PrynX sidecar: route inventory cho thấy các route nghiệp vụ dùng `require_license`/`require_feature`; WebSocket dùng cùng signature/token/clock guard.
- `/results`: middleware yêu cầu chữ ký HMAC theo path trước static mount.
- Tauri CSP: `script-src 'self' blob:`; không có CDN script hoặc `unsafe-eval`.
- DPAPI token storage: secret được đưa vào PowerShell qua env, không nội suy vào `-Command`; đây là đối chứng tốt cho §SEC.3.
- Model ISNet/BiRefNet: có SHA-256; không gộp nhầm vào §SEC.5.
- Secret scan tracked không phát hiện private key/service-role token theo pattern đã dùng. File `.npmrc` tracked trong `debug-sepay` chỉ có comment, không có credential.

### 6.2 Accepted risk / giới hạn kiến trúc

- Client desktop Ring-3 không thể chống patch tuyệt đối. Mục tiêu thực tế là tăng chi phí, giữ trust anchor/server secret ngoài renderer và fail-closed ở native/backend/server.
- Người có quyền admin trên máy build/user có thể đọc nhiều trạng thái process/memory; các biện pháp argv/env chỉ giảm bề mặt/persistence, không chống admin tuyệt đối.
- Endpoint order lookup là public-by-design; sau khi đóng bypass vẫn còn rủi ro đoán code, cần entropy và telemetry.

### 6.3 Hardening ngoài danh sách vulnerability

- Pin `@supabase/supabase-js@2` về version/digest cụ thể và dùng lock/vendor cho Edge imports; hiện nhiều function import major tag mutable từ `esm.sh`.
- Pin GitHub Actions bên thứ ba theo commit SHA và khai báo `permissions` tối thiểu; tag major vẫn là ref mutable.
- Thêm CI kiểm security migration bắt buộc đã tracked và Edge function không tham chiếu RPC chưa có trong manifest.
- Tạo allowlist/checksum tập trung cho mọi binary/model tải ở build/runtime.

## 7. Coverage gap và proof gap

### Coverage gap

- Không đọc line-by-line toàn bộ 187+72 thay đổi tracked và 214 mục untracked của hai repo; audit ưu tiên trust boundary và entrypoint bảo mật.
- Không audit sâu parser PDF/font/image/native FFI bằng fuzzing hoặc sanitizer.
- Không audit bytecode/binary phát hành, NSIS installer thực tế, chữ ký Authenticode hoặc updater artifact đã publish.
- Không chạy dependency advisory online tại thời điểm 2026-07-30; chỉ đối chiếu CI/lock/provenance tĩnh.
- Không review hạ tầng Supabase Dashboard, GitHub branch protection, environment secret, access log hoặc policy ngoài repo.

### Proof gap

- Chưa biết revision Edge Function và migration thực tế trên production.
- Chưa biết Supabase proxy có strip/overwrite `x-real-ip`; finding §SEC.1 không phụ thuộc điều này vì direct RPC đã đủ bypass.
- Chưa biết máy build dùng phiên bản PyTorch nào và cache `.pth` hiện có digest gì.
- Chưa xác minh private signing key đã rotate sau các đợt deploy trước.
- Chưa có runtime test/PoC; theo skill, worktree đang review được coi là untrusted nên audit không chạy code của nhánh.

## 8. Thứ tự xử lý đề xuất theo lô

Mọi lô tối đa 5 file và chỉ bắt đầu sau khi user duyệt.

### Lô A — Đóng bypass server-side ưu tiên cao

- §SEC.1: thu hồi direct RPC / thiết kế bucket không do caller kiểm soát.
- §SEC.2: fail-closed riêng cấp `rk` và thêm regression test.
- Tối đa dự kiến: 4 file (migration mới, Edge Function, test SQL/Edge, tài liệu deploy).

### Lô B — Bảo vệ signing/deploy chain

- §SEC.3 + §SEC.4: bỏ key khỏi argv; pin/checksum Supabase CLI; test giả.
- Tối đa dự kiến: 3 file.

### Lô C — Bảo vệ model build chain

- §SEC.5: SHA-256 + `weights_only=True`/torch pin + regression test.
- Tối đa dự kiến: 4 file.

### Lô D — Chốt migration/repository hygiene

- §SEC.6: manifest/gate migration và review từng migration trước commit/deploy.
- §SEC.7: ignore artifact tạm + secret scan.
- Vì đang có chín migration untracked, chia thành nhiều lô ≤5 file; không áp DB cho tới khi có backup/rollback và user duyệt riêng.

## 9. Tiêu chí đóng finding

Một finding chỉ chuyển `Verified/Closed` khi có đủ:

1. Reproducer/test âm ban đầu fail trên bản cũ và pass trên bản vá.
2. Hành vi hợp lệ vẫn hoạt động.
3. Bypass lân cận được kiểm: direct RPC, RPC error/missing migration, cache sai hash, argv/log redaction.
4. Verify theo `prynx-testing` phù hợp tầng code.
5. Với §SEC.1/§SEC.2/§SEC.6: có bằng chứng migration/Edge revision trên môi trường đích, không chỉ file local.

## 10. Chốt duyệt

Báo cáo dừng tại đây theo quy trình hai chốt. Chưa có bản vá nào được áp dụng. Đề nghị user duyệt một trong các hướng:

- duyệt toàn bộ thứ tự Lô A → D;
- duyệt riêng Lô A trước;
- hoặc yêu cầu điều chỉnh severity/phạm vi trước khi tạo patch proposal.

## 11. Cập nhật sau duyệt — 2026-07-30

User đã duyệt xử lý toàn bộ finding. Bản vá hiện có trong working tree và được ghi
chi tiết tại `docs/BAO_MAT_FIXES_2026-07-30.md`:

- §SEC.1: đã có migration thu hồi quyền gọi trực tiếp order RPC.
- §SEC.2: đã chuyển sang fallback chỉ cho release legacy, giữ khách cũ không bị khóa.
- §SEC.3–§SEC.4: private key không còn ở argv; Supabase CLI đã pin và kiểm checksum.
- §SEC.5: checkpoint Real-ESRGAN đã có checksum và `weights_only=True`.
- §SEC.6–§SEC.7: đã có migration manifest/gate và ignore artifact tạm.

Lifecycle production của §SEC.1, §SEC.2 và §SEC.6 vẫn là `Needs validation` cho tới
khi migration được áp trước Edge Function và có bằng chứng revision trên project đích.

## 12. Bằng chứng production sau triển khai

Migration đã được user áp và xác minh đúng quyền/cột/RPC; toàn bộ `1/1` release key
active được đánh dấu legacy. Hai Edge Function đã deploy lên project
`ryvyuxjgdcvoxujqmggm` bằng CLI `2.110.0` đúng checksum:

- `license-verify`: `ACTIVE`, version 13.
- `order-lookup`: `ACTIVE`, version 6.
- Smoke test không chứa secret trả HTTP 400 đúng validation boundary cho cả hai.

§SEC.1/§SEC.2/§SEC.6 đã `Applied`; chờ kiểm tay PrynX cũ để đóng compatibility runtime.
