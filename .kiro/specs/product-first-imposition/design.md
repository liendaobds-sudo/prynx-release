# Design Document

## Overview

Phase 1 xây một lớp **ProductAdvisor** (cố vấn theo sản phẩm) cho **in nhanh
(digital)**: nhận khai báo sản phẩm + khổ giấy in nhanh + thông tin file, trả về
một danh sách **đề xuất thiết lập** đã fit-check, kèm diễn giải và chỉ số sản xuất.
Người dùng chọn 1 đề xuất → đổ vào `useImposerSettingsStore` (đúng các knob engine
bình hiện tại) → chạy như bình thường. UI "Nâng cao" hiện tại giữ nguyên làm chế độ
override.

Nguyên tắc: **lớp này KHÔNG render, KHÔNG tự cài hình học/sắp trang.** Nó chỉ điều
phối các engine sẵn có (`NupGridSolver` để tính fit, `VirtualMap` để biết số tay/mặt)
và dịch sản phẩm → thiết lập. Offset KHÔNG thuộc phase này; `printMethod` bị khoá
cứng = `in_nhanh`.

## Architecture

```
Người dùng (khai báo sản phẩm)
        │  ProductInput { binding, finishedW/H, sheetKey, pageCount, quantity, bleed }
        ▼
ProductAdvisor.recommend(input)              ← module thuần toán, không UI, không PDF
        │  - map binding → signatureMode + ràng buộc
        │  - tính spread size (2-up) từ finishedSize + bleed
        │  - NupGridSolver.solveOptimalNupLayout(...) → số con/tờ N (thử xoay khổ)
        │  - VirtualMap.generateBindingMap(...) → số tay/mặt (surfaces)
        │  - tính chỉ số: tờ in, lượt in, %hao  (in-nhanh metric)
        │  - sinh 1..n RecommendationOption đã fit-check + cảnh báo
        ▼
ProductFirstPanel (UI)  → hiển thị các option-card + diễn giải "vì sao"
        │  người dùng bấm "Dùng thiết lập này"
        ▼
applyRecommendation(option) → set useImposerSettingsStore (signatureMode, scaleMode,
        formsize/custom sheet, gapX/Y, bleed, blankPlacement, paperClassification='in_nhanh', …)
        ▼
Luồng bình hiện tại (handleStartBooklet → imposePdfViaBackend → PlanExecutor)
```

Điểm cắm UI: thêm một entry "Theo sản phẩm" cạnh luồng hiện tại trong khu vực
ImposerDashboard; không thay đổi luồng power-user.

## Components and Interfaces

### 1. ProductAdvisor (module mới, thuần toán)
`desktop/src/lib/imposerEngine/ProductAdvisor.ts`

```ts
export type InNhanhBinding =
  | 'saddle'        // bấm kim giữa
  | 'thread'        // khâu chỉ chia tép
  | 'perfect'       // keo gáy / lò xo  (engine: signatureMode 'continuous')
  | 'cut_stacks'    // cắt đôi ráp xấp (vé/voucher)
  | 'flush_mount';  // dán đối lưng

export interface ProductInput {
  printMethod: 'in_nhanh';      // Phase 1 khoá cứng
  binding: InNhanhBinding;
  finishedWidthMm: number;
  finishedHeightMm: number;
  pageCount: number;
  sheetKey: string;             // key trong PREDEFINED_SIZES (classification='in_nhanh') hoặc custom
  sheetWidthMm: number;
  sheetHeightMm: number;
  quantity?: number;            // số cuốn cần (để xếp hạng); thiếu → proxy theo tờ
  bleedMm?: number;             // mặc định 3
  foliosize?: number;           // cho thread (bội 4)
}

export interface RecommendationOption {
  id: string;
  strategy: 'one_up' | 'multi_up' | 'cut_stack';
  copiesPerSheet: number;       // "1 tờ mấy con"
  cols: number; rows: number;
  rotatedSheet: boolean;        // có xoay khổ 90° để fit tốt hơn không
  sheetsPerSetOfCopies: number; // số tờ in cho 1 lượt (gồm các mặt)
  totalSheets?: number;         // nếu có quantity
  wastePercent: number;         // %hao lấp đầy còn dư
  explanation: string;          // "1 tờ SRA3 = 2 con A5/mặt, 8 mặt → 4 tờ in"
  warnings: string[];
  settings: BookletSettingsBundle; // bộ knob đổ vào store
}

export interface RecommendResult {
  options: RecommendationOption[]; // đã xếp hạng, [] nếu không khả thi
  errors: string[];                // lý do không khả thi (khổ quá nhỏ…)
}

export function recommendInNhanh(input: ProductInput): RecommendResult;
```

### 2. Mapping sản phẩm → engine (in nhanh)

| Binding (sản phẩm) | signatureMode | Chiến lược khả dĩ | Ghi chú |
|---|---|---|---|
| Bấm kim giữa | `saddle` | one_up, multi_up | spread 2-up, gấp lồng |
| Khâu chỉ chia tép | `thread` | one_up, multi_up | chia tép theo `foliosize` |
| Keo gáy / lò xo | `continuous` | one_up, multi_up | trang tuần tự, có thể gutter |
| Cắt đôi ráp xấp | `cut_stacks` | cut_stack | vé/voucher, hút gáy xén úp |
| Dán đối lưng | `flush_mount` | one_up, multi_up | 1 mặt, spread liền mạch |

- `multi_up` ⇒ store: `scaleMode='chain_nup'`, `chainNup=true`.
- `one_up`   ⇒ store: `scaleMode='100'` (khổ tự theo spread) hoặc `'fit'` (canh giữa khổ lớn).
- `cut_stack`⇒ store: `signatureMode='cut_stacks'` (+ `scaleMode` phù hợp), `spreadDistribution` mặc định 'clustered'.
- **Không** đề xuất `foldPattern`, `gripperMargin`, `interleave` (đó là offset).

### 3. Tính fit "1 tờ mấy con" (tái dùng engine)
- spreadW = `finishedWidthMm*2 - 2*bleed (+0)`, spreadH = `finishedHeightMm` (đồng bộ
  cách `SheetOptimizer.calcSpreadSize` / `GeometricSolver`).
- Gọi `NupGridSolver.solveOptimalNupLayout(usableW, usableH, spreadW, spreadH, gapX, gapY, 'simple_auto', 0, 0, …)`
  để lấy số cell = số con/tờ; thử cả khổ gốc và **xoay 90°**, chọn cái nhiều con hơn.
- `usableW/H` = khổ giấy (in nhanh gripper=0; margins mặc định nhỏ/0).

### 4. Số tay/mặt + chỉ số sản xuất (in nhanh)
- `VirtualMap.generateBindingMap(pageCount, signatureMode, foliosize, blankPlacement)`
  → `sheets` = số tờ-vật-lý/cuốn; surfaces = `sheets.length` (in nhanh in duplex: 1 tờ = 2 mặt).
- `tờ in / cuốn = sheets.length`; `multi_up`: `tổng tờ in = sheets.length * ceil(quantity / N)`.
- `wastePercent` = 1 − (diện tích N spread / diện tích khổ).
- (Không dùng `ProductionCalculator` offset ở phase này; metric in-nhanh đơn giản hơn,
  ghi rõ là model riêng — không nhân bản logic offset.)

### 5. applyRecommendation → store
`desktop/src/lib/imposerEngine/ProductAdvisor.ts` (hoặc helper UI) đổ `settings` vào
`useImposerSettingsStore`: `setTaskMode('booklet')`, `setSignatureMode`, `setScaleMode`,
`setPaperClassification('in_nhanh')`, `setCustomSheetWidth/Height` (+ `setFormsize`),
`setBleed`, `setGapX/Y`, `setBlankPlacement`, `setFoliosize` (thread)… Sau Apply, người
dùng có thể mở Nâng cao chỉnh tiếp.

### 6. ProductFirstPanel (UI mới)
`desktop/src/components/imposition-tools/ProductFirstPanel.tsx`
- Bước 1: chọn sản phẩm (card có icon + mô tả nghề).
- Bước 2: khổ thành phẩm (tự điền từ file, cho sửa) + số trang (từ file).
- Bước 3: chọn khổ giấy **chỉ in nhanh** (lọc `PREDEFINED_SIZES.classification==='in_nhanh'`
  + preset in_nhanh) + số lượng (tuỳ chọn).
- Hiển thị: các option-card xếp hạng, mỗi card có `explanation`, copiesPerSheet, tờ in,
  %hao, cảnh báo; nút "Dùng thiết lập này".
- Có link "Chỉnh nâng cao" mở UI hiện tại.

## Data Models

```ts
interface BookletSettingsBundle {
  taskMode: 'booklet';
  paperClassification: 'in_nhanh';
  signatureMode: 'saddle'|'thread'|'continuous'|'cut_stacks'|'flush_mount';
  scaleMode: '100'|'fit'|'chain_nup'|'cut_stack';
  chainNup: boolean;
  cutStack: boolean;
  formsize: string;                 // 'auto_100' | 'custom' | key
  customSheetWidth: number; customSheetHeight: number;
  bleed: number; gapX: number; gapY: number;
  blankPlacement: 'end'|'center';
  spreadDistribution: 'clustered'|'even';
  foliosize?: number;               // thread
  // KHÔNG có foldPattern/gripperMargin/interleave ở in nhanh
}
```

## Tách In nhanh / Offset (thực thi ở phase này)
- `printMethod` khoá = `in_nhanh`; UI chọn khổ **lọc cứng** theo `classification==='in_nhanh'`.
- Bundle KHÔNG set `foldPattern`/`gripperMargin`/`interleave`. Nếu giá trị nào thuộc
  offset lọt vào → coi là lỗi lập trình (assert/test chặn).
- Khi Phase 3 thêm offset: tạo nhánh `recommendOffset` riêng + chọn khổ offset riêng;
  không tái dùng chung hàm với in nhanh.

## Error Handling

Fail-loud (Requirement 6):
- Khổ giấy nhỏ hơn 1 spread → `RecommendResult.errors` nêu rõ + gợi ý khổ tối thiểu;
  KHÔNG trả option sai.
- Mỗi `RecommendationOption` chỉ phát ra khi `copiesPerSheet >= 1` và đã qua fit-check.
- `pageCount` không bội 4 (saddle/thread) → option vẫn hợp lệ nhưng `warnings` nêu rõ
  số trang trắng sẽ chèn + vị trí (`blankPlacement`).
- Bundle sau Apply phải khớp đúng đường engine viaBackend phase-2 (đã sửa ở audit
  trước) — không có knob bị bỏ rơi.

## Reuse of existing engines (Requirement 7)
- Fit/đếm con: `NupGridSolver.solveOptimalNupLayout` (KHÔNG tự cài lưới).
- Số tay/mặt + thứ tự trang: `VirtualMap.generateBindingMap`.
- Áp dụng: `useImposerSettingsStore` (store hiện có) → `handleStartBooklet` hiện có.
- Không sửa engine bình; chỉ thêm module advisor + 1 panel UI + wiring.

## Correctness Properties

### Property 1: Tách phương pháp in nhanh/offset
Mọi `option.settings` có `paperClassification==='in_nhanh'` và KHÔNG chứa
`foldPattern`/`gripperMargin`/`interleave`.

**Validates: Requirements 2.2, 2.3**

### Property 2: Chỉ phát option fit hợp lệ
Mọi option có `copiesPerSheet >= 1`; nếu không khổ nào fit thì `options=[]` và
`errors` không rỗng (không bao giờ trả option sai âm thầm).

**Validates: Requirements 6.1, 6.2, 3.4**

### Property 3: Phủ trang đầy đủ
Số tay/mặt suy từ `generateBindingMap` ⇒ Apply rồi chạy không sót/trùng trang
(kế thừa bất biến đã test của VirtualMap).

**Validates: Requirements 6.4, 7.2**

### Property 4: Khớp engine thực thi
Bundle sau Apply chạy đúng đường viaBackend phase-2; `multi_up` ⇒ plan có
`phase2.mode==='step_repeat'`, `cut_stack` ⇒ `'cut_stack'`.

**Validates: Requirements 6.3, 5.1**

### Property 5: Đơn điệu theo khổ
Khổ lớn hơn (cùng tỉ lệ) ⇒ `copiesPerSheet` không giảm.

**Validates: Requirements 3.1**

### Property 6: Xoay khổ chỉ để tăng fit
`rotatedSheet=true` chỉ khi nó cho `copiesPerSheet` lớn hơn hoặc bằng phương án
không xoay.

**Validates: Requirements 3.2**

## Testing Strategy
- **Unit (vitest) cho `recommendInNhanh`** (thuần toán, dễ test):
  - saddle A5 trên SRA3 → copiesPerSheet=2 (hoặc theo fit thực), strategy multi_up.
  - khổ A4 quá nhỏ cho spread A4 → errors không rỗng, options rỗng.
  - thread foliosize bội 4; pageCount lẻ → warnings chèn trang trắng.
  - cut_stacks → strategy cut_stack, signatureMode 'cut_stacks'.
  - **Bất biến tách offset:** mọi bundle KHÔNG chứa foldPattern/gripperMargin/interleave.
  - xoay khổ: khổ dọc vs spread ngang → rotatedSheet=true khi fit tốt hơn.
- **Apply→store**: test đổ đúng knob, paperClassification='in_nhanh'.
- **Parity**: option multi_up sau Apply chạy qua serializeBookletPlan → có phase2
  (đã có test phase-2 ở audit trước; thêm 1 ca từ advisor).
- Không cần raster ở phase này (đường render đã raster-verify ở audit trước).

## Phasing (triển khai)
1. `ProductAdvisor.recommendInNhanh` + unit tests (lõi, không UI).
2. `applyRecommendation` → store + test.
3. `ProductFirstPanel` UI + cắm vào dashboard (giữ Nâng cao).
4. Hoàn thiện diễn giải/cảnh báo + đa option xếp hạng.
