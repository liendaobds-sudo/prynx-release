// ============================================================
// useSceneExport — Xuất ảnh PNG / mô hình GLB phía client (Render Layer)
//
// Hook R3F cung cấp hai thao tác xuất, chạy HOÀN TOÀN phía client,
// KHÔNG gọi backend, KHÔNG telemetry (Yêu cầu 6.1, 6.5, 6.6, 9.5):
//
//   • exportPNG(scale?) — kết xuất cảnh hiện tại thành tệp PNG ở hệ số
//     phóng đại ∈ {1,2,4}. Renderer được resize TẠM THỜI tới kích thước
//     mục tiêu (xác thực qua `computeExportSize` với trần 16384 px —
//     Yêu cầu 6.4), render lại, đọc pixel qua `canvas.toBlob`, rồi KHÔI
//     PHỤC kích thước ban đầu. Nếu vượt giới hạn hoặc lỗi → giữ nguyên
//     cảnh và báo lỗi (Yêu cầu 6.4, 6.7).
//
//   • exportGLB() — kết xuất scene three.js sang tệp nhị phân GLB qua
//     `GLTFExporter` (chế độ binary). Lỗi → giữ cảnh và báo lỗi (6.8).
//
// Cả hai bọc trong try/catch; mọi nhánh lỗi đều BẢO TOÀN cảnh hiện tại
// (khôi phục kích thước/pixelRatio renderer trong `finally`) và thông
// báo cho người dùng. Việc tải tệp được kích hoạt phía client bằng thẻ
// <a download> + object URL, không có request mạng.
//
// _Requirements: 6.1, 6.3, 6.5, 6.6, 6.7, 6.8_
// ============================================================

import { useCallback, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import * as THREE from 'three';
import { toast } from 'sonner';
import { useMockupStore } from '../../store/useMockupStore';
import { computeExportSize } from '../../lib/mockup3d/exportSizing';
import type { ExportScale } from '../../lib/mockup3d/types';
import { PRESETS, computeTargetPose } from './CameraRig';
import type { CameraPreset } from '../../store/useMockupStore';

// ─── Tùy chọn & kiểu trả về ─────────────────────────────────────────────────

/** Tùy chọn cấu hình hook xuất cảnh. */
export interface UseSceneExportOptions {
    /**
     * Tiền tố tên tệp xuất (không gồm phần mở rộng). Mặc định `mockup`.
     * Tên tệp cuối cùng có dạng `<prefix>-<timestamp>.<png|glb>`.
     */
    filePrefix?: string;
    /**
     * Callback tùy biến khi xuất thành công. Khi không truyền, hook hiển
     * thị toast thành công mặc định.
     */
    onSuccess?: (kind: 'png' | 'glb', filename: string) => void;
    /**
     * Callback tùy biến khi xuất thất bại. Khi không truyền, hook hiển thị
     * toast lỗi mặc định. Cảnh hiện tại LUÔN được giữ nguyên dù xử lý lỗi
     * theo cách nào.
     */
    onError?: (kind: 'png' | 'glb', message: string) => void;
}

/** API trả về từ `useSceneExport`. */
export interface SceneExportApi {
    /**
     * Xuất cảnh hiện tại thành PNG ở hệ số `scale`. Khi bỏ qua `scale`,
     * dùng `exportScale` trong `useMockupStore` (mặc định 1).
     * Trả về `true` nếu xuất thành công, `false` nếu bị từ chối/lỗi.
     */
    exportPNG: (scale?: ExportScale) => Promise<boolean>;
    /**
     * Xuất nhiều góc camera (front / phối cảnh / từ trên / trực giao) thành
     * nhiều tệp PNG liên tiếp. Camera được khôi phục sau khi xong.
     */
    exportBatchPNG: () => Promise<boolean>;
    /**
     * Xuất scene sang tệp GLB nhị phân ở trạng thái gập hiện tại.
     * Trả về `true` nếu thành công, `false` nếu lỗi.
     */
    exportGLB: () => Promise<boolean>;
}

// ─── Tiện ích thuần (không phụ thuộc React) ─────────────────────────────────

/** Sinh tên tệp xuất kèm dấu thời gian để tránh trùng. */
function buildFilename(prefix: string, ext: 'png' | 'glb'): string {
    const stamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .replace('T', '_')
        .slice(0, 19);
    return `${prefix}-${stamp}.${ext}`;
}

/**
 * Kích hoạt tải một Blob về máy người dùng PHÍA CLIENT (không gọi backend).
 * Dùng object URL + thẻ <a download>; URL được thu hồi ngay sau khi click.
 */
function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.rel = 'noopener';
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
    } finally {
        // Thu hồi sau một nhịp để trình duyệt kịp khởi tạo việc tải.
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }
}

// ─── Hook ───────────────────────────────────────────────────────────────────

/**
 * Hook xuất cảnh PNG/GLB phía client. PHẢI được dùng bên trong cây
 * `<Canvas>` của R3F vì nó truy cập renderer/scene/camera qua `useThree`.
 *
 * _Requirements: 6.1, 6.3, 6.5, 6.6, 6.7, 6.8_
 */
export function useSceneExport(options: UseSceneExportOptions = {}): SceneExportApi {
    const { filePrefix = 'mockup', onSuccess, onError } = options;

    // Lấy renderer/scene/camera trực tiếp từ store R3F (không gây re-render).
    const gl = useThree((s) => s.gl);
    const scene = useThree((s) => s.scene);
    const camera = useThree((s) => s.camera);
    const size = useThree((s) => s.size);
    const controls = useThree((s) => s.controls) as { target: THREE.Vector3; update: () => void } | null;

    // Hệ số xuất mặc định lấy từ store mockup (Yêu cầu 6.2).
    const storeExportScale = useMockupStore((s) => s.exportScale);
    const exportTransparent = useMockupStore((s) => s.exportTransparent);

    // Chặn xuất chồng lấn: một lần xuất phải hoàn tất trước khi bắt đầu lần kế.
    const busyRef = useRef(false);

    // Báo lỗi: ưu tiên callback tùy biến, ngược lại dùng toast mặc định.
    // Mọi nhánh lỗi đều BẢO TOÀN cảnh (Yêu cầu 6.7, 6.8).
    const reportError = useCallback(
        (kind: 'png' | 'glb', message: string) => {
            if (onError) onError(kind, message);
            else toast.error(message);
        },
        [onError],
    );

    const reportSuccess = useCallback(
        (kind: 'png' | 'glb', filename: string) => {
            if (onSuccess) onSuccess(kind, filename);
            else
                toast.success(
                    kind === 'png' ? `Đã xuất ảnh: ${filename}` : `Đã xuất mô hình: ${filename}`,
                );
        },
        [onSuccess],
    );

    // Render cảnh hiện tại ra PNG blob. Khi `transparent` → ẩn nền (scene
    // background) + sàn/bóng ('mockup-floor') và đặt clear alpha = 0 để PNG có
    // nền trong suốt; khôi phục mọi thứ sau khi đọc xong (bảo toàn cảnh).
    const renderToBlob = useCallback(
        async (transparent: boolean): Promise<Blob | null> => {
            const canvas = gl.domElement as HTMLCanvasElement;
            const prevBg = scene.background;
            const floor = scene.getObjectByName('mockup-floor');
            const prevFloorVisible = floor ? floor.visible : undefined;
            const prevClear = new THREE.Color();
            gl.getClearColor(prevClear);
            const prevClearAlpha = gl.getClearAlpha();

            if (transparent) {
                scene.background = null;
                if (floor) floor.visible = false;
                gl.setClearColor(0x000000, 0);
            }
            try {
                gl.render(scene, camera);
                return await new Promise<Blob | null>((resolve) => {
                    canvas.toBlob((b) => resolve(b), 'image/png');
                });
            } finally {
                if (transparent) {
                    scene.background = prevBg;
                    if (floor && prevFloorVisible !== undefined) floor.visible = prevFloorVisible;
                    gl.setClearColor(prevClear, prevClearAlpha);
                }
            }
        },
        [gl, scene, camera],
    );

    // ── exportPNG ────────────────────────────────────────────────────────────
    const exportPNG = useCallback(
        async (scale?: ExportScale): Promise<boolean> => {
            if (busyRef.current) return false;

            const effectiveScale = scale ?? storeExportScale;

            // Xác thực kích thước mục tiêu TRƯỚC khi đụng tới renderer
            // (Yêu cầu 6.4): nếu vượt 16384 px → giữ cảnh, báo lỗi.
            const sizing = computeExportSize(size.width, size.height, effectiveScale);
            if (!sizing.ok) {
                reportError('png', sizing.reason ?? 'Kích thước xuất vượt giới hạn cho phép.');
                return false;
            }

            const canvas = gl.domElement as HTMLCanvasElement;

            // Lưu trạng thái renderer để khôi phục chính xác sau khi xuất.
            // Khôi phục kích thước bằng `size` gốc của R3F (CSS pixels) cùng
            // pixelRatio trước đó, đưa drawing buffer về đúng trạng thái ban đầu.
            const prevPixelRatio = gl.getPixelRatio();
            const restoreWidth = size.width;
            const restoreHeight = size.height;

            busyRef.current = true;
            try {
                // Resize TẠM THỜI tới đúng số pixel mục tiêu: ép pixelRatio = 1
                // rồi setSize theo (width, height) đã tính, không cập nhật style
                // để không làm layout DOM nhảy.
                gl.setPixelRatio(1);
                gl.setSize(sizing.width, sizing.height, false);

                // Render + đọc pixel (kèm tùy chọn nền trong suốt).
                const blob = await renderToBlob(exportTransparent);

                if (!blob) {
                    throw new Error('Trình duyệt không tạo được dữ liệu ảnh PNG.');
                }

                const filename = buildFilename(filePrefix, 'png');
                downloadBlob(blob, filename);
                reportSuccess('png', filename);
                return true;
            } catch (err) {
                const message =
                    'Xuất ảnh PNG thất bại: ' +
                    (err instanceof Error ? err.message : 'Lỗi không xác định');
                console.error('[useSceneExport] exportPNG error:', err);
                reportError('png', message);
                return false;
            } finally {
                // KHÔI PHỤC kích thước/pixelRatio ban đầu và render lại để
                // cảnh hiển thị trở về trạng thái trước khi xuất (Yêu cầu 6.7).
                try {
                    gl.setPixelRatio(prevPixelRatio);
                    gl.setSize(restoreWidth, restoreHeight, false);
                    gl.render(scene, camera);
                } catch (restoreErr) {
                    console.error('[useSceneExport] restore size error:', restoreErr);
                }
                busyRef.current = false;
            }
        },
        [gl, scene, camera, size.width, size.height, storeExportScale, filePrefix, reportError, reportSuccess, renderToBlob, exportTransparent],
    );

    // ── exportBatchPNG: nhiều góc camera ──────────────────────────────────────
    const exportBatchPNG = useCallback(async (): Promise<boolean> => {
        if (busyRef.current) return false;

        const sizing = computeExportSize(size.width, size.height, storeExportScale);
        if (!sizing.ok) {
            reportError('png', sizing.reason ?? 'Kích thước xuất vượt giới hạn cho phép.');
            return false;
        }

        const order: CameraPreset[] = ['front', 'isometric', 'top', 'orthographic'];
        const cam = camera as THREE.PerspectiveCamera;

        // Lưu camera + renderer để khôi phục.
        const savedPos = cam.position.clone();
        const savedQuat = cam.quaternion.clone();
        const savedFov = cam.isPerspectiveCamera ? cam.fov : 45;
        const prevPixelRatio = gl.getPixelRatio();

        // Tâm nhìn + khoảng cách hiện tại để dựng pose từng preset.
        const center = controls?.target ? controls.target.clone() : new THREE.Vector3();
        const distance = cam.position.distanceTo(center);

        busyRef.current = true;
        let okCount = 0;
        try {
            gl.setPixelRatio(1);
            gl.setSize(sizing.width, sizing.height, false);

            for (const preset of order) {
                const pose = computeTargetPose(preset, center, distance);
                cam.position.copy(pose.position);
                if (cam.isPerspectiveCamera) {
                    cam.fov = pose.fov;
                }
                cam.lookAt(center);
                cam.updateProjectionMatrix();

                const blob = await renderToBlob(exportTransparent);
                if (blob) {
                    downloadBlob(blob, buildFilename(`${filePrefix}-${preset}`, 'png'));
                    okCount++;
                }
            }
            if (okCount > 0) reportSuccess('png', `${okCount} góc`);
            else reportError('png', 'Không xuất được góc nào.');
            return okCount > 0;
        } catch (err) {
            reportError('png', 'Xuất batch thất bại: ' + (err instanceof Error ? err.message : 'lỗi không xác định'));
            return false;
        } finally {
            // Khôi phục camera + kích thước renderer + đồng bộ controls.
            try {
                cam.position.copy(savedPos);
                cam.quaternion.copy(savedQuat);
                if (cam.isPerspectiveCamera) cam.fov = savedFov;
                cam.updateProjectionMatrix();
                gl.setPixelRatio(prevPixelRatio);
                gl.setSize(size.width, size.height, false);
                controls?.update();
                gl.render(scene, camera);
            } catch (restoreErr) {
                console.error('[useSceneExport] batch restore error:', restoreErr);
            }
            busyRef.current = false;
        }
    }, [gl, scene, camera, controls, size.width, size.height, storeExportScale, filePrefix, reportError, reportSuccess, renderToBlob, exportTransparent]);

    // ── exportGLB ────────────────────────────────────────────────────────────
    const exportGLB = useCallback(async (): Promise<boolean> => {
        if (busyRef.current) return false;

        busyRef.current = true;
        try {
            const exporter = new GLTFExporter();

            // parseAsync trả về ArrayBuffer khi binary=true (chế độ GLB).
            const result = await exporter.parseAsync(scene, {
                binary: true,
                onlyVisible: true,
            });

            if (!(result instanceof ArrayBuffer)) {
                throw new Error('Kết quả xuất không ở định dạng nhị phân GLB.');
            }

            const blob = new Blob([result], { type: 'model/gltf-binary' });
            const filename = buildFilename(filePrefix, 'glb');
            downloadBlob(blob, filename);
            reportSuccess('glb', filename);
            return true;
        } catch (err) {
            const message =
                'Xuất mô hình GLB thất bại: ' +
                (err instanceof Error ? err.message : 'Lỗi không xác định');
            console.error('[useSceneExport] exportGLB error:', err);
            reportError('glb', message);
            return false;
        } finally {
            busyRef.current = false;
        }
    }, [scene, filePrefix, reportError, reportSuccess]);

    return { exportPNG, exportBatchPNG, exportGLB };
}

export default useSceneExport;
