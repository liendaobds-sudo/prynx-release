import { useEffect, useRef, useCallback } from 'react';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { useAppSettingsStore } from '../../stores/appSettingsStore';

interface ViewerSnapshot {
    order: number[];
    selection: number[];
    lastSelected: number | null;
    rotations: Record<number, number>;
}

interface UseViewerHotkeysProps {
    containerRef: React.RefObject<HTMLDivElement | null>;
    sidebarRef: React.RefObject<HTMLDivElement | null>;
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
    toolMode: 'pointer' | 'hand';
    setToolMode: (m: 'pointer' | 'hand') => void;
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
}

export function useViewerHotkeys(props: UseViewerHotkeysProps) {
    const {
        containerRef, sidebarRef,
        pageOrder, selectedIndices, lastSelectedIndex, pageRotations, activePage, numPages,
        setPageOrder, setSelectedIndices, setLastSelectedIndex, setPageRotations, setActivePage,
        pastStack, futureStack, setPastStack, setFutureStack,
        toolMode, setToolMode, isVdpMode, isThumbMenuOpen, isDeleteModalOpen,
        setIsDeleteModalOpen, setIsExtractModalOpen, setIsInsertModalOpen, setExtractPagesStrForModal, setContextMenu,
        setIsSidebarOpen,
        guides, setGuides, guidesHistory, setGuidesHistory, selectedGuideId, setSelectedGuideId, toggleRulers,
        navigatePage,
        mainVirtuosoRef, internalScrollRef,
        isObjectEditMode, onEditUndo, onEditRedo,
    } = props;

    const prevToolModeRef = useRef<'pointer' | 'hand'>('pointer');
    const isSpacebarHeldRef = useRef(false);
    const spacePressTimeRef = useRef<number>(0);
    const guidesRef = useRef(guides);
    useEffect(() => { guidesRef.current = guides; }, [guides]);

    // F7 rewire: hook chạy TRONG WorkspaceContext.Provider nên lấy setter/isCropMode
    // qua selector (KHÔNG dùng useWorkspaceStore.getState() — store per-Provider, không
    // có global getState). Handler F7 là listener singleton document-level đăng ký MỘT
    // lần → đọc isCropMode qua ref để luôn thấy giá trị mới nhất, tránh stale closure.
    const setIsObjectEditMode = useWorkspaceStore(s => s.setIsObjectEditMode);
    const isCropMode = useWorkspaceStore(s => s.isCropMode);
    const isCropModeRef = useRef(isCropMode);
    useEffect(() => { isCropModeRef.current = isCropMode; }, [isCropMode]);
    const setIsObjectEditModeRef = useRef(setIsObjectEditMode);
    useEffect(() => { setIsObjectEditModeRef.current = setIsObjectEditMode; }, [setIsObjectEditMode]);

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
        if (pastStack.length === 0) return;
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
    }, [pastStack, pageOrder, selectedIndices, lastSelectedIndex, pageRotations, setPastStack, setFutureStack, setPageOrder, setSelectedIndices, setLastSelectedIndex, setPageRotations]);

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

    // Guide hotkeys (Ctrl+R, Ctrl+Z for guides, Delete guide)
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!containerRef.current || containerRef.current.offsetParent === null) return;
            // Ignore events if this viewer is in a background tab (which has opacity-0)
            if (containerRef.current.closest('.opacity-0')) return;

            if (e.ctrlKey && (e.code === 'KeyR' || e.key.toLowerCase() === 'r')) {
                e.preventDefault();
                toggleRulers();
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

            if ((e.key === 'Delete' || e.key === 'Backspace') && selectedGuideId) {
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
    }, [toggleRulers, guidesHistory, guides, selectedGuideId]);

    // F7 → bật/tắt Object Edit Mode (gộp F7 Layer Panel vào Edit PDF: một panel
    // thống nhất). ĐĂNG KÝ PER-INSTANCE + guard tab active (giống handler chính bên
    // dưới) thay vì singleton global cũ: vì giờ gọi setIsObjectEditMode của ĐÚNG
    // Provider này, nếu singleton do tab nền đăng ký sẽ toggle nhầm store tab khác.
    useEffect(() => {
        const handleF7 = (e: KeyboardEvent) => {
            if (e.key !== 'F7') return;
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
            // Chỉ tab đang hiện xử lý (tab nền dùng opacity-0, vẫn display:flex).
            if (!containerRef.current || containerRef.current.offsetParent === null) return;
            if (containerRef.current.closest('.opacity-0')) return;
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
    }, [containerRef, setIsObjectEditMode]);

    // Global keyboard commands (Undo/Redo, Delete, Extract, Spacebar)
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
            if (e.key === 'F7') return; // Handled by independent listener above

            // Bỏ qua nếu viewer này thuộc tab nền. offsetParent chỉ null khi display:none,
            // nhưng tab nền dùng opacity-0 (vẫn display:flex) nên cần check thêm .opacity-0.
            if (!containerRef.current || containerRef.current.offsetParent === null) return;
            if (containerRef.current.closest('.opacity-0')) return;

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
            } else if (e.key === 'Delete' || e.key === 'Backspace') {
                if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
                if (isObjectEditMode || isVdpMode) return;
                // Xóa khi có trang đang chọn trong thumbnail. Không phụ thuộc focus
                // (trước đây yêu cầu focus nằm trong sidebar nên Delete hay bị chặn
                // im lặng khi con trỏ ở vùng trang chính). Tab nền đã bị guard ở trên.
                if (selectedIndices.size === 0) return;
                e.preventDefault();
                setIsDeleteModalOpen(true);
            } else if (e.key === 'e') {
                e.preventDefault();
                const sortedSel = Array.from(selectedIndices).sort((a, b) => a - b).map(i => i + 1);
                let str = sortedSel.length > 0 ? sortedSel.join(', ') : '';
                setExtractPagesStrForModal(str);
                setIsExtractModalOpen(true);
            } else if (e.code === 'Space') {
                if (!e.repeat) {
                    e.preventDefault();
                    if (!isSpacebarHeldRef.current) {
                        isSpacebarHeldRef.current = true;
                        spacePressTimeRef.current = Date.now();
                        prevToolModeRef.current = toolMode;
                        setToolMode('hand');
                    }
                } else {
                    e.preventDefault();
                }
            }
        };

        const handleKeyUp = (e: KeyboardEvent) => {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
            if (!containerRef.current || containerRef.current.offsetParent === null) return;
            if (containerRef.current.closest('.opacity-0')) return;
            if (e.code === 'Space') {
                e.preventDefault();
                isSpacebarHeldRef.current = false;
                setToolMode(prevToolModeRef.current);

                if (Date.now() - spacePressTimeRef.current < 250) {
                    if (e.shiftKey) {
                        navigatePage(activePage - 1);
                    } else {
                        navigatePage(activePage + 1);
                    }
                }
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        document.addEventListener('keyup', handleKeyUp);
        return () => {
            document.removeEventListener('keydown', handleKeyDown);
            document.removeEventListener('keyup', handleKeyUp);
        };
    }, [pastStack, futureStack, pageOrder, selectedIndices, lastSelectedIndex, pageRotations, toolMode, isThumbMenuOpen, isDeleteModalOpen, activePage, numPages, undo, redo, isVdpMode, isObjectEditMode, onEditUndo, onEditRedo]);

    // Escape key closes modals
    useEffect(() => {
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setIsInsertModalOpen(false);
                setIsExtractModalOpen(false);
                setIsDeleteModalOpen(false);
                setContextMenu(null);
            }
        };
        document.addEventListener('keydown', handleEscape);
        return () => document.removeEventListener('keydown', handleEscape);
    }, []);

    return { commitSnapshot, undo, redo };
}
