//! Contract test cho hợp đồng dữ liệu `mixed_nesting` — phase P1.
//!
//! Kế hoạch: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §9, §11.3, §12.
//!
//! Bộ test này là chốt chống trôi hợp đồng. Nó phải chứng minh được:
//!
//! 1. Schema thể hiện **free-angle mặc định** và **X/Y liên tục** — không có bước góc,
//!    không có `translationStepMm`, không có lưới toạ độ.
//! 2. **Không tồn tại đường bật reflection** ở cấp dữ liệu.
//! 3. Góc không-cardinal và toạ độ có phần lẻ round-trip **không mất chữ số nào**.
//! 4. Canonical angle quanh `0°`/`360°` ổn định.
//! 5. Request xấu (NaN/Inf, reflection, miền góc rỗng, trùng `partId`, protocol sai,
//!    matrix tùy ý) bị từ chối, không bị bỏ qua im lặng.
//! 6. `fast/balanced/tight` chỉ đổi work effort.
//!
//! Chưa có solver ở P1 nên không có test hình học/placement nào ở đây.

use imposition_core::mixed_nesting::control::{
    derive_trial_seed, CancelToken, Interrupt, JobPhase, ProgressChannel, ProgressMessageCode,
    RunControl, SearchEffort, StopCriterion,
};
use imposition_core::mixed_nesting::model::{
    canonicalize_angle_deg, format_instance_id, is_canonical_angle_deg, AngleArcDeg,
    AxisAlignedBoundsSpec, ClearanceSpec, ContractErrorCode, FixedObstacleKind, FixedObstacleSpec,
    GroupingIntent, LayoutAlignment, LayoutIntent, ManifestStatus, MixedNestingRequest,
    OrientationPolicy, PartPlacementZoneSpec, PartSpec, PlacementManifest, PointMm, Pose,
    ProductionContractV1, Profile, Reflection, RotationConstraint, RotationDomainKind,
    SheetAxisClearanceMm, SheetMarginMm, SheetSpec, TerminationReason, Tolerance, UnplacedReason,
    MIXED_NESTING_CANONICALIZATION_VERSION, MIXED_NESTING_ENGINE_VERSION,
    MIXED_NESTING_PRODUCTION_SCHEMA_VERSION, MIXED_NESTING_PROTOCOL_VERSION,
    MIXED_NESTING_TOLERANCE_VERSION, MIXED_NESTING_VALIDATOR_VERSION,
};

// ─────────────────────────────────────────────────────────────────────────────
//  Fixture
// ─────────────────────────────────────────────────────────────────────────────

/// Request tối thiểu — sao đúng ví dụ JSON trong kế hoạch §9.2.
const REQUEST_TOI_THIEU: &str = r#"{
  "protocolVersion": 2,
  "seed": 20260826,
  "profile": "balanced",
  "timeBudgetMs": 30000,
  "sheet": {
    "widthMm": 700,
    "heightMm": 1000,
    "marginMm": { "left": 10, "right": 10, "top": 10, "bottom": 10 },
    "maxSheets": 20
  },
  "gapMm": 3,
  "orientationPolicy": {
    "defaultRotation": { "mode": "free" },
    "reflection": "forbidden"
  },
  "parts": [
    {
      "partId": "part-a",
      "quantity": 12,
      "outer": [[0, 0], [80, 0], [80, 40], [0, 40]],
      "holes": [],
      "rotationConstraint": { "mode": "inherit" }
    }
  ]
}"#;

/// Manifest — sao đúng ví dụ JSON trong kế hoạch §9.3.
const MANIFEST_MAU: &str = r#"{
  "schemaVersion": 1,
  "manifestId": "uuid",
  "protocolVersion": 2,
  "engineVersion": "0.3.0",
  "jobId": "uuid",
  "requestRevision": 7,
  "inputHash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "layoutFingerprint": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "layoutIntent": "quantity_fulfillment",
  "seed": 20260826,
  "status": "completed",
  "provenance": {
    "nativeBuildIdentity": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "productionSchemaVersion": 3,
    "toleranceVersion": 1,
    "canonicalizationVersion": 1,
    "normalizeRuleVersion": 2,
    "referencePointRuleVersion": 1,
    "kernelVersion": 1,
    "nfpRuleVersion": 1,
    "scoreVersion": 2,
    "solverVersion": 3,
    "multiStartVersion": 3,
    "baselineVersion": 4,
    "candidateRuleVersion": 1,
    "refineRuleVersion": 1
  },
  "search": {
    "budget": {
      "trialCount": 12,
      "orientationProposalsPerPart": 32,
      "beamWidth": 8,
      "refinementRounds": 6,
      "multiStartRestarts": 3,
      "evaluationBudget": 100000,
      "timeBudgetMs": 30000
    },
    "trialsRun": 12,
    "trialsRejected": 0,
    "selectedCandidate": { "kind": "smart_trial", "trialId": 4 },
    "baselineScore": {
      "invalidCount": 0,
      "primaryPenalty": 0,
      "sheetCount": 2,
      "lastSheetUsedAreaFixed": 200000,
      "wastedWithinEnvelopeFixed": 50000,
      "scoreVersion": 2
    },
    "selectedScore": {
      "invalidCount": 0,
      "primaryPenalty": 0,
      "sheetCount": 2,
      "lastSheetUsedAreaFixed": 180000,
      "wastedWithinEnvelopeFixed": 40000,
      "scoreVersion": 2
    }
  },
  "placements": [
    {
      "instanceId": "part-a#0001",
      "partId": "part-a",
      "sheetIndex": 0,
      "pose": {
        "rotationDeg": 13.372849,
        "translateXmm": 123.456789,
        "translateYmm": 67.891234
      },
      "sourceRevision": "sha256"
    }
  ],
  "unplaced": [],
  "stats": {
    "sheetCount": 2,
    "placedCount": 12,
    "unplacedCount": 0,
    "materialUtilization": 0.8123,
    "elapsedMs": 18450,
    "attempts": 32,
    "orientationEvaluations": 1840,
    "poseRefinements": 312,
    "terminationReason": "work_budget_exhausted"
  },
  "validation": {
    "valid": true,
    "validatorVersion": 2
  }
}"#;

fn request_hop_le() -> MixedNestingRequest {
    serde_json::from_str(REQUEST_TOI_THIEU).expect("request mẫu phải parse được")
}

fn hinh_chu_nhat(w: f64, h: f64) -> Vec<PointMm> {
    vec![
        PointMm::new(0.0, 0.0),
        PointMm::new(w, 0.0),
        PointMm::new(w, h),
        PointMm::new(0.0, h),
    ]
}

fn part_mau(part_id: &str) -> PartSpec {
    PartSpec {
        part_id: part_id.to_string(),
        quantity: 3,
        outer: hinh_chu_nhat(80.0, 40.0),
        holes: Vec::new(),
        rotation_constraint: RotationConstraint::Inherit,
        reference_point_mm: None,
        geometry_hash: None,
        source_revision: None,
    }
}

/// Dựng request trực tiếp trong Rust để thử được cả `NaN`/`Inf` — hai giá trị này
/// không phải JSON hợp lệ nên không thể đi qua đường parse.
fn request_dung_tay(parts: Vec<PartSpec>) -> MixedNestingRequest {
    MixedNestingRequest {
        protocol_version: MIXED_NESTING_PROTOCOL_VERSION,
        seed: 20_260_826,
        profile: Profile::Balanced,
        time_budget_ms: Some(30_000),
        sheet: SheetSpec {
            width_mm: 700.0,
            height_mm: 1000.0,
            margin_mm: SheetMarginMm {
                left: 10.0,
                right: 10.0,
                top: 10.0,
                bottom: 10.0,
            },
            max_sheets: 20,
        },
        gap_mm: 3.0,
        layout_intent: Default::default(),
        orientation_policy: OrientationPolicy {
            default_rotation: RotationConstraint::Free,
            reflection: Reflection::Forbidden,
        },
        parts,
        job_id: None,
        production_contract: None,
    }
}

fn hash_mau(byte: char) -> String {
    format!(
        "sha256:{}",
        std::iter::repeat(byte).take(64).collect::<String>()
    )
}

fn production_contract_mau() -> ProductionContractV1 {
    ProductionContractV1 {
        schema_version: MIXED_NESTING_PRODUCTION_SCHEMA_VERSION,
        request_revision: 7,
        input_hash: hash_mau('a'),
        layout_fingerprint: hash_mau('b'),
        alignment: LayoutAlignment::Center,
        grouping_intent: GroupingIntent::FreeGang,
        placement_zones: Vec::new(),
        clearance: ClearanceSpec {
            part_to_part: SheetAxisClearanceMm {
                x_mm: 2.0,
                y_mm: 3.0,
            },
            part_to_sheet_edge: SheetAxisClearanceMm {
                x_mm: 4.0,
                y_mm: 5.0,
            },
            part_to_obstacle: SheetAxisClearanceMm {
                x_mm: 6.0,
                y_mm: 7.0,
            },
        },
        fixed_obstacles: vec![FixedObstacleSpec {
            obstacle_id: "boong-01".to_string(),
            kind: FixedObstacleKind::Gripper,
            outer: hinh_chu_nhat(30.0, 12.0),
        }],
    }
}

fn placement_zone_mau(part_id: &str, min_y_mm: f64, max_y_mm: f64) -> PartPlacementZoneSpec {
    PartPlacementZoneSpec {
        part_id: part_id.to_string(),
        bounds: AxisAlignedBoundsSpec {
            min_x_mm: 10.0,
            min_y_mm,
            max_x_mm: 690.0,
            max_y_mm,
        },
    }
}

fn request_maximize_area_hop_le() -> MixedNestingRequest {
    let mut request = request_dung_tay(vec![part_mau("part-a"), part_mau("part-b")]);
    request.gap_mm = 0.0;
    let mut production = production_contract_mau();
    production.grouping_intent = GroupingIntent::MaximizeArea;
    // Cố ý đảo thứ tự mảng: association phải theo partId, không theo vị trí JSON.
    production.placement_zones = vec![
        placement_zone_mau("part-b", 10.0, 500.0),
        placement_zone_mau("part-a", 500.0, 990.0),
    ];
    request.production_contract = Some(production);
    request
}

/// Parse rồi validate. Trả `Err(mô tả)` cho cả hai loại thất bại để test chỉ cần
/// khẳng định "bị từ chối", không phụ thuộc việc serde hay validator bắt trước.
fn parse_roi_validate(json: &str) -> Result<MixedNestingRequest, String> {
    let request: MixedNestingRequest =
        serde_json::from_str(json).map_err(|error| format!("serde: {error}"))?;
    request
        .validate()
        .map_err(|errors| format!("contract: {errors}"))?;
    Ok(request)
}

/// Chèn thêm một cặp khoá/giá trị vào JSON gốc ở cấp cao nhất.
fn them_khoa_goc(json: &str, doan_them: &str) -> String {
    let vi_tri = json.find('{').expect("JSON phải mở bằng '{'");
    let mut ket_qua = String::from(&json[..=vi_tri]);
    ket_qua.push_str(doan_them);
    ket_qua.push(',');
    ket_qua.push_str(&json[vi_tri + 1..]);
    ket_qua
}

// ─────────────────────────────────────────────────────────────────────────────
//  1. Version của hợp đồng
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn version_hop_dong_duoc_chot() {
    assert_eq!(MIXED_NESTING_PROTOCOL_VERSION, 2);
    assert_eq!(MIXED_NESTING_ENGINE_VERSION, "0.3.0");
    assert_eq!(MIXED_NESTING_VALIDATOR_VERSION, 2);
    assert_eq!(MIXED_NESTING_TOLERANCE_VERSION, 1);
    assert_eq!(MIXED_NESTING_CANONICALIZATION_VERSION, 1);
    assert_eq!(MIXED_NESTING_PRODUCTION_SCHEMA_VERSION, 3);

    // Tolerance có version và KHÔNG đến từ client.
    let tol = Tolerance::v1();
    assert_eq!(tol.version, MIXED_NESTING_TOLERANCE_VERSION);
    assert!(tol.linear_mm > 0.0 && tol.linear_mm < 1e-3);
    assert!(tol.angular_deg > 0.0 && tol.angular_deg < 1e-6);
}

#[test]
fn request_toi_thieu_parse_dung_hop_dong() {
    let request = parse_roi_validate(REQUEST_TOI_THIEU).expect("request mẫu phải hợp lệ");

    assert_eq!(request.protocol_version, 2);
    assert_eq!(request.seed, 20_260_826);
    assert_eq!(request.profile, Profile::Balanced);
    assert_eq!(request.time_budget_ms, Some(30_000));
    assert_eq!(request.sheet.width_mm, 700.0);
    assert_eq!(request.sheet.height_mm, 1000.0);
    assert_eq!(request.sheet.max_sheets, 20);
    assert_eq!(request.gap_mm, 3.0);
    assert_eq!(request.sheet.usable_width_mm(), 680.0);
    assert_eq!(request.sheet.usable_height_mm(), 980.0);
    assert_eq!(request.total_instances(), 12);

    // Server-owned: request công khai không mang jobId.
    assert!(request.job_id.is_none());
    // Payload lab/legacy cũ vẫn parse được; production adapter mới là nơi bắt buộc
    // gắn identity + clearance + obstacles.
    assert!(request.production_contract.is_none());

    // Round-trip qua JSON không đổi giá trị.
    let lai = serde_json::to_string(&request).unwrap();
    let quay_ve: MixedNestingRequest = serde_json::from_str(&lai).unwrap();
    assert_eq!(request, quay_ve);
}

#[test]
fn production_contract_round_trip_giu_gap_xy_va_obstacle_identity() {
    let mut request = request_hop_le();
    request.gap_mm = 0.0;
    request.production_contract = Some(production_contract_mau());
    request
        .validate()
        .expect("production contract mẫu phải hợp lệ");

    let json = serde_json::to_value(&request).unwrap();
    let production = &json["productionContract"];
    assert_eq!(
        production["schemaVersion"],
        MIXED_NESTING_PRODUCTION_SCHEMA_VERSION
    );
    assert_eq!(production["requestRevision"], 7);
    assert_eq!(production["groupingIntent"], "free_gang");
    assert_eq!(production["placementZones"], serde_json::json!([]));
    assert_eq!(production["clearance"]["partToPart"]["xMm"], 2.0);
    assert_eq!(production["clearance"]["partToPart"]["yMm"], 3.0);
    assert_eq!(production["fixedObstacles"][0]["kind"], "gripper");
    assert_eq!(production["fixedObstacles"][0]["obstacleId"], "boong-01");

    let round_trip: MixedNestingRequest = serde_json::from_value(json).unwrap();
    assert_eq!(round_trip, request);
}

#[test]
fn maximize_area_round_trip_giu_partition_theo_part_id() {
    let request = request_maximize_area_hop_le();
    request
        .validate()
        .expect("partition ngang bằng diện tích phải hợp lệ");

    let json = serde_json::to_value(&request).unwrap();
    let production = &json["productionContract"];
    assert_eq!(production["groupingIntent"], "maximize_area");
    assert_eq!(production["placementZones"][0]["partId"], "part-b");
    assert_eq!(production["placementZones"][0]["bounds"]["minYmm"], 10.0);
    assert_eq!(production["placementZones"][1]["partId"], "part-a");
    assert_eq!(production["placementZones"][1]["bounds"]["maxYmm"], 990.0);

    let round_trip: MixedNestingRequest = serde_json::from_value(json).unwrap();
    assert_eq!(round_trip, request);
}

#[test]
fn grouping_intent_tu_choi_zone_sai_contract() {
    let mut free_gang = request_hop_le();
    free_gang.gap_mm = 0.0;
    let mut production = production_contract_mau();
    production.placement_zones = vec![placement_zone_mau("part-a", 10.0, 990.0)];
    free_gang.production_contract = Some(production);
    assert!(free_gang
        .validate()
        .expect_err("free gang không được mang zone")
        .has(ContractErrorCode::PlacementZonesForbidden));

    let mut missing = request_maximize_area_hop_le();
    missing
        .production_contract
        .as_mut()
        .unwrap()
        .placement_zones
        .pop();
    assert!(missing
        .validate()
        .expect_err("maximize area phải đủ một zone cho mỗi part")
        .has(ContractErrorCode::PlacementZoneMissingPart));

    let mut duplicate = request_maximize_area_hop_le();
    duplicate
        .production_contract
        .as_mut()
        .unwrap()
        .placement_zones[0]
        .part_id = "part-a".to_string();
    let duplicate_errors = duplicate
        .validate()
        .expect_err("partId trùng trong zone phải bị chặn");
    assert!(duplicate_errors.has(ContractErrorCode::PlacementZoneDuplicatePart));
    assert!(duplicate_errors.has(ContractErrorCode::PlacementZoneMissingPart));

    let mut outside = request_maximize_area_hop_le();
    outside
        .production_contract
        .as_mut()
        .unwrap()
        .placement_zones[0]
        .bounds
        .min_x_mm = 9.0;
    assert!(outside
        .validate()
        .expect_err("zone ngoài vùng sau lề phải bị chặn")
        .has(ContractErrorCode::PlacementZoneOutsideUsableArea));

    let mut partition = request_maximize_area_hop_le();
    partition
        .production_contract
        .as_mut()
        .unwrap()
        .placement_zones[0]
        .bounds
        .min_y_mm = 11.0;
    assert!(partition
        .validate()
        .expect_err("các dải không phủ kín hoặc không bằng nhau phải bị chặn")
        .has(ContractErrorCode::PlacementZonePartitionInvalid));
}

#[test]
fn production_contract_bat_buoc_job_id_o_preflight_server_owned() {
    let mut request = request_hop_le();
    request.gap_mm = 0.0;
    request.production_contract = Some(production_contract_mau());

    let missing = request
        .validate_server_owned_fields()
        .expect_err("production request chưa có jobId phải bị bridge chặn");
    assert!(missing.has(ContractErrorCode::ProductionJobIdRequired));
    assert!(missing
        .items()
        .iter()
        .any(|item| item.path == "jobId" && item.code.as_str() == "PRODUCTION_JOB_ID_REQUIRED"));

    request.job_id = Some("".to_string());
    assert!(request
        .validate_server_owned_fields()
        .expect_err("jobId rỗng phải bị từ chối")
        .has(ContractErrorCode::ProductionJobIdRequired));

    request.job_id = Some("job-production-0001".to_string());
    request
        .validate_server_owned_fields()
        .expect("jobId server-owned hợp lệ phải qua preflight");
}

#[test]
fn production_contract_tu_choi_hai_nguon_gap_va_identity_khong_canonical() {
    let mut request = request_hop_le();
    request.production_contract = Some(production_contract_mau());
    let errors = request
        .validate()
        .expect_err("gapMm cũ không được song song clearance mới");
    assert!(errors.has(ContractErrorCode::LegacyGapWithProductionContract));

    request.gap_mm = 0.0;
    request.production_contract.as_mut().unwrap().input_hash = "sha256:ABC".to_string();
    let errors = request
        .validate()
        .expect_err("hash không canonical phải bị chặn");
    assert!(errors.has(ContractErrorCode::IdentityHashInvalid));
}

#[test]
fn production_contract_tu_choi_clearance_am_va_obstacle_id_trung() {
    let mut request = request_hop_le();
    request.gap_mm = 0.0;
    let mut production = production_contract_mau();
    production.clearance.part_to_obstacle.y_mm = -0.01;
    production
        .fixed_obstacles
        .push(production.fixed_obstacles[0].clone());
    request.production_contract = Some(production);

    let errors = request
        .validate()
        .expect_err("constraint production xấu phải bị chặn");
    assert!(errors.has(ContractErrorCode::ClearanceOutOfRange));
    assert!(errors.has(ContractErrorCode::DuplicateObstacleId));
}

#[test]
fn reject_protocol_version_sai() {
    for version in ["0", "1", "999"] {
        let json = REQUEST_TOI_THIEU.replace(
            "\"protocolVersion\": 2",
            &format!("\"protocolVersion\": {version}"),
        );
        let loi = parse_roi_validate(&json).expect_err("protocol lệch phải bị từ chối");
        assert!(
            loi.contains("PROTOCOL_VERSION_UNSUPPORTED"),
            "thiếu mã lỗi protocol: {loi}"
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  2. Rotation policy — free-angle là mặc định, preset chỉ là thu hẹp
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn free_la_mien_lien_tuc_360_do() {
    let free = RotationConstraint::Free;
    assert_eq!(free.domain_kind(), Some(RotationDomainKind::Full));
    assert!(free.allows_continuous_rotation());

    // `ranges` cũng là miền liên tục, không phải angle grid.
    let ranges = RotationConstraint::Ranges {
        arcs: vec![AngleArcDeg {
            start_deg: 350.0,
            sweep_deg: 20.0,
        }],
    };
    assert!(ranges.allows_continuous_rotation());
    assert_eq!(
        ranges.domain_kind(),
        Some(RotationDomainKind::ContinuousArcs { count: 1 })
    );

    // Preset hữu hạn KHÔNG liên tục — đây là bằng chứng chúng chỉ là lựa chọn thu hẹp.
    assert!(!RotationConstraint::preset_cardinal().allows_continuous_rotation());
    assert!(!RotationConstraint::preset_half_turn().allows_continuous_rotation());
    assert!(!RotationConstraint::preset_keep_orientation().allows_continuous_rotation());
}

#[test]
fn profile_khong_thu_hep_mien_goc() {
    // Bằng chứng cấu trúc: miền góc không đi qua SearchEffort, và effective_rotation
    // không nhận profile. Cả ba profile cùng cho miền Full với `free`.
    for profile in [Profile::Fast, Profile::Balanced, Profile::Tight] {
        let mut request = request_dung_tay(vec![part_mau("part-a")]);
        request.profile = profile;
        let phan_giai = request.effective_rotation(&request.parts[0]);
        assert_eq!(phan_giai.domain_kind(), Some(RotationDomainKind::Full));
        assert!(phan_giai.allows_continuous_rotation());
    }

    // Effort tăng đơn điệu theo profile trên MỌI trường; không trường nào là bước góc.
    let fast = SearchEffort::for_profile(Profile::Fast);
    let balanced = SearchEffort::for_profile(Profile::Balanced);
    let tight = SearchEffort::for_profile(Profile::Tight);
    for (thap, cao) in [(fast, balanced), (balanced, tight)] {
        assert!(thap.trial_count < cao.trial_count);
        assert!(thap.orientation_proposals_per_part < cao.orientation_proposals_per_part);
        assert!(thap.beam_width < cao.beam_width);
        assert!(thap.refinement_rounds < cao.refinement_rounds);
        assert!(thap.multi_start_restarts < cao.multi_start_restarts);
        assert!(thap.evaluation_budget < cao.evaluation_budget);
    }

    // Hợp đồng JSON của effort không được chứa khái niệm bước góc hay lưới toạ độ.
    let json = serde_json::to_string(&tight).unwrap();
    for tu_cam in [
        "angleStep",
        "rotationStep",
        "allowedRotations",
        "translationStep",
        "grid",
        "snap",
    ] {
        assert!(
            !json.contains(tu_cam),
            "SearchEffort không được chứa '{tu_cam}': {json}"
        );
    }
}

#[test]
fn inherit_phan_giai_ve_policy_cap_job() {
    let mut request = request_dung_tay(vec![part_mau("part-a"), part_mau("part-b")]);
    request.orientation_policy.default_rotation = RotationConstraint::preset_half_turn();
    // part-b override bằng free ⇒ vẫn tự do dù job đang bị thu hẹp.
    request.parts[1].rotation_constraint = RotationConstraint::Free;
    request.validate().expect("request phải hợp lệ");

    assert_eq!(
        request.effective_rotation(&request.parts[0]),
        &RotationConstraint::preset_half_turn()
    );
    assert_eq!(
        request.effective_rotation(&request.parts[1]),
        &RotationConstraint::Free
    );

    // Thiếu hẳn `rotationConstraint` ⇒ inherit ⇒ (mặc định job free) tự do.
    let json = r#"{"partId":"p","quantity":1,"outer":[[0,0],[10,0],[10,5]]}"#;
    let part: PartSpec = serde_json::from_str(json).unwrap();
    assert_eq!(part.rotation_constraint, RotationConstraint::Inherit);
    let mac_dinh = request_dung_tay(vec![part]);
    assert_eq!(
        mac_dinh.effective_rotation(&mac_dinh.parts[0]),
        &RotationConstraint::Free
    );
}

#[test]
fn reject_inherit_o_cap_job() {
    let json = REQUEST_TOI_THIEU.replace(
        r#""defaultRotation": { "mode": "free" }"#,
        r#""defaultRotation": { "mode": "inherit" }"#,
    );
    let loi = parse_roi_validate(&json).expect_err("inherit cấp job phải bị từ chối");
    assert!(
        loi.contains("ROTATION_INHERIT_NOT_ALLOWED_AT_JOB_LEVEL"),
        "thiếu mã lỗi inherit cấp job: {loi}"
    );
}

#[test]
fn fixed_nhan_goc_khong_cardinal() {
    let json = REQUEST_TOI_THIEU.replace(
        r#"{ "mode": "inherit" }"#,
        r#"{ "mode": "fixed", "angleDeg": 13.372849 }"#,
    );
    let request = parse_roi_validate(&json).expect("góc khóa không-cardinal phải hợp lệ");
    match &request.parts[0].rotation_constraint {
        RotationConstraint::Fixed { angle_deg } => assert_eq!(*angle_deg, 13.372849),
        khac => panic!("mode sai: {khac:?}"),
    }
}

#[test]
fn preset_compile_ve_discrete() {
    // Ba preset của UI đều là `discrete`/`fixed`, không phải mode riêng của engine.
    assert_eq!(
        RotationConstraint::preset_cardinal(),
        RotationConstraint::Discrete {
            angles_deg: vec![0.0, 90.0, 180.0, 270.0]
        }
    );
    assert_eq!(
        serde_json::to_value(RotationConstraint::preset_half_turn()).unwrap(),
        serde_json::json!({ "mode": "discrete", "anglesDeg": [0.0, 180.0] })
    );
    assert_eq!(
        serde_json::to_value(RotationConstraint::preset_keep_orientation()).unwrap(),
        serde_json::json!({ "mode": "fixed", "angleDeg": 0.0 })
    );
}

#[test]
fn ranges_wrap_qua_0_do_khong_mo_ho() {
    let json = REQUEST_TOI_THIEU.replace(
        r#"{ "mode": "inherit" }"#,
        r#"{ "mode": "ranges", "arcs": [{ "startDeg": 350, "sweepDeg": 20 }] }"#,
    );
    let request = parse_roi_validate(&json).expect("cung đi qua 0° phải hợp lệ");
    match &request.parts[0].rotation_constraint {
        RotationConstraint::Ranges { arcs } => {
            assert_eq!(arcs.len(), 1);
            assert_eq!(arcs[0].start_deg, 350.0);
            assert_eq!(arcs[0].sweep_deg, 20.0);
        }
        khac => panic!("mode sai: {khac:?}"),
    }

    // sweep = 360° (cả vòng) vẫn hợp lệ.
    let ca_vong = REQUEST_TOI_THIEU.replace(
        r#"{ "mode": "inherit" }"#,
        r#"{ "mode": "ranges", "arcs": [{ "startDeg": 0, "sweepDeg": 360 }] }"#,
    );
    assert!(parse_roi_validate(&ca_vong).is_ok());
}

#[test]
fn reject_mien_goc_rong() {
    for doan in [
        r#"{ "mode": "discrete", "anglesDeg": [] }"#,
        r#"{ "mode": "ranges", "arcs": [] }"#,
    ] {
        let json = REQUEST_TOI_THIEU.replace(r#"{ "mode": "inherit" }"#, doan);
        let loi = parse_roi_validate(&json).expect_err("miền góc rỗng phải bị từ chối");
        assert!(
            loi.contains("ROTATION_DOMAIN_EMPTY"),
            "thiếu mã lỗi miền rỗng cho {doan}: {loi}"
        );
    }
}

#[test]
fn reject_arc_sweep_ngoai_mien() {
    for sweep in ["0", "-5", "360.5", "720"] {
        let json = REQUEST_TOI_THIEU.replace(
            r#"{ "mode": "inherit" }"#,
            &format!(
                r#"{{ "mode": "ranges", "arcs": [{{ "startDeg": 10, "sweepDeg": {sweep} }}] }}"#
            ),
        );
        let loi = parse_roi_validate(&json).expect_err("sweep ngoài (0,360] phải bị từ chối");
        assert!(
            loi.contains("ROTATION_ARC_SWEEP_OUT_OF_RANGE"),
            "sweep={sweep} không bị chặn đúng mã: {loi}"
        );
    }
}

#[test]
fn reject_rotation_mode_la_va_tham_so_lac() {
    for doan in [
        // Mode không tồn tại.
        r#"{ "mode": "cardinal" }"#,
        r#"{ "mode": "step", "stepDeg": 15 }"#,
        r#"{ "mode": "any" }"#,
        // Khoá lạ cố nhồi bước góc / lưới toạ độ vào miền xoay.
        r#"{ "mode": "free", "angleStepDeg": 1 }"#,
        r#"{ "mode": "free", "translationStepMm": 0.5 }"#,
        r#"{ "mode": "discrete", "anglesDeg": [0, 180], "stepDeg": 90 }"#,
        // Tham số không thuộc mode — phải lỗi, không được lặng lẽ bỏ.
        r#"{ "mode": "free", "anglesDeg": [0, 90] }"#,
        r#"{ "mode": "inherit", "angleDeg": 45 }"#,
        r#"{ "mode": "fixed", "anglesDeg": [0] }"#,
        r#"{ "mode": "discrete", "arcs": [{ "startDeg": 0, "sweepDeg": 10 }] }"#,
        r#"{ "mode": "ranges", "angleDeg": 45 }"#,
        // Thiếu tham số bắt buộc.
        r#"{ "mode": "fixed" }"#,
        r#"{ "mode": "discrete" }"#,
        r#"{ "mode": "ranges" }"#,
    ] {
        let json = REQUEST_TOI_THIEU.replace(r#"{ "mode": "inherit" }"#, doan);
        let loi = parse_roi_validate(&json)
            .expect_err(&format!("mode/tham số lạ phải bị từ chối: {doan}"));
        assert!(
            loi.contains("serde"),
            "phải bị chặn ngay khi deserialize, không bị bỏ qua im lặng: {doan} → {loi}"
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  3. Reflection luôn bị cấm
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn reflection_chi_co_forbidden() {
    assert_eq!(Reflection::default(), Reflection::Forbidden);
    assert_eq!(
        serde_json::to_string(&Reflection::Forbidden).unwrap(),
        "\"forbidden\""
    );

    // Không có literal nào khác deserialize được ⇒ không tồn tại đường bật mirror.
    for gia_tri in ["\"allowed\"", "\"mirror\"", "\"optional\"", "true", "1"] {
        assert!(
            serde_json::from_str::<Reflection>(gia_tri).is_err(),
            "reflection={gia_tri} phải bị từ chối"
        );
    }
}

#[test]
fn reject_reflection_khac_forbidden_trong_request() {
    for gia_tri in ["\"allowed\"", "\"mirror\"", "\"back\""] {
        let json = REQUEST_TOI_THIEU.replace(
            r#""reflection": "forbidden""#,
            &format!(r#""reflection": {gia_tri}"#),
        );
        assert!(
            parse_roi_validate(&json).is_err(),
            "reflection={gia_tri} phải bị từ chối"
        );
    }
}

#[test]
fn reflection_vang_mat_mac_dinh_forbidden() {
    let json = REQUEST_TOI_THIEU.replace(",\n    \"reflection\": \"forbidden\"", "");
    let request = parse_roi_validate(&json).expect("vắng reflection vẫn hợp lệ");
    assert_eq!(request.orientation_policy.reflection, Reflection::Forbidden);
}

#[test]
fn part_khong_duoc_override_reflection() {
    let json = REQUEST_TOI_THIEU.replace(
        r#""quantity": 12,"#,
        r#""quantity": 12, "reflection": "allowed","#,
    );
    let loi = parse_roi_validate(&json).expect_err("part override reflection phải bị từ chối");
    assert!(
        loi.contains("serde"),
        "phải bị chặn ngay khi deserialize: {loi}"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
//  4. Không có translation grid, không có matrix tùy ý
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn reject_translation_step_mm() {
    // Cấp request.
    let goc = them_khoa_goc(REQUEST_TOI_THIEU, "\"translationStepMm\": 0.5");
    assert!(
        parse_roi_validate(&goc).is_err(),
        "translationStepMm cấp job phải bị từ chối"
    );

    // Cấp tờ.
    let cap_to = REQUEST_TOI_THIEU.replace(
        r#""maxSheets": 20"#,
        r#""maxSheets": 20, "translationStepMm": 0.5"#,
    );
    assert!(
        parse_roi_validate(&cap_to).is_err(),
        "translationStepMm cấp tờ phải bị từ chối"
    );

    // Cấp chi tiết.
    let cap_part = REQUEST_TOI_THIEU.replace(
        r#""quantity": 12,"#,
        r#""quantity": 12, "translationStepMm": 0.5,"#,
    );
    assert!(
        parse_roi_validate(&cap_part).is_err(),
        "translationStepMm cấp part phải bị từ chối"
    );
}

#[test]
fn reject_matrix_scale_shear_mirror_tu_client() {
    for doan in [
        r#""matrix": [1, 0, 0, 1, 0, 0]"#,
        r#""transform": { "a": 1, "d": 1 }"#,
        r#""scale": 1.02"#,
        r#""shear": 0.1"#,
        r#""mirror": true"#,
        r#""allowedRotationsDeg": [0, 90, 180, 270]"#,
        r#""snapGridMm": 1"#,
        r#""tolerance": { "linearMm": 1 }"#,
    ] {
        let cap_job = them_khoa_goc(REQUEST_TOI_THIEU, doan);
        assert!(
            parse_roi_validate(&cap_job).is_err(),
            "cấp job phải từ chối {doan}"
        );

        let cap_part =
            REQUEST_TOI_THIEU.replace(r#""quantity": 12,"#, &format!(r#""quantity": 12, {doan},"#));
        assert!(
            parse_roi_validate(&cap_part).is_err(),
            "cấp part phải từ chối {doan}"
        );
    }
}

#[test]
fn pose_khong_kem_matrix() {
    // Pose là nguồn chân lý duy nhất: chỉ 3 khoá, không có matrix song song.
    let pose = Pose::new(13.372849, 123.456789, 67.891234);
    let value = serde_json::to_value(pose).unwrap();
    let object = value.as_object().unwrap();
    assert_eq!(object.len(), 3);
    assert!(object.contains_key("rotationDeg"));
    assert!(object.contains_key("translateXmm"));
    assert!(object.contains_key("translateYmm"));

    // Thêm matrix vào pose ⇒ bị từ chối, không có hai nguồn chân lý.
    let voi_matrix =
        r#"{"rotationDeg":0,"translateXmm":0,"translateYmm":0,"matrix":[1,0,0,1,0,0]}"#;
    assert!(serde_json::from_str::<Pose>(voi_matrix).is_err());
}

// ─────────────────────────────────────────────────────────────────────────────
//  5. Canonical angle quanh 0°/360°
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn canonical_angle_quanh_0_va_360() {
    let tol = Tolerance::v1();
    let canon = |deg: f64| canonicalize_angle_deg(deg, &tol).expect("góc hữu hạn");

    // 360° và 0° cùng một đại diện.
    assert_eq!(canon(0.0), 0.0);
    assert_eq!(canon(360.0), 0.0);
    assert_eq!(canon(720.0), 0.0);
    assert_eq!(canon(-360.0), 0.0);

    // `-0.0` không được rò ra ngoài (làm lệch so sánh và hiển thị).
    assert!(canon(-0.0).is_sign_positive());
    assert_eq!(canon(-0.0), 0.0);

    // Sát biên trong tolerance ⇒ gộp về 0°.
    assert_eq!(canon(359.999_999_999_9), 0.0);
    assert_eq!(canon(-1e-12), 0.0);
    assert_eq!(canon(1e-12), 0.0);

    // Ngoài tolerance ⇒ giữ nguyên, KHÔNG snap.
    assert_eq!(canon(359.9), 359.9);
    assert_eq!(canon(0.1), 0.1);

    // Góc âm và góc vượt vòng quy về đúng miền.
    assert_eq!(canon(-90.0), 270.0);
    assert!((canon(720.5) - 0.5).abs() < 1e-12);
    assert!((canon(-13.372849) - 346.627151).abs() < 1e-9);

    // Mọi kết quả thuộc [0°, 360°).
    for deg in [
        0.1, 13.372849, 44.999, 89.999, 179.5, 359.9, 360.0, -0.5, 1080.25,
    ] {
        let value = canon(deg);
        assert!((0.0..360.0).contains(&value), "canon({deg}) = {value}");
        assert!(is_canonical_angle_deg(value, &tol));
    }

    // Không hữu hạn ⇒ None, engine không tự chữa thành 0°.
    assert!(canonicalize_angle_deg(f64::NAN, &tol).is_none());
    assert!(canonicalize_angle_deg(f64::INFINITY, &tol).is_none());
    assert!(canonicalize_angle_deg(f64::NEG_INFINITY, &tol).is_none());
}

#[test]
fn canonical_giu_nguyen_goc_khong_cardinal() {
    let tol = Tolerance::v1();
    for deg in [0.1, 13.372849, 17.3, 33.7, 44.999, 89.999, 179.5, 359.9] {
        let canon = canonicalize_angle_deg(deg, &tol).unwrap();
        // Bit-exact: canonicalization không được làm tròn về bội của bước góc nào.
        assert_eq!(canon, deg, "canonicalization làm lệch góc {deg}");
    }
}

#[test]
fn round_trip_degree_radian_khong_lech_ngoai_tolerance() {
    let tol = Tolerance::v1();
    for deg in [0.1_f64, 13.372849, 44.999, 89.999, 179.5, 359.9] {
        let quay_ve = deg.to_radians().to_degrees();
        let canon = canonicalize_angle_deg(quay_ve, &tol).unwrap();
        assert!(
            (canon - deg).abs() <= tol.angular_deg,
            "round-trip {deg}° lệch quá tolerance: {canon}"
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  6. Round-trip góc không-cardinal và X/Y phần lẻ
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn manifest_round_trip_giu_du_do_chinh_xac() {
    let manifest: PlacementManifest =
        serde_json::from_str(MANIFEST_MAU).expect("manifest mẫu phải parse được");

    assert_eq!(manifest.protocol_version, 2);
    assert_eq!(manifest.schema_version, 1);
    assert_eq!(manifest.manifest_id, manifest.job_id);
    assert_eq!(manifest.request_revision, Some(7));
    assert_eq!(
        manifest.input_hash.as_deref(),
        Some("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    );
    assert_eq!(
        manifest.layout_fingerprint.as_deref(),
        Some("sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
    );
    assert_eq!(manifest.layout_intent, LayoutIntent::QuantityFulfillment);
    assert_eq!(manifest.provenance.solver_version, 3);
    assert_eq!(manifest.provenance.baseline_version, 4);
    assert_eq!(manifest.search.trials_run, 12);
    assert_eq!(manifest.search.selected_score.score_version, 2);
    assert_eq!(manifest.engine_version, MIXED_NESTING_ENGINE_VERSION);
    assert_eq!(manifest.status, ManifestStatus::Completed);
    assert_eq!(manifest.placements.len(), 1);
    assert_eq!(manifest.unplaced.len(), 0);
    assert_eq!(
        manifest.stats.termination_reason,
        TerminationReason::WorkBudgetExhausted
    );
    assert!(manifest.validation.valid);
    assert_eq!(
        manifest.validation.validator_version,
        MIXED_NESTING_VALIDATOR_VERSION
    );

    let placement = &manifest.placements[0];
    assert_eq!(placement.instance_id, "part-a#0001");
    assert_eq!(placement.sheet_index, 0);
    assert_eq!(placement.source_revision.as_deref(), Some("sha256"));

    // Bit-exact: pose là nguồn chân lý, không được làm tròn ở bất kỳ chặng nào.
    assert_eq!(placement.pose.rotation_deg, 13.372849);
    assert_eq!(placement.pose.translate_x_mm, 123.456789);
    assert_eq!(placement.pose.translate_y_mm, 67.891234);

    let lai = serde_json::to_string(&manifest).unwrap();
    let quay_ve: PlacementManifest = serde_json::from_str(&lai).unwrap();
    assert_eq!(manifest, quay_ve);
    assert_eq!(quay_ve.placements[0].pose.rotation_deg, 13.372849);
    assert_eq!(quay_ve.placements[0].pose.translate_x_mm, 123.456789);
    assert_eq!(quay_ve.placements[0].pose.translate_y_mm, 67.891234);
}

#[test]
fn pose_ten_truong_dung_hop_dong() {
    let json = serde_json::to_string(&Pose::new(1.5, 2.25, 3.125)).unwrap();
    assert_eq!(
        json,
        r#"{"rotationDeg":1.5,"translateXmm":2.25,"translateYmm":3.125}"#
    );
}

#[test]
fn x_y_phan_le_khong_bi_snap_qua_round_trip() {
    // Toạ độ cố ý KHÔNG nằm trên lưới mm/pixel nào.
    let mau = [
        (0.000_001_f64, -0.000_001_f64),
        (123.456_789_012_345, 67.891_234_567_89),
        (699.999_999_9, 0.000_000_1),
        (-45.678_9, 1_000.123_456_7),
    ];
    for (x, y) in mau {
        let pose = Pose::new(13.372_849, x, y);
        let quay_ve: Pose = serde_json::from_str(&serde_json::to_string(&pose).unwrap()).unwrap();
        assert_eq!(quay_ve.translate_x_mm, x, "X {x} bị đổi khi round-trip");
        assert_eq!(quay_ve.translate_y_mm, y, "Y {y} bị đổi khi round-trip");
        assert_eq!(quay_ve.rotation_deg, 13.372_849);
        assert!(quay_ve.is_finite());
    }
}

#[test]
fn diem_contour_phan_le_round_trip_dung_dang_mang() {
    let part = PartSpec {
        outer: vec![
            PointMm::new(0.000_001, 0.000_002),
            PointMm::new(80.123_456_789, 0.0),
            PointMm::new(80.123_456_789, 40.987_654_321),
        ],
        reference_point_mm: Some(PointMm::new(12.345_678, -9.876_543)),
        ..part_mau("part-a")
    };
    let json = serde_json::to_string(&part).unwrap();
    // Hình dạng JSON của điểm là mảng [x, y] đúng như kế hoạch §9.2.
    assert!(
        json.contains(r#""outer":[[1e-6,2e-6]"#),
        "hình dạng điểm sai: {json}"
    );
    let quay_ve: PartSpec = serde_json::from_str(&json).unwrap();
    assert_eq!(part, quay_ve);
}

#[test]
fn instance_id_dung_dinh_dang_hop_dong() {
    assert_eq!(format_instance_id("part-a", 1), "part-a#0001");
    assert_eq!(format_instance_id("part-a", 12), "part-a#0012");
    assert_eq!(format_instance_id("part-a", 9_999), "part-a#9999");
    // Vượt 4 chữ số vẫn duy nhất (không bị cắt).
    assert_eq!(format_instance_id("part-a", 10_000), "part-a#10000");
}

#[test]
fn ma_ly_do_dung_dang_trong_ke_hoach() {
    // unplaced reason: SCREAMING_SNAKE_CASE (§11.4).
    assert_eq!(
        serde_json::to_string(&UnplacedReason::NoFeasiblePose).unwrap(),
        "\"NO_FEASIBLE_POSE\""
    );
    assert_eq!(
        serde_json::to_string(&UnplacedReason::SearchBudgetExhausted).unwrap(),
        "\"SEARCH_BUDGET_EXHAUSTED\""
    );
    // terminationReason: snake_case (§9.3).
    assert_eq!(
        serde_json::to_string(&TerminationReason::WorkBudgetExhausted).unwrap(),
        "\"work_budget_exhausted\""
    );
    assert_eq!(
        serde_json::to_string(&TerminationReason::Deadline).unwrap(),
        "\"deadline\""
    );
}

// ─────────────────────────────────────────────────────────────────────────────
//  7. Validation dữ liệu hữu hạn
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn reject_nan_inf_moi_truong_so() {
    // NaN/Inf không phải JSON hợp lệ nên phải dựng struct trực tiếp.
    let mut xau_toa_do = request_dung_tay(vec![part_mau("part-a")]);
    xau_toa_do.parts[0].outer[2] = PointMm::new(f64::NAN, 40.0);
    let loi = xau_toa_do
        .validate()
        .expect_err("NaN toạ độ phải bị từ chối");
    assert!(loi.has(ContractErrorCode::NotFinite));
    // Không được lộ toạ độ khách hàng trong thông báo, chỉ chỉ số đỉnh.
    assert!(loi.to_string().contains("parts[0].outer[2]"));

    let mut xau_gap = request_dung_tay(vec![part_mau("part-a")]);
    xau_gap.gap_mm = f64::INFINITY;
    assert!(xau_gap
        .validate()
        .expect_err("gap vô cực phải bị từ chối")
        .has(ContractErrorCode::NotFinite));

    let mut xau_to = request_dung_tay(vec![part_mau("part-a")]);
    xau_to.sheet.width_mm = f64::NAN;
    assert!(xau_to
        .validate()
        .expect_err("khổ tờ NaN phải bị từ chối")
        .has(ContractErrorCode::NotFinite));

    let mut xau_le = request_dung_tay(vec![part_mau("part-a")]);
    xau_le.sheet.margin_mm.left = f64::NEG_INFINITY;
    assert!(xau_le
        .validate()
        .expect_err("lề vô cực phải bị từ chối")
        .has(ContractErrorCode::NotFinite));

    let mut xau_goc = request_dung_tay(vec![part_mau("part-a")]);
    xau_goc.parts[0].rotation_constraint = RotationConstraint::Fixed {
        angle_deg: f64::NAN,
    };
    assert!(xau_goc
        .validate()
        .expect_err("góc NaN phải bị từ chối")
        .has(ContractErrorCode::NotFinite));

    let mut xau_pivot = request_dung_tay(vec![part_mau("part-a")]);
    xau_pivot.parts[0].reference_point_mm = Some(PointMm::new(0.0, f64::INFINITY));
    assert!(xau_pivot
        .validate()
        .expect_err("pivot vô cực phải bị từ chối")
        .has(ContractErrorCode::NotFinite));
}

#[test]
fn reject_so_khong_hop_le_tu_json() {
    // Chuỗi "NaN"/"Infinity" và số tràn f64 đều không được lọt qua.
    for doan in [
        (r#""gapMm": 3"#, r#""gapMm": "NaN""#),
        (r#""gapMm": 3"#, r#""gapMm": 1e400"#),
        (r#""gapMm": 3"#, r#""gapMm": -1"#),
        (r#""widthMm": 700"#, r#""widthMm": 0"#),
        (r#""widthMm": 700"#, r#""widthMm": -700"#),
        (r#""maxSheets": 20"#, r#""maxSheets": 0"#),
        (r#""timeBudgetMs": 30000"#, r#""timeBudgetMs": 0"#),
        (r#""quantity": 12"#, r#""quantity": 0"#),
    ] {
        let json = REQUEST_TOI_THIEU.replace(doan.0, doan.1);
        assert!(
            parse_roi_validate(&json).is_err(),
            "phải từ chối payload có {}",
            doan.1
        );
    }
}

#[test]
fn reject_duplicate_part_id() {
    let request = request_dung_tay(vec![part_mau("part-a"), part_mau("part-a")]);
    let loi = request
        .validate()
        .expect_err("partId trùng phải bị từ chối");
    assert!(loi.has(ContractErrorCode::DuplicatePartId));
    assert!(loi.to_string().contains("parts[1].partId"));

    // Hai mã khác nhau thì hợp lệ.
    request_dung_tay(vec![part_mau("part-a"), part_mau("part-b")])
        .validate()
        .expect("hai mã khác nhau phải hợp lệ");
}

#[test]
fn reject_contour_va_part_suy_bien_ve_cau_truc() {
    // Contour < 3 đỉnh.
    let mut it_dinh = request_dung_tay(vec![part_mau("part-a")]);
    it_dinh.parts[0].outer = vec![PointMm::new(0.0, 0.0), PointMm::new(10.0, 0.0)];
    assert!(it_dinh
        .validate()
        .expect_err("contour 2 đỉnh phải bị từ chối")
        .has(ContractErrorCode::RingTooFewVertices));

    // Lỗ < 3 đỉnh cũng bị chặn.
    let mut lo_xau = request_dung_tay(vec![part_mau("part-a")]);
    lo_xau.parts[0].holes = vec![vec![PointMm::new(1.0, 1.0)]];
    assert!(lo_xau
        .validate()
        .expect_err("lỗ 1 đỉnh phải bị từ chối")
        .has(ContractErrorCode::RingTooFewVertices));

    // Không có chi tiết nào.
    assert!(request_dung_tay(Vec::new())
        .validate()
        .expect_err("job rỗng phải bị từ chối")
        .has(ContractErrorCode::EmptyParts));

    // partId rỗng / chứa ký tự điều khiển.
    let mut ma_rong = request_dung_tay(vec![part_mau("   ")]);
    ma_rong.parts[0].part_id = "  ".to_string();
    assert!(ma_rong
        .validate()
        .expect_err("partId rỗng phải bị từ chối")
        .has(ContractErrorCode::InvalidPartId));

    let mut ma_xau = request_dung_tay(vec![part_mau("part-a")]);
    ma_xau.parts[0].part_id = "part\u{0}a".to_string();
    assert!(ma_xau
        .validate()
        .expect_err("partId có ký tự điều khiển phải bị từ chối")
        .has(ContractErrorCode::InvalidPartId));
}

#[test]
fn reject_vung_dung_duoc_khong_con_dien_tich() {
    let mut request = request_dung_tay(vec![part_mau("part-a")]);
    request.sheet.margin_mm.left = 350.0;
    request.sheet.margin_mm.right = 350.0;
    assert!(request
        .validate()
        .expect_err("lề ăn hết bề rộng phải bị từ chối")
        .has(ContractErrorCode::UsableAreaEmpty));
}

#[test]
fn gap_bang_0_duoc_phep() {
    let mut request = request_dung_tay(vec![part_mau("part-a")]);
    request.gap_mm = 0.0;
    request
        .validate()
        .expect("gap 0 mm phải hợp lệ (common cut-line)");
}

#[test]
fn validate_gom_nhieu_loi_va_co_tran() {
    let mut request = request_dung_tay(vec![part_mau("part-a"), part_mau("part-a")]);
    request.protocol_version = 7;
    request.gap_mm = -1.0;
    let loi = request.validate().expect_err("phải có lỗi");
    assert!(loi.len() >= 3, "phải gom nhiều lỗi, có {}", loi.len());
    assert!(loi.has(ContractErrorCode::ProtocolVersionUnsupported));
    assert!(loi.has(ContractErrorCode::GapOutOfRange));
    assert!(loi.has(ContractErrorCode::DuplicatePartId));

    // Payload cực xấu không làm phình bộ nhớ: số lỗi báo có trần.
    let mut rat_xau = request_dung_tay(vec![part_mau("part-a")]);
    rat_xau.parts[0].outer = (0..5_000).map(|_| PointMm::new(f64::NAN, 0.0)).collect();
    let nhieu_loi = rat_xau.validate().expect_err("phải có lỗi");
    assert!(
        nhieu_loi.len() <= 64,
        "vượt trần báo lỗi: {}",
        nhieu_loi.len()
    );
}

// ─────────────────────────────────────────────────────────────────────────────
//  8. Seed, progress, cancel, work budget
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn seed_dan_xuat_deterministic_va_khong_phu_thuoc_worker() {
    let seed = 20_260_826_u64;
    // Cùng (seed, trialId) ⇒ cùng giá trị, mọi lần gọi.
    for trial in 0..64_u64 {
        assert_eq!(
            derive_trial_seed(seed, trial),
            derive_trial_seed(seed, trial),
            "seed dẫn xuất phải thuần"
        );
    }
    // Khác trialId ⇒ khác seed (không đụng nhau trong 4096 trial đầu).
    let mut da_thay = std::collections::BTreeSet::new();
    for trial in 0..4_096_u64 {
        assert!(
            da_thay.insert(derive_trial_seed(seed, trial)),
            "seed dẫn xuất trùng ở trial {trial}"
        );
    }
    // Khác seed gốc ⇒ khác chuỗi.
    assert_ne!(derive_trial_seed(seed, 0), derive_trial_seed(seed + 1, 0));
}

#[test]
fn progress_ghi_doc_qua_atomic() {
    let progress = ProgressChannel::new();
    let ban_dau = progress.snapshot();
    assert_eq!(ban_dau.phase, JobPhase::Queued);
    assert_eq!(ban_dau.progress, 0.0);
    assert_eq!(ban_dau.attempts, 0);
    assert!(ban_dau.best_sheet_count.is_none());
    assert!(ban_dau.best_utilization.is_none());

    progress.set_phase(JobPhase::Nesting);
    progress.set_message(ProgressMessageCode::SearchingPoses);
    progress.set_progress(0.5);
    progress.add_attempts(3);
    progress.add_attempts(4);
    progress.record_best(2, 0.8123);

    let sau = progress.snapshot();
    assert_eq!(sau.phase, JobPhase::Nesting);
    assert_eq!(sau.message_code, ProgressMessageCode::SearchingPoses);
    assert!((sau.progress - 0.5).abs() < 1e-9);
    assert_eq!(sau.attempts, 7);
    assert_eq!(sau.best_sheet_count, Some(2));
    assert!((sau.best_utilization.unwrap() - 0.8123).abs() < 1e-6);

    // Giá trị bệnh không làm UI nhảy.
    progress.set_progress(f64::NAN);
    assert_eq!(progress.snapshot().progress, 0.0);
    progress.set_progress(9.0);
    assert_eq!(progress.snapshot().progress, 1.0);
    progress.set_progress(-9.0);
    assert_eq!(progress.snapshot().progress, 0.0);

    // Snapshot serialize được cho endpoint Status.
    let json = serde_json::to_string(&progress.snapshot()).unwrap();
    assert!(json.contains("\"phase\":\"nesting\""), "{json}");
    assert!(json.contains("\"messageCode\":"), "{json}");
}

#[test]
fn progress_chia_se_duoc_giua_cac_thread() {
    use std::sync::Arc;

    let progress = Arc::new(ProgressChannel::new());
    let ghi = Arc::clone(&progress);
    let handle = std::thread::spawn(move || {
        for _ in 0..1_000 {
            ghi.add_attempts(1);
        }
        ghi.set_phase(JobPhase::Improving);
    });
    // Đọc song song không chặn, không panic.
    let _ = progress.snapshot();
    handle.join().unwrap();

    let sau = progress.snapshot();
    assert_eq!(sau.attempts, 1_000);
    assert_eq!(sau.phase, JobPhase::Improving);
}

#[test]
fn state_machine_va_thong_bao_tieng_viet() {
    // Ánh xạ atomic ↔ enum khép kín.
    for (index, phase) in JobPhase::ALL.iter().enumerate() {
        assert_eq!(JobPhase::from_u8(index as u8), Some(*phase));
    }
    assert!(JobPhase::from_u8(200).is_none());

    assert!(!JobPhase::Nesting.is_terminal());
    assert!(JobPhase::Completed.is_terminal());
    assert!(JobPhase::Failed.is_terminal());
    assert!(JobPhase::Cancelled.is_terminal());

    // Manifest chỉ tồn tại ở trạng thái terminal ⇒ không có "manifest nửa vời".
    assert_eq!(
        JobPhase::Completed.manifest_status(),
        Some(ManifestStatus::Completed)
    );
    assert_eq!(
        JobPhase::Cancelled.manifest_status(),
        Some(ManifestStatus::Cancelled)
    );
    assert!(JobPhase::Nesting.manifest_status().is_none());
    assert!(JobPhase::Queued.manifest_status().is_none());

    // Thông báo UI bằng tiếng Việt cho mọi mã ngoài `none`.
    for code in ProgressMessageCode::ALL {
        let text = code.message_vi();
        if code == ProgressMessageCode::None {
            assert!(text.is_empty());
        } else {
            assert!(!text.is_empty(), "thiếu thông báo cho {code:?}");
        }
    }
}

#[test]
fn cancel_token_hop_tac_va_idempotent() {
    let token = CancelToken::new();
    assert!(!token.is_cancelled());

    // Bản clone dùng chung cờ — sidecar hủy, solver thấy ngay.
    let ban_sao = token.clone();
    ban_sao.cancel();
    assert!(token.is_cancelled());

    // Hủy lặp lại vô hại.
    token.cancel();
    ban_sao.cancel();
    assert!(token.is_cancelled());
}

#[test]
fn checkpoint_uu_tien_cancel_roi_deadline_roi_work_budget() {
    use std::sync::Arc;

    // Work-plan cố định: hết ngân sách ⇒ WorkBudgetExhausted.
    let control = RunControl::new(
        StopCriterion::fixed_work_plan(10),
        CancelToken::new(),
        Arc::new(ProgressChannel::new()),
    );
    assert!(control.checkpoint().is_ok());
    control.charge_evaluations(10);
    assert_eq!(control.evaluations(), 10);
    assert_eq!(control.checkpoint(), Err(Interrupt::WorkBudgetExhausted));
    assert_eq!(
        Interrupt::WorkBudgetExhausted.termination_reason(),
        TerminationReason::WorkBudgetExhausted
    );

    // Hủy thắng mọi lý do khác để thông báo cuối không nói sai nguyên nhân.
    let token = CancelToken::new();
    let control = RunControl::new(
        StopCriterion::fixed_work_plan(1),
        token.clone(),
        Arc::new(ProgressChannel::new()),
    );
    control.charge_evaluations(100);
    token.cancel();
    assert_eq!(control.checkpoint(), Err(Interrupt::Cancelled));
    assert_eq!(
        Interrupt::Cancelled.termination_reason(),
        TerminationReason::Cancelled
    );
    assert_eq!(
        Interrupt::Cancelled.message_code(),
        ProgressMessageCode::CancelledByUser
    );

    // Deadline đã qua ⇒ DeadlineReached, best-so-far vẫn được công bố ở phase sau.
    let control = RunControl::new(
        StopCriterion::with_deadline(u64::MAX, 0),
        CancelToken::new(),
        Arc::new(ProgressChannel::new()),
    );
    std::thread::sleep(std::time::Duration::from_millis(2));
    assert_eq!(control.checkpoint(), Err(Interrupt::DeadlineReached));
    assert_eq!(
        Interrupt::DeadlineReached.termination_reason(),
        TerminationReason::Deadline
    );
}

#[test]
fn work_plan_co_dinh_khong_dung_wall_clock() {
    let co_dinh = StopCriterion::fixed_work_plan(1_000);
    assert!(co_dinh.is_deterministic());
    assert!(co_dinh.time_budget_ms.is_none());

    let co_deadline = StopCriterion::with_deadline(1_000, 5_000);
    assert!(!co_deadline.is_deterministic());
    assert_eq!(co_deadline.time_budget_ms, Some(5_000));

    // `timeBudgetMs` vắng mặt trong request ⇒ chạy deterministic.
    let json = REQUEST_TOI_THIEU.replace("\"timeBudgetMs\": 30000,\n  ", "");
    let request = parse_roi_validate(&json).expect("vắng timeBudgetMs vẫn hợp lệ");
    assert!(request.time_budget_ms.is_none());
    let effort = SearchEffort::for_profile(request.profile);
    assert!(effort
        .stop_criterion(request.time_budget_ms)
        .is_deterministic());
    assert!(!effort.stop_criterion(Some(30_000)).is_deterministic());
}

// ─────────────────────────────────────────────────────────────────────────────
//  9. Chưa có solver ở P1
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn p1_chua_co_solver() {
    // P1 chỉ chốt hợp đồng: dựng được request/manifest hợp lệ, nhưng không có API
    // nào nhận request và trả manifest. Test này là chốt phạm vi phase — nếu solver
    // xuất hiện sớm ở P1, hợp đồng chưa được duyệt mà code đã chạy.
    let request = request_hop_le();
    assert!(request.validate().is_ok());
    let manifest: PlacementManifest = serde_json::from_str(MANIFEST_MAU).unwrap();
    assert_eq!(manifest.stats.sheet_count, 2);
    // Không tồn tại đường nối giữa hai đầu này ở P1 — solver là việc của P3/P4.
}

// ─────────────────────────────────────────────────────────────────────────────
//  10. layoutIntent — CHẶNG A LÔ 1 (2026-08-27)
//
//  Nguồn: docs/BAO_CAO_LO_0_NESTING_TU_DO_TEM_CNC_2026-08-27.md §7 (LO0-4, LO0-9).
//
//  Lô này chỉ chốt contract/validator, chưa sửa vòng solver:
//    a. payload cũ thiếu `layoutIntent` + có quantity vẫn là quantity fulfillment;
//    b. quantity fulfillment bắt buộc quantity dương;
//    c. autofill bắt buộc quantity vắng mặt và đúng một tờ;
//    d. representation `0` trong raw core chỉ là absence và không đi ra wire.
// ─────────────────────────────────────────────────────────────────────────────

fn json_autofill_khong_quantity() -> String {
    let mot_to = REQUEST_TOI_THIEU
        .replace("\"maxSheets\": 20", "\"maxSheets\": 1")
        .replace("\"quantity\": 12,", "");
    them_khoa_goc(&mot_to, "\"layoutIntent\": \"autofill_single_sheet\"")
}

#[test]
fn layout_intent_vang_mat_thi_la_quantity_fulfillment() {
    // Payload cũ của công cụ standalone không khai `layoutIntent`. Mặc định phải là ý
    // định CŨ, nếu không thì thêm một trường tuỳ chọn lại lặng lẽ đổi hành vi đã ship.
    let request = request_hop_le();
    assert_eq!(request.layout_intent, LayoutIntent::QuantityFulfillment);
    assert!(request.layout_intent.quantity_la_yeu_cau());
    assert_eq!(
        request.parts[0]
            .requested_quantity()
            .map(|value| value.get()),
        Some(12)
    );
    assert!(request.validate().is_ok());
}

#[test]
fn autofill_round_trip_vang_quantity_tren_day_truyen() {
    let json = json_autofill_khong_quantity();
    let request: MixedNestingRequest =
        serde_json::from_str(&json).expect("payload có layoutIntent phải parse được");
    assert_eq!(request.layout_intent, LayoutIntent::AutofillSingleSheet);
    assert!(!request.layout_intent.quantity_la_yeu_cau());
    assert_eq!(request.parts[0].requested_quantity(), None);
    assert_eq!(request.total_instances(), 0);
    assert!(request.validate().is_ok());

    let lai = serde_json::to_string(&request).unwrap();
    assert!(
        lai.contains("\"layoutIntent\":\"autofill_single_sheet\""),
        "tên trên dây truyền phải là snake_case: {lai}"
    );
    assert!(
        !lai.contains("\"quantity\""),
        "absence nội bộ không được serialize thành quantity giả: {lai}"
    );
}

#[test]
fn quantity_fulfillment_thieu_quantity_bi_tu_choi() {
    let json = REQUEST_TOI_THIEU.replace("\"quantity\": 12,", "");
    let request: MixedNestingRequest =
        serde_json::from_str(&json).expect("field quantity vắng phải parse được vào raw core");
    assert_eq!(request.layout_intent, LayoutIntent::QuantityFulfillment);
    assert_eq!(request.parts[0].requested_quantity(), None);
    let errors = request
        .validate()
        .expect_err("quantity fulfillment phải có quantity dương");
    assert!(
        errors.has(ContractErrorCode::QuantityOutOfRange),
        "phải báo quantity bắt buộc: {errors}"
    );
}

#[test]
fn autofill_co_quantity_bi_tu_choi() {
    let mot_to = REQUEST_TOI_THIEU.replace("\"maxSheets\": 20", "\"maxSheets\": 1");
    let json = them_khoa_goc(&mot_to, "\"layoutIntent\": \"autofill_single_sheet\"");
    let request: MixedNestingRequest =
        serde_json::from_str(&json).expect("quantity dương vẫn parse để validate chéo intent");
    let errors = request
        .validate()
        .expect_err("autofill phải bỏ hẳn quantity");
    assert!(
        errors.has(ContractErrorCode::AutofillQuantityMustBeAbsent),
        "phải báo đúng lỗi quantity không thuộc autofill: {errors}"
    );
    assert_eq!(
        ContractErrorCode::AutofillQuantityMustBeAbsent.as_str(),
        "AUTOFILL_QUANTITY_MUST_BE_ABSENT"
    );
}

#[test]
fn quantity_hien_dien_bang_khong_bi_tu_choi_ngay_tren_wire() {
    let json = REQUEST_TOI_THIEU.replace("\"quantity\": 12", "\"quantity\": 0");
    assert!(
        serde_json::from_str::<MixedNestingRequest>(&json).is_err(),
        "quantity=0 hiện diện không được đánh đồng với field vắng"
    );
}

#[test]
fn autofill_khai_nhieu_hon_mot_to_bi_tu_choi() {
    // Không tự ép maxSheets = 1: request và hành vi phải có cùng một nguồn chân lý.
    let mut request: MixedNestingRequest =
        serde_json::from_str(&json_autofill_khong_quantity()).unwrap();
    request.sheet.max_sheets = 4;
    let errors = request.validate().expect_err("phải bị từ chối");
    assert!(
        errors.has(ContractErrorCode::AutofillRequiresSingleSheet),
        "phải có mã AUTOFILL_REQUIRES_SINGLE_SHEET: {errors}"
    );
}

#[test]
fn autofill_part_qua_nho_vuot_capacity_bound_bi_tu_choi() {
    let mut request: MixedNestingRequest =
        serde_json::from_str(&json_autofill_khong_quantity()).unwrap();
    request.parts[0].outer = hinh_chu_nhat(0.001, 0.001);
    let errors = request
        .validate()
        .expect_err("cận trên số instance phải bị protocol chặn");
    assert!(
        errors.has(ContractErrorCode::AutofillCapacityBoundTooLarge),
        "phải báo đúng protocol bound, không dùng quantity giả: {errors}"
    );
    assert_eq!(
        ContractErrorCode::AutofillCapacityBoundTooLarge.as_str(),
        "AUTOFILL_CAPACITY_BOUND_TOO_LARGE"
    );
}

#[test]
fn sheet_full_serialize_dung_ten_snake_case() {
    // Tên này đi vào manifest và vào log xưởng — đổi là breaking change.
    let json = serde_json::to_string(&TerminationReason::SheetFull).unwrap();
    assert_eq!(json, "\"sheet_full\"");
    let lai: TerminationReason = serde_json::from_str("\"sheet_full\"").unwrap();
    assert_eq!(lai, TerminationReason::SheetFull);
}
