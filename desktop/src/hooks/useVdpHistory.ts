/**
 * useVdpHistory — Undo/Redo (Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z) cho các thao tác
 * trên VDP fields (tạo, di chuyển, phóng to/thu nhỏ, xóa, nhóm, đổi thuộc tính...).
 *
 * Cơ chế "coalesce": các thay đổi liên tiếp trong một khoảng ngắn (vd kéo resize)
 * được gộp thành MỘT bước undo, nên Ctrl+Z trả về trạng thái trước cả thao tác đó.
 *
 * Khi đang ở chế độ VDP, handler này chạy ở capture-phase + stopPropagation để
 * ưu tiên hơn undo/redo của thao tác trang (useViewerHotkeys).
 */
import { useCallback, useEffect, useRef } from 'react';

type VdpFieldsUpdater<TField> = TField[] | ((previous: TField[]) => TField[]);

interface Options<TField> {
    vdpFields: TField[];
    setVdpFields: (updater: VdpFieldsUpdater<TField>) => void;
    enabled: boolean;
    containerRef: React.RefObject<HTMLElement | null>;
}

const COALESCE_MS = 400;
const MAX_HISTORY = 100;

export function useVdpHistory<TField>({ vdpFields, setVdpFields, enabled, containerRef }: Options<TField>) {
    const pastRef = useRef<TField[][]>([]);
    const futureRef = useRef<TField[][]>([]);
    const prevRef = useRef<TField[]>(vdpFields);
    const burstBaseRef = useRef<TField[] | null>(null);
    const burstTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const skipRef = useRef(false);

    // Ghi lịch sử khi vdpFields đổi (gộp các thay đổi liên tiếp).
    useEffect(() => {
        if (skipRef.current) {
            // Thay đổi đến từ undo/redo → không ghi lại.
            skipRef.current = false;
            prevRef.current = vdpFields;
            return;
        }
        if (vdpFields === prevRef.current) return;

        if (burstBaseRef.current === null) {
            burstBaseRef.current = prevRef.current;
        }
        if (burstTimerRef.current) clearTimeout(burstTimerRef.current);
        burstTimerRef.current = setTimeout(() => {
            if (burstBaseRef.current !== null) {
                pastRef.current.push(burstBaseRef.current);
                if (pastRef.current.length > MAX_HISTORY) pastRef.current.shift();
                futureRef.current = [];
                burstBaseRef.current = null;
            }
            burstTimerRef.current = null;
        }, COALESCE_MS);

        prevRef.current = vdpFields;
    }, [vdpFields]);

    const flushBurst = () => {
        if (burstTimerRef.current) {
            clearTimeout(burstTimerRef.current);
            burstTimerRef.current = null;
        }
        if (burstBaseRef.current !== null) {
            pastRef.current.push(burstBaseRef.current);
            if (pastRef.current.length > MAX_HISTORY) pastRef.current.shift();
            futureRef.current = [];
            burstBaseRef.current = null;
        }
    };

    const undo = useCallback(() => {
        flushBurst();
        if (pastRef.current.length === 0) return;
        const prev = pastRef.current.pop()!;
        futureRef.current.unshift(prevRef.current);
        skipRef.current = true;
        prevRef.current = prev;
        setVdpFields(prev);
    }, [setVdpFields]);

    const redo = useCallback(() => {
        if (futureRef.current.length === 0) return;
        const next = futureRef.current.shift()!;
        pastRef.current.push(prevRef.current);
        skipRef.current = true;
        prevRef.current = next;
        setVdpFields(next);
    }, [setVdpFields]);

    useEffect(() => {
        if (!enabled) return;
        const handler = (e: KeyboardEvent) => {
            if (e.target instanceof HTMLInputElement ||
                e.target instanceof HTMLTextAreaElement ||
                e.target instanceof HTMLSelectElement) return;
            if (!containerRef.current || containerRef.current.offsetParent === null) return;
            if (containerRef.current.closest('.opacity-0')) return;
            if (e.ctrlKey || e.metaKey) {
                const k = e.key.toLowerCase();
                if (k === 'z') {
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.shiftKey) redo(); else undo();
                } else if (k === 'y') {
                    e.preventDefault();
                    e.stopPropagation();
                    redo();
                }
            }
        };
        // capture-phase: chạy trước handler undo-trang (bubble) và chặn lan truyền.
        window.addEventListener('keydown', handler, true);
        return () => window.removeEventListener('keydown', handler, true);
    }, [enabled, undo, redo, containerRef]);
}
