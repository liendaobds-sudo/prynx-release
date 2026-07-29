# Cách ly: chuỗi Ghostscript viewer preview (GS-SUNSET)

**Ngày:** 2026-07-28
**Trạng thái:** ĐÃ RÚT KHỎI ĐƯỜNG CHẠY, **CHƯA XOÁ**.

Thư mục này giữ code đã chết nhưng chưa muốn xoá hẳn. Cấu trúc bên trong **giữ nguyên
đường dẫn gốc** để phục hồi chỉ là một lệnh `git mv` ngược lại.

---

## Vì sao chết

Ghostscript đã bị khai tử khỏi PrynX (PPE thay thế). Ba chốt độc lập khiến GS **không
thể chạy** ở dev, test hay release:

| Chốt | Nơi |
|---|---|
| `GHOSTSCRIPT_PATH` bị ép về chuỗi rỗng **sau** khi đọc mọi nguồn cấu hình | `backend/app/config.py` — `Settings.model_post_init` |
| Mọi lệnh trông giống GS bị ném `GhostscriptUnavailable` **vô điều kiện** | `backend/app/utils/subprocess_utils.py` — `_guard_ghostscript` |
| `$BUNDLE_GS = $false` gõ cứng, build **abort** nếu bất biến bị vi phạm | `build_production.ps1` |

Các gate này có test bảo vệ: `backend/tests/test_no_ghostscript_survival.py`
(khẳng định `total_gs_calls == 0`), `test_release_no_gs_policy.py`,
`test_gs_usage_telemetry.py`.

Hệ quả với chuỗi này: `viewer_preview.py` gọi GS để dựng ảnh preview tạm, nên nó
**luôn** ném `ViewerPreviewError("Ghostscript is not available")` → route trả HTTP 503
→ frontend lùi về PDFium. Nghĩa là lớp preview tạm đã không hoạt động từ lúc gate
no-GS có hiệu lực.

`docs/PRYNX_GS_REPLACEMENT_ENGINE_PLAN.md` §2.1 cũng ghi độc lập rằng
`app/core/viewer_preview.py` là **"CODE CHẾT"**, `desktop/src/lib/viewerPreview.ts`
không được import ở đâu, và thumbnail đã chuyển sang pdfium từ đợt tối ưu 2026-07-22.

---

## Bằng chứng không còn ai dùng (đo bằng grep, 2026-07-28)

- `fetchViewerPagePreview` và `fetchViewerThumbnailPreview` — hai hàm export duy nhất
  của `viewerPreview.ts` — **chỉ được định nghĩa, không nơi nào gọi**.
- Mọi hit của `viewerPreview` / `viewer-preview` trong `desktop/src` đều nằm **bên
  trong chính file `viewerPreview.ts`**.
- `app/core/viewer_preview.py` chỉ được dùng bởi 3 route trong `imposition.py` và bởi
  `tests/test_viewer_preview.py` — cả hai đều nằm trong chuỗi này.
- Không test backend nào gọi 3 endpoint đó (`Select-String` trên `backend/tests/*.py`
  cho kết quả rỗng).

---

## Nội dung đã cách ly

| File trong attic | Đường dẫn gốc |
|---|---|
| `backend/app/core/viewer_preview.py` | y hệt |
| `backend/tests/test_viewer_preview.py` | y hệt |
| `desktop/src/lib/viewerPreview.ts` | y hệt |
| `backend/app/api/routes/imposition_viewer_preview_routes.py` | **trích** từ `backend/app/api/routes/imposition.py` |

File thứ tư không phải file gốc: 3 route nằm lẫn trong `imposition.py` nên phải cắt ra.
Nó **không** được import ở đâu — chỉ là bản lưu nguyên văn để dán lại nếu cần.

Ba endpoint đã rút:

```
POST /imposition/viewer-preview/page
POST /imposition/viewer-preview/thumbnails
GET  /imposition/viewer-preview/thumbnail/{cache_key}/{page}
```

---

## Cách phục hồi

```powershell
git mv attic/gs-sunset-2026-07-28/backend/app/core/viewer_preview.py      backend/app/core/viewer_preview.py
git mv attic/gs-sunset-2026-07-28/backend/tests/test_viewer_preview.py    backend/tests/test_viewer_preview.py
git mv attic/gs-sunset-2026-07-28/desktop/src/lib/viewerPreview.ts        desktop/src/lib/viewerPreview.ts
```

Rồi dán lại nội dung `imposition_viewer_preview_routes.py` vào `imposition.py` (ngay
trước route `/quick-color-space`). `imposition.py` vẫn còn sẵn `FileResponse` và
`asyncio` nên không cần thêm import.

**Lưu ý:** phục hồi cũng vô ích cho tới khi Ghostscript được cho phép chạy lại, vì
`_guard_ghostscript` chặn ở tầng dưới. Muốn có lại lớp preview tạm thì viết bằng
PPE/pdfium, đừng khôi phục đường GS.

---

## Vì sao đặt ngoài `backend/` và `desktop/src/`

Để không lọt vào bất kỳ đường build hay test nào:

- `backend/pytest.ini` khai `testpaths = tests` → pytest không thu file trong attic.
- `tsconfig.app.json` chỉ gồm `src` → `tsc` không biên dịch.
- vitest chỉ quét `desktop/src` → không chạy.
- Nuitka và `build_production.ps1` đóng gói từ `backend/`, `desktop/` → không gom.

Thư mục **không** bị `.gitignore` (khác `tmp/`) nên vẫn nằm trong version control —
đúng yêu cầu "chưa xoá".
