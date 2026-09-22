# NHẬT KÝ LÔ FIX HIỆU NĂNG RENDER / THUMBNAIL / FILE NẶNG — 2026-09-23

Phạm vi theo `BAO_CAO_AUDIT_PERF_RENDER_THUMB_HEAVY_2026-09-23.md`.

## Lô 1 — Virtualize sidebar thumbnail

- Finding: `§R23.05`.
- File: `desktop/src/components/acrobat/ThumbSidebar.tsx`.
- Thay đổi: dùng `VirtuosoGrid`; chỉ mount viewport + overscan, giữ nguyên `pageOrder`, index, selection, drag/context menu và request key.
- Commit: `65f15aa`.
- Verify: `npm run typecheck` đạt; Vitest `ThumbSidebar.aiStatus.test.tsx` + `ThumbSidebar.cutlinePreview.test.tsx`: **12/12 pass**.
- Chưa đạt: runtime Tauri với PDF 1.000+ trang, đo DOM/RSS và scroll thumbnail thật.

## Lô 2 — Document-affinity cho worker nền

- Finding: `§R23.02`.
- File: `desktop/src-tauri/src/pdf_engine/render_worker.rs`.
- Thay đổi: khóa affinity theo `document.path + document.token` cho background lane; cùng snapshot PDF dùng lại worker/DOC_CACHE/page LRU; xóa affinity khi worker transport lỗi hoặc đóng tài liệu.
- Commit: `37df8e1`.
- Verify: `cargo check --manifest-path desktop/src-tauri/Cargo.toml` đạt; test `document_affinity` đạt **1/1**.
- Ghi chú: lần check đầu bị build lock/file lock do tiến trình Cargo khác; chạy lại sau khi tiến trình đó kết thúc đã đạt. `cargo fmt --all -- --check` còn báo các khác biệt format có sẵn ngoài lô này; không chạy formatter toàn repo để tránh sửa file người dùng.
- Chưa đạt: runtime A/B chứng minh `open_ms`, cache hit ratio, first-pixel và peak RSS trên file khách.

## Lô kế tiếp

1. Telemetry sạch theo document/worker/session để đo A/B.
2. First-pixel fast path tách PageShell/geometry khỏi metadata nền nhưng giữ soundness màu.
3. PPE retained scene/resource cache sau khi có baseline sạch.

## Lô 3 — Nâng lane tile khi trang prefetch trở thành active

- Finding: `§R23.06`.
- Files: `desktop/src/components/workspace/LivePageFrame.tsx`, `desktop/src/hooks/viewer/renderCoordinator.ts`, `desktop/src/hooks/viewer/tileRenderScheduler.ts` và test liên quan.
- Thay đổi: khi tile còn nằm trong hàng đợi nền nhưng trang đã active, coordinator/scheduler hạ priority của task đang chờ và cập nhật `purpose`; không hủy hoặc dựng lại cùng bitmap.
- Commit: `295700b`.
- Verify: `npm run typecheck` đạt; Vitest scheduler/coordinator/LiveTile: **48/48 pass**.
- Chưa đạt: runtime A/B trên file khách để xác nhận queue_ms/first-pixel giảm; request đã chạy trong worker không thể bị đổi lane giữa chừng và vẫn cần telemetry.

## Lô 4 — Telemetry affinity worker an toàn

- Finding: hỗ trợ đo `§R23.02`/`§R23.06`.
- File: `desktop/src-tauri/src/pdf_engine/render_worker.rs`.
- Thay đổi: ghi `RENDER_WORKER_AFFINITY` với action/lane và mã băm 12 ký tự của snapshot tài liệu; không ghi path hay tên file khách hàng.
- Commit: `4682ccc`.
- Verify: `cargo check` đạt; test `document_affinity` **1/1 pass**.
- Chưa đạt: cần chạy binary mới trên file khách để thu `open_ms`, `queue_ms`, affinity hit/assign/drop và peak RSS.
