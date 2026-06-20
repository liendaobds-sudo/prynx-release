# Design Document

> Thiết kế — Recipe (Ghi & Phát lại quy trình xử lý PDF)

## Overview

Recipe biến chuỗi thao tác thủ công trong workspace thành một quy trình **tuyến tính, lưu lại & phát lại được**. Thiết kế bám sát hạ tầng sẵn có để rủi ro tối thiểu:

- **`processHandlers.ts`** đã là lớp thực thi dependency-injected (`run*(ctx: ProcessContext, settings)`) → dùng trực tiếp làm **playback engine**.
- **`commitWorkingFile`** là điểm hội tụ kết quả của hầu hết thao tác → dùng làm **record hook** chính.
- **`presetManager.ts`** đã có CRUD + persist + export/import → **sao mẫu** cho RecipeStore.

Nguyên tắc: KHÔNG tạo đường xử lý PDF mới; Recipe chỉ **điều phối lại** các thao tác hiện có.

## Architecture

```
        ┌──────────────────────────── RECORD ────────────────────────────┐
 user thao tác → handleStart* / tool.run() → commitWorkingFile(blob,name)
                         │                          │
                         │ (emit {opId, params})    │ (record hook)
                         ▼                          ▼
                  RecipeRecorder ──── append Step ──► recipe đang ghi
                                                        │ stop → lưu
                                                        ▼
                                                   RecipeStore (persist)

        ┌──────────────────────────── PLAYBACK ──────────────────────────┐
 chọn recipe + bấm ▶ → PlaybackRunner
     for each Step:
        - nếu file-dependent → bỏ qua + cảnh báo
        - nếu cần input ngoài → hỏi file/CSV
        - build ProcessContext (spawnNewTab=false), gọi run<op>(ctx, params)
        - await (job async) → commitWorkingFile → working file mới
     done → kết quả cuối ở working file
```

## Components and Interfaces

### 1. Mô hình dữ liệu (`desktop/src/lib/recipe/recipeTypes.ts`)

```ts
export interface RecipeStep {
  opId: RecipeOpId;            // 'convertcolors' | 'hairlines' | 'booklet' | 'nup' | ...
  label: string;              // tên hiển thị + tóm tắt param
  params: Record<string, any>;// snapshot tham số đủ để phát lại
  recordable: boolean;        // false = phụ thuộc file (sẽ bỏ qua khi phát lại)
  needsExternalInput?: 'csv' | 'file' | null;
  viewerPageOrder?: number[]; // chụp nếu thao tác phụ thuộc thứ tự trang
  viewerPageRotations?: Record<number, number>;
}

export interface Recipe {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  steps: RecipeStep[];
  hints?: { sourcePageCount?: number };  // gợi ý áp dụng
  schemaVersion: number;
}
```

`RecipeOpId` = union khớp các `run*`/tool key trong `processHandlers` + PreprocessingRouter.

### 2. Bảng định nghĩa thao tác (`recipe/recipeOps.ts`) — NGUỒN CHÂN LÝ
Map `opId → { label, recordable, needsExternalInput, capture(state), run(ctx, params) }`.
- `capture()`: đọc store/cấu hình hiện hành → trả `params` thuần (tái dùng `partialize` của `useImposerSettingsStore` + các *Settings).
- `run()`: gọi đúng handler hiện có (`runProcessEngine` cho booklet/nup, `runShuffle/Resize/Split/Merge`, hoặc fetch endpoint cho convertcolors/hairlines/...).

Phân loại ban đầu (theo audit):
| Nhóm | opId | recordable | external |
|---|---|---|---|
| Bình bài page-based | booklet, nup | ✅ | — |
| Bình bài theo hình | sticker_imposer, cnc_imposer | ✅ (phát lại DÒ LẠI hình trên file mới qua /imposition/detect-shape) | — |
| Tạo đường cắt / bù xén | sticker_dieline | ✅ (dò contour server-side mỗi file) | — |
| Tiền xử lý (engine) | shuffle, resize, split | ✅ | — |
| Ghép | merge (merge_files/interleave/insert) | ✅ | file |
| Prepress (backend) | convertcolors, hairlines, trapping, pdfx, ocr, optimize, spot→cmyk | ✅ | — |
| Overlay (FE) | watermark, stick_text_number (Header/Footer) | ✅ | — |
| AI ảnh (tương tác, ngoài chuỗi PDF) | bgremover, upscale | ❌ (công cụ lô ảnh, store/preview riêng) | — |
| VDP | datamerge | ⚠️ (XY) | csv |
| VDP | numbering, cover_numbering | ⚠️ (XY) | — |
| Edit/Crop/Pages-by-index | object edit, crop, set-page-boxes, page index ops | ❌ file-dependent | — |

### 3. RecipeRecorder (`recipe/RecipeRecorder.ts` + hook trong ImpositionTab)
- Trạng thái: `isRecording`, `draftSteps`.
- **Hook chính**: bọc `commitWorkingFile` — khi recording, sau khi commit thành công, lấy `{opId, params}` mà handler đang chạy đã "công bố".
- Cơ chế công bố params: mỗi `handleStart*`/tool, ngay trước khi gọi `run*`/fetch, gọi `recorder.noteOperation(opId, capturedParams)`; recorder ghép với lần `commitWorkingFile` kế tiếp thành một Step.
- Thao tác file-dependent (edit/crop/page-index) gọi `recorder.noteNonRecordable(opId)` → Step `recordable=false`.

### 4. RecipeStore (`recipe/recipeStore.ts`)
- Sao mẫu `presetManager.ts`: CRUD + Tauri AppData JSON (`ps_recipes`) + localStorage fallback + export/import file.

### 5. PlaybackRunner (`recipe/PlaybackRunner.ts`)
```ts
async function runRecipe(recipe: Recipe, ctx: PlaybackContext): Promise<void>
```
- Lặp `steps`:
  - `recordable=false` → `ctx.warn(step)`, bỏ qua.
  - `needsExternalInput` → `await ctx.requestExternalInput(step)`; nếu không có → bỏ qua + cảnh báo.
  - build `ProcessContext` với `spawnNewTab=false`, `getWorkingBytes` (chuỗi từ working file hiện tại), gọi `recipeOps[opId].run(ctx, step.params)`.
  - **await** hoàn tất (engine/job đã await sẵn poll loop).
  - cập nhật tiến trình `Step i/N`.
- Lỗi 1 Step → dừng, báo lỗi, KHÔNG hỏng file gốc.

Tái dùng `buildProcessContext()` của ImpositionTab (đã có `getWorkingBytes`, `commitWorkingFile`...), chỉ override `spawnNewTab=false` và `onSpawnTab=undefined` cho bước trung gian.

### 6. UI
- **Toolbar workspace** (gần Undo/Redo, ImpositionTab ~1632): nút **Ghi/Dừng** + badge đỏ khi đang ghi.
- **Panel "Quy trình đã lưu"**: danh sách recipe; mỗi item: ▶ Phát lại, ✎ Sửa tên, 🗑 Xóa, ⤓ Export; xem danh sách Step (label + cờ recordable).
- **Dialog dừng ghi**: nhập tên/mô tả, xem trước Step, lưu/hủy.
- Toast/confirm dùng `ui/Toast` + `ui/confirmDialog` sẵn có.

## Data flow chi tiết (record 1 bước)
1. User chọn tool "Chuyển màu" + cấu hình → bấm Áp dụng.
2. ConvertColorsTool gọi `recorder.noteOperation('convertcolors', {conversions, icc_profile, rendering_intent, preserve_black})` rồi fetch `/preflight/convert-colors`.
3. Kết quả `onFileFixed(blob)` → `commitWorkingFile`.
4. Recorder ghép note + commit → push Step.

## Error Handling
- Mỗi Step bọc try/catch; lỗi → `setError(Step i: ...)`, dừng runner.
- Job async: dùng nguyên poll loop của `runProcessEngine`/VDP (đã xử lý failed/abort).
- Validate recipe khi import (schemaVersion, opId hợp lệ) — opId lạ → đánh dấu unsupported, bỏ qua khi phát lại.

## Testing Strategy
- **Unit (vitest)**: `recipeOps` (capture/label/classification), serialize/deserialize Recipe, RecipeStore CRUD (mock fs), PlaybackRunner với `run*` được mock (đảm bảo thứ tự, ép spawnNewTab=false, bỏ qua file-dependent, await tuần tự).
- **Property-ish**: round-trip Recipe JSON (record → save → load) giữ nguyên steps.
- **Backend**: không thêm endpoint mới ở MVP (tái dùng các route có sẵn). Nếu cần "ghi grid đã giải", thêm trường vào response job (có test riêng).
- Không phá test hiện có (FE 278 / BE 407).

## Data Models

### Recipe & RecipeStep (lưu bền vững dưới dạng JSON)
```ts
type RecipeOpId =
  | 'booklet' | 'nup' | 'sticker_imposer' | 'cnc_imposer'
  | 'shuffle' | 'resize' | 'split' | 'merge'
  | 'convertcolors' | 'hairlines' | 'trapping' | 'pdfx' | 'ocr' | 'optimize' | 'spot_cmyk'
  | 'watermark' | 'stick_text_number'
  | 'bgremover' | 'upscale'
  | 'datamerge' | 'numbering' | 'cover_numbering'
  | 'object_edit' | 'crop' | 'page_index_op';   // file-dependent (recordable=false)

interface RecipeStep {
  opId: RecipeOpId;
  label: string;                 // hiển thị + tóm tắt param
  params: Record<string, any>;   // snapshot đủ để phát lại độc lập file
  recordable: boolean;           // false → bỏ qua khi phát lại
  needsExternalInput?: 'csv' | 'file' | null;
  viewerPageOrder?: number[];    // chụp khi thao tác phụ thuộc thứ tự trang (1-based, -1=trang trắng)
  viewerPageRotations?: Record<number, number>;
}

interface Recipe {
  id: string;
  name: string;
  description: string;
  createdAt: string;             // ISO
  updatedAt: string;             // ISO
  steps: RecipeStep[];
  hints?: { sourcePageCount?: number };
  schemaVersion: number;         // để migrate
}
```

### Lưu trữ
- Key: `ps_recipes` (Tauri AppData JSON, fallback localStorage) — sao mẫu `presetManager.ts`.
- Export/import: một Recipe = một file `.json` (không nhúng blob file ngoài).

### Ghi chú quan hệ
- `params` của step bình bài là **subset** của backend settings dựng trong `runProcessEngine` (processHandlers.ts) — tái dùng, không định nghĩa lại.
- `params` của step prepress = body POST tới endpoint tương ứng (vd `/preflight/convert-colors`).

## Correctness Properties

Các bất biến cần giữ (làm cơ sở cho test):

### Property 1: Round-trip
`load(save(recipe))` giữ nguyên thứ tự + nội dung các steps.
**Validates: Requirements 2.4, 2.5**

### Property 2: Thứ tự phát lại
PlaybackRunner gọi các `run<op>` theo đúng thứ tự `steps` (đã lọc file-dependent), không đảo.
**Validates: Requirements 3.1**

### Property 3: Tuyến tính
Mọi bước trung gian chạy với `spawnNewTab=false` → working file luôn là output của bước trước.
**Validates: Requirements 3.2**

### Property 4: Tuần tự bất đồng bộ
Bước job (bình/VDP) phải hoàn tất (download xong) trước khi bước kế bắt đầu.
**Validates: Requirements 3.3**

### Property 5: An toàn ghi
Phát lại KHÔNG ghi đè file nguồn trên đĩa; mọi ghi PDF đi qua đường hiện có (pikepdf) → invariant an toàn màu giữ nguyên.
**Validates: Requirements 7.1, 7.2**

### Property 6: Lọc an toàn
Bước `recordable=false` không bao giờ áp toạ độ file cũ lên file mới (luôn bị bỏ qua + cảnh báo).
**Validates: Requirements 4.2**

### Property 7: Không rò input ngoài
Recipe không chứa blob CSV/file ghép; phát lại luôn re-prompt.
**Validates: Requirements 5.1, 5.2**

### Property 8: Dừng sạch khi lỗi
Lỗi ở bước i → dừng, các bước >i không chạy, file gốc nguyên vẹn.
**Validates: Requirements 3.5**

## Out of Scope (v1)
- Node/DAG workflow (đã loại theo quyết định sản phẩm).
- Hotfolder/CLI/API headless (roadmap riêng — sẽ tái dùng cùng `recipeOps`).
- Phát lại thao tác file-dependent (object edit/crop/VDP-XY) — chỉ cảnh báo.
- Chạy recipe theo lô nhiều file (batch) — cân nhắc v2.

## Rủi ro & giảm thiểu
| Rủi ro | Giảm thiểu |
|---|---|
| Params nằm rải ở nhiều store/component | `recipeOps[opId].capture()` tập trung hoá việc đọc params |
| `spawnNewTab=true` phá chuỗi | Runner ép `false` cho bước trung gian |
| Solver auto khác kết quả trên file khác | Lưu kết quả đã giải (cols/rows) khi có |
| `commitWorkingFile` reset page order/rotations | Step chụp kèm order/rotations |
| Thao tác file-dependent áp nhầm | Phân loại + bỏ qua + cảnh báo |
| Input ngoài (CSV/file) | Re-prompt lúc phát lại, không lưu blob |
