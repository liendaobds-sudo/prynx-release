# Báo cáo audit bảo mật chống crack — black-box + white-box (2026-09-02)

> **Chế độ:** Audit bảo mật chuẩn, đọc-only, có validation black-box an toàn trên bản cài cục bộ.
> **Mục tiêu:** đánh giá khả năng chống chia sẻ license, giả mạo entitlement và sửa bản cài của PrynX.
> **Thời điểm:** 2026-09-02 (Asia/Bangkok).
> **Trạng thái:** **ĐÃ DUYỆT — đã áp dụng các lô source/test tới 2026-09-04; release vẫn `HOLD`**.
> Các control hiện hành cho §SEC.15, khe replay theo generation của §SEC.19/§ATK.09,
> §SEC.21, §SEC.23 và §SEC.24-R1–R7 đã được verify ở phạm vi source/test; các finding khác trong
> dải §SEC.16–§SEC.22 giữ đúng lifecycle riêng ở bảng §4. Các chốt artifact/runtime/deploy
> nêu dưới đây vẫn mở. Chưa build/ký/publish release, chưa gọi production và không tạo keygen,
> patcher, bypass hay công thức crack.

## 0. Kết luận điều hành

Lớp mật mã hiện tại (Ed25519 cho license token, resource-key nằm trong payload đã ký, sidecar token
truyền qua stdin và HMAC có nonce) **không có đường giả mạo rẻ kiểu tự ký token** trong phạm vi đã kiểm.
Các probe black-box cũng xác nhận nhiều cổng quan trọng đang fail-closed.

Tuy nhiên, hệ thống **chưa đủ mạnh cho mục tiêu chống chia sẻ/chống crack ở mức cao** vì có một lỗ
logic nghiêm trọng ở authority của HWID và một rủi ro vận hành nghiêm trọng ở khóa ký updater:

| Mức | Finding mới | Kết luận ngắn |
|---|---|---|
| **P0 / Critical** | §SEC.16 | DPAPI chỉ bảo mật bí mật với user khác; chính user có thể tạo blob hợp lệ chứa HWID tùy ý. Server lại ký token trên machine_id do client gửi, nên giới hạn số máy có thể bị quy về một ID dùng chung. |
| **P1 / High (có điều kiện Critical)** | §SEC.17 | Khóa ký updater trên máy build có ACL đọc kế thừa cho CodexSandboxUsers; nếu group/process đó không hoàn toàn tin cậy, artifact độc hại có thể được ký bằng trust anchor mà client tin. |
| **P1 / High — đã giảm thiểu ở source** | §SEC.18 | Persistent one-file cache chỉ kiểm CRC32 đã được thay bằng extraction tạm riêng mỗi lượt, có graceful shutdown và verifier ràng buộc đúng bootstrap/process tree. Vẫn chờ build + runtime validation trên artifact mới nên chưa Closed. |
| **P1 / High — đã giảm thiểu ở source/test, chưa Closed** | §SEC.19, §SEC.23 | Clock state/anchor đã fail-closed hơn và khóa phiên được derive theo thế hệ sidecar. Payload có exact-set cùng lock Tesseract, hardlink/link-count, ADS/reparse và identity lease. Vẫn thiếu runtime fault-injection, deploy và clean build/install/uninstall proof. |
| **P1 / High — cần validation vận hành** | §SEC.20 | Release secret còn residue trong app-data máy build; chưa có bằng chứng nó từng được ship, cũng chưa có rotation/audit production. |
| **P2 / Medium — đã giảm thiểu ở source/test** | §SEC.21–§SEC.22 | Signature v2 đã bind raw path/query, credential snapshot, content type, body mode và body commitment; startup đã bỏ kill theo tên và fail-closed với listener lạ. Packaged lifecycle/runtime vẫn chưa được chứng minh. |

**Trả lời trực tiếp câu hỏi “AI có crack được không?”**: AI không thể suy ra private key Ed25519 từ
public key. Nhưng AI có thể tìm nhanh các bất đối xứng logic như §SEC.16; vì vậy nguy cơ thực tế
không nằm ở việc “bẻ toán”, mà ở việc làm cho client trình bày một danh tính thiết bị không có
authority. Sau khi xử lý các finding P0/P1, vẫn phải giữ kỳ vọng thực tế: phần mềm chạy ở Ring-3
trên máy của người dùng không thể chống patch/dump tuyệt đối; mục tiêu là giữ server/private key
ngoài tầm với và làm crack rẻ trở nên không còn kinh tế.

Không có finding nào trong báo cáo này khẳng định “toàn hệ thống đã an toàn”.

## 1. Phạm vi, revision và ranh giới tin cậy

### 1.1. Codebase và artifact

- D:\pdfcompare — branch codex/pre-release-audit-2026-08-04, HEAD
  33143499ba1a46590ed2617af2406ecc805b48cd.
  Worktree có 35 mục untracked/WIP; không coi đây là bản release sạch.
- D:\printsolutions-main — branch perf/toi-uu-hieu-nang-ui-2026-08-26, HEAD
  d122d55224a9639e5a27686561d5d8ad084f8e27.
  Worktree có thay đổi tracked và untracked (43 mục theo snapshot); migration hardening mới
  chưa được coi là đã deploy.
- Bản cài được kiểm tại C:\Users\Khanh Pham\AppData\Local\PrynX:
  - pdf-inspector.exe: 1.0.0-rc.9, SHA-256
    D7C67C8AAB1E1385F1EA60C644E01ADFEA7F7DB72B932603C27EF5C84CB10399.
  - pdf-inspector-backend.exe: 1.0.0.900, SHA-256
    A3207A2B1CF15D35FBC59595424574994BC6F4A5539C3269AC2FD93030D61CCE.
  - Frontend, outer sidecar, inner sidecar đã giải nén, `pdfcompare_native.pyd` và uninstall.exe
    đều trả NotSigned từ Get-AuthenticodeSignature. Một số Python runtime `.pyd` của bên thứ ba có
    chữ ký hợp lệ; điều đó không ký thay cho mã PrynX.
- Cache giải nén quan sát được:
  - %LOCALAPPDATA%\PrynX\sidecar-1.0.0.8: 1.080 file, khoảng 0,91 GB.
  - %LOCALAPPDATA%\PrynX\sidecar-1.0.0.900: 1.080 file, khoảng 0,91 GB.
  ACL của cache cho user hiện hành FullControl (cùng SYSTEM/Administrators).

### 1.2. Đối thủ trong threat model

Đợt này xét các năng lực sau, đúng với D:\pdfcompare\docs\audit\PRYNX_THREAT_MODEL.md:

- Người dùng Windows/Ring-3 có quyền trên profile của chính mình, có thể đọc/ghi cache, file
  DPAPI và gọi trực tiếp endpoint localhost.
- Renderer/WebView bị patch hoặc bị điều khiển; UI không được xem là biên cưỡng chế.
- Process không tin cậy trên máy build có thể nhìn thấy file mà ACL cho phép.
- Người có binary có thể debugger/dump/patch; đây là accepted commercial risk, không phải điều
  có thể loại bỏ hoàn toàn bằng code.

### 1.3. Ngoài phạm vi

- Không thử trên Supabase production, không gọi RPC/Edge bằng credential thật và không deploy
  migration.
- Không đọc/in private key, secret, license khách hàng hay token đầy đủ; chỉ kiểm metadata và
  kiểu/độ dài khi cần.
- Không tạo CRC collision, patch binary để bypass, keygen, token giả hoặc PoC thay đổi dữ liệu.
- Không đổi giờ hệ thống trên máy thật; không xóa state production; không build, ký hay publish
  release.
- Chưa có VM/snapshot được ủy quyền để kiểm chứng TPM/CNG, rollback clock dài ngày hoặc clean
  installer extraction.

### 1.4. Quan hệ với audit trước

D:\pdfcompare\docs\BAO_CAO_AUDIT_CHONG_CRACK_2026-08-28.md đã có §SEC.01–§SEC.15. Báo cáo này
bắt đầu từ §SEC.16 để tránh trùng finding. Các accepted risk cũ (đặc biệt §SEC.11 về Authenticode)
được nhắc lại ở §7, không mở ID mới.

## 2. Phương pháp và bằng chứng

Đã thực hiện:

1. Đọc threat model, security architecture, báo cáo chống crack trước và log fixes liên quan.
2. Trace tĩnh từ Tauri command/frontend → sidecar → Edge/RPC → token/activation → file/cache.
3. Black-box bản cài: kiểm port/listener, route 404/403, origin/CORS, env override, startup
   proof, sửa byte sidecar, sửa checksum frontend và trạng thái tiến trình sau khi đóng UI.
4. Kiểm metadata chữ ký Authenticode, ACL, kích thước/cache, resource list, file residue và
   đường staging/inventory của installer.
5. Chạy các suite chọn lọc đã được phép trên Windows thật; kết quả được ghi ở §6.

Artifact audit được giữ nguyên, không xóa:

- D:\pdfcompare\.tmp-security-audit\runtime-antitamper-20260902-a1
- D:\pdfcompare\.tmp-security-audit\override-test-20260902
- D:\pdfcompare\.tmp-security-audit\override-cwd-20260902

Các file WIP/untracked khác trong hai worktree cũng được giữ nguyên. Tại thời điểm draft ban đầu,
`PRYNX_MASTER_AUDIT_MATRIX.md` chưa được cập nhật để tránh biến báo cáo chưa duyệt thành trạng
thái đã đóng. Sau các lô đã duyệt, matrix đã được cập nhật nhưng W8 vẫn giữ `STALE · HOLD`.

### 2.1. Quy ước trạng thái bằng chứng

- [CONFIRMED-STATIC]: đường đi và bất biến bị phá đã được chứng minh bằng source/revision, nhưng
  chưa đồng nghĩa với runtime exploit trên production.
- [VERIFIED-RUNTIME]: đã có probe cô lập lặp lại được trên artifact phù hợp.
- [SUSPECTED]: design weakness có điều kiện, còn thiếu một mắt xích runtime/artifact.
- [EXTERNAL]: phụ thuộc trạng thái production, ACL/group hoặc quy trình phát hành ngoài workspace.

Needs validation là trạng thái trung thực; không nâng thành Verified chỉ vì suy luận tĩnh.

## 3. Các control đã pass trong black-box

| Control | Quan sát | Đánh giá |
|---|---|---|
| Bind sidecar | Listener chỉ ở 127.0.0.1:8321 | Pass trong artifact đã kiểm |
| Secret truyền lúc khởi động | Secret đi qua stdin, không xuất hiện trong argv của launcher probe | Pass |
| Production env | Đổi env để bật dev/feature gate không mở được binary release; launcher ép DEV_MODE=false và enforcement token | Pass |
| Surface tài liệu | /docs, /redoc, /openapi.json trả 404 | Pass |
| Signature/route gate | Request thiếu/sai signature hoặc credential trả 403 | Pass |
| Origin/CORS | Origin giả/null bị từ chối | Pass; CORS vẫn còn hardening gap ở §7 |
| Sidecar tamper | Sửa một byte PE sidecar bị startup proof/hash phát hiện, không mở port | [VERIFIED-RUNTIME] |
| Frontend tamper | Sửa checksum frontend nhưng process vẫn chạy | Xác nhận giới hạn Authenticode, không phải bằng chứng patch code đã bypass gate |
| Ed25519/resource key | Static trace cho thấy m/k/p/exp/rk nằm trong payload server ký; native và sidecar đều verify | Pass theo thiết kế; chưa thử private-key forgery |

Điểm cuối cùng chỉ nói rằng không thấy đường giả token rẻ; nó không phủ nhận các finding authority
và lifecycle bên dưới.

## 4. Bảng finding mới

| ID | Mức | Lifecycle hiện tại | Confidence | Bằng chứng | Tài sản/bất biến |
|---|---|---|---:|---|---|
| §SEC.16 | P0 / Critical | Triaged → Mitigated in source; CNG proof accepted with residual risk | 98% design | [CONFIRMED-STATIC][MITIGATED-SOURCE][VERIFIED-TEST][EXTERNAL] | Activation phải bind vào device key; server không được dựa trên chuỗi HWID client tự chọn |
| §SEC.17 | P1 / High; Critical nếu key còn active | Triaged → Contained at release gate; operational remediation required | 95% ACL / 80% impact | [CONFIRMED-STATIC][MITIGATED-SOURCE][EXTERNAL] | Updater signing trust anchor |
| §SEC.18 | P1 / High | Triaged → Mitigated in source / runtime artifact validation pending | 98% source / 90% runtime | [CONFIRMED-STATIC][MITIGATED-SOURCE][VERIFIED-TEST] | Integrity của payload one-file/cache |
| §SEC.19 | P1 / High | Applied → Verified in code/targeted tests; khe replay theo generation đã có control, tổng thể còn runtime/deploy gaps | 95% source | [VERIFIED-CODE][VERIFIED-TEST] | Anti-clock rollback, thời hạn token offline và sidecar generation |
| §SEC.20 | P1 / High; Critical nếu từng ship/secret còn sống | Discovered → Needs validation | 95% residue / 70% shipping | [EXTERNAL] | Supabase release secret và resource-key authority |
| §SEC.21 | P2 / Medium | Applied → Verified in code/targeted tests; packaged runtime pending | 95% source | [VERIFIED-CODE][VERIFIED-TEST][EXTERNAL] | HMAC phải ràng buộc request đầy đủ |
| §SEC.22 | P2 / Medium | Applied → Verified in source tests; packaged runtime pending | 95% source / 85% artifact | [VERIFIED-CODE][VERIFIED-TEST][HISTORICAL-RUNTIME] | Vòng đời sidecar/localhost service |
| §SEC.23 | P1 / High; tác động thực tế có điều kiện | Applied → Verified in source/targeted tests; artifact provenance pending | 97% source / 75% impact | [VERIFIED-CODE][VERIFIED-TEST][EXTERNAL] | Payload phát hành phải chỉ gồm byte có provenance và nằm trong allowlist |

Hai control hiện hành sau được nối vào báo cáo để tránh dùng trạng thái lịch sử; §SEC.24 là nhãn
hardening, **không tự gán severity mới** trong lượt cập nhật tài liệu này:

| ID | Mức đã có / phân loại | Lifecycle hiện tại | Bằng chứng | Bất biến |
|---|---|---|---|---|
| §SEC.15 | P3 lịch sử | Applied → Verified in source/targeted tests; runtime UI/filesystem pending | [VERIFIED-CODE][VERIFIED-TEST][EXTERNAL] | Cửa sổ Save As không được ghi đè source/artifact ngoài grant native đúng owner/target/TTL |
| §SEC.24-R1–R7 | Không xếp severity trong addendum | Applied → Verified in source/targeted tests; prerequisite checkout cục bộ chưa đạt, release artifact/runtime còn `[EXTERNAL]` | [VERIFIED-CODE][VERIFIED-TEST][EXTERNAL] | Tool, source metadata, GitHub destination/config/credential và BAT bootstrap phải có authority fail-closed |

## 5. Chi tiết finding

### §SEC.15 — P3 lịch sử — Save As artifact đã có enforcement native ở source

**Lifecycle:** Applied → Verified (source + targeted tests); runtime UI/filesystem pending
**Trạng thái:** [VERIFIED-CODE][VERIFIED-TEST][EXTERNAL]

Tuyên bố lịch sử “`save_as_only` chỉ là hint gửi renderer” không còn mô tả source hiện tại.
Native cấp grant one-shot bind đúng cửa sổ, canonical target và TTL; lease giữ source cùng các
ancestor bằng handle không share `DELETE`, và timer tự thu hồi grant sau 2 phút. Nhóm registry
Save As đạt **23/23** test. Chưa chạy UI trên bản cài, share NAS hoặc filesystem không phải NTFS,
nên không nâng lên Runtime Verified.

### §SEC.16 — P0/Critical — HWID cache DPAPI không phải device authority

**Lifecycle:** Triaged → Applied/Verified (A0 + A1 source/test); residual CNG software/Ring-3 được chấp nhận, runtime/deploy còn mở
**Confidence:** 98% cho lỗi thiết kế; chưa có runtime proof với CNG và license test trên máy/VM thật
**Trạng thái:** [CONFIRMED-STATIC][MITIGATED-SOURCE][VERIFIED-TEST][EXTERNAL]

> Cập nhật 2026-09-02 — Lô A0 đã được triển khai trong source, đúng 5 file. Native không
> còn tin plaintext DPAPI: cache v1 chỉ được migrate khi khớp fingerprint vừa đo; cache v2
> lưu enrollment và mỗi process phải có UUID khớp hoặc CPU+BIOS cùng khớp. Runtime Tauri
> không fallback sang localStorage khi lấy HWID lỗi. Edge chỉ nhận PrynX HWID canonical 16-hex
> và dùng cùng giá trị cho block, RPC activation, RK ledger, token và log. Thuật toán ID cũ được
> giữ để máy hợp lệ không ăn thêm seat. Verify source: Rust 175 pass/5 ignored; frontend targeted
> 21 pass + typecheck; server ratchet 10 pass. Chưa deploy Edge, chưa build installer và chưa thử
> license test trên hai VM, nên không nâng lên Verified/Closed.

> Cập nhật 2026-09-04 — thiết kế Azure MAA/AIK trước đó đã bị **thay thế và loại khỏi runtime,
> packaging lẫn server** theo quyết định của chủ dự án. A1 hiện dùng **protocol v3 CNG
> challenge–proof**: ưu tiên RSA-2048 trong Microsoft Platform Crypto Provider (TPM); nếu TPM
> không sẵn sàng thì dùng Microsoft Software Key Storage Provider với export policy bằng 0.
> Khóa software đã tồn tại được ưu tiên mở lại trước khi tạo khóa TPM mới để device ID không tự đổi.
> Challenge 32 byte dùng một lần/TTL 120 giây, proof PS256 bind đầy đủ action/license/product/
> device/challenge/request hash và token v3 TTL tối đa 900 giây. Database serialize activation,
> giới hạn lần thử challenge và chặn replay/downgrade. Tự động migrate seat legacy bằng HWID hoặc
> token v1/v2 vẫn bị loại bỏ; trường hợp legacy phải qua recovery/reset thủ công có audit.
>
> Server chỉ kết luận client giữ private key tương ứng public key đã đăng ký; server **không chứng
> minh khóa nằm trong TPM** và không tin provider/trust flag do client tự khai. Đây là residual risk
> có chủ đích để không phụ thuộc Azure: chống copy AppData/token và chia sẻ rẻ mạnh hơn A0, nhưng
> không chống tuyệt đối local admin, memory patch hoặc client Ring-3 bị sửa.
>
> Bằng chứng local hiện hành: sáu suite Edge/protocol/database/deployment/security liên quan
> **76/76**; desktop protocol/store trực tiếp **61/61** và typecheck đạt; Rust device identity **5/5** cùng
> `cargo check` đạt khi loại resource generated chưa tồn tại khỏi cấu hình kiểm tra; release inventory
> **49/49**; PowerShell parser và THIRD_PARTY_NOTICES check đạt. Full lint repo server còn thất bại
> bởi 141 error/581 warning đã tồn tại ngoài phạm vi; targeted lint các file đã sửa đạt 0 error
> (server còn 3 warning `any` cũ). Chưa chạy PostgreSQL/Edge/CNG thật, chưa
> clean build/install/deploy. Vì vậy §SEC.16 là **Mitigated + Accepted residual**, chưa `Closed`, và
> release tiếp tục `HOLD`.

#### Bằng chứng gốc trước Lô A0 (giữ để truy vết)

Các dòng dưới đây mô tả source tại mốc audit ban đầu; trạng thái current-source đã được thay thế
bởi phần cập nhật Lô A0 ở trên. Số dòng được giữ như bằng chứng lịch sử, không phải mô tả code hiện tại.

1. D:\pdfcompare\desktop\src-tauri\src\security.rs:157-186 giải mã
   prynx_hwid.dat bằng DPAPI CurrentUser, sau đó chỉ yêu cầu chuỗi kết quả không rỗng.
2. security.rs:190-235 ưu tiên giá trị trên disk trước khi tính fingerprint mới. Một giá trị
   đã được user hiện tại mã hóa lại bằng DPAPI được coi là HWID của cài đặt.
3. security.rs:289-300 gọi get_hardware_id() rồi verify token theo m của token; không có
   phép đo/attestation phần cứng độc lập với cache đó.
4. D:\pdfcompare\desktop\src\stores\useAuthStore.ts:312-321, :557-564 và :852-860
   giữ fallback `localStorage` do renderer kiểm soát khi native invoke lỗi. Native sẽ từ chối token
   lệch HWID ở bước đăng ký, nhưng Edge đã thực hiện activation và có thể đã nhét `rk` vào payload
   token trước bước đó; vì vậy fallback này vẫn không được coi là authority.
5. D:\printsolutions-main\supabase\functions\license-verify\index.ts:302-312 nhận
   machine_id từ request client, chỉ kiểm chuỗi không rỗng/độ dài rồi chuẩn hóa một phần.
6. Cùng file :384-387 chuyển raw machine_id vào RPC và :555-558 đưa raw machine_id vào
   payload Ed25519 được server ký.
7. Cùng Edge Function dùng normalizedMachineId cho block/RK ledger ở :335-340, :403-408 và
   :483-493, nhưng raw machine_id cho log/token ở :502-508, :525-529, :538-542, :555-568;
   authority vì thế không canonical ở mọi sink.
8. D:\printsolutions-main\supabase\migrations\20260828100000_prynx_activation_hardening.sql:252-277
   đếm COUNT(DISTINCT la.machine_id) rồi chèn theo chuỗi đó. Migration này đang untracked và
   trạng thái deploy production chưa được chứng minh.

#### Giả thuyết tấn công an toàn

Một user sở hữu profile có thể tạo một DPAPI blob hợp lệ cho một chuỗi định danh do mình chọn,
hoặc gửi cùng một định danh tới luồng activation trên nhiều máy. Native sẽ coi blob đó là HWID
cục bộ; Edge Function sẽ ký token có m tương ứng; bộ đếm DISTINCT machine_id nhìn thấy một
thiết bị logic thay vì các thiết bị vật lý. Không cần giả chữ ký Ed25519 và không cần đụng private
key.

Đây là lỗi authority, không phải lỗi bí mật của DPAPI: DPAPI vẫn ngăn user Windows khác đọc
blob, nhưng không ngăn chính user tạo ciphertext mới cho giá trị khác. Cũng có normalization drift:
Edge chuẩn hóa normalizedMachineId ở một số query nhưng gửi giá trị raw ở các call khác; điều này
có thể làm block/activation/telemetry không đồng nhất.

#### Tác động

- Một license có giới hạn thiết bị có thể bị chia sẻ cho nhiều máy bằng một identity logic.
- Reset/block và thống kê activation có thể áp dụng sai máy.
- Token vẫn phải là token server ký; finding này **không tự cấp Pro cho key không hợp lệ** và không
  làm Ed25519 yếu đi.

#### Phản chứng và giới hạn

- Native vẫn kiểm m, k, p, exp; vì vậy nếu HWID cache không bị định hình thì token lệch máy
  bị từ chối.
- DPAPI bảo vệ khỏi tài khoản Windows khác.
- Chưa chạy activation bằng license test trên hai môi trường cô lập và chưa thay đổi state bản cài
  thật; do đó runtime status vẫn là Needs validation.

#### Khắc phục đề xuất

- Trước mắt, bỏ fallback localStorage trong Tauri và không chấp nhận cache DPAPI nếu nó không khớp
  fingerprint vừa đo theo policy rõ ràng. Đây chỉ là **mitigation chuyển tiếp**, chưa đóng finding.
- Control hiện được chọn là CNG challenge–proof với TPM ưu tiên, software KSP fallback và token
  online TTL ngắn. Nếu sau này cần nâng từ `Mitigated + Accepted residual` lên mức attested mạnh,
  phải bổ sung verifier hardware attestation độc lập; đó là một dự án tùy chọn mới, không còn là
  blocker Azure của thiết kế hiện tại. Không coi chuỗi `machine_id` do client gửi là authority.
- Canonicalize identity tại server trước mọi block/count/log/RPC; lưu device-key id hoặc attested
  public key, không lưu raw string làm tiêu chí duy nhất.
- Có quy trình recovery/revoke thiết bị rõ ràng và fallback được chấp thuận cho máy không có TPM
  (fallback phải giảm entitlement hoặc buộc online, không âm thầm quay về chuỗi client).

**Residual risk:** client Ring-3 vẫn có thể patch app của chính nó; server challenge + khóa không
export được chỉ nhằm ngăn chia sẻ rẻ và giữ giới hạn thiết bị có ý nghĩa.

Sau Lô A0, đường sửa blob DPAPI/localStorage rẻ đã bị đóng nhưng WMI vẫn có thể bị giả ở local.
A1 v3 hiện đã có các control source/test nêu trên. Phần còn mở là chứng minh CNG challenge–proof,
software fallback, binding/migration nguyên tử và hard sunset protocol legacy trên staging/VM thật;
không còn relay Azure hoặc AIK trong phạm vi triển khai.

### §SEC.17 — P1/High (conditional Critical) — ACL khóa ký updater quá rộng trên máy build

**Lifecycle:** Triaged → Contained at release gate (Lô D1 source); operational remediation required
**Confidence:** 95% cho ACL quan sát được; 80% cho tác động vì cần xác nhận key còn active
**Trạng thái:** [CONFIRMED-STATIC][MITIGATED-SOURCE][EXTERNAL]

#### Bằng chứng

- File được kiểm metadata: C:\Users\Khanh Pham\.tauri\prynx.key (348 bytes; nội dung không
  được đọc/in).
- ACL hiện tại gồm user hiện hành, SYSTEM, BUILTIN\Administrators và
  KHANHPHAM-PC\CodexSandboxUsers Allow ReadAndExecute, Synchronize; rule của group là kế thừa
  và ACL không được bảo vệ khỏi inheritance. Thuộc tính `Encrypted=False`, nên file cũng không
  có lớp EFS bù trừ trên đĩa.
- Trước Lô D1, D:\pdfcompare\build_production.ps1 cho phép signer nhận key file và thêm
  `--password=` khi password rỗng.
- Public key updater tương ứng nằm trong
  D:\pdfcompare\desktop\src-tauri\tauri.conf.json:105-111.
- D:\pdfcompare\docs\audit\SECURITY_AUDIT_2026-07-26.md:178-182 ghi trạng thái cũ là key không
  passphrase; đây là dấu hiệu cần coi key hiện tại là có khả năng đã lộ cho tới khi audit
  access/rotate xong.

#### Tác động

Nếu một process/agent thuộc CodexSandboxUsers không hoàn toàn tin cậy đọc được private key,
process đó có thể ký updater artifact độc hại. Client kiểm chữ ký bằng public key nhúng sẽ coi
artifact là hợp lệ; đây là supply-chain compromise, khác hẳn patch local một máy.

Không có kết luận rằng group này chắc chắn chứa attacker hoặc key chắc chắn đang được release
production dùng. Vì vậy mức Critical chỉ áp dụng có điều kiện.

#### Hành động vận hành ưu tiên

1. Tạm coi key có khả năng compromise; kiểm access log/process history và danh sách thành viên
   group.
2. Rotate/revoke qua offline signer/HSM hoặc release account tách biệt; phát hành cơ chế chuyển tiếp
   public key cho client cũ trước khi vô hiệu key cũ.
3. Xóa inheritance không cần thiết, bắt buộc passphrase/secret broker, không để private key trong
   profile mà worker/agent dùng chung.
4. Kiểm tra toàn bộ release đã ký từ thời điểm ACL rộng; không đưa key bytes vào issue/log/report.

**Proof gap:** chưa xác nhận key này có trùng public key của channel đang phát hành, chưa có access
log và chưa xác nhận updater endpoint đã phát artifact nào bằng key đó.

#### Containment source sau Lô D1

- `build_production.ps1` từ chối private key inline/environment, khóa nằm trong repository, khóa
  qua reparse point, password rỗng, owner lạ, ACL kế thừa/không canonical hoặc principal ngoài
  current user/SYSTEM/Administrators. File khóa và thư mục cha đều được kiểm metadata.
- Guard chạy ở preflight và chạy lại ngay trước signer; password chỉ được đưa vào environment của
  signer rồi xóa trong `finally`. Đường fallback `--password=` đã bị loại bỏ.
- `PHAT_HANH.bat` nhận passphrase bằng `Read-Host -AsSecureString`; không đặt passphrase trên argv.
- Test guard, parse ba script PowerShell, parse PowerShell nhúng trong BAT và `git diff --check`
  đều pass. Probe chỉ đọc metadata xác nhận khóa hiện tại bị chặn vì ACL vẫn kế thừa; không đọc
  nội dung khóa và không chạy signer.

**Residual/điều kiện đóng:** đây là containment để ngăn release mới dùng key có metadata không đạt,
không chứng minh key cũ chưa từng bị đọc và cũng không chứng minh file thực sự được mã hóa chỉ vì
có password được cung cấp. §SEC.17 chỉ được đóng sau khi owner xác nhận trạng thái key, rà access và
release history, rotate/revoke theo kế hoạch tương thích client, tạo key mới có passphrase bằng
quy trình tin cậy, rồi xác nhận ACL file + thư mục cha đạt guard.

### §SEC.18 — P1/High — Nuitka persistent extraction cache chỉ kiểm CRC32

**Lifecycle:** Triaged → **Mitigated in source / runtime artifact validation pending**
**Confidence:** 98% cho source/config/lifecycle; 90% cho hành vi artifact cho tới khi smoke bản mới
**Trạng thái:** [CONFIRMED-STATIC][MITIGATED-SOURCE][VERIFIED-TEST]; **chưa Closed**

#### Bằng chứng gốc

- Bản build cũ dùng `--onefile-tempdir-spec="{CACHE_DIR}\PrynX\sidecar-{VERSION}"`, tạo cache
  persistent user-writable và tái sử dụng payload giữa các lượt chạy.
- `OnefileBootstrap.c` của Nuitka đã kiểm đọc cho thấy file có sẵn được đối chiếu bằng CRC32 ở
  đường cache hit; SHA-256 outer `pdf-inspector-backend.exe` không chứng minh byte trong cache còn
  nguyên. Cache của bản cài quan sát được có khoảng 1.080 file mỗi version và user có FullControl.
- Vì vậy một payload cache bị thay đổi nhưng vẫn thỏa kiểm yếu có thể được bootstrap tin lại, trong
  khi outer PE vẫn khớp. Audit không tạo collision, patch payload hoặc chạy mã thay thế.

#### Bản vá source đã áp dụng — lô C, đúng 5 file

1. `build_production.ps1` chuyển sidecar sang `--onefile-cache-mode=temporary` và
   `--onefile-tempdir-spec="{TEMP}\PrynX\sidecar-{PID}-{TIME_US}-{RANDOM}"`; payload không còn
   được chủ ý tái sử dụng theo version.
2. `backend/app/main.py` thêm endpoint shutdown ẩn với HMAC-SHA256, timestamp ±30 giây, nonce
   một lần và Uvicorn graceful timeout. Lệnh thoát chỉ được xếp sau khi response `202` đã gửi.
3. `desktop/src-tauri/src/lib.rs` giữ shutdown authority trong memory; lọc toàn bộ năm biến
   `NUITKA_ONEFILE_*` khỏi cả hai đường spawn; serialize spawn/shutdown; bind mỗi thế hệ sidecar
   bằng `{generation, PID, creation FILETIME}` và pinned process handle. Event cũ không thể clear
   thế hệ mới; thiếu/sai identity thì không `taskkill` PID trần mà dựa vào Job Object.
4. `scripts/verify_installed_artifact.ps1` chạy hai lượt trong TEMP riêng, bắt buộc hai extraction
   path khác nhau, parse PID từ tên extraction rồi đối chiếu live identity + executable path +
   lineage về đúng app root. Verifier duyệt cây không đi xuyên reparse point, yêu cầu shutdown êm,
   không chấp nhận force-kill/residue và chỉ ghi `RUNTIME_VERIFIED=yes` sau khi mọi chốt đạt.
5. `backend/tests/test_artifact_runtime_self_test.py` thêm ratchet cho build flags, HMAC/replay,
   môi trường spawn, process identity và topology Nuitka Windows nơi outer/inner có cùng EXE path.

Rust còn dọn best-effort cache persistent cũ và extraction temporary stale chỉ sau khi sidecar mới
đã chứng minh startup identity. Parser tên/PID, ancestor và reparse check đều fail-safe: cấu trúc
lạ bị bỏ qua thay vì xóa mù.

#### Verify source

- Backend policy/runtime tests: **33 passed**, 1 warning Pydantic deprecation có sẵn.
- Rust `cargo test --lib`: **179 passed, 5 ignored, 0 failed**.
- `cargo check --release`: pass, phủ nhánh Win32 release-only giữ process handle.
- PowerShell parse cho build/verifier: pass; `git diff --check` đúng 5 file: pass.
- Review độc lập đã bắt và sửa hai lỗi trước chốt: verifier từng chọn process duy nhất theo EXE path
  (sai với topology outer/inner), và race PID-reuse trước `OpenProcess`. Hậu kiểm cuối không còn
  blocker P0/P1/P2 trong lô §SEC.18.
- `cargo fmt --check` toàn crate vẫn báo formatting drift tại WIP có sẵn trong `lib.rs` và các file
  ngoài lô (`print.rs`, `print_worker.rs`, `process_guard.rs`); không bulk-format để tránh sửa lan
  thay đổi của user. Không có production build, ký hoặc publish trong lô này.

#### Residual và điều kiện đóng

- Chưa có artifact mới nên chưa chứng minh thực tế hai path khác nhau, `CloseMainWindow` → HMAC →
  Uvicorn lifespan → bootstrap cleanup, cũng chưa đo ảnh hưởng cold-start.
- `{RANDOM}` hiện do Nuitka Windows sinh bằng xorshift32 và bootstrap chấp nhận thư mục đã tồn tại.
  Hai path khác nhau trong smoke không phải bằng chứng tuyệt đối chống attacker cùng user dự đoán/
  pre-create đường dẫn. Cần negative test trong VM disposable; nếu không đạt, phải chuyển sang
  launcher tạo directory an toàn hoặc cơ chế provenance mạnh hơn.
- Scan reparse rồi sử dụng/xóa vẫn có TOCTOU ở Ring-3; crash/End Task có thể để residue. Stale
  cleanup chỉ là recovery, không phải trust proof cho payload đang chạy.
- Startup current-source không còn `taskkill /IM` theo tên. Listener không xác thực làm startup
  fail-closed và yêu cầu người dùng xử lý; packaged lifecycle/fault-injection vẫn là residual §SEC.22.
- User có debugger/admin vẫn có thể patch process. Mục tiêu của lô là loại đường sửa persistent
  cache rẻ, không tuyên bố chống crack tuyệt đối.

Chỉ chuyển §SEC.18 sang **Closed** sau khi build artifact mới từ staging tin cậy, chạy verifier trên
clean Windows VM ít nhất hai lượt, xác nhận không force-kill/residue, thử pre-create/junction và
đo cold-start trong ngân sách release. Nếu bất kỳ bằng chứng nào thiếu, giữ nguyên trạng thái trên.

### §SEC.19 — P1/High — Anti-clock rollback và token offline

**Lifecycle:** Applied → Verified (code + targeted tests); residual/deploy/runtime pending
**Confidence:** 95% cho bản vá source; chưa đổi giờ trên máy thật
**Trạng thái:** [VERIFIED-CODE][VERIFIED-TEST], chưa [VERIFIED-RUNTIME]/[VERIFIED-DEPLOY]

> Cập nhật 2026-09-03: trace trước bản vá trong bản báo cáo 2026-09-02 đã được supersede bởi
> `BAO_CAO_AUDIT_SEC19_REAUDIT_2026-09-03.md`.

- Backend phân biệt installation key/marker/record missing, corrupt, tampered và unavailable;
  sau bootstrap, mất/hỏng state buộc fail-closed thay vì tự coi là cài đặt mới.
- Native signer và mọi nhánh offline của renderer cùng kiểm `AnchorState`; khôi phục anchor cần
  token v2 có `iat` và challenge dùng một lần. Đổi license key được serialize và staged.
- Session key của chữ ký request được derive theo từng `sidecar generation`; chữ ký thế hệ cũ
  không hợp lệ sau respawn ngay cả khi bảng nonce của tiến trình mới còn rỗng. Khe replay hẹp
  `§ATK.09` vì tái dùng cùng secret đã được đóng ở mức source/test, không phải runtime artifact.
- Bằng chứng current-source được chốt ở snapshot 2026-09-04 trong §6.2.
- Chưa Closed vì còn đường xóa đồng thời toàn bộ state trước bootstrap, stress/fault test chưa có,
  Edge chưa deploy/xác minh và chưa chạy clean-installer clock rollback/forward/restart smoke.

### §SEC.20 — P1/High (conditional Critical) — Release secret residue trong install root

**Lifecycle:** Discovered → Needs validation
**Confidence:** 95% file residue hiện hữu; 70% khả năng đã nằm trong package khách hàng
**Trạng thái:** [EXTERNAL]

#### Bằng chứng

- Có file C:\Users\Khanh Pham\AppData\Local\PrynX\ReleaseSecrets\secrets.clixml.
  Import dưới đúng Windows user trả payload schema/project hợp lệ và trường
  System.Security.SecureString; giá trị secret không được in, chỉ xác nhận có thể giải mã
  trong context user hiện tại.
- ACL hiện tại của file chỉ cho user hiện hành FullControl; điều này bảo vệ khỏi user Windows
  khác nhưng không bảo vệ khỏi process chạy cùng user.
- probe.clixml trong cùng thư mục là artifact probe do audit tạo, không được coi là release secret.
- D:\pdfcompare\scripts\release_secret_store.ps1:71-125 chủ động lưu Supabase secret bằng
  DPAPI CurrentUser để build; build_production.ps1 đọc just-in-time.
- Counterevidence quan trọng: D:\pdfcompare\desktop\src-tauri\tauri.conf.json:120-124 resource list
  hiện không khai báo ReleaseSecrets. Chưa có clean installer inventory chứng minh file có/không
  nằm trong package public.

#### Tác động có điều kiện

Nếu secrets.clixml hoặc secret còn sống từng được ship tới máy khách, đúng user đó có thể giải
mã và dùng quyền Supabase service để tác động license/resource-key authority. Khi đó đây là
compromise server-side, nghiêm trọng hơn crack local. Nếu file chỉ là residue trên máy build riêng
và chưa từng vào installer, đây là hygiene/provenance risk chứ chưa phải lỗ khách hàng.

#### Khắc phục đề xuất

- Chạy negative inventory trên installer/NSIS/portable artifact và CI gate cấm ReleaseSecrets,
  *.clixml, .env, private key và secret pattern trong package.
- Tách build host/profile khỏi %LOCALAPPDATA% của app; secret lấy từ vault/ephemeral runner,
  xóa residue sau release theo quy trình có log.
- Nếu có bất kỳ bằng chứng ship hoặc access không kiểm soát: rotate/revoke secret ngay, rà lịch
  sử dụng service-role và phát hành lại artifact sạch.

**Proof gap:** chưa có installer sạch được giải nén và inventory độc lập; chưa biết secret có còn
active hay đã rotate; chưa truy production audit log.

### §SEC.21 — P2/Medium — Signature v2 đã bind request body ở source/test

**Lifecycle:** Applied → Verified in code/targeted tests; packaged runtime pending
**Confidence:** 95% cho control source; chưa [VERIFIED-RUNTIME]
**Trạng thái:** [VERIFIED-CODE][VERIFIED-TEST][EXTERNAL]

#### Bằng chứng

- Signature v2 bind method, raw path/query, credential snapshot, content type, body mode và body
  commitment; backend dựng cùng chuỗi và malformed raw query vẫn fail-closed.
- JSON/string/binary bind raw bytes. FormData bind thứ tự, field trùng và metadata file thay vì
  dựa trên một object đã làm mất thông tin. Streaming chỉ được parse/submit sau khi commitment
  được kiểm tại EOF.
- Ratchet hiện kiểm **191/191 route đã đăng ký** có policy body tương ứng. Đây là số route trong
  inventory coverage, không phải “191 test”. Mutation/targeted tests đã khóa raw query, body đổi,
  FormData và streaming.

Control này ràng buộc tính toàn vẹn request; route vẫn phải giữ schema, entitlement và authorization
độc lập. Source coverage không tự chứng minh byte/path thực tế của packaged WebView/sidecar.

#### Khắc phục đề xuất

- Chạy packaged-runtime smoke với JSON/string/binary, FormData có duplicate/order, file metadata,
  streaming và retry; đổi một thành phần sau ký phải fail-closed.
- Giữ ratchet 191/191 route và authorization/feature gate độc lập khi thêm route hoặc body mode mới.

### §SEC.22 — P2/Medium — Source đã bỏ kill theo tên; packaged lifecycle còn mở

**Lifecycle:** Applied → Verified in source tests; packaged runtime pending
**Confidence:** 95% source / 85% cho quan sát artifact lịch sử
**Trạng thái:** [VERIFIED-CODE][VERIFIED-TEST][HISTORICAL-RUNTIME]

#### Quan sát

Trong probe bản cài 1.0.0.900 lịch sử, sidecar còn sống hơn 30 giây sau khi đóng UI. Điều này tạo khoảng thời gian
localhost service vẫn tồn tại sau khi người dùng nghĩ app đã đóng, có thể giữ file/port và làm tăng
bề mặt cho process local khác. Artifact probe và log được giữ tại
D:\pdfcompare\.tmp-security-audit\runtime-antitamper-20260902-a1.

Source hiện tại đã xóa startup `taskkill /IM`: chỉ sidecar do app sở hữu, có HANDLE + creation
FILETIME, mới được shutdown/force-kill. Port 8321 còn listener không xác thực sau 3 giây làm app
fail-closed và ghi breadcrumb. Regression backend kiểm shutdown HMAC/nonce/Uvicorn; Rust overlay
nằm trong snapshot hiện hành **227 pass/5 ignored** ở §6.2. Chưa có artifact mới nên chưa chuyển
sang Runtime Verified.

#### Khắc phục/verify

- Chạy packaged release smoke: đóng cửa sổ chính, Alt+F4, crash, update cancel, second instance;
  xác nhận cả cây process biến mất và port được nhả trong SLA.
- Giữ startup proof/secret handshake; không tự kill listener không xác thực.
- Ghi PID generation và reason vào log không chứa secret; thêm test regression cho stale sidecar,
  installer update và reboot.

### §SEC.23 — P1/High (tác động có điều kiện) — Payload provenance đã có control source/test

**Lifecycle:** Applied → Verified in source/targeted tests; artifact provenance pending
**Confidence:** 97% source / 75% cho tác động vì chưa có clean-build diff
**Trạng thái:** [VERIFIED-CODE][VERIFIED-TEST][EXTERNAL]

#### Bằng chứng

- `build_production.ps1` kiểm mọi path component/reparse point trước khi làm mới staging. Recursive
  cleanup chỉ được phép với sidecar/manifest và cây `tesseract/` do pipeline sinh; nếu gặp
  `data/`, `uploads/`, `results/` hoặc WIP lạ thì build dừng trước khi xóa. Sidecar `externalBin`
  ở app root được tách khỏi manifest resource và tiếp tục khóa bằng `SIDECAR_SHA256`.
- Pipeline sinh `payload-manifest.json` gồm path, size và SHA-256. Guard đọc lại live filesystem,
  so exact-set/hash/size ngay sau khi tạo và lần nữa sát lệnh Tauri; sidecar cũng được rehash.
- `tauri.conf.json` khai manifest là resource. `scripts/verify_installed_artifact.ps1` bắt buộc đúng
  một manifest dưới cây cài, kiểm root và mọi path component, từ chối path/hash trùng hoặc sai,
  surplus/missing/hash mismatch, reparse point và ADS; chỉ chạy Tesseract sau khi exact-set đạt.
- Tesseract lock pin version, canonical path, size và SHA-256. Guard từ chối hardlink/link-count
  bất thường và giữ identity lease, cùng các kiểm ADS/reparse đã có, trước khi payload được dùng.
- Regression PowerShell thực thi đã chứng minh file thêm, byte đổi và dữ liệu lạ trước recursive
  cleanup đều làm guard đỏ; snapshot verify hiện hành nằm ở §6.2.

#### Tác động và điều kiện

Source gate nay chặn residue cũ, file ngoài resource glob, drift trước bundle, nguồn Tesseract sai
lock và identity/link không đạt. Tuy vậy, chưa có artifact từ clean build để chứng minh cùng bộ byte
đã đi xuyên staging → installer → install tree → uninstall; process admin/Ring-3 trên build host vẫn
là residual ngoài khả năng loại bỏ tuyệt đối bằng control client-only.

#### Khắc phục/verify

- Chạy clean build → giải nén installer → cài → exact-set → gỡ cài trên VM; thử sentinel, junction,
  ADS, hardlink, file nguồn thừa, hash mismatch và residue sau uninstall.
- Đối chiếu provenance và identity lease xuyên pipeline; kiểm runtime chỉ chạy payload sau exact-set.

**Proof gap:** chưa chạy build trong checkout sạch/VM, chưa giải nén installer current-source và
chưa đối chiếu exact-set/provenance từ staging → installer → cây cài → sau uninstall.

### §SEC.24-R1–R7 — Trusted executable, source và publisher authority

**Lifecycle:** Applied → Verified in source/targeted tests; artifact/runtime pending
**Severity:** không tự gán trong lượt hardening này
**Trạng thái:** [VERIFIED-CODE][VERIFIED-TEST][EXTERNAL]

- **R1–R3:** Rust chọn PowerShell từ System32; pipeline pin và giữ identity lease cho PowerShell,
  `cmd`, `gh`, Node, Git và Robocopy. npm/Tauri chạy bằng trusted Node với entrypoint
  JavaScript/native binding chính xác; môi trường ambient Node/NAPI bị xóa hoặc bị từ chối. Guard
  Authenticode nạp module inbox qua đường cố định, gọi cmdlet module-qualified và kiểm
  publisher/InternalName theo authority đã chốt.
- **R4:** Cargo, Rustc, Rustdoc và `rust-std` đến từ byte-set có lock versioned/content-addressed;
  release giữ lease, kiểm exact-set trước/sau consumer và bind toolchain provenance vào manifest.
- **R5:** updater chỉ chấp nhận đúng một endpoint HTTPS canonical trên `github.com`; host/repo đích
  của mọi thao tác publish được pin vào endpoint đã audit thay vì ambient routing.
- **R6:** Git chỉ đọc đúng `ROOT\.git` qua grammar allowlist (gồm `--absolute-git-dir`), lease
  config/index/info/ancestor và từ chối common/split worktree, config có điểm thực thi, hidden index
  flag hoặc gitlink. GitHub CLI dùng config từ Windows Known Folder, lease `config.yml`/`hosts.yml`,
  pin `github.com`, exact command/API route và effective config; SemVer chỉ nhận chữ số ASCII,
  raw/escaped tag route phải đúng dạng publisher tạo và percent-escape tổng quát bị từ chối. Đường
  khóa updater lấy từ UserProfile Known Folder, không tin ambient `USERPROFILE`, đồng thời chặn
  UNC/reparse. UI mở log bằng Notepad System32 đã kiểm chữ ký và giữ lease. Login pin HTTPS/device
  web flow, `--skip-ssh-key`, `GH_PROMPT_DISABLED=1`, không dùng clipboard và không tự mở browser,
  dò Git hoặc tạo/upload SSH key. Re-audit trên Git for Windows 2.53 phát hiện
  `core.excludesFile=NUL` làm mọi protected `status` lỗi trước sink; guard nay trỏ
  `core.attributesFile`/`core.excludesFile` vào đúng hai file rỗng đang được lease và có positive
  clean-status regression, nên vẫn fail-closed mà không tự khóa checkout hợp lệ.
- **R7:** `PRYNX.bat` và `PHAT_HANH.bat` neo PowerShell vào `%__APPDIR__%` do `cmd.exe` hiện tại sinh,
  không dùng ambient `%SystemRoot%`/`PATH` trước khi guard PowerShell nhận quyền.

Policy `hosts.yml` là bộ kiểm lexical fail-closed cho credential key và YAML block-style canonical
đã đối chiếu với GitHub CLI 2.93.0; nó **không phải YAML-general scanner**. Publisher dừng trước mọi
lệnh mạng nếu thấy `oauth_token`/`token` plaintext hoặc cú pháp YAML ngoài policy. Ngày 2026-09-04,
trusted wrapper đã xác minh read-only OAuth active, scope `repo` được khai báo, credential nằm trong
Windows Credential Manager và truy cập đúng commit của repo PrynX trên GitHub. Không push/publish.
`gh auth login` vẫn phải ghi config nên cửa sổ login không thể giữ lease read-only; thay đổi
serialization/policy ở phiên bản `gh` sau 2.93.0 vẫn là `[EXTERNAL]` và phải re-audit.

Checkout hiện tại chứng minh fail-closed đúng thiết kế nhưng chưa đủ điều kiện release:
`.git/config` có `extensions.worktreeConfig=true`, `.git/info/exclude` dài 335 byte và
`.git/info/attributes` đang thiếu. Không chuẩn hóa trực tiếp checkout này: nó còn 53 tracked change,
5.679 untracked entry, hai linked worktree và `/_quarantine/` có 81.753 file đang được local exclude
che. Phải chốt/commit/push đúng source rồi tạo clone độc lập tại commit đó; trong clone mới, giữ
`extensions.worktreeConfig` absent và tạo cả hai file `info` thường, rỗng 0 byte. Đây là prerequisite
cục bộ, không phải `[EXTERNAL]`.

Các control trên đã qua grammar/AST/bare-invocation/mutation ratchet và test mục tiêu, nhưng chưa có
release artifact/current checkout hợp lệ để chạy packaged bootstrap, hostile-`PATH` và publisher
runtime thật. Vì vậy §SEC.24 không làm thay đổi quyết định `HOLD`. BAT cũng không thể tự chứng minh
authority của interpreter đầu tiên: file association, explicit wrapper/interpreter giả hoặc patch
registry/process bởi admin/debugger vẫn là residual accepted risk Ring-3.

## 6. Test và runtime evidence

### 6.1. Black-box bản cài

| Ca kiểm | Kết quả |
|---|---|
| Port/listener sidecar | Chỉ thấy loopback 127.0.0.1:8321 |
| /docs, /redoc, /openapi.json | 404 |
| Header/signature thiếu hoặc sai | 403 |
| Origin giả/null | Bị CORS từ chối |
| Env override dev/feature gate | Không bypass binary release |
| Sửa một byte sidecar PE | Startup proof phát hiện, không mở port |
| Sửa checksum frontend PE | Process vẫn chạy; chỉ xác nhận accepted Authenticode gap |
| Đóng UI | Một artifact probe để sidecar sống >30 giây; cần packaged re-test |

Không có test nào dùng license khách hàng, private key, service secret hoặc hệ thống public.

### 6.2. Suite tự động đã chạy trong phiên audit

- Baseline lịch sử ngày 2026-09-02: frontend 38 pass; Rust 167 pass/5 ignored; backend 151 pass,
  1 skip và 1 lỗi runner ACL trước assertion DPAPI.
- Follow-up lịch sử ngày 2026-09-03: frontend auth/license **64 pass** + typecheck;
  Rust overlay **191 pass, 5 ignored**; backend security mục tiêu **128 pass**.
- Hai test DPAPI/ACL chạy ngoài sandbox Windows đạt **2 pass** sau khi cô lập `PSMODULEPATH`;
  test không bỏ kiểm raw plaintext/UTF-8/UTF-16/round-trip. Artifact/security harness riêng đạt
  **32 pass**; hai script PowerShell parse và `git diff --check` đạt.

Snapshot current-source ngày 2026-09-04 sau các lô §SEC.15/.19/.21/.23/.24-R1–R7:

- backend token/body/route/probe: **144/144**;
- frontend auth/license: **89/89**, `npm run typecheck` đạt;
- Edge ratchet: **36/36**;
- Rust Tauri: **227 passed, 5 ignored**; `cargo check --release --lib` và `cargo fmt -- --check` đạt
  với `TAURI_CONFIG='{"bundle":{"resources":[]}}'`; nhóm registry Save As **23/23** nằm trong
  bằng chứng Rust mục tiêu;
- `test_release_secret_store.py`: lượt trước **19 pass + 3 `[BLOCKED-ENV]` trong sandbox**; sau bản
  vá availability R6, chạy toàn file ngoài sandbox đạt **22/22**;
  `test_artifact_runtime_self_test.py`: **55 pass + 1 `[BLOCKED-ENV]`**; cả bốn ca bị chặn bởi
  sandbox/ACL/pipe Windows đạt **4/4** khi chạy ngoài sandbox;
- no-Ghostscript policy **49/49**; native release QA **1/1**; grammar/wrapper/AST mục tiêu **3/3**;
- parser Windows PowerShell 5.1 và pwsh 7 đạt cho bốn script release; `py_compile` đạt cho hai file
  test Python; independent review YAML/line-ending/BAT và bare-executable verifier không có hit;
- route ratchet phủ **191/191 route đã đăng ký**. Đây là coverage inventory, không phải test count.

Các suite trên là bằng chứng regression của các control đã có; chúng **không** đóng proof gap của
artifact/runtime/deploy cho §SEC.15–§SEC.24.

## 7. Accepted risk, false positive và finding không mở ID mới

1. **§SEC.11 cũ — Authenticode chưa được cưỡng chế:** Tauri nhúng frontend vào binary nên
   directory hash không áp dụng trên NSIS; self-exe chỉ log hash. Đây là accepted Ring-3 risk đã
   ghi trong báo cáo 2026-08-28, không lặp lại thành ID mới. Source hiện tại tự ghi
   `CODE_SIGNED = no` tại build_production.ps1:1756 và nhánh NSIS skip integrity frontend tại
   desktop/src-tauri/src/lib.rs:5224-5250. Control artifact còn thiếu là code signing +
   `WinVerifyTrust`; nó tăng publisher/artifact integrity nhưng không loại được admin patch cả
   binary lẫn self-check ở Ring-3. Một hash nhúng trong chính exe không tự giải được vấn đề này.
   Chữ ký updater minisign là control khác, không thay Authenticode cho PE đã cài.
2. **shell:allow-open không đồng nghĩa arbitrary EXE:** plugin vẫn áp regex scheme mặc định
   (http(s), tel, mailto) trong capability đã kiểm; không có exploit path đủ để mở finding mới.
3. **WebSocket credentials qua query:** backend/app/api/routes/ws.py:17-66 có rủi ro secret
   xuất hiện trong proxy/access log, nhưng chưa thấy frontend consumer reachable trong phạm vi này;
   ghi coverage/future risk, chưa gọi là vulnerability.
4. **CORS/TrustedHost:** backend/app/main.py:304-329 cho phép localhost + credentials và nhiều
   method/header. Đây là hardening gap; chưa có đường exploit độc lập vượt qua sidecar signature.
5. **DPAPI không phải hardware attestation:** đây là nguyên nhân cốt lõi của §SEC.16, không nên
   ghi “DPAPI bị bẻ”. DPAPI đang làm đúng việc confidentiality/integrity đối với user khác; nó chỉ
   không thể làm authority chống chính chủ profile.
6. **Anti-debug/anti-dump:** chỉ là defense-in-depth. Người có quyền debug máy mình vẫn có thể
   quan sát/patch; không dùng kết quả này để hứa “không thể crack”.

## 8. Coverage và proof gap còn mở

### Đã rà

- Tauri startup/sidecar supervisor, security.rs, lib.rs integrity và process lifecycle.
- Frontend api.ts, useAuthStore.ts, licenseToken.ts.
- Sidecar license_guard.py (HMAC, nonce, clock, Ed25519, entitlement).
- Edge license-verify, migration activation hardening và config updater trong hai repo.
- Bản cài PE, cache extraction, ACL, release-secret residue, resource staging và installer verifier.

### Chưa đủ bằng chứng

1. Runtime fixture với license test để chứng minh §SEC.16 từ lúc tạo HWID cache đến activation
   count/token trên hai máy cô lập.
2. Build artifact mới rồi chạy verifier §SEC.18 trên clean Windows VM: hai extraction path riêng,
   graceful cleanup không force-kill/residue, cold-start; thêm negative pre-create/junction. Không
   thử phá trên bản cài người dùng.
3. Clock snapshot test cho restart/xóa state/rollback/forward jump (§SEC.19).
4. Clean installer/portable extraction và negative inventory cho ReleaseSecrets (§SEC.20).
5. Production Supabase: migration nào đã db push, GRANT/RLS thực, key rotation và service-role
   audit log.
6. Updater key: membership/access log của CodexSandboxUsers, public-key continuity và artifact
   history (§SEC.17).
7. Packaged runtime current-source: sidecar shutdown, update/restart, second instance, stale port
   (§SEC.22).
8. Packaged-runtime proof cho signature v2/body commitment §SEC.21; source ratchet hiện phủ
   191/191 route đăng ký, không được suy thành runtime artifact.
9. Clean-build exact inventory từ staging mới/rỗng tới installer, install tree và uninstall residue
   (§SEC.23); source đã có Tesseract lock, hardlink/link-count, ADS/reparse, identity lease và
   manifest/exact-set/live-rescan, nhưng artifact provenance/negative VM vẫn mở.
10. Save As UI trên bản cài, share NAS và filesystem không phải NTFS (§SEC.15).
11. Trusted clean clone hoặc chuẩn hóa ba metadata blocker cục bộ của §SEC.24-R6, rồi chạy packaged
    double-click/hostile-`PATH` cho R1–R7. OAuth/Credential Manager/GitHub thật đã đạt read-only trên
    máy audit với `gh` 2.93.0; quyền push/release chưa được thử vì sẽ làm đổi external state. Phiên
    bản `gh` tương lai, Authenticode artifact và publisher continuity vẫn `[EXTERNAL]`; BAT
    interpreter/file-association dưới quyền Ring-3 là residual accepted risk.

Thiếu các điểm trên không được suy thành “đã an toàn” cũng không được suy thành “đã crack thành công”.

## 9. Thứ tự remediation đề xuất (mỗi lô tối đa 5 file)

Đây là thứ tự remediation xuất phát của audit. A0, B, C, D1, phần source D2, toàn bộ request
binding source của E và phần startup của F đã được áp dụng/verify mục tiêu; các residual dưới đây
vẫn phải qua artifact,
runtime, deploy hoặc thiết kế riêng. Mỗi lô phải verify xong trước khi chuyển lô kế.

| Lô | Ưu tiên | Phạm vi đề xuất (≤5 file) | Verify bắt buộc |
|---|---|---|---|
| **A0 — Chặn thay HWID rẻ** | Ngay sau chốt duyệt; chỉ Mitigated | desktop/src-tauri/src/security.rs; desktop/src/stores/useAuthStore.ts; một test frontend; Edge license-verify; một contract test server | Cache DPAPI phải khớp fingerprint vừa đo; Tauri không fallback localStorage; mọi sink dùng canonical ID; không làm khách hợp lệ ăn thêm seat |
| **A1 — CNG device-key proof v3** | P0 — control source/test đã áp dụng; runtime/deploy còn mở; residual software/Ring-3 được chấp nhận | Native CNG TPM-preferred + software fallback; Edge challenge/verify; migration v3; token verifier | Bộ acceptance §9.1 với license TEST/VM; không dùng production; kết luận tối đa là Mitigated nếu không có hardware attestation |
| **B — Clock anchor** | P1 — **đã áp dụng source, còn runtime/deploy** | backend/app/core/license_guard.py; desktop/src-tauri/src/security.rs; desktop/src/stores/useAuthStore.ts; desktop/src/stores/licenseToken.ts | VM snapshot restart/delete/rollback/forward; token expired/revoked; kiểm offline UX và fail-closed |
| **C — Cache integrity** | P1 — **đã áp dụng source, chờ artifact runtime** | build_production.ps1; scripts/verify_installed_artifact.ps1; desktop/src-tauri/src/lib.rs; backend/app/main.py; backend/tests/test_artifact_runtime_self_test.py | Hai extraction path riêng, bind đúng bootstrap lineage, graceful cleanup không force-kill/residue, pre-create/junction và cold-start trên artifact mới |
| **D1 — Release key/secret** | P1 vận hành | scripts/release_secret_store.ps1; build_production.ps1; CI workflow; updater public-key manifest | ACL review, secret/package negative scan, offline signing/rotation, artifact verify; do ops owner thực hiện |
| **D2 — Closed payload inventory** | P1 — **source/test đã áp dụng; chưa Closed** | build_production.ps1; tauri.conf.json; verify_installed_artifact.ps1; inventory regression test | Clean build/install/uninstall; sentinel/reparse/ADS/hardlink negatives; đối chiếu provenance xuyên artifact |
| **E — Request binding** | P2 — **signature v2 + body commitment đã áp dụng source/test** | desktop/src/lib/api.ts; backend/app/core/license_guard.py; route tests | Packaged JSON/binary/FormData/streaming/retry smoke; route authorization vẫn độc lập |
| **F — Lifecycle/package proof** | P2 — **startup source đã áp dụng; runtime còn mở** | desktop/src-tauri/src/lib.rs; installer hook/config; packaged smoke harness; lifecycle regression tests | Close/crash/update/second-instance/reboot trên installer hiện hành; chứng minh port/process cleanup |

Ngoài thứ tự xuất phát này, §SEC.15 và §SEC.24-R1–R7 đã có control source/test vào 2026-09-04. Phần
còn lại tương ứng là Save As UI/NAS/non-NTFS; chuẩn hóa checkout release cục bộ; và packaged
double-click/hostile-`PATH`/OAuth/Credential Manager/GitHub runtime. Không mở thêm lô source chỉ để
thay cho các bằng chứng ngoài workspace đó.

### 9.1. Tiêu chí nghiệm thu bắt buộc cho Lô A

#### Mức kết luận

- **A0 chỉ được ghi Mitigated:** cache DPAPI phải được đối chiếu với fingerprint vừa đo; Tauri
  không fallback sang localStorage; Edge canonicalize một lần và dùng cùng ID cho activation,
  block, revoke, RK ledger, token và log. Fingerprint WMI vẫn có thể bị giả/clone nên chưa Closed.
- **A1 hiện là Mitigated + Accepted residual:** device ID là fingerprint của public key; native ưu
  tiên TPM, cho phép software KSP non-exportable khi TPM không sẵn sàng. Mỗi activation, heartbeat
  nhạy cảm, cấp `rk` và release seat phải có proof trên challenge ngẫu nhiên, một lần, thời hạn
  ngắn. Vì server không xác minh hardware attestation, A1 chứng minh quyền giữ private key chứ
  không chứng minh tuyệt đối khóa gắn với TPM/máy; không ghi `Closed` theo threat model hiện tại.

#### Binding và authority

- Challenge/proof bind tối thiểu: license, product, device-key ID, action, protocol version,
  challenge ID/value và expiry; canonical encoding chỉ có một định nghĩa dùng chung client/server.
- Server không cấp token hoặc `rk`, không tính seat và không release seat chỉ dựa trên raw
  `machine_id`, `app_version`, User-Agent hay protocol do client tự khai.
- Native phải chứng minh private key cục bộ tồn tại trước khi chấp nhận token offline. Token v3 mang
  signed claim protocol + device-key ID; cả Rust và Python verifier từ chối claim thấp hơn minimum.
- Nếu Platform KSP/TPM không sẵn sàng, native chỉ được fallback sang Microsoft Software KSP với
  signing-only và export policy bằng 0; key mất phải đi recovery. Không âm thầm quay về HWID cũ.
- Việc chia sẻ/extract software key hoặc patch client dưới local admin vẫn là residual risk. Rate
  limit theo license/device/action, phát hiện đồng thời bất thường và audit log không chứa secret là
  control bù trừ, không được mô tả như hardware attestation.

#### Migration và tương thích ngược

- Deploy schema + server trước client; migration versioned, idempotent và rollback có record.
- Client cũ không được tự migrate chỉ bằng HWID hoặc token v1/v2 có thể copy. Token legacy chỉ sống
  tới hạn hiện có; activation legacy muốn chuyển sang device-key ID phải qua recovery/reset thủ công
  có owner và audit, dưới cùng advisory lock/device limit.
- Hai máy từng dùng chung một legacy ID không được cùng nhập thành một seat. Mỗi device key mới chịu
  đúng device limit; block/revoke tombstone được bảo toàn.
- Chốt rõ “device” là máy vật lý hay Windows profile. Reinstall, TPM clear, đổi mainboard/profile
  phải đi qua recovery/revoke/reset có owner và audit trail, không tự enrollment như máy cũ.
- Format license, plan/features, resource key và luồng đổi/release key của khách hợp lệ phải giữ
  tương thích, trừ các claim/proof v3 bắt buộc đã công bố.

#### Chống downgrade

- Minimum protocol là state đơn điệu phía server. Sau cutoff, request legacy thiếu proof luôn trả
  `UPGRADE_REQUIRED`, không trả token mới hoặc `rk`; không tin `app_version` để cho phép v1.
- Bản cũ chỉ chạy đến khi token cũ hết TTL. Muốn ngăn tuyệt đối bản cũ nhận token mới, rollout phải
  xoay staged license-signing key: client mới tin key mới, server ngừng ký key cũ sau cửa sổ chuyển.
- Rollback DB/feature flag không tự bật lại raw-HWID. Emergency compatibility phải có TTL, owner,
  reason và audit event riêng.

#### Bộ test release-blocking tối thiểu

1. Native tạo key idempotent; device-key ID ổn định qua restart; private key không export được.
2. Native ưu tiên Platform KSP, fallback đúng Microsoft Software KSP khi TPM không sẵn sàng; cả hai
   phải signing-only, RSA-2048 và export policy bằng 0; device ID ổn định qua restart/provider recovery.
3. Sign/verify challenge hợp lệ; reject thiếu local key, hết hạn, replay và sai
   license/product/action/device/protocol.
4. Thay public key giữa challenge và activation bị từ chối.
5. Blob DPAPI do cùng Windows user tạo và localStorage tùy ý không còn ảnh hưởng authority.
6. Copy AppData/token/public metadata từ VM A sang VM B không có private key bị native và server
   từ chối; khả năng extract/clone software key dưới local admin được ghi nhận là residual risk.
7. Đăng ký lần đầu + retry idempotent không tăng seat.
8. Hai registration đồng thời với `max_devices=1`: đúng một thành công.
9. Automatic legacy migration bị chặn; recovery có audit không cho hai device keys nhập chung một
   legacy activation hoặc vượt device limit.
10. Count, block, revoke, release, RK ledger, token và log đều dùng một canonical device-key ID.
11. Minimum protocol đơn điệu; v1 sau cutoff luôn `UPGRADE_REQUIRED` và không nhận token/`rk` mới.
12. Cài lại bản cũ sau migration không xin được token/resource key mới; hết TTL cũ thì dừng.
13. Upgrade hợp lệ cùng máy giữ seat, license, plan/features và quyền hiện có.
14. Reinstall, TPM clear, đổi mainboard/profile và no-TPM đi đúng recovery/fallback policy.
15. SQL contract xác nhận unique/locking, RLS/GRANT và `SECURITY DEFINER search_path` fail-closed;
    Rust/Python/Edge có parity trên token v3.

### 9.2. Hành động containment không cần sửa source

- Nếu khóa updater ở §SEC.17 còn active: tạm dừng release ký bằng khóa đó, kiểm access log và
  rotate/revoke trước khi phát artifact mới.
- Xác nhận ReleaseSecrets chưa từng vào package; nếu không chứng minh được, rotate Supabase
  secret và rà các hành động service-role.
- Coi `supabase/.temp/tok.json` và `resp.json` là credential-bearing cho tới khi bác bỏ: ACL hiện
  kế thừa quyền rộng. Phải revoke token tương ứng trước, rồi xóa an toàn; không đọc/in nội dung vào
  log audit. Updater private key hiện cũng fail guard vì ACL còn kế thừa và từng có principal ngoài
  allowlist đọc được, nên phải chốt bridge/rotation, không chỉ sửa ACL rồi tiếp tục dùng.
- Source đã tự tạo staging mới, đối chiếu exact inventory, pin provenance Tesseract và có guard
  hardlink/link-count/identity lease. Vẫn không phát hành cho tới khi clean build chứng minh các
  control đó xuyên installer, cây cài và uninstall verifier. `git status` sạch một mình không đóng
  §SEC.23.
- Không xóa thủ công các thư mục evidence/WIP trong báo cáo này; dọn chỉ sau khi chủ dự án chốt
  retention và có checksum/archive phù hợp.

## 10. Quyết định/hành động còn cần chủ dự án xác nhận

1. **A1 CNG device-key proof v3 đã được chọn; Azure MAA/AIK đã bị loại.** Còn cần chạy license TEST
   trên máy TPM và máy không TPM/VM, PostgreSQL staging và Edge staging để xác nhận challenge,
   fallback, replay/downgrade, recovery và device limit. Kết quả không hardware attestation chỉ nâng
   §SEC.16 tới `Mitigated + Accepted residual`, không ghi `Closed`.
2. **D1 source containment và control source/test của D2 đã áp dụng.** Hoàn tất rotation/revocation
   §SEC.17 và chạy clean artifact verifier/provenance trước release kế tiếp.
3. Xác nhận khóa prynx.key hiện có còn là khóa updater đang dùng hay đã được rotate.
4. Xác nhận ReleaseSecrets chỉ tồn tại trên máy build, chưa từng nằm trong installer/portable.
5. Chốt semantics “một thiết bị” là máy vật lý hay Windows profile và policy cho máy không TPM.
6. Để đóng §SEC.18, build artifact mới và cung cấp clean Windows VM/snapshot cho verifier/runtime
   negative tests. Nếu muốn nâng §SEC.15, §SEC.16, §SEC.19, §SEC.21, §SEC.23 và §SEC.24-R1–R7 lên runtime
   verdict, cần fixture/license TEST riêng theo từng boundary; audit tiếp theo vẫn không dùng
   credential production.

**Kết luận cuối:** PrynX hiện đã có nhiều lớp làm tăng chi phí crack rẻ ở token Ed25519, resource
key, sidecar handshake/generation, request signature v2, Save As native grant và release payload/tool
authority. Chưa thể gọi chiến dịch hoàn tất: §SEC.16 đã có A1 source/test nhưng còn CNG runtime,
staging và deploy; §SEC.17/§SEC.20 còn vận hành;
§SEC.15/§SEC.18/§SEC.19/§SEC.21/§SEC.22/§SEC.23/§SEC.24-R1–R7 còn artifact/runtime/deploy proof tương ứng.
Authenticode (artifact hiện `NotSigned`, cert code-signing trong hai store = 0), CNG TPM-preferred/
software-fallback, production DB/Edge và rotate/revoke/audit
secret/key thật vẫn là `[EXTERNAL]`; quyền admin/debugger/memory patch ở Ring-3 là residual accepted
risk. Chưa có bản
release nào được build/ký/publish và chưa có migration nào được deploy trong đợt này; release giữ
`HOLD`.
