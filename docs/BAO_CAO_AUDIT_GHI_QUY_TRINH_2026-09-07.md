# Báo cáo audit — Ghi quy trình / Recipe

**Ngày:** 2026-09-07  
**Phạm vi:** `desktop/src/lib/recipe/*`, `desktop/src/components/recipe/*`, các điểm nối toolbar/playback liên quan trong `desktop/src/components/AcrobatViewer.tsx`, `desktop/src/components/acrobat/AcrobatToolbar.tsx`, `desktop/src/stores/useWorkspaceStore.ts`.  
**Mục tiêu audit unit:** ghi → lưu → phát lại quy trình trên desktop, trace từ entry UI đến state, storage và consumer đọc lại.

## Kết luận điều hành

Lõi Recipe hiện có khung khá tốt: recorder có ticket nội bộ, playback có DI rõ ràng, metadata op được gom tập trung, và bộ test unit phủ khá dày. Tuy vậy, trong lần rà này mình xác nhận được một điểm không khớp với nguyên tắc “desktop coi đĩa là nguồn duy nhất”: nhánh đọc recipe trên desktop vẫn có fallback sang `localStorage` khi đọc thư mục recipe thất bại. Điều đó có thể che mất lỗi đĩa/quyền/scope và trả về dữ liệu cũ hoặc dữ liệu khác nguồn.

Ngoài finding đã xác nhận, mình cũng ghi lại một khoảng trống kiểm chứng runtime: chưa có bằng chứng Tauri runtime/PDF artifact cho round-trip ghi → lưu → phát lại trong app thật ở lượt audit này. Phần còn lại của luồng được trace tĩnh và có test unit.

## Trace chính của luồng

| Mắt xích | File / dòng | Vai trò |
|---|---|---|
| Entry ghi | `desktop/src/components/recipe/RecipeRecordControl.tsx:37-120` | Bắt đầu/dừng phiên ghi theo `tabId`, mở dialog lưu khi có step. |
| Recorder core | `desktop/src/lib/recipe/RecipeRecorder.ts:78-226` | Sinh ticket theo tab/phiên, gom pending note, commit vào `draftSteps`, chặn commit lệch owner. |
| Metadata op | `desktop/src/lib/recipe/recipeOps.ts:33-176` | Phân loại op recordable / external input, dựng `RecipeStep` với nhãn và params đã snapshot. |
| Schema | `desktop/src/lib/recipe/recipeTypes.ts:12-200` | Định nghĩa `Recipe`, `RecipeStep`, schema version, serialize/deserialize. |
| Lưu / đọc | `desktop/src/lib/recipe/recipeStore.ts:41-207` | AppData Tauri JSON, fallback localStorage, import/export. |
| Panel quản lý | `desktop/src/components/recipe/RecipePanel.tsx:142-333` | Load list, rename/delete/import/export, chỉnh sửa step, phát recipe. |
| Playback runner | `desktop/src/lib/recipe/PlaybackRunner.ts:1-178` | Chạy tuần tự step, lọc recordable / external input / entitlement / lỗi. |
| Runner registry | `desktop/src/lib/recipe/recipeRunners.ts:72-472` | Nối opId sang runner thật và tái dùng processHandlers / backend route. |
| Commit working artifact | `desktop/src/lib/recipe/workingArtifact.ts:58-213` | Bảo toàn working path/bytes theo từng bước phát lại. |
| Consumer viewer/workspace | `desktop/src/hooks/useEditSession.ts:243-315`, `desktop/src/stores/useWorkspaceStore.ts:278-305`, `desktop/src/components/AcrobatToolbar.tsx:115-196` | Cập nhật session/toolbar/state cho thao tác người dùng và playback. |

## Findings

### §STORE.2R — Desktop recipe vẫn fallback sang `localStorage` khi đọc đĩa lỗi

- **Mức:** P1
- **Trạng thái:** `[CONFIRMED]`
- **Bằng chứng:**
  - `desktop/src/lib/recipe/recipeStore.ts:85-111` gọi `read_dir_json` trên thư mục recipe của Tauri.
  - Nếu `read_dir_json` ném lỗi, code chỉ `console.warn(...)` rồi trả `sortByUpdated(lsRead())` từ `localStorage`.
  - `desktop/src/lib/recipe/recipeStore.ts:113-137` lại coi đĩa là nguồn duy nhất khi ghi trên desktop, nên fallback đọc sang `localStorage` làm lệch nguồn sự thật.
- **Tác động:**
  - Nếu thư mục recipe đọc lỗi vì quyền, scope, lock hoặc lỗi tạm thời, panel có thể hiện recipe cũ/khác nguồn thay vì fail closed.
  - Người dùng sẽ thấy danh sách “còn sống” dù đĩa đã hỏng hoặc dữ liệu đĩa không đọc được, nên xóa/đổi tên/sửa tiếp có thể đánh vào nguồn sai.
- **Vì sao đây là bug chứ không chỉ là convenience:**
  - Comment ngay trong file khẳng định desktop phải coi đĩa là nguồn duy nhất.
  - Test hiện tại chỉ chứng minh localStorage fallback hoạt động, chứ chưa có test chặn trường hợp desktop read error phải fail-loud.
- **Khoảng trống test:**
  - `desktop/src/lib/recipe/recipeStore.test.ts:29-92` chỉ mô phỏng localStorage fallback, chưa có ca Tauri read failure.

### §STORE.TEST — Chưa có bằng chứng runtime cho round-trip ghi → lưu → phát lại trên app thật

- **Mức:** P2
- **Trạng thái:** `[SUSPECTED]`
- **Bằng chứng:**
  - Có test unit cho `RecipeRecorder`, `PlaybackRunner`, `recipeStore`, `RecipeRecordControl`.
  - Mình chưa thấy PDF artifact hoặc thao tác Tauri runtime thật cho chuỗi: ghi recipe trên tab, lưu ra disk, reload panel, rồi phát recipe trên file mới.
- **Tác động:**
  - Đây không phải bug code khẳng định, nhưng là khoảng trống xác nhận end-to-end. Những lỗi kiểu ownership tab, stale file source, hoặc fallback storage thường chỉ lộ ở runtime.
- **Gợi ý kiểm chứng tiếp theo:**
  - Chạy smoke Tauri cho luồng `record -> stop -> save -> reload panel -> play` trên một PDF thật, ít nhất cho một recipe tuyến tính và một recipe có external input.

## Độ phủ bằng chứng hiện tại

- `TRACED`: toàn bộ chuỗi entry → recorder/store → playback runner → consumer.
- `AUTO`: các helper và unit test quanh recorder, runner, store.
- Chưa đạt `ARTIFACT`/`RUNTIME` cho luồng ghi quy trình end-to-end trong app thật.

## Test và tài liệu đã đối chiếu

- `desktop/src/lib/recipe/recipeStore.test.ts`
- `desktop/src/lib/recipe/PlaybackRunner.test.ts`
- `desktop/src/lib/recipe/RecipeRecorder.test.ts`
- `docs/BAO_CAO_AUDIT_GHI_VA_PHAT_QUY_TRINH_2026-08-15.md`
- `docs/RECIPE_FIXES_2026-08-17.md`
- `docs/PRYNX_MASTER_AUDIT_MATRIX.md`

## Kết luận

Luồng ghi quy trình đã có nền tảng tốt, nhưng mình xác nhận một lỗi fail-open ở lớp đọc recipe desktop: `localStorage` fallback có thể che mất lỗi đĩa và làm UI đọc nhầm nguồn. Mình dừng ở chốt báo cáo theo quy trình audit của PrynX và chờ bạn duyệt trước khi chạm code.
