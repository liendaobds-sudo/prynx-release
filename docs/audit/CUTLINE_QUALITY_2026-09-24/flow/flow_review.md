# Trace UI → CUT PDF và consumer — 2026-09-24

Phạm vi sub-audit chỉ đọc: PDF classic **Bù xén tạo đường cắt**; Tách nhiều tem và Máy cắt chỉ ghi rõ là nhánh riêng/hạ nguồn. Không thay production.

## Defaults thực đang chạy

| Tham số | Giá trị/ý nghĩa | Bằng chứng |
|---|---|---|
| Nguồn đường cắt | `original` | `desktop/src/components/preprocess-tools/StickerTool.tsx:340` |
| Kiểu góc | `preserve` | `StickerTool.tsx:342` |
| Offset | 0 mm, range -10…10 | `StickerTool.tsx:341` |
| Độ bo cong | 50%, 0…100 step5, lưu localStorage | `StickerTool.tsx:346`, `:1424` |
| Khử răng cưa | 30%, 0…100 step5, lưu localStorage | `StickerTool.tsx:419`, `:1448` |
| Simplify | UI hardcode AUTO=true; scalar request ban đầu0; hook tự chọn0.1 mm cho raster/Alpha/AI chưa có CUT | `StickerTool.tsx:488–493`; `useClassicCutlinePreview.ts:547–551`, `:785`; `stickerToolPolicy.ts:7` |
| Smoothness/Fidelity | Classic cố định50/50 | `useClassicCutlinePreview.ts:960–961` |
| Min detail area | Classic cố định1 mm² | `useClassicCutlinePreview.ts:964` |

Giá trị0.1 mm là sai lệch bổ sung so đường baseline trước Simplify, **không phải cam kết tổng sai số so biên ảnh gốc** (`desktop/src/lib/stickerSheetApi.ts:155–156`). Tài liệu UI ngày09-10 không còn mô tả hiện trạng: slider Simplify đã bị bỏ và AUTO chuyển thành mặc định ngày09-11. UI hiện không đọc ra số node/cận sai số mặc dù payload có quality.simplification.

## Trace chính và chốt đang có

1. `StickerTool.tsx:505` → `useClassicCutlinePreview.ts:950` → `stickerSheetApi.ts:452–468`: preview nhận scalar Simplify, DPI x/y riêng, denoise và corner. Hook có cancellation/generation, chặn response cũ và debounce40ms.
2. Một component: shared alpha fitter, canonical path_groups; `sticker_cutline_preview.py:1469–1492` bind geometry/Simplify/algorithm vào fingerprint. Multi-component PDF Alpha: hook chọn whole-page ở `useClassicCutlinePreview.ts:763–773`.
3. Preview whole-page: `sticker_classic_page_preview.py:406–410` tạo geometry, `:298` gọi engine, `:306–328` đọc CUT PDF thật rồi tạo SVG và giữ memo. Không chỉ vẽ polygon raster.
4. `StickerTool.tsx:714–719` gửi reference session/revision/page/fingerprint khi execute. `pdf_tools.py:1768–1784` snapshot; mismatch trả409. Một component dùng `approved_contour_overrides`, `pdf_tools.py:1828–1831`; snapshot toàn trang chỉ truyền Simplify memo, `sticker_sheet_export.py:396–397`, `pdf_tools.py:1918–1920`.
5. Writer chính giữ cubic: `sticker_engine.py:11438–11443` → `build_bezier_segments_path_stream`. SVG preview frontend dùng `path.d` trực tiếp (`StickerSheetWorkspace.tsx:73–76`, thumbnail overlay `thumbnailCutlinePreview.tsx:57–59`), không tự flatten thành node dày.

## F01 — P1 — lệch AUTO giữa preview whole-page và execute [CONFIRMED][ARTIFACT]

- UI luôn `cutlineSimplifyAuto=true` (`StickerTool.tsx:492`) và execute truyền flag đó qua policy tới `pdf_tools.py:1920`.
- Preview API chỉ gửi scalar `cutline_simplify_mm`; whole-page geometry không có flag AUTO (`sticker_classic_page_preview.py:406–410`), nên engine dùng mặc định `cutline_simplify_auto=False` (`sticker_engine.py:8792`).
- Execute AUTO bỏ bước Simplify nếu `cut_fitted_paths` đã có hoặc góc round/alpha_smooth (`sticker_engine.py:11384–11397`, thay đổi gắn tag09-19). Preview scalar vẫn gọi Simplify cùng trường hợp đó.
- Snapshot whole-page chỉ chép memo; nó không cấp final path override. AUTO skip trước khi gọi solver nên memo không cứu được khác biệt policy.

Root đã xác minh bằng worker whole-page thật + memo truyền vào Execute + PDF đọc lại: Binder2 trang12, original/preserve, offset2mm, denoise30, Simplify0.1mm. Preview **56 cubic**, Execute AUTO **73 cubic**, SVG khác nhau. Memo có1 entry nhưng Execute gọi Simplify **0 lần**, xác nhận gate AUTO bỏ đường đã tối ưu. Preview lạnh16.7656s, preview nóng0.00524s, Execute0.71256s; đây là đo một ca backend, không là latency GUI hay tuyên bố speedup trên cùng chất lượng. Evidence: `../preview_auto_parity.json`; PDF: `output/pdf/Cutline-quality-audit-2026-09-24/Binder2_p12_auto_with_preview_memo.pdf`.

Không kết luận mọi trang lệch; cần đường đã fit và Simplify manual có thay đổi. Một-component canonical override có thể giữ đường đúng; không gán bug cho mọi classic.

Gap test: `test_sticker_classic_page_preview.py:53–76` kiểm parity ở Simplify0 và không có AUTO; round test `:78–118` cũng bỏ flag. `test_sticker_simplify_auto.py:46–68` spy simplifier trên raster tổng hợp, không so actual CUT với whole-page preview/memo. Không có test nhắm gate `AUTO-SKIP-FITTED`.

## F02 — hạ nguồn Máy cắt làm mất cubic và flatten phụ thuộc CTM [ARTIFACT]

Không phải writer PDF Bù xén, không phải CUT writer N-Up.

- Router sống tại `main.py:399–400`; cut-export API gọi `inspect_cut_pdf`/`build_cut_model_from_pdf` (`cut_export/api.py:231`, `:310`).
- `cut_layer_extractor.py:254–256` lấy mẫu cubic trong user-space rồi áp CTM. `:290–303` chọn số bước từ độ dài control polygon, clamp2…60; `flatten_tol_pt` không phải cận sai số liên tục.
- `CutPath` chỉ chứa points (`cut_model.py:36–49`). PDF emitter dùng lineTo (`emitters/pdf_spot.py:46–52`), SVG dùng L (`emitters/svg.py:74–79`), kể cả format đích có hỗ trợ cubic.
- Harness `probe_downstream_ctm.py` tạo hai PDF cùng hình vật lý4 cubic, bán kính100mm: một bằng tọa độ vật lý, một bằng unit coordinates+CTM scale. Read → CutModel → PDF emitter thật.

| Biểu diễn input | Source | Reexport | Sai lệch lớn nhất lấy mẫu cubic→polyline |
|---|---:|---:|---:|
| Physical coordinates | 4 cubic | 240 line | 0.009303185 mm |
| Normalized+CTM | 4 cubic | 12 line | 3.494354909 mm |

4097 mẫu/cubic; số trên là max đo mẫu, không gọi là chứng chỉ liên tục. `downstream_ctm_evidence.json` và4 PDF cùng thư mục. Command chạy exit0: `backend/venv/Scripts/python.exe docs/audit/CUTLINE_QUALITY_2026-09-24/flow/probe_downstream_ctm.py`.

Khuyến nghị hạ nguồn: giữ line/cubic trong model cho PDF/SVG; chỉ flatten nếu protocol máy cần polyline và chứng nhận sai số trong mm sau CTM. Không lấy số node PDF Bù xén làm số lệnh driver.

Đối chứng an toàn: N-Up production lấy path_items gốc `nup_diecut.py:451–459`, renderer ghi `draw_bezier` tại `nup_artwork.py:2037–2040`; polygon collision là nhánh khác. Không báo nhầm mọi N-Up làm mất cubic.

## Backlog đã biết, không phải discovery mới

§NODE.1 Tách nhiều tem: backend A1 đã có denoise, nhưng frontend export vẫn không nhận/gửi denoise trong `StickerSheetPageExport` (`stickerSheetApi.ts:140–150`), options `:570–574`, JSON `:584–604`; preview gửi nó ở `:467`. Nhật ký09-09 ghi A2 chưa làm. Cần gọi đúng là việc cũ chưa khép end-to-end, không gán sang classic và không khai là đã sửa trọn.

## Giới hạn

Vitest Windows nhóm `StickerTool.test.ts`, `StickerTool.ui.test.tsx`, `useClassicCutlinePreview.test.tsx`: **3 file / 95 test passed**,8.20s, log `frontend_tests.txt`. Lần đầu sandbox dừng trước khi thu thập test do Vite `spawn EPERM`; chạy lại ngoài sandbox đạt. Không sửa expectation/test hay production. Kết quả xanh không phủ parity whole-page AUTO→actual PDF nêu ở F01.

Chưa chạy Tauri/Illustrator/máy vật lý. Không sửa source/test production hoặc golden. Không chạy full suite; đã probe hạ nguồn2 PDF4 cubic và Vitest hẹp trên Windows. Không đọc hết toàn bộ pipeline N-Up/CNC trong sub-audit này.
