import * as THREE from 'three';
import type { CameraPreset } from '../../stores/useMockupStore';

export const BASE_FOV_DEG = 45;
const ORTHO_FOV_DEG = 12;

const deg2rad = (degrees: number) => (degrees * Math.PI) / 180;

/** Easing chuyển cảnh êm ở đầu và cuối. */
export function easeInOutCubic(t: number): number {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

const ORTHO_DISTANCE_SCALE =
    Math.tan(deg2rad(BASE_FOV_DEG / 2)) / Math.tan(deg2rad(ORTHO_FOV_DEG / 2));

interface PresetDef {
    dir: THREE.Vector3;
    fov: number;
    distanceScale: number;
}

/** Định nghĩa các góc camera dùng chung cho rig và luồng xuất ảnh. */
export const PRESETS: Record<CameraPreset, PresetDef> = {
    front: {
        dir: new THREE.Vector3(0, 0, 1).normalize(),
        fov: BASE_FOV_DEG,
        distanceScale: 1,
    },
    top: {
        dir: new THREE.Vector3(0, 1, 0.0001).normalize(),
        fov: BASE_FOV_DEG,
        distanceScale: 1,
    },
    isometric: {
        dir: new THREE.Vector3(1, 0.8, 1).normalize(),
        fov: BASE_FOV_DEG,
        distanceScale: 1,
    },
    orthographic: {
        dir: new THREE.Vector3(1, 0.8, 1).normalize(),
        fov: ORTHO_FOV_DEG,
        distanceScale: ORTHO_DISTANCE_SCALE,
    },
};

/** Tính tư thế camera mục tiêu cho một preset. */
export function computeTargetPose(
    preset: CameraPreset,
    center: THREE.Vector3,
    distance: number,
): { position: THREE.Vector3; fov: number } {
    const def = PRESETS[preset];
    const effectiveDistance = distance * def.distanceScale;
    const position = center.clone().add(def.dir.clone().multiplyScalar(effectiveDistance));
    return { position, fov: def.fov };
}
