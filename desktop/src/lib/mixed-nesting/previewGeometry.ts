/**
 * Hình học xem trước "Bình lồng ghép tự do" — phase P11.
 *
 * Kế hoạch: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §9.1, §13.
 *
 * §13 nói rõ: preview và export đọc **cùng một** placement manifest và áp **cùng một**
 * phép biến đổi. Module này là nơi duy nhất của frontend làm phép đó:
 *
 * ```text
 * p_sheet = R(rotationDeg) × (p_source_local − referencePoint) + (translateXmm, translateYmm)
 * ```
 *
 * Bốn điều bị cấm, và mỗi điều có test:
 *
 * 1. **Không làm tròn, không snap.** Không có `toFixed`, `Math.round`, không có tham số
 *    lưới nào trong toàn bộ file.
 * 2. **Không recompact.** Module chỉ *áp* pose, không tìm vị trí mới. Không có hàm nào
 *    nhận danh sách vật cản.
 * 3. **Không mirror.** Ma trận luôn là `[cos, sin, −sin, cos]` với `det = +1`; không có
 *    tham số lật. `poseMatrix` được xuất ra để test kiểm định thức.
 * 4. **Đổi hệ Y chỉ ở adapter render.** Toạ độ mm giữ trục Y hướng lên (gốc góc trái
 *    dưới tờ); việc lật cho SVG/Canvas nằm trong `toSvgPoints`/`sheetViewBox` và
 *    **không bao giờ** ghi ngược vào dữ liệu.
 *
 * ## Pivot lấy ở đâu
 *
 * Manifest không mang `referencePointMm` (§9.3), và protocol công khai không cho client
 * gửi nó lên — nó là **server-owned**. Nhưng nó là **hàm thuần của contour nguồn** mà
 * frontend đang giữ: trọng tâm diện tích, quy tắc `REFERENCE_POINT_RULE_VERSION`. Vì vậy
 * ở đây ta tính lại đúng công thức đó, KHÔNG phải đoán một pivot khác.
 *
 * Chống trôi: `previewGeometry.test.ts` đọc trực tiếp
 * `imposition_core/src/mixed_nesting/normalize.rs` và đòi hai hằng version khớp. Rust ghi
 * "Đổi quy tắc là đổi hợp đồng" nên mọi thay đổi quy tắc phải tăng version — và khi đó
 * test frontend đỏ ngay.
 *
 * Lưu ý đã biết: chuẩn hoá phía Rust có loại đỉnh thẳng hàng **trong tolerance**, nên
 * trọng tâm của contour thô và của contour đã chuẩn hoá có thể lệch dưới mức tolerance.
 * Sai lệch đó nhỏ hơn một phần nghìn milimét nên không nhìn thấy trên preview; bản xuất
 * PDF vẫn do backend dựng từ contour đã chuẩn hoá của chính nó.
 */

import type {
  PlacementRecord,
  PointMm,
  RingMm,
  SheetSpec,
} from './types';

/** Version quy tắc chuẩn hoá contour phía Rust (`normalize.rs`). */
export const NORMALIZE_RULE_VERSION = 1;

/** Version quy tắc suy ra pivot phía Rust (`normalize.rs`). */
export const REFERENCE_POINT_RULE_VERSION = 1;

// ─────────────────────────────────────────────────────────────────────────────
//  Hình học cơ bản
// ─────────────────────────────────────────────────────────────────────────────

/** Diện tích **có dấu** của vòng (shoelace). Dấu cho biết chiều vòng. */
export function signedRingAreaMm2(ring: RingMm): number {
  let total = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    total += current[0] * next[1] - next[0] * current[1];
  }
  return total / 2;
}

export function ringAreaMm2(ring: RingMm): number {
  return Math.abs(signedRingAreaMm2(ring));
}

/**
 * Trọng tâm diện tích của vòng — **pivot canonical** của pose.
 *
 * Bản mirror của `normalize::derive_reference_point`. Bất biến với đỉnh bắt đầu và với
 * chiều vòng: cả tử và mẫu cùng đổi dấu.
 *
 * Cố ý KHÔNG dùng góc bbox: §9.1 cấm lấy góc trái bbox sau khi xoay làm pivot, vì pivot
 * đó thay đổi theo góc và làm pose mất nghĩa.
 */
export function deriveReferencePoint(ring: RingMm): PointMm | null {
  if (ring.length < 3) return null;
  let doubleArea = 0;
  let sumX = 0;
  let sumY = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    const cross = current[0] * next[1] - next[0] * current[1];
    doubleArea += cross;
    sumX += (current[0] + next[0]) * cross;
    sumY += (current[1] + next[1]) * cross;
  }
  if (Math.abs(doubleArea) < Number.MIN_VALUE) return null;
  const point: PointMm = [sumX / (3 * doubleArea), sumY / (3 * doubleArea)];
  if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) return null;
  return point;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Pose
// ─────────────────────────────────────────────────────────────────────────────

/** Ma trận rigid 2×3 theo thứ tự `[a, b, c, d, e, f]` như SVG `matrix()`. */
export interface RigidMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/**
 * Dựng ma trận từ pose và pivot. **Chỉ xoay và tịnh tiến** — không tỷ lệ, không lật.
 *
 * `det = a·d − b·c = cos² + sin² = 1` với mọi góc. Test kiểm điều này để không ai chèn
 * được một hệ số âm vào đây.
 */
export function poseMatrix(
  rotationDeg: number,
  translateXmm: number,
  translateYmm: number,
  referencePoint: PointMm,
): RigidMatrix {
  const radians = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    a: cos,
    b: sin,
    c: -sin,
    d: cos,
    // Bù pivot: dịch sao cho điểm tham chiếu về gốc trước khi xoay.
    e: translateXmm - (cos * referencePoint[0] - sin * referencePoint[1]),
    f: translateYmm - (sin * referencePoint[0] + cos * referencePoint[1]),
  };
}

export function applyMatrix(matrix: RigidMatrix, point: PointMm): PointMm {
  return [
    matrix.a * point[0] + matrix.c * point[1] + matrix.e,
    matrix.b * point[0] + matrix.d * point[1] + matrix.f,
  ];
}

/** Định thức. Phải luôn `+1` cho pose hợp lệ; `≤0` nghĩa là đã có mirror. */
export function matrixDeterminant(matrix: RigidMatrix): number {
  return matrix.a * matrix.d - matrix.b * matrix.c;
}

/**
 * Áp pose cho một vòng, trả toạ độ **mm trên tờ** (trục Y hướng lên).
 *
 * Đọc `pose` nguyên giá trị số thực từ manifest. Không làm tròn ở bất kỳ bước nào.
 */
export function transformRing(
  ring: RingMm,
  rotationDeg: number,
  translateXmm: number,
  translateYmm: number,
  referencePoint: PointMm,
): RingMm {
  const matrix = poseMatrix(rotationDeg, translateXmm, translateYmm, referencePoint);
  return ring.map((point) => applyMatrix(matrix, point));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Từ manifest sang hình vẽ
// ─────────────────────────────────────────────────────────────────────────────

/** Contour nguồn của một loại chi tiết, do frontend giữ (đúng thứ đã gửi lên). */
export interface PartSource {
  partId: string;
  outer: RingMm;
  holes: RingMm[];
}

/** Một chi tiết đã được đặt, đã ở toạ độ mm trên tờ. */
export interface PlacedShape {
  instanceId: string;
  partId: string;
  sheetIndex: number;
  outer: RingMm;
  holes: RingMm[];
  /** Pose gốc, giữ nguyên để UI hiện đúng chữ số và để export đối chiếu. */
  rotationDeg: number;
  translateXmm: number;
  translateYmm: number;
}

export interface BoundsMm {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function ringBounds(ring: RingMm): BoundsMm | null {
  if (ring.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Dựng hình vẽ cho một placement.
 *
 * `null` khi không tìm được contour nguồn của `partId` — trường hợp đó là dữ liệu lệch,
 * và **bỏ vẽ** đúng hơn là vẽ một hình đoán.
 */
export function placedShapeOf(
  placement: PlacementRecord,
  sources: ReadonlyMap<string, PartSource>,
): PlacedShape | null {
  const source = sources.get(placement.partId);
  if (!source) return null;
  const referencePoint = deriveReferencePoint(source.outer);
  if (!referencePoint) return null;

  const { rotationDeg, translateXmm, translateYmm } = placement.pose;
  return {
    instanceId: placement.instanceId,
    partId: placement.partId,
    sheetIndex: placement.sheetIndex,
    outer: transformRing(source.outer, rotationDeg, translateXmm, translateYmm, referencePoint),
    holes: source.holes.map((hole) =>
      transformRing(hole, rotationDeg, translateXmm, translateYmm, referencePoint),
    ),
    rotationDeg,
    translateXmm,
    translateYmm,
  };
}

export function partSourceMap(sources: readonly PartSource[]): Map<string, PartSource> {
  return new Map(sources.map((source) => [source.partId, source]));
}

/** Gom hình vẽ theo tờ. Giữ nguyên thứ tự manifest trong từng tờ. */
export function shapesBySheet(
  placements: readonly PlacementRecord[],
  sources: readonly PartSource[],
): Map<number, PlacedShape[]> {
  const map = partSourceMap(sources);
  const bySheet = new Map<number, PlacedShape[]>();
  for (const placement of placements) {
    const shape = placedShapeOf(placement, map);
    if (!shape) continue;
    const list = bySheet.get(shape.sheetIndex);
    if (list) list.push(shape);
    else bySheet.set(shape.sheetIndex, [shape]);
  }
  return bySheet;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Adapter render — CHỖ DUY NHẤT đổi hệ Y
// ─────────────────────────────────────────────────────────────────────────────

/** Vùng dùng được sau khi trừ lề, toạ độ mm (Y hướng lên). */
export function usableRectMm(sheet: SheetSpec): BoundsMm {
  return {
    minX: sheet.marginMm.left,
    minY: sheet.marginMm.bottom,
    maxX: sheet.widthMm - sheet.marginMm.right,
    maxY: sheet.heightMm - sheet.marginMm.top,
  };
}

/**
 * `viewBox` của SVG cho một tờ, đơn vị mm.
 *
 * Gốc SVG ở góc **trái trên** và Y hướng **xuống**; gốc tờ ở góc **trái dưới** và Y
 * hướng **lên**. Chênh lệch đó được xử lý ở đây và ở [`flipY`], không ở nơi khác.
 */
export function sheetViewBox(sheet: SheetSpec): string {
  return `0 0 ${sheet.widthMm} ${sheet.heightMm}`;
}

/** Đổi Y từ hệ tờ sang hệ SVG. Phép đối xứng: gọi hai lần trả về giá trị gốc. */
export function flipY(sheet: SheetSpec, yMm: number): number {
  return sheet.heightMm - yMm;
}

/** Chuỗi `points` cho `<polygon>`, đã đổi hệ Y. Không làm tròn. */
export function toSvgPoints(ring: RingMm, sheet: SheetSpec): string {
  return ring.map(([x, y]) => `${x},${flipY(sheet, y)}`).join(' ');
}

/**
 * Đường `d` cho `<path>` gồm contour ngoài và các lỗ.
 *
 * Lỗ dùng cùng chiều với contour ngoài rồi để `fill-rule="evenodd"` khoét — cách này
 * không phụ thuộc chiều vòng, nên không cần đảo chiều dữ liệu.
 */
export function toSvgPath(shape: PlacedShape, sheet: SheetSpec): string {
  const ringPath = (ring: RingMm) =>
    ring.length === 0
      ? ''
      : `M ${ring.map(([x, y]) => `${x} ${flipY(sheet, y)}`).join(' L ')} Z`;
  return [ringPath(shape.outer), ...shape.holes.map(ringPath)].filter(Boolean).join(' ');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Kiểm tra hiển thị
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hình có nằm trong vùng dùng được không (dùng cho cảnh báo hiển thị).
 *
 * Đây **không** phải validator. Validator độc lập chạy ở Rust và đã kết luận trước khi
 * manifest được công bố. Hàm này chỉ để UI tô đỏ nếu có gì bất thường — nếu nó bắt được
 * lỗi thì nghĩa là dữ liệu không phải manifest đã validate.
 */
export function isInsideUsable(shape: PlacedShape, sheet: SheetSpec, toleranceMm = 1e-6): boolean {
  const usable = usableRectMm(sheet);
  const bounds = ringBounds(shape.outer);
  if (!bounds) return false;
  return (
    bounds.minX >= usable.minX - toleranceMm
    && bounds.minY >= usable.minY - toleranceMm
    && bounds.maxX <= usable.maxX + toleranceMm
    && bounds.maxY <= usable.maxY + toleranceMm
  );
}

/** Diện tích đã dùng trên một tờ, mm² — dùng cho phần tóm tắt. */
export function usedAreaMm2(shapes: readonly PlacedShape[]): number {
  return shapes.reduce(
    (sum, shape) =>
      sum
      + ringAreaMm2(shape.outer)
      - shape.holes.reduce((holeSum, hole) => holeSum + ringAreaMm2(hole), 0),
    0,
  );
}

/**
 * Bao của phần đã dùng trên tờ cuối — tiêu chí 3 của điểm chuẩn §11.5.
 *
 * Hiển thị để thợ in biết phần vật liệu dư còn liền khối hay bị chia vụn.
 */
export function usedBoundsOf(shapes: readonly PlacedShape[]): BoundsMm | null {
  let result: BoundsMm | null = null;
  for (const shape of shapes) {
    const bounds = ringBounds(shape.outer);
    if (!bounds) continue;
    result = result
      ? {
          minX: Math.min(result.minX, bounds.minX),
          minY: Math.min(result.minY, bounds.minY),
          maxX: Math.max(result.maxX, bounds.maxX),
          maxY: Math.max(result.maxY, bounds.maxY),
        }
      : bounds;
  }
  return result;
}
