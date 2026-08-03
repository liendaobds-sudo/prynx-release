/** Mô tả một preset nền/sàn cho cảnh mockup 3D. */
export interface BackgroundPreset {
    id: string;
    label: string;
    backgroundColor: string;
    backgroundGradient?: { inner: string; outer: string };
    floorColor: string;
    floorRoughness: number;
    floorMetalness: number;
    floorShadowOnly?: boolean;
    shadowColor: string;
    shadowOpacity: number;
    shadowBlur: number;
}

// BUILD (audit 2026-08-03 §REL.05): dữ liệu preset nằm ngoài component để giữ
// Fast Refresh ổn định và cho bảng điều khiển dùng chung một nguồn chân lý.
export const BACKGROUND_PRESETS: readonly BackgroundPreset[] = [
    {
        id: 'studio-white', label: 'Studio Trắng', backgroundColor: '#f3f4f6',
        floorColor: '#ffffff', floorRoughness: 0.85, floorMetalness: 0.0,
        shadowColor: '#000000', shadowOpacity: 0.42, shadowBlur: 2.6,
    },
    {
        id: 'studio-dark', label: 'Studio Tối', backgroundColor: '#0a0a0a',
        floorColor: '#15161a', floorRoughness: 0.6, floorMetalness: 0.1,
        shadowColor: '#000000', shadowOpacity: 0.6, shadowBlur: 2.0,
    },
    {
        id: 'neutral-gray', label: 'Xám Trung Tính', backgroundColor: '#9ca3af',
        floorColor: '#d1d5db', floorRoughness: 0.9, floorMetalness: 0.0,
        shadowColor: '#1f2937', shadowOpacity: 0.45, shadowBlur: 2.8,
    },
    {
        id: 'warm-gradient', label: 'Nền Ấm', backgroundColor: '#e8d5c0',
        floorColor: '#f0e6d8', floorRoughness: 0.88, floorMetalness: 0.0,
        shadowColor: '#4b3621', shadowOpacity: 0.4, shadowBlur: 3.0,
    },
    {
        id: 'product-black', label: 'Product tối', backgroundColor: '#0a0a0a',
        backgroundGradient: { inner: '#1a1c22', outer: '#050506' },
        floorColor: '#0e0f12', floorRoughness: 0.75, floorMetalness: 0.08,
        floorShadowOnly: true,
        shadowColor: '#000000', shadowOpacity: 0.55, shadowBlur: 2.4,
    },
    {
        id: 'soft-gray-stage', label: 'Studio xám mềm', backgroundColor: '#eceded',
        backgroundGradient: { inner: '#f7f8f9', outer: '#cfd3d8' },
        floorColor: '#e6e8eb', floorRoughness: 0.9, floorMetalness: 0.0,
        shadowColor: '#1a1a1a', shadowOpacity: 0.28, shadowBlur: 3.2,
    },
    {
        id: 'cool-infinite', label: 'Infinite cool', backgroundColor: '#c5d0dc',
        backgroundGradient: { inner: '#eaf0f7', outer: '#8fa3b8' },
        floorColor: '#d0dae6', floorRoughness: 0.88, floorMetalness: 0.0,
        shadowColor: '#243040', shadowOpacity: 0.35, shadowBlur: 2.8,
    },
    {
        id: 'warm-product', label: 'Warm product', backgroundColor: '#e8d5c0',
        backgroundGradient: { inner: '#f6ebe0', outer: '#c4a88a' },
        floorColor: '#efe0d0', floorRoughness: 0.86, floorMetalness: 0.0,
        shadowColor: '#4b3621', shadowOpacity: 0.38, shadowBlur: 3.0,
    },
    {
        id: 'cyclorama-white', label: 'Cyclorama trắng', backgroundColor: '#f5f5f5',
        backgroundGradient: { inner: '#ffffff', outer: '#e2e4e8' },
        floorColor: '#fafafa', floorRoughness: 0.92, floorMetalness: 0.0,
        floorShadowOnly: true,
        shadowColor: '#000000', shadowOpacity: 0.22, shadowBlur: 3.5,
    },
] as const;

export const DEFAULT_BACKGROUND_PRESET_ID = BACKGROUND_PRESETS[0].id;

export function getBackgroundPreset(id: string | undefined | null): BackgroundPreset {
    return BACKGROUND_PRESETS.find((preset) => preset.id === id) ?? BACKGROUND_PRESETS[0];
}
