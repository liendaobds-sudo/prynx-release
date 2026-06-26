# Gable Lid Fix — Bugfix Design

## Overview

The Gable Box generator (`desktop/src/lib/dieline/GableBox.ts`) draws a handle ("nắp/quai
xách") whose displayed parameters disagree with the geometry actually drawn, renders ~20
developer debug labels onto the small lid area in production, and has several structural
desyncs (handle height not propagated to the side flap, a dead `ratioSLH` lookup, a grip hole
flush on the main fold, and a mixed reference frame for the handle top). The default roof mode
is `gableStyle === 'pitched'`, so most of these defects manifest by default.

This fix is **targeted and minimal**. It touches only the gable surface area:

- `desktop/src/lib/dieline/GableBox.ts` — `generateGableBox`, `buildGablePanel`, `buildSideTriFlap`
- `desktop/src/lib/dieline/types.ts` — `BoxParams` doc comments for `HH`, `HFH`, `SLH` (comments only)
- `desktop/src/lib/dieline/constants.ts` — two new constants (debug-annotation flag, grip-hole margin)
- a new shared module `desktop/src/lib/dieline/gableGeometry.ts` (single source of truth for `h1`/`h2`)
- `desktop/src/components/dieline-tool/ParamPanel.tsx` — gable hint computation + labels (UI only)

The strategy is the bug-condition methodology: for each defect we define a bug condition `C(X)`
over gable `BoxParams`, a corrected property `P`, and verify both that the fix holds for `C(X)`
(fix-checking) and that everything outside `C(X)` is unchanged (preservation). The preservation
gate is the existing dieline-hardening golden-master / regression suite, which already snapshots
the byte-level geometry of all 8 generators.

This is **client-only TypeScript** (no backend). All verification runs under the existing
`desktop` vitest + fast-check setup, reusing `arbBoxParams('gable')` from `arbitraries.ts`.

## Glossary

- **Bug_Condition (C)**: A predicate over a `BoxParams` value `X` with `X.boxType === 'gable'`
  that identifies the inputs triggering a given defect (see "Bug Conditions" per defect).
- **Property (P)**: The corrected behavior expected for inputs where `C(X)` holds.
- **Preservation**: Existing behavior that MUST remain unchanged — the byte-identical geometry of
  the other 7 generators, and the already-correct gable invariants (flat-mode hints, closed
  perimeter, CUT/CREASE classification, crash-lock bottom, junction fillets, `handleY === 'center'`).
- **F / F'**: The Gable pipeline before (F) and after (F') the fix.
- **`generateGableBox`**: Top-level generator in `GableBox.ts` that assembles the gable dieline.
- **`buildGablePanel`**: Helper drawing the front/back gable panel (trapezoid ABCD + handle AEFB +
  lock tabs + grip hole YKNM).
- **`buildSideTriFlap`**: Helper drawing the triangular side flap with its lock slot (rãnh).
- **`h1`**: Base trapezoid height of the gable. `W/√3` when `pitched`, `W/2` when `flat`.
- **`h2`**: Handle (AEFB) height. `HFH` when `HFH > 0`, else `0.9·h1`.
- **AB crease**: The main fold line (`_A`→`_B`) between the trapezoid base and the handle.
- **ngàm (lock tab)**: The gable locking tab (OPRA / QTBH rectangles), height `rectH = SLH/100·h2`.
- **rãnh (lock slot)**: The mating slot cut into the side flap, depth `slotH`. ngàm and rãnh MUST
  reference the same height to mate during assembly.
- **`HH`**: `BoxParams` field — side-flap (triangular tai) height knob (`overrideH` of `buildSideTriFlap`).
- **`HFH`**: `BoxParams` field — the single handle-height knob (overrides `h2`).
- **`SLH`**: `BoxParams` field — dual role: gable lock-tab height ratio AND side-flap slot depth ratio.

## Bug Details

### Bug Condition

The bug manifests whenever a Gable Box is generated or its parameters are shown. The master
condition is `X.boxType === 'gable'`; each defect refines it. Across the pipeline, F either
(a) computes a UI hint from the wrong roof formula, (b) emits developer debug text into
`annotations`, (c) reads a nonexistent `ratioSLH` field, (d) fails to propagate `HFH`/`h2` and
`SLH` into the side flap, (e) places the grip hole flush on the AB crease, or (f) mixes reference
frames for the handle-top width.

**Formal Specification (master + per-defect refinements):**
```
FUNCTION isBugCondition(X)
  INPUT:  X of type BoxParams
  OUTPUT: boolean
  RETURN X.boxType = 'gable' AND (
           isBug1(X) OR isBug4(X) OR isBug5(X) OR
           isBug6(X) OR isBug7(X) OR isBug8(X) OR
           docLabelBehaviorDisagree(X)            // Defects 2 & 3
         )
END FUNCTION

FUNCTION isBug1(X)  RETURN X.gableStyle = 'pitched'           END  // UI hint h1 mismatch
FUNCTION isBug4(X)  RETURN true                               END  // dead ratioSLH (always)
FUNCTION isBug5(X)  RETURN true                               END  // debug annotations (always)
FUNCTION isBug6(X)  RETURN X.HFH > 0                          END  // h2 desync to side flap
FUNCTION isBug7(X)  RETURN X.handleY = 'bottom'               END  // grip hole flush on crease
FUNCTION isBug8(X)  RETURN X.gableStyle = 'pitched'           END  // mixed EF reference frame
```

### Examples

- **Defect 1** — `gable`, `pitched`, `W = 90`: ParamPanel shows `h1 = round(90/2) = 45`, but the
  generator draws `h1 = round(90/√3) ≈ 52`. Every dependent hint (`Cao tay cầm = 0.9·h1`,
  `Cao lỗ quai = h2/2`, `Cao tai hộp = h1+h2`) is therefore wrong. Expected: hints use `90/√3`.
- **Defect 4** — `gable`, `SLH = 60`: `sideFlapFold` reads `(params as any).ratioSLH || 85`, which
  is always `85`; changing `SLH` does not change the computed fold angle. Expected: the angle
  reference uses `params.SLH` (and `h2`, not `0.9·h1`).
- **Defect 5** — any `gable`: `gable_front_handle.annotations` and `side_flap_left.annotations`
  contain entries like `"O (Đỉnh ngàm trái)"`, `"Chân rãnh (yBase)"`. Expected: empty in production.
- **Defect 6** — `gable`, `HFH = 70`: `buildGablePanel` uses `h2 = 70` so `rectH = SLH/100·70`,
  but `buildSideTriFlap` uses `h2 = 0.9·h1` so `slotH = SLH/100·(0.9·h1)`. ngàm and rãnh depths
  diverge. Expected: both use `h2 = 70`.
- **Defect 7** — `gable`, `handleY = 'bottom'`: `holeBottomY = _A.y` (on the AB crease). Expected:
  `holeBottomY ≥ _A.y + margin`, `margin > 0`.
- **Defect 8** — `gable`, `pitched`: `EF_width = 2/3·panelW` while `AB_width = 5/6·panelW`, so the
  handle top is measured against a different base than `insetEF`. Expected: `EF_width` derived from
  `AB_width` (so flat stays `2/3·panelW`, pitched becomes `2/3·AB_width`).
- **Edge / preservation** — `gable`, `flat`: `h1 = W/2` already matches the UI; this case MUST
  remain correct after the Defect-1 fix.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- All 7 non-gable generators (`rte`, `slb`, `paper_bag`, `cup_sleeve`, `pizza`, `envelope`, `tray`)
  produce byte-identical `panels` and `allPaths` (no coordinate drift > 0.001 mm).
- The Gable flat 2D dieline remains valid: closed perimeter, correct CUT/CREASE classification,
  correct crash-lock bottom (female receiver / male hook / dust flaps), and junction fillets.
- `gableStyle === 'flat'`: UI hint `h1 = W/2` continues to match the generator (already correct).
- `handleY === 'center'`: the grip hole stays vertically centered within `h2` exactly as before.
- Public API of all 8 generators (signatures and return shapes) is unchanged.
- `BoxParams` field **names** (`HH`, `HFH`, `SLH`, …) are unchanged — see API Constraint below.

**Scope:**
All inputs with `boxType !== 'gable'` MUST be completely unaffected. Within `gable`, only the
gable lid surface (front/back gable panels, side flaps, the UI hints/labels) changes; the body
panels and crash-lock bottom geometry are untouched.

> **API Constraint (Defects 2 & 3):** We MUST NOT rename `BoxParams` fields. These values are
> persisted (serialized into saved dieline parameter sets), so renaming `HH`/`HFH`/`SLH` would
> break deserialization of existing saved boxes. The reconciliation in Defects 2/3 is therefore
> achieved by aligning **doc comments** (`types.ts`), **UI labels/help text** (`ParamPanel.tsx`),
> and **code usage** (`GableBox.ts`) onto a single agreed meaning per field — never by renaming.

**Note:** The corrected positive behavior for each defect is defined in the Correctness Properties
section below; this section enumerates what MUST NOT change.

## Hypothesized Root Cause

1. **Duplicated `h1` formula (Defect 1)**: `buildGablePanel` and `generateGableBox` compute
   `h1 = pitched ? W/√3 : W/2`, but `ParamPanel.tsx` (~line 696) hardcodes `h1 = W/2`
   independently. Two copies of the same formula drifted. Root cause: no shared helper.

2. **Field-meaning drift (Defects 2 & 3)**: `HH` is documented as "handle height" in `types.ts`
   but used as the side-flap triangle height (`overrideH`) and labeled "Cao tai hộp"; `HFH` is the
   real handle knob. `SLH` drives both `rectH` (gable tab) and `slotH` (side-flap slot) but is
   labeled only "Sâu rãnh (%)". Root cause: docs/labels were never reconciled with code usage.

3. **Dead field reference (Defect 4)**: `generateGableBox` reads `(params as any).ratioSLH || 85`,
   but `BoxParams` has no `ratioSLH` field, so it is always `85`. The angle reference also uses
   `0.9·h1` rather than the `HFH`-overridable `h2`. Root cause: a parameter was renamed to `SLH`
   in the type but not at this call site, hidden by the `as any` cast.

4. **Debug scaffolding left in (Defect 5)**: `buildGablePanel` pushes ~10 labels (`A`, `B`, `O`,
   `P`, `R`, `E`, `F`, `Q`, `T`, `H`) and `buildSideTriFlap` pushes 2 (`Chân rãnh`, `Đỉnh rãnh`)
   into `annotations`, which the renderer draws unconditionally. Root cause: development aids never
   gated for production.

5. **`h2` not threaded (Defect 6)**: `buildSideTriFlap` recomputes `h2 = 0.9·h1` locally and has no
   `HFH` parameter, so `HFH` cannot reach it. Root cause: missing parameter on the helper.

6. **Hole anchored on crease (Defect 7)**: in `buildGablePanel`, `holeBottomY` defaults to `_A.y`
   for `handleY === 'bottom'`. Root cause: no minimum margin above the AB crease.

7. **Mixed reference frame (Defect 8)**: `EF_width = 2/3·panelW` while `insetEF` is derived from
   `AB_width` (= `5/6·panelW` when pitched). Root cause: `EF_width` should be a ratio of `AB_width`.

## Correctness Properties

Property 1: Bug Condition — UI hint `h1` equals generator `h1` (Defect 1)

_For any_ gable `X` where the bug condition holds (`isBug1(X)`, i.e. `pitched`), the ParamPanel hint
`h1` SHALL be computed by the same shared helper `gableH1(W, gableStyle)` the generator uses, so the
displayed default hints (`Cao tay cầm`, `Cao lỗ quai`, `Cao tai hộp`) equal the generator's values
within integer rounding.

**Validates: Requirements 2.1**

Property 2: Bug Condition — doc, label, and behavior agree for `HH`/`HFH`/`SLH` (Defects 2 & 3)

_For any_ gable `X`, the meaning of each field is consistent across the three sources: `types.ts`
documents `HH` as side-flap height and `HFH` as the single handle-height knob; `ParamPanel.tsx`
labels them accordingly; `SLH`'s dual role (gable lock-tab height + side-flap slot depth) is stated
in both its doc comment and its UI help/label. No `BoxParams` field is renamed.

**Validates: Requirements 2.2, 2.3**

Property 3: Bug Condition — `SLH` is honored in the fold computation (Defect 4)

_For any_ gable `X` where the bug condition holds (`isBug4(X)`), `generateGableBox` SHALL compute
`sideFlapFold` from `params.SLH` (not a nonexistent `ratioSLH`) and from the `HFH`-overridable `h2`,
so that varying `SLH` (or `HFH`) changes the computed fold angle.

**Validates: Requirements 2.4**

Property 4: Bug Condition — no developer debug annotations (Defect 5)

_For any_ gable `X` where the bug condition holds (`isBug5(X)`), every gable panel and side-flap
panel SHALL carry an empty `annotations` array in production (debug labels gated off).

**Validates: Requirements 2.5**

Property 5: Bug Condition — ngàm/rãnh reference heights stay equal (Defect 6)

_For any_ gable `X` where the bug condition holds (`isBug6(X)`, i.e. `HFH > 0`), `buildSideTriFlap`
SHALL use the same `h2` as `buildGablePanel` (`h2 = HFH > 0 ? HFH : 0.9·h1`), so the gable lock-tab
reference height (`rectH`) and the side-flap slot reference height (`slotH`) are computed from an
equal `h2`.

**Validates: Requirements 2.6**

Property 6: Bug Condition — grip hole sits above the AB crease (Defect 7)

_For any_ gable `X` where the bug condition holds (`isBug7(X)`, i.e. `handleY === 'bottom'`), the
grip-hole bottom `holeBottomY` SHALL satisfy `holeBottomY ≥ _A.y + margin` with `margin > 0`, and
the hole SHALL still fit within `h2` (no negative/overflowing hole height).

**Validates: Requirements 2.7**

Property 7: Bug Condition — `EF_width` uses a single reference frame (Defect 8)

_For any_ gable `X` where the bug condition holds (`isBug8(X)`, i.e. `pitched`), `EF_width` SHALL be
derived from `AB_width` (`EF_width = 2/3·AB_width`) so it shares the reference frame of `insetEF`;
in `flat` mode `AB_width = panelW`, so `EF_width = 2/3·panelW` is preserved exactly.

**Validates: Requirements 2.8**

Property 8: Preservation — non-gable generators byte-identical

_For any_ input where the bug condition does NOT hold because `X.boxType !== 'gable'`, the fixed
pipeline SHALL produce the same `panels` and `allPaths` as the original (no coordinate drift
> 0.001 mm, same counts/order/tags), preserving all 7 other generators and the 8 public APIs.

**Validates: Requirements 3.1, 3.3, 3.6**

Property 9: Preservation — gable flat dieline and already-correct invariants unchanged

_For any_ gable input outside the corrected bug surface (flat-mode hints, closed perimeter,
CUT/CREASE classification, crash-lock bottom, junction fillets, `handleY === 'center'` centering),
the fixed pipeline SHALL preserve the prior behavior: the flat 2D dieline remains valid and the
flat-mode UI hint `h1 = W/2` and centered-hole behavior are unchanged.

**Validates: Requirements 3.2, 3.4, 3.5, 3.6**

## Fix Implementation

### Change 0 — Shared `h1`/`h2` helper (single source of truth, Defect 1 & supports 6)

**New file**: `desktop/src/lib/dieline/gableGeometry.ts`

```ts
// Single source of truth for gable handle geometry.
// Imported by BOTH the generator (GableBox.ts) and the UI hints (ParamPanel.tsx)
// so the two can never diverge again.
import { snap } from './utils';

/** Base trapezoid height: W/√3 (pitched) or W/2 (flat). */
export function gableH1(W: number, gableStyle: 'flat' | 'pitched'): number {
    return snap(gableStyle === 'pitched' ? W / Math.sqrt(3) : W / 2);
}

/** Handle (AEFB) height: HFH override when > 0, else 0.9·h1. */
export function gableH2(h1: number, HFH: number = 0): number {
    return snap(HFH > 0 ? HFH : 0.9 * h1);
}
```

- Re-export from `desktop/src/lib/dieline/index.ts`: `export * from './gableGeometry';`
  (the barrel already does `export * from './types'` / `'./utils'`).
- **`GableBox.ts`**: replace the three inline `h1 = ... W/√3 : W/2` computations (in
  `generateGableBox`, `buildGablePanel`, `buildSideTriFlap`) with `gableH1(...)`, and replace
  `defaultH2`/`h2` computations with `gableH2(h1, overrideHFH)`.
- **`ParamPanel.tsx`**: import the helper and replace the hardcoded hint formulas.
  `ParamPanel.tsx` already imports from the dieline lib; add
  `import { gableH1, gableH2 } from '@/lib/dieline';` (match the existing import alias/style in the
  file). Hint block becomes:
  ```ts
  const h1 = Math.round(gableH1(params.W, params.gableStyle));
  const h2 = Math.round(gableH2(h1, params.HFH));
  const defHH  = h1 + h2;
  const defHW  = Math.round(2 / 5 * params.L);
  const defHHL = Math.round(h2 / 2);
  // 'Cao tay cầm' default likewise uses Math.round(gableH2(h1, 0))
  ```

### Change 1 — `types.ts` doc comments (Defects 2 & 3; comments only, no rename)

```ts
/** Chiều cao tai mái (side-flap triangle) vượt cạnh trên thân hộp (mm), mặc định 40.
 *  Đây là chiều cao của tai mái tam giác (buildSideTriFlap), KHÔNG phải tay cầm. */
HH: number;
...
/** Chiều cao phần tay cầm mái chính — núm điều khiển DUY NHẤT cho chiều cao tay cầm
 *  (mm), 0 = tự động (0.9·h1). Ghi đè h2 cho cả nắp gable và tai mái. */
HFH: number;
...
/** SLH có HAI vai trò (cùng một giá trị %): (1) chiều cao ngàm khóa nắp gable
 *  (rectH = SLH/100·h2) và (2) độ sâu rãnh gài trên tai mái (slotH). Mặc định 85. */
SLH: number;
```

### Change 2 — ParamPanel labels/help (Defects 2 & 3; UI only)

In the `gableParams` array:
- `HH` label → `'Cao tai mái'` (side-flap height) with help text clarifying it is the triangular
  side flap, not the handle.
- `HFH` label stays `'Cao tay cầm'` and is documented as the single handle-height knob.
- `SLH` label → `'Sâu rãnh / ngàm (%)'` with help text: "đặt cả chiều cao ngàm khóa nắp và độ sâu
  rãnh gài tai mái". Keep `key: 'SLH'`, unit `%`.

### Change 3 — Honor `SLH` and `h2` in `sideFlapFold` (Defect 4)

**File**: `GableBox.ts`, `generateGableBox`, the `sideFlapFold` block:
```ts
// BEFORE:
const rectH = snap(((params as any).ratioSLH || 85) / 100 * (0.9 * h1));
// AFTER:
const h2 = gableH2(h1, params.HFH);
const rectH = snap((params.SLH / 100) * h2);
```
Remove the `as any` cast entirely. `h1` here already uses `gableH1` (Change 0).

### Change 4 — Gate debug annotations off in production (Defect 5)

**File**: `constants.ts`
```ts
/** Bật nhãn debug nội bộ trên nắp gable / tai mái. Mặc định false (production). */
export const GABLE_DEBUG_ANNOTATIONS = false;
```
**Files**: `buildGablePanel` and `buildSideTriFlap` guard every `annotations.push(...)`:
```ts
if (GABLE_DEBUG_ANNOTATIONS) {
    annotations.push(/* ... */);
}
```
Mechanism chosen: **gate behind a compile-time-default-off flag** rather than deleting, so the dev
affordance is recoverable without re-typing the label geometry. With the flag `false`, both
`annotations` arrays are empty, satisfying Property 4.

### Change 5 — Thread `HFH`/`h2` into `buildSideTriFlap` (Defect 6)

**File**: `GableBox.ts`. Add an `overrideHFH` parameter to `buildSideTriFlap` and use the shared
`gableH2`:
```ts
function buildSideTriFlap(
    xLeft: number, xRight: number,
    yBase: number, sideW: number, panelW: number, dir: 1 | -1,
    overrideH: number = 0,
    gableStyle: 'flat' | 'pitched' = 'flat',
    slotW: number = 3,
    ratioSLH: number = 85,
    overrideTRW: number = 0,
    overrideHFH: number = 0,          // NEW — same h2 source as buildGablePanel
): { ... } {
    const h1 = gableH1(sideW, gableStyle);
    const h2 = gableH2(h1, overrideHFH);    // was: snap(0.9 * h1)
    const rectH = snap((ratioSLH / 100) * h2);
    ...
}
```
Update both call sites in `generateGableBox` (`sfLResult`, `sfRResult`) to pass `params.HFH`.

> This is an **internal helper** signature change with a defaulted trailing parameter; the
> **public** generator API (`generateGableBox(params)`) is unchanged (Requirement 3.3).

### Change 6 — Minimum grip-hole margin above AB crease (Defect 7)

**File**: `constants.ts`
```ts
/** Lề tối thiểu giữa đáy lỗ quai và đường gập AB (mm). */
export const GRIP_HOLE_CREASE_MARGIN = 4;
```
**File**: `buildGablePanel`, the `holeBottomY` computation:
```ts
let holeBottomY = snap(_A.y + GRIP_HOLE_CREASE_MARGIN);   // 'bottom' now lifts off the crease
if (holeYMode === 'center') {
    holeBottomY = snap(_A.y + (h2 - holeH) / 2);          // unchanged centering (Req 3.5)
}
// Clamp holeH so the hole + margin fits within the handle area h2.
const maxHoleH = snap(h2 - GRIP_HOLE_CREASE_MARGIN - 1);
const holeH = snap(Math.min(overrideHHL > 0 ? overrideHHL : defaultHoleH, maxHoleH));
```
Order the `holeH` clamp before `holeBottomY` so the available height accounts for the margin.

### Change 7 — Derive `EF_width` from `AB_width` (Defect 8)

**File**: `buildGablePanel`:
```ts
// BEFORE:
const EF_width = snap(2 / 3 * panelW);
// AFTER:
const EF_width = snap(2 / 3 * AB_width);   // flat: AB_width=panelW ⇒ unchanged; pitched: 2/3·(5/6·L)
```
`insetEF = (AB_width - EF_width)/2` now shares the `AB_width` reference frame in both modes.

## Testing Strategy

### Validation Approach

Two phases. First, run **exploratory** tests against the UNFIXED code to surface counterexamples
that confirm each root cause. Then implement the fix and run **fix-checking** (the bug condition no
longer holds) plus **preservation** (everything outside the bug surface is unchanged). The existing
dieline-hardening **golden-master** (`goldenMaster.test.ts`) and **regression** (`regression.test.ts`)
suites are the preservation gate: they snapshot byte-level geometry for all 8 generators.

New tests live in `desktop/src/lib/dieline/gableLidFix.test.ts` (unit + property) and a hint-parity
unit beside the UI logic. Property tests reuse `arbBoxParams('gable')` from `arbitraries.ts` and the
`fc.assert(fc.property(...), { numRuns: 100 })` pattern used in `geometry.test.ts` / `regression.test.ts`.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples demonstrating each defect on UNFIXED code; confirm/refute root
causes. If refuted, re-hypothesize before fixing.

**Test Cases**:
1. **Hint parity (Defect 1)**: assert `round(uiH1(W,'pitched')) === round(W/√3)` — fails (UI gives `W/2`).
2. **SLH ignored (Defect 4)**: generate with `SLH=60` vs `SLH=90`, assert `sideFlapFold` differs —
   fails (both use `85`).
3. **Debug labels (Defect 5)**: assert `gable_front_handle.annotations.length === 0` — fails (~10 labels).
4. **h2 desync (Defect 6)**: with `HFH=70`, compare gable `rectH` reference vs side-flap `slotH`
   reference — fails (panel uses 70, flap uses `0.9·h1`).
5. **Grip hole on crease (Defect 7)**: `handleY='bottom'`, assert `holeBottomY > _A.y` — fails (equal).
6. **EF frame (Defect 8)**: `pitched`, assert `EF_width === 2/3·AB_width` — fails (`2/3·panelW`).

**Expected Counterexamples**: each assertion above fails on F, pinning the defect to its hypothesized site.

### Fix Checking

**Goal**: For all inputs where a bug condition holds, F' produces the corrected behavior.

**Pseudocode:**
```
FOR ALL X WHERE isBug1(X) DO ASSERT round(uiH1(X)) = round(generatorH1(X)) END FOR
FOR ALL X WHERE isBug4(X) DO ASSERT foldAngle depends on X.SLH AND on X.HFH END FOR
FOR ALL X WHERE isBug5(X) DO ASSERT gablePanel.annotations = [] AND sideFlap.annotations = [] END FOR
FOR ALL X WHERE isBug6(X) DO ASSERT gableTab_h2(F'(X)) = sideFlapSlot_h2(F'(X)) END FOR
FOR ALL X WHERE isBug7(X) DO ASSERT holeBottomY(F'(X)) >= A_y + margin AND holeH > 0 END FOR
FOR ALL X WHERE isBug8(X) DO ASSERT EF_width(F'(X)) = 2/3 * AB_width(F'(X)) END FOR
```

### Preservation Checking

**Goal**: For all inputs where no bug condition holds (chiefly `boxType !== 'gable'`, plus the
already-correct gable invariants), F'(X) = F(X).

**Pseudocode:**
```
FOR ALL X WHERE X.boxType <> 'gable' DO
  ASSERT modelEquals(F(X), F'(X))      // panels + allPaths, ≤ 0.001 mm, same counts/order/tags
END FOR
```

**Testing Approach**: Property-based testing is preferred for preservation — it samples the whole
valid domain via `arbBoxParams`, catches edge cases manual tests miss, and gives strong guarantees
that non-gable geometry is unchanged. The existing **`regression.test.ts`** (per-generator golden
master + determinism PBT) and **`goldenMaster.test.ts`** (SVG char-identical) are the authoritative
gate: they MUST stay green for the 7 non-gable generators with no snapshot changes.

**Test Plan**: Run the full suite on UNFIXED code to capture baselines (already committed as
snapshots), apply the fix, then re-run. Only the **gable** snapshot is expected to change; the
other 7 MUST be byte-identical. The gable snapshot delta is reviewed to confirm it reflects only
the intended lid changes (empty annotations, lifted grip hole, narrower pitched EF, threaded h2).

**Test Cases**:
1. **Non-gable invariance**: `regression.test.ts` golden master for `rte, slb, paper_bag,
   cup_sleeve, pizza, envelope, tray` — snapshots unchanged.
2. **Flat-mode hint (Req 3.4)**: assert `round(uiH1(W,'flat')) === round(W/2)` still holds after fix.
3. **Centered hole (Req 3.5)**: with `handleY='center'`, assert hole vertical centering within `h2`
   is unchanged from the recorded baseline.
4. **Gable flat dieline validity (Req 3.2)**: `validateClosedContours` / contour + CUT/CREASE
   checks (as in `geometry.test.ts`) still pass for gable across `arbBoxParams('gable')`.

### Unit Tests

- `gableH1` / `gableH2` helper: exact values for flat vs pitched, and `HFH` override vs default.
- ParamPanel hint parity: `Cao tay cầm`, `Cao lỗ quai`, `Cao tai hộp` defaults equal generator
  values (within rounding) for both roof modes.
- `buildGablePanel`: grip-hole `holeBottomY ≥ _A.y + margin` for `bottom`; centering unchanged for
  `center`; `EF_width === 2/3·AB_width`.
- `buildSideTriFlap`: with `overrideHFH > 0`, `slotH` reference equals the gable panel's `rectH`
  reference; `annotations` empty.
- Annotation gating: both gable panels and both side flaps have `annotations.length === 0`.

### Property-Based Tests

- **Hint = generator (Property 1)**: `arbBoxParams('gable')` → `round(uiH1) === round(generatorH1)`.
- **SLH/HFH honored (Property 3)**: for random gable `X`, recompute `sideFlapFold` with perturbed
  `SLH`/`HFH` and assert the angle responds (no longer pinned to 85 / `0.9·h1`).
- **No annotations (Property 4)**: all gable/side-flap panels have empty `annotations` for every `X`.
- **ngàm/rãnh equal (Property 5)**: for `HFH > 0`, gable-tab `h2` equals side-flap `h2`.
- **Grip hole above crease (Property 6)**: for `handleY='bottom'`, `holeBottomY ≥ _A.y + margin`
  and `holeH > 0` across the domain.
- **Preservation (Property 8)**: reuse the `regression.test.ts` determinism/golden-master harness;
  the 7 non-gable generators stay byte-identical (≤ 0.001 mm).

### Integration Tests

- Full `generateGableBox` over `arbBoxParams('gable')`: model still passes the existing
  closed-perimeter / CUT-CREASE / crash-lock contour checks from `geometry.test.ts`.
- ParamPanel render smoke for gable: displayed defaults match the generator after switching
  `gableStyle` flat ↔ pitched (hint recomputation through the shared helper).
- Export path unaffected: `goldenMaster.test.ts` SVG snapshots for the 7 non-gable fixtures remain
  char-identical; the gable fixture delta is intentional and reviewed.
