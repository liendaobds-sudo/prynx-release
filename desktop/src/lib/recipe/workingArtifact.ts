/**
 * Nguồn working duy nhất trong một lượt Phát Recipe.
 *
 * RECIPE (audit 2026-08-15 §PLAY.1-2): path và bytes là hai revision loại trừ
 * nhau. Không được giữ path cũ cạnh bytes mới vì handler ưu tiên path và sẽ xử
 * lý lại tài liệu ban đầu; carrier 0/11 byte cũng không phải nội dung PDF.
 */
import type { ProcessContext } from '../processHandlers';
import { readArtifactLeaseToken, tagArtifactLeaseToken } from '../artifactLease';

const UNKNOWN_PATH_SIZE = Number.MAX_SAFE_INTEGER;

export type WorkingArtifact =
    | {
        kind: 'path';
        name: string;
        mimeType: string;
        path: string;
        size?: number;
        /** Token runtime của artifact backend; không được serialize vào Recipe JSON. */
        artifactLeaseToken?: string;
    }
    | {
        kind: 'bytes';
        name: string;
        mimeType: string;
        bytes: Uint8Array;
        /** Token runtime của artifact backend; không được serialize vào Recipe JSON. */
        artifactLeaseToken?: string;
    };

type PathArtifact = Extract<WorkingArtifact, { kind: 'path' }>;

export interface WorkingArtifactIo {
    readPath: (artifact: PathArtifact) => Promise<Uint8Array>;
    statPath?: (path: string) => Promise<number | undefined>;
}

export interface WorkingArtifactController {
    readonly current: WorkingArtifact;
    toFile: () => File;
    getBytes: () => Promise<Uint8Array>;
    getSourcePath: () => Promise<string | undefined>;
    commit: (
        blob: Blob,
        name: string,
        existingPath: string | undefined,
        publish: (blob: Blob, name: string, existingPath?: string) => void | Promise<void>,
    ) => Promise<void>;
}

/**
 * Chụp nguồn đầu vào cho một lượt Phát Recipe từ đúng Working revision.
 *
 * REVISION (audit 2026-08-25 §REV.09): lỗi materialize phải dừng lượt phát;
 * tuyệt đối không đọc lại backing File vì file đó có thể chưa chứa xoay/xóa/reorder.
 */
export async function resolveInitialWorkingArtifact(
    context: Pick<ProcessContext, 'getWorkingBytes' | 'getWorkingSourcePath'>,
    file: File,
): Promise<WorkingArtifact> {
    let path: string | undefined;
    try {
        path = await context.getWorkingSourcePath?.();
    } catch {
        // Path native chỉ là fast-path. Cùng revision vẫn có thể materialize bytes.
        path = undefined;
    }

    const mimeType = file.type || 'application/pdf';
    const artifactLeaseToken = readArtifactLeaseToken(file);
    if (path) {
        return {
            kind: 'path',
            name: file.name,
            mimeType,
            path,
            size: file.size,
            ...(artifactLeaseToken ? { artifactLeaseToken } : {}),
        };
    }

    return {
        kind: 'bytes',
        name: file.name,
        mimeType,
        bytes: await context.getWorkingBytes(),
        ...(artifactLeaseToken ? { artifactLeaseToken } : {}),
    };
}

function normalizedSize(size: number | undefined): number | undefined {
    // PDF path 0 byte không phải nguồn hợp lệ; trong app nó thường có nghĩa là
    // stat chưa biết. Dùng sentinel an toàn thay vì hiểu nhầm là file nhỏ.
    return Number.isFinite(size) && Number(size) > 0 ? Number(size) : undefined;
}

function fileFromArtifact(artifact: WorkingArtifact): File {
    if (artifact.kind === 'bytes') {
        return tagArtifactLeaseToken(
            new File([artifact.bytes as BlobPart], artifact.name, {
                type: artifact.mimeType,
            }),
            artifact.artifactLeaseToken,
        );
    }

    const file = new File([], artifact.name, { type: artifact.mimeType });
    Object.defineProperty(file, 'path', {
        value: artifact.path,
        configurable: true,
    });
    // `file.size` tham gia chọn frontend/backend ở Resize. Khi stat path lỗi,
    // coi kích thước là chưa biết/lớn để không nạp nhầm PDF nặng vào WebView.
    const size = normalizedSize(artifact.size) ?? UNKNOWN_PATH_SIZE;
    Object.defineProperty(file, 'size', {
        value: size,
        configurable: true,
    });
    return tagArtifactLeaseToken(file, artifact.artifactLeaseToken);
}

/** Dựng facade ProcessContext cho đúng revision tại đầu mỗi Step. */
export function createWorkingArtifactProcessContext(
    base: ProcessContext,
    controller: WorkingArtifactController,
    publish: ProcessContext['commitWorkingFile'],
): ProcessContext {
    return {
        ...base,
        file: controller.toFile(),
        getWorkingBytes: () => controller.getBytes(),
        getWorkingSourcePath: () => controller.getSourcePath(),
        commitWorkingFile: (blob, name, existingPath) => (
            controller.commit(blob, name, existingPath, publish)
        ),
    };
}

export function createWorkingArtifactController(
    initial: WorkingArtifact,
    io: WorkingArtifactIo,
): WorkingArtifactController {
    let current = initial;
    let cachedPathBytes: Promise<Uint8Array> | null = null;

    return {
        get current() {
            return current;
        },

        toFile() {
            return fileFromArtifact(current);
        },

        async getBytes() {
            if (current.kind === 'bytes') return current.bytes;
            // Một step đôi khi hỏi bytes nhiều lần. Chỉ đọc path đúng một lần cho
            // revision hiện tại; commit tiếp theo sẽ hủy cache này.
            cachedPathBytes ??= io.readPath(current);
            return cachedPathBytes;
        },

        async getSourcePath() {
            return current.kind === 'path' ? current.path : undefined;
        },

        async commit(blob, name, existingPath, publish) {
            const mimeType = blob.type || 'application/pdf';
            const artifactLeaseToken = readArtifactLeaseToken(blob);
            let next: WorkingArtifact;
            let pendingPathSize: Promise<number | undefined> | null = null;

            if (existingPath) {
                // Path backend mới là nguồn chân lý; tuyệt đối không đọc carrier.
                next = {
                    kind: 'path',
                    name,
                    mimeType,
                    path: existingPath,
                    ...(artifactLeaseToken ? { artifactLeaseToken } : {}),
                };
                if (io.statPath) {
                    // Chạy song song với publish để không cộng thêm một lượt stat
                    // vào thời gian mỗi Step; lỗi được hạ thành size chưa biết.
                    pendingPathSize = io.statPath(existingPath)
                        .then(normalizedSize)
                        .catch(() => undefined);
                }
            } else {
                next = {
                    kind: 'bytes',
                    name,
                    mimeType,
                    bytes: new Uint8Array(await blob.arrayBuffer()),
                    ...(artifactLeaseToken ? { artifactLeaseToken } : {}),
                };
            }

            // Chỉ công bố revision mới sau khi workspace đã commit thành công.
            // Nếu publish lỗi, bước kế vẫn phải nhìn thấy artifact cũ.
            await publish(blob, name, existingPath);

            if (next.kind === 'path' && pendingPathSize) {
                const size = await pendingPathSize;
                if (size !== undefined) next = { ...next, size };
            }

            current = next;
            cachedPathBytes = null;
        },
    };
}
