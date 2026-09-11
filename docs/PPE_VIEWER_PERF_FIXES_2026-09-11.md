# Tăng tốc PPE Viewer sau bù xén - 2026-09-11

Người dùng đã duyệt toàn bộ lô trong
`BAO_CAO_AUDIT_TOC_DO_VIEWER_SAU_BU_XEN_2026-09-11.md` bằng yêu cầu
"ok làm hết đi". Không thay writer bù xén, không giảm DPI, không chuyển PDFium,
không thêm hard-cap phần cứng hoặc thay profile màu.

## Lô A - cache chương trình Form

- `print_engine/src/page_program.rs`: `FormProgram` chứa PageProgram bất biến và
  DecodeQuality; đếm vùng nhớ sở hữu của operator/operand/inline-image/dictionary.
- `print_engine/src/session.rs`: Form cache theo ObjectId của document session,
  chung budget/LRU với ảnh; xóa khi close, invalidate, refresh hoặc budget=0.
- `print_engine/src/content/interp.rs`: giải mã một lần, compile tại đúng cổng
  execute cũ sau state/child-buffer guard, không eager-compile Form bị bỏ. Mỗi
  invocation vẫn resolve resource, CTM, clip, Group, OCG và warning riêng.
- `print_engine/tests/render_form_cache.rs`: 7 regression cho 9 Do, nested/group,
  tài nguyên kế thừa, warm recovery visibility, budget 0/tiny/shrink/mixed LRU,
  pre-cancel và save-over giữ ObjectId. Không claim test pre-cancel là mid-compile.

Verify hẹp A: cache 7 + session 12 + stream 17 đạt; các lượt full tiếp theo kiểm
toàn crate. Số đo thăm dò A dưới tải compile vẫn chậm; không gọi cache parser
là lời giải cho toàn bộ latency hoặc dùng những số đó để tuyên bố speedup.

## Lô B - SMask và clip

1. SMask `/G`: không clone payload; chỉ giải mã sau empty-window return đã có.
   BC/TR và guard-band vẫn được tính. Vùng nhìn thấy tái dùng Form program;
   diagnostic deferred được tạo lại theo từng invocation, không cache event.
2. B2: solid fill/stroke không-conservative áp clip/composite trong giao bbox
   path với clip_region đã có. Không đổi scan-convert/transform/AA, không cull
   object hay bỏ make_paint/spot registration. Scratch vẫn đánh dấu và xóa full
   dirty bbox để không rò pixel cũ.
3. B3: giao với clip rỗng tái dùng mask 0; bounds rời nhau tạo mask 0 trực tiếp,
   không raster thêm mask toàn surface. Vẫn thực thi toàn bộ stream/state, không
   bỏ Q/marked-content/outline hay metadata màu.
4. Review độc lập phát hiện BBox tràn f32 có thể cho EMPTY giả. Đã thêm guard:
   corner không hữu hạn → vùng bảo thủ full, giữ fallback clip thay vì làm mất
   body hữu hạn. Có regression riêng; không dùng fast-path dựa trên NaN.

File: `content/interp.rs`, `raster/mask.rs`, `tests/render_smask_cache.rs`;
`native/src/print_engine_py.rs` trả thêm form_hits/misses/evictions để phân biệt
resource hit với bitmap hit. Hai test SMask khóa Alpha/Luminosity, BC/TR,
outside-window, recovery/cache và clip đổi DPI. Các test raster/clip khóa dirty
buffer và mask-parity.

## Lô C - tách prefetch khỏi lane tương tác

- `livePageFramePolicy.ts`: active=10, prefetch=100, nền thường=200, tab ẩn=1000.
- Native/HTTP đã có ngưỡng 100 và lane nền; không tăng số worker hay đổi DPI.
- Giữ request/bitmap cùng pixel khi prefetch trở thành active, không hủy rồi
  dựng lại. LiveTile tests dùng chính producer priority thực, không hardcode mô phỏng.
- `render_worker.rs` thêm regression ngưỡng và test runtime opt-in
  `parent_manager_ppe_prefetch_priority_timeline`, ghi parent wall/lane/PID/PNG
  hash trước/sau priority20/100; chỉ tạo/dọn worker thuộc test.
- Không thêm bitmap cache/singleflight mới vì audit chưa chứng minh lợi ích đủ
  để đổi ownership/cancel. Blob cache và in-flight guard hiện có được giữ.

Frontend: 110 test phạm vi Viewer/coordinator/scheduler/cache và typecheck đạt.
Tauri worker unit suite: 32 đạt, 3 ignored (có probe runtime riêng).

## Số đo đã có

20 cặp trên trang 3 của `sticker_c2f67b48.pdf`, 96 DPI, FOGRA39/Relative,
View/annotations, overprint tắt. Hai native ở hai process riêng, render tuần tự,
đảo thứ tự từng cặp, hai warm-up mỗi phía. Máy dùng chung; không đo GUI.

| Chỉ số | Trước | Sau A+B+B2+B3 |
|---|---:|---:|
| Trung vị N=20 | 8.582,6 ms | 5.232,4 ms |
| P95 nearest-rank | 10.941,7 ms | 6.081,0 ms |
| Khoảng | 7.395,7–12.108,3 ms | 3.997,6–6.122,9 ms |
| Bitmap | Cùng hash ở 22 cặp, gồm warm-up | Không hạ soundness |

Giảm trung vị khoảng 39%; đây là native-session render, không phải click-to-paint.
Trang vẫn mất vài giây, không tuyên bố tải tức thì. Evidence:
`docs/audit/VIEWER_BU_XEN_PERF_2026-09-11/after_paired_page3.json`.
Binary đo này là trước guard BBox không hữu hạn cuối cùng; guard được verify
riêng và cần chốt smoke cùng binary cuối trước khi báo hoàn tất.

## Kiểm cuối đang chốt

- Ma trận Rust cuối, native wheel/EXE dev cuối.
- Pixel/hash đủ 4 trang nguồn + 4 trang kết quả và budget máy yếu mô phỏng.
- Runtime worker active/prefetch, normal lane và shared-lane mô phỏng.
- Không dừng app/backend người dùng hoặc tự thay package đang được process cũ giữ.
- Chưa nghiệm thu click-to-paint trong WebView và chưa build installer/phát hành.
