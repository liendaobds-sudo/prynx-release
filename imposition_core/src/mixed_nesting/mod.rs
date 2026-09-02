//! `mixed_nesting` — engine "Bình lồng ghép tự do" (mixed true-shape nesting).
//!
//! Xếp nhiều chi tiết có hình dạng KHÁC NHAU vào một hoặc nhiều tờ vật liệu theo
//! contour thật. Đây là module **độc lập hoàn toàn**: không import, không gọi và
//! không chia sẻ trạng thái với solver N-Up (`grid`), Sticker (`sticker`), theo hình
//! tem (`shape`), NFP cũ (`nfp`) hay orchestrator hiện tại.
//!
//! Kế hoạch gốc: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md`.
//!
//! ## Hợp đồng hình học (bất biến của cả engine)
//!
//! Placement là **pose cứng trong SE(2)**:
//!
//! ```text
//! p_sheet = R(theta) * (p_source_local - referencePoint) + (tx, ty)
//! ```
//!
//! - `theta` mặc định tự do trong miền **liên tục** `[0°, 360°)`.
//! - `tx`, `ty` là toạ độ **mm liên tục**, được tối ưu đồng thời với `theta`.
//! - Mirror, scale và shear **luôn bị cấm** trong bình mặt trước.
//! - Các lựa chọn "giữ hướng", "0/180", "0/90/180/270", tập/khoảng góc tùy chỉnh chỉ
//!   là *rotation constraint* tùy chọn ở cấp job hoặc từng chi tiết — không phải miền
//!   xoay mặc định của engine.
//! - `fast`/`balanced`/`tight` chỉ đổi **search effort**; chúng không thu hẹp miền góc
//!   hợp lệ và không tạo bước góc hay lưới toạ độ nào.
//!
//! Đơn vị: hình học mm, góc trong API degree (dương ngược chiều kim đồng hồ), gốc toạ
//! độ ở góc trái dưới vùng MediaBox logic của tờ.
//!
//! ## Trạng thái triển khai
//!
//! | Phase | Nội dung | Trạng thái |
//! |---|---|---|
//! | P1 | [`model`] hợp đồng dữ liệu, [`control`] seed/progress/cancel/effort | đã có |
//! | P2a | [`transform`] pose cứng, [`orientation`] miền góc, [`normalize`] contour | đã có |
//! | P2b | [`kernel`] boolean/offset/Minkowski lồi, [`geometry`] phân rã lồi, [`collision`] quan toà | đã có |
//! | P2c | [`nfp`] NFP/IFP, [`spatial`] broad phase, [`validator`] chốt cuối | đã có |
//! | P3a | [`baseline`] sàn an toàn, [`score`] điểm chuẩn | đã có |
//! | P3b | [`candidates`] sinh ứng viên, [`refine`] tinh chỉnh liên tục | đã có |
//! | P4 | [`solver`] một trial, [`multi_start`] gộp và công bố | đã có |
//!
//! Engine Rust đã đủ vòng: [`multi_start::solve`] là điểm vào duy nhất. Module vẫn nằm
//! **inert** trong binary vì chưa có binding PyO3 (P5) — không có nhánh gọi nào từ luồng
//! cũ của PrynX.
//!
//! ## Ai được tin ở đâu
//!
//! [`kernel`] là lớp **duy nhất** biết số học fixed-point và crate `clipper2-rust`; nó
//! sinh hình học phụ trợ (clearance, NFP, coverage). [`collision`] là **quan toà** cho
//! chồng lấn và khoảng hở, cố ý không import [`kernel`] để một lỗi trong kernel không
//! thể tự bào chữa ở bước validate (§11.6).

pub mod baseline;
pub mod candidates;
pub mod collision;
pub mod control;
pub mod geometry;
pub mod kernel;
pub mod model;
pub mod multi_start;
pub mod nfp;
pub mod nfp_cache;
pub mod normalize;
pub mod orientation;
pub mod refine;
pub mod score;
pub mod solver;
pub mod spatial;
pub mod transform;
pub mod validator;

pub use control::{
    derive_trial_seed, CancelToken, Interrupt, JobPhase, ProgressChannel, ProgressMessageCode,
    ProgressSnapshot, RunControl, SearchEffort, StopCriterion,
};
pub use model::{
    canonicalize_angle_deg, format_instance_id, is_canonical_angle_deg, AngleArcDeg,
    AxisAlignedBoundsSpec, ClearanceSpec, ContractError, ContractErrorCode, ContractErrors,
    FixedObstacleKind, FixedObstacleSpec, GroupingIntent, LayoutAlignment, LayoutIntent,
    ManifestAlgorithmVersions, ManifestCandidateSource, ManifestScore, ManifestSearchBudget,
    ManifestSearchSummary, ManifestStatus, MixedNestingRequest, OrientationPolicy,
    PartPlacementZoneSpec, PartSpec, PlacementManifest, PlacementRecord, PointMm, Pose,
    ProductionContractV1, Profile, Reflection, RotationConstraint, RotationDomainKind, RunStats,
    SheetAxisClearanceMm, SheetMarginMm, SheetSpec, TerminationReason, Tolerance, UnplacedReason,
    UnplacedRecord, ValidationSummary, CONVEX_STRICT_TOL_RATIO, DEFAULT_LINEAR_TOL_MM,
    MIXED_NESTING_CANONICALIZATION_VERSION, MIXED_NESTING_ENGINE_VERSION,
    MIXED_NESTING_MANIFEST_SCHEMA_VERSION, MIXED_NESTING_PRODUCTION_SCHEMA_VERSION,
    MIXED_NESTING_PROTOCOL_VERSION, MIXED_NESTING_TOLERANCE_VERSION,
    MIXED_NESTING_VALIDATOR_VERSION,
};
pub use normalize::{
    normalize_request, BoundsMm, NormalizeError, NormalizeErrorCode, NormalizeFailure,
    NormalizedFixedObstacle, NormalizedPart, NormalizedProductionContractV1, NormalizedRequest,
    NormalizedSheet, Winding, NORMALIZE_RULE_VERSION, REFERENCE_POINT_RULE_VERSION,
};
pub use orientation::{
    circular_distance_deg, resolve_part_domain, resolve_rotation_domain, CanonicalArc,
    OrientationError, RotationDomain,
};
pub use transform::{
    check_ring_orientation_preserved, export_transform, place_ring_checked, signed_area_mm2,
    AffineMm, RigidTransform, RigidityViolation, SourceToLocal,
};

pub use baseline::{
    baseline_angles, run_baseline, BaselineAnglePolicy, BaselineError, BaselineOutcome,
    BASELINE_VERSION,
};
pub use candidates::{candidate_angles, order_parts, translation_candidates, PartOrder};
pub use collision::{
    bounds_gap_mm, bounds_may_touch, judge_pair, judge_pair_sheet_axis, min_distance_mm,
    ring_within_bounds, rings_overlap, segment_distance_mm, PairVerdict,
};
pub use geometry::{convex_decompose, is_convex_ring, point_in_ring, reflex_vertex_indices};
pub use kernel::{
    difference, intersection, minkowski_convex, offset, union, union_many, KernelError, OffsetJoin,
    OffsetStyle, RingsMm, KERNEL_FIXED_POINT_SCALE, KERNEL_MAX_ABS_MM, KERNEL_VERSION,
};
pub use multi_start::{
    reduce_candidates, solve, ScoredCandidate, SolutionSource, SolveError, SolveOutcome,
    MULTI_START_VERSION,
};
pub use nfp::{
    feasible_region, feasible_region_cached, inner_fit_rect, no_fit_polygon, region_contains,
    region_vertices, NfpError, RegionMm, NFP_RULE_VERSION,
};
pub use nfp_cache::{NfpCache, KEY_QUANTUM_MM as NFP_CACHE_KEY_QUANTUM_MM};
pub use refine::{
    compact_bottom_left, refine_pose, slide_to_contact, RefineContext, RefinedPose,
    REFINE_RULE_VERSION,
};
pub use score::{score_layout, LayoutScore, PlacementKey, SCORE_VERSION};
pub use solver::{plan_trials, run_trial, TrialError, TrialPlan, TrialResult, SOLVER_VERSION};
pub use spatial::{SpatialEntry, SpatialGrid};
pub use validator::{
    recompute_stats, validate_layout, LayoutUnderReview, ValidationCode, ValidationIssue,
    ValidationReport,
};
