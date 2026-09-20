//! M72.B (2026-09-19): phương án số lượng đầy đủ bằng khung bao bảo thủ.
//! Không đổi contour/miền góc. Nếu seed không dựng được, trả None để NFP cũ xử lý.
//! Seed chỉ công bố sau validator thật; không dùng "valid" của phép xếp rectangle.

use super::{
    baseline_angles_with_fallback, local_ring_at, BaselineAnglePolicy, BaselineError,
    BaselineOutcome, BASELINE_VERSION,
};
use crate::mixed_nesting::control::RunControl;
use crate::mixed_nesting::model::{format_instance_id, PlacementRecord, Pose};
use crate::mixed_nesting::normalize::{BoundsMm, NormalizedRequest};
use crate::mixed_nesting::validator::{validate_layout, LayoutUnderReview};

fn gcd(mut a: u32, mut b: u32) -> u32 {
    while b != 0 {
        let next = a % b;
        a = b;
        b = next;
    }
    a
}

fn contains(a: BoundsMm, b: BoundsMm) -> bool {
    a.min_x <= b.min_x && a.min_y <= b.min_y && a.max_x >= b.max_x && a.max_y >= b.max_y
}

fn subtract(free: &mut Vec<BoundsMm>, used: BoundsMm) {
    let mut next = Vec::new();
    for r in free.drain(..) {
        if used.max_x <= r.min_x
            || used.min_x >= r.max_x
            || used.max_y <= r.min_y
            || used.min_y >= r.max_y
        {
            next.push(r);
            continue;
        }
        if used.min_x > r.min_x {
            next.push(BoundsMm {
                max_x: used.min_x,
                ..r
            });
        }
        if used.max_x < r.max_x {
            next.push(BoundsMm {
                min_x: used.max_x,
                ..r
            });
        }
        if used.min_y > r.min_y {
            next.push(BoundsMm {
                max_y: used.min_y,
                ..r
            });
        }
        if used.max_y < r.max_y {
            next.push(BoundsMm {
                min_y: used.max_y,
                ..r
            });
        }
    }
    *free = next
        .iter()
        .enumerate()
        .filter(|(i, r)| {
            !next.iter().enumerate().any(|(j, other)| {
                i != &j && contains(*other, **r) && (!contains(**r, *other) || j < *i)
            })
        })
        .map(|(_, r)| *r)
        .collect();
}

pub(super) fn run(
    request: &NormalizedRequest,
    control: &RunControl,
    policy: BaselineAnglePolicy,
) -> Result<Option<BaselineOutcome>, BaselineError> {
    run_impl(request, control, policy, true)
}

fn run_impl(
    request: &NormalizedRequest,
    control: &RunControl,
    policy: BaselineAnglePolicy,
    try_repeats: bool,
) -> Result<Option<BaselineOutcome>, BaselineError> {
    if !request.layout_intent.quantity_la_yeu_cau()
        || request.parts.len() < 2
        || request
            .parts
            .iter()
            .any(|part| part.quantity == 0 || part.placement_zone.is_some())
    {
        return Ok(None);
    }
    control.checkpoint_cancel_only()?;
    let copies = if try_repeats {
        request
            .parts
            .iter()
            .fold(0, |acc, part| gcd(acc, part.quantity))
            .max(1)
    } else {
        1
    };
    let (gx, gy, ox, oy) = match &request.production_contract {
        Some(c) => (
            c.clearance.part_to_part.x_mm,
            c.clearance.part_to_part.y_mm,
            c.clearance.part_to_obstacle.x_mm,
            c.clearance.part_to_obstacle.y_mm,
        ),
        None => (
            request.gap_mm,
            request.gap_mm,
            request.gap_mm,
            request.gap_mm,
        ),
    };
    let usable = request.sheet.usable;
    // Hở chỉ nằm GIỮA hai con; mép cuối không phải chừa thêm một lần hở.
    let mut empty = vec![BoundsMm {
        max_x: usable.max_x + gx,
        max_y: usable.max_y + gy,
        ..usable
    }];
    for obstacle in request.fixed_obstacles() {
        subtract(
            &mut empty,
            BoundsMm {
                min_x: obstacle.bounds.min_x - ox,
                min_y: obstacle.bounds.min_y - oy,
                max_x: obstacle.bounds.max_x + ox,
                max_y: obstacle.bounds.max_y + oy,
            },
        );
    }
    let mut order: Vec<_> = request.parts.iter().collect();
    order.sort_by(|a, b| {
        b.effective_area_mm2()
            .total_cmp(&a.effective_area_mm2())
            .then(a.part_id.cmp(&b.part_id))
    });
    let mut sheets: Vec<Vec<BoundsMm>> = Vec::new();
    let mut base = Vec::new();
    let mut attempts = 0;
    let mut orientations = 0;
    for part in order {
        control.checkpoint_cancel_only()?;
        let angles =
            baseline_angles_with_fallback(&part.rotation_domain, policy, &request.tolerance);
        let variants: Vec<_> = angles
            .into_iter()
            .filter_map(|angle| {
                let ring = local_ring_at(part, angle, &request.tolerance)?;
                Some((angle, BoundsMm::from_ring(&ring)?))
            })
            .collect();
        for ordinal in 1..=part.quantity / copies {
            control.checkpoint_cancel_only()?;
            let mut selected = None;
            for sheet_index in 0..=sheets.len() {
                if (sheet_index as u64 + 1) * u64::from(copies)
                    > u64::from(request.sheet.max_sheets)
                {
                    break;
                }
                let free = sheets.get(sheet_index).unwrap_or(&empty);
                for (angle, bounds) in &variants {
                    orientations += 1;
                    let width = bounds.width_mm() + gx;
                    let height = bounds.height_mm() + gy;
                    let anchor = free
                        .iter()
                        .filter(|r| width <= r.width_mm() + 1e-7 && height <= r.height_mm() + 1e-7)
                        .min_by(|a, b| {
                            a.min_y
                                .total_cmp(&b.min_y)
                                .then(a.min_x.total_cmp(&b.min_x))
                        });
                    if let Some(anchor) = anchor {
                        selected = Some((sheet_index, *angle, *bounds, *anchor));
                        break;
                    }
                }
                if selected.is_some() {
                    break;
                }
            }
            let Some((sheet_index, angle, bounds, anchor)) = selected else {
                return if copies > 1 {
                    run_impl(request, control, policy, false)
                } else {
                    Ok(None)
                };
            };
            if sheet_index == sheets.len() {
                sheets.push(empty.clone());
            }
            subtract(
                &mut sheets[sheet_index],
                BoundsMm {
                    min_x: anchor.min_x,
                    min_y: anchor.min_y,
                    max_x: anchor.min_x + bounds.width_mm() + gx,
                    max_y: anchor.min_y + bounds.height_mm() + gy,
                },
            );
            base.push((
                part,
                ordinal,
                sheet_index as u32,
                Pose::new(
                    angle,
                    anchor.min_x - bounds.min_x,
                    anchor.min_y - bounds.min_y,
                ),
            ));
            attempts += 1;
        }
    }
    let base_sheet_count = sheets.len() as u32;
    // Không nhân một tờ cơ sở còn chỗ trống thành hàng trăm tờ lãng phí.
    // Nếu khung bao của một loại còn vừa, dàn toàn bộ SL thay vì áp hệ số chung.
    if copies > 1 {
        for part in &request.parts {
            control.checkpoint_cancel_only()?;
            for angle in
                baseline_angles_with_fallback(&part.rotation_domain, policy, &request.tolerance)
            {
                if let Some(bounds) = local_ring_at(part, angle, &request.tolerance)
                    .and_then(|ring| BoundsMm::from_ring(&ring))
                {
                    if sheets.iter().flatten().any(|r| {
                        bounds.width_mm() + gx <= r.width_mm() + 1e-7
                            && bounds.height_mm() + gy <= r.height_mm() + 1e-7
                    }) {
                        return run_impl(request, control, policy, false);
                    }
                }
            }
        }
    }
    let mut placements = Vec::new();
    for copy in 0..copies {
        control.checkpoint_cancel_only()?;
        for (part, ordinal, sheet_index, pose) in &base {
            placements.push(PlacementRecord {
                instance_id: format_instance_id(
                    &part.part_id,
                    copy * (part.quantity / copies) + ordinal,
                ),
                part_id: part.part_id.clone(),
                sheet_index: copy * base_sheet_count + sheet_index,
                pose: *pose,
                source_revision: part.source_revision.clone(),
            });
        }
    }
    let report = validate_layout(
        request,
        &LayoutUnderReview {
            placements: &placements,
            unplaced: &[],
            stats: None,
        },
    );
    control.checkpoint_cancel_only()?;
    if !report.valid {
        return Ok(None);
    }
    Ok(Some(BaselineOutcome {
        placements,
        unplaced: Vec::new(),
        sheet_count: base_sheet_count * copies,
        attempts,
        orientation_evaluations: orientations,
        periodic_motif: false,
        baseline_version: BASELINE_VERSION,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mixed_nesting::control::{CancelToken, ProgressChannel, StopCriterion};
    use crate::mixed_nesting::model::*;
    use crate::mixed_nesting::normalize::normalize_request;
    use std::sync::Arc;

    fn request(count: usize, quantity: u32) -> NormalizedRequest {
        let parts = (0..count)
            .map(|i| PartSpec {
                part_id: format!("p-{i:03}"),
                quantity,
                outer: vec![
                    PointMm::new(0., 0.),
                    PointMm::new(70., 0.),
                    PointMm::new(70., 70.),
                    PointMm::new(0., 70.),
                ],
                holes: vec![],
                rotation_constraint: RotationConstraint::Fixed { angle_deg: 0.0 },
                reference_point_mm: Some(PointMm::new(0., 0.)),
                geometry_hash: None,
                source_revision: None,
            })
            .collect();
        normalize_request(&MixedNestingRequest {
            sheet: SheetSpec {
                width_mm: 224.,
                height_mm: 224.,
                margin_mm: SheetMarginMm {
                    left: 5.,
                    right: 5.,
                    top: 5.,
                    bottom: 5.,
                },
                max_sheets: 1000,
            },
            parts,
            gap_mm: 2.,
            ..MixedNestingRequest::default()
        })
        .unwrap()
    }

    #[test]
    fn quantity_72_at_nine_per_sheet_has_eight_layouts() {
        for copies in [1, 100] {
            let req = request(72, copies);
            let control = RunControl::new(
                StopCriterion::with_deadline(0, 0),
                CancelToken::new(),
                Arc::new(ProgressChannel::new()),
            );
            let plan = run(&req, &control, BaselineAnglePolicy::FirstAllowed)
                .unwrap()
                .unwrap();
            assert_eq!(plan.sheet_count, 8 * copies);
            assert_eq!(plan.placements.len(), 72 * copies as usize);
            for sheet in 0..plan.sheet_count {
                assert_eq!(
                    plan.placements
                        .iter()
                        .filter(|p| p.sheet_index == sheet)
                        .count(),
                    9
                );
            }
            assert!(
                validate_layout(
                    &req,
                    &LayoutUnderReview {
                        placements: &plan.placements,
                        unplaced: &[],
                        stats: None,
                    }
                )
                .valid
            );
        }
    }

    #[test]
    fn last_type_cancel_and_max_sheets_are_preserved() {
        let mut req = request(73, 1);
        let cancel = CancelToken::new();
        let control = RunControl::new(
            StopCriterion::fixed_work_plan(1),
            cancel.clone(),
            Arc::new(ProgressChannel::new()),
        );
        assert_eq!(
            run(&req, &control, BaselineAnglePolicy::FirstAllowed)
                .unwrap()
                .unwrap()
                .sheet_count,
            9
        );
        req.sheet.max_sheets = 8;
        assert!(run(&req, &control, BaselineAnglePolicy::FirstAllowed)
            .unwrap()
            .is_none());
        cancel.cancel();
        assert!(run(&req, &control, BaselineAnglePolicy::FirstAllowed).is_err());
    }

    #[test]
    fn repeated_orders_do_not_multiply_empty_space() {
        let mut req = request(2, 100);
        req.sheet.max_sheets = 23;
        let control = RunControl::new(
            StopCriterion::fixed_work_plan(1),
            CancelToken::new(),
            Arc::new(ProgressChannel::new()),
        );
        let plan = run(&req, &control, BaselineAnglePolicy::FirstAllowed)
            .unwrap()
            .unwrap();
        assert_eq!(plan.placements.len(), 200);
        assert_eq!(plan.sheet_count, 23);
        assert!(
            validate_layout(
                &req,
                &LayoutUnderReview {
                    placements: &plan.placements,
                    unplaced: &[],
                    stats: None,
                }
            )
            .valid
        );
    }
}
