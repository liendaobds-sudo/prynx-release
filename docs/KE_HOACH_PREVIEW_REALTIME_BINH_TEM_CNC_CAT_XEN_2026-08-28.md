# KẾ HOẠCH CHI TIẾT — PREVIEW REALTIME TRÊN VÙNG XEM CHÍNH CHO BÌNH TEM BẾ / CNC / CẮT XÉN

**Ngày lập:** 2026-08-28

**Trạng thái:** Chờ duyệt — chưa triển khai code

**Phạm vi:** Desktop React/Tauri + FastAPI sidecar + các renderer bình hiện hữu

**Nguyên tắc triển khai:** Mỗi lô tối đa 5 file, verify xong từng lô mới sang lô kế tiếp

---

## 1. Kết luận kiến trúc

Có thể nâng preview của cả ba tính năng từ mô phỏng đường/cell sang **xem trực tiếp tờ bình có artwork ngay trong vùng xem chính**.

Phương án được chọn không tạo lại PDF đầy đủ sau mỗi lần người dùng chỉnh thông số. Preview gồm hai tầng:

1. **Live compose:** nhận đúng layout/manifest đã được chấp nhận, lấy texture trang nguồn đã cache, rồi dựng artwork bằng affine + clip trên Canvas/OffscreenCanvas. Tầng này phản hồi ngay khi đổi khổ giấy, lề, khe hở, chiến lược, tờ hoặc mặt.
2. **Exact proof:** sau khi người dùng dừng thao tác 300–500 ms, backend dựng một ảnh proof từ **chính session + manifest/fingerprint đó**, rồi frontend decode xong mới thay frame theo kiểu atomic swap.

`GridPreview` bên phải và vùng xem chính phải dùng chung một layout/session. Không được solve hai lần, không được tự suy lại vị trí ở frontend, và không được để exporter chọn một layout khác.

Kiến trúc đích:

```text
Thiết lập bình trong ImposerDashboard
        │
        ▼
GridPreview tính/nhận đúng một layout hoặc placement manifest
        │ publish normalized scene vào session riêng của tab
        ├─────────────────────────────┐
        ▼                             ▼
Mini preview bên phải          Main live preview
(số liệu + wireframe)          (artwork + CUT/xén/marks)
                                      │
                                      ├─ compose texture tức thời
                                      └─ exact proof sau idle
                                                │
                                                ▼
                              export tái dùng đúng manifest/fingerprint
```

---

## 2. Mục tiêu sản phẩm

### 2.1. Mục tiêu bắt buộc

- Khi layout sẵn sàng, vùng xem chính hiển thị tờ bình thật thay vì chỉ hiển thị file nguồn.
- Người dùng thấy artwork, vị trí, hướng xoay, clip, đường bế/xén, dấu và mặt tờ cập nhật theo thay đổi mới nhất.
- Giữ nguyên preview nhỏ bên phải để xem số lượng, sức chứa, cut tree và thao tác nhanh.
- Chuyển tờ/mặt, fit, zoom và pan không gọi solver lại.
- Không nháy trắng khi đang cập nhật; frame hợp lệ gần nhất luôn được giữ lại.
- Preview và file xuất phải cùng source revision, layout fingerprint, placement và side mapping.
- Tab nền không chạy tác vụ **preview-owned** hoặc giữ timer preview; job Bình/Xuất do người dùng đã bấm vẫn tiếp tục theo scheduler.
- Lỗi encode/decode/transport chỉ thuộc preview không được chặn xuất. Lỗi source revision, manifest/fingerprint hoặc render contract phải làm session stale và chặn exact-export reuse.

### 2.2. Ngoài phạm vi lượt đầu

- Không thay Acrobat Viewer bằng viewer mới.
- Không đổi Working PDF, document revision, dirty/undo hoặc thumbnail chỉ để phục vụ preview.
- Không raster hóa file xuất sản xuất.
- Không viết lại solver bình tem, CNC hoặc cắt xén.
- Không đưa WebGL vào ngay nếu Canvas/OffscreenCanvas đã đạt SLA.
- Không tuyên bố “proof chính xác” cho một lane legacy chưa chứng minh preview/export parity.

---

## 3. Bằng chứng hiện trạng

### 3.1. Luồng frontend chung

Ba tính năng đều đi qua:

```text
ImpositionTab
  → ImposerDashboard
    → GridPreview
```

`desktop/src/components/imposition-tools/sections/GridPreview.tsx` hiện đã có nền tốt:

- debounce 250 ms;
- `AbortController` khi key đổi;
- generation guard chống response cũ;
- cache và stale-while-revalidate;
- một response có thể chứa nhiều tờ;
- hỗ trợ front/back và mixed duplex;
- vẽ cell, contour, cut line/cut segment/cut tree.

Khoảng trống hiện tại:

- chỉ vẽ SVG hình học, chưa paint artwork nguồn;
- `layoutResult`, loading, error và `activeSheet` thuộc local state của `GridPreview`, vùng chính không dùng lại được;
- `ImposerDashboard` đã nhận `tabId/isActive` nhưng chưa gate toàn bộ `GridPreview`, trong khi các tab nền vẫn mounted;
- contract legacy còn trộn point/mm và top-down/bottom-up;
- một số nhánh chưa có source binding, clip và affine đủ để dựng artwork đúng.

### 3.2. Điểm gắn vùng xem chính

Điểm gắn phù hợp là ngay sau `OutputPreviewHost` trong:

`desktop/src/components/ImpositionTab.tsx` (khoảng dòng 4079).

Overlay đích:

- `top-12` để giữ toolbar Acrobat cao 48 px;
- `left-0`, `bottom-0`;
- `right: effectiveRightToolMenuWidth` để không phủ panel thiết lập;
- lớp `z-40`, nằm dưới processing/error/modal;
- giữ `AcrobatViewer` mounted ở dưới để không làm mất trạng thái viewer.

Không dùng `pageOverlay` của Acrobat Viewer vì overlay đó bám từng trang nguồn, còn tờ bình có khổ, số tờ và số mặt khác tài liệu nguồn. Không thay `file/pdfUrl` của workspace bằng file proof vì sẽ làm sai revision, undo, thumbnail và provenance.

### 3.3. Backend theo từng luồng

| Luồng | Dữ liệu layout hiện có | Phần còn thiếu để paint artwork đúng |
|---|---|---|
| Bình cắt xén | `pageIdx`, vị trí tuyệt đối, rotation; mixed guillotine có `cutSegments`, `cutTree`, `side`, `physicalSheetIndex`, `planHash` | source revision, page boxes, source clip, source→part affine, asset ID |
| Tem S&R | vị trí, rotation, `diePolylines` cùng transform export | `pageIdx` rõ ràng, binding, clip, revision, asset |
| Tem mixed/homogeneous | `pageIdx`, multi-sheet, die polygon/polyline | page boxes, source affine/clip, revision, asset |
| CNC Front | `pageIdx`, placement, die polygon, multi-sheet | Back binding/frame, Cut side, clip, revision, asset |
| CNC Back | mới có cờ two-sided/flip-edge | scene Back hoàn chỉnh |
| CNC Cut | renderer đã có đường khuôn | side descriptor; không paint artwork |

Nền contract canonical cho Tem/CNC true-shape đã tồn tại:

- `PlacementManifest` và `PlacementRecord` trong `imposition_core`;
- `PageBoxesV1`, `PageBindingV2`, `RenderSourceV2`, `RenderBundlePartV2`;
- `ProductionNestingSession` trong `backend/app/core/nesting_production_pipeline.py`;
- `solve_production_nesting_job(...)` solve một lần;
- `render_production_nesting_session(...)` render nhiều lần cùng session;
- CTM chuẩn trong `resolve_manifest_artwork_placement(...)` / `manifest_artwork_render_ctm_mm(...)`;
- sheet frame Front/Back/Cut trong `nesting_imposition_bundle.py`;
- writer thật trong `nesting_imposition_render.py`.

Điểm chưa nối: route Imposition và `processHandlers` chưa dùng production session này; cắt xén chưa có session immutable tương đương; proof/asset/session registry chưa có endpoint production.

Ngoài ra, writer production true-shape hiện đã có parity artwork/CUT nhưng chưa có bằng chứng tiêu thụ đầy đủ `marks`/`artifactOptions`. Cho đến khi nối và test xong, capability phải tách rõ `artwork`, `cut` và `marks`; không gắn nhãn exact cho dấu/pont chỉ vì artwork đã đúng.

---

## 4. Hành vi UX đích

### 4.1. Chế độ hiển thị

Trong vùng xem chính có nút chuyển:

- **File gốc**: Acrobat Viewer hiện hữu.
- **Tờ bình**: live preview của layout đang chọn.

Mặc định đề xuất:

- Khi người dùng chưa vào một trong ba công cụ hoặc layout chưa sẵn sàng: hiện File gốc.
- Khi đang ở Bình cắt xén / Bình tem bế / Bình CNC và layout đã sẵn sàng: tự chuyển sang Tờ bình lần đầu.
- Sau khi người dùng tự chọn File gốc/Tờ bình, giữ lựa chọn đó trong session của tab; không tự giật lại.

### 4.2. Thanh điều khiển vùng chính

- Tờ `n/N`.
- Mặt:
  - Bình cắt xén: Front/Back khi có duplex.
  - Bình tem bế: Front và tùy chọn lớp Dao cắt/CUT khi workflow có tách dao.
  - Bình CNC: Front/Back/Cut hoặc Front/Cut.
- Fit tờ, 100%, zoom +/− và pan.
- Bật/tắt:
  - Artwork;
  - Đường bế/xén;
  - Dấu/pont/canh;
  - thông tin chẩn đoán nội bộ khi dev flag bật.
- Trạng thái gọn:
  - “Đang cập nhật…” khi frame cũ vẫn còn;
  - “Bản xem nhanh” khi mới compose;
  - “Bản xem chính xác” khi proof cùng fingerprint đã áp dụng;
  - lỗi có hướng xử lý, không phủ mất frame.

### 4.3. Đồng bộ mini preview và main preview

Selection dùng chung:

```ts
type PreviewTarget = {
  physicalSheetIndex: number;
  face: "front" | "back" | "cut";
};
```

- Chọn tờ/mặt ở một nơi cập nhật nơi còn lại.
- Selection không tham gia layout key; đổi selection không solve lại.
- Nếu target không tồn tại sau layout mới, chọn target hợp lệ gần nhất theo thứ tự Front → Back → Cut.

---

## 5. Session và hợp đồng nhất quán

### 5.1. Ownership

Mỗi tab có đúng một preview session riêng. Identity tối thiểu:

```text
tabId + previewSourceKey/documentRevision + activeTool + layoutFingerprint
```

Không dùng cờ active, generation, target hoặc object URL toàn cục. Hai tab mở cùng một file vẫn độc lập về lifecycle; asset cache bất biến có thể dùng chung theo content key nhưng owner/ref-count phải rõ.

Provider/session đặt cùng cấp các provider workspace trong `ImpositionTab`, không để `ImpositionTabInner` subscribe toàn bộ Imposer store vì file này đã có ghi nhận việc subscribe rộng từng làm shell Viewer chậm 3–4 giây.

### 5.2. State machine frontend

```text
disabled
  → waiting-source
  → layout-debouncing
  → layout-loading
  → layout-ready
  → render-loading
  → ready

ready → stale → ready
              ↘ recoverable-error
```

Một response chỉ được publish khi đồng thời khớp:

- `tabId`;
- session key;
- client generation;
- request ID;
- source revision;
- manifest ID/layout fingerprint hoặc plan hash;
- target sheet/face.

Decode bitmap xong mới swap. Không set frame về `null` khi request mới bắt đầu hoặc proof lỗi.

### 5.3. `PreviewSessionV1`

Backend trả session opaque, không lộ đường dẫn máy:

```text
schemaVersion
sessionId
ownerId
clientGeneration
requestRevision
state                    # solving | ready | stale | failed
manifestId
layoutFingerprint
renderBundleHash
sourceRevisions[]
expiresAt
capabilities             # geometry | liveArtwork | proof | exactExportReuse
```

Registry giữ session, source pin, owner/ref-count và TTL. Supersede, cancel, expire hoặc đóng tab phải thu hồi đúng tài nguyên. Export nhận `sessionId + manifestId + layoutFingerprint`; mismatch trả 409, không tự solve lại.

`/impose-start` hiện khởi chạy worker ở process khác, vì vậy “session” phải là identity logic có dữ liệu bất biến đọc lại được, không phải chỉ là một Python object trong RAM của route:

- persist atomic manifest + render bundle/source locator hashes bằng store production hiện hữu;
- registry giữ opaque ID và lease, không giữ SSOT chỉ trong object graph;
- payload sang worker chỉ mang `sessionId + manifestId + layoutFingerprint + renderBundleHash`;
- worker rehydrate bundle, kiểm owner/source revision/hash rồi render;
- không pickle/truyền thẳng `ProductionNestingSession` qua process boundary;
- session/store mất hoặc hash lệch phải trả 409/fail-closed, không solve lại.

### 5.4. `PreviewSceneV1`

Contract scene dùng duy nhất hệ:

```text
unit: mm
origin: bottom_left
x: sang phải
y: hướng lên
affine: [a, b, c, d, e, f]
```

Scene tối thiểu:

- session/manifest/fingerprint/generation;
- `parts`: bản an toàn của render bundle, không chứa local path;
- `placements`: pose authoritative;
- `sheets`: khổ, sheet index, side và `sheetFrame`;
- binding Front/Back/Cut;
- artwork clip, CUT/trim/cut tree/marks;
- opaque `assetId`.

CTM canonical:

```text
SheetFrame × Pose × SourcePageToCanonical
```

Không persist một CTM độc lập thứ hai. Nếu response trả CTM đã tính để client dùng nhanh, backend phải kiểm parity với pose/binding/sheet frame trước khi publish.

### 5.5. `PreviewAssetV1`

```text
assetId
url
locatorId
sourceRevision
pageIndex
renderBox
dpi hoặc pixelWidth/pixelHeight
pixelToSourcePageMm
renderVariant
mimeType
etag
```

`pixelToSourcePageMm` là bắt buộc vì pixel dùng gốc trái-trên, còn canonical scene dùng gốc trái-dưới. Descriptor này cũng ngăn frontend áp `/Rotate` hai lần.

Cache key tối thiểu:

```text
sourceRevision + pageIndex + renderBox + resolutionTier + renderVariant
```

Một trang nguồn chỉ raster một lần cho cùng key, sau đó reuse cho mọi placement trên tờ.

### 5.6. Bề mặt route

Tách router preview riêng để không tiếp tục phình `imposition.py`, nhưng vẫn giữ namespace `/api/imposition`:

```text
POST   /api/imposition/preview-sessions
GET    /api/imposition/preview-sessions/{sessionId}/scene
GET    /api/imposition/preview-assets/{assetId}
POST   /api/imposition/preview-sessions/{sessionId}/proofs
DELETE /api/imposition/preview-sessions/{sessionId}
```

- POST create/supersede nhận client generation và stable layout identity; không nhận raw local path ngoài resolver hiện hữu.
- GET scene chỉ trả scene đúng owner/revision/fingerprint.
- GET asset hỗ trợ `etag`/conditional response và không lộ locator/path nội bộ.
- DELETE idempotent, chỉ release tài nguyên do session sở hữu.
- Export vẫn đi entry production hiện hữu nhưng phải nhận exact session/manifest/fingerprint khi capability `exactExportReuse` bật.

### 5.7. Exact proof

Endpoint đề xuất:

```text
POST /imposition/preview-sessions/{sessionId}/proofs
```

Request:

```text
clientGeneration
manifestId
layoutFingerprint
physicalSheetIndex
face
targetDpi hoặc maxPixelSize
```

Response phải echo session/manifest/fingerprint/generation/target và trả proof asset + fidelity. Proof true-shape gọi `render_production_nesting_session(...)`, tuyệt đối không solve. Với cắt xén/legacy, chỉ gắn nhãn “chính xác” sau khi proof và export cùng dùng một placement plan immutable.

Proof chỉ dựng `physicalSheetIndex + face` được yêu cầu bằng primitive của production writer. Không render toàn bộ tài liệu nhiều tờ cho mỗi lượt idle. Nếu writer hiện chỉ có entry render toàn bộ, Lô 7a/7b/7c tương ứng phải tách primitive render một side dùng chung rồi mới mở endpoint; không sao chép lại logic affine/clip.

---

## 6. Renderer realtime phía frontend

### 6.1. Lựa chọn công nghệ

Khởi đầu bằng Canvas 2D + OffscreenCanvas khi runtime hỗ trợ:

- phù hợp raster texture + affine + even-odd clip;
- dễ kiểm corner mapping/parity;
- ít phụ thuộc và ít rủi ro hơn WebGL;
- có thể cache bitmap/Path2D theo asset/part key.

Chỉ nâng sang WebGL2 nếu benchmark đại diện không đạt một trong các điều kiện:

- P95 compose cached texture > 50 ms;
- zoom/pan tụt dưới 45 FPS ở tờ đại diện;
- số placement lớn làm main thread block > 50 ms lặp lại.

Không chọn WebGL chỉ theo cảm giác.

### 6.2. Thứ tự layer

1. Nền workspace, bóng và biên tờ.
2. Artwork bitmap theo CTM + clip.
3. CUT/trim/cut segment/cut tree/marks dạng vector.
4. Nhãn tờ/mặt và diagnostics.
5. Veil loading/stale/error trong suốt.

### 6.3. Quy tắc paint

- Front/Back paint artwork theo page binding.
- Cut không paint artwork trừ khi contract workflow quy định rõ; mặc định chỉ vẽ vector dao.
- CNC Back dùng `sheetFrame` mirror đúng một lần:
  - cạnh dài: `[-1,0,0,1,sheetWidth,0]`;
  - cạnh ngắn: `[1,0,0,-1,0,sheetHeight]`.
- Không vừa mirror placement vừa mirror canvas.
- Clip theo `artworkClipPath`/source clip, không fit ảnh vào bounding box.
- Zoom/pan chỉ đổi display transform; không làm thay đổi CTM production.
- Khi cần độ phân giải cao hơn, chỉ nâng resolution tier cho target đang xem.

---

## 7. Adapter theo từng công cụ

### 7.1. Bình cắt xén

Nguồn layout ưu tiên:

- mixed guillotine: reuse plan đã materialize cho renderer, khóa bằng `planHash`;
- sequential/cut-stacks/ratio-stack/S&R: normalize placement hiện hữu thành scene và thêm source binding;
- tuyệt đối không để preview gọi solver khác với exporter.

Adapter phải materialize:

- `pageIdx`/page instance;
- source revision;
- MediaBox/CropBox/TrimBox + `/Rotate`;
- effective trim/bleed/source clip từ `resolve_guillotine_geometry(...)`;
- source→part transform;
- duplex side mapping;
- cut segment/cut tree cùng plan hash.

Giai đoạn đầu có thể bật live artwork cho cắt xén trước vì layout phần lớn là cardinal và contract mixed guillotine đã có plan hash. Tuy nhiên chỉ bật badge exact proof khi đã có test proof–artifact parity.

### 7.2. Bình tem bế

S&R, homogeneous và mixed phải normalize về cùng scene:

- binding trang nguồn rõ ràng cho mọi placement;
- artwork clip theo khuôn/bleed thực;
- `diePolylines`/CUT dùng cùng transform export;
- holes/multipolygon giữ đúng winding/even-odd;
- homogeneous registration không được thay bằng fit bbox;
- multi-sheet giữ đúng page binding và placement.

Với `true_shape_nesting`, dùng thẳng `ProductionNestingSession` và RenderBundleV2. Với lane legacy, cần đóng placement plan/session immutable trước khi gọi proof “chính xác”.

### 7.3. Bình CNC

Scene phải mô tả đủ:

- Front page indices `0,2,4...` và Back tương ứng `1,3,5...` khi duplex;
- Front/Back/Cut side cho từng physical sheet;
- sheet frame long-edge/short-edge;
- Back page binding riêng;
- Cut identity với Front và không paint artwork;
- simplex/duplex, S&R/gang, multi-sheet.

Điểm chặn sản phẩm cần giải quyết trước khi công bố Cut exact: bộ dò hiện có thể chỉ trả silhouette ngoài và mất holes. Renderer đã hỗ trợ holes, nhưng resolver phải cung cấp được nguồn contour có lỗ hoặc workflow phải quy định nguồn khuôn do người dùng khai. Không được tự fallback bbox.

---

## 8. Hiệu năng và thời gian một tờ

### 8.1. Baseline đã quan sát

Các số sau là baseline hiện trạng/đường tương tự, không phải cam kết cuối:

| Công đoạn | Thời gian quan sát |
|---|---:|
| Layout cache miss ca thường | P50 khoảng 71–86 ms |
| Tile/texture ca thường | khoảng 35–225 ms |
| Ca layout/render nặng | khoảng 0,8–1,6 giây |
| Cache RAM | khoảng 0–2 ms |
| Cache đĩa | khoảng 0–9 ms |

Với debounce hiện tại 250 ms, từ lần gõ cuối đến frame layout thường sẽ khoảng 0,32–0,45 giây trước khi tính thời gian texture. Khi texture đã cache, compose lại cùng tờ chỉ nên mất một vài frame.

### 8.2. Mục tiêu nghiệm thu

| Chỉ số | Mục tiêu |
|---|---:|
| Compose một tờ từ texture đã cache | P50 ≤ 16 ms; P95 ≤ 50 ms |
| Frame tương tác đầu tiên, file thường | P50 ≤ 300 ms; P95 ≤ 700 ms, đo từ sau debounce |
| Chuyển tờ/mặt đã cache | P95 ≤ 100 ms |
| Zoom/pan | mục tiêu 60 FPS; không dưới 45 FPS kéo dài trên corpus đại diện |
| Response aborted/stale được áp dụng | 0 |
| Frame trắng khi cập nhật/lỗi | 0 |
| Solver call preview → export cùng fingerprint | đúng 1 |

Ước lượng trải nghiệm một tờ:

- **Đã có layout + texture cache:** khoảng 16–50 ms để compose.
- **Mở lần đầu, file thường:** khoảng 0,3–0,7 giây để có live artwork.
- **Ca phức tạp/nhiều đối tượng:** khoảng 0,8–1,6 giây; vẫn giữ wireframe/frame cũ trong lúc chờ.
- **Exact proof:** chạy sau idle và cần đo riêng theo corpus; không được chặn tương tác.

Trước khi khóa SLA production phải ghi P50/P95 cho: time-to-layout, time-to-first-artwork, time-to-exact-frame, peak RSS, asset-cache hit rate và solver call count.

### 8.3. Chính sách phần cứng

- `<8 GB RAM`: giảm resolution tier/prefetch/cache theo profile máy yếu.
- `8–<16 GB RAM`: giảm nhẹ.
- `≥16 GB RAM`: giữ chất lượng và concurrency đầy đủ; không hard-cap vô điều kiện.
- Texture/proof ngắn không chiếm `heavy_job_scheduler` toàn máy.
- True-shape solve dùng grant N-Up/CNC hiện hữu, không tạo nested heavy job.
- Mọi lời gọi PDFium trong thread phải nằm trong `pdfium_guard()`; giữ lock chỉ quanh PDFium, encode ảnh ở ngoài lock.

---

## 9. Cache, hủy và quản lý bộ nhớ

### 9.1. Cache tầng frontend

- `ImageBitmap` theo asset ID/etag/resolution tier.
- `Path2D` theo part + clip revision.
- composed frame theo session fingerprint + target + layer visibility + resolution tier.
- Object URL có owner/ref-count; đóng một tab không revoke asset tab khác đang dùng.
- Không cache frame không khớp source revision.

### 9.2. Cache tầng backend

- Coalesce request cùng asset key.
- Cache content-addressed theo revision/page/box/DPI/variant.
- TTL/ref-count gắn session owner.
- Session superseded không được publish asset/proof mới.
- Không nhận raw local path từ client và không trả local path trong response.

### 9.3. Lifecycle bắt buộc

- Settings/source/tool đổi: tăng generation, abort layout/render/proof cũ.
- Active → background: clear debounce, abort request và ngừng render **preview-owned**; không cancel job Bình/Xuất đã submit.
- Background → active: dùng frame đúng session nếu còn hợp lệ; revalidate chỉ khi key đổi.
- Đổi khỏi ba tool: ẩn overlay và dispose tài nguyên riêng của tool.
- Đóng tab: abort, tháo listener, release backend session/pin, revoke object URL đúng owner.
- Cancel/restart sidecar: session cũ thành stale; không hiển thị asset cũ như kết quả mới.

---

## 10. Fallback và xử lý lỗi

### 10.1. Trước khi có final layout/manifest

- Được giữ wireframe legacy hoặc frame cuối gần nhất.
- Nếu lane có baseline fallback, phải ghi provenance.
- Không gọi một solver thứ hai để “cố lấy preview”.

### 10.2. Sau khi có final manifest/fingerprint

- Preview/export chỉ dùng đúng manifest/fingerprint đó.
- Mismatch/stale trả 409; không solve lại và không đổi winner.
- Thiếu contour, source revision lệch, manifest/fingerprint mismatch hoặc renderer contract không hợp lệ: làm session stale và fail-closed; exact export phải dừng, không bbox/snap/raster fallback hay solve lại âm thầm.
- Nhánh không resolve được file/source binding chỉ được trả `geometry_only`; không được paint một ảnh đoán theo cell.
- Render artwork lỗi: giữ geometry/frame hợp lệ cùng manifest và báo “Chưa dựng được ảnh chính xác”. Retry chỉ render trên cùng manifest.
- Chỉ lỗi preview-only như timeout tải proof, encode/decode ảnh hoặc UI paint mới không chặn nút Bình/Xuất khi pipeline xuất đã tự validate hợp lệ. Lỗi contract/revision/hash phải chặn xuất và yêu cầu tạo session mới.

### 10.3. Nhãn fidelity

| Trạng thái | Nhãn UI |
|---|---|
| Chỉ có layout hình học | Xem trước bố cục |
| Scene + texture compose | Bản xem nhanh |
| Proof cùng immutable plan/manifest | Bản xem chính xác |
| Tải/encode/decode proof lỗi, contract vẫn hợp lệ | Bản xem nhanh — chưa dựng được proof |

---

## 11. Kế hoạch triển khai theo lô

Mỗi lô dưới đây tối đa 5 file. File test được tính vào lô. Nếu khảo sát thực tế làm vượt 5 file, phải tách lô và cập nhật tài liệu trước khi sửa.

### Lô 0 — Baseline và khóa contract đo lường

**Mục tiêu:** Có số đo thật trước khi thêm renderer.

**File dự kiến (≤4):**

- `desktop/src/lib/previewPerfLog.ts`;
- test tương ứng;
- `backend/app/core/preview_perf_log.py` hoặc điểm telemetry preview hiện hữu;
- test tương ứng.

**Việc làm:**

- đo time-to-layout, first artwork, exact frame, cache hit/miss, dropped stale frame;
- thêm corpus tối thiểu cho ba tool, single/multi-sheet và CNC duplex;
- ghi RAM profile mà không áp cap mới.

**Cổng:** Baseline có P50/P95 và không đổi hành vi hiện hữu.

### Lô 1 — Schema session/scene/asset/proof

**Mục tiêu:** Khóa wire contract trước route và UI.

**File dự kiến (≤4):**

- mới `backend/app/schemas/imposition_preview.py`;
- mới `backend/tests/test_imposition_preview_schema.py`;
- `backend/app/schemas/imposition.py` nếu cần nối status/capability;
- test OpenAPI hiện hữu hoặc test mới trong cùng file schema test.

**Cổng:** Pydantic `extra="forbid"`, enum side/unit/origin, không lộ path, round-trip ổn định.

### Lô 2 — Registry và lifecycle backend

**Mục tiêu:** Session opaque theo owner/TTL, generation latest-wins.

**File dự kiến (≤4):**

- mới `backend/app/core/imposition_preview_session.py`;
- mới `backend/tests/test_imposition_preview_session.py`;
- `backend/app/core/artifact_lease.py` nếu cần reuse lease/pin;
- test lease/lifecycle liên quan.

**Cổng:** owner isolation, supersede/cancel/TTL cleanup, source stale, không rò pin.

### Lô 3 — Scene builder canonical dùng chung

**Mục tiêu:** Dựng `PreviewSceneV1` từ canonical pose/binding/frame.

**File dự kiến (≤5):**

- mới `backend/app/core/imposition_preview_scene.py`;
- `backend/app/workers/imposition_affine.py`;
- `backend/app/core/nesting_imposition_bundle.py`;
- mới `backend/tests/test_imposition_preview_scene.py`;
- `backend/tests/test_imposition_affine_parity.py`.

**Cổng:** map đúng bốn góc 0/90/180/270, long/short mirror, CUT identity, mm bottom-left duy nhất.

### Lô 4 — Adapter cắt xén

**Mục tiêu:** Chuẩn hóa mixed guillotine và lane cắt xén legacy thành scene gắn plan hash.

**File dự kiến (≤5):**

- mới `backend/app/workers/guillotine_preview_scene.py`;
- `backend/app/workers/mixed_guillotine_adapter.py`;
- `backend/app/workers/nup_layout_solver.py`;
- `backend/tests/test_mixed_guillotine_preview.py`;
- `backend/tests/test_guillotine_preview_live_pages.py`.

**Cổng:** S&R/sequential/cut-stacks/ratio-stack/mixed có binding, clip, revision, multi-sheet/duplex đúng; không solve thêm.

### Lô 5 — Adapter Tem bế/CNC và production session

**Mục tiêu:** Scene true-shape reuse đúng `ProductionNestingSession`; bổ sung lane/side còn thiếu.

**File dự kiến (≤5):**

- `backend/app/core/nesting_production_pipeline.py`;
- `backend/app/core/nesting_production_adapter.py`;
- `backend/app/core/nesting_imposition_bundle.py`;
- `backend/tests/test_nesting_production_pipeline.py`;
- `backend/tests/test_nesting_imposition_bundle.py`.

**Cổng:** preview + export cùng manifest/fingerprint/renderBundleHash, solver call = 1; Front/Back/Cut đúng.

### Lô 6 — Session/scene và asset texture endpoints

**Mục tiêu:** Phơi session/scene có owner fence; raster trang nguồn một lần theo source revision và trả descriptor affine pixel.

**File dự kiến (≤5):**

- mới `backend/app/api/routes/imposition_preview.py`;
- `backend/app/main.py` để đăng ký router;
- mới `backend/app/core/imposition_preview_asset.py`;
- mới `backend/tests/test_imposition_preview_api.py`;
- mới `backend/tests/test_imposition_preview_asset.py`;

Ưu tiên dùng API hẹp đã có của `RustBridge`. Nếu đo đạc cho thấy bắt buộc sửa `rust_bridge.py`, tách thành Lô 6b cùng test guard; không thêm file thứ sáu vào Lô 6.

**Cổng:** create/get/delete session đúng owner/generation; scene đúng fingerprint; cache key đủ revision/page/box/DPI/variant, coalesce request, `pixelToSourcePageMm` đúng bốn góc, PDFium guard đúng phạm vi, encode ngoài lock, không heavy slot.

### Lô 7a — Exact proof cho production true-shape

**Mục tiêu:** Dựng proof theo target từ cùng session, không solve.

**File dự kiến (≤5):**

- mới `backend/app/core/imposition_preview_proof.py`;
- `backend/app/api/routes/imposition_preview.py`;
- `backend/app/workers/nesting_imposition_render.py`;
- mới `backend/tests/test_imposition_preview_proof.py`;
- `backend/tests/test_nesting_imposition_render.py`.

**Cổng:** generation/fingerprint fence, proof–artifact raster parity, lỗi preview-only không đổi manifest; lỗi contract/revision/hash làm session stale và chặn exact export.

### Lô 7b — Immutable render plan và proof cho Bình cắt xén

**Mục tiêu:** Cho S&R/sequential/cut-stacks/ratio-stack/mixed guillotine render một target từ đúng plan mà exporter dùng; không gọi solver lần hai.

**File dự kiến (≤5):**

- mới `backend/app/core/legacy_imposition_render_plan.py`;
- `backend/app/workers/nup_engine.py`;
- `backend/app/workers/nup_process_chunk.py`;
- mới `backend/tests/test_imposition_preview_proof_guillotine.py`;
- `backend/tests/test_preview_export_parity.py`.

**Cổng:** cùng plan hash/placement/source binding cho proof và artifact; render đúng một physical sheet/face; proof–artifact raster parity đạt cho đủ năm lane cắt xén. Chưa đạt cổng này thì Cắt xén chỉ có “Bản xem nhanh”, chưa có badge exact.

### Lô 7c — Proof cho Tem/CNC legacy

**Mục tiêu:** Mở đường proof cùng immutable plan cho lane Tem/CNC chưa đi production true-shape.

**File dự kiến (≤5):**

- `backend/app/core/imposition_preview_proof.py`;
- `backend/app/workers/nup_engine.py`;
- `backend/app/workers/cnc_render.py`;
- mới `backend/tests/test_imposition_preview_proof_legacy_diecut_cnc.py`;
- `backend/tests/test_cnc_mirror_and_exclude.py`.

**Cổng:** Tem legacy giữ clip/CUT/bleed; CNC Front/Back/Cut giữ side mapping và mirror đúng một lần; proof–artifact parity đạt trước khi capability `proof` bật cho từng lane.

### Lô 8 — Frontend session contract per-tab

**Mục tiêu:** Có provider/store hẹp, không subscribe toàn Imposer store.

**File dự kiến (≤4):**

- mới `desktop/src/components/imposition-preview/types.ts`;
- mới `desktop/src/components/imposition-preview/useImpositionPreviewSession.tsx`;
- mới test session;
- `desktop/src/components/ImpositionTab.tsx` chỉ để mount provider nếu cần ở lô này.

**Cổng:** hai tab độc lập, dispose đúng owner, target chung, stale generation không publish.

### Lô 9 — GridPreview là producer duy nhất

**Mục tiêu:** Publish layout/cache hit vào session và dừng toàn bộ việc preview-owned ở tab nền.

**File dự kiến (≤3):**

- `desktop/src/components/imposition-tools/ImposerDashboard.tsx`;
- `desktop/src/components/imposition-tools/sections/GridPreview.tsx`;
- `desktop/src/components/imposition-tools/sections/GridPreview.mixedDuplex.test.tsx` hoặc test lifecycle mới.

**Cổng:** inactive không fetch preview; active→inactive abort preview request nhưng không cancel job Bình/Xuất; cache hit publish; selection không solve lại; response cũ áp dụng = 0.

### Lô 10 — Client API và render-request hook

**Mục tiêu:** Tải scene/asset/proof theo latest generation.

**File dự kiến (≤5):**

- mới `desktop/src/components/imposition-preview/impositionPreviewApi.ts`;
- mới `desktop/src/components/imposition-preview/useImpositionRenderedFrame.ts`;
- test API;
- test hook;
- `desktop/src/lib/api.ts` chỉ khi endpoint proof POST được xác nhận idempotent theo request key.

**Cổng:** abort dừng cả retry, source/fingerprint mismatch bị bỏ, decode xong mới publish, object URL cleanup đúng.

### Lô 11 — Nối submit/export reuse exact session

**Mục tiêu:** Đưa identity session/manifest từ live preview vào job xuất qua process boundary mà không solve lại.

**File dự kiến (≤5):**

- `desktop/src/lib/processHandlers.ts`;
- `desktop/src/lib/processHandlers.test.ts`;
- `backend/app/api/routes/imposition.py`;
- mới `backend/tests/test_imposition_preview_export_reuse.py`;
- `backend/tests/test_nesting_production_pipeline.py`.

**Cổng:** capability bật thì request mang exact IDs/hashes; worker rehydrate đúng bundle; mismatch/stale trả 409; session vắng giữ legacy; preview→export cùng fingerprint có solver call count đúng 1.

### Lô 12 — Canvas compositor

**Mục tiêu:** Paint scene realtime bằng texture + vector overlay.

**File dự kiến (≤5):**

- mới `desktop/src/components/imposition-preview/ImpositionCanvasRenderer.ts`;
- mới `desktop/src/components/imposition-preview/sceneTransforms.ts`;
- test transform/corner mapping;
- test renderer/layer order;
- benchmark/corpus test hẹp.

**Cổng:** CUT/clip/mirror parity, cached compose đạt SLA, không double `/Rotate`, không double mirror CNC.

### Lô 13 — Main-view host và overlay

**Mục tiêu:** Hiển thị preview trong vùng xem chính mà không remount viewer.

**File dự kiến (≤4):**

- mới `desktop/src/components/imposition-preview/ImpositionLivePreviewHost.tsx`;
- mới test host;
- `desktop/src/components/ImpositionTab.tsx`;
- integration test `OutputPreviewHost`/viewer lifecycle.

**Cổng:** toolbar không bị che, panel resize đúng, Acrobat Viewer không remount, File gốc/Tờ bình ổn định.

### Lô 14 — Điều khiển tờ/mặt/layer và i18n

**Mục tiêu:** Hoàn chỉnh UX chung và text Việt/Anh.

**File dự kiến (≤5):**

- `ImpositionLivePreviewHost.tsx`;
- component toolbar mới nếu cần;
- `desktop/src/i18n/locales/vi.json`;
- `desktop/src/i18n/locales/en.json`;
- test tương tác.

**Cổng:** Front/Back/Cut đúng capability; mini/main đồng bộ; keyboard/focus/aria hợp lệ.

### Lô 15 — Rollout và hardening

**Mục tiêu:** Bật theo từng mode, đo production-like corpus, giữ rollback sạch.

**File dự kiến (≤5 mỗi sub-lô):** Tách riêng theo Cắt xén → Tem bế → CNC nếu tổng vượt 5 file.

**Cổng:** hard gates §13 đạt; không bật “Bản xem chính xác” ở mode chưa parity; legacy vẫn là rollback.

---

## 12. Phụ thuộc và xung đột với nhánh nesting đang làm

Lô nesting A4b hiện đang/chưa hoàn tất ở đúng các seam:

- `backend/app/api/routes/imposition.py`;
- `desktop/src/lib/processHandlers.ts`;
- `desktop/src/components/imposition-tools/ImposerDashboard.tsx`;
- `desktop/src/components/imposition-tools/sections/GridPreview.tsx`;
- `backend/app/core/nesting_production_pipeline.py` và bundle/renderer liên quan.

Quy tắc phối hợp:

1. Không triển khai các lô chạm seam này song song với A4b-2/A4b-3.
2. Sau A4b, trace lại request payload và source of truth; không copy contract tạm từ báo cáo cũ.
3. `ProductionNestingSession` sau A4b là nền authoritative; live preview chỉ mở rộng, không fork pipeline.
4. Kiểm lại ba callsite đang lệch naming/đơn vị: execute camelCase+mm, preview snake_case+point và batch preview.
5. Không stage/commit các thay đổi không thuộc lô preview.

---

## 13. Ma trận kiểm thử và hard gates

### 13.1. Frontend lifecycle

- Tab inactive không fetch layout/scene/asset/proof **preview-owned**; job Bình/Xuất đã submit vẫn chạy.
- Active → inactive abort ngay timer và preview request, không cancel job production.
- Generation cũ không publish.
- Kéo settings liên tục chỉ frame cuối xuất hiện.
- Hai tab không rò state, target, request, bitmap hoặc object URL.
- Đóng một tab chỉ revoke tài nguyên do tab đó sở hữu.
- Đổi sheet/face không solve layout lại.
- Loading/error giữ frame cũ.
- Ảnh mới chỉ swap sau decode.
- Abort dừng cả retry.
- Overlay không remount `AcrobatViewer`/`OutputPreviewHost`.
- Overlay giữ toolbar và cập nhật đúng khi panel phải đổi độ rộng.

### 13.2. Affine và fidelity

- MediaBox/CropBox/TrimBox khác nhau.
- `/Rotate` 0/90/180/270; arbitrary angle cho true-shape về sau.
- Pixel top-left → canonical bottom-left đúng bốn góc.
- Tem CUSTOM/lõm, holes, bleed, homogeneous registration.
- CNC Front/Back/Cut; long/short flip; không mirror hai lần.
- Cắt xén S&R, sequential, cut-stacks, ratio-stack, mixed guillotine.
- Multi-sheet, simplex/duplex, source reorder/rotate/duplicate/delete.
- OCG/ẩn hiện và blank page trong corpus kiểm tay.

### 13.3. Backend/session

- Preview và export cùng manifest/fingerprint/render bundle/plan hash.
- Solver call count đúng 1.
- Source revision đổi làm session stale.
- Mismatch export/proof trả 409.
- Owner isolation, TTL/cancel/supersede cleanup.
- Không response nào lộ local path.
- Cache key asset đầy đủ và request trùng được coalesce.
- PDFium guard được gọi; encode ngoài lock.
- Texture route không xin heavy slot.
- Proof raster khớp artifact theo tolerance đã chốt.

### 13.4. RAM profile

- `<8 GB`: profile giảm mạnh vẫn không crash/rò bộ nhớ.
- `8–<16 GB`: profile giảm nhẹ.
- `≥16 GB`: không bị cap DPI/concurrency và đạt full quality.

### 13.5. Test hiện hữu phải tái dùng

Frontend:

- `GridPreview.mixedDuplex.test.tsx`;
- `OutputPreviewHost.test.tsx`;
- `previewSourcePolicy.test.ts`;
- `renderCoordinator.test.ts`;
- `useTileRenderer.test.ts`;
- `tileUrlCache.test.ts`.

Backend:

- `test_preview_export_canonical_parity.py`;
- `test_preview_export_parity.py`;
- `test_imposition_affine_parity.py`;
- `test_nesting_imposition_render.py`;
- `test_nesting_production_pipeline.py`;
- `test_cnc_mirror_and_exclude.py`;
- `test_cnc_multi_template.py`;
- `test_mixed_guillotine_preview.py`;
- `test_guillotine_preview_live_pages.py`;
- `test_sticker_homogeneous_preview.py`.

### 13.6. Hard gates trước rollout

- Một layout request cho mỗi stable key; cache hit/chuyển tờ không gọi lại.
- Response stale/aborted được áp dụng = 0.
- Frame trắng hoặc artwork revision cũ lóe lên = 0.
- Preview→export cùng fingerprint có solver call count = 1.
- Placement/sheet/face/artifact parity đạt tolerance chuẩn.
- Tab nền không fetch/render preview-owned; job production đã submit không bị ảnh hưởng.
- Resource được thu hồi đúng owner.
- Máy ≥16 GB không bị cap.
- Preview trung bình không chiếm heavy-job slot.
- P50/P95 và peak RSS được ghi trên corpus đại diện.

---

## 14. Rollout và rollback

Thứ tự bật đề xuất:

1. Feature flag riêng, mặc định tắt; thu shadow telemetry nhưng chưa thay UI.
2. Bật nội bộ cho Bình cắt xén.
3. Bật nhóm nhỏ cho Bình cắt xén sau khi proof–artifact parity đạt.
4. Bật Bình tem bế, trước hết lane đã có binding/clip đầy đủ.
5. Bật Bình CNC sau khi Front/Back/Cut và holes policy được chốt.
6. Bật mặc định theo mode, vẫn giữ nút File gốc và đường rollback legacy.

Rollback không xóa session/export data. Chỉ tắt main live preview và trở về Acrobat Viewer + mini wireframe; pipeline xuất giữ nguyên.

---

## 15. Rủi ro chính và cách chặn

| Rủi ro | Chốt chặn |
|---|---|
| Preview đẹp nhưng lệch file xuất | cùng manifest/plan hash; proof–artifact parity; solver count = 1 |
| CropBox/rotate/bleed sai | page binding + `pixelToSourcePageMm`; corner mapping tests |
| CNC Back mirror hai lần | sheet frame authoritative; test long/short; không sửa placement lần hai |
| Tab nền tiếp tục render preview | `isActive` gate ở producer và consumer; abort test, không cancel job production |
| Frame cũ lóe lên sau setting mới | session/generation/fingerprint fence + atomic swap |
| RAM phình do bitmap | cache owner/ref-count + RAM profile, không hard-cap máy mạnh |
| PDFium deadlock/crash | `pdfium_guard()` đúng vùng ngắn; encode ngoài lock |
| Exact proof làm UI chậm | idle 300–500 ms, latest-wins, không chặn compose/interactions |
| Contract legacy point/mm lệch | normalize một lần sang scene mm bottom-left |
| Mất holes ở CUT | fail-closed; chốt nguồn contour trước CNC exact |
| Xung đột A4b | không sửa seam song song; trace lại sau khi A4b ổn định |

---

## 16. Ước lượng triển khai

Đây là thay đổi xuyên frontend/backend/renderer, không phải một component UI đơn lẻ.

Ước lượng sau khi A4b ổn định và không phát sinh thay đổi contract lớn:

| Chặng | Ước lượng |
|---|---:|
| Contract + registry + scene canonical | 2–3 ngày kỹ thuật |
| Adapter/asset/proof backend | 3–5 ngày kỹ thuật |
| Session + compositor + main host frontend | 3–5 ngày kỹ thuật |
| Parity, performance, QA ba tool và rollout | 3–5 ngày kỹ thuật |
| Tổng | khoảng 11–18 ngày kỹ thuật |

Ước lượng phải cập nhật sau Lô 0 và sau khi A4b-2/A4b-3 đóng. Không gộp nhiều lô để chạy nhanh vì rủi ro sai affine/preview-export parity cao.

---

## 17. Definition of Done

Tính năng chỉ được coi là hoàn tất khi:

1. Cả ba công cụ có main preview hoạt động theo capability đã công bố.
2. Không có layout solver thứ hai trong luồng preview→export.
3. Source revision, placement, clip, side và affine khớp file xuất.
4. Tab lifecycle, abort, stale guard và resource cleanup đều có test.
5. SLA/peak RSS đạt trên ba profile RAM.
6. Exact proof chỉ xuất hiện ở lane có bằng chứng parity.
7. Vitest targeted + typecheck chạy trên Windows thật; pytest backend liên quan xanh.
8. Kiểm tay multi-sheet/duplex/CUSTOM/CNC Cut và overlay viewer hoàn tất.
9. Tài liệu rollout, rollback và telemetry được cập nhật.
10. Chủ dự án duyệt kết quả từng chặng trước khi bật rộng.

---

## 18. Các quyết định cần duyệt trước khi viết code

1. Duyệt kiến trúc hai tầng: live compose + exact proof sau idle.
2. Duyệt `GridPreview` là producer layout duy nhất và session per-tab là nơi chia sẻ.
3. Duyệt mặc định tự chuyển sang Tờ bình lần đầu khi layout sẵn sàng.
4. Duyệt rollout Cắt xén → Tem bế → CNC.
5. Chốt nguồn contour có holes cho CNC Cut exact.
6. Chờ A4b-2/A4b-3 ổn định trước các lô chạm route/`processHandlers`/`GridPreview`/`ImposerDashboard`.

Khi các điểm trên được duyệt, bắt đầu từ Lô 0, báo kết quả và chờ chốt sau từng lô; không triển khai toàn bộ một lượt.
