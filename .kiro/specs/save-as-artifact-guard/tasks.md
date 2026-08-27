# Implementation Plan: Chốt chặn Save As lên artifact tạm (F2b)

## Overview

Đóng phần bằng chứng còn thiếu của F2b. Phần logic đã đạt ở lô trước (`isSameWorkspacePath`, `validate_disk_copy_request`, 12 test TS + 3 test Rust) không mở lại; các task dưới đây bổ sung hợp đồng test được ở call site, nâng oracle native lên định danh file thật của Windows, và khoá bất biến provenance sau khi từ chối.

Thứ tự tăng dần: hàm thuần trước (plan), rồi executor không React, rồi bất biến provenance, rồi tầng native, cuối cùng mới nối vào `ImpositionTab` và ghi ma trận. Nhờ vậy mọi bước đều verify được trước khi chạm đường lưu nóng.

**Chia lô theo quy tắc tối đa 5 file, verify xong lô này mới sang lô kế:**

| Lô | Task | File |
|---|---|---|
| 1 | 1–3 | `workspaceFileSave.ts`, `workspaceFileSave.test.ts` |
| 2 | 4 | `desktop/src-tauri/src/lib.rs` |
| 3 | 5 | `ImpositionTab.tsx`, file i18n tương ứng |
| 4 | 6 | `docs/PRYNX_MASTER_AUDIT_MATRIX.md` |

Test đánh dấu `*` là task test tách riêng. Property test dùng generator path Windows; vitest và tsc chỉ chạy trên máy Windows thật của dự án.

## Tasks

- [x] 1. Plan thuần cho bước ghi của Save As
  - [x] 1.1 Thêm data models và `planWorkspaceSaveWrite` vào `desktop/src/lib/workspaceFileSave.ts`
    - Định nghĩa `WorkspaceSaveWritePlan` (union `reuseExistingSource` | `rejectArtifactDestination` | `copyOnDisk` | `writeBytes`) và `WorkspaceSaveWriteInput`
    - Thứ tự quyết định: `canReuseExistingWorkspaceSource` → `isUnsafeWorkspaceArtifactDestination` → `copyOnDisk` khi `!didBake` và có `file.path` → còn lại `writeBytes`
    - Hàm thuần, không import Tauri, không đọc state React
    - _Requirements: 1.1, 1.6, 4.5_

  - [x] 1.2 Viết test hợp đồng cho bốn nhánh plan
    - Generated hoặc temp chọn trùng path artifact cho ra `rejectArtifactDestination`
    - Reject cả khi path lệch case ổ đĩa, lệch dấu phân cách, có đoạn `..`
    - Source sạch chọn lại chính nó và không bake cho ra `reuseExistingSource`
    - Không bake và có path đĩa cho ra `copyOnDisk`; có bake cho ra `writeBytes`
    - Path khác file thật cho ra `copyOnDisk`, không reject oan
    - _Requirements: 1.1, 1.6, 3.1, 3.2, 4.4, 4.5_

  - [x]* 1.3 Viết property test cho tính idempotent của chuẩn hoá path
    - **Property 2: Chuẩn hoá path là idempotent**
    - **Validates: Requirements 3.1**
    - `// Feature: save-as-artifact-guard, Property 2`, ≥100 iterations, generator path Windows gồm ổ đĩa, UNC, đoạn `.` và `..`

  - [x]* 1.4 Viết property test cho tính phản xạ và đối xứng
    - **Property 3: Quan hệ cùng-một-file phản xạ và đối xứng**
    - **Validates: Requirements 3.1**
    - `// Feature: save-as-artifact-guard, Property 3`, ≥100 iterations

  - [x]* 1.5 Viết property test cho biến thể path vô hại
    - **Property 4: Biến thể path vô hại không đổi kết luận**
    - **Validates: Requirements 3.1, 3.6**
    - `// Feature: save-as-artifact-guard, Property 4`, ≥100 iterations, tập biến đổi {đổi hoa/thường, `\`→`/`, nhân đôi dấu phân cách, chèn `\.\`, thêm dấu phân cách cuối}; ca UNC phải giữ tiền tố `\\`

  - [x]* 1.6 Viết property test cho việc không chặn oan
    - **Property 5: Không chặn oan**
    - **Validates: Requirements 3.2, 4.4**
    - `// Feature: save-as-artifact-guard, Property 5`, ≥100 iterations, sinh cặp path có khoá chuẩn hoá khác nhau

  - [x]* 1.7 Viết property test cho tính loại trừ của hai đường ghi
    - **Property 8: Hai đường ghi loại trừ nhau**
    - **Validates: Requirements 4.5**
    - `// Feature: save-as-artifact-guard, Property 8`, ≥100 iterations trên mọi tổ hợp `didBake` × có/không `file.path`

- [x] 2. Executor tách khỏi React
  - [x] 2.1 Thêm `WorkspaceSaveWritePorts`, `WorkspaceSaveWriteOutcome` và `executeWorkspaceSaveWrite`
    - Ports: `copyOnDisk`, `writeBytes`, `readBytes`; executor không import Tauri và không đụng state React
    - Nhánh `rejectArtifactDestination` trả `{ kind: 'rejected', messageKey }` mà không gọi bất kỳ port nào, kể cả `readBytes`
    - `messageKey` là khoá i18n, không hardcode text trong lib
    - _Requirements: 1.1, 1.2, 2.1, 2.2_

  - [x] 2.2 Viết test cho hành vi không-tác-dụng-phụ của nhánh từ chối
    - Plan reject: cả ba port đều có số lần gọi bằng 0
    - Plan `copyOnDisk`: chỉ `copyOnDisk` được gọi, đúng cặp source/dest
    - Plan `writeBytes`: chỉ `readBytes` rồi `writeBytes` được gọi
    - Plan `reuseExistingSource`: không port nào được gọi, outcome là `reused`
    - _Requirements: 1.1, 1.6, 2.1, 2.2, 4.5_

  - [x]* 2.3 Viết property test cho việc từ chối không có tác dụng phụ
    - **Property 1: Từ chối không có tác dụng phụ**
    - **Validates: Requirements 1.1, 2.1, 2.2**
    - `// Feature: save-as-artifact-guard, Property 1`, ≥100 iterations, sinh input artifact tạm với nhiều dạng path trùng

- [x] 3. Bất biến provenance quanh biên lưu
  - [x] 3.1 Viết test provenance nguyên vẹn sau khi từ chối
    - Working file sau khi nhận outcome `rejected` vẫn giữ `isGenerated`, `isTempUploadPath` và vé thuê artifact đọc được qua `readArtifactLeaseToken`
    - Đối chiếu: revision publish sau khi ghi thành công thì sạch `isGenerated`, `isTempUploadPath`, cờ chờ path native và vé thuê
    - _Requirements: 2.3, 2.4, 2.5_

  - [x]* 3.2 Viết property test cho điều kiện sinh provenance sạch
    - **Property 6: Provenance sạch chỉ sinh ra khi ghi thành công**
    - **Validates: Requirements 2.3, 2.4, 2.5**
    - `// Feature: save-as-artifact-guard, Property 6`, ≥100 iterations trên mọi nhánh plan

  - [x] 3.3 Verify lô 1: `npm run typecheck`, `npx vitest run src/lib/workspaceFileSave.test.ts`, `npm run lint`
    - Báo đúng số test đã chạy và kết quả; không sang lô 2 nếu còn đỏ
    - _Requirements: 5.3_

- [x] 4. Nâng oracle cùng-một-file ở tầng native
  - [x] 4.1 Thêm `windows_file_identity` vào `desktop/src-tauri/src/lib.rs`
    - Mở handle chỉ-đọc với `FILE_FLAG_BACKUP_SEMANTICS` và share mode đầy đủ để không khoá file người dùng đang mở ở Illustrator hoặc Corel
    - Đọc `BY_HANDLE_FILE_INFORMATION`, trả `Option<(dwVolumeSerialNumber, nFileIndexHigh, nFileIndexLow)>`, đóng handle ngay
    - Không thêm dependency hay feature Cargo: `Win32_Storage_FileSystem` đã bật sẵn
    - _Requirements: 3.3_

  - [x] 4.2 Đổi thân `resolves_to_same_disk_file` sang oracle định danh
    - Đích không tồn tại thì trả `false` trước khi mở handle, giữ chi phí lượt Save As thường ở mức không đổi
    - Trùng cả ba trường thì là cùng một file
    - `windows_file_identity` trả `None` cho bất kỳ phía nào thì rơi về `disk_compare_key`, tuyệt đối không trả `false` vì resolve thất bại
    - Giữ nguyên chữ ký và vị trí gọi của `validate_disk_copy_request`
    - _Requirements: 3.3, 3.5, 4.1, 4.3_

  - [x] 4.3 Viết test cho ca hardlink và junction
    - Hardlink tới cùng file bị nhận ra là cùng một file
    - Junction tới thư mục chứa file bị nhận ra
    - Nếu môi trường không đủ quyền tạo hardlink hoặc junction thì `skip` có thông báo rõ và ghi vào proof gap; không hạ assert rồi báo xanh
    - _Requirements: 3.3_

  - [x] 4.4 Viết test artifact nguyên vẹn sau khi từ chối ở tầng native
    - Sau khi `validate_disk_copy_request` từ chối: bytes file nguồn không đổi, thư mục chỉ còn đúng fixture, không có `.tmp` rơi lại
    - Thông báo lỗi không chứa `not allowed` và không chứa `forbidden path`
    - Đích chưa tồn tại trong thư mục con vẫn qua được validate
    - _Requirements: 2.1, 2.2, 4.2, 4.4_

  - [x]* 4.5 Viết test cho hành vi fail-closed khi không resolve được
    - **Property 7: Fail-closed khi không kết luận được**
    - **Validates: Requirements 3.5**
    - Dựng ca không mở được handle rồi khẳng định vẫn đi qua `disk_compare_key`; nếu không dựng được an toàn thì ghi proof gap

  - [x] 4.6 Verify lô 2: `cargo test --lib disk_copy_request_tests` và `cargo check --lib`
    - Ba test Rust có sẵn phải tiếp tục xanh sau khi đổi oracle; không warning mới thuộc code vừa thêm
    - _Requirements: 4.3, 5.3_

- [x] 5. Nối call site Save As và i18n
  - [x] 5.1 Thêm khoá i18n cho thông báo từ chối
    - Tìm namespace `tabs.imposition` trong `desktop/src/i18n/` và thêm khoá kèm `defaultValue` tiếng Việt nói rõ không thể lưu đè lên file làm việc tạm và hướng chọn vị trí khác
    - _Requirements: 1.2_

  - [x] 5.2 Đổi `performWrite` trong `ImpositionTab.tsx` sang plan và executor
    - Gọi `planWorkspaceSaveWrite`; nhánh `rejectArtifactDestination` thì `setError` bằng khoá i18n rồi trả `false`
    - Không publish revision, không đổi `isSaved`, không đổi tiêu đề tab ở nhánh từ chối
    - Giữ nguyên nhánh `catch` so chuỗi `forbidden path` / `not allowed` cho lỗi phạm vi ghi thật từ Rust
    - Gắn tag truy vết `FILEIO (audit 2026-08-26 §FILE.A4)`
    - _Requirements: 1.1, 1.3, 1.4, 1.5, 4.1_

  - [x] 5.3 Viết test cho hợp đồng hai nhánh lỗi không lẫn nhau
    - Lỗi artifact không kích hoạt hộp thoại chọn lại vị trí
    - Lỗi phạm vi ghi từ native vẫn kích hoạt hộp thoại chọn lại vị trí như trước
    - Sau khi chọn đích hợp lệ ở lần kế thì lưu được và publish revision sạch
    - _Requirements: 1.3, 1.5, 2.5_

  - [x] 5.4 Verify lô 3: `npm run typecheck`, `npm run test` toàn bộ, `npm run lint`
    - So với baseline trước lô; test đỏ do tải phải chạy cô lập để phân biệt flake với hồi quy
    - _Requirements: 5.3_

- [x] 6. Chốt bằng chứng và ghi ma trận
  - [x] 6.1 Chạy ma trận verify đầy đủ theo thiết kế
    - typecheck, vitest phạm vi liên quan, vitest toàn bộ, `cargo test --lib disk_copy_request_tests`, `cargo check --lib`, lint
    - _Requirements: 5.3_

  - [x] 6.2 Cập nhật `docs/PRYNX_MASTER_AUDIT_MATRIX.md`
    - Ghi F2b ở mức `ARTIFACT`, nêu rõ chưa đạt `RUNTIME` và bước kiểm tay còn thiếu
    - Dẫn baseline revision và đường dẫn báo cáo audit gốc để tra lại
    - Ghi giới hạn còn lại: ổ mạng map chưa dựng được fixture, thời điểm xoá của vòng dọn artifact backend chưa đo
    - _Requirements: 5.1, 5.2, 5.3, 5.5_

  - [x] 6.3 Giao chuỗi thao tác runtime cho người dùng
    - Bảy bước trong mục "Chuỗi thao tác runtime" của design, chạy trên `run_dev.bat`
    - Chỉ khi chuỗi này đạt mới được nâng F2b lên `RUNTIME` và ghi lại vào ma trận
    - _Requirements: 5.2, 5.4_

## Task Dependency Graph

```json
{
  "waves": [
    { "wave": 1, "tasks": [1, 4], "description": "Hàm thuần plan (TS) và oracle định danh file (Rust) — hai tầng độc lập, chạy song song" },
    { "wave": 2, "tasks": [2], "description": "Executor không React trên nền plan đã chốt" },
    { "wave": 3, "tasks": [3], "description": "Bất biến provenance quanh biên lưu + verify lô 1" },
    { "wave": 4, "tasks": [5], "description": "Nối call site ImpositionTab và i18n — chỉ sau khi cả hai tầng đã xanh" },
    { "wave": 5, "tasks": [6], "description": "Ma trận verify đầy đủ và ghi bằng chứng vào audit matrix" }
  ]
}
```

```
1 ─ 2 ─ 3 ─┬─ 5 ─ 6
4 ──────────┘
```

- Task 1 và 4 không phụ thuộc nhau: 1 sửa TS, 4 sửa Rust. Đây là hai lô khác nhau nên verify riêng.
- Task 2 cần 1 vì executor tiêu thụ union plan.
- Task 3 cần 2 vì bất biến provenance được khẳng định qua outcome của executor.
- Task 5 cần cả 3 và 4: call site chỉ được đổi khi cả hai tầng đã có test xanh, vì nó nằm trên đường lưu nóng của người dùng.
- Task 6 chạy cuối, sau khi mọi tầng xong.

## Notes

- Ba test Rust có sẵn (`disk_copy_request_tests`) là hợp đồng hồi quy cho task 4: đổi oracle mà chúng đỏ nghĩa là oracle mới nới lỏng hợp đồng, không phải test lỗi thời.
- Task 4 không được thêm dependency hay feature Cargo. `Win32_Storage_FileSystem` đã bật trong `desktop/src-tauri/Cargo.toml`.
- Không đặt `[profile.release]` vào Cargo.toml trong bất kỳ task nào.
- Nhánh `catch` so chuỗi `forbidden path` / `not allowed` ở `ImpositionTab` phải giữ nguyên. Lỗi phạm vi ghi vẫn từ Rust dưới dạng chuỗi; chỉ nhánh artifact chuyển thành giá trị plan.
- Text hiển thị và comment bằng tiếng Việt; thông báo lỗi đi qua khoá i18n, không hardcode trong `lib/`.
- vitest, tsc và eslint chỉ chạy trên máy Windows thật của dự án. Không kết luận từ kết quả chạy trong VM Linux.
- Test đỏ trong lần chạy full suite phải chạy lại cô lập trước khi gọi là hồi quy. Đã gặp flake do tải ở `api.upload.test.ts` và `api.resizeTransparency.test.ts`.
- Không dùng `git checkout` hay `reset --hard` để hoàn tác; dùng Edit.
- Proof gap phải ghi vào ma trận, không được im lặng: ổ mạng map (Requirement 3.4) và thời điểm xoá của vòng dọn artifact backend (Requirement 2.4).