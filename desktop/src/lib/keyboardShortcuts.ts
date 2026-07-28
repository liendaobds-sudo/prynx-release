export type ShortcutGroupId = 'general' | 'tools' | 'view' | 'pages';

interface ShortcutBinding {
    code?: string;
    key?: string;
    primary?: boolean;
    shift?: boolean;
    alt?: boolean;
    ignoreShift?: boolean;
}

export interface KeyboardShortcutDefinition {
    id: string;
    group: ShortcutGroupId;
    keys: readonly string[];
    descriptionKey: string;
    bindings: readonly ShortcutBinding[];
}

export const SHORTCUT_GROUPS: ReadonlyArray<{ id: ShortcutGroupId; labelKey: string }> = [
    { id: 'general', labelKey: 'shortcut_group_general' },
    { id: 'tools', labelKey: 'shortcut_group_tools' },
    { id: 'view', labelKey: 'shortcut_group_view' },
    { id: 'pages', labelKey: 'shortcut_group_pages' },
];

export const KEYBOARD_SHORTCUTS = [
    {
        id: 'global.new_document', group: 'general', keys: ['Ctrl', 'N'],
        descriptionKey: 'shortcut_new_document', bindings: [{ code: 'KeyN', primary: true }],
    },
    {
        id: 'global.open', group: 'general', keys: ['Ctrl', 'O'],
        descriptionKey: 'shortcut_open_file', bindings: [{ code: 'KeyO', primary: true }],
    },
    {
        id: 'global.save', group: 'general', keys: ['Ctrl', 'S'],
        descriptionKey: 'luu_xuat_file_pdf_hien_tai', bindings: [{ code: 'KeyS', primary: true }],
    },
    {
        id: 'global.save_as', group: 'general', keys: ['Ctrl', 'Shift', 'S'],
        descriptionKey: 'luu_de_file_save_as', bindings: [{ code: 'KeyS', primary: true, shift: true }],
    },
    {
        id: 'global.print', group: 'general', keys: ['Ctrl', 'P'],
        descriptionKey: 'shortcut_print', bindings: [{ code: 'KeyP', primary: true }],
    },
    {
        id: 'global.close_tab', group: 'general', keys: ['Ctrl', 'W'],
        descriptionKey: 'dong_tab_cong_cu_dang_mo', bindings: [{ code: 'KeyW', primary: true }],
    },
    {
        id: 'global.settings', group: 'general', keys: ['Ctrl', 'K'],
        descriptionKey: 'mo_dong_bang_cai_dat_nay', bindings: [{ code: 'KeyK', primary: true }],
    },
    {
        id: 'global.quit', group: 'general', keys: ['Alt', 'F4'],
        descriptionKey: 'thoat_phan_mem', bindings: [{ key: 'F4', alt: true }],
    },
    {
        id: 'viewer.escape_mode', group: 'tools', keys: ['Esc'],
        descriptionKey: 'shortcut_exit_mode', bindings: [{ key: 'Escape' }],
    },
    {
        id: 'viewer.pointer', group: 'tools', keys: ['V'],
        descriptionKey: 'shortcut_pointer', bindings: [{ code: 'KeyV' }],
    },
    {
        id: 'viewer.hand', group: 'tools', keys: ['H'],
        descriptionKey: 'shortcut_hand', bindings: [{ code: 'KeyH' }],
    },
    {
        id: 'viewer.temporary_hand', group: 'tools', keys: ['Space'],
        descriptionKey: 'shortcut_temporary_hand', bindings: [{ code: 'Space', ignoreShift: true }],
    },
    {
        id: 'viewer.crop', group: 'tools', keys: ['C'],
        descriptionKey: 'shortcut_crop', bindings: [{ code: 'KeyC' }],
    },
    {
        id: 'viewer.dimension', group: 'tools', keys: ['D'],
        // UIUX (audit 2026-07-27) fix bug user báo: bộ gõ Telex (UniKey/EVKey) chạy
        // toàn hệ thống biến "dd" thành "đ" — nhấn D lần 2 liên tiếp để TẮT DIM thì
        // sự kiện thật bị nuốt, browser nhận phím tổng hợp key='đ' (code rỗng) nên
        // binding KeyD không khớp → phải nhấn thêm mới tắt được. Nhận luôn 'đ' làm
        // binding thứ hai (ignoreShift để 'Đ' khi kẹt Shift cũng khớp).
        descriptionKey: 'shortcut_dimension', bindings: [{ code: 'KeyD' }, { key: 'đ', ignoreShift: true }],
    },
    {
        id: 'viewer.object_edit', group: 'tools', keys: ['F7'],
        descriptionKey: 'shortcut_object_edit', bindings: [{ key: 'F7' }],
    },
    {
        id: 'viewer.extract_pages', group: 'tools', keys: ['E'],
        descriptionKey: 'shortcut_extract_pages', bindings: [{ code: 'KeyE' }],
    },
    {
        id: 'viewer.delete_pages', group: 'tools', keys: ['Delete'],
        descriptionKey: 'shortcut_delete_pages', bindings: [{ code: 'Delete' }],
    },
    {
        id: 'viewer.toggle_rulers', group: 'tools', keys: ['Ctrl', 'R'],
        descriptionKey: 'shortcut_toggle_rulers', bindings: [{ code: 'KeyR', primary: true }],
    },
    {
        id: 'viewer.undo', group: 'tools', keys: ['Ctrl', 'Z'],
        descriptionKey: 'shortcut_undo', bindings: [{ code: 'KeyZ', primary: true }],
    },
    {
        id: 'viewer.redo', group: 'tools', keys: ['Ctrl', 'Y'],
        descriptionKey: 'shortcut_redo', bindings: [{ code: 'KeyY', primary: true }],
    },
    {
        id: 'view.fit_page', group: 'view', keys: ['Ctrl', '0'],
        descriptionKey: 'shortcut_fit_page', bindings: [{ code: 'Digit0', primary: true }, { code: 'Numpad0', primary: true }],
    },
    {
        id: 'view.actual_size', group: 'view', keys: ['Ctrl', '1'],
        descriptionKey: 'shortcut_actual_size', bindings: [{ code: 'Digit1', primary: true }, { code: 'Numpad1', primary: true }],
    },
    {
        id: 'view.fit_width', group: 'view', keys: ['Ctrl', '2'],
        descriptionKey: 'shortcut_fit_width', bindings: [{ code: 'Digit2', primary: true }, { code: 'Numpad2', primary: true }],
    },
    {
        id: 'view.zoom_in', group: 'view', keys: ['+'],
        descriptionKey: 'shortcut_zoom_in',
        bindings: [
            { key: '+', ignoreShift: true },
            { code: 'NumpadAdd', ignoreShift: true },
            { key: '+', primary: true, ignoreShift: true },
            { code: 'NumpadAdd', primary: true, ignoreShift: true },
        ],
    },
    {
        id: 'view.zoom_out', group: 'view', keys: ['-'],
        descriptionKey: 'shortcut_zoom_out',
        bindings: [
            { key: '-' },
            { code: 'NumpadSubtract' },
            { key: '-', primary: true },
            { code: 'NumpadSubtract', primary: true },
        ],
    },
    {
        id: 'pages.previous', group: 'pages', keys: ['Page Up'],
        descriptionKey: 'shortcut_previous_page', bindings: [{ code: 'PageUp' }],
    },
    {
        id: 'pages.next', group: 'pages', keys: ['Page Down'],
        descriptionKey: 'shortcut_next_page', bindings: [{ code: 'PageDown' }],
    },
    {
        id: 'pages.first', group: 'pages', keys: ['Home'],
        descriptionKey: 'shortcut_first_page', bindings: [{ code: 'Home' }],
    },
    {
        id: 'pages.last', group: 'pages', keys: ['End'],
        descriptionKey: 'shortcut_last_page', bindings: [{ code: 'End' }],
    },
    {
        id: 'pages.rotate_right', group: 'pages', keys: ['R'],
        descriptionKey: 'shortcut_rotate_right', bindings: [{ code: 'KeyR' }],
    },
    {
        id: 'pages.rotate_left', group: 'pages', keys: ['Shift', 'R'],
        descriptionKey: 'shortcut_rotate_left', bindings: [{ code: 'KeyR', shift: true }],
    },
    {
        id: 'pages.select_all', group: 'pages', keys: ['Ctrl', 'A'],
        descriptionKey: 'shortcut_select_all_pages', bindings: [{ code: 'KeyA', primary: true }],
    },
    {
        id: 'pages.clear_selection', group: 'pages', keys: ['Ctrl', 'Shift', 'A'],
        descriptionKey: 'shortcut_clear_page_selection', bindings: [{ code: 'KeyA', primary: true, shift: true }],
    },
    // UIUX (audit 2026-07-27 §C-08): bổ sung các thao tác phím/chuột đã hoạt động nhưng
    // chưa được liệt kê trong bảng phím tắt. Các mục này CHỈ để hiển thị (bindings rỗng
    // → matchesShortcut luôn false, không đụng logic phím). SettingsModal render mô tả
    // qua t(`settings:${descriptionKey}`); các slug dưới đây đã được thêm vào
    // vi.json + en.json (UIUX audit 2026-07-27 §C-08 fix-verify).
    {
        id: 'pages.space_next', group: 'pages', keys: ['Space'],
        descriptionKey: 'shortcut_space_tap_next', bindings: [],
    },
    {
        id: 'pages.space_previous', group: 'pages', keys: ['Shift', 'Space'],
        descriptionKey: 'shortcut_space_tap_prev', bindings: [],
    },
    {
        id: 'view.wheel_zoom_cursor', group: 'view', keys: ['Ctrl', 'Lăn chuột'],
        descriptionKey: 'shortcut_ctrl_wheel_zoom', bindings: [],
    },
    {
        id: 'pages.thumb_wheel_resize', group: 'pages', keys: ['Ctrl', 'Lăn chuột'],
        descriptionKey: 'shortcut_ctrl_wheel_thumb_size', bindings: [],
    },
    {
        id: 'pages.thumb_alt_drag_duplicate', group: 'pages', keys: ['Alt', 'Kéo thumbnail'],
        descriptionKey: 'shortcut_alt_drag_duplicate', bindings: [],
    },
    {
        id: 'pages.thumb_double_click_fit', group: 'pages', keys: ['Double-click'],
        descriptionKey: 'shortcut_dblclick_thumb_fit', bindings: [],
    },
    {
        id: 'pages.thumb_marquee_select', group: 'pages', keys: ['Kéo khung'],
        descriptionKey: 'shortcut_marquee_select', bindings: [],
    },
] as const satisfies ReadonlyArray<KeyboardShortcutDefinition>;

export type KeyboardShortcutId = typeof KEYBOARD_SHORTCUTS[number]['id'];

const SHORTCUT_BY_ID = new Map<KeyboardShortcutId, typeof KEYBOARD_SHORTCUTS[number]>(
    KEYBOARD_SHORTCUTS.map((shortcut) => [shortcut.id, shortcut]),
);

export function getShortcutLabel(id: KeyboardShortcutId): string {
    return SHORTCUT_BY_ID.get(id)?.keys.join('+') ?? '';
}

export function matchesShortcut(event: KeyboardEvent, id: KeyboardShortcutId): boolean {
    const shortcut = SHORTCUT_BY_ID.get(id);
    if (!shortcut) return false;
    const primaryPressed = event.ctrlKey || event.metaKey;

    return (shortcut.bindings as readonly ShortcutBinding[]).some((binding) => {
        if (primaryPressed !== Boolean(binding.primary)) return false;
        if (event.altKey !== Boolean(binding.alt)) return false;
        if (!binding.ignoreShift && event.shiftKey !== Boolean(binding.shift)) return false;
        if (binding.code && event.code !== binding.code) return false;
        if (binding.key && event.key.toLowerCase() !== binding.key.toLowerCase()) return false;
        return true;
    });
}
