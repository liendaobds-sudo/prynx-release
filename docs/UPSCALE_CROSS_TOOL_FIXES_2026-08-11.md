# UPSCALE CROSS-TOOL — KẾT QUẢ SỬA SAU RE-AUDIT

**Ngày:** 2026-08-11
**Nguồn finding:** `docs/BAO_CAO_RE_AUDIT_UPSCALE_CROSS_TOOL_2026-08-11.md`
**Revision baseline:** `89a9048d1d5eb71d64171e8c9195782da064d36a`
**Quy trình:** lô tối đa 5 file, verify hẹp sau từng lô; không reset/checkout/stage/commit và không sửa thay đổi ngoài phạm vi.

## 1. Kết quả

Sáu residual P2 trong re-audit đã được xử lý ở mức code + test tự động:

| Finding | Trạng thái sau sửa | Bằng chứng chính |
|---|---|---|
| `§UP.X.01` identity/Undo | `[VERIFIED-AUTO]` | Token bất biến theo `tabId + itemId` đi cùng Blob/File; xóa fallback tên + dung lượng; test collision đạt. |
| `§UP.X.02` close-tab lifecycle | `[VERIFIED-AUTO]` | Shell gọi disposer khi đóng tab; abort controller, revoke URL, xóa Zustand record; test tab owner đạt. |
| `§UP.R.01` path fast-path | `[VERIFIED-AUTO]` | Tauri chỉ cấp grant cho canonical path trong picker/drop FS scope; sidecar kiểm HMAC, tab, TTL, nonce một lần; startup/recent/browser fallback upload. |
| `§UP.X.06` ICC fallback | `[VERIFIED-ARTIFACT]` | PDF fallback nhúng `/ICCBased /N 3`, giữ `/SMask` và pHYs/DPI; profile không thể bảo toàn thì fail rõ, không âm thầm `/DeviceRGB`. |
| `§UP.X.07` cancel/artifact lifecycle | `[VERIFIED-AUTO]` | Disconnect hủy trước admission hoặc tại ranh giới tile; không ngắt giữa DirectML `session.run`; marker lease atomic thay toàn bộ per-file `threading.Timer`. |
| `§UP.X.09` release smoke | `[VERIFIED-ARTIFACT]` | Staged native gate có `combine_image_manifest_native`; frozen self-test gọi merger thật và parse MediaBox, alpha, ICC; installed verifier bắt buộc marker behavior. |

Chưa đổi verdict phát hành thành `GO` chỉ bằng unit test. Còn phải chạy clean Tauri runtime và clean installed artifact ở mục 5.

## 2. Các lô đã áp dụng

### Lô A — identity và đóng tab

- Kết quả Upscale mang token riêng theo tab/item; File được commit giữ nguyên token.
- Undo và ingest-dedup chỉ so token/reference/path thật, không còn đoán bằng tên + size.
- `App.commitCloseTab()` gọi `disposeUpscaleTab()` bằng dynamic import để giữ lazy chunk.
- `destroyTab()` revoke cả original/result object URL rồi xóa hẳn key store.

### Lô B — capability đường dẫn

- Command `grant_upscale_file_path` canonicalize file, từ chối UNC/device/symlink/file nhạy cảm/đuôi sai và bắt buộc `app.fs_scope().is_allowed()`.
- Rust ký grant HMAC 120 giây bằng secret sidecar; secret không ra WebView.
- Sidecar bind grant với canonical path, tab, thời gian và nonce dùng một lần; chỉ thư mục uploads/results của PrynX được đi path không grant.
- Candidate và root cùng qua `realpath + normcase + commonpath`, khóa lỗi alias 8.3/long path.
- Grant bị từ chối/stale thì frontend upload bytes ngay hoặc retry đúng một lần, giữ nguyên option.
- `run_dev.bat` sinh token ngẫu nhiên theo phiên để uvicorn và Tauri dev xác minh cùng grant; production vẫn dùng stdin.

### Lô C — parity ICC của PDF fallback

- Đọc PNG `iCCP` và JPEG `ICC_PROFILE`, giải nén có trần 16 MB và kiểm ICC header/colorspace RGB.
- Nhúng ICC stream vào XObject dưới `/ICCBased`, giữ alpha `/SMask` do pdf-lib tạo.
- Không có ICC vẫn giữ hành vi cũ; ICC lỗi/không-RGB không bị bỏ im lặng.
- Artifact test dùng PNG RGBA có profile sRGB thật và pHYs 300 DPI.

### Lô D — cooperative cancellation và lease bền

- `Request.is_disconnected()` được theo dõi bằng event; scheduler nhận `queue_cancelled` nên request rời trước admission không chiếm worker/slot.
- Engine kiểm cancellation trước và sau mỗi tile; một DirectML call đang chạy được phép hoàn tất an toàn rồi mới dừng.
- Companion PDF có marker lease atomic trên đĩa: 2 giờ trước claim, 26 giờ sau commit; cleanup bảo vệ lease sống và dọn lease hết hạn sau restart.
- Frontend claim chỉ khi callback xác nhận workspace đã commit; unmount/không-promote release lease; đóng tab release mọi lease owner.
- Đã bỏ hoàn toàn `threading.Timer(7200)` theo từng file.

### Lô E — release behavior gate

- Staged wheel fail sớm nếu thiếu `combine_image_manifest_native`.
- Frozen self-test tạo PNG 2×3 RGBA, ICC RGB thật, 300 DPI; gọi native merger và parse PDF một trang.
- Marker bắt buộc: `native_merger=true`, `pages=1`, `alpha=true`, `icc_components=3`, khổ `0,48 × 0,72 pt` trong tolerance.
- Test âm khóa ba ca: thiếu symbol, callable ném lỗi và callable tạo PDF thiếu alpha/ICC.

## 3. Verify đã đạt

| Kiểm tra | Kết quả |
|---|---|
| Upscale frontend Vitest | 12 test đạt |
| `imageNormalizer` Vitest | 22 test đạt |
| Backend Upscale + storage cleanup | 39 test đạt |
| Frozen runtime/build-contract pytest | 20 test đạt |
| TypeScript typecheck | Đạt |
| ESLint hẹp các file Upscale/ICC | Đạt |
| Python `py_compile` các file sửa | Đạt |
| Rust `cargo check` Tauri | Đạt; 7 cảnh báo dead-code có sẵn |
| Rust grant unit test | 1 đạt, 133 test khác được filter |
| PowerShell parser hai script release | Đạt |
| Native merger smoke trên extension dev thật | Đạt: 1 trang, `0,48 × 0,72 pt`, alpha, ICC 3 thành phần |
| File khách `tải xuống.jpg`, Balanced ×4 qua route thật | HTTP 200 trong `14,498 s`; `8000×8000 px`, `288,0106 DPI`; MediaBox `1999,9264 × 1999,9264 pt` |
| PPE 96 DPI trên companion PDF mới | `2667×2667`, `21.338.667` byte RGB trong `4,669 s`; không degraded/ink-unsound/recovery |
| Lease companion PDF trên file khách | Claim/release đều HTTP 200; PDF và marker đã bị xóa sau release |

## 4. Bất biến không đổi

- Không thêm hard-cap worker/RAM/chất lượng; máy mạnh vẫn giữ cấu hình đầy đủ.
- Không thêm `[profile.release]` vào Cargo.toml; LTO vẫn chỉ do script release điều khiển.
- Không thay đổi hình học khuôn bế, snapshot/golden hoặc PDFium locking.
- Không mở allowlist toàn Desktop, `%TEMP%`, ổ D, USB hay NAS.

## 5. Proof gap trước khi phát hành

Các kiểm tra sau vẫn cần chạy trên phiên sạch/bản cài thật trước khi đổi verdict re-audit:

1. `run_dev.bat`: picker Desktop/ổ D, native drop, startup/recent fallback, hai tab chạy song song rồi đóng một tab.
2. Raw socket disconnect giữa hai tile trên inference ONNX thật; xác nhận không chạy tile kế tiếp và không còn PNG/PDF/marker.
3. Chuỗi người dùng thật `mở ảnh → Upscale ×2/×4 → Viewer/PPE → Bù xén/Tạo đường cắt → Undo/Ctrl+Z`.
4. Clean `build_production.ps1`, cài installer mới và chạy `verify_installed_artifact.ps1` với behavior marker.
5. Chạy lại corpus đầy đủ trên ba chế độ; so Poppler và màu native-vs-fallback theo tolerance sản phẩm. File khách Balanced ×4 + PPE 96 DPI đã đạt ở mục 3.

Vì working tree có nhiều thay đổi song song ngoài phạm vi, vòng sửa này không stage/commit/push.
