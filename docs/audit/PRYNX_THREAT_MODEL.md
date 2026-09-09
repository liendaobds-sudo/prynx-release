# PrynX — Threat model ngắn cho security review

**Cập nhật:** 2026-09-04 (đồng bộ §SEC.15, §SEC.19/§ATK.09, §SEC.21–§SEC.23 và §SEC.24-R1–R7)

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

1. **WebView → Tauri IPC**: mọi `invoke`, capability, shell/process, filesystem, deep-link/startup args và asset protocol. `grant_upscale_file_path` chỉ ký canonical image path đã nằm trong dynamic `plugin-fs` scope do picker/native drop cấp; renderer không tự biến một chuỗi path thành capability. Save As từ cửa sổ nhân bản dùng grant native one-shot bind đúng cửa sổ, canonical target và TTL; lease giữ source cùng ancestor bằng handle không share `DELETE`, timer thu hồi sau 2 phút. UI bản cài/NAS/non-NTFS vẫn là `[EXTERNAL]`.
2. **Tauri → FastAPI sidecar**: HTTP/WS localhost, CORS/origin, signature v2, timestamp, nonce và startup challenge. Signature v2 bind method, raw path/query, credential snapshot, content type, body mode và body commitment; JSON/string/binary bind raw bytes, FormData giữ order/duplicate/file metadata, streaming kiểm commitment tại EOF trước parse/submit. Session key được derive theo từng `sidecar generation`, nên chữ ký thế hệ cũ không hợp lệ sau respawn dù nonce table mới rỗng. Trước khi ký, native đối chiếu hash token hiện tại của request với binding license đã verify; token đổi giữa phiên buộc đăng ký lại cache rồi mới được ký. Nếu sidecar chết sau startup, supervisor chỉ spawn thế hệ mới sau khi port rảnh và startup proof khớp secret; không tự ý kill listener không xác thực. Fast-path Upscale dùng grant HMAC riêng, bind `path + tab + iat/exp + nonce`, dùng một lần; production dùng secret stdin, `run_dev.bat` sinh secret theo từng phiên cho hai process cùng kế thừa.
3. **Sidecar → native/parser**: PyO3, PDFium, pypdfium2, subprocess/PowerShell, codec, model/font/PDF parser và worker/process boundary.
4. **Client → PrintSolutions/Supabase**: Edge Functions, RPC, RLS, webhook, activation, entitlement, telemetry và rate limit.
5. **Filesystem/result boundary**: upload, picker/drop, path-by-reference, signed result URL, temp/cache/log và external application launch.
   - **Bàn giao Illustrator (2026-09-09):** `launch_external_app` giữ allowlist EXE và chỉ dùng bridge cho PDF khuôn `prynx_khuon_*` mở bằng `Illustrator.exe`. Native đọc `/OC` + `/NM`, tạo bản PDF riêng với spot định danh ngắn; script cố định được nhúng lúc biên dịch, metadata chỉ là JSON đã escape, không nhận script/path script từ renderer. PowerShell lấy từ System32, script truyền qua stdin UTF-8; COM chỉ kết nối app đang chạy và kiểm đường dẫn cài đặt khớp EXE đã duyệt. File nguồn giữ read lease; bản bàn giao sau khi đóng handle ghi được mở lại read lease, đối chiếu toàn bộ byte rồi mới mở trong Illustrator. Không ghi đè tài liệu nguồn, không thao tác `ActiveDocument` do người dùng đang chọn; script chỉ sửa document vừa mở từ tên file ngẫu nhiên. Sai số lượng/định danh đóng bản sao không lưu và trả lỗi. Phạm vi hiện tại: một trang khuôn, boong vector trực tiếp có metadata; không khẳng định hỗ trợ nhập layer Corel, nhiều trang, boong trong Form hoặc compound path. Runtime bridge đã kiểm trên Illustrator 29.8.2; COM/plugin ở phiên bản khác và nút UI của installer vẫn cần smoke riêng.
6. **CI/build → release**: dependencies, lockfile, downloaded binary/model, resource encryption,
   signing, updater, installer, source metadata và publisher authority. §SEC.24-R1–R3 pin/lease
   PowerShell, `cmd`, `gh`, Node, Git, Robocopy và exact npm/Tauri entrypoint; R4 khóa Cargo/Rustc/
   Rustdoc/`rust-std` theo content-addressed exact-set/provenance; R5 pin đúng một HTTPS updater
   endpoint/destination canonical trên `github.com`; R6 bind Git vào `ROOT\.git`, khóa Git/GitHub
   metadata/config/credential/exact grammar, SemVer ASCII-only và raw/escaped tag route, lấy signing
   key từ Windows Known Folder và mở log bằng Notepad System32 đã lease; R7 dùng `%__APPDIR__%` cho
   BAT bootstrap thay ambient `%SystemRoot%`/`PATH`. Trusted checkout, OAuth/Credential Manager/
   GitHub thật, `gh` tương lai và packaged double-click/hostile-`PATH` vẫn cần bằng chứng riêng.

## 5. Bất biến bảo mật

- Production compiled phải fail-closed khi thiếu/sai token, signature, claim, secret hoặc cấu hình; `DEV_MODE` không được mở cổng production.
- Authn/authz/feature gate của engine/tác vụ có giá trị phải cưỡng chế ở Tauri/backend/server; UI chỉ là lớp UX/defense-in-depth. Tool client-only phải được ghi rõ accepted risk và vẫn re-check khi quyền đổi. **Mọi quyền trong `PRO_FEATURES` phải xuất hiện trong ít nhất một `require_feature`/`enforce_feature` ở backend** — cưỡng chế bằng ratchet `backend/tests/test_pro_feature_enforcement_coverage.py`; ngoại lệ client-only phải khai tường minh trong `_CLIENT_ONLY_ACCEPTED_RISK` và có kiểm hai chiều (audit 2026-08-28 §SEC.01: `cut_export` từng khai `impo.cnc` là Pro ở ba nơi nhưng backend không kiểm ⇒ Free dùng được).
- Kích hoạt PrynX chỉ đi qua Edge Function (`service_role`). RPC công khai (`verify_license`, `verify_license_guarded`) phải **từ chối `product_id='prynx'`** cho caller không phải `service_role`, nhưng vẫn phục vụ các sản phẩm khác (`bexen`/`mecso`/`mecbia`/`dulieu`/`multi_tem_placer`/`print_monitor_app`) vì đó là toàn bộ cơ chế license của chúng. Đếm activation phải serialize bằng advisory lock; rate-limit không được tin hop đầu của `x-forwarded-for`.
- Sidecar chỉ nghe loopback; route/WS ngoài allowlist phải xác thực mặc định. Signature v2 phải ràng buộc request đầy đủ, chống replay và không cho renderer ghi đè header tin cậy. Source/test hiện bind method, raw path/query, credential snapshot, content type, body mode/commitment và đổi session key theo generation. Ratchet phải phủ mọi route đăng ký; snapshot hiện hành là 191/191 route coverage, **không phải test count**. Packaged-runtime proof vẫn `[EXTERNAL]`.
- Claim license chỉ được dùng sau verify Ed25519; private/signing/service key không xuất hiện trong client, source map, argv hoặc log.
- Đường dẫn phải canonicalize rồi mới so scope; chặn traversal, symlink/junction, UNC/device path, arbitrary overwrite và đọc file nhạy cảm. Không chữa lỗi fast-path bằng allowlist toàn Desktop, `%TEMP%` hay ổ đĩa; file ngoài thư mục PrynX phải có capability native hoặc upload bytes. **Deny-list không được so khớp chuỗi thô**: `is_sensitive_path` phải bóc tiền tố `\\?\`/`\??\`/`\\?\UNC\`, chặn admin share (`\\host\C$`) và device namespace, rồi canonicalize và so lại — chuỗi thô để lọt verbatim path, tên 8.3 và junction (audit 2026-08-28 §SEC.04). Save As grant phải bind owner/target/TTL và giữ lease identity trên source/ancestor; runtime NAS/non-NTFS phải được kiểm riêng thay vì suy từ NTFS unit test. Share NAS hợp lệ vẫn phải dùng được.
- Renderer không được biến một chuỗi thành quyền thực thi: lệnh spawn tiến trình (`launch_external_app`) chỉ nhận `.exe` đã nằm trong allowlist do native quản (kết quả dò registry / vừa chọn qua hộp thoại native / đã duyệt phiên trước). Đường cấp quyền một lần (staging grant của New Window) phải đòi nguồn nằm trong `fs_scope` — nếu không, một lệnh copy không kiểm scope sẽ tự hợp pháp hoá path bất kỳ (audit 2026-08-28 §SEC.05/§SEC.07).
- File/result của user không được lộ qua IDOR, static mount, signed URL sai scope, exception hoặc log. Companion PDF Upscale dùng marker lease atomic trong `RESULTS_DIR`: lease ngắn khi chưa commit, claim sau commit, release khi đóng tab và sweep được sau restart; endpoint claim/release vẫn chịu license + feature gate.
- Input định dạng và native FFI luôn không tin cậy; giới hạn parser/process phải bảo vệ tính bí mật, toàn vẹn và ổn định.
- Release phải chốt cùng một Git commit sạch trước/sau build, ghi hai feature gate, Python ABI,
  build mode, sidecar và toolchain provenance vào manifest; artifact smoke phải chứng minh signed
  Free bị từ chối một quyền Pro. Git metadata/config/index/info là input không tin cậy: command chỉ
  chạy qua exact read-only grammar trên đúng `ROOT\.git`, config có điểm thực thi, common/split
  worktree, hidden index flag và gitlink phải fail-closed. Resource ngoài Git phải đi từ staging mới,
  có exact-set path/size/SHA-256 được quét lại sát bundle và sau cài; recursive cleanup chỉ được xóa
  path sinh bởi pipeline, root/mọi component phải từ chối reparse, và không resource executable nào
  được chạy trước exact-set. Tesseract và Rust toolchain phải khớp lock content-addressed; ADS,
  reparse, hardlink/link-count và identity lease phải fail-closed. Mọi tool release phải đến từ
  executable authority đã pin/lease, không qua bare `PATH`; updater/GitHub chỉ dùng canonical
  `github.com` destination, SemVer chữ số ASCII và exact raw/escaped tag route. GitHub config phải
  đến từ Known Folder, không chứa credential key plaintext theo policy lexical đã audit và không mở
  execution/transport override. Policy này mô tả YAML block-style của GitHub CLI 2.93.0, **không
  phải YAML-general scanner**; phiên bản `gh` mới phải được re-audit. Native merger phải qua staged
  symbol gate và behavior smoke thật trên PNG có pHYs + alpha + RGB ICC, kiểm MediaBox, `/SMask` và
  `/ICCBased /N 3`. Secret không nằm trong repo/artifact/log và output cũ không được tái sử dụng âm thầm.
- Migration/RPC/RLS phải fail-closed, chống race và không trao quyền mặc định cho anon/authenticated ngoài chủ đích.
- License V3 có lease offline tối đa **72 giờ** để hỗ trợ cuối tuần; heartbeat online
  vẫn chạy theo nhịp 10 phút, clock anchor vẫn bắt buộc và native cache binding
  trong RAM vẫn có TTL riêng. Đây là accepted trade-off: key bị thu hồi khi máy
  hoàn toàn offline có thể còn dùng được tối đa 72 giờ; không được mô tả là revoke
  tức thời trong UI/tài liệu phát hành.

## 6. Accepted risk và non-goal

- Client Ring-3 trên máy attacker không thể chống patch/dump tuyệt đối. Mục tiêu là giữ private key/server authority, ngăn crack rẻ và nâng chi phí tấn công; không tuyên bố “không thể crack”.
- Admin/debugger/memory patch trên client là residual accepted risk; source/test hardening không được ghi thành bảo đảm chống attacker Ring-3 tuyệt đối.
- BAT không thể tự chứng minh authority của interpreter đầu tiên. File association, explicit wrapper/
  interpreter giả, registry hoặc process bị admin/Ring-3 patch là residual accepted risk; R7 chỉ loại
  ambient `%SystemRoot%`/`PATH` khỏi đường bootstrap chuẩn.
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

- `[EXTERNAL]` Trạng thái migration/Edge Function/DB và secret thật trên production; rotate/revoke/audit key/secret thật.
- `[EXTERNAL]` Authenticode certificate/updater signature và hành vi installer/binary release thật.
- `[EXTERNAL]` runtime CNG challenge–proof trên máy TPM và máy dùng Software KSP fallback. Thiết kế
  hiện không có hardware attestation; local admin/Ring-3 là residual risk được chấp nhận.
- `[EXTERNAL]` Clean build/install/uninstall, exact provenance và fault-injection trên Windows VM sạch.
- `[EXTERNAL]` Save As UI/NAS/non-NTFS và packaged double-click/hostile-`PATH` trên artifact/runtime.
- `[EXTERNAL]` OAuth/device flow, Credential Manager, account/repo/network GitHub thật và
  compatibility/security policy của các phiên bản GitHub CLI sau 2.93.0.
- Workspace PrintSolutions, external service hoặc hardware/runtime không có trong phiên audit.
- Finding cần test phá hoại, fuzz dài, tải lớn hoặc PoC trên dữ liệu nhạy cảm.

Thiếu các bằng chứng trên phải ghi `[EXTERNAL]` hoặc proof gap; không suy diễn thành “đã an toàn” hay “đã khai thác được”.

## 9. Khi phải cập nhật threat model

Cập nhật cùng thay đổi khi thêm/sửa Tauri command, API/WS/RPC, claim/entitlement, biến môi trường bảo mật, storage/result path, external binary/model, auth provider, migration, release/signing pipeline hoặc accepted risk. Mỗi audit lớn phải xác nhận tài liệu này còn khớp code trước khi dùng để xếp hạng finding.
