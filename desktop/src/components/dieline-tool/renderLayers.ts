import * as THREE from 'three';

/**
 * Layer chỉ dành cho chi tiết hỗ trợ hiển thị (sàn, lưới, đường CAD).
 * Camera chính thấy layer này; camera tạo ContactShadows chỉ thấy layer mặc định 0.
 */
export const MOCKUP_VISUAL_ONLY_LAYER = 31;

/** Gắn cả cây hiển thị vào layer không tham gia lượt chụp bóng. */
export function moveToMockupVisualOnlyLayer(root: THREE.Object3D | null): void {
    root?.traverse((object) => object.layers.set(MOCKUP_VISUAL_ONLY_LAYER));
}