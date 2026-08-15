# PrynX — Threat model ngắn cho security review

**Cập nhật:** 2026-08-15

**Vai trò:** scan context ngắn, dùng trước mọi review/audit. `SECURITY_ARCHITECTURE.md` và code/test hiện tại giữ phần chi tiết; tài liệu này không thay thế bằng chứng.

## 1. Phạm vi hệ thống

- `D:\pdfcompare`: React/WebView, Tauri Rust, FastAPI sidecar localhost, Rust/PyO3/PDFium, engine xử lý file và pipeline build/release.
- `D:\printsolutions-main` khi workspace có sẵn: website, Supabase Edge Functions, PostgreSQL/RLS/RPC, thanh toán và cấp/thu hồi license.
- Môi trường mục tiêu chính: Windows desktop cài trên máy khách; sidecar bind `127.0.0.1:8321`.

## 2. Tài sản cần bảo vệ

- File PDF/ảnh/dữ liệu in của khách hàng, file tạm, kết quả xuất và đường dẫn cục bộ.
- License key, signed license token, HWID, sidecar/HMAC secret, activation slot, plan/feature entitlement.
- Ed25519 private signing key, Supabase service-role key, resource key bản phát hành, updater signing key và artifact.
- Thuật toán/IP khuôn bế, solver, binary/model đi kèm và thông tin chống crack.
- Log bảo mật, PII, thông tin đơn hàng/thanh toán và dữ liệu vận hành.

## 3. Đối thủ và input không tin cậy

- PDF, ảnh, SVG, CSV/XLSX, font, model hoặc tên/đường dẫn file được chế tạo độc hại.
- Renderer/WebView bị XSS, inject hoặc bị patch; frontend không phải biên cưỡng chế quyền.
- Tiến trình local khác gọi thẳng sidecar, chiếm port, replay request hoặc dò endpoint.
- Người dùng có toàn quyền trên máy Windows, debugger và khả năng patch/dump binary/RAM.
- Attacker internet gọi website/Edge/RPC bằng anon/auth key, request song song hoặc token/license bị lộ.
- PR, dependency, action, binary/model hoặc script build không tin cậy trong supply chain.

## 4. Trust boundary và entry point

1. **WebView → Tauri IPC**: mọi `invoke`, capability, shell/process, filesystem, deep-link/startup args và asset protocol. `grant_upscale_file_path` chỉ ký canonical image path đã nằm trong dynamic `plugin-fs` scope do picker/native drop cấp; renderer không tự biến một chuỗi path thành capability.
2. **Tauri → FastAPI sidecar**: HTTP/WS localhost, CORS/origin, HMAC header, timestamp, nonce, method/path/body binding và startup challenge. Trước khi ký, native đối chiếu hash token hiện tại của request với binding license đã verify; token đổi giữa phiên buộc đăng ký lại cache rồi mới được ký. Nếu sidecar chết sau startup, supervisor chỉ spawn thế hệ mới sau khi port rảnh và startup proof khớp secret; không tự ý kill listener không xác thực. Fast-path Upscale dùng grant HMAC riêng, bind `path + tab + iat/exp + nonce`, dùng một lần; production dùng secret stdin, `run_dev.bat` sinh secret theo từng phiên cho hai process cùng kế thừa.
3. **Sidecar → native/parser**: PyO3, PDFium, pypdfium2, subprocess/PowerShell, codec, model/font/PDF parser và worker/process boundary.
4. **Client → PrintSolutions/Supabase**: Edge Functions, RPC, RLS, webhook, activation, entitlement, telemetry và rate limit.
5. **Filesystem/result boundary**: upload, picker/drop, path-by-reference, signed result URL, temp/cache/log và external application launch.
6. **CI/build → release**: dependencies, lockfile, downloaded binary/model, resource encryption, signing, updater và installer.

## 5. Bất biến bảo mật

- Production compiled phải fail-closed khi thiếu/sai token, signature, claim, secret hoặc cấu hình; `DEV_MODE` không được mở cổng production.
- Authn/authz/feature gate của engine/tác vụ có giá trị phải cưỡng chế ở Tauri/backend/server; UI chỉ là lớp UX/defense-in-depth. Tool client-only phải được ghi rõ accepted risk và vẫn re-check khi quyền đổi.
- Sidecar chỉ nghe loopback; route/WS ngoài allowlist phải xác thực mặc định. HMAC phải ràng buộc request đầy đủ, chống replay và không cho renderer ghi đè header tin cậy.
- Claim license chỉ được dùng sau verify Ed25519; private/signing/service key không xuất hiện trong client, source map, argv hoặc log.
- Đường dẫn phải canonicalize rồi mới so scope; chặn traversal, symlink/junction, UNC/device path, arbitrary overwrite và đọc file nhạy cảm. Không chữa lỗi fast-path bằng allowlist toàn Desktop, `%TEMP%` hay ổ đĩa; file ngoài thư mục PrynX phải có capability native hoặc upload bytes.
- File/result của user không được lộ qua IDOR, static mount, signed URL sai scope, exception hoặc log. Companion PDF Upscale dùng marker lease atomic trong `RESULTS_DIR`: lease ngắn khi chưa commit, claim sau commit, release khi đóng tab và sweep được sau restart; endpoint claim/release vẫn chịu license + feature gate.
- Input định dạng và native FFI luôn không tin cậy; giới hạn parser/process phải bảo vệ tính bí mật, toàn vẹn và ổn định.
- Release phải chốt cùng một Git commit sạch trước/sau build, ghi hai feature gate, Python ABI, build mode và sidecar provenance vào manifest; artifact smoke phải chứng minh signed Free bị từ chối một quyền Pro. Native merger phải qua staged symbol gate và behavior smoke thật trên PNG có pHYs + alpha + RGB ICC, kiểm MediaBox, `/SMask` và `/ICCBased /N 3`. Secret không nằm trong repo/artifact/log và output cũ không được tái sử dụng âm thầm.
- Migration/RPC/RLS phải fail-closed, chống race và không trao quyền mặc định cho anon/authenticated ngoài chủ đích.

## 6. Accepted risk và non-goal

- Client Ring-3 trên máy attacker không thể chống patch/dump tuyệt đối. Mục tiêu là giữ private key/server authority, ngăn crack rẻ và nâng chi phí tấn công; không tuyên bố “không thể crack”.
- Anti-debug/process mitigation có thể bị giới hạn để tránh crash driver/phần mềm in; phải ghi rõ đánh đổi và residual risk.
- Paper Library hiện chạy hoàn toàn trong WebView. App có guard/downgrade overlay nhưng không coi đây là biên chống patch; đây là accepted commercial risk cho tới khi capability có giá trị được chuyển sang authority native/server.
- DoS chỉ là security finding khi vượt trust boundary, ảnh hưởng dịch vụ/người dùng khác hoặc có tác động bảo mật cụ thể; OOM local thuần túy thường chuyển sang audit hiệu năng.
- Không thử exploit hệ thống public/production, không dùng secret thật và không build/publish release trong audit.

## 7. Ưu tiên review

1. Auth/HMAC/replay/route/WS và đường nâng quyền feature/license.
2. Tauri IPC/capability, arbitrary file access, path canonicalization và subprocess.
3. Edge/RPC/RLS/service-role, activation race, token claims và secret exposure.
4. Parser file/native FFI, supply chain, binary/model provenance và release signing.
5. Privacy/logging, signed result access và accepted-risk drift.

## 8. Proof gap thường gặp

- Trạng thái migration/Edge Function và secret thật trên production.
- Authenticode/updater signature và hành vi installer/binary release thật.
- Workspace PrintSolutions, external service hoặc hardware/runtime không có trong phiên audit.
- Finding cần test phá hoại, fuzz dài, tải lớn hoặc PoC trên dữ liệu nhạy cảm.

Thiếu các bằng chứng trên phải ghi `[EXTERNAL]` hoặc proof gap; không suy diễn thành “đã an toàn” hay “đã khai thác được”.

## 9. Khi phải cập nhật threat model

Cập nhật cùng thay đổi khi thêm/sửa Tauri command, API/WS/RPC, claim/entitlement, biến môi trường bảo mật, storage/result path, external binary/model, auth provider, migration, release/signing pipeline hoặc accepted risk. Mỗi audit lớn phải xác nhận tài liệu này còn khớp code trước khi dùng để xếp hạng finding.
