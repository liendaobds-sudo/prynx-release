# Implementation Plan: Phiên chỉnh sửa PDF trong bộ nhớ (`pdf-edit-session`)

## Overview

Triển khai phương án "C": giữ một `pikepdf.Pdf` SỐNG theo phiên trong RAM backend, áp Edit_Op in-memory, render tăng tiến theo vùng clip, và chỉ Commit ra đĩa khi cần. Kế thừa nguyên trạng `Stream_Editor` / `Geometry_Reader` / schema `EditOp` / `edit_io.save_working_file` của `pdf-object-edit`.

Thứ tự xây dựng đi từ engine phiên backend (`edit_session.py`) → tách render clip → undo/redo → commit → vòng đời/TTL → endpoints `/edit/session/*` → tích hợp frontend (`useEditSession`, `LivePageFrame`, `ImpositionTab`), mỗi bước nối tiếp bước trước và kết thúc bằng wiring để không còn code mồ côi.

Backend: **Python (FastAPI + pikepdf + pypdfium2)**. Frontend: **TypeScript/React**.

## Tasks

- [x] 1. Khởi tạo engine phiên backend (`app/core/edit_session.py`)
  - [x] 1.1 Tạo module phiên với store + vòng đời mở phiên
    - Tạo file `backend/app/core/edit_session.py`
    - Định nghĩa `@dataclass EditSession` (session_id, source_fid, source_path, pdf, baseline_bytes, op_log, redo_stack, lock, last_access, dirty, last_commit_path)
    - Tạo `SESSIONS: dict[str, EditSession]`, `_STORE_LOCK`, phụ trợ `by_fid: dict[str, str]`
    - Implement `open_session(fid) -> EditSession`: đọc file gốc theo `fid`, giữ `baseline_bytes`, mở `pikepdf` từ bytes; đảm bảo ≤1 phiên/fid (đóng phiên cũ nếu trùng); khởi tạo `op_log`/`redo_stack` rỗng, `last_access`, `dirty=False`
    - Lỗi `fid` không tồn tại / file mất → raise lỗi không-tìm-thấy-file, KHÔNG tạo phiên
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [-]* 1.2 Viết unit test cho store và open_session
    - Test mở phiên trả Session_Id duy nhất, op_log rỗng
    - Test ≤1 phiên/fid (mở lại cùng fid đóng phiên cũ)
    - Test fid không tồn tại → lỗi, không tạo phiên
    - _Requirements: 1.1, 1.3, 1.5_

- [x] 2. Áp Edit_Op in-memory
  - [x] 2.1 Implement `apply_op(session, op) -> opResult`
    - Giữ `session.lock` tuần tự hóa thao tác trong cùng phiên
    - Resolve target: `pdf.save(BytesIO)` → PDFium `Geometry_Reader.list_objects` trên bytes hiện tại để map object nhất quán với trạng thái phiên
    - Áp thao tác qua `Stream_Editor.*` (delete/move/resize/rotate/edit_text/add) — chỉ pikepdf, KHÔNG PDFium GenerateContent
    - Thành công: append vào `op_log`, `redo_stack.clear()`, `dirty=True`, cập nhật `last_access`; trả `opResult` gồm bbox MỚI
    - Session_Id không sống → lỗi phiên-không-tồn-tại; thất bại map/glyph/tham số → giữ nguyên `pdf`, KHÔNG vào op_log
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 6.1_

  - [-]* 2.2 Property test: tương đương in-memory ↔ commit so với Legacy
    - Tạo `backend/tests/test_session_commit_equiv_legacy_pbt.py`
    - **Property 1: Tương đương in-memory ↔ commit (Round-trip / Model-based)**
    - **Validates: Requirements 2.1, 6.2, 11.2**

  - [-]* 2.3 Property test: bảo toàn màu Untouched_Object
    - Tạo `backend/tests/test_session_color_preservation_pbt.py`
    - **Property 2: Bảo toàn màu Untouched_Object (Invariant)**
    - **Validates: Requirements 2.6, 6.2**

  - [-]* 2.4 Property test: round-trip màu CMYK/spot
    - Tạo `backend/tests/test_session_cmyk_roundtrip_pbt.py`
    - **Property 3: Round-trip màu CMYK/spot (Round-trip)**
    - **Validates: Requirements 6.3**

- [x] 3. Render tăng tiến theo vùng clip
  - [x] 3.1 Tách `_render_clip_blocking` trong `edit.py`
    - Sửa `backend/app/api/routes/edit.py`: tách `_render_clip_blocking(pdf_bytes, page, scale, clipRect|None)` từ `_render_preview_blocking`
    - Render toàn trang bằng PDFium (read-only) rồi crop ảnh (PIL) theo `clipRect`; `clipRect=None` → trả full-page
    - _Requirements: 3.1, 3.4, 6.1_

  - [x] 3.2 Implement `render_clip(session, op, scale, clip_pad)` trong `edit_session.py`
    - Tính Clip_Region = bbox đối tượng mục tiêu (sau op) + `clip_pad_pt`; với `move`/`add` gộp vùng CŨ + MỚI
    - Quy đổi qua Page_Box (CropBox, fallback MediaBox) để khớp ảnh PDFium
    - Gọi `_render_clip_blocking` với bytes đã save (tái dùng bytes của apply_op → save 1 lần/op), trả `(png_b64, clipRect, full)`
    - Vùng không xác định giới hạn → `clipRect=None, full=True` (render toàn trang)
    - _Requirements: 3.2, 3.3, 3.5, 3.6, 4.1, 4.2_

  - [ ]* 3.3 Integration test: clip render khớp toàn trang
    - Tạo `backend/tests/test_session_clip_render_matches_full.py`
    - **Property 6: Tương đương vùng clip ↔ toàn trang (Metamorphic)** — kiểm bằng 1–3 ví dụ
    - open → op(move) → render clip ≡ vùng tương ứng của full, tolerance ≤ 1.0pt
    - **Validates: Requirements 3.5, 4.3**

- [x] 4. Undo / Redo theo phiên (baseline + replay)
  - [x] 4.1 Implement `undo(session)` và `redo(session)`
    - Undo: `pikepdf.open(BytesIO(baseline_bytes))` → replay `op_log[:-1]` → thay `pdf`; op bỏ đẩy vào `redo_stack`
    - Redo: pop `redo_stack` → áp lên `pdf` → push `op_log`
    - Undo khi op_log rỗng → giữ nguyên Live_Document, báo trạng thái không-có-gì-để-hoàn-tác
    - Trả về cấu trúc như `apply_op` (opResult + canUndo/canRedo) kèm render clip
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.6_

  - [ ]* 4.2 Property test: Undo/Redo idempotent theo cặp
    - Tạo `backend/tests/test_session_undo_redo_pbt.py`
    - **Property 4: Undo/Redo idempotent theo cặp (Round-trip)**
    - **Validates: Requirements 7.5**

- [x] 5. Commit & Defer_Commit
  - [x] 5.1 Implement `commit(session) -> output_path`
    - `edit_io.save_working_file(pdf, build_working_file_path(...))` với `compress_streams=False`, ghi Working_File MỚI (KHÔNG đè gốc)
    - Đăng ký UploadedFile (tái dùng `_register_working_file`), set `dirty=False`, cập nhật `last_commit_path`
    - Commit thất bại → giữ nguyên `pdf` trong RAM, raise lỗi để thử lại
    - _Requirements: 5.2, 5.5, 6.2, 6.3, 6.4, 8.3, 10.5, 11.4_

- [x] 6. Vòng đời, đóng phiên và dọn RAM theo TTL
  - [x] 6.1 Implement `close_session(sid)` và `sweep_expired()`
    - `close_session`: `pdf.close()` + xóa khỏi `SESSIONS`/`by_fid`, giải phóng RAM, giữ nguyên file gốc + Working_File đã commit
    - `sweep_expired`: dọn phiên quá `SESSION_TTL` (30 phút) kể từ `last_access`
    - Lazy sweep mỗi lần tra phiên; tra Session_Id đã dọn/đóng → tín hiệu phiên-không-tồn-tại
    - _Requirements: 9.1, 9.2, 9.3, 9.5_

  - [x] 6.2 Wire background sweep vào `app/main.py`
    - Sửa `backend/app/main.py`: thêm asyncio background task trong `lifespan` gọi `sweep_expired()` mỗi ~5 phút
    - _Requirements: 9.4_

  - [ ]* 6.3 Property test: Op_Log nhất quán khi lỗi/timeout
    - Tạo `backend/tests/test_session_oplog_consistency_pbt.py`
    - **Property 5: Op_Log nhất quán khi lỗi/timeout (Invariant)**
    - **Validates: Requirements 10.1, 10.2, 10.3**

- [x] 7. Endpoints `/edit/session/*`
  - [x] 7.1 Thêm endpoints và schema vào `edit.py`
    - Sửa `backend/app/api/routes/edit.py`: thêm Pydantic `SessionOpenReq/Resp`, `SessionOpReq`, `SessionOpResp`
    - Endpoints: `POST /edit/session/open`, `/op`, `/commit`, `/undo`, `/redo`, `DELETE /edit/session/{sid}`; tất cả `Depends(require_license)`, chạy threadpool có `asyncio.wait_for(EDIT_TIMEOUT_SECONDS)`
    - Map lỗi → HTTP: phiên không tồn tại → 410, `ObjectMapError` → 409, `GlyphCoverageError` → 422, `ValueError` → 422, timeout → 504, file gốc mất → 404; timeout giữ nguyên `pdf`, op CHƯA append log
    - Giữ NGUYÊN các endpoint Legacy (`/edit/objects`, `/edit/delete`, `/edit/transform`, `/edit/text`, `/edit/add`, `/edit/preview`)
    - _Requirements: 1.1, 2.4, 5.1, 5.6, 9.5, 10.1, 10.2, 10.3, 11.1, 11.3_

  - [ ]* 7.2 Integration test: undo/redo e2e + fallback 410
    - Tạo `backend/tests/test_session_undo_redo_e2e.py` (open→op×N→undo/redo→commit) và `backend/tests/test_session_fallback.py` (session-gone 410 → kết quả Legacy tương đương)
    - **Validates: Requirements 7.1–7.4, 9.5, 11.1, 11.2**

- [x] 8. Checkpoint backend - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Tiện ích quy đổi tọa độ frontend (`editGeometry.ts`)
  - [x] 9.1 Thêm `clipRectPdfToCanvas(clipRect, pageHeightPt, bx0, by0, scale)`
    - Sửa `desktop/src/components/.../editGeometry.ts`: hàm thuần quy đổi clipRect PDF (point, bottom-left, trừ gốc Page_Box) → canvas px, tolerance ≤ 1.0pt
    - _Requirements: 4.1, 4.2, 4.3_

  - [ ]* 9.2 Viết vitest cho `clipRectPdfToCanvas`
    - Thêm ca test trong `editGeometry.test.ts` gồm CropBox lệch gốc chống regression tọa độ
    - _Requirements: 4.1, 4.2, 4.3_

- [x] 10. Hook phiên frontend (`useEditSession.ts`)
  - [x] 10.1 Implement `useEditSession`
    - Tạo `desktop/src/hooks/useEditSession.ts`: quản lý `sessionId`, `openSession(fid)`, `applyOp(op, scale)`, `undo()/redo()`, `commit()`, `closeSession()`
    - Timer debounce-commit (~1.5s sau op cuối), cờ `sessionFailed` bắt 410 → tín hiệu fallback Legacy
    - Trả `{preview, clipRect, opResult, canUndo, canRedo}` cho FE dán overlay + cập nhật overlay objects
    - _Requirements: 5.1, 5.3, 5.6, 9.5, 11.1, 12.2, 12.4_

  - [ ]* 10.2 Viết vitest mock fetch cho hook
    - Test open/op/commit/fallback-410
    - _Requirements: 9.5, 11.1_

- [x] 11. Tích hợp `LivePageFrame.tsx`
  - [x] 11.1 Wire phiên vào edit mode
    - Sửa `desktop/src/components/workspace/LivePageFrame.tsx`: vào edit mode → `openSession(selectionFileId)`
    - `commitEditTransform`/`commitEditObjectText`/`commitAddTextObject` → gọi `applyOp(op)` thay `sendEditAndPreview`; thêm state `editPreviewOverlays` dán PNG tại `clipRectPdfToCanvas(...)×scale`
    - Cập nhật `editObjects` tại chỗ từ `opResult.bbox` (KHÔNG refetch, KHÔNG đổi pdfUrl); giữ ghost dashed real-time (CSS) lúc kéo
    - Undo/redo Ctrl+Z/Y khi `isObjectEditMode`; commit (debounce/lưu) → `onEditCommit(output_*)` → đổi pdfUrl, gỡ overlay SAU khi tile mới `onload`
    - `sessionFailed` → rơi về `sendEditAndPreview` + `useObjectEditHistory` cũ
    - _Requirements: 3.3, 4.3, 5.2, 8.1, 8.2, 8.3, 11.1, 12.2, 12.3, 12.4_

- [x] 12. Tích hợp `ImpositionTab.tsx`
  - [x] 12.1 Wire vòng đời phiên vào ImpositionTab
    - Sửa `desktop/src/components/.../ImpositionTab.tsx`: mở/đóng phiên theo vòng đời edit mode; commit khi lưu
    - _Requirements: 9.1, 11.1, 12.2_

- [x] 13. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional (test-related) and can be skipped for a faster MVP.
- Properties 1–5 được kiểm bằng property-based tests (Hypothesis) trên logic engine phiên với PDF in-memory ngẫu nhiên có CMYK/spot/overprint/ICC.
- Property 6 (clip ↔ full) và hành vi thư viện/tiến trình ngoài (PDFium pixel, Rust Tile_Renderer) kiểm bằng integration test 1–3 ví dụ, KHÔNG PBT.
- Mục tiêu hiệu năng (< ~300ms) kiểm bằng benchmark thủ công, KHÔNG nằm trong task list (không tự chạy app end-to-end).
- Mỗi task tham chiếu clause yêu cầu cụ thể để truy vết; mỗi property test tham chiếu property number của design.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "3.1", "9.1", "10.1"] },
    { "id": 1, "tasks": ["2.1", "1.2", "9.2", "10.2"] },
    { "id": 2, "tasks": ["3.2", "11.1", "12.1"] },
    { "id": 3, "tasks": ["4.1", "3.3"] },
    { "id": 4, "tasks": ["5.1"] },
    { "id": 5, "tasks": ["6.1", "2.2", "2.3", "2.4", "4.2"] },
    { "id": 6, "tasks": ["7.1", "6.2"] },
    { "id": 7, "tasks": ["7.2", "6.3"] }
  ]
}
```
