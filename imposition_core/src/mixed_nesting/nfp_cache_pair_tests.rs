//! Hợp đồng batch nhiều contour moving: hình học, thứ tự, hủy và ngân sách.

use super::*;
use std::cell::Cell;

fn rectangle(x: f64, y: f64, width: f64, height: f64) -> Vec<PointMm> {
    vec![
        PointMm::new(x, y),
        PointMm::new(x + width, y),
        PointMm::new(x + width, y + height),
        PointMm::new(x, y + height),
    ]
}

fn cache_with_progress(workers: usize, budget: u64) -> (NfpCache, Arc<ProgressChannel>) {
    let progress = Arc::new(ProgressChannel::new());
    let cache = NfpCache::with_telemetry_and_resources(
        progress.clone(),
        NfpTelemetryPhase::Baseline,
        workers,
        budget,
    );
    (cache, progress)
}

fn sequential(
    cache: &mut NfpCache,
    pairs: &[(&[PointMm], &[PointMm])],
    clearance: NfpClearance,
) -> Vec<RegionMm> {
    pairs
        .iter()
        .map(|(fixed, moving)| {
            cache
                .grown_nfp_with_clearance(fixed, moving, clearance, &Tolerance::v1())
                .expect("cặp contour hợp lệ")
        })
        .collect()
}

#[test]
fn mixed_moving_giu_exact_region_dich_chuyen_pivot_va_cache_hit() {
    let fixed = rectangle(10.0, 20.0, 12.0, 8.0);
    let translated = rectangle(40.0, 50.0, 12.0, 8.0);
    let other = rectangle(70.0, 10.0, 18.0, 9.0);
    let moving = rectangle(0.0, 0.0, 4.0, 3.0);
    let other_pivot = rectangle(2.0, -3.0, 4.0, 3.0);
    let triangle = vec![
        PointMm::new(0.0, 0.0),
        PointMm::new(8.0, 0.0),
        PointMm::new(3.0, 6.0),
    ];
    let pairs: Vec<(&[PointMm], &[PointMm])> = vec![
        (&fixed, &moving),
        (&other, &triangle),
        (&translated, &moving),
        (&fixed, &other_pivot),
        (&other, &triangle),
    ];
    let clearance = NfpClearance::legacy_isotropic(0.0);
    let expected = sequential(&mut NfpCache::new(), &pairs, clearance);
    assert_eq!(
        expected[2],
        translate_region(&expected[0], PointMm::new(30.0, 30.0))
    );
    assert_eq!(
        expected[3],
        translate_region(&expected[0], PointMm::new(-2.0, 3.0))
    );

    for workers in [1, 2, 4] {
        let (mut cache, progress) = cache_with_progress(workers, u64::MAX);
        let actual = cache
            .grown_nfps_pairs_batch_with_clearance(&pairs, clearance, &Tolerance::v1(), None)
            .expect("batch hợp lệ")
            .expect("không hủy");
        assert_eq!(actual, expected);
        let cold = progress.snapshot().nfp_diagnostics.baseline;
        assert_eq!((cache.misses(), cache.hits(), cache.len()), (3, 2, 3));
        assert_eq!(cold.prewarm_batches, u64::from(workers > 1));
        if workers > 1 {
            assert_eq!(cold.prewarm_tasks, 3);
            assert_eq!(cold.prewarm_peak_workers, workers.min(3) as u64);
        }
        let warm = cache
            .grown_nfps_pairs_batch_with_clearance(&pairs, clearance, &Tolerance::v1(), None)
            .expect("batch warm hợp lệ")
            .expect("không hủy");
        assert_eq!(warm, expected);
        assert_eq!((cache.misses(), cache.hits(), cache.len()), (3, 7, 3));
        assert_eq!(
            progress.snapshot().nfp_diagnostics.baseline.prewarm_batches,
            cold.prewarm_batches
        );
    }
}

#[test]
fn cancel_truoc_dispatch_giua_wave_va_truoc_publish_khong_ghi_cache() {
    let fixed = rectangle(0.0, 0.0, 12.0, 8.0);
    let moving: Vec<_> = (1..=3)
        .map(|size| rectangle(0.0, 0.0, size as f64, 3.0))
        .collect();
    let pairs: Vec<(&[PointMm], &[PointMm])> = moving
        .iter()
        .map(|ring| (fixed.as_slice(), ring.as_slice()))
        .collect();
    // Checkpoint: trước batch, trước wave 1, trước wave 2, trước publication.
    for (stop_at, expected_tasks) in [(1, 0), (3, 2), (4, 3)] {
        let (mut cache, progress) = cache_with_progress(2, u64::MAX);
        let checks = Cell::new(0);
        let stop = || {
            checks.set(checks.get() + 1);
            checks.get() >= stop_at
        };
        let result = cache
            .grown_nfps_pairs_batch_with_clearance(
                &pairs,
                NfpClearance::legacy_isotropic(0.0),
                &Tolerance::v1(),
                Some(&stop),
            )
            .expect("hủy không phải lỗi hình học");
        assert!(result.is_none());
        assert_eq!((cache.len(), cache.hits(), cache.misses()), (0, 0, 0));
        let diagnostics = progress.snapshot().nfp_diagnostics.baseline;
        assert_eq!(diagnostics.prewarm_tasks, expected_tasks);
        assert_eq!(diagnostics.cache_entries_built, 0);
    }
}

#[test]
fn mot_worker_va_warm_batch_giu_checkpoint_theo_tung_cap() {
    let fixed = rectangle(0.0, 0.0, 12.0, 8.0);
    let first = rectangle(0.0, 0.0, 2.0, 3.0);
    let second = rectangle(0.0, 0.0, 4.0, 3.0);
    let pairs: Vec<(&[PointMm], &[PointMm])> = vec![(&fixed, &first), (&fixed, &second)];
    let clearance = NfpClearance::legacy_isotropic(0.0);
    for warm in [false, true] {
        let (mut cache, progress) = cache_with_progress(if warm { 2 } else { 1 }, u64::MAX);
        if warm {
            sequential(&mut cache, &pairs, clearance);
        }
        let checks = Cell::new(0);
        let stop = || {
            checks.set(checks.get() + 1);
            checks.get() >= 2
        };
        assert!(
            cache
                .grown_nfps_pairs_batch_with_clearance(
                    &pairs,
                    clearance,
                    &Tolerance::v1(),
                    Some(&stop),
                )
                .expect("hủy không phải lỗi hình học")
                .is_none()
        );
        assert_eq!(checks.get(), 2);
        assert_eq!(cache.hits(), u64::from(warm));
        assert_eq!(cache.misses(), if warm { 2 } else { 1 });
        assert_eq!(
            progress.snapshot().nfp_diagnostics.baseline.prewarm_batches,
            0
        );
    }
}

#[test]
fn byte_budget_nho_va_staging_vuot_budget_giu_ket_qua_tuan_tu() {
    let fixed = rectangle(0.0, 0.0, 12.0, 8.0);
    let moving: Vec<_> = (1..=3)
        .map(|size| rectangle(0.0, 0.0, size as f64, 3.0))
        .collect();
    let pairs: Vec<(&[PointMm], &[PointMm])> = moving
        .iter()
        .map(|ring| (fixed.as_slice(), ring.as_slice()))
        .collect();
    let clearance = NfpClearance::legacy_isotropic(2.0);
    let tol = Tolerance::v1();
    let keys: Vec<_> = pairs
        .iter()
        .map(|(fixed, moving)| prepare_nfp(fixed, moving, clearance).expect("contour không rỗng"))
        .collect();
    let key_budget: u64 = keys
        .iter()
        .map(|prepared| estimate_key_payload_bytes(&prepared.key))
        .sum();
    let first_wave_bytes: u64 = keys
        .iter()
        .zip(&moving)
        .take(2)
        .map(|(prepared, moving)| {
            let region = compute_canonical(&prepared.canonical_obstacle, moving, clearance, &tol)
                .expect("NFP hợp lệ");
            estimate_entry_payload_bytes(&prepared.key, &region)
        })
        .sum();
    assert!(
        first_wave_bytes > key_budget,
        "fixture phải vượt budget ngay wave đầu"
    );
    for budget in [1, key_budget] {
        let (mut reference, _) = cache_with_progress(1, budget);
        let expected = sequential(&mut reference, &pairs, clearance);
        let (mut cache, progress) = cache_with_progress(2, budget);
        let actual = cache
            .grown_nfps_pairs_batch_with_clearance(&pairs, clearance, &tol, None)
            .expect("batch hợp lệ")
            .expect("không hủy");
        assert_eq!(actual, expected);
        assert_eq!(
            (cache.hits(), cache.misses(), cache.len()),
            (reference.hits(), reference.misses(), reference.len())
        );
        assert_eq!(
            cache.estimated_payload_bytes(),
            reference.estimated_payload_bytes()
        );
        assert!(cache.estimated_payload_bytes() <= budget);
        let diagnostics = progress.snapshot().nfp_diagnostics.baseline;
        assert_eq!(diagnostics.prewarm_tasks, if budget == 1 { 0 } else { 2 });
    }
}

#[test]
fn loi_hinh_hoc_theo_thu_tu_input_chi_publish_prefix_thanh_cong() {
    let fixed = rectangle(0.0, 0.0, 12.0, 8.0);
    let good = rectangle(0.0, 0.0, 2.0, 3.0);
    let too_far = rectangle(9_000.0, 9_000.0, 4.0, 3.0);
    let degenerate = vec![PointMm::new(0.0, 0.0), PointMm::new(2.0, 0.0)];
    let clearance = NfpClearance::legacy_isotropic(0.0);
    let tol = Tolerance::v1();
    let range_error = NfpError::Kernel(KernelError::CoordinateOutOfRange);
    assert_eq!(
        compute_canonical(&fixed, &too_far, clearance, &tol),
        Err(range_error)
    );
    for (first_bad, second_bad, expected) in [
        (too_far.as_slice(), degenerate.as_slice(), range_error),
        (
            degenerate.as_slice(),
            too_far.as_slice(),
            NfpError::DecompositionFailed,
        ),
    ] {
        let pairs: Vec<(&[PointMm], &[PointMm])> =
            vec![(&fixed, &good), (&fixed, first_bad), (&fixed, second_bad)];
        for workers in [1, 3] {
            let (mut cache, progress) = cache_with_progress(workers, u64::MAX);
            assert_eq!(
                cache.grown_nfps_pairs_batch_with_clearance(&pairs, clearance, &tol, None),
                Err(expected)
            );
            assert_eq!((cache.len(), cache.misses(), cache.hits()), (1, 1, 0));
            assert_eq!(
                progress.snapshot().nfp_diagnostics.baseline.prewarm_tasks,
                if workers == 1 { 0 } else { 3 }
            );
        }
    }
}
