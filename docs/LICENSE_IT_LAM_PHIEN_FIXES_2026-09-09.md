# Tiến độ license ít làm phiền — 2026-09-09

Baseline `e27cbb3`; phương án được người dùng duyệt, sau đó làm rõ: **dev phải vẫn kiểm tra license thật để phát hiện bug**. Không thêm key giả/auto-Pro, không bỏ gọi xác minh trong dev. Môi trường/key/quota kiểm thử riêng là bước rollout sau, chưa tự tạo hoặc deploy.

## Các lô source đã thực hiện

1. **Native policy và V3** (`security.rs`, wiring `lib.rs`): V3 không gọi bắt buộc HWID legacy; payload version chỉ là hint bỏ công việc WMI, chữ ký/key/product/CNG vẫn verify đầy đủ. IPC clock trả `not_required` khi chính native debug không yêu cầu anchor; release luôn yêu cầu. `get_license_runtime_policy` chỉ báo policy, không cấp quyền hay thay token.
2. **Lịch renewal native** (`license_renewal.rs`, wiring `lib.rs`): một lượt owner/cooldown dùng chung process, thời gian monotonic, window label do Tauri cấp, epoch/attempt-id chống finish stale. Completed 10 phút; rate-limit 5 phút; lỗi tạm backoff 30 giây tới 10 phút. Đây là lịch bảo vệ quota, không phải cap worker/RAM và không cấp quyền offline.
3. **Store renewal/startup** (`useAuthStore.ts`, test cùng module): network phase V3 không giữ mutation barrier của API; native/DPAPI commit vẫn có hàng rào/epoch. Startup có lease V3 đã được native kiểm thì mở trước, tiếp tục online nền; refresh phiên Google không giữ đường license. Deferred native ưu tiên token DPAPI mới của cửa sổ khác. IPC scheduler lỗi không tự bỏ điều phối để gọi Edge; chỉ native cũ báo command không tồn tại mới giữ compatibility.
4. **Retry và UX** (store/test + `LicenseLockOverlay.tsx/test`): RATE_LIMITED giữ đúng nguyên nhân thay vì bị anchor_missing che mất; expose deadline và tự hẹn retry theo lịch native; UI đếm ngược, disable nút khi chưa đến lượt. Nhập lại cùng key đang khóa chạy xác minh thật ngoài queue đổi key, tránh deadlock. Chứng nhận offline còn hơn 24 giờ không hiện banner liên tục; vẫn cảnh báo trong ngày cuối.
5. **Native khuôn bế** (`native/src/dieline_license.rs`, tests inline): đồng bộ 15 phút/72 giờ và đọc khóa TPM hoặc Software KSP đã tồn tại; giữ RSA-2048/SIGN/non-exportable/private-key presence. Không tạo/xóa/đổi khóa CNG, không thay hình học.
6. **Quyền hoàn tất job** (`backend/app/core/job_access.py`, Compare/N-Up/VDP submit + API client): sau submit hợp lệ, server cấp receipt RAM-only tối đa 24 giờ, neo session/owner/job/source; chỉ status/results/page tích cực, download/cancel đúng job được phép. Receipt không mở tạo job mới, không chứa entitlement và bị hủy khi sign-out/đổi key/thu hồi quan sát được.
7. **Server quota/retry** (Edge/shared + migration cục bộ PrintSolutions): refresh/rk_grant, enroll/recover và release có nhóm quota riêng; `RATE_LIMITED` giữ HTTP 200 tương thích, trả `retry_after_seconds` và `Retry-After` hợp lệ; client giữ lease cũ và hẹn lại theo thời gian server. Migration/Edge production chưa deploy.

Các lô chức năng được chia theo phạm vi nhỏ; không đổi server, lô đóng gói A cũ, các file bình tem/đường cắt/locale đang được tác vụ khác sửa. UI mới dùng i18n với fallback tiếng Việt; chưa merge thêm keys vào hai JSON locale đang được sửa đồng thời.

## Kiểm chứng đã chạy

- Native Dieline: test 72 giờ **đỏ trước** với lỗi `License token v3 lifetime is invalid`, sau sửa **13/13 đạt**; `cargo check --locked --offline` đạt. Provider tests dùng closure/metadata giả, không chạm CNG của người dùng.
- Coordinator native: **11/11 đạt**, test pure clock/owner/epoch/replay/cooldown.
- Native policy/HWID: **3/3 đạt**; V3 bỏ WMI lỗi nhưng chữ ký giả vẫn bị từ chối, legacy vẫn cần HWID.
- Native token verifier hiện hữu: **17/17 đạt**, gồm wrong signer, tamper, key/machine/product mismatch, expired và 15 phút/72 giờ.
- Native Tauri library: **276 passed, 6 ignored** (`cargo test --lib --locked --offline`); gồm 10+ test coordinator/transaction mới, flush/replace Windows fixture và toàn bộ token/anchor/signature suite.
- Frontend trước receipt/abort: **136 passed** trên 5 suite auth/token/protocol/API/overlay. Các ca kiểm network barrier, commit barrier, DPAPI token mới ở window khác, scheduler unavailable, timer chính xác/backoff không mất sau restart heartbeat, same-key recovery và startup trước khi network kết thúc.
- Frontend hiện hành sau receipt/abort: **155 passed** trên 6 suite auth/token/protocol/API/overlay/job-receipt.
- Full frontend cuối lượt: **311 test files, 3525 passed, 2 skipped**. Hai hồi quy phát hiện trong full suite đã sửa: thiếu 4 khóa i18n vi/en và collector receipt đọc `headers` trên Response giả của test upload.
- Backend license/job receipt: **129 passed**, 2 cảnh báo deprecation; gồm token/route coverage và Compare/N-Up/VDP receipt path.
- PrintSolutions Edge/migration contract: **104 passed** trên 6 suite, chạy fixture VM/local không mạng.
- Native wheel build/import smoke: `maturin build --release` đã tạo wheel CPython 3.11; cài vào thư mục import tạm và `import pdfcompare_native` đạt. `dieline_engine_status` trả trạng thái plaintext dev/CI; token giả bị từ chối `Malformed license token`. Không thay extension đang bị backend dev giữ khóa.
- UI cooldown có regression **đỏ trước/xanh sau**; suite riêng 12/12.
- Typecheck Windows và ESLint 4 file frontend sửa: đạt. `git diff --check` đạt; Cargo.lock không đổi.

## Giới hạn và phần chưa làm

- Mức đạt **source + unit/integration mock + native wheel import smoke**, chưa installer/runtime. `maturin develop --release` build được nhưng pip không thay extension trong `backend/venv` vì Windows báo `Access denied` trên `pdfcompare_native-0.1.0.dist-info/direct_url.json` đang bị tiến trình backend giữ. Không restart hoặc kill dev app của người dùng, chưa package/cài lại; app đang mở có thể còn dùng native cũ cho đến lần người dùng chủ động dừng backend rồi rebuild.
- Typecheck và build frontend đã xanh ở lượt cuối (các lỗi cú pháp WIP của tác vụ khác đã được xử lý trong lúc làm). Lint toàn repo còn 2 lỗi ngoài phạm vi: `LayerPanel.tsx` biến `setHiddenOcgLayerIds` không dùng, `api.mergeManifest.test.ts` biến `init` không dùng; ESLint các file license/API sửa trong lô này xanh.
- Coordinator mới đã có `commit_license_renewal`: owner/window/attempt/key/epoch/TTL được kiểm trước verify + persist + binding trong mutex chung; stale receipt không ghi credential. Client gửi AbortSignal khi timeout/hủy network. Giao dịch hai slot DPAPI có rollback khi lỗi đã bắt và giữ backup nếu rollback lỗi; **không** tuyên bố atomic khi mất điện/crash giữa hai rename, cũng không biến các IPC legacy thành protocol transaction mới.
- Legacy V2 drain có network trong đoạn recovery vẫn dùng barrier như trước; không gọi nó là mọi luồng renewal hoàn toàn nonblocking.
- Server quota/Retry-After đã có source/contract test; **production rollout** (staging/test authority, migration history, Edge deploy hai repo), recovery slot legacy và CNG/DPAPI thật vẫn cần nghiệm thu riêng. Không có bypass dev mới để che những ca này.
- Receipt đã được kiểm backend cho Compare/N-Up/VDP, nhưng các workflow async khác chưa có receipt riêng; không tuyên bố “mọi tác vụ” đều được phép sau expiry. `api.ts` chỉ gửi receipt ở các đường method/path đã neo; route chưa có receipt vẫn cần license bình thường.
- Không reset key, xóa token/anchor, thay slot, gọi activation thật, deploy, commit hoặc push trong đợt này. Mọi thay đổi chưa commit ở working tree; giữ nguyên source và tài liệu của tác vụ khác.

## Nghiệm thu cần thực hiện trên bản chạy mới

Kiểm cùng key còn hạn → restart → lease local; online→offline→online; 429/cooldown→tự retry; sai signature/device/clock rollback vẫn từ chối; lỗi ghi DPAPI giữ credential; TPM/software; tạo khuôn bằng token 15 phút và 72 giờ; nhiều cửa sổ/focus/resume. Kiểm license phải dùng enforcement như bản cài và key thử/môi trường thử riêng, không chỉ nhìn dev UI mở được.
