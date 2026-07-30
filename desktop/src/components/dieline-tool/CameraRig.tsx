// ============================================================
// CameraRig — Preset camera + chuyển cảnh mượt (≤500ms)
//
// Component R3F (render bên trong <Canvas>) điều khiển camera theo
// 4 preset trình bày đọc từ `useMockupStore.cameraPreset`:
//   - front        : nhìn thẳng mặt trước (+Z)
//   - top          : nhìn từ trên xuống (+Y)
//   - isometric    : góc phối cảnh 3/4
//   - orthographic : góc 3/4 nhưng dùng ống kính tele (FOV nhỏ) để
//                    mô phỏng phép chiếu trực giao (tia gần song song)
//
// Khi `cameraPreset` đổi, rig nội suy vị trí camera + tâm nhìn
// (OrbitControls target) + FOV trong tối đa ~450ms (< 500ms theo
// Yêu cầu 7.2) bằng hàm easing easeInOutCubic.
//
// Lớp này KHÔNG tự cấp phát tài nguyên GPU; chỉ đọc/ghi thuộc tính
// camera + controls hiện có. Tính toán vị trí preset dựa trên tâm
// và bán kính khung nhìn truyền vào qua props (lớp wiring 10.1 cấp
// từ `dieline.boundingBox`).
//
// _Requirements: 7.1, 7.2_
// ============================================================

import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useMockupStore, type CameraPreset } from '../../stores/useMockupStore';

/** Thời lượng chuyển cảnh mặc định (ms). Phải < 500ms (Yêu cầu 7.2). */
export const DEFAULT_TRANSITION_MS = 450;

/** FOV cơ sở cho các preset phối cảnh thường. */
const BASE_FOV_DEG = 45;

/** FOV "tele" để mô phỏng phép chiếu trực giao (tia gần song song). */
const ORTHO_FOV_DEG = 12;

const deg2rad = (d: number) => (d * Math.PI) / 180;

/**
 * Hệ số khoảng cách cho preset orthographic: khi giảm FOV từ 45° xuống
 * 12°, tăng khoảng cách tương ứng để giữ kích thước biểu kiến của hộp
 * không đổi (tan(fov/2) tỉ lệ nghịch với khoảng cách).
 */
const ORTHO_DISTANCE_SCALE =
    Math.tan(deg2rad(BASE_FOV_DEG / 2)) / Math.tan(deg2rad(ORTHO_FOV_DEG / 2));

interface PresetDef {
    /** Hướng (đã chuẩn hóa) từ tâm nhìn tới vị trí camera. */
    dir: THREE.Vector3;
    /** FOV (độ) áp cho camera ở preset này. */
    fov: number;
    /** Hệ số nhân khoảng cách cơ sở. */
    distanceScale: number;
}

/** Định nghĩa 4 preset camera (Yêu cầu 7.1). */
export const PRESETS: Record<CameraPreset, PresetDef> = {
    front: {
        dir: new THREE.Vector3(0, 0, 1).normalize(),
        fov: BASE_FOV_DEG,
        distanceScale: 1,
    },
    top: {
        // epsilon nhỏ theo Z để tránh trùng phương với vector up (gimbal)
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

/** easeInOutCubic — chuyển cảnh êm ở đầu/cuối. */
function easeInOutCubic(t: number): number {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Tính tư thế camera mục tiêu cho một preset. */
export function computeTargetPose(
    preset: CameraPreset,
    center: THREE.Vector3,
    distance: number,
): { position: THREE.Vector3; fov: number } {
    const def = PRESETS[preset];
    const effDist = distance * def.distanceScale;
    const position = center.clone().add(def.dir.clone().multiplyScalar(effDist));
    return { position, fov: def.fov };
}

interface OrbitLikeControls {
    target: THREE.Vector3;
    update: () => void;
}

interface AnimState {
    active: boolean;
    startTime: number;
    duration: number;
    fromPos: THREE.Vector3;
    toPos: THREE.Vector3;
    fromTarget: THREE.Vector3;
    toTarget: THREE.Vector3;
    fromFov: number;
    toFov: number;
}

export interface CameraRigProps {
    /** Tâm nhìn (look-at target) theo tọa độ thế giới. */
    center: [number, number, number];
    /** Khoảng cách cơ sở từ camera tới tâm (≈ bán kính khung nhìn). */
    distance: number;
    /** Thời lượng chuyển cảnh (ms); mặc định 450, luôn được giới hạn < 500. */
    transitionMs?: number;
}

/**
 * CameraRig — đặt bên trong <Canvas>, cùng cấp với <OrbitControls makeDefault>.
 * Đọc preset từ store và nội suy camera tới preset đó.
 */
export default function CameraRig({
    center,
    distance,
    transitionMs = DEFAULT_TRANSITION_MS,
}: CameraRigProps) {
    const cameraPreset = useMockupStore((s) => s.cameraPreset);
    const cameraResetNonce = useMockupStore((s) => s.cameraResetNonce);
    const camera = useThree((s) => s.camera);
    const controls = useThree((s) => s.controls) as OrbitLikeControls | null;
    const invalidate = useThree((s) => s.invalidate);

    const animRef = useRef<AnimState>({
        active: false,
        startTime: 0,
        duration: DEFAULT_TRANSITION_MS,
        fromPos: new THREE.Vector3(),
        toPos: new THREE.Vector3(),
        fromTarget: new THREE.Vector3(),
        toTarget: new THREE.Vector3(),
        fromFov: BASE_FOV_DEG,
        toFov: BASE_FOV_DEG,
    });

    const cx = center[0];
    const cy = center[1];
    const cz = center[2];

    // Khởi động chuyển cảnh khi preset (hoặc khung nhìn) thay đổi.
    useEffect(() => {
        const centerVec = new THREE.Vector3(cx, cy, cz);
        const { position: toPos, fov: toFov } = computeTargetPose(
            cameraPreset,
            centerVec,
            distance,
        );

        const fromTarget = controls
            ? controls.target.clone()
            : centerVec.clone();
        const fromFov =
            camera instanceof THREE.PerspectiveCamera ? camera.fov : toFov;

        // Giới hạn thời lượng < 500ms (Yêu cầu 7.2).
        const duration = Math.min(Math.max(transitionMs, 0), 499);

        animRef.current = {
            active: true,
            startTime:
                typeof performance !== 'undefined' ? performance.now() : Date.now(),
            duration,
            fromPos: camera.position.clone(),
            toPos,
            fromTarget,
            toTarget: centerVec,
            fromFov,
            toFov,
        };
        invalidate();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cameraPreset, cx, cy, cz, distance, transitionMs, cameraResetNonce]);

    useFrame(() => {
        const anim = animRef.current;
        if (!anim.active) return;

        const now =
            typeof performance !== 'undefined' ? performance.now() : Date.now();
        const elapsed = now - anim.startTime;
        const rawT = anim.duration > 0 ? elapsed / anim.duration : 1;
        const t = Math.min(Math.max(rawT, 0), 1);
        const e = easeInOutCubic(t);

        // Nội suy vị trí camera.
        camera.position.lerpVectors(anim.fromPos, anim.toPos, e);

        // Nội suy FOV (chỉ với camera phối cảnh).
        if (camera instanceof THREE.PerspectiveCamera) {
            const fov = anim.fromFov + (anim.toFov - anim.fromFov) * e;
            if (Math.abs(camera.fov - fov) > 1e-4) {
                camera.fov = fov;
                camera.updateProjectionMatrix();
            }
        }

        // Nội suy tâm nhìn + đồng bộ OrbitControls.
        if (controls) {
            controls.target.lerpVectors(anim.fromTarget, anim.toTarget, e);
            controls.update();
        } else {
            const target = anim.fromTarget
                .clone()
                .lerp(anim.toTarget, e);
            camera.lookAt(target);
        }

        invalidate();

        if (t >= 1) {
            anim.active = false;
        }
    });

    return null;
}
