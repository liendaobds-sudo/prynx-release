// ============================================================
// materialLibrary.ts — Mockup 3D Realism (Logic Layer)
//
// Thư viện vật liệu/finish thuần (pure). Cung cấp:
//   - `FINISH_LIBRARY`: bảng tra cứu ≥6 finish theo `FinishId`, mỗi
//     finish kèm tham số PBR (roughness/metalness) trong miền [0,1].
//   - `getFinish`: tra cứu một finish theo id (an toàn, có fallback).
//   - `applyFinishToAllPanels`: helper áp một finish ĐỒNG NHẤT cho
//     toàn bộ panel của hộp (Yêu cầu 4.4).
//
// Bổ sung (task 4.2):
//   - `mapSpotUvRoughness` / `isSpotUvPixelActive`: ánh xạ mask spot-UV
//     theo ngưỡng >50% (Yêu cầu 4.3).
//   - `clampEmbossHeight`: giới hạn độ cao emboss về [0.0, 5.0] mm
//     (Yêu cầu 4.5).
//
// _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_
// ============================================================

import type { FinishId, Panel } from './types';

/**
 * Đặc tả một kiểu gia công bề mặt (finish) cho vật liệu PBR.
 * `roughness` và `metalness` luôn nằm trong [0.0, 1.0] (Yêu cầu 4.2).
 */
export interface FinishSpec {
    /** Mã định danh finish */
    id: FinishId;
    /** Nhãn hiển thị (tiếng Việt) */
    label: string;
    /** Độ nhám bề mặt nền, miền hợp lệ [0.0, 1.0] */
    roughness: number;
    /** Độ kim loại, miền hợp lệ [0.0, 1.0] */
    metalness: number;
    /** Có cần mặt nạ (mask) do người dùng cung cấp hay không (spot-uv, emboss) */
    needsMask: boolean;
}

/**
 * Finish mặc định khi `getFinish` nhận id không hợp lệ.
 * Theo Yêu cầu 1/4, mặc định vật liệu là kraft.
 */
export const DEFAULT_FINISH_ID: FinishId = 'kraft';

/**
 * Thư viện finish — tối thiểu 6 lựa chọn (Yêu cầu 4.1):
 * kraft, SBS trắng, cán mờ, cán bóng, spot-UV, foil/metallic (+ emboss).
 *
 * Giá trị PBR khởi tạo (theo bảng thiết kế), mọi giá trị thuộc [0,1]
 * (Yêu cầu 4.2). Với spot-uv, `roughness` là độ nhám của bề mặt NỀN;
 * việc giảm nhám tại vùng mask (>50%) thuộc task 4.2, không xử lý ở đây.
 */
export const FINISH_LIBRARY: Record<FinishId, FinishSpec> = {
    kraft: {
        id: 'kraft',
        label: 'Giấy kraft',
        roughness: 0.85,
        metalness: 0.0,
        needsMask: false,
    },
    'sbs-white': {
        id: 'sbs-white',
        label: 'Giấy SBS trắng',
        roughness: 0.55,
        metalness: 0.0,
        needsMask: false,
    },
    'matte-lam': {
        id: 'matte-lam',
        label: 'Cán màng mờ',
        roughness: 0.7,
        metalness: 0.0,
        needsMask: false,
    },
    'gloss-lam': {
        id: 'gloss-lam',
        label: 'Cán màng bóng',
        roughness: 0.12,
        metalness: 0.0,
        needsMask: false,
    },
    'spot-uv': {
        id: 'spot-uv',
        label: 'Phủ UV định vị (spot-UV)',
        roughness: 0.7,
        metalness: 0.0,
        needsMask: true,
    },
    'foil-metallic': {
        id: 'foil-metallic',
        label: 'Ép kim / metallic',
        roughness: 0.25,
        metalness: 0.9,
        needsMask: false,
    },
    emboss: {
        id: 'emboss',
        label: 'Dập nổi (emboss)',
        roughness: 0.6,
        metalness: 0.0,
        needsMask: true,
    },
};

/**
 * Tra cứu finish theo id. Nếu `id` không tồn tại trong thư viện
 * (dữ liệu hỏng/ngoài tập hợp lệ), trả về finish mặc định kraft để
 * cảnh vẫn render được.
 *
 * @param id Mã finish cần tra cứu
 * @returns `FinishSpec` tương ứng (hoặc kraft nếu id không hợp lệ)
 * _Requirements: 4.1, 4.2_
 */
export function getFinish(id: FinishId): FinishSpec {
    return FINISH_LIBRARY[id] ?? FINISH_LIBRARY[DEFAULT_FINISH_ID];
}

/**
 * Áp một finish ĐỒNG NHẤT cho toàn bộ panel của hộp (Yêu cầu 4.4).
 *
 * Trả về một mảng `FinishSpec` song song 1-1 với `panels` (cùng độ dài,
 * cùng thứ tự), trong đó MỌI phần tử đều là cùng một finish đã chọn.
 * Đây là hàm thuần: không biến đổi `panels`, không phụ thuộc tên panel.
 *
 * @param panels Danh sách panel của hộp (read-only)
 * @param id Mã finish được chọn
 * @returns Mảng `FinishSpec` cùng độ dài với `panels`, đồng nhất finish
 * _Requirements: 4.4_
 */
export function applyFinishToAllPanels(panels: readonly Panel[], id: FinishId): FinishSpec[] {
    const spec = getFinish(id);
    return panels.map(() => spec);
}

// ------------------------------------------------------------
// Spot-UV: ánh xạ mask theo ngưỡng 50% (Yêu cầu 4.3)
// ------------------------------------------------------------

/**
 * Ngưỡng mask spot-UV. Một điểm ảnh được coi là thuộc vùng phủ UV
 * (vùng "bóng") KHI VÀ CHỈ KHI giá trị mask của nó LỚN HƠN 50%.
 *
 * Giá trị mask được hiểu là một phân số đã chuẩn hóa trong [0, 1]
 * (0 = đen/không phủ, 1 = trắng/phủ hoàn toàn). Ngưỡng 0.5 tương
 * ứng 50% theo Yêu cầu 4.3.
 */
export const SPOT_UV_MASK_THRESHOLD = 0.5;

/**
 * Độ nhám của vùng được phủ UV (vùng "bóng") của finish spot-UV.
 * Theo bảng thiết kế: vùng mask có roughness ≈ 0.08 (bóng cao), trong
 * khi bề mặt nền giữ roughness gốc (≈ 0.7).
 */
export const SPOT_UV_GLOSS_ROUGHNESS = 0.08;

/**
 * Xác định một điểm ảnh mask có kích hoạt hiệu ứng spot-UV hay không.
 *
 * Trả về `true` khi và chỉ khi `maskValue` (phân số đã chuẩn hóa trong
 * [0, 1]) LỚN HƠN ngưỡng 50% (`SPOT_UV_MASK_THRESHOLD`). Giá trị `NaN`
 * được coi là KHÔNG kích hoạt (giữ bề mặt nền) để cảnh vẫn render an toàn.
 *
 * @param maskValue Giá trị mask đã chuẩn hóa, miền [0, 1]
 * @param threshold Ngưỡng kích hoạt (mặc định 0.5 = 50%)
 * @returns `true` nếu điểm ảnh thuộc vùng phủ UV, ngược lại `false`
 * _Requirements: 4.3_
 */
export function isSpotUvPixelActive(
    maskValue: number,
    threshold: number = SPOT_UV_MASK_THRESHOLD,
): boolean {
    if (Number.isNaN(maskValue)) {
        return false;
    }
    return maskValue > threshold;
}

/**
 * Ánh xạ một giá trị mask spot-UV sang độ nhám (roughness) áp dụng.
 *
 * Hàm thuần thực thi Yêu cầu 4.3: tại các điểm ảnh có giá trị mask
 * LỚN HƠN 50%, trả về độ nhám "bóng" (`glossRoughness`); tại mọi điểm
 * còn lại, GIỮ NGUYÊN độ nhám của bề mặt nền (`baseRoughness`).
 *
 * @param maskValue Giá trị mask đã chuẩn hóa, miền [0, 1]
 * @param baseRoughness Độ nhám của bề mặt nền (giữ nguyên ngoài vùng mask)
 * @param glossRoughness Độ nhám vùng phủ UV (mặc định `SPOT_UV_GLOSS_ROUGHNESS`)
 * @returns Độ nhám áp dụng tại điểm ảnh đó
 * _Requirements: 4.3_
 */
export function mapSpotUvRoughness(
    maskValue: number,
    baseRoughness: number,
    glossRoughness: number = SPOT_UV_GLOSS_ROUGHNESS,
): number {
    return isSpotUvPixelActive(maskValue) ? glossRoughness : baseRoughness;
}

// ------------------------------------------------------------
// Emboss: giới hạn độ cao nổi/lõm về [0.0, 5.0] mm (Yêu cầu 4.5)
// ------------------------------------------------------------

/** Cận dưới độ cao emboss (mm). _Requirements: 4.5_ */
export const EMBOSS_MIN_HEIGHT_MM = 0.0;

/** Cận trên độ cao emboss (mm). _Requirements: 4.5_ */
export const EMBOSS_MAX_HEIGHT_MM = 5.0;

/**
 * Giới hạn độ cao nổi/lõm (emboss) về miền hợp lệ [0.0, 5.0] mm.
 *
 * Hàm thuần thực thi Yêu cầu 4.5 (clamp về biên gần nhất):
 * - `< 0.0` → `0.0`
 * - `> 5.0` → `5.0`
 * - `NaN` / `undefined` → `0.0` (không emboss, mặc định an toàn)
 * - ngược lại → giữ nguyên giá trị đầu vào.
 *
 * @param rawHeight Độ cao emboss đầu vào (mm)
 * @returns Độ cao đã giới hạn trong [0.0, 5.0] mm
 * _Requirements: 4.5_
 */
export function clampEmbossHeight(rawHeight: number | undefined): number {
    if (rawHeight === undefined || Number.isNaN(rawHeight) || rawHeight < EMBOSS_MIN_HEIGHT_MM) {
        return EMBOSS_MIN_HEIGHT_MM;
    }
    if (rawHeight > EMBOSS_MAX_HEIGHT_MM) {
        return EMBOSS_MAX_HEIGHT_MM;
    }
    return rawHeight;
}
