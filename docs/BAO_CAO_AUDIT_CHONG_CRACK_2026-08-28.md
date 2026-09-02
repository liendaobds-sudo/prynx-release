# Báo cáo audit bảo mật — chống crack & leo quyền (2026-08-28)

> **Chế độ:** Audit chuẩn (đọc-only), phạm vi license/entitlement/anti-tamper.
> **Lý do:** lo ngại đối thủ dùng AI để bẻ khóa PrynX.
> **Repo/revision:** `d:\pdfcompare` @ `c863931` (2026-08-27) — **working tree KHÔNG sạch**
> (WIP mixed_nesting/artifact_lease/source_revision). `d:\printsolutions-main` @ working tree hiện tại.
> **Threat model dùng để xếp hạng:** `docs/audit/PRYNX_THREAT_MODEL.md` (2026-08-15) — đã xác nhận còn khớp code.
> **Quan hệ với audit trước:** re-audit F1–F12 của `SECURITY_AUDIT_INDEPENDENT_2026-07-26.md` + rà phần code mới
> (151 commit, ~17k dòng thêm ở core/routes/src-tauri/stores) chưa từng qua security review.
> **Trạng thái:** ĐÃ DUYỆT VÀ SỬA (2026-08-28). 12/15 finding đã vá; 3 còn lại cần hạ tầng hoặc
> quyết định thương mại. Log sửa + bằng chứng verify: `docs/CHONG_CRACK_FIXES_2026-08-28.md`.
> Tóm tắt kiến trúc: `docs/audit/SECURITY_ARCHITECTURE.md` §26.
>
> | Lifecycle | Finding |
> |---|---|
> | **Verified** (có test âm trước / dương sau) | §SEC.01, §SEC.04, §SEC.05, §SEC.07, §SEC.13, §SEC.14 |
> | **Applied**, chờ deploy để thành Verified | §SEC.02, §SEC.06, §SEC.08, §SEC.10 |
> | **False positive → Closed** (kèm gate thường trực) | §SEC.12 |
> | **Accepted risk** (giữ nguyên, có tài liệu) | §SEC.09, §SEC.11 |
> | **Còn mở** | §SEC.03 (cần credential production), §SEC.15 (thuộc spec `save-as-artifact-guard`) |

---

## 0. Trả lời trực tiếp câu hỏi "AI có bẻ được PrynX không"

Phân tách hai loại tấn công, vì chúng cần biện pháp khác nhau:

**Loại 1 — giả mạo license (keygen, tự ký token).** AI **không giúp gì**. Muốn giả token phải có private key Ed25519,
key đó chỉ nằm trong Supabase secret; muốn mở engine dieline phải có `rk` nằm trong payload đã ký. Đây là toán học,
không phải logic — không có gì để "suy luận ra". Lớp này vẫn chắc, đã verify lại trong đợt này.

**Loại 2 — tìm chỗ hở trong logic cưỡng chế.** Đây **chính là chỗ AI tạo lợi thế thật**: đọc hết repo trong vài phút,
đối chiếu "feature này khai là Pro ở đâu" với "route này gate bằng gì", và tìm ra bất đối xứng. Đợt audit này tìm được
**một lỗ đúng đúng loại đó** (§SEC.01) và **một đường đi vòng ở server** (§SEC.02). Cả hai đều không cần crack gì cả —
chỉ cần gọi API đúng cách với một license Free hợp lệ.

Kết luận hành động: **đừng đầu tư thêm vào obfuscation/anti-debug.** Ưu tiên đóng khe cưỡng chế và thêm ratchet CI để
khe đó không mở lại. Đường crack tốn kém nhất cho đối thủ vẫn là §SEC.11 (patch exe) và nó chỉ đóng được bằng
code signing — vẫn là quyết định thương mại chưa làm.

---

## 1. Tóm tắt điều hành

| Mức | Số finding | Ghi chú |
|---|---|---|
| 🔴 P0 | 1 | §SEC.01 — Free dùng được tính năng Pro (bình bế rớt/CNC + đẩy máy bế) |
| 🟠 P1 | 2 | §SEC.02 đường activation công khai ở DB; §SEC.03 provenance gap của migration bảo mật |
| 🟠 P2 | 7 | §SEC.04–§SEC.10 |
| 🟡 P3 | 5 | §SEC.11–§SEC.15 (gồm accepted risk cần nhắc lại) |

**Đã xác nhận VÁ ĐÚNG từ đợt trước** (không cần làm lại): F3 (cận tuổi thọ token nay chỉ đọc env ở dev),
F5 (DPAPI truyền secret qua env var, không nội suy dòng lệnh, có escape đúng), F6 (`order-lookup` bỏ
`x-forwarded-for`), F10 (`api.ts` xoá sạch header auth do caller đặt trước khi gắn header đã ký).

**Vẫn chắc, không cần đụng:** token Ed25519 (payload do server dựng bằng object rồi stringify, `plan`/`features`/`rk`/`exp`
client không chạm được, fail-closed khi tra entitlement lỗi), nonce dùng-một-lần tiêu **sau** khi HMAC hợp lệ,
`DEV_MODE`/`FEATURE_GATING`/pubkey đều fail-closed dưới binary compiled, resource key AES-256-GCM với khoá chỉ đến từ
claim đã ký, `release_resource_keys` RLS deny-all chỉ `service_role` đọc.

---

## 2. Bảng finding

### §SEC.01 — 🔴 P0 — Router `cut_export` không cưỡng chế `impo.cnc`: Free dùng được tính năng Pro

- **Lifecycle:** Accepted · **Confidence:** cao · **Bằng chứng:** `[VERIFIED]` (đọc code + grep, chưa chạy runtime)
- **Trust boundary:** Client → FastAPI sidecar (biên cưỡng chế quyền)
- **Vị trí:** `backend/app/workers/cut_export/api.py:32`

```python
router = APIRouter(prefix="/imposition", tags=["cut-export"], dependencies=[Depends(require_license)])
```

Chỉ có `require_license`. Grep toàn bộ package `backend/app/workers/cut_export/**` cho
`require_feature|enforce_feature|impo\.cnc` → **0 hit**. Nghĩa là 10 endpoint sau chỉ đòi *một license hợp lệ bất kỳ*,
không đòi gói Pro:

`/api/imposition/cut-export`, `/cut-export-from-file`, `/cut-preview-from-file`, `/cut-layers`, `/cut-pages`,
`/cut-profile`, `/cut-profile-save`, `/cut-profile-delete`, `/cut-profiles`, `/cut-connection-test`
(`api.py:68,77,96,169,237,264,280,300,316,341`).

- **Bất đối xứng chứng minh đây là lỗ, không phải chủ đích:**
  - `impo.cnc` khai là **Pro** ở backend: `backend/app/core/feature_entitlements.py:29` (`PRO_FEATURES`).
  - Khai là **Pro** ở frontend: `desktop/src/lib/license/features.ts:36` (`minPlan: 'pro'`, label "Bình bế rớt/CNC").
  - Tool được gate ở UI: `desktop/src/lib/toolRegistry.ts:561` (`featureId: 'impo.cnc'`).
  - Nhưng `impo.cnc` **chỉ được enforce thật** ở một chỗ duy nhất: `imposition.py:976` (`_launch_impose_job` →
    `enforce_feature(_imposition_feature(settings))`). Module cut_export bỏ trắng.
- **Kịch bản khai thác:** người dùng có license **Free** (hoặc renderer bị patch/XSS) gọi thẳng
  `POST /api/imposition/cut-export-from-file` qua `authenticatedFetch`. Header HMAC + token vẫn hợp lệ (license Free
  là license thật), `require_license` cho qua, không ai hỏi plan. Client TS đã có sẵn hàm gọi:
  `desktop/src/components/imposition-tools/cut-export/api.ts:92,125,179,191`.
- **Tác động:** mất doanh thu tính năng Pro có giá trị cao nhất trong nhóm (xuất luồng cắt DXF/command stream và
  **đẩy trực tiếp tới máy bế qua TCP/serial**). Đây là output đi thẳng vào sản xuất, không phải preview.
- **Root cause:** độ phủ entitlement dựa vào **quy ước** chứ không có cưỡng chế cấu trúc. Audit 2026-07-26 §1.5 đã
  cảnh báo đúng câu này ("thêm router mới mà quên dep sẽ hở âm thầm") nhưng không có ratchet nào chặn.
- **Control bị bypass:** feature entitlement (`require_feature`). UI gate vẫn còn nhưng theo threat model §5,
  "UI chỉ là lớp UX/defense-in-depth" — không phải biên cưỡng chế.
- **Remediation đề xuất:** thêm `Depends(require_feature("impo.cnc"))` vào `dependencies` cấp router. Cân nhắc riêng:
  `/cut-profiles` và `/cut-connection-test` có nên để Free đọc danh sách máy không (quyết định sản phẩm).
- **Test cần có:** một test kiểu `test_free_token_e2e.py` khẳng định Free → 403 kèm `"impo.cnc"` trong detail.
  Lưu ý `backend/app/workers/cut_export/tests/test_api.py:20` hiện **override `require_license` = lambda: True** nên
  không thể phát hiện lỗ này.
- **Residual sau vá:** không đáng kể.
- **Proof gap:** chưa chạy request thật bằng token Free ký hợp lệ (cần Windows + venv). Kết luận dựa trên đọc code.

---

### §SEC.02 — 🟠 P1 — `verify_license_guarded` được GRANT cho `anon`: đường activation PrynX công khai đi vòng Edge Function

- **Lifecycle:** Accepted · **Confidence:** cao · **Bằng chứng:** `[VERIFIED]` (đọc migration)
- **Trust boundary:** Internet → Supabase PostgREST (bỏ qua Edge Function)
- **Vị trí:** `d:\printsolutions-main\supabase\migrations\20260822120000_reset_machine_blocks_prynx_multitem.sql:94-129`

```sql
CREATE OR REPLACE FUNCTION public.verify_license_guarded(
  p_license_key TEXT, p_machine_id TEXT, p_product_id TEXT DEFAULT 'prynx')
...
  RETURN public.verify_license(p_license_key, p_machine_id, p_product_id);
...
GRANT EXECUTE ON FUNCTION public.verify_license_guarded(TEXT, TEXT, TEXT) TO anon, authenticated;
```

- **Điều kiện tấn công:** chỉ cần **anon key**, vốn công khai trong bundle frontend và hardcode trong hàng chục
  script `product/**`.
- **Đường đi:** `POST /rest/v1/rpc/verify_license_guarded` → `verify_license` (`20260214_verify_license_add_expiry_fields.sql:14-111`).
  Đường này **không** đi qua Edge Function nên mất luôn: rate-limit theo IP tin cậy, ghi `security_logs`, và cổng
  `claim_rk_grant_v2`.
- **Hai điểm yếu cộng dồn trong `verify_license`:**
  1. **TOCTOU đếm activation** (`:69-95`): đọc `COUNT(DISTINCT machine_id)` → so trần → `INSERT ... ON CONFLICT`,
     **không** `pg_advisory_xact_lock`, **không** `FOR UPDATE`. N request song song với N `machine_id` khác nhau đều
     đọc cùng một `hwid_count` cũ và đều chèn thành công ⇒ vượt trần thiết bị.
     (Advisory lock trong repo chỉ có ở `20260819091000:266` và `20260826120000:273` — không phải đường này.)
  2. **Rate-limit spoof được** (`:32-36`): `coalesce(current_setting('request.header.x-forwarded-for'), ...)` —
     ưu tiên header **client tự đặt được**. Xoay header là reset bucket 10/phút. Đây đúng là F6, đã vá ở
     `order-lookup` nhưng **chưa vá ở đường SQL**, và đường SQL thì anon gọi được.
- **Tác động:** đốt suất activation của license khách hàng thật (khoá oan khách → DoS thương mại), enumerate license
  key với chi phí thấp. **Không** mint được token ký (private key chỉ ở Edge) ⇒ không trực tiếp mở Pro.
- **Remediation đề xuất:** `REVOKE EXECUTE ... FROM anon` trên `verify_license_guarded` **và** `verify_license`
  (mọi overload), chỉ để `service_role`; thêm advisory lock theo `license_id` quanh đoạn đếm→chèn; đảo thứ tự IP
  thành `cf-connecting-ip` → `x-real-ip` → bỏ `x-forwarded-for`. Cần rà consumer trước khi revoke: script `.jsx`,
  `LicenseBridge.ps1`, `PrintMonitorApp` có thể đang gọi RPC trực tiếp.
- **Proof gap:** repo nói "GRANT cho anon, không có REVOKE"; **production có thể đã khác**. Xác nhận dứt điểm bằng
  một câu chỉ-đọc `has_function_privilege('anon', 'public.verify_license_guarded(text,text,text)', 'EXECUTE')`.

---

### §SEC.03 — 🟠 P1 — Provenance gap: 3 migration bảo mật mất khỏi repo, `verify_license_edge` không tái dựng được

- **Lifecycle:** Accepted risk (vận hành) · **Bằng chứng:** `[EXTERNAL]`
- **Vị trí:** `d:\printsolutions-main\supabase\migrations\` — không có file nào mang ngày `20260726*`.
  Header `20260826120000_prynx_rk_grant_rebuild.sql:6-13` tự ghi nhận hai file đã mất
  (`20260726090000_release_resource_keys.sql`, `20260726140000_prynx_rk_grant_cap.sql`); file thứ ba
  `20260726110000_prynx_security_audit_fixes.sql` (F2) cũng không còn và **không** nằm trong
  `security-manifest.json:required_migrations`.
- **Hệ quả kiểm chứng được ngay:** `verify_license_edge` **không có `create function` ở bất kỳ migration nào** —
  chỉ tồn tại dưới dạng lời gọi (`license-verify/index.ts:382`) và comment. Nghĩa là bốn control mà audit trước ghi
  là "đã chắc" (advisory lock activation, rate-limit bucket theo IP tin cậy, khoá tài nguyên bất biến,
  REVOKE khỏi `anon`) **không có bằng chứng nào trong repo**. Một clean checkout không dựng lại được production.
- **Tác động:** không thể phân biệt "đã vá" với "tin là đã vá". Nếu phải rebuild project hoặc dựng staging, các control
  này biến mất im lặng. Đây cũng là lý do §SEC.02 không kết luận được là "đã đóng ở production".
- **Remediation đề xuất:** `supabase db pull` (hoặc dump định nghĩa `verify_license_edge`) rồi commit lại thành
  migration có số thứ tự, cập nhật `security-manifest.json`. Sau đó chạy đối chiếu schema production ⇄ repo.

---

### §SEC.04 — 🟠 P2 — `is_sensitive_path` bị đi vòng bằng `\\?\` / UNC / 8.3 / junction (F8 chỉ vá ở 4 call-site)

- **Lifecycle:** Accepted · **Bằng chứng:** `[VERIFIED]` bằng phân tích tĩnh (chưa chạy PoC)
- **Vị trí:** `desktop/src-tauri/src/lib.rs:3512-3513`

```rust
fn is_sensitive_path(path: &str) -> bool {
    let norm = path.replace('/', "\\").to_lowercase();
```

So khớp **chuỗi thô do renderer gửi**. Không `canonicalize`, không `symlink_metadata`, không strip `\\?\`,
không `GetLongPathName`. Tầng chặn thư mục là `norm.starts_with(home_l + "\\" + blocked)` (`:3573-3576`) nên:

| Biến thể | Kết quả |
|---|---|
| `\\?\C:\Users\<u>\.aws\sso\cache\x.json` | `norm` bắt đầu `\\?\c:\...` → **không** khớp `home_l` → **qua** |
| `\\server\share\...` | không khớp `home_l` → **qua** (`is_network_or_device_path` tồn tại ở `:3599` nhưng **không** được gọi trong nhóm command này) |
| `C:\Users\BOB~1\.aws\...` (8.3) | không khớp dạng dài → **qua** |
| junction `C:\pub\link` → `%USERPROFILE%\.aws` | không resolve → **qua** |

- **Đường đi tới sink:** `read_system_file` (`lib.rs:3864`) cho phép đuôi `.json` (`:3872`) và chỉ kiểm
  `is_sensitive_path` trên chuỗi raw (`:3880`) → `fs::read` → **trả bytes về renderer**. Cùng cấu hình áp cho
  `get_file_size` (`:3887`), `stat_system_file` (`:3963`) và custom protocol `localfile://` (`:6378`) — protocol thì
  không cần `invoke`, chỉ cần một thẻ `<img>`/`fetch`.
- **Tài sản lộ:** `.aws\sso\cache\*.json` (bearer token), `.docker\config.json`, `Code\User\settings.json`.
- **Đã vá đúng cách ở 4 call-site nóng** (raw check → canonicalize → check lại canonical → đối chiếu `fs_scope`):
  `render_worker.rs:1001/1008/1011`, `grant_upscale_file_path` (`lib.rs:3617→3636`),
  `document_window_registry.rs:408→429`, `delete_print_temp` (`print.rs:227-232`).
- **Remediation đề xuất:** vá tại **gốc**: đổi `is_sensitive_path` thành nhận `&Path` đã canonicalize, hoặc thêm một
  hàm bọc `resolve_then_check()` và buộc mọi command dùng nó; đồng thời gọi `is_network_or_device_path` trong nhóm
  `read_system_file`/`get_file_size`/`stat_system_file`/`write_file_atomic`/`launch_external_app`/`localfile`.
- **Residual:** canonicalize làm chậm nhẹ mỗi lần gọi; cần kiểm không vỡ luồng mở file trên NAS.

---

### §SEC.05 — 🟠 P2 — `launch_external_app`: renderer spawn `.exe` tuỳ ý

- **Bằng chứng:** `[VERIFIED]` · **Vị trí:** `desktop/src-tauri/src/external_app.rs:131-169`

Renderer gửi **cả** `app_path` lẫn `file_path`. Guard: `.exe` + tồn tại + `is_sensitive_path`. Rồi
`Command::new(&app_path).arg(&file_path).spawn()`.

- Không có command-injection (argv tách rời, không qua shell) — điểm này ổn.
- Nhưng **không allowlist thư mục** (comment `:150-151` nói cố ý), **không kiểm ký số**, **không** gọi
  `is_network_or_device_path`. Renderer bị patch/XSS ⇒ chạy `.exe` bất kỳ đã có trên máy (Downloads) hoặc
  `\\attacker\share\evil.exe`. Đây là primitive mạnh nhất renderer có trong toàn bộ bề mặt IPC.
- **Remediation đề xuất:** chỉ nhận `app_path` từ kết quả `detect_design_apps` hoặc từ dialog native (giữ danh sách
  đã duyệt ở phía Rust và cho renderer chọn bằng **id**, không bằng path); chặn UNC.

---

### §SEC.06 — 🟠 P2 — F1 còn sống: edge `bin-packing` fail-open + không trần input

- **Bằng chứng:** `[VERIFIED]` · **Vị trí:** `d:\printsolutions-main\supabase\functions\bin-packing\index.ts`

Hai fail-open độc lập:
- `:301` bọc toàn bộ kiểm subscription trong `if (authHeader)`, không có `else`; `:325` comment nói thẳng
  "*If no auth header, allow anonymous access for now (tool gate handles client-side)*" → bỏ header là chạy solver.
- `:318` `if (subData && !subData.has_access)` → `subData` null thì **qua**.

Không trần input: `:333` chỉ chặn `items.length === 0`; `:343-350` bung `flatJobList` theo `item.quantity` không giới hạn
⇒ `{"quantity": 50000000}` là request DoS. Không trần `items.length`, không trần `canvasWidth`/`maxPageHeight`, không timeout.

- **Tác động:** solver nesting (đúng loại IP mà `HYBRID_ANTICRACK_REPORT.md` khuyên đưa lên server để **giấu**) trở
  thành API công khai; cộng thêm DoS. Function này **không có entry `verify_jwt` trong `config.toml`** nên cờ gateway
  thật trên production không kiểm được từ repo.
- **Remediation đề xuất:** fail-closed (thiếu `authHeader` hoặc `subData` null → 403); trần `quantity`, `items.length`,
  `flatJobList.length`, kích thước canvas; thêm timeout.

---

### §SEC.07 — 🟠 P2 — `copy_file_atomic` + staging grant: hợp pháp hoá path vượt `fs_scope`

- **Bằng chứng:** `[VERIFIED]` · **Vị trí:** `lib.rs:4221`, `lib.rs:4249-4256`, `document_window_registry.rs:231-241`, `:425`

`copy_file_atomic` chỉ kiểm đuôi + `is_sensitive_write_path` (`:4202`), **không** kiểm `fs_scope`. Sau khi copy nó gọi
`register_document_window_staging` → path được cấp quyền **một lần, TTL 120s** để làm nguồn cho
`create_document_window` **mà không cần `fs_scope`**.

⇒ Renderer copy một PDF **ngoài** `fs_scope` vào `%TEMP%\prynx_print_new_window_<32hex>.pdf` rồi tự cấp staging grant.
Điều kiện phát hành grant khá chặt (tên `prynx_print_new_window_<32 hex>.pdf`, phải nằm trực tiếp trong `%TEMP%` đã
canonicalize, không symlink, có `%PDF-`) nên đây là **amplification**, không phải quyền mới (renderer đã đọc được file
đó qua `read_system_file`). Nhưng nó phá vỡ tuyên bố ở comment `document_window_registry.rs:604-606`
("PDF lớn chỉ đi bằng path đã được fs_scope cấp") — và tuyên bố sai làm audit sau xếp hạng sai.

- **Remediation đề xuất:** hoặc kiểm `fs_scope` cho **đích** của `copy_file_atomic`, hoặc sửa comment cho đúng và ghi
  nhận là accepted risk có ý thức.

---

### §SEC.08 — 🟠 P2 — `release_resource_keys` không có trigger chống ghi lại khoá đã phát hành

- **Bằng chứng:** `[VERIFIED]` · **Vị trí:** `20260826120000_prynx_rk_grant_rebuild.sql:212-219`

RLS bật, deny-all, `revoke all` khỏi `public/anon/authenticated`, `grant all` cho `service_role` — phần này đúng.
Có unique index chống một khoá gán cho hai bản (`:174`) và chống hai hàng cùng bản (`:177`).

**Thiếu:** không có `BEFORE UPDATE ... RAISE`, không `REVOKE UPDATE (resource_key)` theo cột. Grep `create trigger`
toàn bộ migration → không có trigger nào trên bảng này. Bất biến "khoá bất biến theo bản" hiện chỉ được cưỡng chế ở
**tầng review migration** + một test so văn bản (`src/dielineResourceKeyGate.test.ts:1745` assert migration không chứa
`update release_resource_keys`).

- **Tác động:** bất kỳ ai/quy trình nào có `service_role` (Edge Function, `build_production.ps1`, key bị rò) ghi đè được
  `resource_key` của một bản đã phát hành ⇒ toàn bộ máy khách đang chạy bản đó mất khả năng mở engine dieline.
- **Remediation đề xuất:** trigger `BEFORE UPDATE` chặn thay đổi `resource_key` khi `revoked_at IS NULL`.

---

### §SEC.09 — 🟠 P2 — F4 vá một phần: `rk` vẫn thu gom được với tốc độ 72 bản/ngày

- **Bằng chứng:** `[VERIFIED]` · **Vị trí:** `license-verify/index.ts:191-192`, `:483-490`; `20260826120000:239-303`

Cổng `claim_rk_grant_v2` chống **burst**: `RK_BURST_WINDOW_MINUTES = 60`, `RK_BURST_VERSION_LIMIT = 3`. Migration
**cố ý bỏ trần tổng** (trước là 5 bản/30 ngày) vì nhịp phát hành thật ~10 bản/30 ngày nên trần tổng bắn vào chính khách
hàng — lý do ghi ở header `:15-21`. Ba luật phụ làm cổng có nghĩa: idempotent theo `(license_hash, product_id, app_version)`,
đếm theo license không theo máy, `pg_advisory_xact_lock` serialize đếm→chèn.

Số học còn lại: một license Pro hợp lệ rút được **3 bản/giờ, không trần trên theo thời gian dài**. Cổng chuyển từ
"chặn" sang "làm chậm + để lại dấu vết" (`prynx_rk_grants` + event `rk_cap_exceeded` `:531-544`) và phản ứng thủ công.

- **Đánh giá:** đây là đánh đổi **có chủ đích, có tài liệu** — không phải hồi quy. Ghi nhận để không quên: nếu mô hình
  đe doạ là "đối thủ mua một license Pro rồi kiên nhẫn thu khoá mọi bản", F4 vẫn mở.
- **Remediation (tuỳ chọn):** thêm trần mềm theo 30 ngày ở mức cao (ví dụ 15 bản) chỉ để **báo động**, không chặn.

---

### §SEC.10 — 🟠 P2 — F12 còn sống: `license-release` được cấp private key

- **Bằng chứng:** `[VERIFIED]` · **Vị trí:** `license-release/index.ts:43-51`

Function chỉ cần **verify** token nhưng vẫn đọc `LICENSE_SIGNING_KEY` rồi
`ed.getPublicKey(...)` để suy ra public key ⇒ mở rộng bán kính rò của private key vô ích.
Phần còn lại của function khá chắc (kiểm `exp`, trần lifetime 8 ngày khớp verifier client, so `m`/`k`/`p`, fail-closed
khi thiếu token).

- **Remediation đề xuất:** thêm secret `LICENSE_PUBLIC_KEY` và bỏ `LICENSE_SIGNING_KEY` khỏi function này.

---

### §SEC.11 — 🟡 P3 (accepted risk, nhắc lại vì đúng chủ đề) — Integrity exe/frontend không được cưỡng chế

- **Bằng chứng:** `[VERIFIED]` · **Vị trí:** `lib.rs:4903` (`verify_frontend_integrity`), nhánh no-op `:4941-4949`;
  `lib.rs:4975` (`log_self_exe_hash` — chỉ `log::warn!`)

Tauri v2 **nhúng** `dist/` vào `PrynX.exe` nên nhánh "không tìm thấy `dist/` → `return Ok(())`" **luôn** chạy trên bản
NSIS đã cài ⇒ VECTOR #4/#10 (patch JS bundle) **không được phủ**. Phần còn giữ giá trị: nếu kẻ nghịch **thêm** `dist/`
ra đĩa để tráo frontend thì nhánh trên buộc khớp hash (cửa "shadowing" vẫn đóng).

`verify_sidecar_integrity` (`:4850`) thì **chặn thật** và fail-closed đúng (hash lỗi → từ chối khởi động, `:4867-4881`).

**Đường crack hiện thực nhất vẫn là:** patch `PrynX.exe` để vô hiệu `verify_sidecar_integrity` → patch public key Ed25519
nhúng trong sidecar Nuitka → tự ký token `plan=pro`. Không có Authenticode thì không lớp nào chặn bước đầu.
Đây là quyết định 2026-07-25 "không làm" và vẫn còn nguyên. Không có gì trong code sửa được (chicken-egg: không nhúng
hash của exe vào chính exe đó).

- **Remediation:** code signing Authenticode + `WinVerifyTrust` lúc khởi động. Là quyết định chi phí, không phải kỹ thuật.

---

### §SEC.12 — 🟡 P3 — 33 JWT literal trong `product/**` chưa xác nhận `role` claim

- **Bằng chứng:** `[SUSPECTED]` — chủ ý **không** decode để không xử lý giá trị secret.
- Phân bố: `test_sepay.mjs:4`, `update-nav.mjs:5`, `product/LicenseBridge.ps1:23`,
  `product/PrintMonitorApp/core/license_manager.py:12`, ~26 file `.jsx` trong `product/**`.
- Theo ngữ cảnh (script phân phối cho người dùng cuối) gần như chắc là **anon key** — công khai theo thiết kế. Nhưng
  **không chứng minh được** rằng không có cái nào là `service_role`.
- **Việc cần làm:** decode local từng cái, đọc claim `role`. Ưu tiên `LicenseBridge.ps1:23` và
  `license_manager.py:12` (code hạ tầng, không phải script khách). Nếu có bất kỳ cái nào là `service_role` thì đó là
  compromise toàn hệ thống (bypass mọi RLS → đọc `release_resource_keys` → lấy khoá engine dieline) và phải rotate +
  rewrite history.
- Xác nhận sạch: `LICENSE_SIGNING_KEY` không có literal nào trong repo; `sbp_` 0 match.

---

### §SEC.13 — 🟡 P3 — `FEATURE_GATING_ENABLED` mặc định TẮT khi chạy từ source

- **Bằng chứng:** `[VERIFIED]` · **Vị trí:** `backend/app/core/feature_entitlements.py:8-16`

Binary compiled/frozen ⇒ luôn `True` (đúng, fail-closed). Chạy từ source ⇒ đọc
`PRYNX_FEATURE_GATING_ENABLED`, **mặc định `"false"`** ⇒ `can_use_feature()` trả `True` cho **mọi** feature.
Cộng với `require_license` ở dev thiếu credential trả `{"plan": "dev", "features": ["*"]}` (`license_guard.py:561-562`).

Không phải lỗ production. Ghi nhận vì nó tạo **an toàn giả trong dev/test**: một lỗ kiểu §SEC.01 chạy thử ở dev sẽ
"hoạt động bình thường" và không ai thấy gì sai.

---

### §SEC.14 — 🟡 P3 — Thiếu test 403 cho các router mới; test cut_export vô hiệu hoá guard

- **Bằng chứng:** `[VERIFIED]` (grep toàn `backend/tests`, chỉ 16 file chứa `403`)
- **Có test tốt:** `test_free_token_e2e.py:124-196` (E2E ký HMAC + token Ed25519 thật),
  `test_mixed_nesting_feature_gate.py`, `test_logo_rebuild_feature_gate.py`, `test_dieline_feature_gate.py`,
  `test_feature_entitlements.py`.
- **Thiếu hẳn:** `sticker_sheet` (`test_sticker_sheet_api.py` 2133 dòng, **0 assert 403** cho 10 route
  `prepress.cutline`), `document_tools`, `document_cleanup`, `office_convert` (non-batch), và **không có file test nào**
  cho `combine_jobs`.
- **Phản tác dụng:** `backend/app/workers/cut_export/tests/test_api.py:20` override `require_license = lambda: True`
  ⇒ chỉ chứng minh happy path, không thể phát hiện §SEC.01.

---

### §SEC.15 — 🟡 P3 — `save_as_only` chỉ là hint gửi renderer

- **Bằng chứng:** `[VERIFIED]` · **Vị trí:** `document_window_registry.rs:72`, set ở `:618`

Không có enforcement native nào chặn cửa sổ nhân bản ghi đè file gốc. Với giả định renderer không tin cậy thì cờ này
bằng 0 giá trị bảo mật. Liên quan trực tiếp spec `save-as-artifact-guard` đang mở.

---

## 3. Đề xuất thứ tự sửa theo lô (≤5 file/lô, verify xong mới sang lô kế)

| Lô | Nội dung | File | Verify |
|---|---|---|---|
| **A** | §SEC.01 — gate `impo.cnc` cấp router + test 403 | `backend/app/workers/cut_export/api.py`, `backend/app/workers/cut_export/tests/test_api.py`, `backend/tests/test_free_token_e2e.py` | pytest phạm vi cut_export + e2e |
| **B** | §SEC.04 — vá `is_sensitive_path` tại gốc + gọi `is_network_or_device_path` ở nhóm command còn hở | `desktop/src-tauri/src/lib.rs`, `src/external_app.rs` | `cargo test --lib`, `cargo check` |
| **C** | §SEC.05 + §SEC.07 — siết `launch_external_app` theo id, kiểm `fs_scope` cho đích `copy_file_atomic` | `desktop/src-tauri/src/external_app.rs`, `src/lib.rs`, `src/document_window_registry.rs` | `cargo test --lib` |
| **D** | §SEC.02 + §SEC.08 — REVOKE `anon`, advisory lock activation, đảo thứ tự IP, trigger khoá bất biến | migration mới ở `printsolutions-main` | review SQL + **cần bạn duyệt trước khi push** |
| **E** | §SEC.06 + §SEC.10 — fail-closed `bin-packing` + trần input; bỏ private key khỏi `license-release` | `supabase/functions/bin-packing/index.ts`, `supabase/functions/license-release/index.ts` | deploy do bạn thực hiện |
| **F** | §SEC.03 — dump `verify_license_edge` về repo thành migration + cập nhật `security-manifest.json` | `printsolutions-main/supabase/**` | đối chiếu schema |
| **G** | §SEC.14 — bổ sung test 403 cho router thiếu; thêm **ratchet CI**: mọi feature trong `PRO_FEATURES` phải xuất hiện trong ít nhất một `require_feature`/`enforce_feature` | `backend/tests/**`, `.github/workflows/ci.yml` | pytest + CI |

Lô **G** là lô quan trọng nhất về dài hạn: nó biến "quy ước" thành "cưỡng chế", tức là đóng luôn class lỗi của §SEC.01
thay vì chỉ đóng một instance.

---

## 4. Coverage đã đạt

- **Đã rà:** `main.py` (middleware, mount, route trực tiếp), 21 router + toàn bộ decorator route và signature,
  `license_guard.py` (HMAC/nonce/clock guard/token Ed25519/entitlement), `feature_entitlements.py`,
  56 Tauri command trong `generate_handler!`, `is_sensitive_path`/`is_sensitive_write_path` + mọi call-site,
  `document_window_registry.rs`, `capabilities/default.json` ⇄ `tauri.conf.json` assetProtocol (đối chiếu 28 pattern,
  ratchet CI đang **pass**), `external_app.rs`, 3 hàm integrity, `api.ts` (F10), 10 edge function,
  `supabase/migrations/` từ 2026-07 tới nay, `release_resource_keys` + `prynx_rk_grants`,
  `verify_license`/`verify_license_guarded`.
- **Không rà (ngoài phạm vi đợt này):** engine xử lý PDF/ảnh (parser fuzzing), `preflight.py` đối chiếu từng path với
  `_PREFLIGHT_ROUTE_FEATURES`, owner-isolation chi tiết của các route license-only
  (`results.py:244`, `vdp.py:713`, `mixed_nesting.py:640`), `print_worker.rs::run_isolated`,
  `print_pdf_direct` (`print.rs:1293`), `security.rs::get_credential_path`, `build_production.ps1`.

## 5. Proof gap (không được suy thành "đã an toàn")

1. **Không chạy test/runtime nào** trong đợt này — theo AGENTS.md quy tắc 5, vitest/pytest phải chạy trên Windows thật;
   tôi chọn không chạy để giữ đợt này là đọc-only. Mọi finding là phân tích tĩnh.
2. **Trạng thái production Supabase** — migration nào đã `db push`, GRANT thật của `verify_license_edge`/
   `verify_license_guarded`, cờ `verify_jwt` thật của `bin-packing`/`qr-redirect`/`scheduled-cleanup`,
   số hàng `legacy_fallback` (migration `20260826120000:83-85` đặt điều kiện hậu-deploy là **phải đúng bằng 1**).
3. **Hành vi trên bản đã cài** — `verify_frontend_integrity` đi nhánh nào thật,
   `PRYNX_SIDECAR_HASH`/`PRYNX_FRONTEND_HASH` có được set không, đường IN với `PRYNX_MITIGATIONS`.
4. **`role` claim của 33 JWT literal** (§SEC.12) — cố ý không decode.
5. **PoC của §SEC.04** — chưa chạy thử `\\?\` để xác nhận runtime; kết luận dựa trên việc **không có lớp nào chuẩn hoá
   trước khi so chuỗi**.
6. **Working tree không sạch** — có WIP chưa commit; finding trên code WIP có thể lệch so với bản sẽ phát hành.

---

## 6. Điều KHÔNG kết luận

Không kết luận "hệ thống an toàn". Kết luận đúng phạm vi: **lớp mật mã (token Ed25519 + resource key) không có đường
crack rẻ; lỗ thực tế nằm ở khe cưỡng chế logic, và đợt này tìm được một khe P0 cùng một đường đi vòng P1.**
Trần cố hữu của phần mềm cài máy khách vẫn đúng như tài liệu đã thừa nhận (~8/10): kẻ có binary và chịu khó luôn mở
được Pro **trên máy của hắn**.
