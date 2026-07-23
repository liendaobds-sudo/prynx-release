# PrynX — Independent Performance Re-Audit

Date: 2026-07-23  
Scope: commits `b94a7b0`, `8918572`, `828af37`, plus the uncommitted P0-0 instrumentation in the working tree.

## Executive verdict

**Not merge/release-safe in the current working tree.** The architectural direction is generally sound, but two P0 regressions were found:

1. **N-Up is currently broken by the uncommitted instrumentation.** `_spawn_nup_process()` calls `time.time()` without a module-scope `time` import. The `NameError` occurs before `try/finally`, leaving jobs queued and leaking the submission slot. Evidence: `backend/app/api/routes/imposition.py:1092-1100,1142-1143,1205-1209`. A direct runtime probe reproduced `NameError: name 'time' is not defined`.
2. **Large Combine loses pages.** The frontend emits one manifest item per whole PDF without `page_index`; the backend defaults missing `page_index` to `0`. A 3-page source reproduced as a 1-page output. Evidence: `desktop/src/components/CombineTab.tsx:39-65,810-823`; `backend/app/workers/pdf_manifest_engine.py:45-63`.

The changes contain useful guardrails and refactors, but there is no reproducible before/after benchmark for peak RSS, cold launch, or P95 latency. Correctness tests and build success are not performance proof.

## Verdict table

Legend: **C** = code exists, **H** = runtime behavior is correct/safe, **M** = measured with real performance data.

| Claim | Verdict | Evidence |
|---|---|---|
| N-Up bounded executor, queue, 429, `queued`, env configuration | **PARTIAL** | C: `backend/app/api/routes/imposition.py:1040-1043,1194-1214`. H: broken in the current tree by the instrumentation `NameError` before the worker `try/finally`. M: none. |
| N-Up cleanup/release is not affected by instrumentation | **FALSE** | Instrumentation setup is before `try` at `backend/app/api/routes/imposition.py:1095-1099`; release is only at `:1143`. The failure bypasses both cleanup and release. |
| Instrumentation is production-safe and zero-overhead when disabled | **FALSE** | `PRYNX_PERF` gates only the sampler/log in `backend/app/core/perf_sampler.py:134-155`; temp-directory scans still run at `backend/app/api/routes/imposition.py:1099,1130`. Frontend marks are not environment-gated at `desktop/src/lib/perfMarks.ts:24-46`. |
| Instrumentation reports job peak RSS/temp usage accurately | **FALSE** | It samples one outer PID at `backend/app/api/routes/imposition.py:1112`, while N-Up creates child processes at `backend/app/workers/nup_engine.py:3051-3055`. `temp_delta_mb` is an end-of-job delta, not peak temp usage. No `logs/job_perf.log` was produced. |
| VDP has bounded concurrency, queue, 429, and `queued` | **PARTIAL** | Mechanism exists at `backend/app/api/routes/vdp.py:50-55,160-169,264-283`; admission occurs only after parsing/copying at `:184-247`, so rejected requests can still consume substantial resources. Queued jobs retain full row lists and wait on a semaphore. |
| CSV single-up avoids whole-dataset JSON transport | **PARTIAL** | `TextIOWrapper`, row cap, and threadpool parse at `backend/app/api/routes/vdp.py:82-122,187-198`; however rows are still materialized in memory and the template file is read whole at `:245-254`. |
| Multi-up/preview VDP paths still serialize rows | **PARTIAL** | The dormant multi-up branch still stringifies rows at `desktop/src/lib/api.ts:423-426`, but runtime currently hard-codes `isMultiUp=false` at `desktop/src/components/preprocess-tools/DataMergeTool.tsx:747`. Preview still sends/stringifies all rows at `DataMergeTool.tsx:982-994` and `desktop/src/lib/api.ts:747-750`. |
| Compare Desktop/DEV uses fixed executor/bounded queue; production uses Celery | **PARTIAL** | Main mechanism is present at `backend/app/api/routes/compare.py:22-33,166-188`. Setup/imports before `try` can still leak a slot on exceptional initialization. |
| Heavy `pdf_tools` routes are off the FastAPI event loop | **PARTIAL** | Core operations use `run_in_threadpool`, but ZIP creation still calls synchronous `ZipFile.write` inside the async route at `backend/app/api/routes/pdf_tools.py:321-327`. |
| Upload streaming and ZIP-to-file cleanup | **PARTIAL** | Upload helper streams/caps at `backend/app/utils/file_handler.py:21-48`; ZIP success path uses `FileResponse` and cleanup at `backend/app/api/routes/pdf_tools.py:321-334`. Some single-output/exception paths are not fully cleaned, and the refactor changes extension/error behavior. |
| N-Up chunks use paths instead of bytes | **PARTIAL** | Worker returns a temp path at `backend/app/workers/nup_process_chunk.py:1309-1323`; merge opens sequentially at `backend/app/workers/nup_engine.py:3070-3155`, but deletes all chunks only after the complete merge at `:3157-3161`. Cancellation is not implemented/proven. |
| Preview layout has field constraints and hard caps | **TRUE** | Constraints at `backend/app/api/routes/imposition.py:1301-1355`; cell/page-map caps and 422 at `:1541-1562`. This proves a guardrail, not a speedup. |
| Manifest engine opens each source once and supports selection/blank/rotation | **TRUE in isolation** | `backend/app/workers/pdf_manifest_engine.py:16-73`; basic tests pass. The Combine caller is still incorrect end-to-end. |
| Combine threshold and backend delegation work end-to-end | **FALSE** | Threshold/predicate exists at `desktop/src/lib/combineDelegation.ts:1-51`, call at `desktop/src/components/CombineTab.tsx:810-823`; whole-file PDFs lose pages because `page_index` is omitted and backend defaults to page 0. Blank pages also default to A4 because width/height are not sent (`CombineTab.tsx:47-49`). |
| Combine removes large-file WebView memory pressure | **PARTIAL** | It avoids building the `pdf-lib` object graph, but source files are still materialized as Blobs/FormData at `desktop/src/lib/api.ts:173-207,549-560`, and output returns as a whole Blob. |
| API error formatting preserves old behavior | **PARTIAL** | Normal string/object/FastAPI-array errors still throw at `desktop/src/lib/api.ts:12-23`; some empty/primitive array edge cases now format differently. |
| Two large Imposer stringifications are memoized | **TRUE** | `desktop/src/components/imposition-tools/ImposerDashboard.tsx:214-219,243-253`. A smaller per-render `JSON.stringify(params)` remains at `:1470-1476`. |
| Persist debounce/pagehide/tab scope/legacy seed is complete | **PARTIAL** | Mechanisms exist at `desktop/src/components/imposition-tools/store/persist.ts:18-70` and `useImposerSettingsStore.ts:43-59`; generated tab IDs are not reused and keys are not removed on close, so orphaned keys can accumulate and legacy seed semantics remain stale. |
| Dieline removed `preserveDrawingBuffer` and uses render-target readback | **PARTIAL** | Wiring is present at `desktop/src/components/dieline-tool/MockupCanvas.tsx:96-109` and `useSceneExport.ts:157-217`. No pixel-equivalence test, MSAA configuration, total-pixel cap, or device-capability check was found. |
| Vite manual chunks and 1.5 MB bundle budget | **TRUE, narrowly scoped** | `desktop/vite.config.ts:5-20,48-65`. This is an entry-chunk budget, not a total-app/vendor/worker budget. |
| Lint budget ratchet blocks total and per-rule growth | **TRUE when invoked** | `desktop/scripts/lint/check-budget.mjs:41-49` against `lint-budget.json`; no mandatory CI invocation was found. |
| 405-line NupGridSolver diff is cosmetic | **TRUE for solver arithmetic** | Diff inspection shows `let→const`, renamed bindings, removed unused variables and whitespace/catch cleanup; no numeric literal/operator/branch/loop-bound changes. Evidence around `desktop/src/lib/imposerEngine/NupGridSolver.ts:434-457,551-574,1450-1458`. |
| Rust dead-code/cfg cleanup does not break dev/release | **TRUE** | `cargo check` and `cargo check --release` both passed with zero warnings; Rust unit tests passed 38/38. |
| Viewer render and large-file save are proven faster | **FALSE as a performance claim** | Code exists: PDFium thumbnail path at `desktop/src/components/acrobat/ThumbSidebar.tsx:98-116`, LRU at `desktop/src-tauri/src/lib.rs:94-99`, disk copy at `desktop/src/components/ImpositionTab.tsx:1816-1825`. No reproducible before/after benchmark exists. Ghostscript fallback and dead main-preview code remain. |
| Warm-up moved into splash period | **PARTIAL** | Scheduling moved to `desktop/src/App.tsx:160-163`; no cold-launch trace proves benefit, and warm-up can compete with splash/auth resources. |
| Full P1-8 lifecycle and global resource scheduler are implemented | **FALSE** | There is partial viewer suspension, but no complete `active/paused/serialized` lifecycle and no scheduler shared by N-Up, VDP, Compare, and PDF tools. |
| Performance improvements are already proven by real numbers | **FALSE** | No before/after RSS, cold-launch, P95 status latency, or benchmark matrix exists. Correctness tests are not performance measurements. |

## Gates executed

| Gate | Result |
|---|---|
| `desktop/npm run build` | **PASS**; entry chunk about 1.148 MB and budget passed. Vite still warns about chunks over 500 kB and ineffective dynamic imports. |
| `desktop/npm test` | **PASS — 110/110 test files; 955 passed, 2 skipped** |
| `node scripts/lint/check-budget.mjs` | **PASS — 1,549 errors, 112 warnings**; this is not a clean lint result. |
| `cargo check` | **PASS, 0 warnings** |
| `cargo check --release` | **PASS, 0 warnings** |
| `cargo test` | **PASS — 38/38** |
| Backend `py_compile` | **PASS — 20 related Python files** |
| `tests/test_perf_sampler.py` | **PASS — 9/9**; does not invoke `_spawn_nup_process`, so it misses the runtime `NameError`. |
| CSV + manifest tests | **PASS — 5/5** |
| Compare queue/engine/pipeline tests | **PASS — 30/30** |
| VDP integration tests | **PASS — 14/14** on the current machine |

The document's statement that the 14 VDP integration tests could not run because PostgreSQL was unavailable is stale for this audit. The documented `121/121` backend total could not be independently reproduced because the exact test-selection command is not recorded.

## Priority risks

1. **P0:** Fix or revert the uncommitted N-Up instrumentation before any merge.
2. **P0:** Fix Combine manifest semantics and add end-to-end whole-PDF/page-selection/rotation/blank tests.
3. **P1:** Gate all instrumentation work, measure process-tree RSS and peak temp usage, and add queue latency/P95 status measurements.
4. **P1:** Reserve VDP capacity before parsing/copying; use fixed workers/tokens instead of retaining large queued datasets and waiting threads.
5. **P1:** Move ZIP creation fully into a threadpool and close exception/single-output cleanup gaps.
6. **P1:** Rework persist-key lifecycle and Dieline total-pixel/device limits.
7. **P2:** Address viewer render churn, stale tile-cache clearing, upload contract drift, and connect lint budget to CI.

## Scores

- **Current architecture safety: 4/10.** The direction (bounded work, streaming, temp-file chunks, explicit budgets) is good, but the current implementation contains a broken primary N-Up path and data-loss in large Combine.
- **Performance proven: 1/10.** Build/tests prove compilation and selected correctness only; they do not prove faster execution, lower RSS, faster launch, or improved P95 latency.

## Recommended next sequence

1. Correct the N-Up instrumentation failure and add an integration test asserting `queued → running → terminal` plus slot release with `PRYNX_PERF` both on and off.
2. Correct the Combine manifest contract and add output-equivalence tests against the frontend path.
3. Implement process-tree/peak-disk instrumentation and capture repeatable baselines for N-Up, VDP, Compare, viewer cold launch/scroll, and Dieline export.
4. Only after those correctness gates pass, use the benchmark matrix to make before/after performance claims.


## Remediation update - 2026-07-23

The verdict above records the state that was independently audited. The current working tree now removes the two P0 correctness blockers and closes the actionable code findings from that verdict.

| Finding | Remediated state |
|---|---|
| N-Up instrumentation and slot leaks | Instrumentation is fully gated; setup is inside the lifecycle guard; process-tree RSS, peak job-temp bytes and sample count are recorded. Queue lifecycle is tested with performance sampling both enabled and disabled. |
| Whole-PDF Combine and rotated blank | A missing page_index now means the whole source PDF. Explicit selection, composed rotation and blank-page rotation/size inheritance are covered at engine and HTTP-route levels. A rendered four-page fixture visually confirmed rotated content plus a correctly rotated blank final page. |
| Combine WebView memory | Native desktop inputs are sent as file paths and the native result is returned as a path-stub File, so the large path does not round-trip source/output bytes through the WebView. Browser fallback remains multipart/Blob by platform necessity. |
| VDP admission and transport | Capacity is reserved before parsing/copying. Inputs are spooled to disk, queued jobs retain paths instead of row arrays, parsing starts only in a fixed executor, and CSV preview/generate/batch paths keep the source file-backed. |
| Compare initialization | Fixed-executor setup/import/database failures release the reservation on every path. |
| Shared resource scheduling | N-Up, VDP, local Compare and PDF-tools threadpool work now share PRYNX_MAX_HEAVY_JOBS admission in addition to their feature-local queue limits. |
| PDF-tools event loop and cleanup | ZIP creation, watermarking and the complete ZIP write are off-loop. FileResponse success cleanup, exception cleanup, split-directory cleanup and interrupted-upload cleanup are covered. Unsupported extensions return 415 before writing. |
| N-Up chunk lifetime | Imported chunks are removed as soon as their content is consumed; outer cleanup remains the failure/cancellation safety net. |
| API error formatting | Strings and FastAPI message arrays are preserved; empty/primitive arrays and circular objects use a stable fallback. |
| Imposer render/persistence | The remaining per-page parameter stringify is memoized. Tab-scoped keys mirror the latest preferences to the legacy seed, are removed on tab close, and orphan scoped keys are collected once per session. |
| Dieline export | Export checks the device texture limit and a 40,000,000-pixel aggregate cap. WebGL row conversion has pixel-equivalence coverage; bounded MSAA is explicit and disabled for large targets. The 3D WebGL tree is serialized when its tab is inactive. |
| Viewer | Ghostscript thumbnail fallback and the dead main-preview branch were removed. PDFium remains the single render path; background viewers suspend and per-file tile URLs are revoked on tab close. |
| CI lint gate | CI invokes npm run lint:budget, which ratchets both total and per-rule findings. |

### Verification after remediation

- Backend full suite: **1,118 passed**.
- Desktop full suite: **964 passed, 2 skipped** across 113 test files.
- Desktop typecheck: **PASS**.
- Production build: **PASS**; entry chunk **1,148.63 kB**, below the 1.5 MB budget.
- Lint budget: **PASS** at **1,548 errors / 112 warnings**. This is a ratchet, not a clean-lint claim.
- Rotated-blank PDF inspection: **4 pages**; source pages retain /Rotate=90, the blank page has a 500x300 pt media box with /Rotate=90, and Poppler rendering confirms a blank 300x500 visible page.

### Claims that intentionally remain open

The code now provides reproducible opt-in measurements, but this remediation does **not** invent before/after product numbers. Peak RSS for production-scale N-Up/VDP/Compare workloads, Tauri/WebView2 cold launch and scroll traces, cancellation latency, and P95 status latency still require representative customer fixtures and the target release hardware. Until that matrix is captured, performance improvement claims remain **unproven**, even though the correctness, admission, cleanup and budget gates above pass.
