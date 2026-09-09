# Nhật ký sửa bản quyền/khởi động PrynX 2.0 — 2026-09-09

## Lô A — Chốt đóng gói và bàn giao installer

**Đã được duyệt:** người dùng trả lời “làm đi” sau đề xuất sửa lô khởi động/đóng gói trước.

**Báo cáo:** `BAO_CAO_AUDIT_BAN_QUYEN_VA_KHOI_DONG_2_0_2026-09-09.md`, §SEC.LIC20.01–03.

**Baseline:** HEAD `641fdc46958b7a17365b9ef5685bedbf9f54e67e`.

**Trạng thái:** Applied + Verified ở mức source/kiểm thử; chưa build installer mới, chưa nghiệm thu runtime. Giữ `HOLD`, chưa `Closed`.

### Phạm vi thay đổi — đúng 5 file code/test

| File | Thay đổi và lý do |
|---|---|
| `desktop/src-tauri/build.rs` | Kiểm cấu hình ngay trước `tauri_build::build()`: hai hash phải là SHA-256 hex chữ thường đúng 64 ký tự; `TAURI_CONFIG` phải chứa đúng sidecar và không build lại frontend đã băm. Lỗi chỉ nêu tên điều kiện và hướng dẫn pipeline, không in config/hash đầu vào. |
| `desktop/src-tauri/Cargo.toml` | Thêm `serde_json` vào build-dependencies để parse JSON thật, không kiểm bằng tìm chuỗi. Đã có cùng dependency trong lockfile; `Cargo.lock` không đổi. Không thêm `[profile.release]`, không đổi LTO. |
| `desktop/src-tauri/tests/release_packaging_gate.rs` | 8 test chạy chính helper build script: dev/QA, thiếu/sai hash, JSON/sidecar/overlay sai, không rebuild frontend, hai overlay chính thức, không echo dữ liệu và wiring trước Tauri build. |
| `build_production.ps1` | Thiếu `dist/` phải dừng thay vì bỏ qua hash. Chuẩn bị xong provenance/feature/native guard và manifest trước bàn giao. Helper `Publish-PrynXInstallerManifest` stage cặp mới, kiểm SHA/name/version, khóa lượt publish, giữ backup, chỉ công bố manifest sau khi installer đã promote và được hậu kiểm. Dời `BUILD COMPLETE`/mở thư mục xuống sau helper thành công. |
| `backend/tests/test_release_packaging_publish.py` | 24 test trên file giả trong Temp và Windows PowerShell 5.1; chỉ trích hai helper bằng AST, không chạy phần đầu script, không build/sign/install. Bao gồm lỗi trước và sau khi installer được thay. |

Tài liệu audit/matrix/threat model được cập nhật riêng để ghi đúng mức bằng chứng; không sửa code license, token, CNG, HWID hoặc các engine khác.

### Vì sao không chặn nhầm vòng dev/QA

Guard dùng `tauri_build::is_dev()` theo dependency feature `tauri/custom-protocol`, không dùng riêng `PROFILE=release` hoặc feature `custom-protocol` của app.

- `cargo test` và `cargo check --release` của QA vẫn là Tauri dev mode, không cần hash/overlay đóng gói.
- `tauri build`, kể cả `--debug`, là đóng gói và phải có đủ input.
- Đã đối chiếu API trong crate đã khóa và compiler fingerprint: lượt full-build có overlay sidecar; lượt hỏng có `TAURI_CONFIG=null`; QA có `cfg(dev)`.
- Không bỏ hoặc nới `verify_frontend_integrity`/`verify_sidecar_integrity` trong runtime.

### Hợp đồng bàn giao và khôi phục

1. Hoàn tất mọi kiểm tra source/native/feature trước khi chạm bản ở `Ban_Phat_Hanh`.
2. Stage installer và manifest trong `.publish-<guid>`; installer dùng tên `installer.pending`, không phải tên setup có thể bị chọn nhầm.
3. Đối chiếu byte staging với `INSTALLER_SHA256`; tên/version phải khớp, field bắt buộc không trùng, `RUNTIME_VERIFIED` giữ `no`.
4. Khóa `.release-publish.lock` bằng `FileShare.None` để hai lượt bàn giao hợp tác không ghi đè nhau.
5. Chuyển manifest cũ sang `manifest.previous` trước khi thay installer. Nếu cùng version, thay installer nguyên tử bằng `File.Replace`, giữ `installer.previous`.
6. Giữ read handle của installer mới từ lúc hậu kiểm SHA đến lúc promote manifest. Sau khi cặp hợp lệ mới báo hoàn tất.

**Nếu lỗi giữa bước 5–6:** có thể thiếu manifest tại vị trí bàn giao, nhưng không còn manifest cũ xác nhận nhầm installer mới. Backups và staging được giữ nguyên; thông báo chỉ đường khôi phục. Không tự gắn lại manifest cũ khi installer đã đổi, không tự ghi hash để cho qua.

Thư mục backup được giữ lại sau mỗi lượt và có thể chiếm dung lượng bằng installer cũ; chưa tự thêm chính sách xóa. Việc chỉnh tay artifact ngoài pipeline vẫn có thể làm cặp lệch; uploader/verifier hiện hữu tiếp tục kiểm SHA và giữ lease trước sử dụng. Chốt mới không phải bảo đảm chống local admin/Ring-3 thay file sau khi bàn giao.

### Verify trước/sau

- Baseline lỗi runtime đã lưu trong báo cáo: bản cài tự thoát vì thiếu compile-time hash; NSIS recipe thiếu sidecar; manifest SHA khác installer.
- Source-order regression đã kiểm trên nội dung `git show HEAD:build_production.ps1` trong bộ nhớ: đỏ; cùng test với working tree mới: xanh. Không checkout hoặc tạm hoàn nguyên source.
- `cargo test --test release_packaging_gate --locked --offline`: **8 passed**, 5m01s.
- `cargo check --release --locked --offline`: **đạt**, 1m23s, khi cả hai hash và `TAURI_CONFIG` đều vắng — chứng minh QA không bị chặn nhầm.
- `python -B -m pytest -q -p no:cacheprovider tests/test_release_packaging_publish.py`: **24 passed**, 25,82 giây, chạy ngoài sandbox sau khi `File.Replace` bị sandbox từ chối. Chỉ dùng file giả trong Temp.
- Regression hiện hữu về manifest/ABI/gate, payload exact-set/lease, Tauri overlay, môi trường QA, cấu hình dev và parser 7 script PowerShell: **16 passed**, 7,52 giây.
- `npm run typecheck`: **đạt**, exit code 0 trên Windows.
- `git diff --check`: đạt; Cargo lockfile không đổi. Warning còn lại là `dead_code` Rust ngoài diff, Pydantic deprecation và LF→CRLF của Git.

Hai lỗi harness trong quá trình verify đã được xử lý, không quy thành lỗi production: PowerShell 5.1 giữ mảng JSON thành một output object nếu bọc thêm `@()`; và `PSMODULEPATH` kế thừa từ PowerShell 7 làm mất `Get-FileHash`. Fixture nay bind `[string[]]` trực tiếp và loại biến module-path không phân biệt chữ hoa/thường. Các ca âm phải trả lỗi đúng nhóm, không chỉ kiểm `Ok=false`.

### Chưa thực hiện / bước tiếp theo

- **Không chạy `build_production.ps1`/`tauri build`, không cài lại hoặc mở app, không ký/publish/deploy, không commit/push.** Installer cũ chưa được thay, SHA-256 vẫn là `272055c0a64d1123878bf7fb89d06f53da116f4cb89a497650f1904783decfe4`.
- Chưa thay key/token/slot, chưa xử lý §04–06 hoặc §S1/S2. Lỗi nhập key mới vẫn cần lô xác minh native riêng; không suy đã sửa nó từ test đóng gói.
- Có thay đổi của phiên khác về sticker-sheet/đường cắt và tài liệu trong working tree; giữ nguyên, không gộp commit hay hoàn nguyên.
- Trước build mới: chốt và commit/push source hợp lệ theo `prynx-build-release`, kiểm worktree/remote; sau đó build đúng pipeline và smoke trên user/VM sạch. Không dùng bộ cài cũ để nghiệm thu bản vá source này.
