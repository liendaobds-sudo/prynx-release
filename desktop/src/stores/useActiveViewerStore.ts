import { create } from 'zustand';

/**
 * Trạng thái hiển thị của viewer ĐANG ACTIVE — bản sao toàn cục, chỉ-đọc với shell.
 *
 * VÌ SAO CẦN: state thật của viewer nằm trong `useWorkspaceStore` được tạo MỖI TAB
 * một instance (createWorkspaceStore + Provider), nên `App.tsx` — ở ngoài Provider —
 * không có cách nào đọc "tab đang xem đang ở chế độ trang nào". Hệ quả (audit menu
 * 2026-07-28 §MB.5): menu Xem không tick được mục đang chọn, người dùng không biết
 * mình đang ở "Xem một trang" hay "Cuộn hai trang".
 *
 * CHỈ chứa những trường thanh menu cần và ĐỔI THƯA. Cố tình KHÔNG đưa activePage /
 * selectedIndices vào đây: chúng đổi liên tục khi cuộn (file vài nghìn trang) →
 * shell sẽ render lại theo từng trang, đúng loại hồi quy hiệu năng mà audit trước
 * đã dặn tránh. Mục "Trang trước/sau" không cần biết trang hiện tại vì
 * `navigatePage` tự kẹp biên và tự bỏ qua khi chưa có trang nào.
 */
export interface ActiveViewerSnapshot {
    /** Tab đang phát trạng thái này (để shell biết dữ liệu thuộc tab nào). */
    tabId: string | null;
    pageDisplayMode: 'single_fit' | 'single_scroll' | 'two_fit' | 'two_scroll';
    fitMode: 'width' | 'page' | 'custom' | 'smart';
    numPages: number;
}

interface ActiveViewerStore extends ActiveViewerSnapshot {
    /** Viewer active gọi mỗi khi một trong các trường trên đổi. */
    publish: (snapshot: ActiveViewerSnapshot) => void;
    /** Không còn viewer nào đang xem (đóng tab cuối) → về mặc định. */
    reset: () => void;
}

const DEFAULT_SNAPSHOT: ActiveViewerSnapshot = {
    tabId: null,
    pageDisplayMode: 'single_fit',
    fitMode: 'smart',
    numPages: 0,
};

export const useActiveViewerStore = create<ActiveViewerStore>()((set) => ({
    ...DEFAULT_SNAPSHOT,
    publish: (snapshot) => set(snapshot),
    reset: () => set(DEFAULT_SNAPSHOT),
}));
