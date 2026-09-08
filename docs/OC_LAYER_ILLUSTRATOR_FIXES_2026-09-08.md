# Fixes boong/ốc, layer Graphtec và mở Illustrator — 2026-09-08

> Audit: `BAO_CAO_AUDIT_REAUDIT_OC_LAYER_ILLUSTRATOR_2026-09-08.md`  
> Trạng thái: source + artifact regression đã sửa; runtime Illustrator/Graphtec Studio vẫn cần smoke trên máy có license.

## Lô A — Writer true-shape và merge OCG

| File | Thay đổi | Verify |
|---|---|---|
| `backend/app/workers/nesting_imposition_render.py` | Tạo cây OCG Graphtec/layer/group một lần cho artifact; gắn `/Resources/Properties`; bọc từng mark bằng `/OC` và `/Span ... /NM`; Sticker chỉ gắn OCG ở CUT (hoặc Front khi không có CUT), CNC gắn Front+CUT. | Artifact Sticker/CNC: `/OCProperties`, `/D/Order`, tên OCG và `/NM` đạt; Back CNC không có boong. |
| `backend/app/workers/nup_output_finalize.py` | Ghép chunk remap page resource theo `objgen`/object identity thay vì `/Name`, tránh dồn group trùng tên về sheet cuối. | Regression hai chunk trùng `AUDIT_GROUP`: hai trang giữ hai ref khác nhau. |
| `backend/tests/test_nesting_imposition_render.py` | Thêm artifact test tên layer/item cho Sticker true-shape và CNC true-shape. | Phạm vi writer **61 passed**. |
| `backend/tests/test_nup_output_finalize.py` | Thêm regression duplicate-name OCG qua merge. | Phạm vi finalize + writer **67 passed**. |

## Lô B — Page plan homogeneous và file tách

| File | Thay đổi | Verify |
|---|---|---|
| `desktop/src/components/imposition-tools/OpenInDesignModal.tsx` | Nhận diện output Sticker có tổng trang lẻ là `CUT chung` ở cuối; không suy cặp xen kẽ. | Test modal chọn đúng trang cuối và giữ OCG. |
| `desktop/src/lib/printFileNaming.ts` | Thêm `sharedMasterCut`; lập kế hoạch `[in_0..in_N, cut_chung]`. | Test plan pageIndex 0..N và CUT cuối. |
| `desktop/src/components/workspace/SavePrintFilesModal.tsx` | Suy shared-master từ số trang lẻ; hiển thị đúng số loại/tệp. | Typecheck + suite frontend. |
| `desktop/src/lib/savePrintFiles.ts` | Tự suy shared-master khi cần; giữ OCG rỗng Graphtec cho file CUT (và Front CNC). | Regression parse PDF ghi ra giữ `GRAPH_INFO/PONT_LAYER/PONT_GROUP`. |
| `desktop/src/components/imposition-tools/OpenInDesignModal.test.tsx`, `desktop/src/lib/printFileNaming.test.ts`, `desktop/src/lib/savePrintFiles.nativePath.test.ts` | Khóa page mapping, naming và OCG tách file. | **23 passed** trong ba file. |

## Verify tổng hợp

- Backend nesting/cnc/true-shape/production: **225 passed**.
- Backend writer/finalize/finishing: **79 passed**.
- Backend full `pytest -q tests` (trước Lô C): **5.358 passed, 2 skipped**; sau Lô C focused **101 passed**.
- Frontend phạm vi OCG/page-plan/process: **187 passed**, typecheck xanh.
- Frontend sau khi thêm test save-plan/OGC: **23 passed**, typecheck xanh.
- `npm run build`: **PASS** (tsc + Vite production build).
- `npm run test` toàn bộ frontend bị chặn ngay lúc load config bởi `spawn EPERM` trong môi trường đang có nhiều process; các suite liên quan vẫn **186 passed** và typecheck/lint file sửa xanh.
- Chưa build release/Nuitka/Tauri installer; chưa mở artifact trong Illustrator/Graphtec Studio thật.

## Lô C — Hardening contract còn lại

| File | Thay đổi | Verify |
|---|---|---|
| `backend/app/schemas/pont.py` | `pontType` chỉ nhận `none/corner/5mm/custom`, chuẩn hóa khoảng trắng/chữ hoa trước khi render. | Regression unknown + case-insensitive đạt. |
| `backend/app/workers/nup_marks.py` | Guide dùng cùng `itemName` marked-content như bốn ốc. | CNC guide artifact giữ 5 `/NM` item mỗi side. |
| `desktop/src/components/imposition-tools/OpenInDesignModal.tsx` | Path native fail-closed với sentinel không phải PDF; fallback chỉ nhận blob có header `%PDF-`; hỗ trợ output không có trang CUT riêng. | Modal suite 10/10, typecheck xanh. |

## Hạn chế còn lại

1. `itemName` mới được đảm bảo ở mức PDF marked-content `/NM`; Illustrator có hiển thị thành object name native hay không phải smoke downstream.
2. Màu ốc vẫn là DeviceCMYK `100/100/100/100`; chưa có test tách màu vật lý trên máy Graphtec.
3. Runtime app hiện cần license hợp lệ để chạy thao tác end-to-end.

## Lô D — lỗi Win32 `0x8007007b` khi tạo PDF tạm Illustrator

| File | Thay đổi | Verify |
|---|---|---|
| `desktop/src/components/imposition-tools/OpenInDesignModal.tsx` | Sanitize `originalName` trước khi ghép `prynx_khuon_*.pdf`; tránh `:`, `\\`, `/`, `*`, `?`, dấu ngoặc kép và ký tự cấm khác đi vào target Win32. | Regression tên `Don:Hang\\Mau?.pdf` tạo target basename `Don-Hang-Mau...pdf`; không còn ký tự cấm. |
| `desktop/src/components/imposition-tools/OpenInDesignModal.test.tsx` | Thêm test publish path với tên nguồn chứa ký tự Windows không hợp lệ. | Modal suite **11 passed**. |

Nguyên nhân nằm ở tên target, không phải nội dung PDF hay OCG. `SetFileInformationByHandle` chỉ báo lỗi ở bước publish nên UI trước đó hiển thị thông báo Win32 dài như ảnh người dùng gửi.
