# Báo cáo lô §NEST-BASELINE-ROTATE-ON-FAIL + §NEST-PREVIEW-1

Ngày 2026-08-28. Đóng hai báo lỗi còn lại của chủ dự án: "không thấy xoay tem" và "preview
không đúng như kết quả chạy".

## Sửa lại một điều tôi nói sai

Lô trước tôi kết luận "preview đi engine lưới JS". **Sai.** Preview gọi
`POST /imposition/preview-layout` xuống sidecar và engine lưới **Python** trả `cells`;
`NupGridSolver.ts` nằm ngoài đường preview hoàn toàn — chốt `throw` ở
`NupGridSolver.ts:1031` đang bảo vệ một đường **không ai đi** (hai caller duy nhất là
`NupRenderer.ts:114` và `ProductAdvisor.ts:166`, đều là đường TS legacy).

Chỗ fallback thật là `backend/app/workers/sticker_imposer_pkg/orchestrator.py:460`:
dispatch chỉ biết `optimal_auto`/`head_to_tail`/`staggered`, mọi giá trị khác vào
``else: # grid`` ⇒ `true_shape_nesting` được tính bằng **lưới chữ nhật thuần**, còn yếu hơn
`optimal_auto`. Không log, không lỗi — chỉ là một con số khác: **41** thay vì **46**.

## §NEST-PREVIEW-1 — đã sửa

`backend/app/core/nesting_preview_capacity.py` (mới)

- `settings_from_preview_request()` — dịch `PreviewLayoutRequest` (snake_case, point) sang
  `settings` (camelCase, mm).
- `build_nesting_preview()` — `get_or_solve` trên **kho phiên dùng chung**, rồi dựng `cells`
  bằng **chính seam của writer** (`resolve_manifest_artwork_placement` +
  `transform_manifest_polygon_rings`). Chỉ có MỘT đường đọc pose, nên hình preview không thể
  lệch hình xuất.
- Mỗi placement của tờ 0 thành một cell mang `absX/absY/width/height` (bbox) **và**
  `diePolylines` = đường bế thật. Bbox một mình là vẽ sai: nesting lồng các hình lõm vào nhau
  nên bbox của chúng chồng lên nhau.

`backend/app/api/routes/imposition.py` — nhánh nesting đặt **trước** mọi đường lưới, ngay sau
`enforce_feature`. Fail-closed: ngoài phạm vi thì 422, không lặng lẽ rơi về lưới.

### Đóng luôn lỗ thứ hai

`attach_preview_session_reference` (route, lúc launch job) chỉ `peek()` kho phiên. Vì **chưa
ai tạo phiên** nên nó luôn no-op ⇒ process con solve lại từ đầu ⇒ "preview ≡ output" không
có gì bảo đảm. Giờ preview tạo phiên ⇒ export nạp đúng manifest đó và render.

### Một bug do chính test bắt được

`test_khoa_settings_khop_de_phien_tai_dung_duoc_voi_export` đỏ ngay lượt đầu:

```
At index 3 diff: 429.99999999999994 != 430.0
```

Frontend gửi `sheet_h = 430.0 * PT_PER_MM`; chia lại ra `429.99999999999994` — lệch **một
ULP**. Mà `job_identity_key` băm chính các số này, nên job preview và job export thành hai
khoá khác nhau ⇒ phiên **không bao giờ** được tái dùng ⇒ bất biến vỡ **im lặng**. Không có
test này thì lô coi như xong mà thực ra không hoạt động.

Sửa: `_mm()` làm tròn 9 chữ số (nanomét, thấp hơn dung sai engine ba bậc).

### Đo trên file khách

`test/test nesting.pdf`, 13 mẫu, tờ 320×430mm:

```
totalItems=46  sheetsNeeded=1  strategyUsed='true_shape_nesting'  absPlacement=True
cells=46  isMixedPreview=True
placedByPage={'0':4,'1':3,'2':4,'3':3,'4':3,'5':3,'6':4,'7':3,'8':3,'9':4,'10':4,'11':4,'12':4}
cell[0]: abs=(14.7,14.7) 175.5x185.5pt  rings=1  điểm=733  pageIdx=11
  diePolylines y (top-down pt): 1018.7..1204.2   (tờ cao 1218.9)
phiên còn trong kho sau preview: True
lượt hai TÁI DÙNG phiên (không solve lại): True
manifestId preview == export: True
```

`totalItems=46` khớp engine thật (lưới cũ báo 41). Đổi trục Y khớp chính xác:
`1218.9 − 14.7 − 185.5 = 1018.7`.

## §NEST-BASELINE-ROTATE-ON-FAIL — đã sửa, và bản đầu bị số đo loại

`baseline_angles(FirstAllowed)` trả **đúng một** góc — góc đầu của miền, tức 0° với miền
cardinal `[0,90,180,270]` mà production dùng. Bộ tối ưu là thứ duy nhất thử 90/180/270 nhưng
chưa hoàn tất nổi một lượt, nên phương án công bố luôn là baseline ⇒ mọi con ở 0°.

### Bản đầu: nối cardinal vào cuối danh sách góc — bị loại

Xoay xuất hiện thật (`{0°: 62, 90°: 1, 180°: 2}` trên 65 con) nhưng `placedCount` **không
đổi**, còn autofill 13 mẫu đi từ 17,7s lên **50–66s**. Trả 3× thời gian cho 0 con.

Nguyên nhân: nối vào cuối thì mỗi con không vừa ở 0° phải thử thêm 3 góc trên **từng tờ**, mà
ở cuối lượt lấp tờ gần như mọi con đều không vừa.

### Bản giữ lại: góc dự phòng ở LƯỢT RIÊNG

Ba lượt, theo thứ tự: (1) góc chính trên các tờ đã mở → (2) góc dự phòng trên các tờ đã mở →
(3) cả miền trên tờ mới. Xoay **chỉ** được thử khi lựa chọn còn lại là mở thêm một tờ — đó là
chỗ xoay tiết kiệm cả tờ giấy, và là chỗ duy nhất chi phí thêm được biện minh.

Hai chặn khác:

- Tập dự phòng **chỉ** là cardinal, không phải cả miền. Miền `Discrete` người dùng khai có
  thể hàng chục góc, mà baseline **không có deadline** — thử hết là tự làm chậm đúng chỗ đang
  bị phàn nàn. Nó cũng giữ đúng vai "sàn RẺ, có thể bỏ lỡ" mà
  `autofill_smart_rescue_design_ngoai_tap_goc_baseline` dựa vào.
- **Autofill không dùng dự phòng.** Autofill chỉ có một tờ nên không có "tiết kiệm một tờ" để
  biện minh; đo được là 0 con thêm mà 3× thời gian.

### Đo A/B bằng số TẤT ĐỊNH

Thời gian không dùng được để so: CPU nền đang 45–53% từ tiến trình khác, cùng một cấu hình đo
được 30,1s rồi 66,3s. Nên dùng `orientationEvaluations` (đo chi phí) và
`placedCount`/`sheetCount` (đo lợi ích):

| ca | dự phòng | con | tờ | orientEval | xoay |
|---|---|---|---|---|---|
| 13 mẫu autofill | tắt | 46 | 1 | 67 | 0 |
| 13 mẫu autofill | bật | 46 | 1 | **67** | 0 |
| 13×5 = 65 con | tắt | 65 | 2 | 92 | 0 |
| 13×5 = 65 con | bật | 65 | 2 | 100 | **3** |
| 13×20 = 260 con | tắt | 260 | 6 | 979 | 0 |
| 13×20 = 260 con | bật | 260 | 6 | 1070 | **9** |

Đọc trung thực:

- Autofill **không đổi một đơn vị nào** — bản vá không chạm đường đó.
- Quantity tốn thêm **~9%** và xoay được 3 rồi 9 con, tức 9 con vừa được vào tờ đang mở thay
  vì đẩy sang tờ sau.
- **Tổng số tờ không giảm** trên file này. Lợi ích là thật nhưng chưa đủ vượt ranh giới một
  tờ. Với khuôn dài hoặc tờ chật thì đó là chỗ tiết kiệm cả tờ giấy — test
  `xoay_tren_to_dang_mo_thay_vi_mo_to_moi` dựng đúng ca đó (3 con vào 1 tờ thay vì 2 tờ).

## Verify

| Hạng mục | Kết quả |
|---|---|
| `cargo test imposition_core` | **325 passed** = 315 + 10 (file mới), EXITCODE=0 |
| `test_nesting_preview_capacity.py` | 15 passed (mới) |
| Full backend (sau lô xoay) | 4566 passed, 19 skipped — không hồi quy |
| Full backend (sau lô preview) | **4581 passed, 19 skipped = 4600**, khớp `--collect-only` 4600, EXITCODE=0 |
| Đối chiếu số nền | 4585 (trước lô) + 15 (preview) = 4600 |

### Đã kiểm test bắt lỗi

| Đột biến | Kết quả |
|---|---|
| Bỏ lượt góc dự phòng trên tờ đã mở | 1 đỏ — `xoay_tren_to_dang_mo_thay_vi_mo_to_moi` |
| `_mm()` không làm tròn | 1 đỏ — `test_khoa_settings_khop_de_phien_tai_dung_duoc_voi_export` |
| `diePolylines` không đổi trục Y | 1 đỏ — `test_diePolylines_la_top_down_con_abs_la_bottom_up` |

### Hai fixture giòn đã sửa trong lúc làm

1. `xoay_tren_to_dang_mo_thay_vi_mo_to_moi` bản đầu dùng tờ 130 nên cột còn lại khít đúng
   `40 = 40`, và khe hở bảo toàn của solver ăn hết chỗ dư ⇒ đỏ dù code đúng. Đổi sang tờ 135.
2. Bản đầu của test đó chỉ assert `so_to <= 2`, được thoả bởi lượt "tờ mới" chứ không phải
   lượt xoay ⇒ **không phân biệt được** bản có vá với bản không. Đổi sang `== 1` + đòi có con
   xoay 90°.

## Còn lại

| Mã | Việc | Ưu tiên |
|---|---|---|
| `NEST-PREVIEW-UI` | Frontend chưa được kiểm bằng vitest cho nhánh mới (`cells` có `diePolylines`, `absPlacement`) | P1 |
| `NFP-INCREMENTAL-1` | Miền hợp lệ tăng dần — chỗ có 10–100× | P1 |
| `NEST-CUTSTYLE-UI` | `build_cut_style_spec` còn trả mặc định; UI chưa có ô | P2 |
| `NEST-EXPORT-UNIQUE` | `exportUniqueSheets` chưa được writer dùng | P2 |
| `NUPGRIDSOLVER-DEAD` | Chốt `throw` cho `true_shape_nesting` đang bảo vệ đường không ai đi | P3 |
