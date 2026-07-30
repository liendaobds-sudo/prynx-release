# Design Document

> Thiết kế — Thư viện biến thể khuôn bế (Box Variant Catalog)

## Overview

Thêm **một lớp dữ liệu nằm trên engine khuôn bế**, không chạm engine. Lớp này biến 11 card `boxType` thành ~21 card biến thể, mỗi card là một bộ thuộc tính đã chốt sẵn.

```
[DielineGallery]  ← sidebar nhóm (đếm số) + ô tìm kiếm + lưới card
       │  chọn variant.id
       ▼
[useBoxStore.setVariant(id)]
       │  applyBoxTypeDefaults(boxType)  →  variant.preset  →  variant.lockedParams
       ▼
[scheduleGeneration]  (KHÔNG ĐỔI)
       ▼
[api.generateDielineRemote → sidecar Rust/Boa → engine.ts → generator]   (KHÔNG ĐỔI)
       ▼
[ParamPanel]  ← ẩn control theo variant.lockedParams; công tắc "Tuỳ chỉnh nâng cao"
```

Cả đường ống sinh khuôn phía dưới `scheduleGeneration` không biết khái niệm "variant" tồn tại. Đó là lý do rủi ro hồi quy hình học bằng 0 (Requirement 6).

## Architecture

### Vì sao dữ liệu, không phải generator mới

Phương án đã bị loại: tách `SnapLockBottom.ts` thành `SnapLockBottomPlain.ts` + `SnapLockBottomLock.ts`. Lý do loại:

- Nhân đôi hình học ⇒ mỗi bug hình học phải sửa hai nơi, sẽ lệch sau vài tháng.
- Nhân đôi golden master snapshot, nhân đôi `nativeFixtureParity`.
- Phải thêm `boxType` mới ⇒ phải sửa allow-list ở **ba** tầng (`runtimeValidation.ts`, `dieline_validation.py`, `dieline_request.rs`) cho mỗi biến thể, và mỗi lần thiếu một tầng là lỗi 422 "Không thể tạo khuôn với thông số này" — thông báo mờ, tốn nhiều giờ dò.
- Phải build lại bundle sidecar cho mỗi biến thể.

Phương án chọn: catalog dữ liệu. Thêm biến thể = thêm một object, không build lại Rust, không đổi snapshot.

### Giới hạn cần nói rõ

Lớp này KHÔNG tạo hình học mới. Nó chỉ phơi bày các tổ hợp thuộc tính engine **đã dựng được**. Muốn có kiểu hộp mà engine chưa dựng thì vẫn phải viết generator mới theo `prynx-add-boxtype`. Giá trị của lớp này: 21 card hiện có dễ chọn, và mỗi generator thêm sau này tự nở ra 2–4 card thay vì 1 card kèm form rối.

## Components and Interfaces

### 1. Catalog biến thể

File mới: `desktop/src/lib/dieline/variants.ts` — dữ liệu thuần, không import generator, không tính hình học.

```ts
/** Nhóm ngành hàng để gom card. Một biến thể mang NHIỀU nhóm (chồng lấn có chủ ý). */
export type BoxGroup =
    | 'nap_cai'        // Hộp nắp cài (Tuck End)
    | 'day_gai_dan'    // Hộp đáy gài & đáy dán (Auto / Snap-Lock Bottom)
    | 'khay_hai_manh'  // Khay & hộp hai mảnh (Tray & Lid)
    | 'cua_so'         // Hộp có cửa sổ (Window)
    | 'treo_ke'        // Hộp treo kệ (Hanging / Display)
    | 'thuc_pham'      // Hộp thực phẩm (Food)
    | 'tui_boc'        // Túi & bọc (Bag & Sleeve)
    | 'bi_thu';        // Bì thư (Envelope)

export interface BoxVariant {
    /** Khoá kỹ thuật, ổn định, dùng cho i18n key và tên tệp ảnh. */
    id: string;
    /** Mã khuôn cho người dùng đọc/gọi điện báo: 'PRYNX-SLB-02'. */
    code: string;
    /** Trỏ về generator CÓ THẬT — không bao giờ là giá trị mới. */
    boxType: BoxParams['boxType'];
    groups: BoxGroup[];
    nameVi: string;
    descVi: string;
    /** Từ đồng nghĩa/phương ngữ cho ô tìm kiếm, viết KHÔNG dấu. */
    aliases: string[];
    /** Ảnh minh hoạ sinh tự động: /images/dieline/variants/<id>.png */
    image: string;
    /** Thuộc tính CHỐT: vừa áp khi chọn, vừa ẩn khỏi form. Nguồn DUY NHẤT. */
    lockedParams: Partial<BoxParams>;
    /** Số đo khởi đầu; người dùng sửa tự do. Bỏ trống = dùng mặc định boxType. */
    preset?: Partial<BoxParams>;
}
```

API của module:

```ts
export const BOX_VARIANTS: readonly BoxVariant[];
export const BOX_GROUPS: readonly { id: BoxGroup; nameVi: string; nameEn: string }[];

/** Trả biến thể theo id; undefined nếu không có. */
export function getVariant(id: string): BoxVariant | undefined;

/** Biến thể mặc định của một boxType — dùng làm đường lùi (Req 2.5)
 *  và để tương thích code cũ đang gọi setParam('boxType', ...). */
export function defaultVariantFor(boxType: BoxParams['boxType']): BoxVariant;

/** Khoá này có bị biến thể chốt không → dùng để ẩn control. */
export function isParamLocked(variantId: string | null, key: keyof BoxParams): boolean;

/** Cả cụm khoá đều bị chốt → ẩn luôn cả section. */
export function isSectionLocked(variantId: string | null, keys: (keyof BoxParams)[]): boolean;

/** Params hiện tại đã lệch khỏi lockedParams của biến thể chưa (Req 4.4). */
export function isDeviated(variantId: string | null, params: BoxParams): boolean;

/** Đếm số biến thể mỗi nhóm — cho sidebar (Req 3.2). */
export function countByGroup(): Record<BoxGroup, number>;

/** Khớp biến thể với từ khoá tìm kiếm (Req 3.5). */
export function variantMatchesQuery(v: BoxVariant, query: string): boolean;
```

`variantMatchesQuery` **dùng lại** `normalizeSearch` (thường hoá + bỏ dấu + `đ→d`). Không viết hàm bỏ dấu mới.

Hàm này trước ở `desktop/src/lib/toolRegistry.ts`; đã **tách sang module thuần** `desktop/src/lib/textSearch.ts`, toolRegistry re-export nên mọi chỗ gọi cũ giữ nguyên. Lý do bắt buộc phải tách: `lib/dieline/*` nằm trong chuỗi bundle của **sidecar chạy trên Boa (không có DOM)**; `toolRegistry.ts` import React và `lazy()` toàn bộ cây component, kéo nó vào `lib/dieline` sẽ làm vỡ bundle sidecar. Đây là bẫy phát hiện khi thi công lô 1.

### 2. Store

File sửa: `desktop/src/store/useBoxStore.ts` (additive).

```ts
interface BoxStore {
    // … giữ nguyên toàn bộ trường hiện có
    variantId: string;
    setVariant: (id: string) => void;
    isAdvancedMode: boolean;
    setAdvancedMode: (v: boolean) => void;
}
```

`setVariant` — điểm dễ sai nhất của cả tính năng:

```ts
/** (a) mặc định boxType → (b) preset → (c) lockedParams.
 *  (a) và (b) CHỈ chạy khi bước sang họ hộp khác. */
function applyVariant(prev: BoxParams, variant: BoxVariant): BoxParams {
    if (prev.boxType === variant.boxType) return { ...prev, ...variant.lockedParams };
    return {
        ...applyBoxTypeDefaults(prev, variant.boxType),  // tái dùng, không viết lại
        ...variant.preset,
        ...variant.lockedParams,
    };
}

setVariant: (id) => {
    const prev = get().params;
    const variant = getVariant(id) ?? defaultVariantFor(prev.boxType);
    if (!variant) { set({ variantId: null }); return; }  // catalog chưa phủ loại này
    set({ variantId: variant.id, params: applyVariant(prev, variant) });
    // changedKey: 'boxType' để scheduleGeneration bật forceRerender ⇒ clampVersion
    // tăng ⇒ input remount lấy giá trị mới. BẮT BUỘC kể cả khi boxType KHÔNG đổi
    // (Req 2.2) — hai biến thể cùng boxType vẫn phải làm mới ô nhập.
    scheduleGeneration(set, get, { changedKey: 'boxType' });
}
```

**Bẫy đã gặp khi thi công (Req 2.3):** `applyBoxTypeDefaults` nhúng sẵn preset số đo của `pizza`, `tray`, `double_tray`, `hanging_window` và áp **vô điều kiện** khi `value` trùng loại đó — nó không kiểm `prev.boxType`. Nên khi đổi giữa hai biến thể cùng `boxType` thì phải bỏ **cả** bước (a), không chỉ bước (b); nếu chỉ bỏ (b) thì số đo người dùng vẫn bị xoá bởi (a). Khi không đổi họ hộp thì cũng không có "mặc định theo boxType" nào cần áp.

`setParam('boxType', …)` giữ nguyên để không phá code cũ, nhưng thêm một dòng: đồng bộ `variantId = defaultVariantFor(value).id`. Nhờ vậy state không bao giờ ở trạng thái "boxType và variantId trỏ hai nơi khác nhau".

### 3. Thư viện (gallery)

File sửa: `desktop/src/components/dieline-tool/DielineGallery.tsx`.

Layout mới (bám mô hình Pacdora, nhưng đảo thứ tự ảnh):

```
┌──────────────┬──────────────────────────────────────────┐
│ 🔍 [tìm kiếm]│  ┌────────┐ ┌────────┐ ┌────────┐        │
│              │  │  3D    │ │  3D    │ │  3D    │        │
│ Tất cả    21 │  │  2D    │ │  2D    │ │  2D    │        │
│ Nắp cài    3 │  │ Tên    │ │ Tên    │ │ Tên    │        │
│ Đáy gài…   4 │  │ PRYNX-…│ │ PRYNX-…│ │ PRYNX-…│        │
│ Khay…      2 │  └────────┘ └────────┘ └────────┘        │
│ Cửa sổ     2 │                                          │
│ Treo kệ    2 │                                          │
│ Thực phẩm  5 │                                          │
│ Túi & bọc  4 │                                          │
│ Bì thư     4 │                                          │
└──────────────┴──────────────────────────────────────────┘
```

Quyết định thiết kế: **hình hộp 3D đặt TRƯỚC khuôn 2D** trong card (Pacdora làm ngược). Thợ nhận ra "cái hộp mình cần" bằng hình khối; nét bế trải phẳng là thứ họ xem sau khi đã chọn.

Số đếm ở sidebar lấy từ `countByGroup()`, không hằng số. Tổng cột phải ≠ tổng "Tất cả" là bình thường — nhóm chồng lấn.

Lọc và tìm kiếm đều là client-side thuần trên mảng 21 phần tử; không cần memo hoá phức tạp, không cần virtual list.

### 4. Form tham số

File sửa: `desktop/src/components/dieline-tool/ParamPanel.tsx`.

Cấu trúc hiện tại đã dùng cờ `isSLB`, `isPizza`… quanh từng khối JSX. Thêm một tầng điều kiện, không đổi cách tổ chức:

```tsx
const { variantId, isAdvancedMode } = useBoxStore();
/** Hiện control khi: chế độ nâng cao HOẶC khoá không bị biến thể chốt. */
const show = (key: keyof BoxParams) => isAdvancedMode || !isParamLocked(variantId, key);
const showSection = (keys: (keyof BoxParams)[]) =>
    isAdvancedMode || !isSectionLocked(variantId, keys);
```

Áp dụng:

- `{(isSLB || isAutoBottom) && show('lockTab') && ( … ô tích lưỡi khoá … )}`
- Cụm "Tính năng hộp pizza": bọc bằng `showSection(['pizzaVent','pizzaFrontLock','pizzaCornerLock'])`, từng ô bọc `show(...)` riêng — cả cụm bị chốt thì ẩn cả tiêu đề section, tránh để lại nhãn rỗng.
- Ô `select` chọn `boxType` → thay bằng `select` chọn biến thể, `value={variantId}`, `onChange → setVariant`. Nhóm bằng `<optgroup>` theo `BoxGroup` đầu tiên của biến thể.
- Công tắc "Tuỳ chỉnh nâng cao" đặt cuối panel, cạnh mục nâng cao hiện có.
- Nhãn "đã tuỳ chỉnh" hiện khi `isDeviated(variantId, params)` — chip nhỏ cạnh tên biến thể, không phải dialog cảnh báo.

### 5. Script sinh ảnh minh hoạ

File mới: `desktop/scripts/genVariantThumbs.mts`.

```
với mỗi variant trong BOX_VARIANTS:
    params = validateParams({ ...DEFAULT_PARAMS, boxType, ...preset, ...lockedParams }).params
    model  = generateDieline(params)               // engine TS, chạy trong Node
    svg2D  = renderDielineSVG(model)              // màu nét theo chú giải hiện hành
    png3D  = renderFoldedPreview(model, 1.0)      // hộp đã gấp, góc nhìn cố định
    ghép dọc → public/images/dieline/variants/<id>.png
```

Yêu cầu ổn định (Req 5.3): góc camera, ánh sáng, kích thước canvas, seed texture — tất cả là hằng trong script, không phụ thuộc thời gian/random. Cùng đầu vào cho ra byte-identical để `git diff` ảnh có nghĩa.

Nếu render 3D trong Node quá tốn công (three.js headless), phương án B: script chỉ sinh khuôn 2D, còn hình hộp 3D chụp tay một lần cho mỗi biến thể. Card vẫn có khung giữ chỗ khi thiếu ảnh (Req 5.4), nên thiếu ảnh không chặn các lô trước.

### 6. i18n

Khoá theo `id` biến thể, đặt trong namespace sẵn có của công cụ:

```
dieline.variant:<id>.name
dieline.variant:<id>.desc
dieline.group:<group>.name
```

`nameVi`/`descVi` trong catalog là **fallback**, không phải nguồn hiển thị — đi qua `t()` như mọi text khác (Req 4.6).

## Data Models

Ma trận biến thể đợt đầu: xem bảng ở Requirement 7.1. Gán nhóm:

| Mã | groups |
|---|---|
| PRYNX-RTE-01 | `nap_cai` |
| PRYNX-SLB-01 / -02 | `nap_cai`, `day_gai_dan` |
| PRYNX-AB-01 / -02 | `nap_cai`, `day_gai_dan` |
| PRYNX-GB-01 / -02 | `thuc_pham`, `tui_boc` |
| PRYNX-PB-01 / -02 | `tui_boc` |
| PRYNX-CS-01 / -02 | `tui_boc`, `thuc_pham` |
| PRYNX-PZ-01 / -02 | `thuc_pham` |
| PRYNX-EV-01…-03 | `bi_thu` |
| PRYNX-EV-04 | `bi_thu`, `cua_so` |
| PRYNX-TR-01 | `khay_hai_manh`, `thuc_pham` |
| PRYNX-DT-01 | `khay_hai_manh` |
| PRYNX-HW-01 | `nap_cai`, `cua_so`, `treo_ke` |
| PRYNX-HW-02 | `nap_cai`, `treo_ke` |

`preset` chỉ khai cho biến thể có số đo đặc thù, tái dùng số đã kiểm trong `applyBoxTypeDefaults`: `pizza` 300×300×40 T1.5 · `tray` 200×150×40 T1 · `double_tray` 361×261×52 T1.5 (mẫu 100010-01) · `hanging_window` 80×30×140 T0.5 (Preset_Dacdora) · `envelope` 220×110 (DL). Các biến thể còn lại để trống `preset`.

## Error Handling

| Tình huống | Xử lý |
|---|---|
| `variantId` không có trong catalog | `defaultVariantFor(params.boxType)`, không throw (Req 2.5) |
| Ảnh biến thể thiếu | `onError` của `<img>` → khung giữ chỗ có chữ mã khuôn (Req 5.4) |
| `preset`/`lockedParams` bị `validateParams` kẹp | KHÔNG xử lý ở runtime — đây là lỗi dữ liệu, test lô 1 phải chặn từ CI |
| Tìm kiếm rỗng kết quả | Thông báo + nút "Xem tất cả" (Req 3.6) |
| Người dùng ở chế độ nâng cao sửa khoá bị chốt | Cho phép, hiện chip "đã tuỳ chỉnh" (Req 4.4) |

## Testing Strategy

File mới `desktop/src/lib/dieline/variants.test.ts` — bốn tầng, viết cùng lúc với catalog:

1. **Toàn vẹn catalog**: `id`/`code` duy nhất; mọi `boxType` được phủ (đối chiếu trực tiếp với union type, để thêm `boxType` mà quên biến thể là đỏ CI); mọi `groups` là giá trị hợp lệ; `image` trỏ đúng quy ước đường dẫn.
2. **Sinh được khuôn**: mỗi biến thể → `generateDieline` không throw, không NaN trong `allPaths`, `boundingBox` bao đúng `allPaths` (Req 6.5).
3. **Preset không bị kẹp**: `validateParams` trên params của mỗi biến thể trả `wasClamped === false` (Req 6.6).
4. **Biến thể phải khác hình**: với mỗi cặp biến thể cùng `boxType`, so số nét CUT / số panel / bbox — bắt buộc khác ít nhất một chỉ số (Req 1.5). Đây là test chống "tách card cho vui".

Thêm vào `desktop/src/store/useBoxStore.test.ts`: `setVariant` áp đúng thứ tự (a)(b)(c); đổi giữa hai biến thể cùng `boxType` vẫn tăng `clampVersion`; `id` rác rơi về mặc định.

Chốt chống hồi quy (Req 6.1): chạy `npx vitest run src/lib/dieline` sau mỗi lô, `goldenMaster.test.ts` phải xanh **mà không** cần `-u`. Nếu snapshot đỏ ⇒ đã chạm hình học ⇒ sai hướng, dừng lại soi diff chứ không cập nhật snapshot.

Test chạy trên Windows thật (`node_modules` chứa binary Windows — xem `prynx-testing`).

## Correctness Properties

*Một property là đặc tính phải đúng trên mọi lần thực thi hợp lệ — phát biểu hình thức về điều hệ thống phải làm, làm cầu nối giữa đặc tả người đọc và bảo đảm kiểm chứng được bằng máy.*

Chạy trên toàn bộ `BOX_VARIANTS` (bảng liệt kê hữu hạn 21 mục — duyệt cạn, không cần sinh ngẫu nhiên).

### Property 1: Lớp biến thể trong suốt với engine

Với mọi biến thể `v`, `generateDieline({ ...DEFAULT_PARAMS, ...v.preset, ...v.lockedParams, boxType: v.boxType })` cho ra `DielineModel` **giống hệt** kết quả khi đặt cùng bộ tham số đó bằng tay qua `setParam`. Lớp biến thể chỉ là đường tắt đặt tham số, không được thêm/bớt gì.
**Validates: Requirements 6.2, 6.3**

### Property 2: Chốt là chốt

Với mọi biến thể `v` và mọi khoá `k ∈ keys(v.lockedParams)`: sau `setVariant(v.id)`, `params[k] === v.lockedParams[k]`. Không tầng nào (`applyBoxTypeDefaults`, `preset`, `validateParams`) được ghi đè giá trị đã chốt.
**Validates: Requirements 2.1, 6.6**

### Property 3: Chốt và ẩn không thể lệch nhau

Với mọi biến thể `v` và mọi khoá `k`: `isParamLocked(v.id, k) === (k ∈ keys(v.lockedParams))`. Không có nguồn thứ hai quyết định việc ẩn.
**Validates: Requirements 1.6, 4.1**

### Property 4: Biến thể cùng loại phải khác hình

Với mọi cặp `(v1, v2)` có `v1.boxType === v2.boxType` và `v1.id ≠ v2.id`: hai model sinh ra khác nhau ở ít nhất một trong ba chỉ số — số nét CUT, số panel, `boundingBox`. Đây là test chống tách card vô nghĩa.
**Validates: Requirements 1.5**

### Property 5: Phủ kín loại hộp

Tập `{ v.boxType }` bằng đúng tập giá trị của union `BoxParams['boxType']`. Thêm loại hộp mà quên biến thể ⇒ đỏ CI; khai biến thể trỏ `boxType` không tồn tại ⇒ đỏ typecheck.
**Validates: Requirements 1.3, 1.4**

### Property 6: Preset không bị kẹp

Với mọi biến thể `v`: `validateParams(paramsOf(v)).wasClamped === false`. Preset bị kẹp là preset sai — phải sửa dữ liệu, không phải chấp nhận ở runtime.
**Validates: Requirements 6.6**

### Property 7: Không mất tính năng

Với mọi khoá `k` đang có control trong `ParamPanel` hôm nay: tồn tại đường để người dùng sửa `k` — hoặc control hiện bình thường, hoặc hiện sau khi bật "Tuỳ chỉnh nâng cao". Không khoá nào bị khoá cứng vĩnh viễn.
**Validates: Requirements 4.3**

### Property 8: Đơn định của ảnh minh hoạ

Chạy script sinh ảnh hai lần trên cùng catalog cho ra tệp byte-identical.
**Validates: Requirements 5.3**

### Property 9: Tìm kiếm bỏ dấu đối xứng

Với mọi biến thể `v` và mọi truy vấn `q` là một từ trong `v.nameVi`: `variantMatchesQuery(v, q)` đúng cả khi `q` có dấu và khi `q` đã bỏ dấu.
**Validates: Requirements 3.5**
