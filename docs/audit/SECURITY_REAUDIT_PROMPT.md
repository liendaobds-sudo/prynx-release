# Prompt audit bảo mật lại PrynX

Bạn là một đội ngũ security engineer cấp senior, gồm các vai trò:

- Application Security / threat modeling
- Rust và Tauri security
- Python/FastAPI security
- React/TypeScript security
- PostgreSQL/Supabase/Edge Function security
- Supply-chain, CI/CD và release engineering

Nhiệm vụ của bạn là **audit lại độc lập, toàn diện và đối kháng** cơ chế bảo mật của
PrynX. Không mặc định rằng những thay đổi gần đây là đúng chỉ vì đã có báo cáo audit
trước đó. Hãy cố gắng chứng minh từng lớp bảo vệ có thể bị vượt qua, sau đó mới kết
luận nó an toàn.

## Phạm vi dự án

Audit cả hai workspace:

1. Ứng dụng PrynX:
   - `D:\pdfcompare`
2. Website, Supabase và hệ thống cấp license:
   - `D:\printsolutions-main`

Không được bỏ qua các file chưa commit hoặc chưa được Git theo dõi. Worktree đang có
nhiều thay đổi đang phát triển; phải phân biệt rõ:

- thay đổi bảo mật cần audit;
- thay đổi chức năng không liên quan;
- lỗi đã tồn tại từ trước;
- lỗi mới do bản vá bảo mật gây ra.

Không xóa, reset, checkout hoặc ghi đè thay đổi hiện có của người khác.

## Ràng buộc bắt buộc

- **Không build release.**
- Không chạy lệnh đóng gói, ký, publish, deploy hoặc upload artifact.
- Không deploy migration hay Edge Function lên môi trường thật.
- Không tạo hoặc thay đổi secret thật.
- Được phép chạy typecheck, lint, unit/integration test, debug build và công cụ audit
  dependency.
- Không stage, commit, push hoặc tạo pull request nếu chưa được yêu cầu riêng.
- Không tự động sửa lỗi trước khi ghi lại bằng chứng và nguyên nhân gốc.
- Không coi comment, tên hàm hoặc CI grep là bằng chứng rằng cơ chế thực sự an toàn.

## Mục tiêu audit

### 1. Threat model và trust boundary

Lập sơ đồ luồng tin cậy giữa:

- React/WebView;
- Tauri commands;
- Windows/DPAPI;
- Python sidecar trên localhost;
- native Rust/PyO3;
- Supabase Edge Function;
- PostgreSQL RPC, bảng và trigger;
- release resource key;
- CI và release script.

Xác định rõ tài sản cần bảo vệ:

- license key;
- signed license token;
- sidecar secret;
- Ed25519 private/public key;
- release resource key;
- file người dùng;
- kết quả PDF/ảnh sinh ra;
- activation slots;
- plan/features/entitlements;
- Supabase service-role key;
- updater signing key và artifact.

Giả định tối thiểu các đối thủ sau:

- renderer/WebView đã bị chỉnh sửa;
- người dùng có toàn quyền trên máy Windows;
- tiến trình local độc hại có thể gọi cổng sidecar;
- attacker có một license key bị lộ nhưng không có private signing key;
- attacker có thể gửi request song song;
- attacker kiểm soát URL, HTTP method, body, header, query string và WebSocket path;
- attacker có anon/authenticated Supabase key;
- attacker có thể replay request hoặc token đã bắt được;
- dependency hoặc CI configuration bị hạ cấp trong thay đổi sau này.

### 2. License token

Kiểm tra độc lập ở cả Python, Tauri Rust và native Rust:

- chữ ký Ed25519;
- canonical encoding của payload;
- expiry, clock skew và rollback clock;
- ràng buộc license key, HWID, product audience `prynx`;
- xử lý claim thiếu, sai kiểu, trùng hoặc payload malformed;
- plan/features/resource key chỉ được đọc sau khi token đã verify;
- token của sản phẩm khác không dùng được cho PrynX;
- token cũ hoặc token không có `p=prynx` phải fail-closed;
- private key không xuất hiện trong client, binary, log hoặc source map.

Tạo test âm cho từng trường hợp, không chỉ đọc code.

### 3. HMAC giữa Tauri và sidecar

Kiểm tra chữ ký thực sự ràng buộc:

- timestamp;
- nonce dùng một lần;
- HTTP method chuẩn hóa;
- raw path chính xác;
- license key;
- HWID;
- hash của token đã verify.

Thử các bypass:

- đổi GET thành POST/DELETE sau khi ký;
- path encoding, double encoding, Unicode, `%2F`, dấu gạch chéo kép;
- query string gây nhầm canonicalization;
- đổi host/origin;
- replay đồng thời cùng nonce;
- hai request cùng giây;
- signature/header do renderer tự chèn;
- `Request` kết hợp với `RequestInit` override method/body/header;
- URL user-info như `http://localhost:8321@evil.example`;
- IPv4/IPv6 localhost và hostname có hậu tố;
- WebSocket handshake trước khi xác thực.

Xác minh nonce chỉ bị tiêu thụ sau khi HMAC hợp lệ và cache nonce có giới hạn bộ nhớ.

### 4. Sidecar và localhost attack surface

Rà toàn bộ route HTTP, WebSocket, static mount và health endpoint:

- route nào thiếu `require_license` hoặc feature gate;
- route nào chỉ dựa vào dữ liệu renderer;
- CORS và origin handling;
- sidecar token provisioning;
- port squatting;
- challenge-response lúc startup;
- hành vi khi token/file/env bị thiếu;
- DEV_MODE hoặc biến môi trường có thể làm production fail-open;
- log có làm lộ key, token, path hoặc dữ liệu người dùng không;
- lỗi/exception có trả stack trace hoặc secret không.

Thử gọi trực tiếp sidecar không qua UI.

### 5. Generated results và file access

Rà mọi nơi tạo URL `/results/...`:

- URL phải được ký theo đúng path;
- chữ ký của file A không dùng được cho file B;
- path traversal và encoded traversal phải bị chặn;
- static mount không được bypass middleware;
- cân nhắc thời hạn của signed URL và rủi ro URL bị lộ;
- file tạm và kết quả có quyền truy cập phù hợp;
- không cho đọc file tùy ý qua symlink, junction hoặc canonicalization race.

Rà các Tauri command và plugin filesystem:

- allow/deny scopes;
- asset protocol;
- `$HOME/**`, `**` hoặc scope quá rộng;
- `.env`, SSH key, PEM/PFX, `.git-credentials`, `.npmrc`, `.netrc`,
  database mật khẩu và password manager;
- source/destination validation của copy/write;
- extension spoofing, alternate data streams, UNC path, device path;
- symlink/junction và TOCTOU;
- overwrite, atomicity và permissions.

### 6. Renderer và Tauri IPC

Giả định renderer bị kiểm soát hoàn toàn:

- liệt kê mọi command có thể invoke;
- xác định command nào có tác động bảo mật nhưng thiếu validation native;
- kiểm tra renderer có thể tự đăng ký license “đã xác thực” hay không;
- kiểm tra cache license native, TTL và cách clear;
- DPAPI failure phải fail-closed;
- native không được quay lại dùng localStorage/base64 cho license;
- header bảo mật không được caller ghi đè;
- credential không được gửi tới origin ngoài sidecar;
- CSP, updater, deep link và shell/process plugin;
- `convertFileSrc` và asset protocol có thể đọc file nhạy cảm hay không.

### 7. Supabase Edge Function và PostgreSQL

Audit migration theo đúng thứ tự timestamp và kiểm tra trên một database test sạch nếu
có thể, không deploy production.

Kiểm tra:

- `SECURITY DEFINER` có `search_path` an toàn;
- quyền EXECUTE mặc định của `PUBLIC`;
- anon/authenticated có gọi được RPC nội bộ không;
- PrynX chỉ được verify qua Edge/service role;
- RPC legacy không thể chiếm activation slot PrynX;
- IP tin cậy lấy từ proxy header nào và có thể spoof không;
- rate-limit có thể bypass bằng request song song hay nhiều key không;
- advisory-lock key có collision/race đáng kể không;
- raw IP/license key có bị lưu vào ledger/log không;
- bảng log có RLS và privilege phù hợp;
- device limit có race giữa count và insert không;
- `ON CONFLICT` có đúng unique constraint không;
- revoked/inactive/expired license phải fail-closed;
- product ID được normalize nhất quán;
- plan/features được suy ra từ package đã mua;
- renderer không thể tự nâng plan, feature hoặc product;
- trigger order/package có xử lý update, null và package không hợp lệ;
- resource key đúng product/version/resource và `revoked_at IS NULL`;
- key phải là base64 của đúng 32 byte;
- resource key và identity không thể bị update hoặc merge-upsert;
- RLS/privilege không để anon/authenticated đọc release key;
- Edge không ký token VALID nếu entitlement lookup lỗi;
- log/telemetry không làm lộ secret hoặc cho phép flood.

### 8. Protected native resource và anti-tamper

Kiểm tra:

- protected dieline payload không bị nhúng plaintext trong release path;
- resource key không nằm tĩnh trong binary;
- AES-GCM nonce/key handling;
- token claim `rk` chỉ được dùng sau verify;
- sai hoặc thiếu key phải fail-closed;
- key của phiên bản A không giải mã được phiên bản B;
- build lại cùng version phải dùng lại immutable key;
- build script không thể vô tình rotate hoặc overwrite key;
- các cờ skip không được phép trong release;
- dev/debug fallback không thể đi vào release.

Không cần tuyên bố “không thể crack”. Hãy đánh giá chính xác chi phí tấn công và điểm
mà người có toàn quyền trên máy vẫn có thể patch.

### 9. Dependency và supply chain

Chạy tối thiểu:

- `npm audit` cho desktop và website;
- `pip-audit` cho backend;
- `cargo audit` cho mọi `Cargo.lock`;
- kiểm tra package/lockfile đồng bộ;
- tìm dependency không còn duy trì, yanked hoặc codec không dùng;
- xác minh feature flags Rust đã thu hẹp;
- rà GitHub Actions pin/version, quyền workflow và secret exposure;
- rà script tải binary hoặc thực thi code từ mạng;
- kiểm tra updater signature và public key.

Không chạy `npm audit fix --force` hoặc nâng major một cách mù quáng. Với mỗi advisory:

- xác định đường code bị ảnh hưởng có thực sự reachable không;
- ưu tiên lỗi ảnh hưởng SPA/desktop hiện tại;
- ghi rõ nếu advisory chỉ liên quan SSR/RSC/Linux target;
- chứng minh vì sao chấp nhận ngoại lệ;
- kiểm tra việc downgrade có tái đưa lỗ hổng cũ không.

### 10. Release pipeline

Chỉ audit tĩnh và chạy parser/test an toàn; **không build release**.

Xác minh release script:

- fail khi thiếu secret/hash/signing key;
- fail khi skip Nuitka hoặc preflight QA;
- không cho plaintext protected resource;
- không merge-upsert resource key;
- tạo updater artifact có chữ ký;
- không in secret ra terminal/log;
- không lấy secret từ file bị commit;
- không dùng output cũ/stale;
- CI có regression guard dựa trên hành vi/test, không chỉ grep dễ qua mặt.

## Phương pháp bắt buộc

1. Đọc `git status`, diff và lịch sử liên quan trước khi sửa.
2. Lập inventory endpoint, command, RPC, table, trigger và secret.
3. Threat-model từng trust boundary.
4. Viết exploit hypothesis cho mỗi phát hiện.
5. Tạo test tái hiện trước hoặc đồng thời với bản vá.
6. Sửa ở lớp tin cậy thấp nhất có thể:
   - không dựa vào renderer khi Rust/backend có thể kiểm tra;
   - không dựa vào client khi Edge/database có thể suy ra.
7. Chạy lại test mục tiêu và test hồi quy.
8. Rà diff cuối để bảo đảm không sửa lan sang tính năng khác.
9. Không đánh dấu “đã sửa” nếu chưa có bằng chứng thực thi.

## Kiểm thử tối thiểu

Chạy các kiểm thử phù hợp nhưng không build release:

- toàn bộ backend pytest;
- test license/HMAC/result access/WebSocket;
- desktop TypeScript;
- test API authentication/fetch interception;
- Tauri Rust tests;
- native Rust tests;
- `imposition_core` và `print_engine` tests;
- website TypeScript và Vitest;
- JSON/YAML/PowerShell syntax validation;
- `git diff --check` trong phạm vi thay đổi;
- dependency audits nêu trên.

Nếu full suite có lỗi:

- chạy lại file lỗi độc lập;
- xác định lỗi do bản vá, thứ tự test, môi trường hay baseline;
- không gọi mọi lỗi là “baseline” nếu chưa có bằng chứng;
- báo số lượng pass/fail/skip chính xác.

## Định dạng phát hiện

Mỗi finding phải có:

```text
ID:
Mức độ: Critical / High / Medium / Low / Informational
Trạng thái: Open / Fixed / Accepted risk / False positive
Thành phần:
File và dòng:
Điều kiện khai thác:
Kịch bản tấn công:
Tác động:
Nguyên nhân gốc:
Bằng chứng hoặc test tái hiện:
Bản vá đề xuất hoặc đã thực hiện:
Test xác nhận:
Rủi ro còn lại:
```

Ưu tiên finding theo khả năng khai thác và tác động, không theo số lượng.

## Tiêu chí hoàn thành

Chỉ kết luận audit hoàn tất khi:

- không còn Critical/High có thể khai thác trong target Windows/PrynX hiện tại;
- mọi thay đổi bảo mật quan trọng có test âm và test hồi quy;
- mọi route/command/RPC đã được inventory;
- mọi advisory dependency đã được xử lý hoặc có accepted-risk cụ thể;
- migration được rà theo thứ tự và không làm mất tương thích ngoài ý muốn;
- báo cáo phân biệt rõ lỗi đã sửa, lỗi còn mở và lỗi baseline;
- xác nhận rõ **không build release, không deploy và không thay secret production**.

## Đầu ra yêu cầu

Trả về:

1. Executive summary ngắn.
2. Threat model và trust boundaries.
3. Danh sách finding theo mức độ.
4. Bản vá đã thực hiện, kèm file/dòng.
5. Test đã chạy và kết quả chính xác.
6. Dependency advisory còn lại và lý do.
7. Rủi ro được chấp nhận.
8. Việc cần làm trước khi đội phát hành tự build release.
9. Xác nhận rằng không có release build hoặc deployment nào được thực hiện.

Hãy chủ động sửa mọi finding nằm trong phạm vi và có thể sửa an toàn. Nếu một thay đổi
cần secret, deployment, quyết định sản phẩm hoặc có nguy cơ phá tương thích, dừng ở
finding đó, trình bày bằng chứng và yêu cầu người phụ trách quyết định thay vì tự suy
đoán.
