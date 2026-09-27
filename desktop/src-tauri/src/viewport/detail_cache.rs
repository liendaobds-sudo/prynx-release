//! PERF (audit 2026-09-26 §R35): cache resident detail theo mức sử dụng.
//!
//! Một frame đã nét là tài sản có thể tái sử dụng. FIFO làm mất vùng người
//! dùng vừa quay lại chỉ vì đã đi qua vài vùng kế bên; LRU giữ lại vùng được
//! nhìn thấy gần đây và chỉ loại frame ít được dùng nhất khi thật sự đầy.

use print_engine::geom::Matrix;
use viewer_gpu::resident_present::{raster_grid_matches, raster_sample_density, ResidentFrame};

#[derive(Clone, Copy, Debug, PartialEq)]
struct Region {
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
}
impl Region {
    fn valid(self) -> bool {
        self.x1 > self.x0 && self.y1 > self.y0
    }
}
/// PERF (audit 2026-09-27 §V27.R1): giữ nguyên lưới raster gốc và crop nguyên.
/// Matrix texture đã trừ crop chỉ dùng lấy mẫu; không nghịch đảo nó để đo lại
/// vùng đã dựng, vì phép trừ/nhân f32 tạo khe giả tại zoom/pan có phần lẻ.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RasterCoverage {
    pub matrix: Matrix,
    pub rect: [u32; 4],
}
impl RasterCoverage {
    pub fn full(matrix: Matrix, width: u32, height: u32) -> Self {
        Self {
            matrix,
            rect: [0, 0, width, height],
        }
    }
    fn bounds(self) -> Region {
        let [x, y, w, h] = self.rect;
        Region {
            x0: x as f64,
            y0: y as f64,
            x1: x as f64 + w as f64,
            y1: y as f64 + h as f64,
        }
    }
    fn covers(self, other: Self) -> bool {
        if raster_sample_density(self.matrix, other.matrix) + 0.0001 < 1.0 {
            return false;
        }
        let Some(r) = region(self, other.matrix) else {
            return false;
        };
        let old = other.bounds();
        r.x0 <= old.x0 && r.y0 <= old.y0 && r.x1 >= old.x1 && r.y1 >= old.y1
    }
}
fn subtract(regions: &mut Vec<Region>, cover: Region) -> bool {
    let mut changed = false;
    let mut next = Vec::new();
    for r in regions.drain(..) {
        let c = Region {
            x0: r.x0.max(cover.x0),
            y0: r.y0.max(cover.y0),
            x1: r.x1.min(cover.x1),
            y1: r.y1.min(cover.y1),
        };
        if !c.valid() {
            next.push(r);
            continue;
        }
        changed = true;
        next.extend(
            [
                Region { x1: c.x0, ..r },
                Region { x0: c.x1, ..r },
                Region {
                    x0: c.x0,
                    x1: c.x1,
                    y1: c.y0,
                    ..r
                },
                Region {
                    x0: c.x0,
                    x1: c.x1,
                    y0: c.y1,
                    ..r
                },
            ]
            .into_iter()
            .filter(|r| r.valid()),
        );
    }
    *regions = next;
    changed
}
fn region(coverage: RasterCoverage, target: Matrix) -> Option<Region> {
    let source = coverage.matrix;
    let r = coverage.bounds();
    if source == target {
        return r.valid().then_some(r);
    }
    let (a, b, c, d, e, f) = (
        source.a as f64,
        source.b as f64,
        source.c as f64,
        source.d as f64,
        source.e as f64,
        source.f as f64,
    );
    let det = a * d - b * c;
    if !det.is_finite() || det.abs() < 1e-12 {
        return None;
    }
    let (ta, tb, tc, td, te, tf) = (
        target.a as f64,
        target.b as f64,
        target.c as f64,
        target.d as f64,
        target.e as f64,
        target.f as f64,
    );
    // Cùng tuyến tính chỉ khác pan: tính delta trực tiếp, không roundtrip.
    let m = if (a, b, c, d) == (ta, tb, tc, td) {
        [1., 0., 0., 1., te - e, tf - f]
    } else {
        [
            (d * ta - b * tc) / det,
            (d * tb - b * td) / det,
            (-c * ta + a * tc) / det,
            (-c * tb + a * td) / det,
            ((c * f - d * e) * ta + (b * e - a * f) * tc) / det + te,
            ((c * f - d * e) * tb + (b * e - a * f) * td) / det + tf,
        ]
    };
    if !m.iter().all(|v| v.is_finite()) {
        return None;
    }
    // Camera đang dùng chỉ scale/pan/rotation 90°. Với shear bất kỳ thì miss
    // bảo thủ, không lấy bbox hình nghiêng để tự chứng minh coverage.
    if !((m[1] == 0. && m[2] == 0.) || (m[0] == 0. && m[3] == 0.)) {
        return None;
    }
    let ps = [(r.x0, r.y0), (r.x1, r.y0), (r.x0, r.y1), (r.x1, r.y1)]
        .map(|(x, y)| (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]));
    let r = Region {
        x0: ps.iter().map(|p| p.0).fold(f64::INFINITY, f64::min),
        y0: ps.iter().map(|p| p.1).fold(f64::INFINITY, f64::min),
        x1: ps.iter().map(|p| p.0).fold(f64::NEG_INFINITY, f64::max),
        y1: ps.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max),
    };
    r.valid().then_some(r)
}
fn frame_bytes(frame: &ResidentFrame) -> u64 {
    u64::from(frame.texture.width())
        * u64::from(frame.texture.height())
        * match frame.texture.format() {
            wgpu::TextureFormat::Rgba16Float => 8,
            _ => 4,
        }
}

/// Ngân sách byte theo bộ nhớ thật, không trần số frame cố định trên máy mạnh.
pub(crate) fn budget_for_memory(
    total: u64,
    available: u64,
    gpu: Option<(u64, u64)>,
    resident: u64,
) -> Option<u64> {
    let ram = if total > 0 && total < 8 * 1024 * 1024 * 1024 {
        Some(available / 8)
    } else if total > 0 && (total < 16 * 1024 * 1024 * 1024 || available < total / 10) {
        Some(available / 4)
    } else {
        None
    };
    let gpu = gpu.filter(|(budget, _)| *budget > 0).map(|(budget, used)| {
        budget
            .saturating_sub(used.saturating_sub(resident))
            .saturating_mul(3)
            / 4
    });
    match (ram, gpu) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    }
}

pub struct ResidentDetail {
    pub frame: ResidentFrame,
    coverage: RasterCoverage,
    last_used: u64,
}

pub struct DetailCache {
    entries: Vec<ResidentDetail>,
    clock: u64,
    budget_bytes: Option<u64>,
}
pub struct MissingDetail {
    pub area: f64,
    pub region: Option<[u32; 4]>,
}

impl DetailCache {
    pub fn new(budget_bytes: Option<u64>) -> Self {
        Self {
            entries: Vec::new(),
            clock: 0,
            budget_bytes,
        }
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.clock = 0;
    }

    /// PERF (audit 2026-09-27 §V27.D1): hợp vùng phủ đủ mật độ; chỉ touch
    /// frame thực sự bổ sung pixel, không touch mọi lớp bị che ở phía dưới.
    pub fn touch(&mut self, matrix: Matrix, width: u32, height: u32) -> bool {
        self.clock = self.clock.wrapping_add(1).max(1);
        let mut missing = vec![Region {
            x0: 0.,
            y0: 0.,
            x1: width as f64,
            y1: height as f64,
        }];
        let mut display_missing = missing.clone();
        let mut order: Vec<_> = (0..self.entries.len()).collect();
        order.sort_by(|&a, &b| {
            raster_grid_matches(self.entries[b].frame.matrix,matrix)
                .cmp(&raster_grid_matches(self.entries[a].frame.matrix,matrix))
                .then_with(||raster_sample_density(self.entries[b].frame.matrix, matrix)
                .total_cmp(&raster_sample_density(self.entries[a].frame.matrix, matrix))
                .then(b.cmp(&a)))
        });
        for i in order {
            let entry = &mut self.entries[i];
            let frame = &entry.frame;
            let density = raster_sample_density(frame.matrix, matrix);
            let Some(r) = region(entry.coverage, matrix) else {
                continue;
            };
            let visible = density >= viewer_gpu::resident_present::MIN_DETAIL_DISPLAY_DENSITY
                && subtract(&mut display_missing, r);
            // PERF/COLOR (audit 2026-09-27 §V27.R8): ảnh resample dùng tạm
            // được để giữ tương tác, nhưng không được ACK đã nét. Chỉ lưới
            // pixel thực của texture khớp camera mới kết thúc refinement.
            let sharp = raster_grid_matches(frame.matrix,matrix) && subtract(&mut missing, r);
            if visible || sharp {
                entry.last_used = self.clock;
            }
        }
        missing.is_empty()
    }

    /// Thêm frame mới và loại frame ít dùng nhất. Trả về số frame đã loại.
    #[allow(dead_code)]
    pub fn insert(&mut self, frame: ResidentFrame) -> usize {
        let coverage =
            RasterCoverage::full(frame.matrix, frame.texture.width(), frame.texture.height());
        self.insert_with_coverage(frame, coverage)
    }
    pub fn insert_with_coverage(
        &mut self,
        frame: ResidentFrame,
        coverage: RasterCoverage,
    ) -> usize {
        debug_assert_eq!(
            [frame.texture.width(), frame.texture.height()],
            [coverage.rect[2], coverage.rect[3]]
        );
        self.clock = self.clock.wrapping_add(1).max(1);
        // PERF (audit 2026-09-27 §V27.R2): cùng matrix không có nghĩa cùng
        // extent. Chỉ thay thế khi vùng mới thực sự phủ hết vùng cũ đủ nét.
        self.entries
            .retain(|entry| !coverage.covers(entry.coverage));
        self.entries.push(ResidentDetail {
            frame,
            coverage,
            last_used: self.clock,
        });
        let mut evicted = 0;
        while self.entries.len() > 1
            && self
                .budget_bytes
                .is_some_and(|budget| self.bytes() > budget)
        {
            let Some(index) = least_recently_used_index(
                &self
                    .entries
                    .iter()
                    .map(|entry| entry.last_used)
                    .collect::<Vec<_>>(),
            ) else {
                break;
            };
            self.entries.remove(index);
            evicted += 1;
        }
        evicted
    }

    pub fn frames(&self) -> Vec<&ResidentFrame> {
        self.entries.iter().map(|entry| &entry.frame).collect()
    }
    /// Vùng thiếu lớn nhất, có gutter bilinear. Matrix của renderer không đổi;
    /// refiner crop kết quả trên GPU sau khi đã tính ở hệ tọa độ camera gốc.
    #[allow(dead_code)]
    pub fn missing_region(&self, matrix: Matrix, width: u32, height: u32) -> Option<[u32; 4]> {
        self.missing_detail(matrix, width, height)
            .and_then(|missing| missing.region)
    }
    pub fn missing_detail(&self, matrix: Matrix, width: u32, height: u32) -> Option<MissingDetail> {
        let mut missing = vec![Region {
            x0: 0.,
            y0: 0.,
            x1: width as f64,
            y1: height as f64,
        }];
        for entry in &self.entries {
            let f = &entry.frame;
            if !raster_grid_matches(f.matrix, matrix) {
                continue;
            }
            if let Some(r) = region(entry.coverage, matrix) {
                subtract(&mut missing, r);
            }
        }
        let area: f64 = missing.iter().map(|r| (r.x1 - r.x0) * (r.y1 - r.y0)).sum();
        if area <= 1.0 {
            return None;
        }
        // PERF (audit 2026-09-27 §V27.R4 / fix loop 2026-09-27): Nếu vùng thiếu bị phân
        // mảnh (> 1 mảnh) hoặc là dải mép quá hẹp (< 48px) do trôi/pan nhỏ: dựng trọn vẹn
        // toàn bộ viewport (region: None) để gom thành 1 frame đầy đủ duy nhất. Tránh lặp vô hạn
        // hàng chục lần ROI micro-strip (3px, 11px, 23px) làm nghẽn refiner GPU.
        if missing.len() > 1 {
            return Some(MissingDetail {
                area,
                region: None,
            });
        }
        let r = missing.into_iter().max_by(|a, b| {
            ((a.x1 - a.x0) * (a.y1 - a.y0)).total_cmp(&((b.x1 - b.x0) * (b.y1 - b.y0)))
        })?;
        let x = (r.x0.floor() - 2.).max(0.) as u32;
        let y = (r.y0.floor() - 2.).max(0.) as u32;
        let right = (r.x1.ceil() + 2.).min(width as f64) as u32;
        let bottom = (r.y1.ceil() + 2.).min(height as f64) as u32;
        let rw = right.saturating_sub(x);
        let rh = bottom.saturating_sub(y);
        let is_micro_strip = (rw < 48 && width >= 48) || (rh < 48 && height >= 48);
        let rect = [x, y, rw, rh];
        Some(MissingDetail {
            area,
            region: (rect != [0, 0, width, height] && !is_micro_strip).then_some(rect),
        })
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn bytes(&self) -> u64 {
        self.entries.iter().map(|e| frame_bytes(&e.frame)).sum()
    }
    pub fn set_budget(&mut self, budget: Option<u64>) {
        self.budget_bytes = budget;
    }
    pub fn budget(&self) -> Option<u64> {
        self.budget_bytes
    }
}

fn least_recently_used_index(values: &[u64]) -> Option<usize> {
    values
        .iter()
        .enumerate()
        .min_by_key(|(_, value)| *value)
        .map(|(index, _)| index)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn test_frame(
        ctx: &viewer_gpu::GpuContext,
        matrix: Matrix,
        width: u32,
        height: u32,
    ) -> ResidentFrame {
        ResidentFrame {
            texture: ctx.create_target_texture(
                width,
                height,
                wgpu::TextureFormat::Rgba8Unorm,
                None,
            ),
            matrix,
        }
    }
    #[test]
    fn regression_same_origin_crop_keeps_larger_sharp_frame() {
        let ctx = viewer_gpu::GpuContext::new_sync().unwrap();
        let mut cache = DetailCache::new(None);
        cache.insert(test_frame(&ctx, Matrix::IDENTITY, 100, 100));
        cache.insert(test_frame(&ctx, Matrix::IDENTITY, 3, 5));
        assert!(
            cache.touch(Matrix::IDENTITY, 100, 100),
            "Crop nhỏ không được xóa vùng nét lớn cùng gốc"
        );
    }
    #[test]
    fn regression_fractional_full_frame_has_no_phantom_gap() {
        let ctx = viewer_gpu::GpuContext::new_sync().unwrap();
        let mut cache = DetailCache::new(None);
        let s = 6.377287864685059_f32;
        let matrix = Matrix::new(s, 0., 0., -s, -2985.15, 561.26 * s - 1730.73);
        cache.insert(test_frame(&ctx, matrix, 1292, 733));
        assert!(
            cache.touch(matrix, 1292, 733),
            "Cùng raster phải phủ đúng cả viewport, không có khe do nghịch đảo f32"
        );
    }
    #[test]
    fn resampled_zoom_is_display_only_not_finished_sharpness(){
        let ctx=viewer_gpu::GpuContext::new_sync().unwrap();let mut cache=DetailCache::new(None);
        cache.insert(test_frame(&ctx,Matrix::IDENTITY,128,96));
        let camera=Matrix::new(1.05,0.,0.,1.05,-3.2,-2.4);
        assert!(!cache.touch(camera,128,96),"Coverage 95% bị upscale không chứng minh đã nét ở camera mới");
        assert!(cache.missing_detail(camera,128,96).is_some());
    }
    #[test]
    fn fractional_pan_requires_new_grid_but_integer_pan_can_reuse(){
        let ctx=viewer_gpu::GpuContext::new_sync().unwrap();let mut cache=DetailCache::new(None);
        cache.insert(test_frame(&ctx,Matrix::translate(5.,5.),138,106));
        assert!(!cache.touch(Matrix::translate(0.25,0.5),128,96),"Pan phần lẻ đang bilinear, chưa phải pixel mới");
        assert!(cache.touch(Matrix::translate(1.,-2.),128,96));
    }
    #[test]
    fn fractional_crop_converges_for_pan_zoom_rotation_and_dpr() {
        let ctx = viewer_gpu::GpuContext::new_sync().unwrap();
        for dpr in [1., 1.25, 1.5, 2.] {
            for rotation in 0..4 {
                for zoom in [1., 1.15, 0.8] {
                    let s = 6.377287864685059_f32 * dpr;
                    let source = match rotation {
                        0 => Matrix::new(s, 0., 0., -s, -2980.15, 561.26 * s - 1733.73),
                        1 => Matrix::new(0., s, s, 0., -1733.73, -2980.15),
                        2 => Matrix::new(-s, 0., 0., s, 561.26 * s - 1733.73, -2980.15),
                        _ => Matrix::new(0., -s, -s, 0., -2980.15, 561.26 * s - 1733.73),
                    };
                    let target = source.then(&Matrix::new(zoom, 0., 0., zoom, -5.35, 3.75));
                    let mut cache = DetailCache::new(None);
                    cache.insert(test_frame(&ctx, source, 1292, 733));
                    let mut steps = 0;
                    while !cache.touch(target, 1292, 733) && steps < 8 {
                        let rect = cache
                            .missing_region(target, 1292, 733)
                            .unwrap_or([0, 0, 1292, 733]);
                        let [x, y, w, h] = rect;
                        let raster = Matrix {
                            e: target.e - x as f32,
                            f: target.f - y as f32,
                            ..target
                        };
                        cache.insert_with_coverage(
                            test_frame(&ctx, raster, w, h),
                            RasterCoverage {
                                matrix: target,
                                rect,
                            },
                        );
                        steps += 1;
                    }
                    assert!(
                        cache.touch(target, 1292, 733),
                        "Không hội tụ: DPR={dpr}, rotate={rotation}, zoom={zoom}, steps={steps}"
                    );
                    assert_eq!(cache.missing_region(target, 1292, 733), None);
                }
            }
        }
    }
    #[test]
    fn crop_provenance_never_hides_a_real_fractional_gap() {
        let full = Region {
            x0: 0.,
            y0: 0.,
            x1: 100.,
            y1: 100.,
        };
        let mut missing = vec![full];
        subtract(&mut missing, Region { x1: 50., ..full });
        subtract(
            &mut missing,
            Region {
                x0: 50.0000001,
                ..full
            },
        );
        assert!(
            !missing.is_empty(),
            "Không được nới epsilon để coi pixel chưa có là đã có"
        );
    }
    #[test]
    fn union_fills_viewport_but_never_hides_a_gap() {
        let full = Region {
            x0: 0.,
            y0: 0.,
            x1: 100.,
            y1: 100.,
        };
        let mut missing = vec![full];
        assert!(subtract(&mut missing, Region { x1: 50., ..full }));
        assert!(!missing.is_empty());
        assert!(subtract(&mut missing, Region { x0: 51., ..full }));
        assert!(!missing.is_empty());
        subtract(
            &mut missing,
            Region {
                x0: 50.,
                x1: 51.,
                ..full
            },
        );
        assert!(missing.is_empty());
    }
    #[test]
    fn strong_memory_has_no_frame_cap_and_pressure_is_byte_based() {
        let gib = 1024 * 1024 * 1024;
        assert_eq!(budget_for_memory(32 * gib, 16 * gib, None, 0), None);
        assert_eq!(budget_for_memory(4 * gib, 2 * gib, None, 0), Some(gib / 4));
        assert_eq!(budget_for_memory(8 * gib, 4 * gib, None, 0), Some(gib));
        assert_eq!(budget_for_memory(12 * gib, 8 * gib, None, 0), Some(2 * gib));
        assert_eq!(budget_for_memory(16 * gib, 8 * gib, None, 0), None);
        assert_eq!(budget_for_memory(32 * gib, gib, None, 0), Some(gib / 4));
        assert_eq!(
            budget_for_memory(32 * gib, 16 * gib, Some((8 * gib, 3 * gib)), gib),
            Some(6 * gib * 3 / 4)
        );
    }
    #[test]
    fn raster_rect_preserves_pan_and_rejects_shear() {
        let source = Matrix {
            e: -50.,
            ..Matrix::IDENTITY
        };
        assert_eq!(
            region(RasterCoverage::full(source, 50, 100), Matrix::IDENTITY),
            Some(Region {
                x0: 50.,
                y0: 0.,
                x1: 100.,
                y1: 100.
            })
        );
        assert!(region(
            RasterCoverage::full(
                Matrix {
                    b: 0.1,
                    ..Matrix::IDENTITY
                },
                50,
                100
            ),
            Matrix::IDENTITY
        )
        .is_none());
    }
    #[test]
    fn gpu_cache_union_lru_and_no_twelve_frame_ceiling() {
        let ctx = viewer_gpu::GpuContext::new_sync().unwrap();
        let frame = |x: f32| ResidentFrame {
            texture: ctx.create_target_texture(5, 10, wgpu::TextureFormat::Rgba8Unorm, None),
            matrix: Matrix {
                e: -x,
                ..Matrix::IDENTITY
            },
        };
        let mut cache = DetailCache::new(Some(400));
        cache.insert(frame(0.));
        cache.insert(frame(5.));
        assert!(cache.touch(Matrix::IDENTITY, 10, 10));
        assert_eq!(cache.bytes(), 400);
        assert_eq!(cache.missing_region(Matrix::IDENTITY, 10, 10), None);
        assert!(cache.touch(Matrix::IDENTITY, 5, 10));
        cache.insert(frame(10.));
        assert_eq!(cache.len(), 2);
        assert!(cache.touch(Matrix::IDENTITY, 5, 10));
        assert!(!cache.touch(Matrix::IDENTITY, 10, 10));
        assert_eq!(
            cache.missing_region(Matrix::IDENTITY, 10, 10),
            Some([3, 0, 7, 10])
        );
        let mut full = DetailCache::new(None);
        for x in 0..20 {
            full.insert(frame(x as f32 * 5.));
        }
        assert_eq!(full.len(), 20);
        assert!(full.touch(Matrix::IDENTITY, 100, 10));
    }

    #[test]
    fn lru_selects_oldest_entry() {
        assert_eq!(least_recently_used_index(&[11, 4, 9]), Some(1));
    }

    #[test]
    fn lru_is_empty_safe() {
        assert_eq!(least_recently_used_index(&[]), None);
    }
}
