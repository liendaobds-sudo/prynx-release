/**
 * Kiểm manifest trước khi preview/export — phase P8.
 *
 * Kế hoạch: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §9.3, §13, §16.4.
 *
 * Vì sao frontend phải kiểm lại khi backend và Rust đã kiểm:
 *
 * - Backend/Rust là **enforcement boundary** cuối; nhưng preview và export đọc trực tiếp
 *   `pose` từ manifest. Nếu manifest tới từ một nguồn khác (bản build cũ, response bị
 *   sửa, file đã lưu từ phiên trước) thì UI sẽ vẽ và xuất theo dữ liệu chưa ai kiểm.
 * - §13 ghi rõ: preview chỉ bật **sau** khi result validation đạt.
 *
 * Validator này KHÔNG "sửa nhẹ" dữ liệu. Nó chỉ trả `ok` hoặc danh sách lỗi. Sửa nhẹ rồi
 * dùng tiếp chính là cách sinh ra bản in khác với bản đã validate.
 */

import {
  FORBIDDEN_LEGACY_FIELDS,
  MIXED_NESTING_PROTOCOL_VERSION,
  TERMINATION_REASONS,
  UNPLACED_REASONS,
  type LayoutIntent,
  type PlacementManifest,
  type PlacementRecord,
  type Pose,
} from './types';

export interface ValidationIssue {
  /** Đường dẫn trường, ví dụ `placements[3].pose.rotationDeg`. */
  path: string;
  code: ValidationIssueCode;
  message: string;
}

export type ValidationIssueCode =
  | 'PROTOCOL_MISMATCH'
  | 'MISSING_FIELD'
  | 'WRONG_TYPE'
  | 'NOT_FINITE'
  | 'OUT_OF_RANGE'
  | 'DUPLICATE_ID'
  | 'FORBIDDEN_FIELD'
  | 'NOT_VALIDATED'
  | 'QUANTITY_MISMATCH'
  | 'LAYOUT_INTENT_MISMATCH'
  | 'STATS_MISMATCH'
  | 'UNKNOWN_ENUM';

export type ValidationResult =
  | { ok: true; manifest: PlacementManifest }
  | { ok: false; issues: ValidationIssue[] };

function issue(path: string, code: ValidationIssueCode, message: string): ValidationIssue {
  return { path, code, message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Tìm trường bị cấm ở mọi độ sâu.
 *
 * Trong **manifest**, `reflection` bị cấm hoàn toàn: manifest không có trường đó trong
 * hợp đồng, nên sự hiện diện của nó nghĩa là dữ liệu tới từ một protocol khác. (Trong
 * *request* thì `reflection: 'forbidden'` là hợp lệ — xem `api.ts::findForbiddenFields`.)
 */
export function findForbiddenManifestFields(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findForbiddenManifestFields(item, `${path}[${index}]`));
  }
  if (!isPlainObject(value)) return [];

  const found: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const here = path ? `${path}.${key}` : key;
    if (FORBIDDEN_LEGACY_FIELDS.includes(key)) {
      found.push(here);
      continue;
    }
    found.push(...findForbiddenManifestFields(child, here));
  }
  return found;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Pose
// ─────────────────────────────────────────────────────────────────────────────

/** Sai số cho phép khi so góc/toạ độ. Chỉ dùng để SO SÁNH, không để làm tròn dữ liệu. */
export const ANGLE_EPSILON_DEG = 1e-9;

export function validatePose(value: unknown, path: string): ValidationIssue[] {
  if (!isPlainObject(value)) {
    return [issue(path, 'WRONG_TYPE', 'pose phải là object.')];
  }
  const issues: ValidationIssue[] = [];
  for (const key of ['rotationDeg', 'translateXmm', 'translateYmm'] as const) {
    const raw = value[key];
    if (raw === undefined) {
      issues.push(issue(`${path}.${key}`, 'MISSING_FIELD', `Thiếu ${key}.`));
      continue;
    }
    if (typeof raw !== 'number') {
      issues.push(issue(`${path}.${key}`, 'WRONG_TYPE', `${key} phải là số.`));
      continue;
    }
    if (!Number.isFinite(raw)) {
      issues.push(
        issue(`${path}.${key}`, 'NOT_FINITE', `${key} phải hữu hạn (không NaN/Infinity).`),
      );
    }
  }
  if (issues.length > 0) return issues;

  const rotation = value.rotationDeg as number;
  // Canonical `[0, 360)`. Chấp nhận đúng biên dưới, KHÔNG chấp nhận 360.
  if (rotation < -ANGLE_EPSILON_DEG || rotation >= 360) {
    issues.push(
      issue(
        `${path}.rotationDeg`,
        'OUT_OF_RANGE',
        `rotationDeg phải canonical trong [0°, 360°), nhận ${rotation}.`,
      ),
    );
  }
  return issues;
}

/**
 * Góc có thuộc tập/miền đã khai? Dùng cho kiểm per-part ở tầng cao hơn.
 *
 * Cố ý nhận **danh sách góc** thay vì "bước góc": không có API nào trong module này chấp
 * nhận angle step, vì angle step không tồn tại trong hợp đồng.
 */
export function angleMatchesAny(
  angleDeg: number,
  allowedDeg: readonly number[],
  toleranceDeg = 1e-6,
): boolean {
  return allowedDeg.some((allowed) => {
    const delta = ((angleDeg - allowed + 180) % 360 + 360) % 360 - 180;
    return Math.abs(delta) <= toleranceDeg;
  });
}

export function angleInArc(
  angleDeg: number,
  arc: { startDeg: number; sweepDeg: number },
  toleranceDeg = 1e-6,
): boolean {
  const offset = ((angleDeg - arc.startDeg) % 360 + 360) % 360;
  return offset <= arc.sweepDeg + toleranceDeg;
}

/** Góc có phải một trong bốn góc cardinal? Dùng để BÁO CÁO, không để ràng buộc. */
export function isCardinalAngle(angleDeg: number, toleranceDeg = 1e-6): boolean {
  return angleMatchesAny(angleDeg, [0, 90, 180, 270], toleranceDeg);
}

/** Toạ độ có phần lẻ mm? Bằng chứng continuous X/Y trong report và test. */
export function hasFractionalTranslation(pose: Pose, epsilon = 1e-9): boolean {
  return (
    Math.abs(pose.translateXmm - Math.round(pose.translateXmm)) > epsilon
    || Math.abs(pose.translateYmm - Math.round(pose.translateYmm)) > epsilon
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Manifest
// ─────────────────────────────────────────────────────────────────────────────

interface ValidateManifestOptionsBase {
  /**
   * Số lượng mong đợi theo `partId` (từ request đã gửi). Có thì validator kiểm **bảo toàn
   * số lượng**; không có thì bỏ qua phần đó, vì frontend không được tự bịa kỳ vọng.
   */
  /** Cho phép manifest ở trạng thái `cancelled`/`failed` đi qua (chỉ để xem, không export). */
  allowNonCompleted?: boolean;
}

export type ValidateManifestOptions =
  | (ValidateManifestOptionsBase & {
      layoutIntent?: undefined;
      expectedQuantities?: never;
      expectedPartIds?: never;
    })
  | (ValidateManifestOptionsBase & {
      layoutIntent: Extract<LayoutIntent, 'quantity_fulfillment'>;
      expectedQuantities: Readonly<Record<string, number>>;
      expectedPartIds?: never;
    })
  | (ValidateManifestOptionsBase & {
      layoutIntent: Extract<LayoutIntent, 'autofill_single_sheet'>;
      expectedPartIds: readonly string[];
      expectedQuantities?: never;
    });

function validatePlacement(
  raw: unknown,
  index: number,
  seenIds: Set<string>,
): ValidationIssue[] {
  const path = `placements[${index}]`;
  if (!isPlainObject(raw)) {
    return [issue(path, 'WRONG_TYPE', 'placement phải là object.')];
  }
  const issues: ValidationIssue[] = [];

  if (typeof raw.instanceId !== 'string' || raw.instanceId.length === 0) {
    issues.push(issue(`${path}.instanceId`, 'WRONG_TYPE', 'instanceId phải là chuỗi.'));
  } else if (seenIds.has(raw.instanceId)) {
    issues.push(
      issue(`${path}.instanceId`, 'DUPLICATE_ID', `instanceId trùng: ${raw.instanceId}.`),
    );
  } else {
    seenIds.add(raw.instanceId);
  }

  if (typeof raw.partId !== 'string' || raw.partId.length === 0) {
    issues.push(issue(`${path}.partId`, 'WRONG_TYPE', 'partId phải là chuỗi.'));
  }
  if (!Number.isInteger(raw.sheetIndex) || (raw.sheetIndex as number) < 0) {
    issues.push(
      issue(`${path}.sheetIndex`, 'OUT_OF_RANGE', 'sheetIndex phải là số nguyên >= 0.'),
    );
  }
  if (raw.sourceRevision !== undefined && typeof raw.sourceRevision !== 'string') {
    issues.push(
      issue(`${path}.sourceRevision`, 'WRONG_TYPE', 'sourceRevision phải là chuỗi nếu có.'),
    );
  }
  issues.push(...validatePose(raw.pose, `${path}.pose`));
  return issues;
}

/**
 * Kiểm toàn bộ manifest. Trả `ok: true` kèm manifest đã **hẹp kiểu** để nơi gọi dùng
 * trực tiếp mà không cast.
 */
export function validateManifest(
  raw: unknown,
  options: ValidateManifestOptions = {},
): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!isPlainObject(raw)) {
    return { ok: false, issues: [issue('', 'WRONG_TYPE', 'Manifest phải là object JSON.')] };
  }

  // ── Trường bị cấm: kiểm TRƯỚC mọi thứ khác ──
  // Một manifest mang `matrix`/`translationStepMm` không phải "manifest thiếu sót" mà là
  // manifest của protocol khác. Đọc pose từ nó là dùng sai nguồn chân lý.
  for (const path of findForbiddenManifestFields(raw)) {
    issues.push(
      issue(path, 'FORBIDDEN_FIELD', `Trường ${path} không thuộc hợp đồng manifest v1.`),
    );
  }

  if (raw.protocolVersion !== MIXED_NESTING_PROTOCOL_VERSION) {
    issues.push(
      issue(
        'protocolVersion',
        'PROTOCOL_MISMATCH',
        `Cần protocolVersion ${MIXED_NESTING_PROTOCOL_VERSION}, nhận ${String(raw.protocolVersion)}.`,
      ),
    );
  }
  for (const key of ['engineVersion', 'jobId'] as const) {
    if (typeof raw[key] !== 'string' || (raw[key] as string).length === 0) {
      issues.push(issue(key, 'WRONG_TYPE', `${key} phải là chuỗi không rỗng.`));
    }
  }
  if (!isFiniteNumber(raw.seed)) {
    issues.push(issue('seed', 'WRONG_TYPE', 'seed phải là số hữu hạn.'));
  }

  const status = raw.status;
  if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') {
    issues.push(issue('status', 'UNKNOWN_ENUM', `status lạ: ${String(status)}.`));
  } else if (status !== 'completed' && !options.allowNonCompleted) {
    issues.push(
      issue('status', 'NOT_VALIDATED', `Manifest ở trạng thái '${status}', không dùng để xuất.`),
    );
  }

  // ── Validator của engine là điều kiện tiên quyết ──
  if (!isPlainObject(raw.validation)) {
    issues.push(issue('validation', 'MISSING_FIELD', 'Thiếu khối validation.'));
  } else {
    if (raw.validation.valid !== true) {
      issues.push(
        issue('validation.valid', 'NOT_VALIDATED', 'Kết quả chưa qua validator của engine.'),
      );
    }
    if (!Number.isInteger(raw.validation.validatorVersion)) {
      issues.push(
        issue('validation.validatorVersion', 'WRONG_TYPE', 'validatorVersion phải là số nguyên.'),
      );
    }
  }

  // ── Placements ──
  const seenIds = new Set<string>();
  if (!Array.isArray(raw.placements)) {
    issues.push(issue('placements', 'WRONG_TYPE', 'placements phải là mảng.'));
  } else {
    raw.placements.forEach((item, index) => {
      issues.push(...validatePlacement(item, index, seenIds));
    });
  }

  // ── Unplaced ──
  if (!Array.isArray(raw.unplaced)) {
    issues.push(issue('unplaced', 'WRONG_TYPE', 'unplaced phải là mảng.'));
  } else {
    raw.unplaced.forEach((item, index) => {
      const path = `unplaced[${index}]`;
      if (!isPlainObject(item)) {
        issues.push(issue(path, 'WRONG_TYPE', 'unplaced item phải là object.'));
        return;
      }
      if (typeof item.instanceId !== 'string' || item.instanceId.length === 0) {
        issues.push(issue(`${path}.instanceId`, 'WRONG_TYPE', 'instanceId phải là chuỗi.'));
      } else if (seenIds.has(item.instanceId)) {
        issues.push(
          issue(
            `${path}.instanceId`,
            'DUPLICATE_ID',
            `instanceId ${item.instanceId} xuất hiện ở cả placements và unplaced.`,
          ),
        );
      } else {
        seenIds.add(item.instanceId);
      }
      if (typeof item.partId !== 'string' || item.partId.length === 0) {
        issues.push(issue(`${path}.partId`, 'WRONG_TYPE', 'partId phải là chuỗi.'));
      }
      if (!UNPLACED_REASONS.includes(item.reason as never)) {
        issues.push(issue(`${path}.reason`, 'UNKNOWN_ENUM', `reason lạ: ${String(item.reason)}.`));
      }
    });
  }

  // ── Stats ──
  if (!isPlainObject(raw.stats)) {
    issues.push(issue('stats', 'MISSING_FIELD', 'Thiếu khối stats.'));
  } else {
    const stats = raw.stats;
    for (const key of [
      'sheetCount',
      'placedCount',
      'unplacedCount',
      'elapsedMs',
      'attempts',
      'orientationEvaluations',
      'poseRefinements',
    ] as const) {
      if (!Number.isInteger(stats[key]) || (stats[key] as number) < 0) {
        issues.push(issue(`stats.${key}`, 'OUT_OF_RANGE', `stats.${key} phải là số nguyên >= 0.`));
      }
    }
    if (!isFiniteNumber(stats.materialUtilization) || stats.materialUtilization < 0) {
      issues.push(
        issue('stats.materialUtilization', 'OUT_OF_RANGE', 'materialUtilization phải >= 0.'),
      );
    }
    if (!TERMINATION_REASONS.includes(stats.terminationReason as never)) {
      issues.push(
        issue(
          'stats.terminationReason',
          'UNKNOWN_ENUM',
          `terminationReason lạ: ${String(stats.terminationReason)}.`,
        ),
      );
    }
    // Stats phải khớp placements thật — solver tự báo số không được tin.
    if (Array.isArray(raw.placements) && Number.isInteger(stats.placedCount)) {
      if (stats.placedCount !== raw.placements.length) {
        issues.push(
          issue(
            'stats.placedCount',
            'STATS_MISMATCH',
            `placedCount ${stats.placedCount} khác số placement thật ${raw.placements.length}.`,
          ),
        );
      }
    }
    if (Array.isArray(raw.unplaced) && Number.isInteger(stats.unplacedCount)) {
      if (stats.unplacedCount !== raw.unplaced.length) {
        issues.push(
          issue(
            'stats.unplacedCount',
            'STATS_MISMATCH',
            `unplacedCount ${stats.unplacedCount} khác số unplaced thật ${raw.unplaced.length}.`,
          ),
        );
      }
    }
    // sheetIndex phải nằm trong số tờ đã báo.
    if (Array.isArray(raw.placements) && Number.isInteger(stats.sheetCount)) {
      const maxIndex = (stats.sheetCount as number) - 1;
      raw.placements.forEach((item, index) => {
        if (!isPlainObject(item)) return;
        if (Number.isInteger(item.sheetIndex) && (item.sheetIndex as number) > maxIndex) {
          issues.push(
            issue(
              `placements[${index}].sheetIndex`,
              'STATS_MISMATCH',
              `sheetIndex ${item.sheetIndex} vượt sheetCount ${stats.sheetCount}.`,
            ),
          );
        }
      });
    }
  }

  // ── Bất biến theo layoutIntent của REQUEST ──
  // Không suy intent từ quantity, terminationReason hay hình dạng manifest.
  if (
    options.layoutIntent === 'quantity_fulfillment'
    && Array.isArray(raw.placements)
    && Array.isArray(raw.unplaced)
  ) {
    const actual = new Map<string, number>();
    for (const list of [raw.placements, raw.unplaced]) {
      for (const item of list) {
        if (!isPlainObject(item) || typeof item.partId !== 'string') continue;
        actual.set(item.partId, (actual.get(item.partId) ?? 0) + 1);
      }
    }
    for (const [partId, expected] of Object.entries(options.expectedQuantities)) {
      const got = actual.get(partId) ?? 0;
      if (got !== expected) {
        issues.push(
          issue(
            `quantity.${partId}`,
            'QUANTITY_MISMATCH',
            `Chi tiết ${partId}: yêu cầu ${expected} con, manifest có ${got}.`,
          ),
        );
      }
    }
    for (const partId of actual.keys()) {
      if (!(partId in options.expectedQuantities)) {
        issues.push(
          issue(
            `quantity.${partId}`,
            'QUANTITY_MISMATCH',
            `Manifest có chi tiết ${partId} không thuộc yêu cầu.`,
          ),
        );
      }
    }
  } else if (
    options.layoutIntent === 'autofill_single_sheet'
    && Array.isArray(raw.placements)
    && Array.isArray(raw.unplaced)
  ) {
    if (raw.unplaced.length !== 0) {
      issues.push(
        issue(
          'unplaced',
          'LAYOUT_INTENT_MISMATCH',
          'Kết quả tự lấp đầy một tờ không được có danh sách unplaced.',
        ),
      );
    }
    if (isPlainObject(raw.stats) && raw.stats.sheetCount !== 1) {
      issues.push(
        issue(
          'stats.sheetCount',
          'LAYOUT_INTENT_MISMATCH',
          `Tự lấp đầy phải trả đúng một tờ, nhận ${String(raw.stats.sheetCount)}.`,
        ),
      );
    }
    const expected = new Set(options.expectedPartIds);
    const placed = new Set<string>();
    for (const item of raw.placements) {
      if (!isPlainObject(item) || typeof item.partId !== 'string') continue;
      placed.add(item.partId);
      if (!expected.has(item.partId)) {
        issues.push(
          issue(
            `parts.${item.partId}`,
            'LAYOUT_INTENT_MISMATCH',
            `Manifest có chi tiết ${item.partId} không thuộc yêu cầu autofill.`,
          ),
        );
      }
    }
    for (const partId of expected) {
      if (!placed.has(partId)) {
        issues.push(
          issue(
            `parts.${partId}`,
            'LAYOUT_INTENT_MISMATCH',
            `Autofill chưa xếp được ít nhất một con của chi tiết ${partId}.`,
          ),
        );
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, manifest: raw as unknown as PlacementManifest };
}

/** Có thể preview/export chưa? Chỉ khi validator đạt và trạng thái là `completed`. */
export function canPreview(raw: unknown): boolean {
  return validateManifest(raw).ok;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Số đo dùng cho UI và report
// ─────────────────────────────────────────────────────────────────────────────

export interface PoseMetrics {
  nonCardinalAngleCount: number;
  fractionalTranslationCount: number;
  distinctAngles: number;
}

export function collectPoseMetrics(placements: readonly PlacementRecord[]): PoseMetrics {
  const angles = new Set<number>();
  let nonCardinal = 0;
  let fractional = 0;
  for (const placement of placements) {
    angles.add(placement.pose.rotationDeg);
    if (!isCardinalAngle(placement.pose.rotationDeg)) nonCardinal += 1;
    if (hasFractionalTranslation(placement.pose)) fractional += 1;
  }
  return {
    nonCardinalAngleCount: nonCardinal,
    fractionalTranslationCount: fractional,
    distinctAngles: angles.size,
  };
}

/** Gom placement theo tờ, giữ nguyên thứ tự trong manifest. */
export function groupBySheet(
  placements: readonly PlacementRecord[],
): Map<number, PlacementRecord[]> {
  const bySheet = new Map<number, PlacementRecord[]>();
  for (const placement of placements) {
    const list = bySheet.get(placement.sheetIndex);
    if (list) list.push(placement);
    else bySheet.set(placement.sheetIndex, [placement]);
  }
  return bySheet;
}
