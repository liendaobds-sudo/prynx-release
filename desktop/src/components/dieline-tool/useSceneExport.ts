// ============================================================
// useSceneExport — Xuất ảnh PNG / mô hình GLB phía client (Render Layer)
//
// Hook R3F cung cấp hai thao tác xuất, chạy HOÀN TOÀN phía client,
// KHÔNG gọi backend, KHÔNG telemetry (Yêu cầu 6.1, 6.5, 6.6, 9.5):
//
//   • exportPNG(scale?) — kết xuất cảnh hiện tại thành tệp PNG ở hệ số
//     phóng đại ∈ {1,2,4}. Cảnh được render vào WebGLRenderTarget tạm thời,
//     đọc pixel và mã hóa qua canvas 2D dùng riêng cho file xuất; canvas hiển thị
//     không resize và không cần `preserveDrawingBuffer` thường trực.
//
//   • exportGLB() — kết xuất scene three.js sang tệp nhị phân GLB qua
//     `GLTFExporter` (chế độ binary). Lỗi → giữ cảnh và báo lỗi (6.8).
//
// Cả hai bọc trong try/catch; mọi nhánh lỗi đều BẢO TOÀN cảnh hiện tại
// (khôi phục render target, camera và trạng thái scene trong `finally`) và thông
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
import { computeExportSize, flipWebGlPixelRows, MAX_EXPORT_PX } from '../../lib/mockup3d/exportSizing';
import type { ExportScale } from '../../lib/mockup3d/types';
import { computeTargetPose } from './CameraRig';
import type { CameraPreset } from '../../store/useMockupStore';
import { useTranslation } from 'react-i18next';

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
  const { t } = useTranslation();
    const { filePrefix = 'mockup', onSuccess, onError } = options;

    // Lấy renderer/scene/camera trực tiếp từ store R3F (không gây re-render).
    const gl = useThree((s) => s.gl);
    const scene = useThree((s) => s.scene);
    const maxTextureSize = Math.min(MAX_EXPORT_PX, gl.capabilities.maxTextureSize || MAX_EXPORT_PX);
    const camera = useThree((s) => s.camera);
    const size = useThree((s) => s.size);
    const controls = useThree((s) => s.controls) as { target: THREE.Vector3; update: () => void } | null;

    // Hệ số xuất mặc định lấy từ store mockup (Yêu cầu 6.2).
    const storeExportScale = useMockupStore((s) => s.exportScale);
    const exportTransparent = useMockupStore((s) => s.exportTransparent);
    const qualityTier = useMockupStore((s) => s.qualityTier);
    const setQualityTier = useMockupStore((s) => s.setQualityTier);
    const invalidate = useThree((s) => s.invalidate);

    // Chặn xuất chồng lấn: một lần xuất phải hoàn tất trước khi bắt đầu lần kế.
    const busyRef = useRef(false);

    /** Đợi N frame demand + env remount (quality high) trước khi chụp. */
    const waitFrames = useCallback(
        (n: number) =>
            new Promise<void>((resolve) => {
                let left = n;
                const step = () => {
                    invalidate();
                    left -= 1;
                    if (left <= 0) resolve();
                    else requestAnimationFrame(step);
                };
                requestAnimationFrame(step);
            }),
        [invalidate],
    );

    /**
     * Xuất 2×/4×: tạm bật quality high để env 512, rồi khôi phục tier cũ.
     * balanced + 1× giữ nguyên để không tốn GPU khi preview.
     */
    const withExportQuality = useCallback(
        async <T,>(scale: ExportScale, run: () => Promise<T>): Promise<T> => {
            const bump = scale >= 2 && qualityTier !== 'high';
            if (!bump) return run();
            const prev = qualityTier;
            setQualityTier('high');
            try {
                await waitFrames(3);
                return await run();
            } finally {
                setQualityTier(prev);
                invalidate();
            }
        },
        [qualityTier, setQualityTier, waitFrames, invalidate],
    );

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

    // Render vào framebuffer riêng rồi đọc pixel. Canvas hiển thị không cần
    // preserveDrawingBuffer và không bị resize trong lúc export.
    const renderToBlob = useCallback(
        async (transparent: boolean, width: number, height: number): Promise<Blob | null> => {
            const prevBg = scene.background;
            const floor = scene.getObjectByName('mockup-floor');
            const prevFloorVisible = floor ? floor.visible : undefined;
            const prevClear = new THREE.Color();
            gl.getClearColor(prevClear);
            const prevClearAlpha = gl.getClearAlpha();
            const prevTarget = gl.getRenderTarget();
            const target = new THREE.WebGLRenderTarget(width, height, {
                depthBuffer: true,
                stencilBuffer: false,
            });
            target.texture.colorSpace = THREE.SRGBColorSpace;
            const maxSamples = gl.capabilities.maxSamples || 0;
            target.samples = gl.capabilities.isWebGL2 && width * height <= 8_000_000
                ? Math.min(4, maxSamples)
                : 0;

            if (transparent) {
                scene.background = null;
                if (floor) floor.visible = false;
                gl.setClearColor(0x000000, 0);
            }

            try {
                gl.setRenderTarget(target);
                gl.clear(true, true, true);
                gl.render(scene, camera);

                const pixels = new Uint8Array(width * height * 4);
                gl.readRenderTargetPixels(target, 0, 0, width, height, pixels);

                // WebGL có gốc ở dưới-trái; Canvas 2D có gốc ở trên-trái.
                const flipped = flipWebGlPixelRows(pixels, width, height);

                const exportCanvas = document.createElement('canvas');
                exportCanvas.width = width;
                exportCanvas.height = height;
                const context = exportCanvas.getContext('2d');
                if (!context) throw new Error('Không khởi tạo được canvas xuất ảnh.');
                const imageData = context.createImageData(width, height);
                imageData.data.set(flipped);
                context.putImageData(imageData, 0, 0);

                return await new Promise<Blob | null>((resolve) => {
                    exportCanvas.toBlob((blob) => resolve(blob), 'image/png');
                });
            } finally {
                gl.setRenderTarget(prevTarget);
                target.dispose();
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
            const sizing = computeExportSize(size.width, size.height, effectiveScale, maxTextureSize);
            if (!sizing.ok) {
                reportError('png', sizing.reason ?? t('dieline.useSceneExport:kich_thuoc_xuat_vuot_gioi_han_cho_phep'));
                return false;
            }

            busyRef.current = true;
            try {
                const blob = await withExportQuality(effectiveScale, () =>
                    renderToBlob(
                        exportTransparent,
                        sizing.width,
                        sizing.height,
                    ),
                );
                if (!blob) {
                    throw new Error(t('dieline.useSceneExport:trinh_duyet_khong_tao_duoc_du_lieu_anh'));
                }

                const filename = buildFilename(filePrefix, 'png');
                downloadBlob(blob, filename);
                reportSuccess('png', filename);
                return true;
            } catch (err) {
                const message =
                    'Xuất ảnh PNG thất bại: ' +
                    (err instanceof Error ? err.message : t('dieline.useSceneExport:loi_khong_xac_dinh'));
                console.error('[useSceneExport] exportPNG error:', err);
                reportError('png', message);
                return false;
            } finally {
                busyRef.current = false;
            }
        },
        [size.width, size.height, storeExportScale, maxTextureSize, filePrefix, reportError, reportSuccess, renderToBlob, exportTransparent, withExportQuality, t],
    );
    // ── exportBatchPNG: nhiều góc camera ──────────────────────────────────────
    const exportBatchPNG = useCallback(async (): Promise<boolean> => {
        if (busyRef.current) return false;

        const sizing = computeExportSize(size.width, size.height, storeExportScale, maxTextureSize);
        if (!sizing.ok) {
            reportError('png', sizing.reason ?? t('dieline.useSceneExport:kich_thuoc_xuat_vuot_gioi_han_cho_phep'));
            return false;
        }

        const order: CameraPreset[] = ['front', 'isometric', 'top', 'orthographic'];
        const cam = camera as THREE.PerspectiveCamera;
        const savedPos = cam.position.clone();
        const savedQuat = cam.quaternion.clone();
        const savedFov = cam.isPerspectiveCamera ? cam.fov : 45;
        const center = controls?.target ? controls.target.clone() : new THREE.Vector3();
        const distance = cam.position.distanceTo(center);

        busyRef.current = true;
        let okCount = 0;
        try {
            for (const preset of order) {
                const pose = computeTargetPose(preset, center, distance);
                cam.position.copy(pose.position);
                if (cam.isPerspectiveCamera) cam.fov = pose.fov;
                cam.lookAt(center);
                cam.updateProjectionMatrix();

                const blob = await renderToBlob(
                    exportTransparent,
                    sizing.width,
                    sizing.height,
                );
                if (blob) {
                    downloadBlob(blob, buildFilename(`${filePrefix}-${preset}`, 'png'));
                    okCount += 1;
                }
            }
            if (okCount > 0) reportSuccess('png', `${okCount} góc`);
            else reportError('png', t('dieline.useSceneExport:khong_xuat_duoc_goc_nao'));
            return okCount > 0;
        } catch (err) {
            reportError('png', 'Xuất batch thất bại: ' + (err instanceof Error ? err.message : t('dieline.useSceneExport:loi_khong_xac_dinh_2')));
            return false;
        } finally {
            try {
                cam.position.copy(savedPos);
                cam.quaternion.copy(savedQuat);
                if (cam.isPerspectiveCamera) cam.fov = savedFov;
                cam.updateProjectionMatrix();
                controls?.update();
            } catch (restoreErr) {
                console.error('[useSceneExport] batch restore error:', restoreErr);
            }
            busyRef.current = false;
        }
    }, [camera, controls, size.width, size.height, storeExportScale, maxTextureSize, filePrefix, reportError, reportSuccess, renderToBlob, exportTransparent, t]);
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
                throw new Error(t('dieline.useSceneExport:ket_qua_xuat_khong_o_dinh_dang_nhi_phan'));
            }

            const blob = new Blob([result], { type: 'model/gltf-binary' });
            const filename = buildFilename(filePrefix, 'glb');
            downloadBlob(blob, filename);
            reportSuccess('glb', filename);
            return true;
        } catch (err) {
            const message =
                'Xuất mô hình GLB thất bại: ' +
                (err instanceof Error ? err.message : t('dieline.useSceneExport:loi_khong_xac_dinh'));
            console.error('[useSceneExport] exportGLB error:', err);
            reportError('glb', message);
            return false;
        } finally {
            busyRef.current = false;
        }
    }, [scene, filePrefix, reportError, reportSuccess, t]);

    return { exportPNG, exportBatchPNG, exportGLB };
}

export default useSceneExport;
