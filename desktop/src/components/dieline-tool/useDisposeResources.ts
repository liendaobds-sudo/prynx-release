// ============================================================
// useDisposeResources — Giải phóng tài nguyên GPU (Render Layer)
//
// Hook và tiện ích phía render để GIẢI PHÓNG (dispose) các tài
// nguyên three.js (geometry / material / texture) không còn được
// tham chiếu TRƯỚC KHI cấp phát tài nguyên mới khi dieline hoặc
// ảnh nghệ thuật thay đổi. Mục tiêu: tránh rò rỉ bộ nhớ GPU khi
// cảnh dựng lại nhiều lần.
//
// three.js KHÔNG tự thu hồi bộ nhớ GPU; mỗi `BufferGeometry`,
// `Material`, `Texture` phải gọi `.dispose()` thủ công. Hook này
// đóng gói nguyên tắc đó dưới dạng React idiom: khi danh sách phụ
// thuộc (deps) đổi, tài nguyên cũ được dispose ngay trước khi
// factory tạo tài nguyên mới; khi component unmount, tài nguyên
// cuối cùng cũng được dispose.
//
// _Requirements: 8.3_
// ============================================================

import { useRef, useEffect, useMemo } from 'react';
import * as THREE from 'three';

// ─── Kiểu tài nguyên có thể giải phóng ──────────────────────────────────────

/** Một tài nguyên three.js đơn lẻ có thể giải phóng GPU. */
export type DisposableResource =
    | THREE.BufferGeometry
    | THREE.Material
    | THREE.Texture
    | THREE.Object3D;

/** Tài nguyên đơn, mảng tài nguyên, hoặc rỗng (null/undefined). */
export type DisposableInput =
    | DisposableResource
    | DisposableResource[]
    | null
    | undefined;

// ─── Tiện ích giải phóng thuần (không phụ thuộc React) ──────────────────────

/**
 * Giải phóng mọi texture được tham chiếu bởi một material.
 *
 * Material PBR (`MeshStandardMaterial`, …) giữ texture qua nhiều khe
 * khác nhau (`map`, `normalMap`, `roughnessMap`, …). Ta duyệt toàn
 * bộ thuộc tính của material và dispose mọi giá trị là `THREE.Texture`,
 * sau đó dispose chính material. An toàn với material đã dispose vì
 * `.dispose()` của three idempotent ở mức thực dụng.
 *
 * @param material Material cần giải phóng (đơn hoặc mảng).
 */
export function disposeMaterial(material: THREE.Material | THREE.Material[]): void {
    const materials = Array.isArray(material) ? material : [material];

    for (const mat of materials) {
        if (!mat) continue;

        // Giải phóng mọi texture đính trong các khe của material.
        for (const key of Object.keys(mat) as (keyof typeof mat)[]) {
            const value = mat[key];
            if (value instanceof THREE.Texture) {
                value.dispose();
            }
        }

        mat.dispose();
    }
}

/**
 * Giải phóng đệ quy một tài nguyên three.js (geometry / material /
 * texture / Object3D) và toàn bộ tài nguyên con của nó.
 *
 * - `BufferGeometry`  → `dispose()`.
 * - `Material`        → giải phóng texture + `dispose()` (qua `disposeMaterial`).
 * - `Texture`         → `dispose()`.
 * - `Object3D`        → duyệt cây con, dispose geometry + material của mọi `Mesh`.
 * - Mảng              → giải phóng từng phần tử.
 * - `null`/`undefined`→ bỏ qua.
 *
 * Hàm không bao giờ ném lỗi cho input rỗng để có thể gọi vô điều kiện
 * trong vòng đời render.
 *
 * @param resource Tài nguyên (hoặc mảng) cần giải phóng.
 */
export function disposeResource(resource: DisposableInput): void {
    if (resource == null) return;

    if (Array.isArray(resource)) {
        for (const item of resource) disposeResource(item);
        return;
    }

    if (resource instanceof THREE.BufferGeometry) {
        resource.dispose();
        return;
    }

    if (resource instanceof THREE.Texture) {
        resource.dispose();
        return;
    }

    if (resource instanceof THREE.Material) {
        disposeMaterial(resource);
        return;
    }

    if (resource instanceof THREE.Object3D) {
        // Duyệt toàn bộ cây con (kể cả chính nó) để dispose geometry/material.
        resource.traverse((child) => {
            const mesh = child as Partial<THREE.Mesh>;
            if (mesh.geometry instanceof THREE.BufferGeometry) {
                mesh.geometry.dispose();
            }
            if (mesh.material) {
                disposeMaterial(mesh.material as THREE.Material | THREE.Material[]);
            }
        });
        return;
    }
}

// ─── Hook: cấp phát có giải phóng tài nguyên cũ ─────────────────────────────

/**
 * Tạo và quản lý vòng đời một tài nguyên three.js: giải phóng tài
 * nguyên CŨ trước khi cấp phát tài nguyên MỚI mỗi khi `deps` đổi, và
 * giải phóng tài nguyên cuối cùng khi component unmount (Yêu cầu 8.3).
 *
 * Dùng cho geometry/material/texture được sinh từ dieline hoặc ảnh
 * nghệ thuật: khi dieline/ảnh đổi → `deps` đổi → tài nguyên cũ được
 * thu hồi GPU ngay, tránh rò rỉ khi cảnh dựng lại.
 *
 * Thứ tự bảo đảm: factory chạy để tạo tài nguyên mới, tài nguyên cũ
 * (của lần render trước) được dispose trong cleanup của `useEffect`
 * TRƯỚC khi giá trị mới được "chốt" cho lần kế tiếp — tức tài nguyên
 * cũ luôn được giải phóng, không bao giờ giữ song song hai thế hệ
 * sau khi deps thay đổi.
 *
 * @typeParam T Kiểu tài nguyên (geometry/material/texture/mảng…).
 * @param factory Hàm tạo tài nguyên mới; chỉ chạy lại khi `deps` đổi.
 * @param deps    Danh sách phụ thuộc kiểu React (dieline, url ảnh, …).
 * @returns Tài nguyên hiện tại do `factory` tạo.
 */
export function useDisposableResource<T extends DisposableInput>(
    factory: () => T,
    deps: React.DependencyList,
): T {
    // Tạo tài nguyên mới khi deps đổi (memo hóa theo deps).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const resource = useMemo(factory, deps);

    // Giữ tham chiếu tới tài nguyên hiện tại để cleanup dispose đúng
    // thế hệ đang "treo" khi deps đổi hoặc khi unmount.
    const currentRef = useRef<T>(resource);
    currentRef.current = resource;

    useEffect(() => {
        // Khi effect chạy, `resource` là thế hệ mới. Cleanup dưới đây
        // sẽ chạy khi deps đổi (trước lần effect kế) hoặc khi unmount,
        // dispose đúng thế hệ tài nguyên vừa bị thay thế.
        const allocated = resource;
        return () => {
            disposeResource(allocated);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps);

    return resource;
}

/**
 * Giải phóng một tài nguyên (đã có sẵn, ví dụ texture nạp ngoài hook)
 * khi `deps` đổi hoặc khi component unmount, mà không tự cấp phát.
 *
 * Hữu ích khi tài nguyên được tạo bởi loader/bên thứ ba nhưng ta vẫn
 * muốn bảo đảm thu hồi GPU đúng lúc nội dung đổi (Yêu cầu 8.3).
 *
 * @param resource Tài nguyên cần theo dõi để giải phóng.
 * @param deps     Danh sách phụ thuộc; thay đổi → giải phóng giá trị trước đó.
 */
export function useDisposeOnChange(
    resource: DisposableInput,
    deps: React.DependencyList,
): void {
    const ref = useRef<DisposableInput>(resource);
    ref.current = resource;

    useEffect(() => {
        const allocated = ref.current;
        return () => {
            disposeResource(allocated);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps);
}

/**
 * Tổng hợp tiện ích giải phóng để tiêu thụ tiện lợi ở lớp render.
 */
export const useDisposeResources = {
    /** Giải phóng đệ quy một tài nguyên/mảng tài nguyên. */
    dispose: disposeResource,
    /** Giải phóng material + texture của nó. */
    disposeMaterial,
    /** Hook cấp phát có dispose tài nguyên cũ. */
    useDisposableResource,
    /** Hook giải phóng tài nguyên ngoài khi deps đổi. */
    useDisposeOnChange,
} as const;

export default useDisposeResources;
