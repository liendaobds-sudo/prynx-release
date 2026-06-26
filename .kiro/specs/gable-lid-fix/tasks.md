# Implementation Plan

## Overview

This plan fixes the 8 Gable Box lid defects using the bug-condition methodology. Tests come
**first**: an exploratory bug-condition test that MUST FAIL on the unfixed code (proving the bugs
exist), and a preservation baseline that MUST PASS on the unfixed code (locking in behavior to keep).
Only then is the fix applied (Changes 0–7 from `design.md`), followed by fix-checking and a final
full-suite run. All work is **client-only TypeScript** under `desktop/` (vitest + fast-check + tsc),
reusing `arbBoxParams('gable')` and the existing `regression.test.ts` / `goldenMaster.test.ts`
preservation gate.

## Task Dependency Graph

```json
{
  "waves": [
    { "wave": 0, "name": "Tests-first (before any production change)", "tasks": ["1", "2"], "dependsOn": [] },
    { "wave": 1, "name": "Shared foundation", "tasks": ["3"], "dependsOn": [0] },
    { "wave": 2, "name": "Core generator + constants", "tasks": ["4", "5", "6"], "dependsOn": [1] },
    { "wave": 3, "name": "UI hints + labels", "tasks": ["7"], "dependsOn": [1] },
    { "wave": 4, "name": "Verify fix + preservation + checkpoint", "tasks": ["8", "9", "10"], "dependsOn": [2, 3] }
  ]
}
```

```
Wave 0 — Tests-first (before any production change)
  ├─ Task 1  Bug-condition exploration test      [Property 1: Bug Condition]  (MUST FAIL on F)
  └─ Task 2  Preservation baseline tests          [Property 2: Preservation]   (MUST PASS on F)
                         │
                         ▼
Wave 1 — Shared foundation
  └─ Task 3  Change 0: gableGeometry.ts + index.ts re-export (gableH1 / gableH2)
                         │
        ┌────────────────┼─────────────────────────────┐
        ▼                ▼                              ▼
Wave 2 — Core generator + constants (depend on Task 3)
  ├─ Task 4  Changes 4 & 6: constants.ts (GABLE_DEBUG_ANNOTATIONS, GRIP_HOLE_CREASE_MARGIN)
  ├─ Task 5  Changes 0,3,4,5,6,7: GableBox.ts (depends on Task 3 + Task 4)
  └─ Task 6  Change 1: types.ts doc comments (comments only — independent, no rename)
                         │
                         ▼
Wave 3 — UI (depends on Task 3)
  └─ Task 7  Changes 0 & 2: ParamPanel.tsx hints + labels
                         │
                         ▼
Wave 4 — Verify fix + preservation (depend on Waves 2–3)
  ├─ Task 8  Fix-checking: re-run Task 1 (now PASS) + Properties 1,2,3,4,5,6,7,8 assertions
  ├─ Task 9  Re-run Task 2 preservation (still PASS; only gable snapshot changes, reviewed)
  └─ Task 10 Checkpoint — full suite: vitest + tsc in desktop
```

Critical ordering: **Task 1 runs first and is EXPECTED TO FAIL** on the unfixed code — that failure
is the confirmation that the bugs exist. Do not fix the test or the code when it fails in Wave 0.

## Tasks

- [ ] 1. Write the bug-condition exploration test (BEFORE any fix)
  - **Property 1: Bug Condition** — Gable Lid Defects (Defects 1, 4, 5, 6, 7, 8)
  - **CRITICAL**: This test MUST FAIL on the unfixed code — failure confirms the bugs exist.
  - **DO NOT attempt to fix the test or the production code when it fails here.**
  - **NOTE**: This same test file encodes the expected (corrected) behavior; it becomes the
    fix-checking gate in Task 8 when it flips to PASS.
  - **GOAL**: Surface a concrete counterexample for each defect, pinning it to its hypothesized site.
  - Create `desktop/src/lib/dieline/gableLidFix.test.ts`.
  - Use property-based tests (`fast-check`, `fc.assert(fc.property(arbBoxParams('gable'), ...), { numRuns: 100, seed: <record the seed printed on first run> })`) for the defects mapped to PBT, and plain unit assertions for the deterministic ones:
    - **Defect 1 / Design Property 1 (PBT)** — `isBug1(X)` (`pitched`): assert `round(uiH1(W,'pitched')) === round(W/√3)`. Expect FAIL (UI hardcodes `W/2`). Record counterexample (e.g. `W=90 → UI 45 vs generator 52`).
    - **Defect 4 / Design Property 3 (PBT)** — `isBug4(X)`: generate with `SLH=60` vs `SLH=90` and assert the computed `sideFlapFold` angle differs. Expect FAIL (both resolve to the dead `ratioSLH || 85`).
    - **Defect 5 / Design Property 4 (PBT)** — `isBug5(X)`: assert `gable_front_handle.annotations.length === 0` and `side_flap_left.annotations.length === 0`. Expect FAIL (~20 debug labels).
    - **Defect 6 / Design Property 5 (PBT)** — `isBug6(X)` (`HFH > 0`, e.g. `HFH=70`): assert the gable-panel `rectH` reference `h2` equals the side-flap `slotH` reference `h2`. Expect FAIL (panel uses 70, flap uses `0.9·h1`).
    - **Defect 7 / Design Property 6 (PBT)** — `isBug7(X)` (`handleY='bottom'`): assert `holeBottomY > _A.y` (above the AB crease). Expect FAIL (equal — flush on crease).
    - **Defect 8 / Design Property 7 (unit, deterministic)** — `pitched`, fixed `L`: assert `EF_width === round(2/3·AB_width)`. Expect FAIL (`2/3·panelW`).
  - **Scoped PBT approach**: for the deterministic defects (7, 8) scope the property to concrete failing cases so the counterexample is reproducible; for 1, 4, 5, 6 keep the universal `arbBoxParams('gable')` property.
  - Run on UNFIXED code via `npx vitest run gableLidFix --run` in `desktop`.
  - **EXPECTED OUTCOME**: every assertion above FAILS — this proves each defect exists.
  - Document the counterexamples (W/h1 mismatch, SLH-insensitive angle, annotation counts, h2 divergence, `holeBottomY === _A.y`, `EF_width === 2/3·panelW`) in the test file as comments.
  - Mark complete when the test is written, run, and the failures are documented.
  - _Requirements: 1.1, 1.4, 1.5, 1.6, 1.7, 1.8_
  - _Design Properties: 1, 3, 4, 5, 6, 7_

- [ ] 2. Write preservation baseline tests (BEFORE any fix)
  - **Property 2: Preservation** — Non-gable byte-identical + already-correct gable invariants
  - **IMPORTANT**: Follow the observation-first methodology — observe behavior on UNFIXED code, then
    assert it, and confirm the assertions PASS before changing any production code.
  - **GOAL**: Lock in everything outside the bug surface so the fix cannot silently regress it.
  - Reuse the existing preservation gate rather than re-deriving it:
    - **Design Property 8 (PBT preservation)** — confirm `regression.test.ts` (per-generator golden
      master + determinism PBT, `numRuns: 100`) and `goldenMaster.test.ts` (SVG char-identical) are
      GREEN for the 7 non-gable generators (`rte, slb, paper_bag, cup_sleeve, pizza, envelope, tray`).
      Record the current snapshots as the baseline (already committed).
    - **Design Property 9 (unit preservation)** — add to `gableLidFix.test.ts`:
      - Flat-mode hint (Req 3.4): assert `round(uiH1(W,'flat')) === round(W/2)` — observe it already holds on F.
      - Centered hole (Req 3.5): with `handleY='center'`, observe and record the hole vertical
        centering within `h2`; assert it equals the recorded baseline.
      - Gable flat dieline validity (Req 3.2): reuse the closed-perimeter / CUT-CREASE contour checks
        from `geometry.test.ts` against `arbBoxParams('gable')`; observe they pass on F.
  - Run on UNFIXED code: `npx vitest run regression goldenMaster gableLidFix --run` in `desktop`.
  - **EXPECTED OUTCOME**: all preservation assertions PASS — this is the baseline to preserve.
  - Mark complete when the tests are written/identified, run, and passing on unfixed code.
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_
  - _Design Properties: 8, 9_

- [ ] 3. Change 0 — Add the shared `gableGeometry.ts` helper (single source of truth)
  - Create `desktop/src/lib/dieline/gableGeometry.ts` exporting:
    - `gableH1(W, gableStyle)` → `snap(gableStyle === 'pitched' ? W/√3 : W/2)`.
    - `gableH2(h1, HFH = 0)` → `snap(HFH > 0 ? HFH : 0.9·h1)`.
  - Import `snap` from `./utils`.
  - Re-export from `desktop/src/lib/dieline/index.ts`: `export * from './gableGeometry';`.
  - This helper is the foundation that both `GableBox.ts` (Task 5) and `ParamPanel.tsx` (Task 7)
    consume so the `h1`/`h2` formulas can never diverge again.
  - [ ]* 3.1 Unit-test `gableH1` / `gableH2` exact values
    - Assert `gableH1` for flat (`W/2`) vs pitched (`W/√3`), and `gableH2` for `HFH` override vs the
      `0.9·h1` default. Add to `gableLidFix.test.ts`.
    - _Requirements: 2.1_
    - _Design Properties: 1_
  - _Requirements: 2.1, 2.6_
  - _Design Properties: 1, 5_

- [ ] 4. Changes 4 & 6 — Add gating + margin constants
  - In `desktop/src/lib/dieline/constants.ts` add:
    - `export const GABLE_DEBUG_ANNOTATIONS = false;` (production gate for lid debug labels — Change 4).
    - `export const GRIP_HOLE_CREASE_MARGIN = 4;` (min mm between grip-hole bottom and AB crease — Change 6).
  - _Requirements: 2.5, 2.7_
  - _Design Properties: 4, 6_

- [ ] 5. Changes 0, 3, 4, 5, 6, 7 — Repair `GableBox.ts`
  - Parent task; depends on Task 3 (helper) and Task 4 (constants).
  - [ ] 5.1 Change 0 — Replace inline `h1`/`h2` with the shared helper
    - Replace the three inline `h1 = pitched ? W/√3 : W/2` computations (in `generateGableBox`,
      `buildGablePanel`, `buildSideTriFlap`) with `gableH1(...)`, and the `defaultH2`/`h2`
      computations with `gableH2(h1, overrideHFH)`. Import from `./gableGeometry` (or the barrel).
    - _Bug_Condition: isBug1(X) — pitched_
    - _Expected_Behavior: generator h1/h2 come from gableH1/gableH2 (Design Change 0)_
    - _Requirements: 2.1_
    - _Design Properties: 1_
  - [ ] 5.2 Change 3 — Honor `params.SLH` and `h2` in `sideFlapFold`
    - In `generateGableBox`'s `sideFlapFold` block, remove the `(params as any).ratioSLH || 85` read
      and the `as any` cast; compute `const h2 = gableH2(h1, params.HFH);` then
      `const rectH = snap((params.SLH / 100) * h2);`.
    - _Bug_Condition: isBug4(X) — always (gable)_
    - _Expected_Behavior: sideFlapFold depends on params.SLH and HFH-overridable h2 (Design Change 3)_
    - _Requirements: 2.4_
    - _Design Properties: 3_
  - [ ] 5.3 Change 4 — Gate debug annotations behind `GABLE_DEBUG_ANNOTATIONS`
    - Wrap every `annotations.push(...)` in `buildGablePanel` and `buildSideTriFlap` in
      `if (GABLE_DEBUG_ANNOTATIONS) { ... }`. With the flag `false`, both arrays stay empty.
    - _Bug_Condition: isBug5(X) — always (gable)_
    - _Expected_Behavior: gablePanel.annotations = [] AND sideFlap.annotations = [] (Design Change 4)_
    - _Requirements: 2.5_
    - _Design Properties: 4_
  - [ ] 5.4 Change 5 — Thread `overrideHFH` into `buildSideTriFlap`
    - Add a defaulted trailing `overrideHFH: number = 0` parameter to `buildSideTriFlap`; inside, use
      `const h2 = gableH2(h1, overrideHFH);` (was `snap(0.9·h1)`) so `rectH = snap((ratioSLH/100)·h2)`.
      Update both call sites (`sfLResult`, `sfRResult`) in `generateGableBox` to pass `params.HFH`.
    - Internal helper signature change only; public `generateGableBox(params)` API unchanged.
    - _Bug_Condition: isBug6(X) — HFH > 0_
    - _Expected_Behavior: buildSideTriFlap h2 = buildGablePanel h2 (Design Change 5)_
    - _Preservation: public generator signatures unchanged (Req 3.3)_
    - _Requirements: 2.6_
    - _Design Properties: 5_
  - [ ] 5.5 Change 6 — Lift the grip hole off the AB crease
    - In `buildGablePanel`: set `let holeBottomY = snap(_A.y + GRIP_HOLE_CREASE_MARGIN);` for the
      `bottom` mode; keep the `center` branch (`snap(_A.y + (h2 - holeH)/2)`) unchanged. Clamp
      `holeH` first: `const maxHoleH = snap(h2 - GRIP_HOLE_CREASE_MARGIN - 1);` then
      `holeH = snap(Math.min(overrideHHL > 0 ? overrideHHL : defaultHoleH, maxHoleH));` so the hole +
      margin always fits within `h2`.
    - _Bug_Condition: isBug7(X) — handleY = 'bottom'_
    - _Expected_Behavior: holeBottomY ≥ _A.y + margin AND holeH > 0 (Design Change 6)_
    - _Preservation: handleY = 'center' centering unchanged (Req 3.5)_
    - _Requirements: 2.7_
    - _Design Properties: 6_
  - [ ] 5.6 Change 7 — Derive `EF_width` from `AB_width`
    - In `buildGablePanel`: replace `const EF_width = snap(2/3·panelW);` with
      `const EF_width = snap(2/3·AB_width);`. In flat mode `AB_width === panelW` (unchanged); in
      pitched `AB_width = 5/6·L`, so `EF_width` and `insetEF` now share one reference frame.
    - _Bug_Condition: isBug8(X) — pitched_
    - _Expected_Behavior: EF_width = 2/3·AB_width (Design Change 7)_
    - _Preservation: flat-mode EF_width = 2/3·panelW unchanged_
    - _Requirements: 2.8_
    - _Design Properties: 7_
  - _Requirements: 2.1, 2.4, 2.5, 2.6, 2.7, 2.8, 3.3, 3.5_
  - _Design Properties: 1, 3, 4, 5, 6, 7_

- [ ] 6. Change 1 — Reconcile `types.ts` doc comments (comments only, NO rename)
  - Update the `BoxParams` doc comments for `HH` (side-flap triangle height — NOT the handle),
    `HFH` (the single handle-height knob, overrides `h2`), and `SLH` (dual role: gable lock-tab
    height `rectH = SLH/100·h2` AND side-flap slot depth `slotH`).
  - **MUST NOT rename any field** — these values are persisted/serialized (API Constraint).
  - _Bug_Condition: docLabelBehaviorDisagree(X) — Defects 2 & 3_
  - _Expected_Behavior: doc, label, and code agree per field; no rename (Design Change 1)_
  - _Requirements: 2.2, 2.3_
  - _Design Properties: 2_

- [ ] 7. Changes 0 & 2 — Update `ParamPanel.tsx` hints and labels
  - Depends on Task 3 (shared helper).
  - [ ] 7.1 Change 0 — Compute hints from the shared helper
    - Add `import { gableH1, gableH2 } from '@/lib/dieline';` (match the file's existing import style)
      and replace the hardcoded `h1 = W/2` (~line 696) with
      `const h1 = Math.round(gableH1(params.W, params.gableStyle)); const h2 = Math.round(gableH2(h1, params.HFH));`
      so `Cao tay cầm` (`gableH2(h1,0)`), `Cao lỗ quai` (`h2/2`), and `Cao tai hộp` (`h1+h2`) match
      the generator for the active `gableStyle`.
    - _Bug_Condition: isBug1(X) — pitched_
    - _Expected_Behavior: uiH1 = generatorH1 within rounding (Design Change 0)_
    - _Preservation: flat-mode hint h1 = W/2 unchanged (Req 3.4)_
    - _Requirements: 2.1_
    - _Design Properties: 1_
  - [ ] 7.2 Change 2 — Relabel `HH` and `SLH` in the `gableParams` array
    - `HH` label → `'Cao tai mái'` with help text clarifying it is the triangular side flap, not the
      handle. `HFH` label stays `'Cao tay cầm'` (documented as the single handle knob). `SLH` label →
      `'Sâu rãnh / ngàm (%)'` with help text covering both roles. Keep all `key` values unchanged.
    - _Bug_Condition: docLabelBehaviorDisagree(X) — Defects 2 & 3_
    - _Expected_Behavior: labels/help agree with types.ts and code (Design Change 2)_
    - _Requirements: 2.2, 2.3_
    - _Design Properties: 2_

- [ ] 8. Verify the bug-condition exploration test now PASSES (fix-checking)
  - **Property 1: Expected Behavior** — Gable Lid Defects resolved
  - **IMPORTANT**: Re-run the SAME `gableLidFix.test.ts` from Task 1 — do NOT write a new test. The
    assertions that failed on F must now pass on F'.
  - Run `npx vitest run gableLidFix --run` in `desktop` (PBT with `numRuns: 100` and the recorded seed).
  - **EXPECTED OUTCOME**: all bug-condition assertions PASS, confirming each defect is fixed:
    - Property 1: `round(uiH1) === round(generatorH1)` for pitched.
    - Property 3: `sideFlapFold` angle responds to `SLH` and `HFH`.
    - Property 4: gable + side-flap `annotations` arrays are empty.
    - Property 5: gable-tab `h2` equals side-flap `h2` when `HFH > 0`.
    - Property 6: `holeBottomY ≥ _A.y + margin` and `holeH > 0` for `handleY='bottom'`.
    - Property 7: `EF_width === round(2/3·AB_width)` for pitched.
  - [ ]* 8.1 Add the remaining unit / integration assertions (Properties 2 & 7 detail + integration)
    - Property 2 (unit): assert `types.ts` doc, `ParamPanel` label, and `GableBox` usage agree per
      field (e.g. snapshot the label strings); confirm no field renamed.
    - Integration: full `generateGableBox` over `arbBoxParams('gable')` still passes the
      closed-perimeter / CUT-CREASE / crash-lock contour checks from `geometry.test.ts`.
    - _Requirements: 2.2, 2.3, 3.2_
    - _Design Properties: 2, 9_
  - _Requirements: 2.1, 2.4, 2.5, 2.6, 2.7, 2.8_
  - _Design Properties: 1, 3, 4, 5, 6, 7_

- [ ] 9. Verify preservation tests still PASS (no regressions)
  - **Property 2: Preservation** — Non-gable byte-identical + gable invariants
  - **IMPORTANT**: Re-run the SAME tests from Task 2 — do NOT write new tests.
  - Run `npx vitest run regression goldenMaster gableLidFix --run` in `desktop`.
  - **EXPECTED OUTCOME**: the 7 non-gable generators stay byte-identical (no snapshot changes,
    ≤ 0.001 mm), flat-mode hint and centered-hole behavior unchanged.
  - The **only** expected snapshot delta is the **gable** fixture — review it to confirm it reflects
    only the intended lid changes (empty annotations, lifted grip hole, narrower pitched EF, threaded
    `h2`, SLH-driven fold). Update the gable snapshot intentionally; do NOT update any other snapshot.
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_
  - _Design Properties: 8, 9_

- [ ] 10. Checkpoint — full suite green (vitest + tsc)
  - Run the full test suite and type-check in `desktop`:
    - `npx vitest run` (all dieline tests including `gableLidFix`, `regression`, `goldenMaster`,
      `geometry`, `generators`).
    - `npx tsc --noEmit` (no type errors from the helper, the `overrideHFH` parameter, or the removed
      `as any` cast).
  - Confirm all tests pass and only the gable snapshot changed. Ask the user if any question arises
    (e.g. an unexpected non-gable snapshot delta).
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_
  - _Design Properties: 8, 9_

## Notes

- **Bug-condition methodology**: Task 1 (exploration) must FAIL on the unfixed pipeline F; Task 2
  (preservation) must PASS on F. After applying Changes 0–7, Task 8 re-runs Task 1 (now PASS =
  fix-checking) and Task 9 re-runs Task 2 (still PASS = no regression). The same test files are
  reused — never rewritten — across the fail→pass transition.
- **Property-based tests** (fast-check, `numRuns: 100`, recorded seed) cover Design Properties 1, 3,
  4, 5, 6, 8. Deterministic defects (Property 7 / Defect 8) and the doc/label reconciliation
  (Property 2) use unit assertions. Optional test sub-tasks are marked with `*`.
- **Preservation gate**: the authoritative non-gable invariance check is the existing
  `regression.test.ts` (golden master + determinism PBT) and `goldenMaster.test.ts` (SVG
  char-identical). Only the **gable** snapshot may change; any other snapshot delta is a regression.
- **API constraint**: `BoxParams` field names (`HH`, `HFH`, `SLH`) are persisted — Defects 2 & 3 are
  fixed by aligning doc comments, UI labels, and code usage, never by renaming fields.
- **Scope**: changes are limited to `desktop/src/lib/dieline/` (`gableGeometry.ts`, `GableBox.ts`,
  `types.ts`, `constants.ts`, `index.ts`) and the gable section of
  `desktop/src/components/dieline-tool/ParamPanel.tsx`. Client-only TypeScript, no backend.
