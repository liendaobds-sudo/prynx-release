# Bugfix Requirements Document

## Introduction

The Gable Box (hộp quai xách) lid/handle ("nắp") drawn by `desktop/src/lib/dieline/GableBox.ts` is visually cluttered and its displayed parameters do not match the geometry that is actually drawn. An audit identified eight concrete defects spanning three areas:

- **Parameter/UI mismatch** — the ParamPanel hints are computed for the wrong roof mode and the `HH` / `HFH` / `SLH` parameters have inconsistent names, docs, and behavior across `types.ts`, `GableBox.ts`, and `ParamPanel.tsx`.
- **Visual clutter** — roughly 20 developer debug annotations are rendered onto the small lid area in production.
- **Structural correctness** — the handle reference height (`HFH`) does not propagate to the side-flap, a dead `ratioSLH` lookup ignores the user's `SLH`, the grip hole sits flush on the main fold crease, and the handle-top width mixes reference frames between roof modes.

The default roof mode is `gableStyle === 'pitched'`, so the defects manifest by default for most users. This bugfix corrects the displayed parameters, removes the production debug labels, and repairs the structural geometry so that the lock tab (ngàm) and side-flap slot (rãnh) mate, while preserving the flat 2D dieline correctness and leaving every other box generator unchanged.

**Scope constraints:**
- Changes limited to `desktop/src/lib/dieline/` (primarily `GableBox.ts`, `types.ts`, `validateParams.ts`) and the gable section of `desktop/src/components/dieline-tool/ParamPanel.tsx`.
- MUST NOT change the public API of the 8 generators or the behavior of any non-gable box type.
- MUST keep existing tests green (vitest + fast-check in `desktop`).

**Bug condition methodology key terms** (where `X` is a `BoxParams` value with `boxType === 'gable'`):
- **F** = the current Gable Box rendering/parameter pipeline (before fix).
- **F'** = the corrected pipeline (after fix).
- **C(X)** = predicate identifying gable inputs that trigger a given defect.
- **P(result)** = the corrected behavior expected for those inputs.

## Bug Analysis

### Current Behavior (Defect)

**Defect 1 — UI hints assume flat roof while the default is pitched (high priority, observable)**

1.1 WHEN `boxType === 'gable'` AND `gableStyle === 'pitched'` (the default) THEN ParamPanel computes `h1 = W/2` (ParamPanel.tsx ~line 696) while `GableBox` draws with `h1 = W/√3`, so the displayed default hints `Cao tay cầm` (`0.9·h1`), `Cao lỗ quai` (`h2/2`), and `Cao tai hộp` (`h1+h2`) do not match the drawn geometry.

**Defect 2 — `HH` semantics are contradictory across three places (high priority, observable)**

1.2 WHEN a user reads or sets `HH` THEN the meaning is inconsistent: `types.ts` documents `HH` as "handle height above box top", the code passes `HH` only to `buildSideTriFlap` as the triangular side-flap height (`overrideH`), and the UI labels it "Cao tai hộp" (side-flap height); the actual handle-height knob is `HFH`, so the parameter is misleading.

**Defect 3 — `SLH` drives two behaviors but is labeled once (high priority, observable)**

1.3 WHEN a user sets `SLH` THEN it simultaneously sets the gable locking-tab height (`rectH = SLH/100 · h2` in `buildGablePanel`) and the side-flap lock-slot depth (`slotH` in `buildSideTriFlap`), but the UI labels it only "Sâu rãnh (%)", hiding the locking-tab effect.

**Defect 4 — dead `ratioSLH` wiring ignores user `SLH` (high priority, observable)**

1.4 WHEN `generateGableBox` computes the side-flap 3D fold (`sideFlapFold`) THEN it reads `(params as any).ratioSLH || 85`, which always resolves to `85` because `BoxParams` has no `ratioSLH` field, so the user's `SLH` is ignored and the angle reference also uses `0.9·h1` instead of the (`HFH`-overridable) `h2`.

**Defect 5 — production debug annotations clutter the lid (high priority, observable)**

1.5 WHEN any gable panel is rendered THEN ~10 verbose debug annotations per panel (e.g. "O (Đỉnh ngàm trái)", "P (Góc trong ngàm trái)", "R (Chân ngàm trái)", "Q/T/H ...") plus the side-flap "Chân rãnh (yBase)" / "Đỉnh rãnh (slotH)" labels are emitted into `annotations`, totaling ~20 text labels across the two panels and making the small lid area look cluttered ("rối/lộn xộn").

**Defect 6 — `h2` desync between gable panel and side flap (structural)**

1.6 WHEN `HFH > 0` (user raises "Cao tay cầm") THEN `buildGablePanel` uses `h2 = HFH`, but `buildSideTriFlap` hardcodes `h2 = 0.9·h1` and so ignores `HFH`; the gable lock-tab height (`rectH`) and the side-flap slot depth (`slotH`) diverge and may not mate during assembly.

**Defect 7 — handle hole bottom sits on the AB fold crease (structural)**

1.7 WHEN `handleY === 'bottom'` (the default) THEN the handle hole bottom edge (`_M`, `_N`) is placed at `y = _A.y`, exactly on the AB main fold crease, so the grip hole opens flush on the fold instead of a few mm above it.

**Defect 8 — EF top-width uses a mixed reference frame (structural)**

1.8 WHEN `buildGablePanel` computes the handle-top width THEN `EF_width = 2/3 · panelW` is used for both flat and pitched modes, while `AB_width` and `insetEF` are derived from `AB_width` (which is `5/6·L` when pitched), so the handle-top proportions drift inconsistently between the two roof modes.

### Expected Behavior (Correct)

**Defect 1**

2.1 WHEN `boxType === 'gable'` THEN ParamPanel SHALL compute its hint `h1` using the same formula as the generator for the active `gableStyle` (`h1 = W/√3` for `pitched`, `h1 = W/2` for `flat`), so every displayed default hint equals the generator's value within rounding.

**Defect 2**

2.2 WHEN a user reads or sets gable parameters THEN the doc comment in `types.ts`, the UI label in `ParamPanel.tsx`, and the code usage in `GableBox.ts` for `HH` SHALL agree on a single meaning (side-flap height), and `HFH` SHALL be the single, clearly labeled handle-height knob.

**Defect 3**

2.3 WHEN a user sets `SLH` THEN the UI SHALL communicate that `SLH` controls both the gable locking-tab height and the side-flap lock-slot depth (label/help text reflecting both roles), and both behaviors SHALL remain driven by the same `SLH` value.

**Defect 4**

2.4 WHEN `generateGableBox` computes `sideFlapFold` THEN it SHALL use the real `params.SLH` value (not a nonexistent `ratioSLH` defaulting to 85) and SHALL use the `HFH`-overridable `h2` (consistent with `buildGablePanel`) as the height reference.

**Defect 5**

2.5 WHEN any gable panel or side flap is rendered in production THEN no developer debug annotations SHALL be emitted onto the lid (the `annotations` arrays for gable panels and side flaps SHALL be empty, or contain only intentional production labeling).

**Defect 6**

2.6 WHEN `HFH > 0` THEN `buildSideTriFlap` SHALL use the same `h2` value as `buildGablePanel` (`h2 = HFH > 0 ? HFH : 0.9·h1`), so the side-flap slot depth tracks the gable lock-tab height and the ngàm/rãnh reference heights stay equal.

**Defect 7**

2.7 WHEN `handleY === 'bottom'` THEN the handle hole bottom (`_M`, `_N`) SHALL sit at least a fixed margin above the AB crease (`holeBottomY ≥ _A.y + margin`, margin > 0), so the grip hole does not open flush on the fold.

**Defect 8**

2.8 WHEN `buildGablePanel` computes the handle-top width THEN `EF_width` SHALL be derived from the same reference frame as `AB_width` (e.g. a ratio of `AB_width`) consistently across both flat and pitched modes, so handle-top proportions do not drift between modes.

### Unchanged Behavior (Regression Prevention)

3.1 WHEN any non-gable box is generated (`boxType !== 'gable'`: `rte`, `slb`, `paper_bag`, `cup_sleeve`, `pizza`, `envelope`, `tray`) THEN the system SHALL CONTINUE TO produce identical geometry and parameters.

3.2 WHEN a Gable Box is generated THEN the system SHALL CONTINUE TO produce a correct flat 2D dieline (closed perimeter, valid CUT/CREASE classification, correct crash-lock bottom, junction fillets) as before.

3.3 WHEN the public APIs of the 8 generators are called THEN their signatures and return shapes SHALL CONTINUE TO be unchanged.

3.4 WHEN `gableStyle === 'flat'` THEN the UI hint `h1 = W/2` SHALL CONTINUE TO match the generator (this case was already correct and must remain so).

3.5 WHEN `handleY === 'center'` THEN the handle hole vertical centering within `h2` SHALL CONTINUE TO behave as before.

3.6 WHEN the existing vitest + fast-check test suite in `desktop` is run THEN all currently passing tests SHALL CONTINUE TO pass.

### Bug Conditions (Methodology)

The defects share the master condition `X.boxType === 'gable'`. Each defect refines it:

```pascal
FUNCTION isBugCondition_1(X)   // UI hint vs generator h1 mismatch
  RETURN X.boxType = 'gable' AND X.gableStyle = 'pitched'
END FUNCTION

FUNCTION isBugCondition_4(X)   // dead ratioSLH wiring
  RETURN X.boxType = 'gable'                      // SLH always ignored
END FUNCTION

FUNCTION isBugCondition_5(X)   // production debug annotations
  RETURN X.boxType = 'gable'                      // always rendered
END FUNCTION

FUNCTION isBugCondition_6(X)   // h2 desync (HFH not propagated to side flap)
  RETURN X.boxType = 'gable' AND X.HFH > 0
END FUNCTION

FUNCTION isBugCondition_7(X)   // grip hole flush on AB crease
  RETURN X.boxType = 'gable' AND X.handleY = 'bottom'
END FUNCTION

FUNCTION isBugCondition_8(X)   // mixed EF reference frame
  RETURN X.boxType = 'gable' AND X.gableStyle = 'pitched'
END FUNCTION
```

Representative fix-checking properties (defined over `F'`):

```pascal
// Property: Fix Checking — UI hint equals generator (Defect 1)
FOR ALL X WHERE isBugCondition_1(X) DO
  ASSERT uiHint_h1(X) = generator_h1(X)   // within rounding
END FOR

// Property: Fix Checking — SLH is honored (Defect 4)
FOR ALL X WHERE isBugCondition_4(X) DO
  ASSERT sideFlapFold(F'(X)) depends on X.SLH   // changing SLH changes the angle
END FOR

// Property: Fix Checking — no debug labels (Defect 5)
FOR ALL X WHERE isBugCondition_5(X) DO
  ASSERT gablePanel.annotations = [] AND sideFlap.annotations = []
END FOR

// Property: Fix Checking — ngàm/rãnh heights track HFH (Defect 6)
FOR ALL X WHERE isBugCondition_6(X) DO
  ASSERT gableTab_referenceHeight(F'(X)) = sideFlapSlot_referenceHeight(F'(X))
END FOR

// Property: Fix Checking — grip hole above crease (Defect 7)
FOR ALL X WHERE isBugCondition_7(X) DO
  ASSERT holeBottomY(F'(X)) >= A_y(F'(X)) + margin   // margin > 0
END FOR
```

Preservation goal (all non-gable inputs, and gable invariants that were already correct):

```pascal
// Property: Preservation Checking
FOR ALL X WHERE X.boxType <> 'gable' DO
  ASSERT F(X) = F'(X)
END FOR
```
