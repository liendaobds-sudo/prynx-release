# Security Audit — printsolutions-main (license/payment server) — 2026-06-20

> Repo: `D:\printsolutions-main` (remote: github.com/KhanhPVN123/printsolutions) — Supabase
> (project ryvyuxjgdcvoxujqmggm) + Vercel. Đây là nơi cấp/ký license token cho PrynX.
> Phương pháp: đọc code thật qua shell (workspace-restricted nên không dùng dedicated tools).
> Secret được CHE khi in (chỉ phân loại role, không lộ giá trị). `[VERIFIED]` = đã đọc/ giải mã;
> `[SUSPECTED]` = suy luận; `[CHƯA kiểm]` = chưa xác minh (cần Supabase live / network).

---

## 0. TL;DR — 2 lỗ 🔴 phải xử NGAY

1. 🔴 **service_role key bị hardcode + commit vào git** (`check_sepay.mjs:4`) → toàn quyền DB.
2. 🔴 **Edge function `debug-sepay` không xác thực**, dump `orders` + `sepay_transactions` (PII khách + thanh toán) bằng service_role.

Cả hai đều cho phép truy cập/khai thác dữ liệu khách + license mà không cần đăng nhập.

---

## 1. 🔴 CRITICAL — service_role key hardcode trong git

**Bằng chứng [VERIFIED]:** `check_sepay.mjs` dòng 4:
```js
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJ...<219 ký tự, role=service_role>';
```
- File **đang được track** (`git ls-files --error-unmatch check_sepay.mjs` = có) → nằm trong lịch sử git + đã push lên GitHub.
- Giải mã payload JWT → `role: service_role`. Key này **bypass toàn bộ RLS**: đọc/ghi mọi bảng (licenses, orders, customers, payments, security_logs). Kẻ có key = cấp/thu hồi license tùy ý, dump toàn bộ PII khách, sửa đơn hàng.

**Khắc phục (theo thứ tự):**
1. **ROTATE service_role key NGAY** trên Supabase (Settings → API → reset). Key cũ xem như đã lộ.
2. Gỡ literal khỏi `check_sepay.mjs` (chỉ đọc từ `process.env`, bỏ fallback).
3. **Purge khỏi git history** (BFG / `git filter-repo`) rồi force-push; nếu repo public → coi như đã lộ vĩnh viễn, rotate là bắt buộc.
4. Kiểm tra access log Supabase xem key có bị dùng từ IP lạ không.
5. Đặt repo **private** nếu đang public.

> Lưu ý: các file khác (`test_sepay.mjs`, `update-nav.mjs`, `product/LicenseBridge.ps1`,
> `product/PrintMonitorApp/core/license_manager.py`, `*.jsx`) chỉ chứa **anon key** —
> public-by-design, chấp nhận được (nhưng vẫn nên dựa RLS chặt, xem mục 5).

---

## 2. 🔴 CRITICAL — debug-sepay: endpoint dump dữ liệu không xác thực

**Bằng chứng [VERIFIED]:** `supabase/functions/debug-sepay/index.ts` (33 dòng) —
KHÔNG có bất kỳ kiểm tra auth nào, dùng `SUPABASE_SERVICE_ROLE_KEY`, trả về:
```js
.from('sepay_transactions').select('*').limit(10)   // giao dịch ngân hàng
.from('orders').select('*').limit(10)               // đơn hàng: tên, email, sđt khách...
```
Ai biết URL function đều gọi được → lộ PII khách + dữ liệu thanh toán. Service_role bypass RLS nên RLS không cứu được.

**Khắc phục:** **XÓA function này** (hoặc undeploy ngay). Nếu cần debug → bọc auth admin (JWT role check) + KHÔNG dùng service_role để select *. `[CHƯA kiểm]` trạng thái deploy thực tế trên Supabase — kiểm bằng `supabase functions list`.

---

## 3. 🟠 HIGH — sepay-webhook: auth fail-OPEN + cấp license tự động

**Bằng chứng [VERIFIED]:** `supabase/functions/sepay-webhook/index.ts`:
```js
if (settings.sepay_api_key && apiKey !== settings.sepay_api_key) { return 401; }
```
- Auth chỉ chạy **nếu** `sepay_api_key` đã cấu hình. Nếu trống/null → **bỏ qua kiểm tra hoàn toàn** → webhook nhận POST từ bất kỳ ai.
- Hệ quả: kẻ gian POST payload giả (biết `order_code` của 1 đơn pending + `transferAmount` khớp ±1000đ) → match đơn → `confirm_order` → **cấp license + gửi email license MIỄN PHÍ**. Toàn bộ đường tiền→license bị qua mặt.
- Phụ: log lỗi in cả key kỳ vọng: `console.error('Invalid API key', { received, expected })` → lộ `sepay_api_key` vào function logs. So sánh key không hằng-thời-gian (timing, nhỏ).

**Khắc phục:**
1. **Fail-CLOSED:** nếu `sepay_api_key` chưa cấu hình → **từ chối** (500/401), KHÔNG xử lý. Bắt buộc phải có key.
2. Bỏ `expected` khỏi log.
3. Dùng so sánh hằng-thời-gian (HMAC/crypto.subtle).
4. Tốt nhất: xác thực theo **chữ ký SePay** (nếu SePay hỗ trợ signed webhook) thay vì shared key trong DB.
5. `[CHƯA kiểm]` runtime: `sepay_api_key` hiện đã set chưa — kiểm ngay (đây là điều kiện sống còn của lỗ này).

---

## 4. 🟠 license-verify — tốt phần lõi, vài điểm cần siết

**[VERIFIED] Tốt:** private key đọc từ `Deno.env.get("LICENSE_SIGNING_KEY")` (KHÔNG hardcode);
chỉ ký token khi RPC `verify_license` trả `VALID`; ký Ed25519 đúng định dạng khớp verifier Python.

**Cần siết:**
- 🟠 **`client_signal` ghi `security_logs` KHÔNG xác thực** — ai cũng gọi endpoint với `client_signal` tùy ý → **flood/đầu độc** bảng log (làm nhiễu forensic, phình DB). → rate-limit theo IP + validate `event_type` whitelist.
- 🟠 **Token TTL = 7 ngày** (`7*24*60*60`). Thu hồi license trễ tới 7 ngày (client offline vẫn chạy). Cân nhắc rút ngắn (vd 24–48h) — đánh đổi với offline.
- 🟢 **CORS `*`** trên cả license-verify/sepay-webhook/debug-sepay — với endpoint công khai thì chấp nhận, nhưng nên giới hạn origin nếu có thể.
- 🟢 catch trả `error.message` ra client (rò nhẹ nội bộ) — nên generic.

---

## 5. CHƯA kiểm kỹ (cần pass sâu hơn / Supabase live)

- **RLS cuối cùng** của `licenses`/`orders`/`customers`/`security_logs`: có migration `20260212_fix_licenses_rls_critical.sql` + `021/022/023_*security*` + `20260213_security_logs_hardening.sql` (dấu hiệu đã từng vá lỗ RLS nghiêm trọng — khớp doc PrynX Mục 8.1.B). **Chưa trace trạng thái RLS hiện hành** từng bảng → cần đọc các migration mới nhất + verify trên live (anon đọc được gì).
- **RPC `verify_license`**: rate-limit (doc nói 10/min/IP), device-limit, SECURITY DEFINER + GRANT — chưa đọc nội dung file `018/20260117223000/20260214` trong lượt này.
- **send-license-email, order-lookup, qr-redirect, scheduled-cleanup, bin-packing**: chưa audit (order-lookup có thể lộ đơn theo mã đoán được; bin-packing có thể là compute endpoint).
- **Repo public hay private** trên GitHub: `[CHƯA kiểm]` (cần network) — quyết định mức độ khẩn của #1.
- `dump.sql`, `recover_keys.cjs`, `supabase_create_tables.sql`: chưa kiểm có chứa dữ liệu/khoá thật không.

---

## 6. Ưu tiên xử lý

| # | Mức | Việc | Ghi chú |
|---|---|---|---|
| 1 | 🔴 | Rotate service_role key + gỡ literal + purge history | KHẨN — key đã lộ |
| 2 | 🔴 | Xóa/undeploy `debug-sepay` | KHẨN — lộ PII |
| 3 | 🟠 | sepay-webhook fail-closed khi thiếu api key + bỏ log key | Chặn cấp license free |
| 4 | 🟠 | Rate-limit + whitelist `client_signal` ở license-verify | Chống flood log |
| 5 | 🟠 | Xác nhận RLS các bảng nhạy cảm (anon đọc được gì) | Cần pass sâu |
| 6 | 🟢 | Rút TTL token; siết CORS; generic error | Tùy chọn |

> Tôi mới audit **crown jewels** (rò secret, ký token, thanh toán→license, debug dump).
> Phần RLS đầy đủ + các edge function còn lại + xác minh trên Supabase live cần một pass riêng.


---

## 7. Pass sâu (a) — RLS + RPC (2026-06-20, đọc migration thật)

### 7.1 🔴 NEW — `site_settings` lộ secret webhook cho anon
**[VERIFIED]:**
- `035_credit_system_sepay.sql`: `ALTER TABLE site_settings ADD COLUMN sepay_api_key TEXT; ... sepay_webhook_secret TEXT;`
- `20260108104709_remix_migration_from_pg_dump.sql:1622`: `CREATE POLICY "Anyone can read site settings" ON site_settings FOR SELECT TO authenticated, anon USING (true);`
- **KHÔNG migration nào DROP policy này** (grep `DROP POLICY ... site_settings` = rỗng). Thứ tự lexicographic: remix (`20260108…`) chạy SAU các file số (`035…`), `022_phase2` chỉ THÊM policy admin-manage, không gỡ anon-read.
- ⇒ Anon (anon key công khai) `GET /rest/v1/site_settings?select=sepay_api_key,sepay_webhook_secret` **đọc được secret**. RLS là row-level nên policy USING(true) lộ MỌI cột kể cả secret.
- **Hệ quả:** vô hiệu hoá Patch 3 — kẻ gian đọc `sepay_api_key` rồi gửi webhook "hợp lệ" → confirm đơn → **license free**. `sepay_webhook_secret` cũng lộ.
- `[CHƯA kiểm live]` — xác nhận: `curl '.../rest/v1/site_settings?select=sepay_api_key' -H "apikey: <ANON>"` phải KHÔNG trả giá trị.

**Khắc phục (SQL) — tách secret ra bảng admin-only (service_role vẫn đọc được vì bypass RLS):**
```sql
-- 1) Bảng cấu hình bí mật, KHÔNG anon/authenticated nào đọc.
CREATE TABLE IF NOT EXISTS public.payment_secrets (
  id int PRIMARY KEY DEFAULT 1,
  sepay_api_key text,
  sepay_webhook_secret text,
  CONSTRAINT singleton CHECK (id = 1)
);
ALTER TABLE public.payment_secrets ENABLE ROW LEVEL SECURITY;
-- chỉ admin đọc/ghi; service_role (edge function) bypass RLS nên vẫn dùng được.
CREATE POLICY "admin manage payment_secrets" ON public.payment_secrets
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
-- 2) Chuyển dữ liệu hiện có sang.
INSERT INTO public.payment_secrets (id, sepay_api_key, sepay_webhook_secret)
SELECT 1, sepay_api_key, sepay_webhook_secret FROM public.site_settings LIMIT 1
ON CONFLICT (id) DO UPDATE SET sepay_api_key=EXCLUDED.sepay_api_key, sepay_webhook_secret=EXCLUDED.sepay_webhook_secret;
-- 3) Xoá cột secret khỏi bảng public.
ALTER TABLE public.site_settings DROP COLUMN IF EXISTS sepay_api_key;
ALTER TABLE public.site_settings DROP COLUMN IF EXISTS sepay_webhook_secret;
```
Rồi sửa `sepay-webhook` đọc `from('payment_secrets')` thay vì `site_settings`. (Nếu không muốn tách bảng: tối thiểu `DROP POLICY "Anyone can read site settings"` + tạo VIEW công khai chỉ cột không nhạy cảm cho frontend.)

### 7.2 ✅ Đã ổn (verify bằng migration)
- **licenses RLS:** lỗ `USING(true)` bị tái tạo ở `20260121_fix_rls_security_warnings.sql` NHƯNG `20260212_fix_licenses_rls_critical.sql` (chạy sau) đã DROP → trạng thái cuối: chỉ owner-email + admin đọc. ✓
- **security_logs:** chỉ service_role ghi, chỉ admin đọc (`20260213`). ✓
- **license_logs:** anon-insert bị gỡ ở `20260212`. ✓
- **verify_license RPC:** CÓ rate-limit (`RATE_LIMITED`, index `idx_license_logs_rate_limit`, `012`) + device limit (`max_activations`/`MAX_ACTIVATIONS_REACHED`, `010/011`). ✓ → brute-force key + share máy bị chặn server-side.
- **USING(true) khác** (seasonal_themes, animated_banners, partner_logos, knowledge_resources, kprint_*, license_products, tools): nội dung CMS công khai → chấp nhận.

### 7.3 [CHƯA kiểm] còn lại
- Edge functions `order-lookup` (lộ đơn theo mã đoán?), `send-license-email`, `qr-redirect`, `scheduled-cleanup`, `bin-packing`.
- `orders`/`customers` RLS cuối cùng (PII) — chưa trace từng policy.
- `dump.sql`, `recover_keys.cjs`, `supabase_create_tables.sql` có dữ liệu/khoá thật không.
- Xác minh các kết luận RLS trên Supabase LIVE (đọc thử bằng anon key).


---

## 8. Pass sâu (a) tiếp — edge functions còn lại + orders RLS

### 8.1 ✅ Đã ổn (verify bằng code)
- **`orders` RLS:** tiến hóa 001 (mở) → 002 (gỡ "view by code") → `021_security_audit_remediation` (cuối): **"Owner or admin can read orders"** + "Admin can manage" + anon CHỈ được tạo đơn (checkout). Không anon-read trực tiếp. ✓ (Caveat: remix `20260108` chạy sau theo thứ tự — nên verify live không có policy mở nào tái sinh.)
- **`order-lookup`:** service_role nhưng gọi qua RPC `get_order_by_code` (CÓ rate-limit → 429). PII chỉ ra theo mã đơn + bị giới hạn tần suất. 🟢 catch trả `error.message` (rò nhẹ).
- **`send-license-email`:** xác thực chắc — `token === service_role` (edge-to-edge) HOẶC verify JWT + check `user_roles.role='admin'` (else 403). HTML-escape nội dung (chống XSS). KHÔNG gọi trực tiếp để spam/lộ key được. ✓
- **`qr-redirect`:** chỉ select `target_url,is_active` → lộ tối thiểu. 🟢 (open-redirect theo thiết kế tính năng QR động).

### 8.2 🟢 Config hygiene — `config.toml`
- Chỉ `[functions.debug-sepay]` có block (`verify_jwt = true`). LƯU Ý: `verify_jwt=true` **vẫn cho qua nếu gửi anon key** (anon key là JWT hợp lệ, công khai) → không chặn được #2.
- Các function khác (license-verify, sepay-webhook, send-license-email, order-lookup, qr-redirect) KHÔNG có block → `verify_jwt` theo default. `sepay-webhook` cần `verify_jwt=false` (SePay gọi ngoài, không có Supabase JWT) — biên giới thật của nó là api-key (đang fail-open, mục 3).
- **Khuyến nghị:** khai báo `verify_jwt` tường minh cho TỪNG function trong config.toml; đảm bảo logic auth nội bộ (api-key/admin) là lớp chặn thật, không dựa verify_jwt.

### 8.3 [CHƯA kiểm] còn lại (mức thấp)
- `scheduled-cleanup`, `bin-packing` (compute), `debug-sepay/deno.json`.
- `customers` table RLS cụ thể (orders đã che phần lớn PII; customers nên kiểm riêng).
- Nội dung `dump.sql` / `recover_keys.cjs` / `supabase_create_tables.sql` (có khoá/dữ liệu thật?).
- **Xác minh LIVE** (bằng anon key) cho 3 critical: site_settings, debug-sepay, orders.

---

## 9. TỔNG KẾT printsolutions (cả 2 pass)

**🔴 phải xử trước (theo thứ tự):**
1. Rotate service_role key (lộ ở `check_sepay.mjs`, git) + gỡ literal + purge history.
2. Xóa `debug-sepay` (dump orders+transactions; anon-key truy cập được).
3. Tách `sepay_api_key`/`sepay_webhook_secret` khỏi `site_settings` (anon đọc được) — SQL ở Mục 7.1.

**🟠 nên xử:**
4. `sepay-webhook` fail-closed khi thiếu api key + bỏ log key (Patch 3).
5. `license-verify` whitelist `client_signal` + (tùy) rút TTL (Patch 4).

**✅ Đã tốt (không cần sửa):** RLS licenses/security_logs/license_logs/orders; `verify_license` có rate-limit + device-limit; `send-license-email` auth chắc + escape; `license-verify` giữ private key trong env, chỉ ký khi VALID; order-lookup/qr-redirect phơi bày tối thiểu.

> Kết luận: phần SERVER (printsolutions) về thiết kế bảo mật **khá vững** (RLS đã được vá nhiều vòng, RPC gate đúng, token ký server-side). Rủi ro thực còn lại tập trung ở **3 lỗ vận hành/cấu hình** (#1 key lộ, #2 debug endpoint, #3 secret trong bảng public) — đều sửa nhanh và không đụng kiến trúc.


---

## 10. XÁC MINH LIVE (anon key public, GET read-only) — 2026-06-20 [VERIFIED]

Gọi thật tới `ryvyuxjgdcvoxujqmggm.supabase.co` bằng anon key (che giá trị secret):

| Test | Kết quả LIVE | Verdict |
|---|---|---|
| `GET /rest/v1/site_settings?select=sepay_api_key` | HTTP 200, **sepay_api_key LỘ = TRUE** | 🔴 **VERIFIED** — anon đọc được api key thanh toán |
| `GET /rest/v1/orders?select=order_code,customer_email` | HTTP 200, **DATA_LEAK** | 🔴 **VERIFIED MỚI** — anon đọc được đơn + email khách (PII) |
| `GET /rest/v1/licenses?select=license_key` | HTTP 200, **[] EMPTY_SAFE** | ✅ fix RLS licenses CÓ hiệu lực live |
| `GET /functions/v1/debug-sepay` | HTTP 200, **dumps_data=TRUE** (4958 byte) | 🔴 **VERIFIED** — dump orders+transactions cho anon |

### ⚠️ Đính chính kết luận Mục 8.1 (orders)
Phân tích migration trước đó kết luận `orders` chỉ owner/admin đọc — **SAI so với live**. Live cho thấy **anon đọc được orders** (email khách + order_code). Nguyên nhân khả dĩ: remix migration `20260108…` (chạy sau `021`) hoặc thay đổi dashboard đã tái mở policy, HOẶC RLS orders chưa bật. → **Bài học: luôn verify bằng artifact, không tin thứ tự migration.**

**Khắc phục orders (chạy trên Supabase SQL Editor):**
```sql
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
-- Gỡ MỌI policy đọc mở:
DROP POLICY IF EXISTS "Anyone can view orders by code" ON public.orders;
DROP POLICY IF EXISTS "Anyone can view orders"        ON public.orders;
DROP POLICY IF EXISTS "Public can view orders"        ON public.orders;
-- Giữ: owner-or-admin read (021) + anon create. Kiểm lại bằng:
--   SELECT policyname, cmd, roles, qual FROM pg_policies WHERE tablename='orders';
```

### Tổng kết LIVE: 3/4 critical CONFIRMED khai thác được ngay (site_settings, orders, debug-sepay). licenses đã an toàn.
