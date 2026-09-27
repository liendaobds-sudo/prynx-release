# Re-review audit độ nét/tốc độ PPE–PDFium — 27/09/2026

## Kết luận

**Chưa đủ điều kiện đóng audit.** Diff liên quan trực tiếp mới bổ sung một phần
telemetry của lô S0 và §SHARP.07; chưa có bằng chứng mới về tốc độ lên nét end-to-end, pixel
parity hay tối ưu raster/ICC. Đặc biệt, phép đo mới hiện có thể phân loại độ nét
ngược ở màn hình HiDPI và gán sai thao tác đầu vào.

Không phát hiện thay đổi raster, ICC, worker limit hoặc timer 48/96 ms trong
phần diff PPE/PDFium được kiểm. Việc chưa thay chúng không phải lỗi tự thân:
audit gốc yêu cầu có số đo đúng trước khi tối ưu.

## Phạm vi và mốc bằng chứng

- Mode: review diff hiện tại so với `HEAD 1c1c838`, không triển khai bản vá.
- Repo: `D:\pdfcompare`, Windows, khoảng 17:30–17:45 ngày 27/09/2026 (+07:00).
- Phạm vi chính: phần thêm telemetry trong `LivePageFrame.tsx`,
  `useTileRenderer.ts`, `previewPerfLog.ts`, `tileUrlCache.ts`,
  `scripts/report_viewer_perf.ps1`.
- Đã đọc thêm producer zoom, DPI bucket, TileLayer/presentation,
  render coordinator và test liên quan để kiểm đơn vị, identity, lifecycle.
- Có sửa song song trong workspace: lúc đầu 7 file, sau đó 9 file tracked bị
  thay đổi, gồm UI/VDP ở `NumberingTool`, `ToolUI`, `AcrobatViewer`,
  `useViewerZoom` và phần picker của `LivePageFrame`. Không đánh giá đây là
  một snapshot Git bất biến. UI/VDP ngoài audit chỉ kiểm tĩnh bổ sung và test
  có sẵn; không chứng nhận toàn bộ nghiệp vụ mới.
- Không build/release, không sửa source ứng dụng, không stage/commit, không
  cập nhật golden, không điều khiển app đang chạy. Chỉ thêm báo cáo này.
- Trust boundary chạm tới: telemetry FE → IPC/log cục bộ và bộ đọc log.
  Không có thay đổi auth/capability/native parser trong diff chính; không mở
  rộng lượt này thành audit bảo mật hệ thống.

### Dấu vân tay phần telemetry đã kiểm

| File | SHA-256 lúc kiểm |
|---|---|
| `desktop/src/components/workspace/LivePageFrame.tsx` | `A4B78DD450D51BAFD8CD4E906226E0DF7A61085D08FD57E739BAFE3D360D996E` |
| `desktop/src/hooks/viewer/useTileRenderer.ts` | `CD21EFFC2E859CC018A61941DE8DAF017DD7EBA56060CA1BA6974B002547292A` |
| `desktop/src/lib/previewPerfLog.ts` | `6BDEF5AECB0F068BB55E3E317FBFDAA367CF64BC0F293E16602A5A42171D53F9` |
| `desktop/src/lib/tileUrlCache.ts` | `4DCA926807A82EC4C1CC9E4DEE614F811D8346FD5440A481CCDBFF07BEAA7D6F` |
| `scripts/report_viewer_perf.ps1` | `334E42A8518C3203E9727E1F5C60F5EFC9083D55892B7B6A55352CB56044A897` |

## Findings

Tổng cộng **4 finding Accepted: 2 P1, 2 P2**; chưa áp dụng bản vá.

### §SHARP.R1 — P1 / M — So sánh raster scale với logical zoom làm sai cờ đã nét

**Trạng thái:** Accepted, đã xác minh logic bằng probe trên đoạn source thực;
chưa chạy màn hình WebView2 thật.

**Bằng chứng:** `desktop/src/components/workspace/LivePageFrame.tsx:736–751`:
`pixelRatio = scale / targetZoom` và
`Math.abs(scale - targetZoom) <= 0.05 * targetZoom`.

`scale` nhận từ `tileSpec.renderScale` (dòng 2169); TileLayer tạo nó từ
`sZoom * dpr`, rồi bucket PPE (dòng 1745–1751). Trong khi `zoom_target` của
`useViewerZoom.ts:498–500` là zoom UI, chưa nhân DPR.

Probe đọc và thực thi nguyên khối telemetry mới với clock/context giả:

| Zoom UI | DPR | Raster scale | Mật độ đúng theo target | Code báo ratio | Code báo sharp |
|---:|---:|---:|---:|---:|---|
| 1 | 2 | 2 | 1 | 2 | false |
| 1 | 2 | 1 | 0,5 | 1 | true |
| 1 | 1 | 1 | 1 | 1 | true |

Điều kiện sai số đối xứng ±5% còn loại cả ảnh dư mật độ do bucket hoặc zoom-out,
dù ảnh đó không phải underlay thiếu nét. X/y luôn bằng nhau nên cũng không phát
hiện sai tỷ lệ theo từng trục.

**Hướng sửa:** xác định pixel ratio bằng bitmap đã decode / kích thước CSS thực /
DPR, có xét rotation; tách đủ mật độ khỏi đúng target identity. Đã có phép đo
DOM tương tự trong `tile-frame-opportunity` (dòng 662–673), nhưng cần nối vào
gate coverage/proof thay vì chỉ kiểm một tỷ lệ scale. Thêm ca DPR 1/1,25/1,5/2,
bucket và zoom-out.

### §SHARP.R2 — P1 / M — Context zoom toàn cục gán nhầm input cho tile hoàn tất

**Trạng thái:** Accepted, xác minh bằng source và probe deterministic.

**Bằng chứng:** `previewPerfLog.ts:109–125` chỉ giữ một bộ epoch/target/sequence
cho toàn module; `LivePageFrame.tsx:736–746` đọc bộ này lúc commit. Không có
tab/document/page/revision để đối chiếu, không snapshot identity của input khi
target được nhận. Không reset khi đổi file; trace `zoom-input` hiện được phát
ở nhánh wheel, không bao quát mọi nút/menu/fit.

Probe: input A lúc 2000 ms, zoom 2; input B lúc 2200 ms, zoom 1; request A
commit lúc 2800 ms. Event giữ `request_id=A` nhưng mang attempt của B,
`target_scale=1` và latency 600 ms thay vì 800 ms của A. Trong app, một tab
đang render hoàn toàn có thể trả kết quả sau khi tab khác nhận input.

**Tác động:** p50/p95 và kết quả target cuối bị lẫn tài liệu/thao tác; mở file mới
hoặc dùng nút zoom có thể bị đo từ wheel cũ. Không thể dùng ID này làm chuỗi
input → request → worker → presentation theo §SHARP.01.

**Hướng sửa:** token theo tab/document/revision/camera; gắn token từ input qua
accepted target/request. Khi tái sử dụng ảnh phải đánh giá coverage của camera
hiện hành trong cùng scope; không tự coi input toàn app mới nhất là chủ request.

### §SHARP.R3 — P2 / M — Báo cáo tính phân bố mọi commit, không phải time-to-sharp

**Trạng thái:** Accepted, xác minh bằng bộ đọc PowerShell hiện tại với log tổng hợp.

**Bằng chứng:** `scripts/report_viewer_perf.ps1:73–77` cộng mọi
`input_to_commit_ms`, kể cả `is_target_sharp=false`; không group/deduplicate
theo attempt, không xét tile đã phủ viewport hay frame đã hiện. Output đặt
chúng dưới `time_to_sharp` tại dòng 133–137.

Probe một attempt có frame chưa nét ở 10 ms, frame nét đầu ở 1000 ms, một commit
khác ở 1200 ms: script trả `sharp_commits=3`, `target_sharp_commits=2`, phân bố
latency có `count=3`, `min=10`. Thực tế chỉ có một mẫu first target-sharp ở
1000 ms. Attempts không bao giờ sharp cũng không được đếm là thất bại.

Producer phát event ngay trong hàm vẽ canvas, trước callback chốt tile visible
(dòng 761–763); wrapper target/atlas có thể vẫn opacity 0. Vì thế chỉ lọc
`is_target_sharp=true` vẫn chưa đủ để chứng minh pixel người dùng nhìn thấy.

**Hướng sửa:** tách commit latency thô khỏi time-to-sharp; mỗi attempt chỉ lấy
mốc coverage/proof/density hợp lệ đầu tiên, báo riêng readable/sharp/target/idle,
cancel và các attempt thiếu completion. Nối frame opportunity/visibility;
không gọi DOM/rAF là bằng chứng scan-out.

### §SHARP.R4 — P2 / M — Nhánh ảnh fallback không phát sự kiện sharpness

**Trạng thái:** Accepted theo truy vết source; chưa ép lỗi decoder trong WebView2.

**Bằng chứng:** event mới chỉ nằm trong `renderBitmapToCanvas` ở
`LivePageFrame.tsx:743`. Khi `createImageBitmap` không có hoặc lỗi,
`useTileRenderer.ts:353–418` trả URL không có bitmap. Consumer đi qua
`preImg.onload` ở `LivePageFrame.tsx:1157–1250`, phát `tile-commit` và
`tile-first-pixel` nhưng không phát `tile-sharpness-commit`.

Trong fallback, `decodeMs` còn được chốt khi mới dựng PNG/BMP URL hoặc Blob,
trước phần decode thật của Image. Vì script chỉ đọc event mới, các ca fallback
biến mất khỏi mẫu sharpness, thay vì được biểu diễn là đường decode khác.

**Hướng sửa:** hook đo chung sau khi consumer canvas hoặc img hoàn tất decode;
tách tạo source/encode fallback khỏi decode, đánh dấu cache hit và thống kê
cùng terminal contract cho cả hai surface.

## Đối chiếu 8 finding gốc

| Finding | Tình trạng sau diff hiện tại |
|---|---|
| SHARP.01 | Mới có telemetry cục bộ; R1–R3 chặn dùng làm bằng chứng end-to-end. Chưa có p50/p95 worker/WebView hiện tại. |
| SHARP.02 | Chưa có phase profile raster/color/resource mới hoặc tối ưu native trong diff. |
| SHARP.03 | Chưa đổi state machine/timer trong diff telemetry; không nên tối ưu timer dựa trên số đo hiện tại. |
| SHARP.04 | Chưa thêm corpus pixel/ROI theo ma trận DPR/zoom; R1 khiến pixel gate hiện tại không đáng tin. |
| SHARP.05 | Có scale/ratio/proof metadata một phần, thiếu underlay age và coverage hợp lệ để chốt sharp. |
| SHARP.06 | Test mock cũ vẫn đạt; chưa có replay 20–48 ms với worker thật mới. |
| SHARP.07 | Có `decodeMs` cho ImageBitmap; fallback/presentation còn thiếu như R4. |
| SHARP.08 | Diff cache chỉ thêm trường timing, không bổ sung ledger/pressure/hit-miss/eviction hoặc phép đo A→B→A mới. Không suy rằng cơ chế cũ hoàn toàn không có pressure handling. |

## Verify và giới hạn

- Typecheck: lần đầu lỗi `__pathRebaseOnly` khi `AcrobatViewer` đang được sửa;
  sau khi kiểu được bổ sung bởi thay đổi song song, chạy lại **exit 0**.
- Vitest: **11 file / 231 test khác nhau đạt**. Trong đó 6 file baseline của
  audit gốc vẫn đạt **192 test**; thêm logger, Numbering sequence và 3 bộ
  AcrobatViewer. Một test sequence được chạy lặp, không đếm hai lần.
- Cảnh báo jsdom `HTMLCanvasElement.getContext` ở decoder fallback vẫn xuất
  hiện; không có test fail. Các test có sẵn chưa assert các field sharpness mới.
- Probe Node chỉ transpile hàm logger và thực thi khối telemetry đọc từ source
  trong VM với clock/source giả; probe PowerShell chạy phần parser hiện tại
  với 3 dòng log tổng hợp trong RAM. Đây là bằng chứng logic, **không phải
  benchmark ứng dụng hoặc chứng minh compositor**. Không tạo/chỉnh source test.
- `npm run lint`: **105 error / 24 warning** toàn repo tại thời điểm chạy.
  Không quy tất cả cho bản vá. Có một lỗi mới ngoài phạm vi telemetry:
  `useViewerZoom.ts:63` còn destructure `hasRightPanelTool` sau khi xóa chỗ dùng.
- `git diff --check` từng báo trailing whitespace ở NumberingTool; không coi
  whitespace là finding chức năng PPE và không tự sửa file của phiên khác.
- Chưa chạy GUI/WebView2, worker PPE corpus hiện tại, low/high RAM, pixel ROI,
  artifact parity hoặc benchmark trước/sau. Không có sửa backend/Rust nên không
  chạy pytest/cargo/maturin trong lượt này.

## Đề xuất lô tiếp theo — chờ duyệt

1. Sửa phép đo: R1/R2, scope input/request và test DPR/bucket/đa tab.
2. Nối completion hai loại surface + visibility/coverage, rồi sửa parser R3/R4;
   mỗi lô tối đa 5 file, verify riêng.
3. Chạy corpus worker/WebView2 theo audit gốc để quyết định timer/native phase.

Không nên báo “đã sửa xong độ nét/tốc độ” từ test policy xanh hoặc từ các
percentile commit hiện tại. Các finding trên là lỗi/thiếu sót đo lường; lượt
review này không chứng minh renderer đã chậm hơn hoặc làm thay đổi pixel.
