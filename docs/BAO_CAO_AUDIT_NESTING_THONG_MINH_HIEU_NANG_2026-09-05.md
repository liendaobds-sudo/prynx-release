# Audit nesting bình tem bế/CNC: độ thông minh và hiệu năng — 2026-09-05

## 1. Kết luận điều hành

Phạm vi: `W2-U09 / W7-U11`, từ thiết lập Tem bế/CNC qua preview, session, solver Rust tới manifest và writer Front/Back/CUT. Mục tiêu là tìm cơ hội xếp tốt hơn, trả kết quả nhanh hơn **mà không giảm an toàn hình học hoặc chất lượng**.

**Kết quả audit ban đầu: 1 finding P1 và 2 finding P2 đã xác nhận.** Sau khi được duyệt,
Lô A đã sửa contract handoff CNC và một quick-win baseline cache đã được áp dụng; các số
liệu trong §5 vẫn là baseline trước sửa. Độ phủ hiện tại là `TRACED + PROBE · artifact HOLD`;
test contract đã pass nhưng chưa phải nghiệm thu artifact/runtime toàn luồng.

- **§NEST26.1 — P1:** “Dấu canh in 2 mặt” CNC bị rơi ở preview nhưng có ở export. Probe xác nhận preview có 0 vật cản registration, export có 4; identity khác, không gắn được reference và phải đi đường solve lại. Chưa chứng minh va chạm hoặc pose PDF sai cụ thể.
- **§NEST26.2 — P2:** profile Balanced của core có thể tốn công hơn nhưng cho phương án kém Fast. Với `S20`, vùng bao tờ cuối lớn hơn **7,95%**; cả 12 trial Balanced bị ngắt vì work budget nên không được công bố, phải dùng baseline. Hiện Tem/CNC production dùng Fast, không được gán trực tiếp finding này cho toàn bộ output UI.
- **§NEST26.3 — P2:** harness corpus ghi planner 15 worker nhưng lời gọi thực chỉ cấp **1 worker**. Không dùng số đó kết luận production một lõi hoặc đo mức tận dụng máy mạnh.

Hướng nâng cấp có cơ sở: thống nhất preview/export → chuẩn hóa benchmark → giữ Fast làm phương án tốt nhất đã biết trong portfolio mạnh hơn → phân bổ công tìm kiếm/refine theo tiến độ → thử cạnh tranh góc/lookahead và motif S&R trên corpus có sàn chất lượng. Không chỉ tăng số trial hoặc kéo dài timeout.

## 2. Phạm vi, nguồn và provenance

| Mục | Ghi nhận |
|---|---|
| Repository | `D:/pdfcompare` |
| HEAD lúc bắt đầu | `baeec0517b213d5c017d4d25dd77ed81b0b6425e` |
| HEAD lúc lập báo cáo | `669b92dbb3a343633c578df6fea9872514c6ef22` |
| Installed native dùng cho probe | `pdfcompare_native.cp311-win_amd64.pyd`, build `release`, source revision `baeec051…`, `source_dirty=true` |
| Native identity | `fbe222ddf552cc2a8cdef6054d91defa50e971ee88a9352dfef286df9ae572bf` |
| Version | engine 0.3.0, protocol 2, baseline 12, solver 4, multi-start 5, runtime-control 1 |
| Máy corpus | Windows, Python 3.11.9, 16 logical CPU, RAM tổng khoảng 32 GB |
| File khách | `test/test nesting.pdf`, 13 trang, SHA-256 `EFCDE4F0A16ACA0A5A54EE2D952945AFE2EB70DD2073BC9FF59EE87292B257AB` |

HEAD thay đổi bởi phiên khác trong lúc audit; không reset/revert thay đổi đó. Delta không thay kernel `imposition_core`; một số đường Tem/CNC đổi cấp log. Các thay đổi native ngoài nesting không được dùng để suy ra binary parity. Installed build có dirty provenance, không chứng minh tương ứng mọi byte của source hiện tại. `native/build.rs` tạo identity từ metadata build, không phải hash toàn cây mã.

Gói [bằng chứng và script tái hiện](D:/pdfcompare/docs/audit/NESTING_THONG_MINH_HIEU_NANG_EVIDENCE_2026-09-05.json) lưu:

- SHA-256 của 31 đầu vào/source/binary liên quan, hai kết quả corpus cũ, selected score/placement hash/runtime grant của probe mới.
- Script Python đúng đã dùng cho CNC marks, grant 1 và grant 15; stdout và script/helper S&R 13 trang.
- Phạm vi mock, giới hạn phép đo và kết quả kiểm thử. Các log test đầy đủ trước đó chưa được content-addressed; không coi bản ghi số test là raw log.

Tài liệu nền đã đối chiếu: [audit tốc độ 09-01, cập nhật 09-02](D:/pdfcompare/docs/BAO_CAO_AUDIT_TOC_DO_PREVIEW_VA_THUC_THI_NESTING_TEM_CNC_2026-09-01.md), [re-audit 08-30](D:/pdfcompare/docs/BAO_CAO_AUDIT_LAI_NESTING_PRYNX_2026-08-30.md), [B6 spatial-index](D:/pdfcompare/docs/SPEC_NEST_B6_SPATIAL_INDEX_2026-08-30.md), [B9 incremental](D:/pdfcompare/docs/SPEC_NEST_B9_INCREMENTAL_FEASIBLE_2026-08-30.md), [quy tắc audit](D:/pdfcompare/audit-rules.md). Không mở lại lỗi cũ đã đóng chỉ từ mô tả lịch sử.

## 3. Thẻ audit unit và đường đang chạy

**Unit:** `W2-U09 / W7-U11` — mở PDF có contour CUSTOM → chọn Xếp tối ưu/Tem bế/CNC → xem preview → bấm Bình → nhận Front/Back/CUT.

**Hợp đồng:** UI preview dùng pt tại request boundary rồi chuyển sang mm; model/solver và vật cản dùng mm; page/side, quantity, gap X/Y, lề/ốc, duplex/flip/registration, allowed-angle, source identity và manifest phải nhất quán. Preview và export cùng thiết lập phải dùng cùng pose/manifest; report có thể thay đổi riêng theo hợp đồng hiện hữu.

| Chặng | Entry/consumer đã truy vết |
|---|---|
| UI chọn chiến lược | [GridSettingsSection](D:/pdfcompare/desktop/src/components/imposition-tools/sections/GridSettingsSection.tsx:523) → [trueShapeNestingRollout](D:/pdfcompare/desktop/src/components/imposition-tools/trueShapeNestingRollout.ts:301) |
| Preview debounce, job, progress | [GridPreview](D:/pdfcompare/desktop/src/components/imposition-tools/sections/GridPreview.tsx:2505) → [mixed-nesting API](D:/pdfcompare/desktop/src/lib/mixed-nesting/api.ts:408) |
| Route reachable và threadpool | [router registration](D:/pdfcompare/backend/app/main.py:372) → [imposition route](D:/pdfcompare/backend/app/api/routes/imposition.py:1729) → [preview jobs](D:/pdfcompare/backend/app/core/nesting_preview_jobs.py:281) |
| Schema/settings → production job | [preview mapper](D:/pdfcompare/backend/app/core/nesting_preview_capacity.py:74) → [job builder](D:/pdfcompare/backend/app/workers/nup_true_shape_nesting.py:749) |
| Pipeline → hardware grant → native | [production pipeline](D:/pdfcompare/backend/app/core/nesting_production_pipeline.py:559) → [orchestrator](D:/pdfcompare/backend/app/core/nesting_production_orchestrator.py:379) → [service](D:/pdfcompare/backend/app/core/mixed_nesting_service.py:545) → [PyO3](D:/pdfcompare/native/src/mixed_nesting_py.rs:365) |
| Manifest → preview poses | [preview capacity](D:/pdfcompare/backend/app/core/nesting_preview_capacity.py:655), dùng [resolve_manifest_artwork_placement](D:/pdfcompare/backend/app/core/nesting_preview_capacity.py:197) |
| Bấm Bình → session handoff | [processHandlers](D:/pdfcompare/desktop/src/lib/processHandlers.ts:427) → [execute route](D:/pdfcompare/backend/app/api/routes/imposition.py:1015) → [manifest render entry](D:/pdfcompare/backend/app/workers/nup_true_shape_nesting.py:1327) |
| Writer → output → nơi nhận | [bundle](D:/pdfcompare/backend/app/core/nesting_imposition_bundle.py:873) → [Front/Back/CUT writer](D:/pdfcompare/backend/app/workers/nesting_imposition_render.py:1356) → [output/download consumer](D:/pdfcompare/desktop/src/lib/processHandlers.ts:441) |

Ca biên đã kiểm trong lượt này: CNC duplex marks, schema reject field lạ, preview session miss, contour gap dị hướng, fixed-work grant 1/15, trial completion, S&R batch/serial và child render không solve lại. Còn thiếu artifact CNC duplex nguồn thật và thao tác Tauri/installed; bảng trace **không** chứng minh file xuất đã được nghiệm thu.

## 4. Findings đã xác nhận

| Mã | Mức / effort | Phạm vi | Bất biến bị vi phạm | Trạng thái |
|---|---|---|---|---|
| §NEST26.1 | P1 / M | Live CNC preview→export | Cùng thiết lập gia công phải tạo cùng job identity/obstacles và tái dùng reference | **SOURCE FIXED (Lô A)**; artifact CNC duplex còn HOLD |
| §NEST26.2 | P2 / M | Core quantity, profile Balanced | Mức tìm kiếm mạnh hơn chưa giữ được sàn chất lượng Fast; công tìm kiếm bị bỏ khi không hoàn thành trial | CONFIRMED, chưa sửa |
| §NEST26.3 | P2 / S | Benchmark/proof | Metadata worker phải phản ánh grant thực của lời gọi được đo | CONFIRMED, chưa sửa |

### §NEST26.1 — CNC duplex marks không đi qua preview

**Nguồn và consumer:**

- Checkbox [AdvancedSettingsSection](D:/pdfcompare/desktop/src/components/imposition-tools/sections/AdvancedSettingsSection.tsx:535); Dashboard truyền prop vào preview ở [dòng 2210](D:/pdfcompare/desktop/src/components/imposition-tools/ImposerDashboard.tsx:2210) và đưa vào export ở [dòng 1724](D:/pdfcompare/desktop/src/components/imposition-tools/ImposerDashboard.tsx:1724).
- [GridPreview](D:/pdfcompare/desktop/src/components/imposition-tools/sections/GridPreview.tsx:1374) có prop cho predicate, nhưng cache key từ [dòng 1759](D:/pdfcompare/desktop/src/components/imposition-tools/sections/GridPreview.tsx:1759) và payload [dòng 2371](D:/pdfcompare/desktop/src/components/imposition-tools/sections/GridPreview.tsx:2371) không mang `cncDuplexMarks`; chỉ có duplex/flip.
- [PreviewLayoutRequest](D:/pdfcompare/backend/app/api/routes/imposition.py:1420) có `extra="forbid"`, không khai `cnc_duplex_marks`; [mapper](D:/pdfcompare/backend/app/core/nesting_preview_capacity.py:97) cũng không sinh `cncDuplexMarks`.
- Export serializer [processHandlers](D:/pdfcompare/desktop/src/lib/processHandlers.ts:411) giữ field. [Job builder](D:/pdfcompare/backend/app/workers/nup_true_shape_nesting.py:921) đọc nó và tạo 4 registration obstacles; [session identity](D:/pdfcompare/backend/app/core/nesting_preview_session.py:201) tính cả obstacles và duplex registration.
- [Handoff miss](D:/pdfcompare/backend/app/workers/nup_true_shape_nesting.py:2541) trả settings không reference; execution [không có reference](D:/pdfcompare/backend/app/workers/nup_true_shape_nesting.py:1372) đi `get_or_solve`.

**Tái hiện:** schema, mapper, builder và handoff thật; detector/solver mock để cô lập hợp đồng; local session store thật, fingerprint nguồn thật. Main đã chạy lại độc lập.

```json
{
  "exportRoutesTrueShape": true,
  "previewCacheHit": true,
  "exportCacheHit": false,
  "handoffReferencePresent": false,
  "sameIdentity": false,
  "previewRegistration": false,
  "exportRegistration": true,
  "previewObstacles": 0,
  "exportObstacles": 4,
  "schemaErrors": [{"loc": ["cnc_duplex_marks"], "type": "extra_forbidden"}]
}
```

**Tác động đã chứng minh:** không bảo đảm preview/export cùng layout; mất lợi ích handoff cho cấu hình này. **Chưa chứng minh:** mức tăng latency, placement PDF cụ thể, va chạm với dấu canh hoặc sản phẩm cắt lỗi. Đây không phải lỗi cũ “duplex rơi về simplex”.

**Hướng sửa:** nối một field nhất quán qua cache key → payload → schema → mapper; khóa test bật/tắt marks làm invalidate đúng, cùng settings thì identity/reference khớp, execution không solve lại. Sau đó kiểm Front/Back/CUT thật.

**Kết quả Lô A (sau duyệt):** đã nối `cncDuplexMarks` qua cache key, payload
`cnc_duplex_marks`, `PreviewLayoutRequest` (`StrictBool`), mapper và job identity. Test
backend xác nhận bật → 4 vật cản, tắt → 0 và identity khác nhau; test GridPreview xác nhận
đổi bật/tắt tạo request mới (42/42 pass). Chưa chạy artifact CNC duplex nguồn thật nên
chưa nâng trạng thái lên `ARTIFACT`/`RUNTIME`.

### §NEST26.2 — Balanced chia công quá mỏng, không còn trial hoàn chỉnh để chọn

[allocate_trials](D:/pdfcompare/imposition_core/src/mixed_nesting/multi_start.rs:181) chia quota theo trial ID, không chia theo chi phí dự kiến của trial. [Solver effort](D:/pdfcompare/imposition_core/src/mixed_nesting/control.rs:812) tăng đồng thời trial, candidates và refinement.

| Profile | Trial | Tổng evaluations | Mỗi trial xấp xỉ | Refine rounds | Beam-width / orientation proposals |
|---|---:|---:|---:|---:|---:|
| Fast | 4 | 30.000 | 7.500 | 2 | 4 / 12 |
| Balanced | 12 | 100.000 | 8.333 | 6 | 8 / 32 |

Với `CONSTRAINTS` và `S20`, telemetry đều cho Fast **4 completed/0 interrupted**, Balanced **0 completed/12 interrupted**. [Publication barrier](D:/pdfcompare/imposition_core/src/mixed_nesting/multi_start.rs:828) bỏ quantity trial bị ngắt trước khi được công bố; đây là chốt an toàn cần giữ. Balanced chọn baseline, Fast chọn smart trial tốt hơn.

**Đo đúng chất lượng:** [score.rs](D:/pdfcompare/imposition_core/src/mixed_nesting/score.rs:11) so fulfillment/số tờ, rồi vùng bao tờ cuối và compactness. Cùng tập chi tiết và số tờ thì utilization không đổi; không dùng utilization bằng nhau để kết luận layout ngang nhau.

| Ca | Fast vùng bao tờ cuối, mm² | Balanced, mm² | Diễn giải |
|---|---:|---:|---|
| ANGLE_ONLY | 8.676,706 | 8.607,203 | Balanced tốt hơn khoảng 0,80% |
| CONTINUOUS_XY | 3.562,040 | 3.562,040 | Cùng placement hash, cùng baseline |
| CONSTRAINTS | 28.560,098 | 28.630,529 | Balanced lớn hơn 0,247% |
| S20 | 121.168,487 | 130.800,000 | Balanced lớn hơn 7,949% |

Giá trị gốc `lastSheetUsedAreaFixed` có lượng tử **0,001 mm²**, không phải mm² nguyên. Cả bốn ca đã xếp hết trên một tờ; không có bằng chứng giảm số tem/tăng số tờ ở phép thử này.

Probe phần cứng thật N=1 cho hai ca cuối:

| Ca | Fast wall, ms | Balanced wall, ms | Grant thực | Concurrent trials Fast / Balanced |
|---|---:|---:|---:|---:|
| CONSTRAINTS | 103,838 | 279,602 | 15 | 4 / 12 |
| S20 | 613,589 | 1.248,743 | 15 | 4 / 12 |

Hai ca này có score và placement hash tương ứng giống probe grant 1. Đây là bằng chứng hiện tượng không chỉ do chạy thiếu worker. N=1 chưa đủ xác nhận percentile hoặc speedup; hardware wall còn tính `plan_hardware`. Không gộp timing khác lượt để quy nguyên nhân tải CPU.

**Giới hạn reachability:** core API có profile này; [Tem/CNC builder](D:/pdfcompare/backend/app/workers/nup_true_shape_nesting.py:1027) hiện chọn `profile="fast"`, budget 3.000 ms. UI hiện không expose núm Balanced/quality cho luồng này.

**Hướng sửa:** giữ một phương án Fast đã validate làm sàn; dành công cho placement hoàn chỉnh trước refine bổ sung, phân bổ portfolio theo tiến độ. Trial interruption/cancel vẫn không được vượt publication barrier. Muốn dùng partial result phải thiết kế checkpoint hợp lệ và test riêng, không đơn giản bỏ `continue`.

### §NEST26.3 — Harness ghi planner 15 worker nhưng chạy native grant 1

[describe_machine](D:/pdfcompare/scripts/benchmark_mixed_nesting.py:128) ghi `workers=plan.workers`; [solve_once](D:/pdfcompare/scripts/benchmark_mixed_nesting.py:244) lại gọi `handle.solve(request)`. [Service](D:/pdfcompare/backend/app/core/mixed_nesting_service.py:483) gọi native một đối số; [PyO3 default](D:/pdfcompare/native/src/mixed_nesting_py.rs:276) là `worker_grant=1`.

Probe thật cho `workerGrant=1`, `trialCapacity=1`, `concurrencyLimit=1`, cache byte grant null. Vì vậy hai JSON corpus cũ là **API lab, fixed-work, một worker**, dù metadata machine ghi 15. `estimatedPeakMb` cũng là planner estimate, không phải RSS measured của phép đo.

Production đã truyền hardware plan tại [orchestrator](D:/pdfcompare/backend/app/core/nesting_production_orchestrator.py:251) và [service hardware path](D:/pdfcompare/backend/app/core/mixed_nesting_service.py:545); không kết luận production chưa song song.

**Hướng sửa:** tách rõ benchmark lab một worker và hardware-plan path; lấy grant/cache/concurrency từ runtime telemetry mỗi ca; ghi full selected score, canonical pose hash và phase timings. Dùng workload/seed/native identity cố định, đo contention/RSS process tree và không lấy planner estimate làm measured peak.

## 5. Baseline tốc độ: số nào có thể dùng

### 5.1. Corpus fixed-work, lab/free-angle, grant thực 1

N=3, số trung vị khảo sát dưới đây nằm trong [raw evidence](D:/pdfcompare/docs/audit/NESTING_THONG_MINH_HIEU_NANG_EVIDENCE_2026-09-05.json). Không gọi p95 từ ba mẫu là acceptance P95; không đại diện preview/execute production.

| Ca | Fast median, ms | Balanced median, ms | Số chi tiết đã xếp |
|---|---:|---:|---:|
| ANGLE_ONLY | 0,57 | 2,88 | 1 |
| CONTINUOUS_XY | 37,00 | 279,54 | 4 |
| CONSTRAINTS | 310,62 | 1.772,29 | 10 |
| S20 | 2.017,37 | 6.303,89 | 20 |

Tất cả valid, một tờ, không unplaced, placement tất định trong ba lượt theo harness. `CONTINUOUS_XY` Balanced chậm khoảng **7,56×**, không phải 10×. Selected score được kiểm bằng probe riêng §NEST26.2, không có trong metric corpus cũ.

### 5.2. File khách 13 trang: S&R solve-only

Tờ 320×430 mm, gap 2×2 mm, lề 3 mm, ốc 5 mm. Cùng installed native, mỗi chế độ N=1. [Harness](D:/pdfcompare/backend/.audit-tmp/bench_step_repeat_13.py:114) dùng production job/solve; tùy `PRYNX_BENCH_PRODUCTION_BATCH` để chạy batch scheduler hoặc tuần tự. Cờ rollout chỉ bật trong subprocess audit, không đổi cấu hình ứng dụng.

| Chế độ | Wall cả 13 job | Tổng placement raw | Grant từng job |
|---|---:|---:|---|
| Production batch scheduler | 10.088,373 ms | 600 | 2, 2, rồi 11 job × 1 |
| Tuần tự mặc định harness | 25.798,704 ms | 661 | 15 mỗi job |

**Không gọi đây là speedup giữ nguyên chất lượng.** Batch trả nhanh hơn nhưng ít hơn 61 placement trong lượt này. Nhiều baseline batch chạm gần budget 3.000 ms; validation/publication còn chạy sau đó. Đây là quan sát trade-off deadline/lane, chưa cô lập để quy hết nguyên nhân cho scheduler. Không chạy quality gate auto UI, render/persist hoặc kiểm artifact nên không suy rằng output tự động của người dùng giảm 61 tem.

Cả hai `searchMs=0` vì [periodic-intent baseline lock](D:/pdfcompare/imposition_core/src/mixed_nesting/multi_start.rs:617), không phải mất threading.

Phân rã **lượt tuần tự**, tổng từng phase:

| Phase | ms |
|---|---:|
| Wall pipeline cộng theo job | 25.783,403 |
| Wall solveProduction | 19.115,649 |
| Native total | 16.959 |
| Baseline | 10.539 |
| Baseline validation | 2.123 |
| Publication | 4.282 |
| Sau native, phần còn lại trong solveProduction | 2.156,649 |

Các dòng lồng nhau, không cộng thành tổng. Ở batch, tổng phase của các job đồng thời lớn hơn wall tổng là bình thường. Harness `sumSolveWallMs` cộng `row.wallMs`: serial là pipeline wall, batch gán bằng solveProductionWallMs; không so hai summary này như cùng metric. `nfpBuildCpuMs`/`differenceCpuMs` thực là elapsed counters cộng dồn, không phải profiler CPU.

### 5.3. Baseline lịch sử không thay thế phép đo hiện hành

Snapshot 09-02 đã có N=20 preview/execution và handoff/raster parity riêng. Giữ nguyên giá trị lịch sử, không đối chiếu trực tiếp với solve-only ở trên thành A/B.

CNC khoảng 13 ms simplex/22 ms duplex trong báo cáo đó chỉ là **writer synthetic, quantity=2/hai pose**, không gồm detector/solver. Chưa có fixture+harness full CNC duplex nặng hiện hành để hứa latency hoặc mức tăng tốc toàn tính năng.

### 5.4. Đo đúng file user cung cấp: preview → handoff → PDF

Đã chạy audit-only bằng đúng `D:/pdfcompare/test/test nesting.pdf` (13 trang), cùng settings S&R: tờ 320×430 mm, gap 2×2 mm, lề 3 mm, ốc 5 mm. Hai warm-up + ba lượt đo, backend explicit `true_shape_nesting`; detector, solver và writer là code thật. Không qua HTTP/Tauri, không bật quality gate Auto, không đo cold tuyệt đối của process/OS.

| Pha | Median | Khoảng đo (N=3) | Ghi chú |
|---|---:|---:|---|
| Preview cold | **15,417 ms** | 13,596–16,509 ms | 13 job solve, RAM-gated production batch |
| Preview warm | **2,736 ms** | 2,733–4,205 ms | 0 solve, đọc lại session/reference |
| Handoff reference | **405 ms** | 405–444 ms | 13 reference, 0 solve |
| Xuất PDF từ manifest | **11,069 ms** | 10,134–11,233 ms | 0 solve; 26 trang Front/CUT |
| Tổng phase quan sát | **26,891 ms** | 24,135–28,186 ms | Không phải wall liên tục lần bấm đầu; warm preview chạy xen giữa |

Trong cả ba lượt đo, preview và PDF xuất cùng lượt có cùng tập manifest/pose, 26 trang, MediaBox 320×430 mm và nguồn không đổi; kiểm tra ảnh bằng Poppler đã xem một trang nguồn cùng Front/CUT đầu tiên. Export không gọi lại solver (`exportSolveTotal=0`). Kết quả này là **baseline trước sửa**, chưa phải phần trăm tăng tốc.

Có biến thiên chất lượng giữa các lần cold solve cùng input/settings: tổng placement lần lượt **612, 592, 589** (layout digest mỗi lượt khác). Vì vậy KPI sau này phải so đồng thời thời gian và sàn placement/score; không được lấy lượt nhanh nhất làm headline. Bằng chứng thô và script nằm ở [NESTING_USER_FILE_BASELINE_2026-09-05.json](D:/pdfcompare/docs/audit/NESTING_USER_FILE_BASELINE_2026-09-05.json); kho PDF/PNG tạm giữ ngoài Git trong `backend/.audit-tmp/userfile-timing-20260905-d3q84p2g`.

## 6. Điều đã có và điều không nên “sửa nhầm”

| Trạng thái | Kết luận có căn cứ |
|---|---|
| EXPECTED | Production giới hạn cardinal theo [adapter](D:/pdfcompare/backend/app/core/nesting_production_adapter.py:108); free-angle core/lab không đồng nghĩa đã mở rollout Tem/CNC. |
| EXPECTED | S&R bảo vệ periodic intent, có baseline motif/lattice/half-turn; không thay bằng generic free-gang khi chưa chốt semantics. [Nguồn](D:/pdfcompare/imposition_core/src/mixed_nesting/multi_start.rs:763). |
| EXPECTED | Search hiện là greedy multi-trial: mỗi instance chọn một best, dừng ở góc đầu tiên có pose hợp lệ. `beam_width` giới hạn vertex candidates, không phải beam nhiều trạng thái layout. [Solver](D:/pdfcompare/imposition_core/src/mixed_nesting/solver.rs:294), [candidates](D:/pdfcompare/imposition_core/src/mixed_nesting/candidates.rs:279). |
| EXPECTED / đã biết | `multi_start_restarts` là effort/metadata, không tự điều khiển thêm restart; trial thực theo `trial_count`. Không mô tả metadata là số restart đã thực thi. |
| DISPROVED | Không có bằng chứng NFP production ép gap dị hướng thành khoảng cách tròn `hypot`: [NFP](D:/pdfcompare/imposition_core/src/mixed_nesting/nfp.rs:181) dùng Minkowski rectangle theo hai trục; [validator](D:/pdfcompare/imposition_core/src/mixed_nesting/validator.rs:491) phán theo sheet-axis. Hai regression gap dị hướng đã pass. |
| DISPROVED | Trial đầu không ăn hết shared quota: work budget đã chia độc lập theo trial ID tại [allocate_trials](D:/pdfcompare/imposition_core/src/mixed_nesting/multi_start.rs:181). |
| ĐÃ ĐO / ĐÃ TRIỂN KHAI | Không đề xuất lại B6 spatial-index đã NO-GO hoặc B8 bbox fastpath đã thua hình lõm như quick win. B9 incremental feasible region đã triển khai cho autofill baseline. |
| Không mở lại finding cũ | Quantity/duplex→simplex/maxSheets/progress/cancel/singleflight/hardware grant có bản sửa hiện hành; lỗi marks §NEST26.1 là khe hở khác. |

## 7. Cơ hội “thông minh hơn” và nhanh hơn cần A/B

Các mục sau **không phải finding P0–P3**, không hứa tăng yield/tốc độ trước khi đo:

| Mã / trạng thái | Căn cứ hiện tại | Thử nghiệm có giới hạn |
|---|---|---|
| S1 — SUSPECTED | [Solver](D:/pdfcompare/imposition_core/src/mixed_nesting/solver.rs:371) nhận góc hợp lệ đầu tiên; [midpoint helper](D:/pdfcompare/imposition_core/src/mixed_nesting/candidates.rs:294) chưa có consumer solver. | So vài góc khả thi theo score, thử lookahead hạn chế/ứng viên tiếp xúc; giữ incumbent và cùng work envelope để đo chất lượng/thời gian. |
| S2 — SUSPECTED | Edge normals thêm trước, seed chỉ thêm khi còn slot ở [candidates](D:/pdfcompare/imposition_core/src/mixed_nesting/candidates.rs:151); contour nhiều cạnh có thể hết budget trước seeded samples. | Fixture 100+ đỉnh; đo độ khác candidate-set giữa seed và score, không suy mất yield chỉ từ code. |
| S3 — SUSPECTED | `min_area_box_angle_deg` O(n²) có thể lặp theo instance ở [candidates](D:/pdfcompare/imposition_core/src/mixed_nesting/candidates.rs:229); NFP decomposition/Boolean đắt nhưng work charge chủ yếu theo pose/candidate. | Profile chi phí theo unique contour/rotation; A/B tiền xử lý/tái dùng decomposition và cost-aware work budget. Cache chỉ sau khi đo và giữ đúng ownership/RAM tier. |
| S4 — SUSPECTED | Refine validity đúng sheet-axis, nhưng conservative advancement còn scalar `hypot` ở [refine](D:/pdfcompare/imposition_core/src/mixed_nesting/refine.rs:152). | Tạo ca chứng minh compactness loss trước khi sửa; không phục hồi claim “NFP gap sai”. |
| S5 — PROOF GAP | S&R batch/serial có trade-off §5.2; baseline/publication chiếm thời gian đáng kể. | Benchmark cùng quality floor, bố trí lane theo độ phức tạp, so motif incumbent; không hard-cap máy mạnh hoặc bỏ periodic intent. |
| S6 — BACKLOG đã biết | PERF-NEST-02 shared snapshot/cross-job hash còn mở; chưa đo cache frontend một entry là bottleneck. | Tách source hashing, detector, solve, publication, render; chỉ xử lý tầng chiếm thời gian được xác nhận. |

Nguyên tắc: phần tìm kiếm nâng cao là **bổ sung cạnh tranh với phương án đã tốt**, không được làm mất phương án đó. So chất lượng bằng đúng score version và fulfillment/floor nghiệp vụ; không thay oracle bằng riêng utilization.

## 8. Verify và khoảng trống

| Kiểm tra đã chạy trong đợt audit | Kết quả và giới hạn |
|---|---|
| Backend focused nesting | 257 passed, 1 lỗi môi trường `multiprocessing.Queue / WinError 5` trong sandbox; không gọi invocation này xanh toàn bộ. |
| Chạy lại riêng ca child render ngoài sandbox | `test_nesting_session_handover.py::test_process_con_that_render_khong_solve`: 1 passed, 1 Pydantic deprecation warning. Không cộng ca lặp thành số test mới. |
| Rust `imposition_core --lib` | 47 passed. |
| Rust `mixed_nesting_solver gap_di_huong` | 2 passed; warning dọn incremental access denied, không phải test failure. |
| Contract scanner self-test | 17 passed; scanner không thay thế proof finding. |
| CNC marks contract probe | Tái hiện thành công; detector/solver mock, không artifact. |
| Native score/grant probe | 8 hàng grant 1 + 4 hàng grant 15; kết quả chi tiết trong evidence. |
| S&R 13 trang | 2 chế độ × N=1, solve-only; không dùng làm acceptance full pipeline. |

Lệnh rerun quan trọng:

```powershell
# cwd: D:/pdfcompare/backend
.\venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider tests/test_nesting_session_handover.py::test_process_con_that_render_khong_solve
# cwd: D:/pdfcompare
cargo test --manifest-path imposition_core/Cargo.toml --test mixed_nesting_solver gap_di_huong -- --nocapture
```

Chưa chạy lại frontend full/typecheck cho snapshot báo cáo; chưa Tauri dev/installed/Nuitka; chưa PDF CNC duplex nguồn thật với registration/cut parity; chưa N≥20 đầy đủ corpus/hai tier RAM thấp; chưa CPU profiler/RSS process tree được cô lập. Các số đã đo không đủ để mở release hoặc tuyên bố “đã tối ưu xong”.

## 9. Lộ trình đề xuất — chờ duyệt

Mỗi lô tối đa 5 file, verify xong và xác nhận thao tác thật rồi mới sang lô tiếp. Không thêm cap vô điều kiện; RAM <8/<16 GB mới xét giảm, máy ≥16 GB giữ chính sách full. Không thay Cargo release LTO, không bỏ `pdfium_guard()`/validator và không đổi rollout/free-angle trong audit này.

| Lô | Nội dung / phạm vi dự kiến | Cổng ra |
|---|---|---|
| A — ưu tiên | §NEST26.1: [GridPreview](D:/pdfcompare/desktop/src/components/imposition-tools/sections/GridPreview.tsx), [schema imposition](D:/pdfcompare/backend/app/api/routes/imposition.py), [preview mapper](D:/pdfcompare/backend/app/core/nesting_preview_capacity.py), [frontend test](D:/pdfcompare/desktop/src/components/imposition-tools/sections/GridPreview.mixedDuplex.test.tsx), [backend handoff test](D:/pdfcompare/backend/tests/test_nesting_session_handover.py). **5 file.** | Bật→tắt→bật marks serialize/invalidate đúng; registration obstacles true→4, false→0; preview/export cùng job identity; export reference có mặt; child render không solve; focused tests + Windows typecheck; CNC artifact và app smoke trước khi đóng P1 toàn luồng. |
| B — chuẩn hóa phép đo | §NEST26.3: harness corpus + test hợp đồng benchmark + schema/evidence metric nếu cần, tối đa 3 file. | Runtime grant khớp lời gọi; full score/hash/native provenance; lab/production scope tách bạch; không đổi solver. |
| C — tăng chất lượng core | §NEST26.2: `multi_start.rs`, `solver.rs`, regression và corpus chuyên biệt, tối đa 5 file. | Fast incumbent không mất; CONSTRAINTS/S20 không kém Fast; đủ quantity, valid, deterministic fixed-work grant 1/2/N; cancel/deadline/publication vẫn an toàn. Rebuild native có provenance theo workflow trước benchmark. |
| D — S&R và phase đã đo | Một thay đổi mỗi A/B: baseline preprocessing hoặc bố trí công việc theo độ phức tạp, tối đa 5 file. | Chạy 13 trang giữ quality floor/periodic intent; so output đã qua auto-route quality gate; không chỉ tối ưu raw wall mà giảm tem. |
| E — thử sức tìm kiếm | Angle competition/lookahead/seed diversity, mỗi thử nghiệm một lô ≤5 file, chỉ sau C. | Corpus chứng minh score/yield tốt hơn trong ngân sách; không hồi quy thỏa ràng buộc, artifact và performance. Mở free-angle production cần duyệt riêng. |

**Acceptance trước khi gọi “nhanh và thông minh hơn”:**

1. Chất lượng: valid, đủ quantity, không tăng số tờ hoặc mất floor legacy/Fast; so đầy đủ selected score và pose, không chỉ utilization.
2. Parity: preview → session → manifest → Front/Back/CUT cùng hash/pose theo hợp đồng; marks/obstacles/pont/flip/registration đúng. Mở lại PDF, đo/raster thực.
3. Hiệu năng: N≥20 sau 2 warm-up, cold/warm riêng; wall end-to-end và từng phase, actual worker grant, CPU/process-tree RSS, source/native hash. Không ghép các lượt khác cấu hình thành speedup.
4. Tải: 1/2/3+ preview đồng thời, cancel/retry/cache-hit, chạy trên các tier RAM phù hợp; máy mạnh không bị giảm công suất vô điều kiện.
5. Runtime: smoke Tauri dev và packaged đúng fixture CNC duplex. Alias `PROD_CNC_DUPLEX`/`PRYNX_LO0_CORPUS_DIR` trong tài liệu cũ chưa thay cho fixture+harness hiện hành.

**Chốt duyệt được đề xuất:** duyệt Lô A trước; Lô B chuẩn hóa phép đo rồi mới chốt KPI/triển khai thay đổi solver. Báo cáo này không cấp phép tự sửa các lô C–E.

**Cập nhật thực thi 2026-09-05:** Lô A đã được duyệt và hoàn tất; quick-win baseline cache
(tái dùng NFP ở reason-check, không clone `RegionMm`) cũng đã áp dụng trong lô nhỏ kế tiếp.
Lô B–E vẫn chờ benchmark after cùng quality floor; các số §5 không được đọc như kết quả
after.
