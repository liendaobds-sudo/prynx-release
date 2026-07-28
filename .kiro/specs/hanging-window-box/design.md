# Design Document

## Overview

Tính năng này hoàn thiện generator `HangingWindowBox.ts` (đang đứt giữa) và đấu nối
`boxType = 'hanging_window'` vào toàn bộ đường chạy khuôn bế của PrynX: engine dispatch →
validate → UI/i18n → 3D → test 4 tầng → golden master → bundle sidecar.

Nguyên tắc thiết kế xuyên suốt: **tái dùng tối đa hợp đồng hình học của Reverse Tuck End**
(`ReverseTuckEnd.ts`) cho thân/nắp/tai bụi/mí dán, và chỉ viết mới hai cụm riêng — cửa sổ
mặt trước và tai treo euro gập đôi trên mặt sau. Không tách helper dùng chung mới cho phần
RTE trong đợt này: RTE có bước `connectCorner` mutate endpoint khá tinh vi, trích xuất chung
sẽ kéo rủi ro hồi quy sang loại hộp đang chạy production. Đổi lại, phần trùng lặp được đánh
dấu `[HANGING-WINDOW 2026-07-27]` kèm ghi chú nguồn gốc để lần sau có cơ sở gộp.

Phát hiện quan trọng làm đơn giản hoá thiết kế: **engine Rust không tự dựng hình học**.
`native/src/dieline_engine.rs` nhúng `ENGINE_PAYLOAD` = bundle TypeScript
(`OUT_DIR/dieline_payload.txt`, sinh từ `npm run build:dieline-sidecar`) và gọi
`__prynxGenerateDieline` bằng Boa. Parity vì thế là hệ quả tự động của việc build lại bundle;
việc còn lại chỉ là bổ sung khoá mới vào fixture request.

## Architecture

### Đường chạy (sau khi hoàn thành)

```
ParamPanel / DielineGallery
        │  setParam('boxType', 'hanging_window')
        ▼
useBoxStore.applyBoxTypeDefaults  ── nạp Preset_Dacdora (L80×W30×D140)
        │  params
        ▼
lib/dieline/api.ts ──HTTP──► backend /dieline ──PyO3──► native/dieline_engine.rs (Boa)
        │                                                      │ chạy bundle TS
        └──────────────── engine.ts generateDieline ◄───────────┘
                 │ validateParams → dispatchGenerator
                 ▼
        HangingWindowBox.generateHangingWindowBox
                 │ DielineModel
                 ├─► DielineCanvas2D (CUT/CREASE + holes)
                 ├─► mockup3d (parent/pivotEdge/foldAngle/foldPhase/renderZShift)
                 └─► productionPDF / nesting
```

### Bảng panel và cây gập

`panelOrder = 'LWLW'`, `glueSide = 'left'` (như mẫu Dacdora):

| Panel | Nhãn | parent | pivotEdge | foldAngle | foldPhase | Ghi chú |
|---|---|---|---|---|---|---|
| `glue_flap` | Mép dán keo | `front` | cạnh trong mí dán | 92 | mặc định | như RTE |
| `front` | Mặt trước | `null` | — | 0 | — | ROOT, có `holes` = cửa sổ |
| `right` | Hông phải | `front` | x3 dọc | −90 | — | |
| `back` | Mặt sau | `right` | x4 dọc | −90 | — | mép trên là CREASE (khác RTE) |
| `left` | Hông trái | `back` | x5 dọc | −90 | — | |
| `dust_top_left/right` | Tai bụi trên | hông tương ứng | cạnh trên hông | 90 | [0.10, 0.40] | như RTE |
| `dust_bot_left/right` | Tai bụi dưới | hông tương ứng | cạnh dưới hông | −90 | [0.10, 0.40] | như RTE |
| `closure_top` | Nắp đậy trên | `front` | y = D + T | 90 | [0.60, 0.95] | như RTE |
| `tuck_top` | Lưỡi gài trên | `closure_top` | y = D + W − T | 92 | [0.75, 0.95] | như RTE |
| `closure_bot` | Nắp đậy dưới | `back` | y = −T | −90 | [0.60, 0.95] | như RTE |
| `tuck_bot` | Lưỡi gài dưới | `closure_bot` | y = −W + T | −92 | [0.75, 0.95] | như RTE |
| `hang_tab_1` | Tai treo lớp 1 | `back` | y = D trên mặt sau | **0** | [0.05, 0.20] | đồng phẳng mặt sau, có Lỗ_Euro |
| `hang_tab_2` | Tai treo lớp 2 | `hang_tab_1` | y = D + tabH (Nếp_Gấp_Chung) | **180** | [0.20, 0.40] | `renderZShift = −(T + 0.1)` |
| `hang_tab_lip` | Lưỡi khoá tai treo | `hang_tab_2` | y = D + tabH + tab2H | **90** | [0.40, 0.55] | gài vào lòng hộp |

`foldAngle = 0` cho `hang_tab_1` là chủ đích: tai treo thật nằm cùng mặt phẳng với mặt sau,
nó chỉ tồn tại như panel riêng để mang Lỗ_Euro và làm gốc gập cho lớp 2.

### Sơ đồ trải phẳng (ghi vào comment đầu generator)

```
                                    [Lưỡi khoá tai treo]      y = D+tabH+tab2H+lipH
                                    [Tai treo lớp 2  ⌷]       y = D+tabH+tab2H
                                    [Tai treo lớp 1  ⌷]       y = D+tabH
   [Lưỡi gài trên]
   [Nắp đậy trên]   [TaiBụi]        [TaiBụi]                  y = D
  ┌──────┬─────────┬───────┬─────────┬───────┐
  │ Keo  │ Trước ▭ │ Hông  │  Sau    │ Hông  │                thân: y ∈ [0, D]
  │ (G)  │  (L)    │ (W)   │  (L)    │ (W)   │
  └──────┴─────────┴───────┴─────────┴───────┘                y = 0
   [TaiBụi]         [TaiBụi]
                    [Nắp đậy dưới]
                    [Lưỡi gài dưới]
```

## Components and Interfaces

### 1. `HangingWindowBox.ts` — viết nốt (giữ nguyên phần đã có)

Đã có, không sửa: `HangingWindowDims`, `hangingWindowDims()`, `buildRoundedWindow()`,
`buildEuroSlot()`, khối A (toạ độ cột), B (thân), C (tai bụi).

Bổ sung `hasWindow` phải tính thêm công tắc:

```ts
// [HANGING-WINDOW 2026-07-27] Cửa sổ chỉ dựng khi người dùng BẬT và hộp đủ lớn.
const hasWindow = params.hgbWindow && winW >= 10 && winH >= 10;
```

Viết mới, theo thứ tự trong file:

```ts
// D. CỬA SỔ MẶT TRƯỚC
function buildFrontWindow(dims, xFrontL, xFrontR, yBot, yTop): {
    paths: PathSegment[]; hole: Point2D[];
}
// E. NẮP ĐẬY + LƯỠI GÀI (trên mặt trước, dưới mặt sau) — theo khuôn RTE
// F. TAI TREO EURO GẬP ĐÔI (trên mặt sau)
function buildHangTabLayer(xL, xR, yBase, layerH, slot: {cy, nibDir} | null): {
    paths: PathSegment[]; outline: Point2D[]; holes: Point2D[][];
}
// G. BOUNDING BOX + RETURN DielineModel
```

`standardCode`: `'HANGING-WINDOW'`; `name`: `'Hanging Window Box'`;
`description`: `'Hộp treo có cửa sổ — hàng điện tử, phụ kiện, treo kệ siêu thị'`.

### 2. Hình học cửa sổ

- Tâm cửa sổ = tâm mặt trước: `cx = (xFrontL + xFrontR)/2`, `cy = D/2`.
- Gọi `buildRoundedWindow(cx − winW/2, cy − winH/2, winW, winH, winR)` → 8 đoạn CUT kín.
- Ghi vào `panels[front].holes = [ringFromCutChain(windowPaths)]` để 3D khoét lỗ thật, và
  push toàn bộ đoạn vào `allPaths` để canvas/PDF vẽ.
- `hangingWindowDims()` đã kẹp `winW ≤ L − 2·8mm`, `winH ≤ D − 2·8mm` ⇒ lề an toàn tự thoả.

### 3. Hình học tai treo euro

Toạ độ y (gốc y = 0 tại đáy hộp, tăng lên trên):

```
yTabBase   = D                       ← CREASE mặt sau ↔ lớp 1
yTabMid    = D + tabH                ← Nếp_Gấp_Chung (lớp 1 ↔ lớp 2)
yTabTop    = D + tabH + tab2H        ← CREASE lớp 2 ↔ lưỡi khoá
yLipTop    = yTabTop + lipH
```

Tâm hai Lỗ_Euro — **bất biến sống còn**, đối xứng qua `yTabMid`:

```
cySlot1 = yTabMid − slotPos    (lớp 1, nibDir = +1)
cySlot2 = yTabMid + slotPos    (lớp 2, nibDir = −1)
cxSlot  = (xBackL + xBackR) / 2   (dùng chung cho cả hai lớp)
```

Sau khi lớp 2 gập 180° quanh `yTabMid`, ánh xạ `y ↦ 2·yTabMid − y` biến `cySlot2 → cySlot1`
và lật chiều gờ (`nibDir` −1 ↦ +1) ⇒ hai lỗ trùng khít cả gờ. Đây chính là mệnh đề mà
property test số 3 kiểm bằng cách phản chiếu tập điểm.

Bề rộng: hai lớp và lưỡi khoá đều thụt `h = T/2` mỗi bên so với mặt sau để không đè tai bụi
khi gập (cùng quy ước với `closure_*` của RTE). Lưỡi khoá rộng `lipW` căn giữa, bo góc trên
bằng `buildTuckFlap` để gài trơn vào lòng hộp.

Guard suy biến:
- `hasSlot = false` → dựng tai treo trơn, warning `'Hộp treo: tai treo quá thấp để đặt lỗ treo — đã bỏ lỗ euro. Hãy tăng HTH hoặc chiều cao D.'`
- `hasWindow = false` khi `hgbWindow = true` → warning `'Hộp treo: mặt trước quá nhỏ để mở cửa sổ (cần ≥ 10mm mỗi chiều sau khi chừa lề 8mm) — đã bỏ cửa sổ.'`

### 4. Tham số mới `hgbWindow`

| Tệp | Thay đổi |
|---|---|
| `types.ts` | `hgbWindow: boolean` trong `BoxParams` + doc tiếng Việt; `DEFAULT_PARAMS.hgbWindow = true` |
| `runtimeValidation.ts` | `ENUM_VALUES.boxType` thêm `'hanging_window'`; `hgbWindow` vào nhóm khoá boolean |
| `validateParams.ts` | kẹp `WNW`, `WNH`, `HTH` theo miền của `hangingWindowDims`, cảnh báo khi bị kẹp |
| `native/tests/fixtures/dieline_default_request.json` | thêm `hgbWindow`, `WNW`, `WNH`, `HTH` |

Theo tiền lệ `envWindow` của bì thư (boolean bật/tắt cửa sổ) nên đặt tên theo tiền tố hằng
`HGB_` của loại hộp này: `hgbWindow`.

### 5. Đấu nối UI

- `engine.ts`: `case 'hanging_window': return generateHangingWindowBox(params);`
- `index.ts`: export `generateHangingWindowBox`, `hangingWindowDims`.
- `geometryHelpers.ts`: thêm nhánh diện tích phẳng kỳ vọng (thân RTE + 2 lớp tai treo +
  lưỡi khoá − cửa sổ) để Property 4 của `geometry.test.ts` không bỏ sót loại hộp mới.
- `useBoxStore.applyBoxTypeDefaults`:

```ts
if (value === 'hanging_window') {
    // [HANGING-WINDOW 2026-07-27] Preset mẫu Dacdora: hộp treo hàng điện tử.
    Object.assign(next, { L: 80, W: 30, D: 140, T: 0.5, C: 0.5, G: 15, TH: 15 });
} else if (prev.boxType === 'hanging_window') {
    Object.assign(next, { L: DEFAULT_PARAMS.L, W: DEFAULT_PARAMS.W, D: DEFAULT_PARAMS.D,
        T: DEFAULT_PARAMS.T, C: DEFAULT_PARAMS.C, G: DEFAULT_PARAMS.G, TH: DEFAULT_PARAMS.TH });
}
```

`isStanding` giữ mặc định `true` (hộp đứng như RTE) — không cần thêm vào danh sách loại trừ.

- `ParamPanel.tsx`: cờ `isHangingWindow`; nhóm điều khiển chỉ hiện với loại này — ô tích
  "Cửa sổ mặt trước" (`hgbWindow`), hai thanh trượt "Rộng cửa sổ" (`WNW`, 0–L), "Cao cửa sổ"
  (`WNH`, 0–D) chỉ hiện khi ô tích bật, và "Cao tai treo" (`HTH`, 0–40).
- `DielineGallery.tsx`: thẻ mới "Hộp treo có cửa sổ".
- i18n `vi.json` + `en.json`: khoá `dieline.param:hop_treo_cua_so`, `cua_so_mat_truoc`,
  `rong_cua_so`, `cao_cua_so`, `cao_tai_treo`.

## Data Models

Không thêm kiểu dữ liệu mới ngoài tham số. `DielineModel`/`Panel`/`PathSegment` dùng nguyên.
`HangingWindowDims` đã đủ trường; chỉ thay đổi cách tính `hasWindow` (nhân thêm công tắc).

## Error Handling

- Tham số vô lý → `validateParams` kẹp về miền hợp lệ + warning tiếng Việt (không throw).
- Hình học suy biến (`hasWindow`/`hasSlot` = false) → bỏ chi tiết + warning vào
  `model.warnings`, KHÔNG sinh nét cắt qua mép/nếp gấp.
- Không `console.log` trong generator.
- Cảnh báo hợp nhất qua `attachWarnings` trong `engine.ts` (đã có sẵn, không cần sửa).

## Testing Strategy

| Tầng | Tệp | Nội dung thêm |
|---|---|---|
| Cấu trúc | `generators.test.ts` | describe `generateHangingWindowBox`: đếm panel (bật/tắt cửa sổ, có/không lỗ euro), `parent`/`pivotEdge` của chuỗi tai treo, `renderZShift` âm của lớp 2, `holes` của mặt trước |
| Bất biến riêng | `hangingWindowTab.test.ts` (mới) | phản chiếu Lỗ_Euro lớp 2 qua Nếp_Gấp_Chung ≡ Lỗ_Euro lớp 1 (< 0.01mm); `tab2H = tabH + T`; `slotPos` trong miền cho phép |
| Biên dạng | `contourValidator.test.ts`, `bleedContours.test.ts`, `geometry.test.ts`, `legend.test.ts` | thêm `'hanging_window'` vào `ALL_TYPES` |
| Property | `arbitraries.ts` | arbitrary cho `'hanging_window'` (L 40–200, W 15–80, D 60–300, `hgbWindow` boolean, WNW/WNH/HTH gồm cả 0) |
| Golden | `goldenMaster.test.ts` | case `hanging_window (Hộp treo có cửa sổ)` L80×W30×D140, `-u` một lần |
| Parity | `nativeFixtureParity.test.ts` + fixture | khoá mới có trong fixture; `cargo test` trong `native/` |
| Store | `useBoxStore.test.ts` | preset Dacdora khi chọn loại hộp, trả về mặc định khi đổi loại |

Trình tự verify (theo `prynx-testing`): `npm run typecheck` → `npx vitest run src/lib/dieline`
→ `npx vitest run src/store` → `cargo check` trong `native/` → `npm run build:dieline-sidecar`
+ `npm run check:dieline-webview` → kiểm tay 2D/3D trong `run_dev.bat`.

## Design Decisions and Rationale

1. **Không port Rust.** Đã xác minh Native_Engine chạy bundle TS qua Boa. Port tay sẽ tạo
   hai nguồn sự thật hình học — đúng cái mà `audit-rules.md` §6 xếp là nhóm lỗi đắt nhất.
2. **`hang_tab_1` là panel riêng dù đồng phẳng mặt sau.** Cần một panel để mang Lỗ_Euro
   trong `holes` và làm `parent` có `pivotEdge` thật cho lớp 2 gập 180°. Nhồi lỗ vào panel
   `back` sẽ khiến `pivotEdge` của lớp 2 không nằm trên biên chung với parent — vi phạm bất
   biến 3D.
3. **Đặt lỗ theo `slotPos` tính từ Nếp_Gấp_Chung, không tính từ mép ngoài tai.** Chỉ cách này
   mới cho trùng khít bằng chứng minh hình học thuần (phản chiếu), không phụ thuộc `tab2H`
   lớn hơn `tabH` một lượng `T`.
4. **Không trích helper chung với RTE trong đợt này.** `connectCorner` của RTE mutate endpoint
   theo thứ tự mảng; refactor chung sẽ đặt hộp RTE đang chạy production vào vùng rủi ro. Ghi
   nợ kỹ thuật kèm tag truy vết thay vì làm gộp.
5. **Cửa sổ dùng công tắc riêng thay vì suy từ `WNW > 0`.** `WNW = 0` đã mang nghĩa "tự động",
   nên không thể đồng thời mang nghĩa "tắt" — hai nghĩa chồng nhau là bẫy hồi quy.

## Correctness Properties

Các thuộc tính dưới đây chạy bằng fast-check trên arbitrary `'hanging_window'` (L 40–200,
W 15–80, D 60–300, T 0.3–2, C 0–2, G 8–25, TH 8–30, `hgbWindow` boolean, `WNW`/`WNH`/`HTH`
gồm cả giá trị 0 = tự động, `glueSide` và `panelOrder` cả hai giá trị).

### Property 1: CUT kín

Với mọi tham số hợp lệ, chuỗi CUT ngoài của mỗi panel và mỗi vòng CUT của
   Cửa_Sổ, Lỗ_Euro đều khép kín: mọi đoạn liền kề nối nhau và đầu ≡ cuối trong 0,01 mm.
**Validates: Requirements 3.1, 3.2**
### Property 2: Không NaN

Mọi thành phần toạ độ trong `allPaths`, `panels[].outline`,
   `panels[].holes`, `panels[].pivotEdge`, `boundingBox` đều là số hữu hạn.
**Validates: Requirements 3.7**
### Property 3: Hai Lỗ_Euro trùng khít sau gập

Với mọi tham số có `hasSlot = true`, phản chiếu tập
   điểm Lỗ_Euro của Lớp_2 qua Nếp_Gấp_Chung (`y ↦ 2·yTabMid − y`) cho tập điểm trùng tập
   điểm Lỗ_Euro của Lớp_1, kể cả gờ chống trượt, trong 0,01 mm.
Đây là bất biến sống còn của loại hộp này.
**Validates: Requirements 2.4**
### Property 4: Cửa_Sổ nằm trong lề an toàn

Với mọi tham số có `hgbWindow = true` và
   `hasWindow = true`, mọi điểm chuỗi CUT Cửa_Sổ cách mỗi cạnh mặt trước ≥
   `HGB_WINDOW_MARGIN_MM` − 0,01 mm; và Cửa_Sổ căn giữa mặt trước theo cả hai trục.
**Validates: Requirements 1.5, 4.6**
### Property 5: Kẹp và đơn điệu của `hangingWindowDims`

(a) mọi giá trị trả về nằm trong miền do
   hằng `HGB_*` quy định; (b) tăng `L` thì `winW`, `slotW` không giảm; (c) tăng `D` thì
   `winH`, `tabH` không giảm; (d) `tab2H ≡ tabH + T`; (e) khi `hasSlot = true` thì
   `slotH/2 + nibD + 3 ≤ slotPos ≤ tabH − slotH/2 − 3`.
**Validates: Requirements 2.2, 4.3, 4.4**
### Property 6: Bất biến bezier

Mọi đoạn `type = 'bezier'` có `points[0] ≡ controlPoints[0]` và
   `points[cuối] ≡ controlPoints[3]` trong 1e-6.
**Validates: Requirements 3.3**
### Property 7: Cây gập hợp lệ

Mọi panel có `parent` khác `null` đều có `pivotEdge` gồm hai điểm
   nằm trên biên chung với panel `parent` (khoảng cách tới biên đó < 0,01 mm), và đồ thị
   `parent` không có chu trình, đúng một gốc.
**Validates: Requirements 6.1**