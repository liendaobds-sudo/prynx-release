# NHẬT KÝ SỬA — CHỮ & FONT

**Ngày:** 2026-08-13  
**Audit:** `W7-U08` — `docs/BAO_CAO_AUDIT_CHU_FONT_HIEU_NANG_UIUX_2026-08-13.md`  
**Phạm vi:** identity/cancel, event-loop và planner của luồng quét font/chữ.

## Lô A — độ phản hồi và tính đúng

## Thay đổi

1. `backend/app/api/routes/preflight.py`
   - Đưa `PreflightEngine.run()` của cả `/preflight/inspect` và
     `/preflight/inspect-upload` sang `run_in_threadpool`.
   - Giữ route mỏng để các request khác của sidecar vẫn được phục vụ trong lúc
     PDF đang được đọc.
2. `backend/app/core/preflight_engine.py`
   - Với tập rule chỉ gồm `FONT_NOT_EMBEDDED` và/hoặc `TEXT_DETECTED`, chạy một
     lượt trong process hiện tại thay vì dựng `ProcessPoolExecutor` mới cho PDF
     trên 10 trang.
   - Các tập rule content-stream khác giữ nguyên planner và RAM-gating hiện có.
3. `desktop/src/components/preprocess-tools/FontToolsTool.tsx`
   - Bind `fileId` theo `workspaceDocumentIdentity` và tái sử dụng ID đã có.
   - Thêm generation fence + `AbortController`; hủy upload/inspect/fix/download
     khi tài liệu đổi, unmount hoặc request mới bắt đầu.
   - Chỉ cập nhật report/result và gọi Viewer callback nếu identity còn hiện hành.

## Bằng chứng verify

- Backend `test_preflight_engine.py`: **25 passed**, 1 warning.
- Backend nhóm Preflight/OUTLINE liên quan: **71 passed, 17 skipped**, 2 warnings.
- Frontend `FontToolsTool.test.tsx`: **5 passed**.
- `npm.cmd run typecheck`: đạt.
- `py_compile` các file backend đã sửa: đạt.
- `git diff --check` các file Lô A: đạt.

Benchmark synthetic sau sửa trên PDF có DejaVuSans nhúng (median, 5 lượt):

| Trang | Trước audit (full scan) | Sau sửa font-only | Ghi chú |
|---:|---:|---:|---|
| 15 | 357,19 ms | 27,73 ms | giảm overhead tạo process |
| 50 | 503,73 ms | 104,83 ms | số đo khác corpus/độ nóng cache, chỉ so xu hướng |
| 100 | 770,32 ms | 188,82 ms | vẫn giữ kiểm tra mọi trang |

Probe route 50 trang sau sửa: `90,10 ms`, khoảng hở heartbeat tối đa
`25,92 ms`; không còn khoảng hở xấp xỉ toàn lượt quét như baseline `506,80 ms`.

## Chưa nằm trong Lô A

- Handoff output trực tiếp backend → Viewer: Lô C.
- Batch/session native cho outline và hậu kiểm mọi trang: Lô D.
- Runtime Tauri với PDF khách lớn: cần chạy kiểm tay trên máy người dùng.

## Lô B — đơn giản hóa báo cáo và UI

### Thay đổi

1. `backend/app/core/preflight_rules/fonts.py` + `preflight_engine.py`
   - Giữ ba field cũ `total/embedded/not_embedded` là occurrence theo trang để
     không phá consumer Preflight hiện hữu.
   - Bổ sung `unique_total/unique_embedded/unique_not_embedded` và `fonts[]`;
     mỗi font có trạng thái nhúng, tổng occurrence và danh sách trang.
   - Một font subset dùng trên 100 trang nay báo đúng `unique_total = 1`, nhưng
     vẫn giữ 100 issue/page để Viewer highlight chính xác.
2. `desktop/src/components/preprocess-tools/FontToolsTool.tsx`
   - Tự quét đúng một lần theo `workspaceDocumentIdentity`; báo cáo được cache
     trong WorkspaceContext nên đổi công cụ rồi quay lại không quét lại.
   - Gộp cảnh báo thiếu font theo font và thu gọn danh sách trang; report API cũ
     chưa có field unique vẫn có fallback tương thích.
   - Rút màn hình về ba trạng thái: an toàn; có chữ sống và có thể khóa; thiếu
     font gốc và bị chặn.
   - Thêm thời gian đã chạy, stage quét/outline/hậu kiểm, nút Hủy và Quét lại
     dạng hành động phụ.
4. `backend/app/api/routes/preflight.py`
   - Nối client disconnect của `/preflight/fix` vào task `ActionEngine`; task bị
     cancel sẽ bật token cooperative sẵn có, dừng outline giữa trang/pha hậu kiểm
     và dọn file `.pending`/output thay vì chỉ dừng spinner phía UI.
5. `desktop/src/i18n/locales/vi.json` + `en.json`
   - Bổ sung đầy đủ text VI/EN cho trạng thái, tiến trình, hủy và trang thu gọn.

### Bằng chứng verify

- Backend Preflight/OUTLINE liên quan: **74 passed, 17 skipped**, 2 warning
  deprecation có sẵn.
- Frontend `FontToolsTool.test.tsx`: **10 passed** — gồm cache/remount, auto-scan,
  đổi PDF, hủy, report cũ và một font trên 100 trang.
- `npm.cmd run typecheck`: đạt.
- ESLint hai file `FontToolsTool`: đạt.
- `git diff --check`: đạt.

### Còn mở

- Lô C: bỏ vòng tải file kết quả qua WebView rồi upload ngược lại backend.
- Lô D: batch/session native để giảm số lần mở PDF trong outline/hậu kiểm.
- Runtime Tauri với PDF khách lớn; Lô B hiện đạt bằng chứng tự động, chưa phải
  nghiệm thu UI/runtime trên ứng dụng thật.
