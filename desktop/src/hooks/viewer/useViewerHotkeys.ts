import { useEffect, useRef, useCallback, useContext } from 'react';
import { useWorkspaceStore, WorkspaceContext } from '../../stores/useWorkspaceStore';
import { useAppSettingsStore } from '../../stores/appSettingsStore';

/** Chống 2 listener (nhiều tab mount) toggle DIM 2 lần trong 1 cú nhấn → kẹt ON. */
let dimShortcutLockUntil = 0;

interface ViewerSnapshot {
    order: number[];
    selection: number[];
    lastSelected: number | null;
    rotations: Record<number, number>;
}

interface UseViewerHotkeysProps {
    containerRef: React.RefObject<HTMLDivElement | null>;
    sidebarRef: React.RefObject<HTMLDivElement | null>;
    /** Tab đang hiển thị? Ưu tiên hơn heuristic DOM (opacity-0). */
    isActive?: boolean;
    // Page state
    pageOrder: number[];
    selectedIndices: Set<number>;
    lastSelectedIndex: number | null;
    pageRotations: Record<number, number>;
    activePage: number;
    numPages: number;
    // State setters
    setPageOrder: React.Dispatch<React.SetStateAction<number[]>>;
    setSelectedIndices: React.Dispatch<React.SetStateAction<Set<number>>>;
    setLastSelectedIndex: React.Dispatch<React.SetStateAction<number | null>>;
    setPageRotations: React.Dispatch<React.SetStateAction<Record<number, number>>>;
    setActivePage: (p: number) => void;
    // Undo/Redo stacks
    pastStack: ViewerSnapshot[];
    futureStack: ViewerSnapshot[];
    setPastStack: React.Dispatch<React.SetStateAction<ViewerSnapshot[]>>;
    setFutureStack: React.Dispatch<React.SetStateAction<ViewerSnapshot[]>>;
    // Tool modes
    toolMode: 'pointer' | 'hand' | 'dimension';
    setToolMode: (m: 'pointer' | 'hand' | 'dimension') => void;
    isVdpMode: boolean;
    isThumbMenuOpen: boolean;
    isDeleteModalOpen: boolean;
    // Modal & sidebar controls
    setIsDeleteModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
    setIsExtractModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
    setIsInsertModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
    setExtractPagesStrForModal: React.Dispatch<React.SetStateAction<string>>;
    setContextMenu: React.Dispatch<React.SetStateAction<any>>;
    setIsSidebarOpen: (open: boolean) => void;
    // Guide system
    guides: any[];
    setGuides: React.Dispatch<React.SetStateAction<any[]>>;
    guidesHistory: any[][];
    setGuidesHistory: React.Dispatch<React.SetStateAction<any[][]>>;
    selectedGuideId: string | null;
    setSelectedGuideId: React.Dispatch<React.SetStateAction<string | null>>;
    toggleRulers: () => void;
    // Navigation
    navigatePage: (newPage: number) => void;
    // Virtuoso ref
    mainVirtuosoRef: React.RefObject<any>;
    internalScrollRef: React.MutableRefObject<HTMLElement | null>;
    // Object Edit Mode: Ctrl+Z/Ctrl+Y hoàn tác/làm lại thao tác edit-object.
    isObjectEditMode?: boolean;
    onEditUndo?: () => boolean | void;
    onEditRedo?: () => boolean | void;
    /** Hoàn tác file đã xử lý khi không còn thao tác trang nào để hoàn tác. */
    onDocumentUndo?: () => void;
}

export function useViewerHotkeys(props: UseViewerHotkeysProps) {
    const {
        containerRef, sidebarRef, isActive = true,
        pageOrder, selectedIndices, lastSelectedIndex, pageRotations, activePage, numPages,
        setPageOrder, setSelectedIndices, setLastSelectedIndex, setPageRotations, setActivePage,
        pastStack, futureStack, setPastStack, setFutureStack,
        toolMode, setToolMode, isVdpMode, isThumbMenuOpen, isDeleteModalOpen,
        setIsDeleteModalOpen, setIsExtractModalOpen, setIsInsertModalOpen, setExtractPagesStrForModal, setContextMenu,
        setIsSidebarOpen,
        guides, setGuides, guidesHistory, setGuidesHistory, selectedGuideId, setSelectedGuideId, toggleRulers,
        navigatePage,
        mainVirtuosoRef, internalScrollRef,
        isObjectEditMode, onEditUndo, onEditRedo, onDocumentUndo,
    } = props;

    const prevToolModeRef = useRef<'pointer' | 'hand' | 'dimension'>('pointer');
    const toolModeRef = useRef(toolMode);
    useEffect(() => { toolModeRef.current = toolMode; }, [toolMode]);
    const setToolModeRef = useRef(setToolMode);
    useEffect(() => { setToolModeRef.current = setToolMode; }, [setToolMode]);
    const toggleRulersRef = useRef(toggleRulers);
    useEffect(() => { toggleRulersRef.current = toggleRulers; }, [toggleRulers]);
    const isActiveRef = useRef(isActive);
    useEffect(() => { isActiveRef.current = isActive; }, [isActive]);
    const isSpacebarHeldRef = useRef(false);
    const spaceStartedInCropRef = useRef(false);
    const spacePressTimeRef = useRef<number>(0);
    const guidesRef = useRef(guides);
    useEffect(() => { guidesRef.current = guides; }, [guides]);

    // Tab active?
    // 1) isActive=false → chắc chắn bỏ qua (không stopPropagation).
    // 2) Defense: ancestor .opacity-0 (shell tab nền) — kể cả khi caller quên truyền isActive.
    // 3) Không bắt buộc containerRef (canvas chỉ có khi numPages>0; toolbar vẫn cần phím D).
    const isViewerLive = useCallback(() => {
        if (!isActiveRef.current) return false;
        const root = containerRef.current || sidebarRef.current;
        if (root?.closest('.opacity-0')) return false;
        return true;
    }, [containerRef, sidebarRef]);

    // Store API per-tab (context) — dùng getState() trong hotkey để không stale.
    const workspaceStore = useContext(WorkspaceContext);

    // F7 rewire: hook chạy TRONG WorkspaceContext.Provider nên lấy setter/isCropMode
    // qua selector (KHÔNG dùng useWorkspaceStore.getState() — store per-Provider, không
    // có global getState). Handler F7 là listener singleton document-level đăng ký MỘT
    // lần → đọc isCropMode qua ref để luôn thấy giá trị mới nhất, tránh stale closure.
    const setIsObjectEditMode = useWorkspaceStore(s => s.setIsObjectEditMode);
    const isCropMode = useWorkspaceStore(s => s.isCropMode);
    const setIsCropMode = useWorkspaceStore(s => s.setIsCropMode);
    const isCropModeRef = useRef(isCropMode);
    useEffect(() => { isCropModeRef.current = isCropMode; }, [isCropMode]);
    const setIsObjectEditModeRef = useRef(setIsObjectEditMode);
    useEffect(() => { setIsObjectEditModeRef.current = setIsObjectEditMode; }, [setIsObjectEditMode]);
    const setIsCropModeRef = useRef(setIsCropMode);
    useEffect(() => { setIsCropModeRef.current = setIsCropMode; }, [setIsCropMode]);

    // Helper: commit snapshot for undo
    const commitSnapshot = useCallback(() => {
        setPastStack(prev => [...prev, {
            order: [...pageOrder],
            selection: Array.from(selectedIndices),
            lastSelected: lastSelectedIndex,
            rotations: { ...pageRotations }
        }]);
        setFutureStack([]);
    }, [pageOrder, selectedIndices, lastSelectedIndex, pageRotations, setPastStack, setFutureStack]);

    const undo = useCallback(() => {
        if (pastStack.length === 0) {
            onDocumentUndo?.();
            return;
        }
        const prev = pastStack[pastStack.length - 1];
        const newPast = pastStack.slice(0, -1);

        setFutureStack(prevFuture => [{
            order: pageOrder,
            selection: Array.from(selectedIndices),
            lastSelected: lastSelectedIndex,
            rotations: pageRotations
        }, ...prevFuture]);

        setPastStack(newPast);
        setPageOrder(prev.order);
        setSelectedIndices(new Set(prev.selection));
        setLastSelectedIndex(prev.lastSelected);
        setPageRotations(prev.rotations);
    }, [pastStack, pageOrder, selectedIndices, lastSelectedIndex, pageRotations, setPastStack, setFutureStack, setPageOrder, setSelectedIndices, setLastSelectedIndex, setPageRotations, onDocumentUndo]);

    const redo = useCallback(() => {
        if (futureStack.length === 0) return;
        const next = futureStack[0];
        const newFuture = futureStack.slice(1);

        setPastStack(prevPast => [...prevPast, {
            order: pageOrder,
            selection: Array.from(selectedIndices),
            lastSelected: lastSelectedIndex,
            rotations: pageRotations
        }]);

        setFutureStack(newFuture);
        setPageOrder(next.order);
        setSelectedIndices(new Set(next.selection));
        setLastSelectedIndex(next.lastSelected);
        setPageRotations(next.rotations);
    }, [futureStack, pageOrder, selectedIndices, lastSelectedIndex, pageRotations, setPastStack, setFutureStack, setPageOrder, setSelectedIndices, setLastSelectedIndex, setPageRotations]);

    // True khi IME (Unikey/Telex…) đang compose — không chạy hotkey.
    // Telex "dd"→"đ" hay phát Backspace giả; nếu hotkey xóa trang bắt Backspace
    // thì bấm D lần 2 (tắt DIM) sẽ mở nhầm popup xóa trang.
    const isImeNoise = (e: KeyboardEvent) => e.isComposing || e.keyCode === 229;

    // Guide hotkeys (Ctrl+R, Ctrl+Z for guides, Delete guide)
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (isImeNoise(e)) return;
            if (!isViewerLive()) return;
            if (isCropModeRef.current) return;

            if (e.ctrlKey && (e.code === 'KeyR' || e.key.toLowerCase() === 'r')) {
                e.preventDefault();
                toggleRulersRef.current();
                return;
            }

            if (e.ctrlKey && (e.code === 'KeyZ' || e.key.toLowerCase() === 'z')) {
                if (guidesHistory.length > 0) {
                    e.preventDefault();
                    const prevGuides = guidesHistory[guidesHistory.length - 1];
                    setGuides(prevGuides);
                    setGuidesHistory(prev => prev.slice(0, -1));
                    setSelectedGuideId(null);
                }
                return;
            }

            // Xóa guide: Delete hoặc Backspace — chỉ khi đã chọn guide (không phải xóa trang).
            if ((e.code === 'Delete' || e.code === 'Backspace') && selectedGuideId) {
                if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) {
                    return;
                }
                e.preventDefault();
                setGuidesHistory(prev => [...prev, guides]);
                setGuides(prev => prev.filter(g => g.id !== selectedGuideId));
                setSelectedGuideId(null);
                return;
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isViewerLive, guidesHistory, guides, selectedGuideId, setGuides, setGuidesHistory, setSelectedGuideId]);

    // F7 → bật/tắt Object Edit Mode (gộp F7 Layer Panel vào Edit PDF: một panel
    // thống nhất). ĐĂNG KÝ PER-INSTANCE + guard tab active (giống handler chính bên
    // dưới) thay vì singleton global cũ: vì giờ gọi setIsObjectEditMode của ĐÚNG
    // Provider này, nếu singleton do tab nền đăng ký sẽ toggle nhầm store tab khác.
    useEffect(() => {
        const handleF7 = (e: KeyboardEvent) => {
            if (e.key !== 'F7') return;
            if (isImeNoise(e)) return;
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
            if (!isViewerLive()) return;
            // Đang Crop → bỏ qua F7 (tránh mở edit mode chồng lên crop).
            if (isCropModeRef.current) return;
            e.preventDefault();
            setIsObjectEditModeRef.current(v => {
                const next = !v;
                // Panel Edit render TRONG khối {isSidebarOpen && ...} của ImpositionTab
                // → nếu sidebar phải đang đóng, bật edit mode mà KHÔNG thấy panel. Khi
                // BẬT → mở sidebar luôn để panel hiện ngay (LayerPanel cũ nổi độc lập
                // nên không cần; nay gộp vào Edit PDF thì phải tự mở). useAppSettingsStore
                // là store GLOBAL (create) nên gọi getState() hợp lệ ngoài React.
                if (next) useAppSettingsStore.getState().setWorkspaceSidebarOpen(true);
                return next;
            });
        };
        document.addEventListener('keydown', handleF7, true);
        return () => document.removeEventListener('keydown', handleF7, true);
    }, [isViewerLive]);

    // D = DIM bật/tắt. Capture phase + isActive.
    // Đọc mode từ store.getState() (không tin ref stale) → D lần 2 chắc chắn TẮT.
    useEffect(() => {
        const handleDimensionShortcut = (e: KeyboardEvent) => {
            if (e.code !== 'KeyD') return;
            if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
            const target = e.target as HTMLElement | null;
            if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) return;
            // Tab nền: bỏ qua, KHÔNG stopPropagation — để tab active nhận sự kiện.
            if (!isViewerLive()) return;
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            if (e.repeat) return;
            // Hai listener cùng tab/cùng event (Strict Mode / multi-mount) → khóa 120ms.
            const now = Date.now();
            if (now < dimShortcutLockUntil) return;
            dimShortcutLockUntil = now + 120;

            const storeApi = workspaceStore;
            const current = storeApi?.getState().viewerToolMode ?? toolModeRef.current;
            const next = current === 'dimension' ? 'pointer' : 'dimension';
            toolModeRef.current = next;
            if (storeApi) {
                storeApi.getState().setViewerToolMode(next);
                if (next === 'dimension') {
                    storeApi.getState().setIsObjectEditMode(false);
                    storeApi.getState().setIsCropMode(false);
                }
            } else {
                setToolModeRef.current(next);
                if (next === 'dimension') {
                    setIsObjectEditModeRef.current(false);
                    setIsCropModeRef.current(false);
                }
            }
            if (next === 'dimension' && !useAppSettingsStore.getState().showRulers) {
                toggleRulersRef.current();
            }
            // Rời focus khỏi nút toolbar (tránh Space/Enter kích hoạt nhầm sau đó).
            if (document.activeElement instanceof HTMLElement) {
                const tag = document.activeElement.tagName;
                if (tag === 'BUTTON' || tag === 'A') document.activeElement.blur();
            }
        };
        window.addEventListener('keydown', handleDimensionShortcut, true);
        return () => window.removeEventListener('keydown', handleDimensionShortcut, true);
    }, [isViewerLive, workspaceStore]);

    // Global keyboard commands (Undo/Redo, Delete, Extract, Spacebar)
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (isImeNoise(e)) return;
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
            if (e.key === 'F7') return; // Handled by independent listener above
            // KeyD do handler DIM (capture) xử lý — không đụng nhánh khác.
            if (e.code === 'KeyD') return;

            if (!isViewerLive()) return;

            // Space temporarily switches to the hand tool even while Crop is active.
            // Handling this before the Crop guard prevents the shortcut from being swallowed.
            if (e.code === 'Space') {
                e.preventDefault();
                if (!e.repeat && !isSpacebarHeldRef.current) {
                    const currentMode = workspaceStore?.getState().viewerToolMode ?? toolModeRef.current;
                    isSpacebarHeldRef.current = true;
                    spaceStartedInCropRef.current = isCropModeRef.current;
                    spacePressTimeRef.current = Date.now();
                    prevToolModeRef.current = currentMode;
                    toolModeRef.current = 'hand';
                    if (workspaceStore) workspaceStore.getState().setViewerToolMode('hand');
                    else setToolModeRef.current('hand');
                }
                return;
            }

            if (isCropModeRef.current) {
                const key = e.key.toLowerCase();
                if ((e.ctrlKey || e.metaKey) && (key === 'z' || key === 'y')) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    const cropState = workspaceStore?.getState();
                    if (key === 'y' || e.shiftKey) cropState?.redoCropSelection();
                    else cropState?.undoCropSelection();
                }
                return;
            }

            if (e.ctrlKey || e.metaKey) {
                // Khi đang ở chế độ VDP, undo/redo do useVdpHistory xử lý (capture-phase).
                if (isVdpMode) return;
                // Chế độ chỉnh sửa đối tượng → Ctrl+Z/Y hoàn tác/làm lại edit-object
                // (move/delete/rotate...), KHÔNG đụng undo thao tác trang.
                if (isObjectEditMode && (onEditUndo || onEditRedo)) {
                    if (e.key.toLowerCase() === 'z') {
                        e.preventDefault();
                        if (e.shiftKey) onEditRedo?.(); else onEditUndo?.();
                        return;
                    }
                    if (e.key.toLowerCase() === 'y') {
                        e.preventDefault();
                        onEditRedo?.();
                        return;
                    }
                }
                if (e.key.toLowerCase() === 'z') {
                    e.preventDefault();
                    if (e.shiftKey) redo(); else undo();
                } else if (e.key.toLowerCase() === 'y') {
                    e.preventDefault();
                    redo();
                }

            } else if (e.code === 'Delete') {
                // CHỈ phím Delete vật lý mở xóa trang.
                // KHÔNG bắt Backspace: IME Telex (Unikey) khi gõ D/đ thường phát Backspace
                // → trước đây bấm D lần 2 (tắt DIM) lại mở popup xóa trang.
                if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
                if (isObjectEditMode || isVdpMode) return;
                // Xóa khi có trang đang chọn trong thumbnail. Không phụ thuộc focus
                // (trước đây yêu cầu focus nằm trong sidebar nên Delete hay bị chặn
                // im lặng khi con trỏ ở vùng trang chính). Tab nền đã bị guard ở trên.
                if (selectedIndices.size === 0) return;
                e.preventDefault();
                setIsDeleteModalOpen(true);
            } else if (e.code === 'KeyE') {
                e.preventDefault();
                const sortedSel = Array.from(selectedIndices).sort((a, b) => a - b).map(i => i + 1);
                let str = sortedSel.length > 0 ? sortedSel.join(', ') : '';
                setExtractPagesStrForModal(str);
                setIsExtractModalOpen(true);
            }
        };

        const restoreToolAfterSpace = () => {
            if (!isSpacebarHeldRef.current) return false;
            isSpacebarHeldRef.current = false;
            const previousMode = prevToolModeRef.current;
            spaceStartedInCropRef.current = false;
            toolModeRef.current = previousMode;
            if (workspaceStore) workspaceStore.getState().setViewerToolMode(previousMode);
            else setToolModeRef.current(previousMode);
            return true;
        };

        const handleKeyUp = (e: KeyboardEvent) => {
            if (isImeNoise(e)) return;
            // Always release a temporary hand tool, even if focus/tab changed while Space was held.
            if (e.code === 'Space' && isSpacebarHeldRef.current) {
                e.preventDefault();
                const startedInCrop = spaceStartedInCropRef.current;
                restoreToolAfterSpace();

                // A quick Space tap in Crop is still a pan gesture, never page navigation.
                if (!startedInCrop && Date.now() - spacePressTimeRef.current < 250) {
                    if (e.shiftKey) {
                        navigatePage(activePage - 1);
                    } else {
                        navigatePage(activePage + 1);
                    }
                }
                return;
            }
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
            if (!isViewerLive()) return;
        };

        document.addEventListener('keydown', handleKeyDown);
        document.addEventListener('keyup', handleKeyUp);
        window.addEventListener('blur', restoreToolAfterSpace);
        return () => {
            document.removeEventListener('keydown', handleKeyDown);
            document.removeEventListener('keyup', handleKeyUp);
            window.removeEventListener('blur', restoreToolAfterSpace);
        };
    }, [isViewerLive, selectedIndices, activePage, undo, redo, isVdpMode, isObjectEditMode, onEditUndo, onEditRedo, navigatePage, setIsDeleteModalOpen, setExtractPagesStrForModal, setIsExtractModalOpen, workspaceStore]);

    // Restore only when this viewer really unmounts. The keyboard-listener effect above
    // can restart while panning (for example when activePage changes during the drag).
    useEffect(() => () => {
        if (!isSpacebarHeldRef.current) return;
        isSpacebarHeldRef.current = false;
        spaceStartedInCropRef.current = false;
        const previousMode = prevToolModeRef.current;
        toolModeRef.current = previousMode;
        if (workspaceStore) workspaceStore.getState().setViewerToolMode(previousMode);
        else setToolModeRef.current(previousMode);
    }, [workspaceStore]);


    // Escape: đóng modal + thoát DIM (nếu đang bật)
    useEffect(() => {
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            if (!isViewerLive()) return;
            setIsInsertModalOpen(false);
            setIsExtractModalOpen(false);
            setIsDeleteModalOpen(false);
            setContextMenu(null);
            const mode = workspaceStore?.getState().viewerToolMode ?? toolModeRef.current;
            if (mode === 'dimension') {
                toolModeRef.current = 'pointer';
                if (workspaceStore) workspaceStore.getState().setViewerToolMode('pointer');
                else setToolModeRef.current('pointer');
            }
        };
        document.addEventListener('keydown', handleEscape);
        return () => document.removeEventListener('keydown', handleEscape);
    }, [isViewerLive, workspaceStore, setIsInsertModalOpen, setIsExtractModalOpen, setIsDeleteModalOpen, setContextMenu]);

    return { commitSnapshot, undo, redo };
}
