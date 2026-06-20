# Security Audit (independent, code-verified) — 2026-06-20

> **Khác biệt với `SECURITY_ARCHITECTURE.md`:** tài liệu kia do dự án tự viết (self-report).
> Báo cáo này **trace code thật** theo `audit-rules` (verify-to-ground-truth), gắn nhãn
> `[VERIFIED]` (đã đọc/đối chiếu code) vs `[SUSPECTED]` (suy luận, chưa chứng minh trong session)
> vs `[CHƯA kiểm]`. Severity chỉ gắn SAU khi có bằng chứng.
> **Phạm vi:** license_guard.py, security.rs, lib.rs, main.tsx, useAuthStore.ts, config.py,
> main.py, ws.py, toàn bộ routes. **Không** chạy crack thật; **không** truy cập repo
> `printsolutions-main` / Supabase live / bản release đã build.

---

## 0. Kết luận 1 dòng

Phòng thủ đạt mức **răn đe thương mại**: **chống keygen tốt** (Ed25519), **chống share key khá** (HWID+token), nhưng **không chống nổi reverser có kỹ năng** vì **toàn bộ enforcement chạy Ring-3 trên máy khách** — đây là trần cố hữu, không phải bug. Cảm giác "mong manh" **đúng một phần**: vài lớp là "theater", + 1 default fail-open.

---

## 1. Đã VERIFIED là TỐT (không phải chỉ doc nói)

| # | Hạng mục | Bằng chứng (file) | Trạng thái |
|---|---|---|---|
| S1 | **Mọi endpoint API đều gate `require_license`** (router-level: imposition, cut_export, preflight, pdf_tools, export, edit; per-route: upload, system, vdp, results, report, qc, compare) | grep toàn bộ `routes/*` + `APIRouter(` | [VERIFIED] |
| S2 | **WebSocket gate** `verify_sidecar_signature` (token+HMAC qua query), đóng `4001` nếu sai | `ws.py` | [VERIFIED] |
| S3 | **Wiring release THẬT chạy** (không phải dead-code): anti-debug 5s, `SetProcessMitigationPolicy` (signed-only + no-dynamic-code), `verify_frontend_integrity`, `verify_sidecar_integrity`, `SetAreDevToolsEnabled(false)` — đều gọi trong `setup()` dưới `#[cfg(not(debug_assertions))]` | `lib.rs` L806–963 | [VERIFIED] |
| S4 | **Enforce token BẬT ở release**: spawn sidecar set `("PRYNX_ENFORCE_LICENSE_TOKEN","true")` + `("DEV_MODE","false")` | `lib.rs` L928–937 | [VERIFIED] |
| S5 | **Ed25519 verify đúng** (sig + exp + ràng HWID `m` + hash key `k`); public key **nhúng cứng**, env chỉ override khi DEV_MODE | `license_guard.verify_license_token`, `_LICENSE_PUBLIC_KEY_B64` | [VERIFIED] |
| S6 | **`_is_dev_mode` fail-closed trong binary compiled** (`"__compiled__" in globals() or sys.frozen` → False) | `license_guard._is_dev_mode` | [VERIFIED code] / phụ thuộc Nuitka chèn `__compiled__` → [SUSPECTED reliable] |
| S7 | **CORS hardcode allowlist** (`tauri.localhost`), cố ý bỏ `settings.CORS_ORIGINS`; không `*` | `main.py` L108–115 | [VERIFIED] |
| S8 | **DPAPI** cho license/timestamp/token; token ràng HWID nên copy sang máy khác vô dụng | `security.rs` | [VERIFIED] |
| S9 | Không tìm thấy endpoint `/debug` `/test` mở | grep `main.py`/routes | [VERIFIED] |

➡️ Khẳng định ở lượt trước rằng "độ phủ chưa chắc" — nay **bác bỏ**: độ phủ gate **đầy đủ**. Đây là điểm mạnh thật.

---

## 2. Phát hiện (severity sau bằng chứng)

### F1 — 🟠 `sign_api_request` bỏ qua Gate license khi key RỖNG
`security.rs`:
```rust
if !is_valid && !license_key.is_empty() {   // key="" → cả biểu thức = false → KHÔNG chặn
    return Err("License not validated in Rust cache");
}
```
Gọi `sign_api_request(path, "")` → vượt Gate 1, trả HMAC headers hợp lệ. **[VERIFIED]**
*Tác động thực:* hạn chế — ở sidecar vẫn cần `X-License-Key`/`X-Hardware-Id` (thiếu → 401) và token Ed25519 (enforced → 403). Nhưng là **lỗi logic** + cho thấy "Rust license gate" không phải biên giới thật.

### F2 — 🟠 "Rust license cache gate" là theater
`register_validated_key(key)` do **frontend gọi**, Rust **không** re-verify với Supabase. Client crack gọi `register_validated_key("bất_kỳ")` → cache hợp lệ → `sign_api_request` ký. **[VERIFIED]** (doc Mục 9.1 cũng thừa nhận). ⇒ HMAC sidecar token **không** chặn được client bị crack, chỉ chặn caller NGOÀI.

### F3 — 🟡 `DEV_MODE` mặc định = TRUE (fail-open)
`config.py`: `DEV_MODE: bool = True`; `backend/.env`: `DEV_MODE=true`. Khi DEV_MODE=on → `verify_sidecar_signature` & token check **bỏ qua hoàn toàn**. **[VERIFIED]**
*Release được cứu bởi 2 lớp*: `lib.rs` set env `DEV_MODE=false` + `_is_dev_mode` trả False khi `__compiled__`. Nhưng **mặc định nên fail-closed** (`= False`), để dev bật thủ công — tránh rủi ro 1 build lỡ tay/`__compiled__` không có là mở toang.

### F4 — 🟡 Sidecar token (X-PrynX-Token) lộ với attacker cục bộ
Token giải mã trong Rust rồi **trả cho JS** và **gửi plaintext qua loopback header**. XOR-mask trong RAM vô nghĩa tại điểm dùng. Bất kỳ tiến trình local / JS bị crack đều đọc được. **[VERIFIED]** ⇒ chỉ chống caller ngoài, **không** chống crack.

### F5 — 🟡 HWID dễ giả
`collect_hardware_fingerprint` = parse stdout PowerShell (`Get-CimInstance`) + `DefaultHasher` (non-crypto). Patch `get_hardware_id` trả hằng số / chặn WMI → giả HWID. **[VERIFIED]** (doc 9.5 nhận 🟡). Hệ quả: vượt "HWID limit 2 máy".

### F6 — 🟢 Online re-verify thực chất là cố vấn
`_verify_with_supabase`: thiếu creds → `return True`; lỗi mạng → except → grace `True`. Sidecar thường **không** có `SUPABASE_SERVICE_KEY` (chỉ ở edge function). ⇒ gate thời-gian-thực gần như không tham gia; tất cả dồn vào token Ed25519 enforced cục bộ. **[VERIFIED code]** / [SUSPECTED] về việc sidecar không có service key.

### F7 — 🟢 Integrity check no-op nếu build không set hash
`verify_sidecar_integrity`/`verify_frontend_integrity`: nếu `option_env!("PRYNX_SIDECAR_HASH"/"PRYNX_FRONTEND_HASH")` rỗng → cảnh báo & cho qua. **[VERIFIED code]**; việc build có set hay không = **[CHƯA kiểm]** (cần xem `build_production.ps1` chạy thật).

### F8 — 🟢 Rò rỉ phụ
- `main.tsx`: `Sentry.init({ sendDefaultPii: true })` → gửi PII lên Sentry (riêng tư, không liên quan crack). **[VERIFIED]**
- DPAPI ký qua nội suy chuỗi PowerShell (key escape `'`→`''`). Rủi ro injection thấp nhưng **mẫu mong manh** (shell-out để làm crypto). **[VERIFIED]**

---

## 3. Vì sao "mong manh" — phân tích cấu trúc (câu trả lời thật)

```
Đường crack rẻ nhất (xếp theo công sức):
1. Patch sidecar (Nuitka) để require_license/verify_license_token luôn pass
   └─ Chặn bởi: sidecar integrity SHA-256 (Rust) + anti-debug + mitigation
      └─ Nhưng các lớp đó CŨNG ở Ring 3 → patch tiếp Rust exe (NOP exit(1))
         └─ Trần vật lý: Ring 3 thua kernel/patch tĩnh. KHÔNG chặn tuyệt đối.
2. "Không có license" → buộc phải đi đường (1) vì token Ed25519 không giả được (tốt).
3. Share 1 license → chặn bởi HWID limit + token ràng HWID (khá), nhưng HWID giả được (F5).
```

**Bản chất:** điểm bất khả giả duy nhất = chữ ký Ed25519 (chặn **keygen**). Nhưng **việc THỰC THI** token đó là **code cục bộ patch được** (chặn **crack** thì không). Mọi lớp còn lại (Rust cache, HMAC token, XOR, anti-debug, HWID) **nâng chi phí**, không phải tường chặn. Đây là lý do điểm tự chấm của doc ~6.5–7/10 là **trung thực**.

---

## 4. GO / NO-GO theo loại mối đe doạ

| Mối đe doạ | Phán quyết | Lý do |
|---|---|---|
| **Keygen** (như ảnh TIFF Assembler) | **GO** (kháng tốt) | Ed25519 — không có private key thì không đẻ token |
| **Share key nhiều máy** | **GO có điều kiện** | HWID limit + token-HWID; yếu ở F5 (HWID giả được) |
| **Caller API ngoài (Fiddler/script)** | **GO** | sidecar token + HMAC + CORS + loopback-only |
| **Reverser kỹ năng cao patch binary** | **NO-GO** (cố hữu) | Ring 3; chỉ nâng chi phí, không chặn |
| **Tổng thể** | **Răn đe thương mại, KHÔNG bất khả phá** | đúng như doc; ~6.5–7/10 |

---

## 5. Khuyến nghị (ưu tiên)

**Sửa nhanh, rủi ro thấp:**
1. **F3:** đổi `config.py` `DEV_MODE` default → `False` (fail-closed); dev bật qua `.env`. (1 dòng)
2. **F1:** sửa Gate 1 — coi key rỗng là KHÔNG hợp lệ (`if !is_valid { return Err }`).
3. **F7:** xác nhận `build_production.ps1` thực sự set `PRYNX_SIDECAR_HASH` + `PRYNX_FRONTEND_HASH` (nếu không, integrity là theater).
4. **F8:** cân nhắc `sendDefaultPii: false` (riêng tư khách hàng).

**Cần làm trên hạ tầng (ngoài phạm vi session này — cần bạn):**
5. Kiểm chứng trên **bản release thật** theo checklist doc Mục 9.6 (security.log phải ghi `enforce=true dev_mode=False pubkey=embedded`; chạy sidecar trực tiếp phải 403).
6. Rotate 45 key từng phơi nhiễm (doc 8.6 #3) — xác nhận đã làm.
7. Code signing Authenticode.

**Nâng cấp căn cơ (phá trần Ring-3):**
8. **Mô hình lai server-side cho solver IP cao** (xem `HYBRID_ANTICRACK_REPORT.md`). Đây là **cách DUY NHẤT** vượt trần "client crack được": cái gì không ship binary thì không patch được. Các lớp client-side chỉ nên coi là **lớp làm-nản**, không phải lớp-chặn.

---

## 6. Việc tôi CHƯA kiểm (không dám khẳng định)

- Nuitka có chắc chắn chèn `__compiled__` vào `globals()` của *đúng module* `license_guard` không (F3/S6) — cần bản build thật.
- `build_production.ps1` có set 2 hash integrity không (F7).
- Edge function `license-verify` (repo `printsolutions-main`) có thật sự cấp token + ký đúng private key không — cần Supabase live.
- Chưa thử nghiệm crack thực tế (và sẽ không) — kết luận là phân tích cấu trúc, không phải PoC.
- Watermark forensics (`watermark.py`) chưa trace sâu trong lượt này.

---

## 7. Đã xử lý (2026-06-20) + lý do phần còn lại

| # | Trạng thái | Hành động |
|---|---|---|
| **F1** | ✅ **ĐÃ SỬA** | `security.rs`: gate `sign_api_request` đổi `if !is_valid && !key.is_empty()` → `if !is_valid` (key rỗng cũng bị từ chối). Frontend `getLicenseHeaders` bắt lỗi êm → dev vẫn chạy, release từ chối đúng. typecheck FE ✓. |
| **F3** | ✅ **ĐÃ SỬA** | `config.py`: `DEV_MODE` default `True → False` (fail-closed). Xác nhận dev vẫn `True` (đọc `.env`), `IS_DESKTOP_APP` giữ SQLite ở release → không gãy. |
| **F7** | ✅ **KHÔNG phải lỗi** | `build_production.ps1` L197–238 CÓ tính + set `PRYNX_SIDECAR_HASH`, `PRYNX_FRONTEND_HASH`, `DEV_MODE=false` trước build Tauri → integrity check có hiệu lực thật. [VERIFIED] |
| **F8** | ✅ **ĐÃ SỬA** | `main.tsx`: `Sentry.sendDefaultPii: true → false`. typecheck ✓. |
| **F2** | ⚠️ **Cấu trúc — KHÔNG sửa kiểu vá** | "Rust cache gate" vốn chỉ là defense-in-depth. Biên giới thật = token Ed25519 verify ở sidecar (S4, đang enforce). Thêm verify Ed25519 trong Rust = thêm crate `ed25519-dalek` + nhúng pubkey + code crypto **không build-test được trong session này** (Cargo.toml hiện không có ed25519) → rủi ro gãy build. Đề xuất làm riêng, build-test trên release. **Hiện đã được token Ed25519 ở sidecar che chắn.** |
| **F4** | ⚠️ **Cấu trúc — không thể "sửa"** | Token sidecar buộc phải gửi tới sidecar qua loopback → luôn lộ với attacker cục bộ. Đây là cơ chế chống caller-NGOÀI, không phải chống-crack. Bỏ token = mất luôn lớp chống caller ngoài. Không vá được mà không đổi mô hình. |
| **F5** | ⚠️ **ĐỔI LÀ VỠ license đang chạy** | HWID dễ giả, nhưng đổi cách tính HWID (PowerShell→WinAPI/thêm nguồn) sẽ **đổi giá trị hash** → mọi license đã kích hoạt lệch `m`/device-binding → khách hợp lệ bị khoá. Cần **migration có kế hoạch** (đọc HWID kiểu mới song song + chuyển dần), KHÔNG sửa nóng. |
| **F6** | 🟢 **Theo thiết kế** | "Offline grace trả True" là chủ ý (sidecar không có service key → tin token). Đã được token Ed25519 enforced che. Siết thêm dễ gãy luồng offline hợp lệ. Giữ. |

**Tóm lại:** sửa an toàn được **F1, F3, F8**; **F7** hoá ra không phải lỗi. **F2/F4/F5/F6** là **trần cấu trúc hoặc đổi-là-vỡ** — không nên "vá đại". Cách DUY NHẤT nâng trần thực sự vẫn là **mô hình lai server-side** (`HYBRID_ANTICRACK_REPORT.md`).

> ⚠️ Lưu ý kiểm chứng: F1 (Rust) chưa build release trong session này (release-only + nặng). Đoạn sửa nằm NGOÀI `#[cfg]` nên sẽ biên dịch như thường; cần `cargo build` thật xác nhận trước khi ship.

---

## 8. Đợt 2 — Vắt kiệt mô hình client (2026-06-20, dev chưa có khách)

> Bỏ qua mô hình lai. Tận dụng việc CHƯA có khách để làm cả các mục trước đó "đổi-là-vỡ".

| # | Trạng thái | Hành động + Verify |
|---|---|---|
| **F2** | ✅ **ĐÃ SỬA** (theater → gate thật) | `security.rs`: thêm `verify_token_with_pubkey` (Ed25519, đối xứng backend) + nhúng public key trust-anchor. `register_validated_key(license_key, hwid, token)` giờ **TỰ verify token Ed25519** trước khi cache → patch mỗi frontend không đủ, phải qua **cả Rust lẫn sidecar**. Frontend (`useAuthStore`) lấy token TRƯỚC rồi register kèm token+hwid. **6 unit test Rust PASS** (valid / tampered-sig / **wrong-signer = chống keygen** / expired / machine-mismatch / key-mismatch). Token rỗng (dev) vẫn cache → không gãy luồng cũ. Thêm crate `ed25519-dalek=2`. |
| **F5** | ✅ **ĐÃ SỬA** | `security.rs`: HWID bỏ `DefaultHasher` (SipHash — Rust **không** đảm bảo ổn định giữa toolchain → nâng cấp Rust có thể đổi mọi HWID, vỡ license) → **SHA-256** (crate `sha2` sẵn có), lấy 8 byte đầu giữ đúng 16 hex ký tự. Vừa sửa rủi ro ổn định, vừa dùng hàm băm crypto. `cargo check` sạch. |
| **F6** | 🟢 **Không làm — redundant** | Cho sidecar tự gọi RPC verify_license là **thừa**: token Ed25519 (đang enforce) ĐÃ là server-authoritative + TTL 2h ⇒ có token = Supabase đã xác nhận trong 2h gần nhất. Thêm RPC chỉ tăng phụ thuộc online, không tăng an toàn thực. |
| **F4** | ⚠️ **Vẫn cấu trúc** | Token sidecar qua loopback — không thể bỏ mà không mất lớp chống caller-ngoài. Giữ nguyên. |

**Verify đợt 2:** Rust `cargo test token_tests` = **6/6 pass**; `cargo check` sạch (chỉ warning có sẵn); frontend `npm test` = **333 pass**, `typecheck` sạch; backend `pytest` = **378 pass**. Không regression.

**Lưu ý ship:** thay đổi Rust nằm trong build release (Tauri). Cần `build_production.ps1` (release) thật để xác nhận end-to-end với token do edge function ký (session này chỉ verify logic bằng keypair test + token thật chưa chạy qua). Public key trong Rust (`LICENSE_PUBLIC_KEY_B64`) PHẢI khớp backend — đã copy đúng hằng số.

### Tổng kết trạng thái sau 2 đợt
- ✅ Đã xử lý: **F1, F2, F3, F5, F8** (đều verify được). **F7** = không phải lỗi.
- ⚠️ Còn lại (cố hữu): **F4** (loopback — trần cấu trúc), **F6** (bỏ vì redundant). Trần Ring-3 vẫn còn → muốn vượt phải dùng mô hình lai (đã gác theo yêu cầu).
- Mô hình client hiện đã được hardened tới mức hợp lý: 2 lớp enforce token độc lập (Rust + sidecar), HWID ổn định+crypto, fail-closed mặc định, gate license không còn lỗ key-rỗng.
