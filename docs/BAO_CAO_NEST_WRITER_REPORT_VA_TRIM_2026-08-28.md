# Báo cáo lô §NEST-WRITER-REPORT + §NEST-TRIM-OUT-OF-SCOPE

Ngày 2026-08-28. Tiếp `BAO_CAO_NEST_WRITER_PONT_VA_KHOA_GIA_CONG_2026-08-28.md`.

## Kết luận trước

- **Report: đã vẽ được.** Writer giờ đọc `renderBundle.artifactOptions` và stamp report lên
  các trang IN qua chính `nup_report.stamp_reports_on_pdf` mà lane lưới dùng.
- **Dấu xén: KHÔNG làm, và đó là kết luận đúng.** Ba bằng chứng cho thấy dấu xén ngoài phạm
  vi lane này; viết code vẽ nó sẽ là thêm bug. Thay vào đó tôi chặn lỗ im lặng.
- Thêm một lỗ ánh xạ nữa được tìm ra và sửa: **vị trí report** chưa từng được map.

## Dấu xén — vì sao không làm

Ban đầu tôi xếp `NEST-WRITER-TRIM` là P0 cùng hạng với report. Đo lại thì sai:

1. **Lane lưới cũng không vẽ.** `nup_process_chunk.py:1059`:
   `if not is_die_cut and (mark_type == 'guillotine' or mark_type == 'corners')`. Die-cut
   không bao giờ vào nhánh này.
2. **UI không cho bật.** `IMPOSER_CAPABILITIES` trong
   `desktop/src/components/imposition-tools/types.ts` khai `diecut: {supportsMarks: false}`
   và `cnc: {supportsMarks: false}`, nên `processHandlers.ts:276` **luôn** gửi
   `markType: 'none'` cho hai công cụ mà lane nesting phục vụ.
3. **Nghiệp vụ.** Tem bế và bế rớt CNC do **dao** cắt, không phải bàn cắt xén. Dấu xén ở đây
   là dấu vô nghĩa, và tệ hơn: thợ dễ hiểu nó thành đường cắt.

Nên `build_trim_spec` giờ luôn trả `ImpositionTrimSpec()` (= `none`), **kèm log** khi settings
khai khác — vì một payload dựng tay có thể lách UI, và spec mang giá trị writer không bao giờ
vẽ chính là loại lỗi im lặng mà module này tồn tại để chặn.

Test `test_dau_xen_toi_duoc_job` trong `test_nesting_finishing_parity.py` trước đây **khẳng
định `trim.type == 'corners'`** — tức khẳng định một hành vi sai. Đã đổi thành
`test_dau_xen_khong_toi_job_vi_ngoai_pham_vi` với lý luận đầy đủ, để một "bản sửa" sai trong
tương lai bị chặn kèm giải thích.

## Report — đã sửa

`backend/app/workers/nesting_imposition_render.py`

- `_report_text()` — dựng chuỗi bằng **chính** `nup_report.compute_report_data` +
  `build_report_string`. Không tự nối chuỗi: tự nối là mở đường cho hai lane in ra hai chuỗi
  khác nhau từ cùng thiết lập, mà lệch đó không ai phát hiện tới khi thợ so hai tờ.
- `_stamp_report()` — stamp qua `nup_report.stamp_reports_on_pdf`, cùng font (DejaVu) và
  cùng cách canh với lane lưới.
- Chỉ stamp lên **trang IN**. Trang CUT dành cho người làm dao; chữ ở đó là rác cho máy cắt.
  Lane lưới cũng vậy (`_stamp_reports` dùng `sheet_idx * 2`, tức đúng các trang front).
- **Fail-closed**: stamp lỗi thì xoá artifact rồi báo lỗi. Không được lặp lại chính lỗi đang
  sửa dưới dạng "ghi được file nhưng thiếu chữ".
- `PRODUCTION_WRITER_VERSION` → `nesting-manifest-writer-v3-pont-report`.

`backend/app/workers/nup_nesting_finishing.py`

- `_build_report_placement()` — map `reportDisplay.position/offsetX/offsetY/fontSize/centered`.
  **Trước bản vá năm khoá này chưa từng được map**, nên report luôn ra ở mặc định
  `top / 5mm / 8pt / centered` bất kể người dùng chọn gì.
- Map thêm `customText` và `removeDiacritics` — cũng chưa từng được map.
- `fontSize` ngoài 4..40 bị kẹp về 8pt kèm log, thay vì để hợp đồng bundle làm vỡ cả lượt
  bình vì một dòng chữ.

## Đo trên file khách

`test/test nesting.pdf`, 3 mẫu, tờ 320×430mm. Settings có `showPaperSize: False`,
`reportLamination: 1.0` (float), `reportLaminationSides: 2`, vị trí `bottom`, offset (6,4),
font 9pt:

```
report.enabled=True fields=('orderCode','gangCount','material','lamination','labelsPerSheet','sheetCount')
placement=bottom off=(6.0,4.0) font=9.0
lamination=gloss/2  material='Decal giấy'
CHUỖI: DH-2026-0828 - 3 mẫu - Decal giấy - Cán bóng 2 mặt - SL/tờ: 50 - Số tờ: 1
```

Ba điều xác nhận cùng lúc: `showPaperSize: False` lọc được `paperSize` khỏi `fields`;
`reportLamination` dạng **float** ra `gloss` (lỗi int-only đã sửa ở lô trước); vị trí và
font tới đúng writer.

## Verify

| Hạng mục | Kết quả |
|---|---|
| `test_nesting_imposition_render.py` | 41 passed (thêm 9 test report) |
| `test_nup_nesting_finishing_keys.py` | 30 passed (thêm 3 test dấu xén) |
| `test_nesting_finishing_parity.py` | 12 passed (1 test đã đổi kỳ vọng) |
| Full backend | **4566 passed, 19 skipped = 4585**, khớp `--collect-only` 4585, EXITCODE=0 |
| Đối chiếu số nền | 4570 (sau lô ốc) + 9 (report) + 3 (dấu xén) + 3 (placement/keys) = 4585 |

### Đã kiểm test bắt lỗi

| Đột biến | Kết quả |
|---|---|
| Writer bỏ stamp report (`if False`) | **5 đỏ** |
| Stamp cả trang CUT (bỏ lọc `ARTWORK_SIDES`) | 1 đỏ — `test_report_khong_nam_tren_trang_cut` |
| Bỏ đọc `placement` (dùng `{}`) | 1 đỏ — `test_report_ton_trong_vi_tri_da_chon` |
| `markType` không bị ép về `none` | 4 đỏ (lô trước) |

Ghi chú về hai test vị trí: chúng dùng `quantity=1` để tem nằm **giữa** tờ, nhờ vậy dải trên
và dải dưới đều sạch artwork và mực đo được ở đó chỉ có thể là report. Bản đầu tôi dùng
`quantity=2` với một tem ở góc dưới nên test đỏ oan — đó là lỗi của test, không phải của code.

## Còn lại

| Mã | Việc | Ưu tiên |
|---|---|---|
| `NEST-PREVIEW-1` | Preview render từ manifest thay vì engine lưới JS (báo 41 vs thật 46) | P0 |
| `NEST-BASELINE-ROTATE-ON-FAIL` | Baseline thử góc cardinal khi 0° không đặt được — hướng rẻ để có xoay | P1, đo trước |
| `NFP-INCREMENTAL-1` | Miền hợp lệ tăng dần — chỗ có 10–100× | P1 |
| `NEST-CUTSTYLE-UI` | `build_cut_style_spec` còn trả mặc định; UI chưa có ô | P2 |
| `NEST-EXPORT-UNIQUE` | `exportUniqueSheets` chưa được writer dùng | P2 |
