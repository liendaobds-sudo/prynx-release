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

## Lô 5 — Gom target DPI sau first-frame

- Finding: chuỗi stale/cancel 56 → 68 → 92 DPI trong cold-open runtime probe.
- Files: `desktop/src/components/workspace/LivePageFrame.tsx` và test LiveTile.
- Thay đổi: khi đã có first-frame prime, trì hoãn 120 ms cho target accurate kế tiếp để gom các thay đổi layout/fit liên tiếp; không trì hoãn frame đầu và không hạ DPI cuối.
- Commit: `8b13216`.
- Verify: `npm run typecheck` đạt; LiveTile **26/26 pass**.
- Chưa đạt: cần chạy lại cùng PDF khách để xác nhận số stale/cancel và số lượt PPE giảm.
- Telemetry settle thêm tại commit `f696438` để phiên runtime kế tiếp ghi rõ lúc gom target DPI.

## Lô 6 — Hoãn accurate base nền đến khi layout ổn định

- Bằng chứng runtime mới: event `tile-accurate-target-settle` đã xuất hiện; trang accurate nền vẫn có request 68 DPI rồi 92 DPI sau khi active/layout đổi.
- Files: `LivePageFrame.tsx`, `livePageFramePolicy.ts`, test LiveTile.
- Thay đổi: accurate base/underlay nền chỉ được dựng khi `renderZoom` khớp target hiện tại; trang active không bị gate này.
- Commit: `30ea519`.
- Verify: typecheck đạt; LiveTile + renderPolicy **49/49 pass**.
- Chưa đạt: runtime A/B trên cùng PDF; giữ kế hoạch tiến tới retained scene/resource cache sau baseline.

- Runtime probe cho thấy 120 ms vẫn phát hai settle cách nhau ~208 ms; commit `3c02d26` đồng bộ settle lên 250 ms theo debounce zoom hiện tại. Verify lại: typecheck + LiveTile/renderPolicy **49/49 pass**.

## Runtime probe — phiên người dùng 2026-09-23

Nguồn: `%USERPROFILE%\Desktop\PrynX_RenderPerf.log`, lượt cuối lúc 04:56. Đây là probe runtime thật, chưa phải P95 corpus.

- PDF 44 trang: bootstrap **43 ms**, full metadata **53 ms**; page 1 PPE 92 DPI `total_ms=193`, first-pixel khoảng **418 ms sau `pdf-load-start`**; page 2/page 3 first-pixel lần lượt khoảng **1.97 s / 2.76 s** khi các trang accurate được dựng nối tiếp.
- Cùng PDF: affinity background chuyển sang `hit lane=background:4`; thumbnail page 1–5 trả khoảng **9–53 ms**.
- PDF 123 trang: bootstrap **52 ms**, page 1 display render `10–20 ms`, first-pixel khoảng **136 ms**; thumbnail các trang đầu khoảng **153–236 ms**, affinity `hit lane=background:0`.
- Priority promotion đã chạy thật (`tile-priority-promote` với `previous_priority=100 → priority=10`) và không cần hủy bitmap đang chờ.

Khoảng trống còn lại: cold-open PDF 44 trang vẫn phát chuỗi request accurate 56 → 68 → 92 DPI và có stale/cancel ở các generation cũ. Đây là mục tiêu lô kế tiếp: ổn định target DPI/first-frame để giảm render thừa, không hạ chất lượng cuối.
