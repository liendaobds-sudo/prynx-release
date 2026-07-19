# Audit thumbnail (ThumbSidebar) — 2026-07-18

**Phạm vi:** dải thumbnail viewer Acrobat
**File chính:**

- `desktop/src/components/acrobat/ThumbSidebar.tsx`
- `desktop/src/components/acrobat/useThumbSidebar.ts`
- `desktop/src/hooks/viewer/useViewerZoom.ts` (viewport indicator + clamp thumb size)
- `desktop/src/hooks/viewer/usePdfLoader.ts` (cache / generateThumb)

**Bối cảnh:** Bug “thumbnail mất nửa phải khi thu gọn panel” đã được vá một phần (clamp `displayThumbBase` + `overflow-x-hidden`). Tài liệu này ghi audit còn lại.

---

## A. Tóm tắt

| Mức | Số | Ghi chú |
|-----|-----|--------|
| **P0** | 0 | Không crash / data-loss rõ |
| **P1** | 2 | Clip panel (đã fix 1 phần); **thumb stale sau edit** |
| **P2** | 5 | Viewport vs xoay; cache key chết; hard cap 1000; resize live; objectFit fill |
| **P3** | 3 | Ctrl+A focus; ghost DnD global; brand strip khi collapse |

Clamp **cắt nửa phải khi thu panel** đã có (`displayThumbBase` trong `ThumbSidebar`) — tốt. Phần dưới là **còn lại**.

---

## B. Findings

### P1

| ID | Vấn đề | Chi tiết | Ảnh hưởng |
|----|--------|----------|-----------|
| **T1** | **Thumbnail không invalidate sau edit/commit** | Render ảnh phụ thuộc `file.path` + zoom. Edit xong path thường **giữ nguyên** → `useEffect` không chạy lại → vẫn blob JPEG cũ. `__editCommit` chỉ giữ load-gate, **không** force re-fetch. | User sửa object/crop/commit → dải thumb **sai nội dung** cho đến khi đóng/mở lại file |
| **T2** | **Clamp fit panel vs `thumbBaseWidth` state lệch** | UI hiển thị `displayThumbBase = min(base, panel)`. State `thumbBaseWidth` có thể vẫn lớn khi panel hẹp → lần mở rộng panel nhảy size; Ctrl+wheel clamp panel nhưng **không** đồng bộ khi chỉ `transition` width (collapse 40px ↔ full). | Flicker / size “nhảy” khi mở lại panel; ít gây clip nếu clamp display còn |

### P2

| ID | Vấn đề | Chi tiết |
|----|--------|----------|
| **T3** | **Viewport indicator lệch khi trang xoay 90°/270°** | Ảnh trong khối `transform: rotate(...)`, overlay indicator nằm trên slot **không xoay**. `updateViewportRect` map % theo page main lên slot footprint — **không** bù CSS rotate của thumb. | Minimap pan trên thumb **xoay** dễ lệch |
| **T4** | **Cache key “chết” trên Tauri** | `thumbCacheRef.get(\`${pdfUrl}_${page}_0_400\`)` gần như không khớp render IPC (zoom động). Branch cache pdfjs (`generateThumb`) **bỏ qua** khi có `file.path`. | Dead code / confuse; không bust cache khi cần |
| **T5** | **Hard hide thumb sau trang 1000** | `pageOrder.slice(0, 1000)` + message ẩn phần còn lại. | File >1000 trang: thumb/reorder/marquee **không** cover trang sau |
| **T6** | **`objectFit: 'fill'`** | Ép fill khung; nếu `localDim` sai (fallback 1.414) → **méo** ảnh đến khi dims về. | Thumb méo tạm / lâu nếu dim fail |
| **T7** | **Resize live chỉ đổi `style.width`, React width state trễ** | Khi kéo handle, `displayThumbBase` đọc `thumbWidth` **store** (chưa update) → trong lúc kéo vẫn size cũ; chỉ clamp sau mouseup. | Trong lúc kéo: vẫn có thể clip cho đến khi thả chuột |

### P3

| ID | Vấn đề |
|----|--------|
| **T8** | Ctrl+A select-all chỉ khi `sidebarRef` contains focus — click thumb có focus nhưng dễ miss |
| **T9** | Ghost DnD / marquee `querySelectorAll('.acro-thumb-item')` global — multi-tab có thể chạm item tab khác (hiếm, tab ẩn) |
| **T10** | Collapse full (40px) chỉ hiện `PrintSolutions.vn` dọc — by design; dễ hiểu nhầm “thumb hỏng” nếu user kỳ vọng mini-strip trang |

---

## C. Đã ổn / đã harden

| Hạng mục | Ghi chú |
|----------|---------|
| Clamp `displayThumbBase` + `overflow-x-hidden` | Chống clip nửa phải khi thu hẹp panel |
| Ctrl+wheel clamp theo `clientWidth` panel | Không phóng to thumb quá panel |
| Event `prynx-thumb-panel-resized` | Clamp state `thumbBaseWidth` sau resize |
| Lazy load + gate main-tile-first | Giảm tranh pdfium với trang chính |
| Memo so `localDim` / `thumbBaseWidth` | Tránh kẹt ratio fallback A4 1.414 |
| DnD pointer-capture + Alt-copy + cross-file drop | Reorder / copy trang |
| Viewport indicator ẩn khi fit full page | Không chặn reorder thumb |
| Page order 1-based | Khớp `render_pdf_page` IPC |
| Min panel resize 160px | Cho phép thu hẹp hơn min cũ 260 |

### Code tham chiếu (clamp fit)

```ts
// ThumbSidebar.tsx — ý chính
const THUMB_H_PAD = 52;
const maxFootprintW = Math.max(48, thumbWidth - THUMB_H_PAD);
const fittedThumbBase = Math.min(
  thumbBaseWidth,
  Math.floor(maxFootprintW * 0.72), // an toàn portrait sau xoay 90°
);
const displayThumbBase = Math.max(40, fittedThumbBase);
// … truyền displayThumbBase vào MemoThumbItem
```

---

## D. Ma trận kịch bản

| Kịch bản | Trạng thái |
|----------|------------|
| Thu hẹp panel / clip nửa phải | **Đã fix** (display clamp); lúc **đang kéo** resize còn P2 **T7** |
| Ctrl+wheel phóng to thumb | **Đã clamp** |
| Collapse hẳn 40px | Brand strip — **đúng thiết kế** |
| Edit PDF → thumb cập nhật | **P1 T1** — dễ stale |
| Thumb trang xoay + minimap | **P2 T3** |
| File >1000 trang | **P2 T5** |
| Multi-tab thumb render | IPC sem ~4; OK; ghost/marquee global = P3 |

---

## E. Ưu tiên fix (backlog)

1. **T1 (P1):** Bust thumb khi commit — `thumbRev` / `file.mtime` / `__editCommit` token trong deps `useEffect` + `URL.revokeObjectURL` + re-invoke `render_pdf_page`.
2. **T7 (P2):** Khi `mousemove` resize, đọc `sidebarEl.clientWidth` cho clamp live (không chỉ store).
3. **T3 (P2):** Indicator map theo khối đã rotate, hoặc bake rotation vào bitmap thumb.
4. **T5 (P2):** Virtualize full list thay vì cap 1000 (nếu cần catalog lớn).
5. **T4 / T6 (P2/P3):** Dọn cache key chết; cân `objectFit: 'contain'` khi dim chưa có.

---

## F. Kết luận

- **Clip khi thu panel:** đã xử lý phần lớn; còn **clip tạm lúc kéo resize** và **state/base lệch**.
- Lỗi **đáng làm tiếp nhất:** **thumbnail không refresh sau edit** (**T1**).
- Không thấy **P0** crash riêng thumb; DnD/select **chắc** hơn viewport/rotation/cache.

**Go / No-Go ship thumb hiện tại:** **GO có điều kiện** — OK cho luồng xem/reorder thường; **No-Go “perfect parity Acrobat”** nếu edit-in-viewer + minimap trên trang xoay là critical.

---

## G. Lịch sử liên quan

| Ngày | Việc |
|------|------|
| 2026-07-18 | Fix clip nửa phải: `displayThumbBase`, overflow-x-hidden, clamp wheel/resize event |
| 2026-07-18 | Audit này ghi backlog T1–T10 |

---

*File audit: `docs/audit/THUMBNAIL_AUDIT_2026-07-18.md`*
