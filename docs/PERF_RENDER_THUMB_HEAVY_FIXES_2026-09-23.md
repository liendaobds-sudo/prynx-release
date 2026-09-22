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

