# Audit thumbnail (ThumbSidebar) — 2026-07-18

**Phạm vi:** dải thumbnail viewer Acrobat  
**File chính:**

- `desktop/src/components/acrobat/ThumbSidebar.tsx`
- `desktop/src/components/acrobat/useThumbSidebar.ts`
- `desktop/src/hooks/viewer/useViewerZoom.ts` (viewport indicator + clamp thumb size)
- `desktop/src/hooks/viewer/usePdfLoader.ts` (cache / generateThumb)

**Bối cảnh:** Bug “thumbnail mất nửa phải khi thu gọn panel” đã được vá một phần (clamp `displayThumbBase` + `overflow-x-hidden`). Tài liệu này ghi audit còn lại + **trạng thái fix sau xác minh 2026-07-20**.

---

## A. Tóm tắt

| Mức | Số ban đầu | Sau fix 2026-07-20 |
|-----|------------|---------------------|
| **P0** | 0 | 0 |
| **P1** | 2 | **0** (T1, T2 đã xử lý) |
| **P2** | 5 | **1** (T5 cap 1000 còn lại; T3/T4/T6/T7 đã xử lý) |
| **P3** | 3 | **1** (T10 by design; T8/T9 đã harden) |

Clamp **cắt nửa phải khi thu panel** đã có (`displayThumbBase` trong `ThumbSidebar`) — tốt.

---

## B. Findings

### P1

| ID | Vấn đề | Trạng thái | Fix |
|----|--------|------------|-----|
| **T1** | Thumbnail không invalidate sau edit/commit | **FIXED 2026-07-20** | `thumbRev` (= `pdfUrl`) trong deps `useEffect` + query `?r=` trên tile URL + memo compare `thumbRev` → revoke blob + re-invoke `render_pdf_page` khi commit đổi pdfUrl dù path giữ nguyên |
| **T2** | Clamp fit panel vs `thumbBaseWidth` state lệch | **FIXED 2026-07-20** | `livePanelWidth` khi kéo resize; `prynx-thumb-panel-resized` fire live (rAF) → clamp `thumbBaseWidth` + `displayThumbBase` theo panel đang kéo |

### P2

| ID | Vấn đề | Trạng thái | Fix / ghi chú |
|----|--------|------------|----------------|
| **T3** | Viewport indicator lệch khi trang xoay 90°/270° | **FIXED 2026-07-20** | Indicator trên footprint slot; main page query footprint (`.group/pdf-frame`); drag scale theo `[data-thumb-footprint]` không theo `<img>` trong khối CSS-rotate |
| **T4** | Cache key “chết” `_0_400` | **FIXED 2026-07-20** | Key = `` `${rev}_${page}_0_${zoomMilli}` ``; `generateThumb` (web) khớp công thức zoom; Tauri vẫn IPC |
| **T5** | Hard hide thumb sau trang 1000 | **OPEN** | `pageOrder.slice(0, 1000)` — virtualize full list nếu catalog lớn là critical |
| **T6** | `objectFit: 'fill'` méo khi dim fallback | **FIXED 2026-07-20** | `contain` khi chưa có `localDim`; `fill` khi đã có dim |
| **T7** | Resize live chỉ đổi style.width | **FIXED 2026-07-20** | `livePanelWidth` state + clamp live qua event |

### P3

| ID | Vấn đề | Trạng thái |
|----|--------|------------|
| **T8** | Ctrl+A select-all chỉ khi focus sidebar | **FIXED 2026-07-20** — focus trong sidebar **hoặc** `:hover` sidebar |
| **T9** | Marquee `querySelectorAll` global | **FIXED 2026-07-20** — scope `sidebarRef.current` |
| **T10** | Collapse full (40px) brand strip | **By design** — `PrintSolutions.vn` dọc |

---

## C. Đã ổn / đã harden

| Hạng mục | Ghi chú |
|----------|---------|
| Clamp `displayThumbBase` + `overflow-x-hidden` | Chống clip nửa phải khi thu hẹp panel |
| Ctrl+wheel clamp theo `clientWidth` panel | Không phóng to thumb quá panel |
| Event `prynx-thumb-panel-resized` | Clamp state `thumbBaseWidth` sau resize **và lúc kéo** |
| Lazy load + gate main-tile-first | Giảm tranh pdfium với trang chính |
| Memo so `localDim` / `thumbBaseWidth` / `thumbRev` | Tránh kẹt ratio fallback; bust sau edit |
| DnD pointer-capture + Alt-copy + cross-file drop | Reorder / copy trang |
| Viewport indicator ẩn khi fit full page | Không chặn reorder thumb |
| Page order 1-based | Khớp `render_pdf_page` IPC |
| Min panel resize 160px | Cho phép thu hẹp hơn min cũ 260 |
| **thumbRev bust sau edit** | pdfUrl trong deps + tile `?r=` |
| **livePanelWidth lúc kéo** | Clamp display + base width live |

### Code tham chiếu (clamp fit + bust)

```ts
// ThumbSidebar.tsx — ý chính
const panelWidthForClamp = livePanelWidth ?? thumbWidth;
const THUMB_H_PAD = 52;
const maxFootprintW = Math.max(48, panelWidthForClamp - THUMB_H_PAD);
const fittedThumbBase = Math.min(
  thumbBaseWidth,
  Math.floor(maxFootprintW * 0.72),
);
const displayThumbBase = Math.max(40, fittedThumbBase);
const thumbRev = pdfUrl || '';
// MemoThumbItem: useEffect deps include thumbRev; tile URL ?r=thumbRev
```

---

## D. Ma trận kịch bản

| Kịch bản | Trạng thái |
|----------|------------|
| Thu hẹp panel / clip nửa phải | **Đã fix** (display clamp) |
| Lúc **đang kéo** resize | **Đã fix** (T7 livePanelWidth) |
| Ctrl+wheel phóng to thumb | **Đã clamp** |
| Collapse hẳn 40px | Brand strip — **đúng thiết kế** |
| Edit PDF → thumb cập nhật | **Đã fix** (T1 thumbRev) |
| Thumb trang xoay + minimap | **Đã harden** (T3 footprint) |
| File >1000 trang | **P2 T5** còn open |
| Multi-tab marquee | **Đã scope** sidebar (T9) |

---

## E. Ưu tiên fix (backlog còn lại)

1. ~~**T1 (P1):** Bust thumb khi commit~~ ✅
2. ~~**T7 (P2):** Clamp live khi mousemove resize~~ ✅
3. ~~**T3 (P2):** Indicator / drag theo footprint~~ ✅
4. **T5 (P2):** Virtualize full list thay vì cap 1000 (nếu cần catalog lớn).
5. ~~**T4 / T6:** Cache key + objectFit~~ ✅

---

## F. Kết luận

- **Clip khi thu panel / kéo resize:** đã xử lý (display clamp + livePanelWidth).
- **Thumbnail refresh sau edit:** đã xử lý qua `thumbRev`/`pdfUrl`.
- **Còn lại đáng chú ý:** **T5** hard cap 1000 trang (hiếm với catalog in ấn thường).
- Không thấy **P0** crash riêng thumb.

**Go / No-Go ship thumb hiện tại:** **GO** cho luồng xem / reorder / edit-in-viewer thường. Virtualize >1000 trang chỉ cần nếu catalog lớn là critical.

---

## G. Lịch sử liên quan

| Ngày | Việc |
|------|------|
| 2026-07-18 | Fix clip nửa phải: `displayThumbBase`, overflow-x-hidden, clamp wheel/resize event |
| 2026-07-18 | Audit này ghi backlog T1–T10 |
| 2026-07-20 | Xác minh code: T1–T10 vẫn open |
| 2026-07-20 | Fix T1, T2, T3, T4, T6, T7, T8, T9; cập nhật audit |

---

*File audit: `docs/audit/THUMBNAIL_AUDIT_2026-07-18.md`*
