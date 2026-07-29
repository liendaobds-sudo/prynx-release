# NHẬT KÝ SỬA — ĐỘ NÉT & TỐC ĐỘ LÀM NÉT (audit 2026-07-28)

Báo cáo gốc: `docs/BAO_CAO_AUDIT_DO_NET_RENDER_2026-07-28.md` (§R.1–§R.12).
Tag truy vết: `PERF (audit độ nét 2026-07-28 §R.x)` và `NÉT (audit độ nét 2026-07-28 §R.x)`.
Trạng thái: **đã áp Lô 1 (§R.1) + Lô 2 (§R.4). Các mục khác chưa làm — xem mục "Chưa làm và vì sao".**
File đã sửa: **1** — `desktop/src/components/workspace/LivePageFrame.tsx`. Không chạm Rust.

---

## Lô 2 — Nét 1:1 pixel (§R.4)

**Nguyên nhân.** Bitmap nền do Rust tạo rộng `(width_pt * render_scale) as i32` — **cắt** thập phân
(`lib.rs:684`), còn khung CSS là `Math.ceil(displayWidth)` (`LivePageFrame.tsx:2616`) và thẻ `<img>`
dùng `width:100%; height:100%; objectFit:'fill'`. Lệch ≤1px là đủ để tỉ lệ scale ≠ 1.0 → browser
resample bilinear **toàn bộ trang** → chữ mềm ở **mọi** mức zoom, không riêng zoom cao.

**Cách sửa.** Thêm `applyExactFit()` trong `LiveTile`, gọi từ `onLoad` của `<img>`:

```
bitmap ≈ khung (±2 device px)  →  vẽ ĐÚNG kích thước gốc: style.width = naturalWidth / dpr
bitmap nhỏ hơn nhiều (zoom cao, renderZoom bị cap)  →  giữ 100%/100% như cũ (phải giãn để phủ kín)
```

Vì sao thiết kế như vậy:

- **Không đổi hệ toạ độ.** Overlay (thước, guide, số đo DIM, chỉnh sửa đối tượng, VDP) neo theo
  KHUNG trang chứ không theo `<img>`, nên đổi kích thước vẽ của ảnh không xê dịch bất cứ thứ gì.
  Đây là lý do chọn hướng này thay vì sửa `displayWidth/displayHeight`.
- **Tự thoái lui an toàn.** Không khớp trong ngưỡng ±2px thì rơi về đúng hành vi hôm nay, không
  có đường nào tệ hơn trước.
- **Không cần đổi Rust, không đổi chữ ký IPC, không tốn thêm một millisecond render nào.**
- Đặt `background:'white'` cho khung tile: khi snap, bitmap có thể hụt ≤2px → chừa sợi mảnh ở mép
  phải/dưới; nền trắng làm nó vô hình trên trang PDF (PDFium render `clear_color = WHITE`), thay vì
  hở ra nền skeleton xám.
- `onLoad` bao **mọi** đường vào (tải mới, khôi phục từ cache, pixel rỗng ban đầu) nên chỉ cần một
  chỗ duy nhất, không phải rải logic ở 3 nhánh set `src`.

**Đúng ở cả hai loại tile.** Tile sắc của `TileLayer` vốn đã khớp (`cssW = clipW / dpr`, bitmap =
`set_fixed_size(clipW)`) → `|bw − wantW| = 0` → snap ra đúng kích thước cũ, không đổi gì. Tile nền
ở zoom thường (renderZoom == zoom) là chỗ được sửa thật.

### fix-verify — hồi quy "zoom nhanh thấy trang bị bóp méo rồi nhảy lại"

**User báo ngay sau khi áp Lô 2.** Bản đầu chỉ đặt px tuyệt đối trong `onLoad` mà không có đường
trả về, nên px đó **kẹt lại** ở hai tình huống:

1. **Zoom đang chuyển:** khung trang đã phình theo zoom mới nhưng tile mới chưa về → ảnh giữ px cũ →
   nội dung như bị bóp trong khung trắng, xong mới nhảy lại. Đây là cái user thấy.
2. **Zoom cao (nghiêm trọng hơn, kẹt vĩnh viễn):** `renderZoom` bị chặn bởi `capByBudget` nên tham số
   tile **không đổi** khi zoom tiếp → không có lần load mới → `onLoad` không bao giờ chạy lại → ảnh
   đứng nguyên px cũ trong khi khung tiếp tục lớn.

**Sửa:** thêm `useLayoutEffect` phụ thuộc `[cssW, cssH, clipW, clipH]` — trả `width/height` về
`100%` **ngay khi khung đổi kích thước**, tức khôi phục hành vi giãn-theo-khung như trước trong suốt
thời gian chờ. Khi tile khớp load xong thì `onLoad` snap lại 1:1. Dùng `useLayoutEffect` (chạy trước
khi browser vẽ) nên không thấy nháy.

Bài học: khi thay một thuộc tính *tương đối* (`100%`) bằng *tuyệt đối* (px), phải luôn có đường trả
về cho mọi trạng thái mà giá trị tuyệt đối không còn đúng — không chỉ đường "khi dữ liệu mới về".

---

## Lô 1 — Bỏ 8 bản render không ai xem (§R.1)

**Nguyên nhân.** Virtuoso giữ ~9 trang mounted. `LiveTile` gọi `_loadTile()` **đồng bộ ngay trong
effect**, cố tình bỏ qua IntersectionObserver (`:299-306` — bản sửa lỗi màn trắng khi WebView2 bị
occluded). Tile nền **không** được gate `isActiveFrame` (trong khi `needsTiling` thì đã gate từ đợt
trước), nên cả 9 trang đều xin render nền ở `renderZoom` hiện tại; ở zoom cao mỗi bản có cạnh dài
tới 6000px. Mọi render PDFium đi tuần tự sau `RENDER_LOCK` → tile sắc của vùng đang nhìn xếp hàng
sau 8 bản vô ích.

**Cách sửa.** Trần zoom cho nền của trang KHÔNG active:

```ts
const BG_IDLE_ZOOM_CAP = 2;
const bgZoom = isActiveFrame ? S : Math.min(S, BG_IDLE_ZOOM_CAP * dpr);
```

Phạm vi ảnh hưởng bị chặn rõ ràng, đây là điểm quan trọng khi nghiệm thu:

- Vì dùng `Math.min`, trần chỉ **có tác dụng khi zoom > ~200%**. Ở fit-width / 100% thì `renderZoom`
  đã ≤ 2×dpr nên **không có gì thay đổi so với trước**.
- Trang đang xem **giữ nguyên** `renderZoom` — không hạ chất lượng chỗ mắt đang nhìn.
- **Cố tình KHÔNG chạm** lối gọi `_loadTile()` đồng bộ. Nó là bản sửa lỗi màn trắng; đổi sang để
  IntersectionObserver quyết định sẽ làm lỗi đó quay lại khi cuộn nhanh. Hạ zoom cho trang nền là
  đủ đạt mục tiêu (render rẻ → hàng đợi thoát nhanh) mà không đụng vào bản sửa cũ.
- **Đánh đổi duy nhất:** xem 2 trang cạnh nhau ở zoom > 200% thì trang không active nét bằng nửa
  cho tới khi cuộn sang (thành active → render lại đủ nét).

---

## Lô 4a — Thumbnail theo HiDPI (§R.7) + phát hiện thêm §R.13

**File:** `desktop/src/components/acrobat/ThumbSidebar.tsx`. Thuần TS, không chạm Rust, không xoá cache tile.

### Đính chính báo cáo: §R.7 bị tôi mô tả SAI

Báo cáo viết "*thumbnail render 1× rồi bị phóng*". **Không đúng.** Tính lại đầy đủ:
`optimalZoom = thumbBaseWidth × 1.3 / baseW`, và Rust tạo bitmap rộng `width_pt × (96/72) × zoom`.
Vì `baseW = localDim.w = width_pt × (96/72)`, hai thừa số triệt tiêu → **bitmap = thumbBaseWidth × 1.3**.
Tức đang có oversample **1.3×**, không phải 1×.

Hệ quả đúng của con số 1.3:

| dpr (Windows scale) | Cần | Có | Kết luận |
|---|---|---|---|
| 1.0 (100%) | 1.0× | 1.3× | dư 30% → render thừa pixel |
| 1.25 (125%) | 1.25× | 1.3× | vừa đủ |
| **1.5 (150%)** | 1.5× | 1.3× | **thiếu 13% → mờ** |
| **2.0 (200%)** | 2.0× | 1.3× | **thiếu 35% → mờ rõ** |

Nên §R.7 **vẫn là lỗi thật** nhưng chỉ từ scale 150% trở lên, không phải "mọi màn HiDPI" như tôi viết.
Đồng thời một lo ngại khác trong báo cáo là **sai**: trần `Math.min(1.5, …)` thực tế **chưa bao giờ
chạm** (cần `thumbBaseWidth > 915px` mới chạm, mà clamp panel là 50–400px).

### Cách sửa

Thay hệ số ma thuật bằng "xin đúng số pixel muốn có":

```ts
const wantThumbPx = Math.min(1400, Math.ceil(thumbBaseWidth * dpr * 1.15));
const optimalZoom = Math.max(0.1, wantThumbPx / baseW);   // bitmap ≈ wantThumbPx
```

- Đúng ở mọi dpr; 15% dư để chịu sai số làm tròn của `objectFit:'contain'`.
- Trần đặt theo **pixel thật** (chi phí render tỉ lệ với pixel) thay vì theo hệ số zoom.
- **Đánh đổi có ý thức:** ở dpr = 1 số pixel **giảm** (1.3× → 1.15×). Thumbnail xếp hàng cùng
  `RENDER_LOCK` với trang chính nên bớt pixel là bớt tranh chấp — lợi kép. Mất mát thị giác ở
  dpr = 1 không đáng kể vì thumbnail không phải mặt để đọc chữ.
- Sửa luôn `baseW` fallback `595` (point) → `595 × 96/72` (px@96) cho đúng đơn vị. Trước đây khi
  dims chưa về, `optimalZoom` lệch 1.333× **và** sinh `cacheKey` khác bản sau khi dims về → cùng
  một thumbnail bị render **hai lần**.

### §R.13 (mới, P2) — tooltip kích thước trang SAI 1.333×

Phát hiện khi làm §R.7, cùng file, gốc cùng một nhầm lẫn đơn vị:

```ts
const dimW = localDim ? (localDim.w * 25.4 / 72).toFixed(1) : 0;   // SAI: .w là px@96
```

`localDim.w/h` do `usePdfLoader` dựng bằng `widthPt * 96/72` nên là **px@96**; chia 72 làm số mm
phồng lên 1.333×. **Hover thumbnail một trang A4 đang hiện "280.0 × 396.0 mm" thay vì
"210.0 × 297.0 mm".** Với phần mềm chế bản thì đây là con số không được phép sai.

Đã sửa thành `× 25.4 / 96`, cùng quy ước với `StatusBar` (`PX_TO_MM = 25.4 / 96`) — chỗ đó vốn đã đúng.

---

## Lô 4b — `previewQuality` từ nút chết thành nút thật (§R.9)

**File:** `desktop/src/components/workspace/LivePageFrame.tsx` + test mới
`src/components/workspace/computeRenderZoom.test.ts`. Thuần TS, không chạm Rust, không xoá cache.

**Vấn đề.** Cài đặt "Chất lượng xem trước" ('high' | 'fast') có UI radio, có mô tả, được persist —
nhưng **không một đường render nào đọc nó**. Người dùng đổi và không có gì xảy ra.

**Cách nối.** Trần ngân sách pixel trước đây là hằng `6000` **cứng bên trong**
`computeRenderZoomPure`. Nay thành tham số:

```ts
export const RENDER_BUDGET_PX = { high: 6000, fast: 3000 } as const;
computeRenderZoomPure(z, actualWidth100, pageDimW, pageDimH, budgetPx = RENDER_BUDGET_PX.high)
```

- `'fast'` → cạnh dài bitmap nền giảm 2× ⇒ **số pixel giảm ~4×** ở zoom cao (chi phí render tỉ lệ
  với pixel). Đây đúng là chỗ đắt nhất mà §R.1 đã chỉ ra.
- **Zoom thấp không bị ảnh hưởng** — ở zoom ≤ ~2.6× thì `target` nhỏ hơn cả trần 'fast' nên hai chế
  độ cho kết quả y nhau. Nghĩa là chọn 'fast' không làm mờ lúc xem bình thường, chỉ giới hạn khi
  zoom sâu. Có test chốt điều này.
- Tile sắc của `TileLayer` (bị chặn riêng bởi `TILE_MAX = 4000`) **không** bị hạ → zoom sâu vẫn nét
  ở vùng đang nhìn, chỉ nền quanh nó thô hơn.
- **Tuân thủ nguyên tắc hiệu năng của dự án** (`prynx-performance`): mặc định vẫn `'high'` = 6000,
  máy mạnh không bị hạ gì. Chỉ giảm khi người dùng **chủ động chọn** — đây là escape hatch, không
  phải cap vô điều kiện.
- Thêm `renderBudgetPx` vào deps của effect debounce để đổi cài đặt áp **ngay**, không phải chờ lần
  zoom kế tiếp.
- Đọc store bằng **selector một trường** (`s => s.previewQuality`), không subscribe cả store — theo
  đúng bài học §4.4 của đợt audit hiệu năng trước.

**Test mới (6 case).** Chốt các bất biến mà trước đây không có gì canh: cạnh dài ≤ ngân sách ở cả
'high' và 'fast'; `fast ≈ high / 2`; zoom thấp hai chế độ bằng nhau; sàn `devicePixelRatio`; trần
cứng 24× với trang rất nhỏ; trang **ngang** cũng tôn trọng ngân sách (đây chính là nghi vấn tôi từng
tưởng là bug rồi loại sau khi tính lại — nay có test giữ kết luận đó).

**Lưu ý còn treo:** chuỗi mô tả trong Cài đặt ("*Giảm chất lượng render để xem trước PDF hàng ngàn
trang siêu mượt mà*") nói theo hướng SỐ TRANG, còn tác dụng thật là hạ **độ phân giải khi zoom sâu**.
Chưa sửa chữ để tránh trộn việc; nên sửa khi có dịp chạm i18n.

---

## Chưa làm và vì sao (khác kế hoạch trong báo cáo)

| Mục | Kế hoạch | Thực tế | Lý do |
|---|---|---|---|
| §R.12 | Chuyển sàn `dpr` vào trong `Math.min` để không phá trần ngân sách 6000px | **Không làm** | Hành vi hiện tại cho bitmap **lớn hơn** → **nét hơn**, và RAM đã được `max_dim = 8000` của Rust chặn. Sửa theo kế hoạch sẽ làm khổ rất lớn **mờ đi** để đổi lấy một lo ngại RAM đã có người canh. Đây là audit độ nét — không đánh đổi ngược hướng. |
| §R.3 | Nối `getTileUrl` vào `processTileQueue` để có cơ chế huỷ tile lỗi thời | **Không làm** | Xét lại thì với debounce 180ms, số render lỗi thời thực sự được **gửi đi** là ít; và FE đã loại kết quả lỗi thời (`loadedParamsRef` guard). Rewire có rủi ro thật: hàng đợi resolve item bị huỷ bằng `''` → `LiveTile` sẽ set `src=''`. Đổi lấy lợi ích nhỏ, không đáng làm mù. **Cần log đo trước** (xem mục dưới) rồi mới quyết. Tôi hạ §R.3 từ P1 xuống P2. |
| §R.5 | A/B LCD subpixel text | **Không làm** | Cần ảnh chụp A/B như đã hẹn — sửa mù có thể làm chữ tệ hơn. |
| §R.6 | Tile sắc dùng PNG hoặc q96-98 thay q90 | Chưa (Lô 3) | Đây là mục xoá khác biệt chất lượng cuối cùng so với Acrobat, nên làm kế tiếp. |
| §R.7 | Thumbnail HiDPI | **ĐÃ LÀM** (Lô 4a) | Kèm đính chính: báo cáo mô tả sai mức độ (1.3× chứ không phải 1×). |
| §R.13 | — (phát hiện mới) | **ĐÃ LÀM** (Lô 4a) | Tooltip kích thước trang sai 1.333×. |
| §R.9 | `previewQuality` là nút chết | **ĐÃ LÀM** (Lô 4b) | Nối vào trần ngân sách pixel + 6 test chốt bất biến. |
| §R.8, §R.10, §R.11 | Ẩn tile lúc zoom, coarse→sharp, prefetch | Chưa (Lô 5) | |

---

## Kết quả verify

| Hạng mục | Lệnh | Kết quả |
|---|---|---|
| TS types | `npm run typecheck` | **PASS** — 0 lỗi |
| Test component + hook | `npx vitest run src/components src/hooks` | **PASS** 32 file / 239 test |
| Toàn bộ component + hook + lib | `npx vitest run src/components src/hooks src/lib` | **PASS** 128 file / 1155 test, 2 skip |
| Lint phạm vi sửa | `npx eslint src/components/workspace/LivePageFrame.tsx` | Không thêm vấn đề mới. `applyExactFit` (useCallback, deps đủ) sạch. Cảnh báo "Cannot access refs during render" ở dòng khung tile là **có từ trước** (`opacity: hasLoadedOnce.current`), tôi chỉ thêm `background:'white'` vào cùng dòng nên rule chỉ vào đó. |
| Sau fix-verify | `npm run typecheck` + `npx vitest run src/components src/hooks` | **PASS** — 0 lỗi type, 32 file / 239 test |
| Chạy thật trên máy | user thao tác zoom nhanh/chậm sau fix-verify | **USER XÁC NHẬN OK** (2026-07-28) — hết hiện tượng bóp méo/nhảy tỉ lệ |
| Sau Lô 4a (§R.7 + §R.13) | `npm run typecheck` + `npx vitest run src/components src/hooks` | **PASS** — 0 lỗi type, 32 file / 239 test |
| Sau Lô 4b (§R.9) | `npm run typecheck` + `npx vitest run src/components src/hooks` | **PASS** — 0 lỗi type, **33 file / 245 test** (thêm 6 test mới) |
| Lint file mới | `npx eslint src/components/workspace/computeRenderZoom.test.ts` | **0 vấn đề** |
| Lint ThumbSidebar | `npx eslint src/components/acrobat/ThumbSidebar.tsx` | 16 vấn đề, **tất cả có từ trước** (`any`, unused var, set-state-in-effect); không có vấn đề nào ở vùng tôi sửa |

**Chưa đo runtime.** Hai lô này sửa theo suy luận từ code như đã thống nhất; chưa có số trước/sau.

---

## Cần kiểm tay + đo (đề nghị chạy ngay)

1. `run_dev.bat` → mở PDF nhiều chữ (catalog/bìa sách).
2. **§R.4 — điều đáng thấy nhất:** soi chữ ở **100%**. Trước đợt này chữ đã bị resample nhẹ ở mọi
   mức zoom; giờ phải nét hơn rõ **mà không cần chờ gì**. So với Acrobat cùng file cùng zoom.
3. **§R.1:** zoom 400-800%, so cảm giác thời gian từ lúc thả chuột tới lúc chữ nét — phải nhanh hơn
   trước rõ rệt.
4. **Đánh đổi cần soi:** chuyển sang chế độ **Xem hai trang / Cuộn hai trang**, zoom > 200% → trang
   không active sẽ nét bằng nửa. Nếu bạn thấy khó chịu, nói tôi nâng `BG_IDLE_ZOOM_CAP` hoặc cho
   trang kề trang active cũng được full.
5. **Không được có:** mảng trắng/sợi xám ở mép phải hoặc mép dưới trang ở bất kỳ mức zoom nào
   (đây là rủi ro chính của cách snap 1:1 — nếu thấy, gửi tôi ảnh chụp kèm mức zoom và scale màn hình).
6. Gửi `PrynX_RenderPerf.log` trên Desktop sau khi zoom 100% → 400% → 800%. Cần nó để: (a) chứng
   minh số bản render `kind=page` mỗi lần zoom đã giảm, (b) quyết định §R.3 và §R.2 có đáng làm không.
