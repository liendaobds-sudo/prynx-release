# Ưu tiên khung nét trước atlas khi zoom — 2026-09-23

## Ca người dùng và bằng chứng trước sửa

Người dùng báo sau các bản chống chớp/giảm nấc mờ vẫn làm nét chậm khi zoom.
Không điều khiển UI trong lượt này theo yêu cầu trước đó; không coi ca runtime
đã được giải quyết chỉ vì test xanh. File dùng đối chứng là poster retro trong
`test/` mà người dùng đã cung cấp; log app gần nhất có nhiều tài liệu, không
gán mọi timing trong log cho poster.

Log `PrynX_RenderPerf.log`, trace `Vmue5mzlm-ktpcw0`: zoom đổi target nhưng
`active_pan_grid_tiles=6–8`, `outer_enabled=false`, visible vẫn mang key cũ.
Viewport accurate có lượt 536–774 ms; job nền có lượt 1.753 ms, trong đó chờ
semaphore chiếm phần lớn. Không suy ra khung chính phải chờ đủ 1.753 ms: các
request chính được kiểm có `sem_wait_ms=0`, vấn đề thử nghiệm là tranh CPU.

Test tích hợp đỏ trước sửa: đã có ảnh accurate của trang nhưng raster mới chưa
xong, `getTileUrl` được gọi **5 lần thay vì 1**. Nguyên nhân:
`viewerPanGridRenderPolicy` dùng `accurateCommitted` có vòng đời cả trang để
mở near-grid ở cả zoom mới; `tileBuffer.visible` cũng có thể thuộc bucket cũ.

## Thay đổi nhỏ

- `LivePageFrame.tsx`: chỉ mở atlas khi surface đúng raster bucket hoặc coverage
  của plan hiện tại đã ready; trong lúc gom zoom không phát thêm job atlas.
- `livePageFramePolicy.ts`: thêm gate `targetRasterPending`, không đổi số worker,
  mật độ pixel, profile màu hay engine; sau frame chính mở lại toàn bộ atlas.
- `LivePageFrame.liveTile.test.tsx`: kiểm request đầu duy nhất, mở atlas sau decode,
  đổi zoom lại đợi đúng bucket và pan cùng zoom vẫn giữ surface/atlas.
- Consumer của policy: duy nhất `TileLayer`, cộng test trực tiếp.

## Đối chứng worker thật, không phải WebView

Harness `scripts/benchmark_zoom_runway.py` gọi binary có sẵn với
`--prynx-render-worker`, rẽ nhánh trước khởi tạo UI. Không build, thay binary,
kill app hay chạm worker của người dùng; chỉ tạo/dọn child của benchmark.

Trang 1, 188 DPI, viewport 1.344×832 px tại (1.024,512), sáu cell 512×512 px
cùng vùng. Làm ấm cả bảy vùng trước mỗi bộ; cùng process/session cho hai nhánh,
12 cặp đảo thứ tự chẵn/lẻ. Nhánh cũ gửi khung chính + sáu cell ngay; nhánh mới
đợi PNG chính rồi gửi sáu cell. Mọi request phải Ready/color-verified và PNG
phải cùng SHA-256 theo từng vùng. Không dùng số liệu để claim P95 toàn corpus.

- PDF SHA-256: `574af320396c766eb975b6b3d062aa99c0724f241ff4c107401426b2eddff9a1`.
- Binary dev hiện tại: `39098ab7e91f10dc7645e6385215ec2e3fb9bfce9ab43fdce1f7a9dd7a5b53bd`.
- PNG viewport: `a09d65ad896dac936b8c69456baec03dcf0f4b05746233da318069f690c48279`.
- Bảy PNG khớp qua cả hai nhánh, cả hai cấu hình; file/binary hash trước/sau khớp.

| Cấu hình | Trung vị khung chính trước | Sau | Toàn bộ 7 PNG trước → sau |
|---|---:|---:|---:|
| Auto phần cứng, không override | 346,60 ms | 262,99 ms (−24,1%) | 346,60 → 502,21 ms |
| Giả lập một slot, background=0 | 261,64 ms | 258,90 ms | 1.234,29 → 1.224,38 ms |

Đánh đổi có chủ ý: trên máy nhiều slot, ảnh người dùng nhìn thấy sớm hơn khoảng
84 ms nhưng các ô dự phòng hoàn tất muộn hơn khoảng 156 ms. Đây là ưu tiên
latency, **không phải tăng throughput mọi job**. Máy yếu mô phỏng gần như không
đổi; đây không thay thế phép đo trên CPU/RAM yếu thật.

Các cặp main-ms trên binary hiện tại (trước/sau):

| Cặp | Auto | Một slot |
|---|---|---|
| 0 | 348,26 / 265,62 | 261,68 / 262,36 |
| 1 | 344,85 / 263,92 | 254,91 / 258,09 |
| 2 | 339,94 / 258,53 | 258,33 / 259,38 |
| 3 | 347,46 / 256,87 | 264,26 / 261,04 |
| 4 | 342,08 / 262,52 | 271,00 / 255,19 |
| 5 | 354,24 / 266,32 | 262,05 / 255,74 |
| 6 | 347,04 / 257,73 | 261,60 / 261,24 |
| 7 | 340,88 / 259,33 | 252,57 / 258,83 |
| 8 | 351,32 / 275,44 | 276,26 / 258,97 |
| 9 | 352,02 / 263,85 | 293,30 / 257,25 |
| 10 | 330,86 / 255,54 | 257,57 / 258,27 |
| 11 | 346,16 / 263,46 | 258,53 / 263,23 |

Raw reports: `.tmp/zoom_runway_current_full_2026-09-23.json` và
`.tmp/zoom_runway_current_low_2026-09-23.json`. Giữ nguyên các lượt thăm dò
trước đó: binary example cũ `f51634b6…` cho 320→246 ms (6 cặp), 381→282 ms
(12 cặp); chúng không được trộn vào baseline binary hiện tại. Lượt low đầu
có trùng thời gian chạy typecheck, chỉ dùng lượt cuối chạy riêng cho kết luận.

## Verify và phần chưa xác minh

- Regression mới đỏ trước sửa, xanh sau sửa.
- Typecheck đạt; Viewer/policy/viewport/scheduler/coordinator **131/131 đạt**.
- ESLint policy + test liên quan đạt; không claim lint toàn file LivePageFrame
  hoặc toàn repo sạch (có code khác ngoài phạm vi).
- Chưa chạy lại thao tác zoom thực trên WebView, chưa đo input-to-sharp hoặc
  cảm giác pan ngay sau zoom. Không bảo đảm mức giảm worker 24% chuyển nguyên
  vẹn thành mức giảm thời gian người dùng nhìn thấy.
- Không sửa backend, Rust, DPI, màu, hay các thay đổi VDP đang làm dở.
