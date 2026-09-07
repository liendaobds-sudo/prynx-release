//! S&R có quỹ đạo rigid: tìm tiếp xúc contour rồi nhân bản theo một basis duy nhất.
//!
//! NFP chỉ sinh ứng viên. Quan hệ giữa các láng giềng của lattice được kiểm bằng
//! contour thật một lần; phase/ốc/biên tờ chỉ bỏ cell, không dịch riêng bất kỳ tem nào.

use super::*;
use crate::mixed_nesting::kernel;

#[derive(Clone)]
struct Member {
    angle: f64,
    offset: PointMm,
    ring: Vec<PointMm>,
    bounds: BoundsMm,
}

#[derive(Clone)]
struct Motif {
    members: Vec<Member>,
    bounds: BoundsMm,
}

#[derive(Clone, Copy)]
struct Basis {
    pitch_x: f64,
    row: PointMm,
}

#[derive(Clone, Copy)]
struct Phase {
    origin: PointMm,
    count: usize,
    bounds: BoundsMm,
}

#[derive(Clone, Copy)]
struct Span {
    row: i64,
    member: usize,
    first: i64,
    last: i64,
}

struct Search<'a> {
    request: &'a NormalizedRequest,
    part: &'a NormalizedPart,
    control: &'a RunControl,
    best: Option<(LayoutScore, Vec<PlacementRecord>)>,
    attempts: u64,
    orientations: u64,
    // Chỉ sống trong một run, geometry/clearance không đổi. Dùng exact f64 bits,
    // không gộp hai khoảng hở khác nhau bằng lượng tử hoá cache key.
    pair_memo: BTreeMap<(u64, u64, u64, u64), bool>,
}

fn shifted(ring: &[PointMm], delta: PointMm) -> Vec<PointMm> {
    ring.iter()
        .map(|point| PointMm::new(point.x + delta.x, point.y + delta.y))
        .collect()
}

fn member(part: &NormalizedPart, angle: f64, offset: PointMm, tol: &Tolerance) -> Option<Member> {
    let ring = local_ring_at(part, angle, tol)?;
    let local = BoundsMm::from_ring(&ring)?;
    let bounds = translated_bounds(local, &Pose::new(angle, offset.x, offset.y));
    Some(Member {
        angle,
        offset,
        ring,
        bounds,
    })
}

fn motif(members: Vec<Member>) -> Option<Motif> {
    let bounds = members
        .iter()
        .map(|value| value.bounds)
        .reduce(union_bounds)?;
    Some(Motif { members, bounds })
}

fn phase_values(mut values: Vec<f64>, step: f64, tol: &Tolerance) -> Vec<f64> {
    values.retain(|value| value.is_finite());
    for value in &mut values {
        *value = value.rem_euclid(step);
        if *value <= tol.linear_mm || step - *value <= tol.linear_mm {
            *value = 0.0;
        }
    }
    values.sort_by(f64::total_cmp);
    values.dedup_by(|a, b| (*a - *b).abs() <= tol.linear_mm);
    let events = values.clone();
    for index in 0..events.len() {
        let end = events.get(index + 1).copied().unwrap_or(events[0] + step);
        values.push(((events[index] + end) * 0.5).rem_euclid(step));
    }
    values.sort_by(f64::total_cmp);
    values.dedup_by(|a, b| (*a - *b).abs() <= tol.linear_mm);
    values
}

fn row_range(
    motif: &Motif,
    basis: Basis,
    origin_y: f64,
    usable: BoundsMm,
    tol: &Tolerance,
) -> (i64, i64) {
    let first = ((usable.min_y - motif.bounds.max_y - origin_y - tol.linear_mm) / basis.row.y)
        .ceil() as i64;
    let last = ((usable.max_y - motif.bounds.min_y - origin_y + tol.linear_mm) / basis.row.y)
        .floor() as i64;
    (first, last)
}

impl Search<'_> {
    fn expired(&self) -> Result<bool, BaselineError> {
        // NESTROW (audit 2026-09-07 §NESTROW.1): periodic baseline là sàn an toàn
        // của S&R. Không được cắt giữa một motif rồi công bố candidate hợp lệ nhưng
        // hụt số tem chỉ vì tải máy/batch làm deadline dao động. Deadline vẫn được
        // kiểm ở barrier của multi_start sau khi baseline hoàn tất; smart trial không
        // chạy tiếp khi cửa sổ đã hết. Baseline chỉ tôn trọng hủy người dùng.
        self.control.checkpoint_cancel_only()?;
        Ok(false)
    }

    fn count(&self) -> usize {
        self.best.as_ref().map_or(0, |(_, values)| values.len())
    }

    fn span_summary(
        &self,
        motif: &Motif,
        basis: Basis,
        origin: PointMm,
    ) -> (Option<BoundsMm>, usize) {
        let usable = self.request.placement_bounds_for(self.part);
        let tol = self.request.tolerance;
        let (first_row, last_row) = row_range(motif, basis, origin.y, usable, &tol);
        let mut bounds: Option<BoundsMm> = None;
        let mut count = 0usize;
        for row in first_row..=last_row {
            let row_x = origin.x + row as f64 * basis.row.x;
            let row_y = origin.y + row as f64 * basis.row.y;
            for member in &motif.members {
                if member.bounds.min_y + row_y < usable.min_y - tol.linear_mm
                    || member.bounds.max_y + row_y > usable.max_y + tol.linear_mm
                {
                    continue;
                }
                let first = ((usable.min_x - member.bounds.min_x - row_x - tol.linear_mm)
                    / basis.pitch_x)
                    .ceil() as i64;
                let last = ((usable.max_x - member.bounds.max_x - row_x + tol.linear_mm)
                    / basis.pitch_x)
                    .floor() as i64;
                if first > last {
                    continue;
                }
                count = count.saturating_add((last - first + 1) as usize);
                let first_bounds = translated_bounds(
                    member.bounds,
                    &Pose::new(member.angle, row_x + first as f64 * basis.pitch_x, row_y),
                );
                let last_bounds = translated_bounds(
                    member.bounds,
                    &Pose::new(member.angle, row_x + last as f64 * basis.pitch_x, row_y),
                );
                let span_bounds = union_bounds(first_bounds, last_bounds);
                bounds =
                    Some(bounds.map_or(span_bounds, |current| union_bounds(current, span_bounds)));
            }
        }
        (bounds, count)
    }

    fn clash(&mut self, fixed: &Member, moving: &Member, delta: PointMm) -> bool {
        let delta = PointMm::new(
            delta.x + moving.offset.x - fixed.offset.x,
            delta.y + moving.offset.y - fixed.offset.y,
        );
        let key = (
            fixed.angle.to_bits(),
            moving.angle.to_bits(),
            delta.x.to_bits(),
            delta.y.to_bits(),
        );
        if let Some(&value) = self.pair_memo.get(&key) {
            return value;
        }
        self.attempts = self.attempts.saturating_add(1);
        let ring = shifted(&moving.ring, delta);
        let value = pair_clashes_for_request(self.request, &ring, &fixed.ring, false);
        self.pair_memo.insert(key, value);
        value
    }

    fn basis_valid(&mut self, motif: &Motif, basis: Basis) -> Result<bool, BaselineError> {
        let clearance = part_clearance_for_request(self.request);
        let x_reach = motif.bounds.width_mm() + clearance.reach_x_mm();
        let y_reach = motif.bounds.height_mm() + clearance.reach_y_mm();
        let last_row = (y_reach / basis.row.y).ceil() as i64;
        for row in 0..=last_row {
            self.control.checkpoint_cancel_only()?;
            if self.expired()? {
                return Ok(false);
            }
            let row_x = row as f64 * basis.row.x;
            let first_column = ((-x_reach - row_x) / basis.pitch_x).floor() as i64;
            let last_column = ((x_reach - row_x) / basis.pitch_x).ceil() as i64;
            for column in first_column..=last_column {
                if row == 0 && column < 0 {
                    continue;
                }
                let delta = PointMm::new(
                    row_x + column as f64 * basis.pitch_x,
                    row as f64 * basis.row.y,
                );
                for (fixed_index, fixed) in motif.members.iter().enumerate() {
                    for (moving_index, moving) in motif.members.iter().enumerate() {
                        if row == 0 && column == 0 && moving_index <= fixed_index {
                            continue;
                        }
                        let moved_bounds = translated_bounds(
                            moving.bounds,
                            &Pose::new(moving.angle, delta.x, delta.y),
                        );
                        if !bbox_may_clash(
                            &moved_bounds,
                            &fixed.bounds,
                            clearance,
                            &self.request.tolerance,
                        ) {
                            continue;
                        }
                        if self.clash(fixed, moving, delta) {
                            return Ok(false);
                        }
                    }
                }
            }
        }
        Ok(true)
    }

    fn spans(
        &self,
        motif: &Motif,
        basis: Basis,
        origin: PointMm,
    ) -> (Vec<Span>, Option<BoundsMm>, usize) {
        let usable = self.request.placement_bounds_for(self.part);
        let tol = self.request.tolerance;
        let (first_row, last_row) = row_range(motif, basis, origin.y, usable, &tol);
        let mut spans = Vec::new();
        let mut bounds: Option<BoundsMm> = None;
        let mut count = 0usize;
        for row in first_row..=last_row {
            let row_x = origin.x + row as f64 * basis.row.x;
            let row_y = origin.y + row as f64 * basis.row.y;
            for (index, member) in motif.members.iter().enumerate() {
                if member.bounds.min_y + row_y < usable.min_y - tol.linear_mm
                    || member.bounds.max_y + row_y > usable.max_y + tol.linear_mm
                {
                    continue;
                }
                let first = ((usable.min_x - member.bounds.min_x - row_x - tol.linear_mm)
                    / basis.pitch_x)
                    .ceil() as i64;
                let last = ((usable.max_x - member.bounds.max_x - row_x + tol.linear_mm)
                    / basis.pitch_x)
                    .floor() as i64;
                if first > last {
                    continue;
                }
                count = count.saturating_add((last - first + 1) as usize);
                let first_bounds = translated_bounds(
                    member.bounds,
                    &Pose::new(member.angle, row_x + first as f64 * basis.pitch_x, row_y),
                );
                let last_bounds = translated_bounds(
                    member.bounds,
                    &Pose::new(member.angle, row_x + last as f64 * basis.pitch_x, row_y),
                );
                let span_bounds = union_bounds(first_bounds, last_bounds);
                bounds =
                    Some(bounds.map_or(span_bounds, |current| union_bounds(current, span_bounds)));
                spans.push(Span {
                    row,
                    member: index,
                    first,
                    last,
                });
            }
        }
        (spans, bounds, count)
    }

    fn phases(&self, motif: &Motif, basis: Basis) -> Result<Vec<Phase>, BaselineError> {
        let usable = self.request.placement_bounds_for(self.part);
        let tol = self.request.tolerance;
        let obstacle_clearance = blocker_clearance_for_request(self.request, true);
        let mut y_events = Vec::new();
        for member in &motif.members {
            y_events.extend([
                usable.min_y - member.bounds.min_y,
                usable.max_y - member.bounds.max_y,
            ]);
            // NESTROW (audit 2026-09-07 §NESTROW.1): mép tờ không đủ để tìm
            // phase khi hai vật cản tạo một hành lang hẹp. Đây chỉ là ứng viên
            // theo bbox; mọi cell vẫn qua phán quyết contour/clearance thật.
            for obstacle in self.request.fixed_obstacles() {
                y_events.extend([
                    obstacle.bounds.min_y - obstacle_clearance.reach_y_mm() - member.bounds.max_y,
                    obstacle.bounds.max_y + obstacle_clearance.reach_y_mm() - member.bounds.min_y,
                ]);
            }
        }
        let mut phases = Vec::new();
        for origin_y in phase_values(y_events, basis.row.y, &tol) {
            self.control.checkpoint_cancel_only()?;
            if self.expired()? {
                break;
            }
            let (first_row, last_row) = row_range(motif, basis, origin_y, usable, &tol);
            let mut x_events = Vec::new();
            for row in first_row..=last_row {
                let row_x = row as f64 * basis.row.x;
                let row_y = origin_y + row as f64 * basis.row.y;
                for member in &motif.members {
                    if member.bounds.min_y + row_y < usable.min_y - tol.linear_mm
                        || member.bounds.max_y + row_y > usable.max_y + tol.linear_mm
                    {
                        continue;
                    }
                    x_events.extend([
                        usable.min_x - member.bounds.min_x - row_x,
                        usable.max_x - member.bounds.max_x - row_x,
                    ]);
                    for obstacle in self.request.fixed_obstacles() {
                        if member.bounds.min_y + row_y
                            > obstacle.bounds.max_y
                                + obstacle_clearance.reach_y_mm()
                                + tol.linear_mm
                            || member.bounds.max_y + row_y
                                < obstacle.bounds.min_y
                                    - obstacle_clearance.reach_y_mm()
                                    - tol.linear_mm
                        {
                            continue;
                        }
                        x_events.extend([
                            obstacle.bounds.min_x
                                - obstacle_clearance.reach_x_mm()
                                - member.bounds.max_x
                                - row_x,
                            obstacle.bounds.max_x + obstacle_clearance.reach_x_mm()
                                - member.bounds.min_x
                                - row_x,
                        ]);
                    }
                }
            }
            for origin_x in phase_values(x_events, basis.pitch_x, &tol) {
                if self.expired()? {
                    break;
                }
                let origin = PointMm::new(origin_x, origin_y);
                // PERF (audit 2026-09-07 §SMART.5): phase ranking chỉ cần bbox/count;
                // không dựng Vec<Span> rồi bỏ ngay trước khi consider() chạy. Giữ
                // `spans()` cho phase được chọn, tránh thêm NFP/evaluation.
                let (bounds, count) = self.span_summary(motif, basis, origin);
                if let Some(bounds) = bounds.filter(|_| count >= self.count()) {
                    phases.push(Phase {
                        origin,
                        count,
                        bounds,
                    });
                }
            }
        }
        let alignment = self
            .request
            .production_contract
            .as_ref()
            .map(|value| value.alignment);
        phases.sort_by(|a, b| {
            b.count
                .cmp(&a.count)
                .then(
                    (a.bounds.width_mm() * a.bounds.height_mm())
                        .total_cmp(&(b.bounds.width_mm() * b.bounds.height_mm())),
                )
                .then_with(|| {
                    alignment.map_or(std::cmp::Ordering::Equal, |value| {
                        alignment_residual_mm(value, &a.bounds, &usable)
                            .total_cmp(&alignment_residual_mm(value, &b.bounds, &usable))
                    })
                })
                .then(a.origin.y.total_cmp(&b.origin.y))
                .then(a.origin.x.total_cmp(&b.origin.x))
        });
        Ok(phases)
    }

    fn consider(&mut self, motif: &Motif, basis: Basis) -> Result<(), BaselineError> {
        let tol = self.request.tolerance;
        let usable = self.request.placement_bounds_for(self.part);
        if !basis.pitch_x.is_finite()
            || !basis.row.x.is_finite()
            || !basis.row.y.is_finite()
            || basis.pitch_x <= tol.linear_mm
            || basis.row.y <= tol.linear_mm
        {
            return Ok(());
        }
        if motif.members.iter().all(|member| {
            member.bounds.width_mm() > usable.width_mm() + tol.linear_mm
                || member.bounds.height_mm() > usable.height_mm() + tol.linear_mm
        }) {
            return Ok(());
        }
        // Cận diện tích vật liệu chỉ loại basis bất khả thi, không thay thế narrow phase.
        let cell_area = basis.pitch_x * basis.row.y;
        let material_area = self.part.effective_area_mm2() * motif.members.len() as f64;
        if cell_area + tol.linear_mm * (basis.pitch_x + basis.row.y) < material_area {
            return Ok(());
        }
        let phases = self.phases(motif, basis)?;
        if phases.is_empty() || !self.basis_valid(motif, basis)? {
            return Ok(());
        }
        for phase in phases {
            if self.expired()? || phase.count < self.count() {
                break;
            }
            let (spans, _, _) = self.spans(motif, basis, phase.origin);
            let mut placements = Vec::new();
            let mut interrupted = false;
            let mut begin = 0;
            // Trộn các span ngay khi đọc: chỉ giữ một cursor/member của hàng,
            // không cấp phát toàn bộ cell trước chốt protocol/cancel.
            'rows: while begin < spans.len() {
                let row = spans[begin].row;
                let end = begin
                    + spans[begin..]
                        .iter()
                        .take_while(|span| span.row == row)
                        .count();
                let row_spans = &spans[begin..end];
                let mut cursors: Vec<Option<i64>> =
                    row_spans.iter().map(|span| Some(span.first)).collect();
                while let Some(column) = cursors.iter().flatten().copied().min() {
                    if self.expired()? {
                        interrupted = true;
                        break 'rows;
                    }
                    for (cursor, span) in cursors.iter_mut().zip(row_spans) {
                        if *cursor != Some(column) {
                            continue;
                        }
                        *cursor = (column < span.last).then(|| column + 1);
                        self.control.checkpoint_cancel_only()?;
                        let member = &motif.members[span.member];
                        let origin = PointMm::new(
                            phase.origin.x
                                + column as f64 * basis.pitch_x
                                + row as f64 * basis.row.x,
                            phase.origin.y + row as f64 * basis.row.y,
                        );
                        let pose = Pose::new(
                            member.angle,
                            origin.x + member.offset.x,
                            origin.y + member.offset.y,
                        );
                        let ring = shifted(
                            &member.ring,
                            PointMm::new(pose.translate_x_mm, pose.translate_y_mm),
                        );
                        let Some(bounds) = BoundsMm::from_ring(&ring) else {
                            continue;
                        };
                        if !ring_within_bounds(&ring, &usable, &tol)
                            || violates_fixed_obstacle_contract(self.request, &ring, &bounds)
                        {
                            continue;
                        }
                        self.attempts = self.attempts.saturating_add(1);
                        if placements.len() as u64 >= MAX_INSTANCES_TOTAL {
                            return Err(BaselineError::CapacityInvariantExceeded);
                        }
                        placements.push(PlacementRecord {
                            instance_id: format_instance_id(
                                &self.part.part_id,
                                (placements.len() + 1) as u32,
                            ),
                            part_id: self.part.part_id.clone(),
                            sheet_index: 0,
                            pose,
                            source_revision: self.part.source_revision.clone(),
                        });
                    }
                }
                begin = end;
            }
            if interrupted {
                break;
            }
            if placements.is_empty() {
                continue;
            }
            let no_vacancy = placements.len() == phase.count;
            let score = score_layout(self.request, &placements, 0);
            if self
                .best
                .as_ref()
                .is_none_or(|(current, _)| score.is_better_than(current))
            {
                self.best = Some((score, placements));
            }
            if no_vacancy {
                // Các phase còn lại không hơn count/envelope của phase đã giữ đủ cell.
                break;
            }
        }
        Ok(())
    }
}

fn axis_contacts(region: &RegionMm, horizontal: bool, tol: &Tolerance) -> Vec<f64> {
    let mut result = Vec::new();
    for ring in region {
        for index in 0..ring.len() {
            let a = ring[index];
            let b = ring[(index + 1) % ring.len()];
            let (along_a, across_a, along_b, across_b) = if horizontal {
                (a.x, a.y, b.x, b.y)
            } else {
                (a.y, a.x, b.y, b.x)
            };
            if across_a.abs() <= tol.linear_mm && along_a > tol.linear_mm {
                result.push(along_a);
            }
            if (across_a < 0.0 && across_b > 0.0) || (across_a > 0.0 && across_b < 0.0) {
                let along = along_a + (along_b - along_a) * (-across_a / (across_b - across_a));
                if along > tol.linear_mm {
                    result.push(along);
                }
            }
        }
    }
    result.sort_by(f64::total_cmp);
    result.dedup_by(|a, b| (*a - *b).abs() <= tol.linear_mm);
    result
}

fn self_forbidden(
    motif: &Motif,
    request: &NormalizedRequest,
    cache: &mut NfpCache,
    control: &RunControl,
) -> Result<RegionMm, BaselineError> {
    let mut regions = Vec::new();
    for fixed in &motif.members {
        for moving in &motif.members {
            control.checkpoint_cancel_only()?;
            // Cache NFP dùng vòng local không mang phase; thay phase của motif chỉ
            // dịch vùng đã có, không phân rã/Minkowski lại cùng cặp contour.
            let region = cache.grown_nfp_with_clearance(
                &fixed.ring,
                &moving.ring,
                part_clearance_for_request(request),
                &request.tolerance,
            )?;
            let delta = PointMm::new(
                fixed.offset.x - moving.offset.x,
                fixed.offset.y - moving.offset.y,
            );
            regions.extend(region.iter().map(|ring| shifted(ring, delta)));
        }
    }
    Ok(kernel::union_many(&regions).map_err(NfpError::from)?)
}

fn row_contacts(
    search: &Search<'_>,
    motif: &Motif,
    forbidden: &RegionMm,
    pitch_x: f64,
) -> Result<Vec<PointMm>, BaselineError> {
    let tol = search.request.tolerance;
    let clearance = part_clearance_for_request(search.request);
    let height = motif.bounds.height_mm() + clearance.reach_y_mm();
    let width = motif.bounds.width_mm() + clearance.reach_x_mm();
    let window = vec![vec![
        PointMm::new(0.0, 0.0),
        PointMm::new(pitch_x, 0.0),
        PointMm::new(pitch_x, height),
        PointMm::new(0.0, height),
    ]];
    let radius = (width / pitch_x).ceil() as i64 + 1;
    let forbidden_bounds: Vec<Option<BoundsMm>> = forbidden
        .iter()
        .map(|ring| BoundsMm::from_ring(ring))
        .collect();
    let mut blocked = Vec::new();
    for column in -radius..=radius {
        search.control.checkpoint_cancel_only()?;
        if search.expired()? {
            return Ok(Vec::new());
        }
        let shift_x = column as f64 * pitch_x;
        // PERF (audit 2026-09-07 §SMART.5): vòng cấm chắc chắn nằm ngoài cửa sổ
        // không thể đóng góp vào intersection. Lọc bằng bbox trước khi clone/đổi
        // tọa độ; mọi vòng còn khả năng giao vẫn đi qua kernel exact như cũ.
        let moved: RegionMm = forbidden
            .iter()
            .zip(&forbidden_bounds)
            .filter_map(|(ring, bounds)| {
                let bounds = bounds.as_ref()?;
                if bounds.max_x + shift_x < -tol.linear_mm
                    || bounds.min_x + shift_x > pitch_x + tol.linear_mm
                    || bounds.max_y < -tol.linear_mm
                    || bounds.min_y > height + tol.linear_mm
                {
                    return None;
                }
                Some(shifted(ring, PointMm::new(shift_x, 0.0)))
            })
            .collect();
        if moved.is_empty() {
            continue;
        }
        let clipped = kernel::intersection(&moved, &window).map_err(NfpError::from)?;
        // Kernel từ chối input rỗng; đây là identity tập hợp, không phải lỗi
        // hình học được phép nuốt. Các lỗi từ ring/kernel thật vẫn truyền lên.
        if clipped.is_empty() {
            continue;
        }
        blocked = if blocked.is_empty() {
            clipped
        } else {
            kernel::union(&blocked, &clipped).map_err(NfpError::from)?
        };
    }
    let mut contacts: Vec<PointMm> = blocked
        .iter()
        .flatten()
        .copied()
        .filter(|point| point.y > tol.linear_mm)
        .collect();
    contacts.extend([
        PointMm::new(0.0, height),
        PointMm::new(pitch_x * 0.5, height),
    ]);
    // Khi số hàng đổi, nghiệm tốt có thể nằm giữa một cạnh NFP chứ không ở đỉnh.
    // Thêm giao điểm với đúng các sự kiện fit-row, không quét lưới phase tùy tiện.
    let usable = search.request.placement_bounds_for(search.part);
    let minimum_y = search.part.effective_area_mm2() * motif.members.len() as f64 / pitch_x;
    if minimum_y > tol.linear_mm {
        let max_rows =
            ((usable.height_mm() + motif.bounds.height_mm()) / minimum_y).ceil() as usize;
        for rows in 2..=max_rows.min(MAX_INSTANCES_TOTAL as usize) {
            if search.expired()? {
                break;
            }
            let y = (usable.height_mm() - motif.bounds.height_mm()) / (rows - 1) as f64;
            if y < minimum_y - tol.linear_mm || y > height + tol.linear_mm {
                continue;
            }
            for ring in &blocked {
                for index in 0..ring.len() {
                    let a = ring[index];
                    let b = ring[(index + 1) % ring.len()];
                    if (a.y < y && b.y > y) || (a.y > y && b.y < y) {
                        contacts.push(PointMm::new(
                            a.x + (b.x - a.x) * ((y - a.y) / (b.y - a.y)),
                            y,
                        ));
                    }
                }
            }
        }
    }
    contacts.sort_by(|a, b| a.y.total_cmp(&b.y).then(a.x.total_cmp(&b.x)));
    contacts
        .dedup_by(|a, b| (a.x - b.x).abs() <= tol.linear_mm && (a.y - b.y).abs() <= tol.linear_mm);
    Ok(contacts)
}

fn optimize_motif(
    search: &mut Search<'_>,
    motif: &Motif,
    cache: &mut NfpCache,
) -> Result<(), BaselineError> {
    let forbidden = self_forbidden(motif, search.request, cache, search.control)?;
    let mut pitches = axis_contacts(&forbidden, true, &search.request.tolerance);
    let clearance = part_clearance_for_request(search.request);
    pitches.push(motif.bounds.width_mm() + clearance.reach_x_mm());
    pitches.sort_by(f64::total_cmp);
    pitches.dedup_by(|a, b| (*a - *b).abs() <= search.request.tolerance.linear_mm);
    for pitch_x in pitches {
        if search.expired()? {
            break;
        }
        let contacts = row_contacts(search, motif, &forbidden, pitch_x)?;
        for row in contacts {
            if search.expired()? {
                break;
            }
            search.consider(motif, Basis { pitch_x, row })?;
        }
    }
    Ok(())
}

fn pair_motifs(
    search: &mut Search<'_>,
    primary: &Member,
    secondary: &Member,
    cache: &mut NfpCache,
) -> Result<Vec<Motif>, BaselineError> {
    let region = cache.grown_nfp_with_clearance(
        &primary.ring,
        &secondary.ring,
        part_clearance_for_request(search.request),
        &search.request.tolerance,
    )?;
    let mut contacts: Vec<PointMm> = region.iter().flatten().copied().collect();
    contacts.extend(
        axis_contacts(&region, true, &search.request.tolerance)
            .into_iter()
            .map(|x| PointMm::new(x, 0.0)),
    );
    contacts.extend(
        axis_contacts(&region, false, &search.request.tolerance)
            .into_iter()
            .map(|y| PointMm::new(0.0, y)),
    );
    let mut choices = Vec::new();
    for offset in contacts {
        search.control.checkpoint_cancel_only()?;
        if search.expired()? {
            break;
        }
        // Đại diện nửa mặt phẳng: đổi thứ tự hai member cho nửa còn lại.
        if offset.x < -search.request.tolerance.linear_mm
            || (offset.x.abs() <= search.request.tolerance.linear_mm && offset.y < 0.0)
        {
            continue;
        }
        let Some(other) = member(
            search.part,
            secondary.angle,
            offset,
            &search.request.tolerance,
        ) else {
            continue;
        };
        let Some(candidate) = motif(vec![primary.clone(), other]) else {
            continue;
        };
        if search.clash(
            &candidate.members[0],
            &candidate.members[1],
            PointMm::new(0.0, 0.0),
        ) {
            continue;
        }
        choices.push(candidate);
    }
    // Các cực trị hình học bổ sung nhau: cặp gọn diện tích, gọn ngang và gọn dọc.
    // Không suy motif từ việc bốn/sáu placement greedy tình cờ đã thẳng hàng.
    let mut selected: Vec<Motif> = Vec::new();
    for criterion in 0..3 {
        let best = choices.iter().min_by(|a, b| {
            let key = |value: &Motif| match criterion {
                0 => (
                    value.bounds.width_mm() * value.bounds.height_mm(),
                    value.bounds.width_mm(),
                ),
                1 => (value.bounds.width_mm(), value.bounds.height_mm()),
                _ => (value.bounds.height_mm(), value.bounds.width_mm()),
            };
            let left = key(a);
            let right = key(b);
            left.0.total_cmp(&right.0).then(left.1.total_cmp(&right.1))
        });
        if let Some(best) = best {
            let offset = best.members[1].offset;
            if !selected
                .iter()
                .any(|value| value.members[1].offset == offset)
            {
                selected.push(best.clone());
            }
        }
    }
    Ok(selected)
}

pub(super) fn run(
    request: &NormalizedRequest,
    control: &RunControl,
    policy: BaselineAnglePolicy,
) -> Result<BaselineOutcome, BaselineError> {
    let part = &request.parts[0];
    let mut search = Search {
        request,
        part,
        control,
        best: None,
        attempts: 0,
        orientations: 0,
        pair_memo: BTreeMap::new(),
    };
    let angles = baseline_angles_with_fallback(&part.rotation_domain, policy, &request.tolerance);
    let mut members: Vec<Member> = angles
        .into_iter()
        .filter_map(|angle| member(part, angle, PointMm::new(0.0, 0.0), &request.tolerance))
        .collect();
    let clearance = part_clearance_for_request(request);

    // Sàn an toàn cũng là periodic. Deadline không được trả greedy tự do cho S&R.
    // Mọi góc hợp lệ của baseline đều được quyền tạo sàn, không chỉ 0°/180°.
    for value in &members {
        search.orientations = search.orientations.saturating_add(1);
        let Some(single) = motif(vec![value.clone()]) else {
            continue;
        };
        search.consider(
            &single,
            Basis {
                pitch_x: value.bounds.width_mm() + clearance.reach_x_mm(),
                row: PointMm::new(0.0, value.bounds.height_mm() + clearance.reach_y_mm()),
            },
        )?;
    }

    // Không còn smart rescue tự do ở S&R: nếu first/cardinal không vừa, phải
    // tìm sàn ở những góc hữu hạn còn lại trước khi kết luận không có chỗ đặt.
    // Với miền liên tục dùng bootstrap hiện hữu; không thu hẹp policy canonical.
    if search.best.is_none() {
        let extra_angles = match &part.rotation_domain {
            RotationDomain::Discrete(values) => values.clone(),
            _ => autofill_bootstrap_angles(request, part, 0, policy),
        };
        for angle in extra_angles {
            control.checkpoint_cancel_only()?;
            if members.iter().any(|value| {
                circular_distance_deg(value.angle, angle) <= request.tolerance.angular_deg
            }) {
                continue;
            }
            let Some(value) = member(part, angle, PointMm::new(0.0, 0.0), &request.tolerance)
            else {
                continue;
            };
            let Some(single) = motif(vec![value.clone()]) else {
                continue;
            };
            search.orientations = search.orientations.saturating_add(1);
            search.consider(
                &single,
                Basis {
                    pitch_x: value.bounds.width_mm() + clearance.reach_x_mm(),
                    row: PointMm::new(0.0, value.bounds.height_mm() + clearance.reach_y_mm()),
                },
            )?;
            members.push(value);
        }
    }

    let mut cache = NfpCache::with_telemetry_and_resources(
        control.progress().clone(),
        NfpTelemetryPhase::Baseline,
        control.nfp_worker_grant(),
        control.nfp_cache_byte_budget(),
    );
    let mut paired_angles = Vec::new();
    for value in &members {
        if search.expired()? {
            break;
        }
        search.orientations = search.orientations.saturating_add(1);
        let Some(single) = motif(vec![value.clone()]) else {
            continue;
        };
        optimize_motif(&mut search, &single, &mut cache)?;
        let Some(half_angle) = canonicalize_angle_deg(value.angle + 180.0, &request.tolerance)
        else {
            continue;
        };
        if !part
            .rotation_domain
            .contains(half_angle, &request.tolerance)
            || paired_angles.iter().any(|angle| {
                circular_distance_deg(*angle, value.angle) <= request.tolerance.angular_deg
            })
        {
            continue;
        }
        let Some(half) = member(part, half_angle, PointMm::new(0.0, 0.0), &request.tolerance)
        else {
            continue;
        };
        paired_angles.extend([value.angle, half_angle]);
        for pair in pair_motifs(&mut search, value, &half, &mut cache)? {
            if search.expired()? {
                break;
            }
            optimize_motif(&mut search, &pair, &mut cache)?;
        }
    }
    let placements = search.best.map_or_else(Vec::new, |(_, values)| values);
    Ok(BaselineOutcome {
        sheet_count: u32::from(!placements.is_empty()),
        placements,
        unplaced: Vec::new(),
        attempts: search.attempts,
        orientation_evaluations: search.orientations,
        periodic_motif: true,
        baseline_version: BASELINE_VERSION,
    })
}
