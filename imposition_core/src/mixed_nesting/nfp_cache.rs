//! Cache NFP theo **hình dạng**, không theo vị trí.
//!
//! PERF (audit 2026-08-28 §NFP-CACHE).
//!
//! ## Vấn đề đo được
//!
//! [`super::nfp::feasible_region`] gọi `no_fit_polygon(obstacle, moving)` **một lần cho
//! từng chi tiết đã đặt**, ở **mỗi** lần thử một góc. Nhưng NFP chỉ phụ thuộc hai **hình
//! dạng**, không phụ thuộc vị trí:
//!
//! ```text
//! NFP(A + t, B) = NFP(A, B) + t
//! ```
//!
//! Nên con thứ 50 cùng hình cùng góc với con thứ 1 có NFP y hệt, chỉ dịch đi. Đo trên
//! contour thật của khách (127–733 đỉnh): **một** NFP tốn 0,5–1,7 giây. Với 20 chi tiết
//! đã đặt, một lượt `feasible_region` tốn tới hàng chục giây — và nó **không chia nhỏ
//! được**, nên `RunControl::checkpoint()` giữa các góc không cắt kịp. Đó là lý do đặt
//! ngân sách 2 giây mà chạy 12 giây, và bấm Hủy không dứt.
//!
//! ## Vì sao cache được, và vì sao nó không đổi kết quả
//!
//! Đo thật: mọi con đã đặt trên file khách đều có `rotationDeg = 0.0` — chỉ **một** góc.
//! Rotation domain là cardinal (server quyết), nên với `P` mẫu và `K` góc chỉ có tối đa
//! `P×K` hình khác nhau. Số NFP khác nhau vì vậy là hữu hạn và nhỏ.
//!
//! `no_fit_polygon` là **hàm thuần**. Cache một hàm thuần không đổi giá trị trả về, nên
//! layout và `layoutFingerprint` giữ nguyên.
//!
//! ## Chuẩn hoá và lượng tử hoá
//!
//! Khoá là cặp vòng đã **chuẩn hoá về gốc theo bbox-min**, lượng tử hoá về lưới
//! [`KEY_QUANTUM_MM`]. Hai chi tiết cùng hình khác vị trí cho cùng vòng chuẩn hoá, sai
//! khác chỉ là nhiễu làm tròn `f64` (~1e-13 mm ở thang mm) — nhỏ hơn lưới khoá bốn bậc.
//!
//! Lưới `1e-9 mm` cố tình **nhỏ hơn** `Tolerance::linear_mm` (`1e-6`) một nghìn lần: hai
//! vòng trùng khoá thì lệch dưới một nanomet-của-nanomet, tức dưới mọi ngưỡng mà engine
//! coi là phân biệt được.

use std::collections::HashMap;
use std::mem::size_of;
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Instant;

use super::control::{NfpTelemetryMetric, NfpTelemetryPhase, ProgressChannel};
use super::kernel::{offset, KernelError, OffsetStyle};
use super::model::PointMm;
use super::model::Tolerance;
use super::nfp::{no_fit_polygon, no_fit_polygon_sheet_axis, NfpClearance, NfpError, RegionMm};

/// Lưới lượng tử hoá khoá, mm. Nhỏ hơn `Tolerance::linear_mm` 1000×.
pub const KEY_QUANTUM_MM: f64 = 1e-9;

/// Trần số bản ghi. Với `P` mẫu và `K` góc, số khoá thật là `O((P·K)²)`; trần này đủ cho
/// 13 mẫu × 4 góc mà vẫn chặn được ca bệnh lý (theta liên tục) không ăn hết RAM.
pub const MAX_ENTRIES: usize = 8_192;

type QuantizedRing = Vec<(i64, i64)>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum NfpClearanceKey {
    LegacyIsotropic { radius_nm: i64 },
    SheetAxis { x_nm: i64, y_nm: i64 },
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct NfpKey {
    obstacle: QuantizedRing,
    moving: QuantizedRing,
    /// Mode và đủ hai trục phải nằm trong khoá; `(0, 10)` khác `(10, 0)`.
    clearance: NfpClearanceKey,
}

fn quantize_coord(value: f64) -> i64 {
    (value / KEY_QUANTUM_MM).round() as i64
}

fn clearance_key(clearance: NfpClearance) -> NfpClearanceKey {
    match clearance {
        NfpClearance::LegacyIsotropic { radius_mm } => NfpClearanceKey::LegacyIsotropic {
            radius_nm: quantize_coord(radius_mm.max(0.0)),
        },
        NfpClearance::SheetAxis(axis) => NfpClearanceKey::SheetAxis {
            x_nm: quantize_coord(axis.x_mm.max(0.0)),
            y_nm: quantize_coord(axis.y_mm.max(0.0)),
        },
    }
}

fn quantize_ring(ring: &[PointMm], anchor: PointMm) -> QuantizedRing {
    ring.iter()
        .map(|point| {
            (
                quantize_coord(point.x - anchor.x),
                quantize_coord(point.y - anchor.y),
            )
        })
        .collect()
}

/// Góc dưới-trái của bbox. Dùng làm gốc chuẩn hoá vì nó bất biến với thứ tự đỉnh.
fn bbox_min(ring: &[PointMm]) -> Option<PointMm> {
    let first = ring.first()?;
    let mut min_x = first.x;
    let mut min_y = first.y;
    for point in ring.iter().skip(1) {
        if point.x < min_x {
            min_x = point.x;
        }
        if point.y < min_y {
            min_y = point.y;
        }
    }
    Some(PointMm { x: min_x, y: min_y })
}

fn translate_region(region: &RegionMm, delta: PointMm) -> RegionMm {
    region
        .iter()
        .map(|ring| {
            ring.iter()
                .map(|point| PointMm {
                    x: point.x + delta.x,
                    y: point.y + delta.y,
                })
                .collect()
        })
        .collect()
}

/// Bộ nhớ đệm NFP đã nở gap, dùng lại theo hình dạng.
///
/// Sở hữu bởi **một trial**: trial là đơn vị độc lập của `multi_start`, nên cache theo
/// trial giữ nguyên tính tất định kể cả khi lớp gọi chạy các trial song song.
#[derive(Debug)]
pub struct NfpCache {
    entries: HashMap<NfpKey, RegionMm>,
    hits: u64,
    misses: u64,
    estimated_payload_bytes: u64,
    worker_grant: usize,
    cache_byte_budget: u64,
    telemetry: Option<(Arc<ProgressChannel>, NfpTelemetryPhase)>,
}

impl Default for NfpCache {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            hits: 0,
            misses: 0,
            estimated_payload_bytes: 0,
            // Caller cũ và unit test mặc định giữ nguyên đường tuần tự.
            worker_grant: 1,
            cache_byte_budget: u64::MAX,
            telemetry: None,
        }
    }
}

#[derive(Debug)]
struct PreparedNfp {
    key: NfpKey,
    obstacle_anchor: PointMm,
    canonical_obstacle: Vec<PointMm>,
}

#[derive(Debug)]
struct NfpBuildTask {
    key: NfpKey,
    canonical_obstacle: Vec<PointMm>,
}

#[derive(Debug)]
struct NfpBuildAttempt {
    result: Result<RegionMm, NfpError>,
    elapsed_us: u64,
}

#[derive(Debug)]
enum BatchOccurrence {
    Cached {
        key: NfpKey,
        obstacle_anchor: PointMm,
    },
    ColdFirst {
        task_index: usize,
        key: NfpKey,
        obstacle_anchor: PointMm,
    },
    ColdRepeat {
        key: NfpKey,
        obstacle_anchor: PointMm,
    },
}

impl NfpCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Tạo cache có counter runtime gắn với đúng phase solver.
    ///
    /// PERF (audit 2026-08-30 §NEST-D0-D): telemetry chỉ dùng atomic Relaxed và
    /// timing quanh phép NFP thật; không log, serialize hay khóa trong hot path.
    pub(crate) fn with_telemetry(progress: Arc<ProgressChannel>, phase: NfpTelemetryPhase) -> Self {
        Self {
            telemetry: Some((progress, phase)),
            ..Self::default()
        }
    }

    /// Gắn grant runtime đã admission vào cache của đúng một baseline/trial.
    pub(crate) fn with_telemetry_and_resources(
        progress: Arc<ProgressChannel>,
        phase: NfpTelemetryPhase,
        worker_grant: usize,
        cache_byte_budget: u64,
    ) -> Self {
        Self::with_telemetry(progress, phase).with_resources(worker_grant, cache_byte_budget)
    }

    pub(crate) fn with_resources(mut self, worker_grant: usize, cache_byte_budget: u64) -> Self {
        self.worker_grant = worker_grant.max(1);
        self.cache_byte_budget = cache_byte_budget;
        self
    }

    fn record(&self, metric: NfpTelemetryMetric) {
        if let Some((progress, phase)) = &self.telemetry {
            progress.record_nfp_metric(*phase, metric);
        }
    }

    pub fn hits(&self) -> u64 {
        self.hits
    }

    pub fn misses(&self) -> u64 {
        self.misses
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn estimated_payload_bytes(&self) -> u64 {
        self.estimated_payload_bytes
    }

    pub(crate) const fn allows_parallel_batch(&self) -> bool {
        self.worker_grant > 1
    }

    /// NFP legacy đã nở tròn theo `gap_mm`, lấy từ cache khi có.
    pub fn grown_nfp(
        &mut self,
        obstacle: &[PointMm],
        moving: &[PointMm],
        gap_mm: f64,
        tol: &Tolerance,
    ) -> Result<RegionMm, NfpError> {
        self.grown_nfp_with_clearance(
            obstacle,
            moving,
            NfpClearance::legacy_isotropic(gap_mm),
            tol,
        )
    }

    /// NFP giữ nguyên mode clearance tới phép dựng và cache key.
    ///
    /// Trả về vùng ở **toạ độ tờ** (đã dịch lại theo vị trí thật của `obstacle`).
    pub fn grown_nfp_with_clearance(
        &mut self,
        obstacle: &[PointMm],
        moving: &[PointMm],
        clearance: NfpClearance,
        tol: &Tolerance,
    ) -> Result<RegionMm, NfpError> {
        let Some(prepared) = prepare_nfp(obstacle, moving, clearance) else {
            return self.compute(obstacle, moving, clearance, tol);
        };
        if let Some(cached) = self.entries.get(&prepared.key) {
            self.hits += 1;
            self.record(NfpTelemetryMetric::CacheHit);
            return Ok(translate_region(cached, prepared.obstacle_anchor));
        }

        // Tính trên vòng đã chuẩn hoá để giá trị lưu được dùng lại cho mọi vị trí.
        let build_started = Instant::now();
        let canonical = self.compute(&prepared.canonical_obstacle, moving, clearance, tol)?;
        self.record(NfpTelemetryMetric::NfpBuildTimeUs(elapsed_us(
            build_started,
        )));
        self.misses += 1;
        self.record(NfpTelemetryMetric::CacheMiss);
        self.insert_canonical(prepared.key, &canonical);
        Ok(translate_region(&canonical, prepared.obstacle_anchor))
    }

    /// Dựng đúng tập cold miss phát sinh trong **một** `feasible_region`.
    ///
    /// PERF (audit 2026-08-30 §NEST-NFP-P1): chỉ khi có ít nhất hai khoá lạnh duy
    /// nhất, grant >1 và toàn batch vừa trần entry/byte thì mới mở các scoped worker.
    /// Kết quả luôn được replay theo thứ tự obstacle/first-use; cache và blocker không
    /// bao giờ nhận thứ tự hoàn tất của thread.
    pub(crate) fn grown_nfps_batch_with_clearance(
        &mut self,
        obstacles: &[&[PointMm]],
        moving: &[PointMm],
        clearance: NfpClearance,
        tol: &Tolerance,
        should_stop: Option<&dyn Fn() -> bool>,
    ) -> Result<Option<Vec<RegionMm>>, NfpError> {
        if obstacles.is_empty() {
            return Ok(Some(Vec::new()));
        }

        let mut cold_by_key: HashMap<NfpKey, usize> = HashMap::new();
        let mut tasks: Vec<NfpBuildTask> = Vec::new();
        let mut occurrences: Vec<BatchOccurrence> = Vec::with_capacity(obstacles.len());
        for obstacle in obstacles {
            let Some(prepared) = prepare_nfp(obstacle, moving, clearance) else {
                return self.grown_nfps_sequential_with_clearance(
                    obstacles,
                    moving,
                    clearance,
                    tol,
                    should_stop,
                );
            };
            if self.entries.contains_key(&prepared.key) {
                occurrences.push(BatchOccurrence::Cached {
                    key: prepared.key,
                    obstacle_anchor: prepared.obstacle_anchor,
                });
            } else if cold_by_key.contains_key(&prepared.key) {
                occurrences.push(BatchOccurrence::ColdRepeat {
                    key: prepared.key,
                    obstacle_anchor: prepared.obstacle_anchor,
                });
            } else {
                let task_index = tasks.len();
                cold_by_key.insert(prepared.key.clone(), task_index);
                occurrences.push(BatchOccurrence::ColdFirst {
                    task_index,
                    key: prepared.key.clone(),
                    obstacle_anchor: prepared.obstacle_anchor,
                });
                tasks.push(NfpBuildTask {
                    key: prepared.key,
                    canonical_obstacle: prepared.canonical_obstacle,
                });
            }
        }

        let worker_count = self.worker_grant.min(tasks.len());
        let remaining_bytes = self
            .cache_byte_budget
            .saturating_sub(self.estimated_payload_bytes);
        let minimum_batch_bytes = tasks.iter().fold(0_u64, |total, task| {
            total.saturating_add(estimate_key_payload_bytes(&task.key))
        });
        let batch_fits_entries = self.entries.len().saturating_add(tasks.len()) <= MAX_ENTRIES;
        if tasks.len() <= 1
            || worker_count <= 1
            || !batch_fits_entries
            || minimum_batch_bytes > remaining_bytes
        {
            return self.grown_nfps_sequential_with_clearance(
                obstacles,
                moving,
                clearance,
                tol,
                should_stop,
            );
        }

        // Publication barrier 1: hủy/deadline trước dispatch không được tạo cache nửa batch.
        if should_stop.is_some_and(|stop| stop()) {
            return Ok(None);
        }
        let batch_started = Instant::now();
        let mut attempts = Vec::with_capacity(tasks.len());
        let mut peak_workers = 0_usize;
        let mut staging_estimated_bytes = 0_u64;
        for wave in tasks.chunks(worker_count) {
            // Mỗi worker chỉ nhận đúng một NFP trong wave. Hủy giữa hai wave vì thế
            // không thể làm worker lấy thêm hàng dài task sau khi request đã supersede.
            if should_stop.is_some_and(|stop| stop()) {
                if !attempts.is_empty() {
                    self.record(NfpTelemetryMetric::PrewarmBatch {
                        tasks: u64::try_from(attempts.len()).unwrap_or(u64::MAX),
                        workers: u64::try_from(peak_workers).unwrap_or(u64::MAX),
                        wall_time_us: elapsed_us(batch_started),
                    });
                }
                return Ok(None);
            }
            peak_workers = peak_workers.max(wave.len());
            let wave_attempts = build_parallel(wave, moving, clearance, *tol);
            staging_estimated_bytes = wave.iter().zip(&wave_attempts).fold(
                staging_estimated_bytes,
                |total, (task, attempt)| {
                    attempt.result.as_ref().map_or(total, |region| {
                        total.saturating_add(estimate_entry_payload_bytes(&task.key, region))
                    })
                },
            );
            attempts.extend(wave_attempts);
            if staging_estimated_bytes > remaining_bytes {
                // Chốt ngay sau từng wave: không dispatch wave kế khi staging local đã
                // vượt grant. Ghi đúng số task thực chạy, giải phóng toàn bộ region
                // transient rồi mới replay đường tuần tự có byte-budget enforcement.
                self.record(NfpTelemetryMetric::PrewarmBatch {
                    tasks: u64::try_from(attempts.len()).unwrap_or(u64::MAX),
                    workers: u64::try_from(peak_workers).unwrap_or(u64::MAX),
                    wall_time_us: elapsed_us(batch_started),
                });
                drop(attempts);
                return self.grown_nfps_sequential_with_clearance(
                    obstacles,
                    moving,
                    clearance,
                    tol,
                    should_stop,
                );
            }
        }
        let batch_wall_time_us = elapsed_us(batch_started);
        self.record(NfpTelemetryMetric::PrewarmBatch {
            tasks: u64::try_from(tasks.len()).unwrap_or(u64::MAX),
            workers: u64::try_from(peak_workers).unwrap_or(u64::MAX),
            wall_time_us: batch_wall_time_us,
        });
        // Publication barrier 2: kết quả worker chỉ là local; hủy thắng trước mọi insert.
        if should_stop.is_some_and(|stop| stop()) {
            return Ok(None);
        }

        let mut attempts: Vec<Option<NfpBuildAttempt>> = attempts.into_iter().map(Some).collect();
        let mut regions = Vec::with_capacity(occurrences.len());
        for occurrence in occurrences {
            if should_stop.is_some_and(|stop| stop()) {
                return Ok(None);
            }
            match occurrence {
                BatchOccurrence::Cached {
                    key,
                    obstacle_anchor,
                }
                | BatchOccurrence::ColdRepeat {
                    key,
                    obstacle_anchor,
                } => {
                    let translated = {
                        let canonical = self
                            .entries
                            .get(&key)
                            .expect("batch replay phải thấy cache theo first-use");
                        translate_region(canonical, obstacle_anchor)
                    };
                    self.hits = self.hits.saturating_add(1);
                    self.record(NfpTelemetryMetric::CacheHit);
                    regions.push(translated);
                }
                BatchOccurrence::ColdFirst {
                    task_index,
                    key,
                    obstacle_anchor,
                } => {
                    let attempt = attempts[task_index]
                        .take()
                        .expect("mỗi cold task chỉ có một first-use");
                    let canonical = attempt.result?;
                    self.record(NfpTelemetryMetric::NfpBuildTimeUs(attempt.elapsed_us));
                    self.misses = self.misses.saturating_add(1);
                    self.record(NfpTelemetryMetric::CacheMiss);
                    self.insert_canonical(key, &canonical);
                    regions.push(translate_region(&canonical, obstacle_anchor));
                }
            }
        }
        Ok(Some(regions))
    }

    pub(crate) fn record_feasible_region_call(&self) {
        self.record(NfpTelemetryMetric::FeasibleRegionCall);
    }

    pub(crate) fn record_interrupted_call(&self) {
        self.record(NfpTelemetryMetric::InterruptedCall);
    }

    pub(crate) fn record_blockers_considered(&self, count: u64) {
        self.record(NfpTelemetryMetric::BlockersConsidered(count));
    }

    pub(crate) fn record_bbox_rejects(&self, count: u64) {
        if count > 0 {
            self.record(NfpTelemetryMetric::BboxRejects(count));
        }
    }

    pub(crate) fn record_blocker_rings_generated(&self, count: u64) {
        self.record(NfpTelemetryMetric::BlockerRingsGenerated(count));
    }

    pub(crate) fn record_difference_call(&self) {
        self.record(NfpTelemetryMetric::DifferenceCall);
    }

    pub(crate) fn record_difference_time(&self, started: Instant) {
        self.record(NfpTelemetryMetric::DifferenceTimeUs(elapsed_us(started)));
    }

    fn compute(
        &self,
        obstacle: &[PointMm],
        moving: &[PointMm],
        clearance: NfpClearance,
        tol: &Tolerance,
    ) -> Result<RegionMm, NfpError> {
        compute_canonical(obstacle, moving, clearance, tol)
    }

    fn grown_nfps_sequential_with_clearance(
        &mut self,
        obstacles: &[&[PointMm]],
        moving: &[PointMm],
        clearance: NfpClearance,
        tol: &Tolerance,
        should_stop: Option<&dyn Fn() -> bool>,
    ) -> Result<Option<Vec<RegionMm>>, NfpError> {
        let mut regions = Vec::with_capacity(obstacles.len());
        for obstacle in obstacles {
            if should_stop.is_some_and(|stop| stop()) {
                return Ok(None);
            }
            regions.push(self.grown_nfp_with_clearance(obstacle, moving, clearance, tol)?);
        }
        Ok(Some(regions))
    }

    fn insert_canonical(&mut self, key: NfpKey, canonical: &RegionMm) {
        let entry_bytes = estimate_entry_payload_bytes(&key, canonical);
        let next_bytes = self.estimated_payload_bytes.saturating_add(entry_bytes);
        if self.entries.len() < MAX_ENTRIES && next_bytes <= self.cache_byte_budget {
            self.estimated_payload_bytes = next_bytes;
            self.record(NfpTelemetryMetric::CacheEntryBuilt {
                estimated_bytes: entry_bytes,
                cache_total_estimated_bytes: self.estimated_payload_bytes,
            });
            self.entries.insert(key, canonical.clone());
        } else {
            self.record(NfpTelemetryMetric::CacheInsertSkipped);
        }
    }
}

fn prepare_nfp(
    obstacle: &[PointMm],
    moving: &[PointMm],
    clearance: NfpClearance,
) -> Option<PreparedNfp> {
    let obstacle_anchor = bbox_min(obstacle)?;
    bbox_min(moving)?;
    // NFP phụ thuộc cả outline moving lẫn vị trí outline đó so với pivot/gốc local.
    // Vì vậy moving vào key phải giữ nguyên toạ độ local; chuẩn hoá nó theo bbox-min
    // sẽ alias hai part cùng outline nhưng khác reference point và trả sai vị trí NFP.
    let key = NfpKey {
        obstacle: quantize_ring(obstacle, obstacle_anchor),
        moving: quantize_ring(moving, PointMm::new(0.0, 0.0)),
        clearance: clearance_key(clearance),
    };
    let canonical_obstacle = obstacle
        .iter()
        .map(|point| PointMm {
            x: point.x - obstacle_anchor.x,
            y: point.y - obstacle_anchor.y,
        })
        .collect();
    Some(PreparedNfp {
        key,
        obstacle_anchor,
        canonical_obstacle,
    })
}

fn build_parallel(
    tasks: &[NfpBuildTask],
    moving: &[PointMm],
    clearance: NfpClearance,
    tol: Tolerance,
) -> Vec<NfpBuildAttempt> {
    let (sender, receiver) = mpsc::channel();
    thread::scope(|scope| {
        for (task_index, task) in tasks.iter().enumerate() {
            let sender = sender.clone();
            scope.spawn(move || {
                let started = Instant::now();
                let result = compute_canonical(&task.canonical_obstacle, moving, clearance, &tol);
                let attempt = NfpBuildAttempt {
                    result,
                    elapsed_us: elapsed_us(started),
                };
                let _ = sender.send((task_index, attempt));
            });
        }
        drop(sender);
        let mut ordered: Vec<Option<NfpBuildAttempt>> = (0..tasks.len()).map(|_| None).collect();
        for _ in 0..tasks.len() {
            let (task_index, attempt) = receiver
                .recv()
                .expect("scoped NFP worker phải trả đủ kết quả");
            ordered[task_index] = Some(attempt);
        }
        ordered
            .into_iter()
            .map(|attempt| attempt.expect("task index NFP không được bỏ trống"))
            .collect()
    })
}

fn compute_canonical(
    obstacle: &[PointMm],
    moving: &[PointMm],
    clearance: NfpClearance,
    tol: &Tolerance,
) -> Result<RegionMm, NfpError> {
    match clearance {
        NfpClearance::LegacyIsotropic { radius_mm } => {
            let nfp = no_fit_polygon(obstacle, moving, tol)?;
            if radius_mm > 0.0 {
                offset(&nfp, radius_mm, OffsetStyle::v1_round()).map_err(NfpError::from_kernel)
            } else {
                Ok(nfp)
            }
        }
        NfpClearance::SheetAxis(axis) => no_fit_polygon_sheet_axis(obstacle, moving, axis, tol),
    }
}

fn elapsed_us(started: Instant) -> u64 {
    started.elapsed().as_micros().min(u128::from(u64::MAX)) as u64
}

/// Ước lượng payload heap thực sự giữ trong cache. Không tính bucket/allocator overhead,
/// nên field công bố mang tên `estimated`; dùng để so phase/tier chứ không thay RSS.
fn estimate_entry_payload_bytes(key: &NfpKey, region: &RegionMm) -> u64 {
    let region_bytes = size_of::<RegionMm>()
        .saturating_add(region.len().saturating_mul(size_of::<Vec<PointMm>>()))
        .saturating_add(
            region
                .iter()
                .map(|ring| ring.len().saturating_mul(size_of::<PointMm>()))
                .sum::<usize>(),
        );
    estimate_key_payload_bytes(key).saturating_add(u64::try_from(region_bytes).unwrap_or(u64::MAX))
}

fn estimate_key_payload_bytes(key: &NfpKey) -> u64 {
    let bytes = size_of::<NfpKey>()
        .saturating_add(key.obstacle.len().saturating_mul(size_of::<(i64, i64)>()))
        .saturating_add(key.moving.len().saturating_mul(size_of::<(i64, i64)>()));
    u64::try_from(bytes).unwrap_or(u64::MAX)
}

/// Chỉ dùng cho test P1b để chọn budget nằm giữa preflight-key và payload wave đầu.
#[cfg(test)]
pub(crate) fn parallel_budget_probe(
    obstacles: &[&[PointMm]],
    moving: &[PointMm],
    gap_mm: f64,
    tol: &Tolerance,
    first_wave_tasks: usize,
) -> Result<(u64, u64), NfpError> {
    let clearance = NfpClearance::legacy_isotropic(gap_mm);
    let mut unique = HashMap::<NfpKey, ()>::new();
    let mut ordered = Vec::new();
    for obstacle in obstacles {
        let Some(prepared) = prepare_nfp(obstacle, moving, clearance) else {
            continue;
        };
        if unique.contains_key(&prepared.key) {
            continue;
        }
        unique.insert(prepared.key.clone(), ());
        ordered.push(NfpBuildTask {
            key: prepared.key,
            canonical_obstacle: prepared.canonical_obstacle,
        });
    }
    let preflight_key_bytes = ordered.iter().fold(0_u64, |total, task| {
        total.saturating_add(estimate_key_payload_bytes(&task.key))
    });
    let first_wave_payload_bytes =
        ordered
            .iter()
            .take(first_wave_tasks)
            .try_fold(0_u64, |total, task| {
                compute_canonical(&task.canonical_obstacle, moving, clearance, tol).map(|region| {
                    total.saturating_add(estimate_entry_payload_bytes(&task.key, &region))
                })
            })?;
    Ok((preflight_key_bytes, first_wave_payload_bytes))
}

impl NfpError {
    fn from_kernel(error: KernelError) -> Self {
        NfpError::Kernel(error)
    }
}
