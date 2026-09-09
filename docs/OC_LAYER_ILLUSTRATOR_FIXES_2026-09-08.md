# Fixes boong/ốc, layer Graphtec và mở Illustrator — 2026-09-08

> Audit: `BAO_CAO_AUDIT_REAUDIT_OC_LAYER_ILLUSTRATOR_2026-09-08.md`  
> Trạng thái: source + artifact regression đã sửa; runtime Illustrator/Graphtec Studio vẫn cần smoke trên máy có license.

> **Đính chính 2026-09-09:** người dùng vẫn gặp `0x8007007b` sau Lô D. Test sanitize chỉ mock IPC, không kiểm lời gọi Win32 thật; kết luận Lô D đã xử lý lỗi runtime là không đúng. Nguyên nhân native đã tái hiện ở Lô E bên dưới. Test native không thay thế nghiệm thu UI; trạng thái phiên debug được ghi cuối Lô E.

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

## Lô D — phòng vệ tên PDF tạm (chưa giải quyết lỗi runtime)

| File | Thay đổi | Verify |
|---|---|---|
| `desktop/src/components/imposition-tools/OpenInDesignModal.tsx` | Sanitize `originalName` trước khi ghép `prynx_khuon_*.pdf`; tránh `:`, `\\`, `/`, `*`, `?`, dấu ngoặc kép và ký tự cấm khác đi vào target Win32. | Regression tên `Don:Hang\\Mau?.pdf` tạo target basename `Don-Hang-Mau...pdf`; không còn ký tự cấm. |
| `desktop/src/components/imposition-tools/OpenInDesignModal.test.tsx` | Thêm test publish path với tên nguồn chứa ký tự Windows không hợp lệ. | Modal suite **11 passed**. |

Kết luận trước rằng nguyên nhân chắc chắn ở tên target đã bị bác bỏ: lỗi tiếp tục với tên hợp lệ. Giữ sanitize để bảo vệ tên đầu vào, nhưng không dùng 11 test frontend có mock `write_file_atomic` làm bằng chứng Win32 thành công.

## Lô E — sửa buffer native `FILE_RENAME_INFO` (2026-09-09)

Baseline: commit `178555d`; working tree sạch khi bắt đầu. Chuỗi người dùng: đã bình tem/CNC → **Bế** → mở Illustrator → `Win32 từ chối publish handle file tạm … (0x8007007B)`. Không thay đổi engine/bố cục/OCG trong lô này.

### Nguyên nhân và tái hiện

`desktop/src-tauri/src/lib.rs::publish_atomic_save_temp` copy UTF-16 không có NUL kết thúc vào buffer `offset(FileName) + số_byte_tên`. Buffer căn theo `usize` nên đôi khi padding zero che lỗi. Trên x64 (`offset=20`), khi số code unit `N % 4 == 2`, allocation hết ngay sau ký tự cuối, và Win32 có thể đọc tiếp vùng nhớ ngoài buffer.

Probe Win32 cô lập dùng tên hợp lệ, cùng `CreateFileW` với DELETE/no-share-WRITE/DELETE và `SetFileInformationByHandle(FileRenameInfo)`. Canary `?*` nằm sau vùng buffer cũ nhưng vẫn trong allocation probe, không đọc memory ngẫu nhiên:

| Biến thể | Không thêm NUL | Thêm NUL tường minh |
|---|---|---|
| DOS `C:\…` | 3/4 thành công; ca không padding trả WinError 123 | 4/4 thành công |
| Verbatim `\\?\C:\…` (giống `canonicalize`) | 3/4 thành công; ca không padding trả WinError 123 | 4/4 thành công |
| NT `\??\C:\…` (chỉ đối chứng, không đổi production) | 3/4 thành công; ca không padding trả WinError 123 | 4/4 thành công |

Đổi namespace không giải quyết nguyên nhân. Kiểm Rust trước sửa cũng đỏ xác định: `atomic_save_rename_info_ket_thuc_nul_trong_buffer` báo **thiếu 2 byte NUL**, không phụ thuộc tình cờ của heap. Test publish cũ chỉ có một tên `BanLuu.pdf` vẫn xanh nên đã bỏ lọt biên độ dài.

Căn cứ API: [Microsoft FILE_RENAME_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info) mô tả `FileName` là chuỗi NUL-terminated; [Rust std Windows rename](https://github.com/rust-lang/rust/blob/master/library/std/src/sys/fs/windows.rs) cũng cấp thêm NUL và không tính nó trong `FileNameLength`.

### Bản sửa

- Tách helper nội bộ `atomic_save_rename_info` để kiểm buffer được dùng thật, không viết bản mock khác.
- Cấp thêm 2 byte, copy NUL cuối, giữ `FileNameLength` chỉ tính tên; từ chối NUL bên trong để không cắt ngắn target âm thầm.
- Giữ nguyên canonical parent, identity check, DELETE access, chỉ share READ và handle sau publish tới khi ghi lineage/grant xong. Không fallback đóng handle rồi rename theo path.
- Cùng helper phục vụ `write_file_atomic` và `copy_file_atomic`: **Bế**, lưu/tách file in và các consumer ghi nguyên tử đều nhận bản sửa.

### Verify

- Native `disk_copy_request_tests`: **13 passed**, gồm 24 cấu trúc path/alignment và 32 lượt publish Unicode/verbatim mới/ghi đè, đường dài >260, NUL nội bộ, hardlink/junction và khóa WRITE/DELETE.
- Chạy Cargo test với overlay **chỉ cho test** `TAURI_CONFIG={"bundle":{"resources":[]}}` để không copy đè PDFium DLL đang được app dùng; restore environment sau lệnh. Không sửa config release, không đóng process người dùng.
- Full Tauri `cargo test --lib`: **242 passed, 5 ignored**; `cargo check --lib` đạt (cảnh báo dead-code hiện hữu). Hai bước dùng cùng overlay test nêu trên.
- Regression modal Illustrator hiện hữu: **11 passed**. `rustfmt --check` phạm vi lib và `git diff --check` đạt; frontend chỉ sửa comment đính chính, không thay luồng.
- Quan sát read-only cuối lượt: `src/lib.rs` sửa lúc 05:40:00, debug EXE có mtime 05:41:39 và main process mới bắt đầu 05:41:43 ngày 09/09. Agent không đóng/kill app; phiên dev đã được nạp lại trong lúc kiểm thử. Mốc thời gian không được dùng như bằng chứng đã smoke nút Bế hoặc provenance installer.
- **Chưa smoke nút Bế / Illustrator / Graphtec thật.** Cần thử thao tác trên phiên debug mới. Với phiên khác phải chạy `run_dev.bat` để biên dịch lại Rust; chỉ build Vite hoặc mở lại EXE cũ không nạp bản sửa native này. Chưa build installer/commit/push.

## Lô F — ghép S&R và bàn giao Illustrator native (2026-09-09)

- `_concat_pdf_pages_impl` trước đây làm mất catalog dù writer từng mẫu đã có OCG. Nay chuyển `/OCProperties` bằng bản đồ ref của pikepdf, giữ cây cha-con, layer rỗng Graphtec và trạng thái ẩn/hiện từng mẫu; không gộp theo tên. Regression mới đỏ 11 ca trước sửa; sau sửa bộ backend liên quan **195 passed**, frontend OCG/modal/save **35 passed**, typecheck đạt.
- PDF tạm tờ 1/tờ 3 lúc 06:54 đã có đủ `SA info...`, `Marks_Model_`, `MarkLine`, `/NM=MKLINE` và ref hợp lệ. Illustrator 29.8.2 nhập đúng file tờ 3 nhưng chỉ tạo `Layer 1`, không group, 76 đường vector. Đây là lỗi bàn giao riêng, không phải mất catalog hoặc chọn nhầm trang trong 13 mẫu.
- `external_app.rs` gọi bridge native cho `Illustrator.exe` đã được duyệt và PDF `prynx_khuon_*`. `illustrator_handoff.rs` parse `/OC` + `/NM`, đánh dấu chính xác từng nét bằng spot ngắn trong bản sao PDF; `illustrator_handoff.js` cố định tạo layer/group/item rồi trả màu gốc. Metadata chỉ là JSON, không nhận mã từ renderer; giữ read lease và không ghi đè nguồn.
- Hai lỗi runtime đã được bắt và sửa: handle WRITE còn sống khiến Illustrator hủy mở; tên spot dài bị cắt 31 ký tự khiến mất định danh. Bản bàn giao nay dùng read lease sau đối chiếu byte, tên spot chứa chỉ số trong giới hạn Illustrator.
- Smoke chạy **chính bridge Rust** trên bản sao tờ 3 đã đạt. Đọc lại qua COM: `Marks_Model_` chứa `MarkLine` và đúng 4 `MKLINE`, layer `SA info...` riêng; 76 đường vector, số điểm từng đường giữ nguyên, biên hình học lệch **0 pt**, màu boong trả CMYK 100/100/100/100. Toàn Tauri lib **250 passed, 6 ignored**, smoke opt-in **1 passed**, modal **11 passed**, cargo check đạt.
- Giới hạn: mỗi lượt chọn một trang khuôn; chưa hỗ trợ bridge nhiều trang, boong nằm trong Form/compound path hay Corel. Nút modal/installer và plugin Graphtec chưa được nghiệm thu end-to-end. Không dùng kết quả bridge để khẳng định toàn bộ workflow đã hoàn tất.
- Lỗi build EXE tiếp theo là cache incremental `app_lib` cũ gây LNK2019/LNK1120. Chuyển riêng cache/artifact lỗi vào `target/link-recovery-20260909`, giữ source/config nguyên vẹn; build dev bình thường sau tạo lại cache đạt hai lượt liên tiếp. Không tắt incremental lâu dài.
