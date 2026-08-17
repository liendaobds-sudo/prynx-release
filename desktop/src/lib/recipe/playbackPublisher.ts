/**
 * playbackPublisher — quản vòng đời revision hiển thị TRONG MỘT lượt Phát Recipe.
 *
 * RECIPE (audit 2026-08-17 §PLAY.13/§PLAY.14): trước đây playback dùng thẳng
 * `commitWorkingFile` cho từng bước. Vì `playRecipe` chạy tuần tự không re-render
 * giữa các bước nên closure `base` giữ `file`/`pdfUrl` của thời điểm bắt đầu:
 *  - mỗi bước đẩy CÙNG một revision gốc vào history ⇒ Undo phải bấm N lần (§PLAY.13);
 *  - `revokeObjectURL` luôn thu hồi URL đầu tiên ⇒ các blob URL trung gian rò lại,
 *    mỗi bước một bản PDF đầy đủ trong RAM WebView (§PLAY.14).
 *
 * Module thuần này KHÔNG đụng React/DOM trực tiếp — nhận các phụ thuộc qua deps để
 * test trọn vẹn. Bất biến:
 *  - Chỉ MỘT blob URL trung gian sống tại một thời điểm: publish mới thu hồi URL blob
 *    trước đó; nhánh path native thu hồi blob URL còn treo.
 *  - Không tự thu hồi URL gốc trước lượt phát (thuộc state tab); nếu phát lỗi giữa
 *    chừng, revision cuối vẫn dùng được.
 *  - KHÔNG đẩy history mỗi bước — caller đẩy đúng MỘT entry trước vòng lặp để Undo
 *    thu gọn cả lượt phát về đúng revision trước khi phát.
 */

export interface PlaybackRevision {
    file: File;
    url: string;
    name: string;
    path?: string;
}

export interface PlaybackPublisherDeps {
    createObjectUrl: (blob: Blob) => string;
    revokeObjectUrl: (url: string) => void;
    localFileUrl: (path: string) => string;
    /** Cập nhật viewer sang revision mới nhất (setFile/setPdfUrl/setOriginalFileName…). */
    onRevision: (revision: PlaybackRevision) => void;
}

export interface PlaybackPublisher {
    /** Chữ ký khớp `ProcessContext['commitWorkingFile']` để dùng làm publish. */
    publish: (blob: Blob, name: string, existingPath?: string) => void | Promise<void>;
    /** Blob URL trung gian đang sống (null nếu revision hiện tại là path native). */
    readonly currentObjectUrl: string | null;
}

export function createPlaybackPublisher(deps: PlaybackPublisherDeps): PlaybackPublisher {
    let currentObjectUrl: string | null = null;

    const publish = (blob: Blob, name: string, existingPath?: string): void => {
        const file = new File([blob as BlobPart], name, {
            type: blob.type || 'application/pdf',
        });
        if (existingPath) {
            Object.defineProperty(file, 'path', { value: existingPath, configurable: true });
        }

        let url: string;
        if (existingPath) {
            // Revision path native: dùng localFileUrl; thu hồi blob URL trung gian còn treo.
            url = deps.localFileUrl(existingPath);
            if (currentObjectUrl) {
                deps.revokeObjectUrl(currentObjectUrl);
                currentObjectUrl = null;
            }
        } else {
            url = deps.createObjectUrl(blob);
            // Chỉ giữ MỘT blob URL trung gian: thu hồi cái trước đó.
            if (currentObjectUrl) deps.revokeObjectUrl(currentObjectUrl);
            currentObjectUrl = url;
        }

        deps.onRevision({ file, url, name, path: existingPath });
    };

    return {
        publish,
        get currentObjectUrl() {
            return currentObjectUrl;
        },
    };
}
