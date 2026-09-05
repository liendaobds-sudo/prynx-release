// @vitest-environment jsdom

/**
 * FILEIO (audit 2026-08-26 §FILE.A4) — task 5.3 của spec `save-as-artifact-guard`.
 *
 * Khoá hợp đồng "hai nhánh lỗi không lẫn nhau" ngay tại CALL SITE THẬT: test mount
 * `ImpositionTab` và bắn đúng event `app-trigger-save` mà menu/Ctrl+S dùng, nên nó đi
 * qua chính `handleSaveFile` → `planWorkspaceSaveWrite` → `executeWorkspaceSaveWrite`
 * → `applySaveOutcome`, không phải một mô hình viết lại.
 *
 * Ba điều được khoá:
 * 1. Đích trùng artifact tạm → từ chối, KHÔNG mở lại hộp thoại chọn vị trí
 *    (Requirement 1.3): nhánh này là giá trị trả về nên không đi qua `catch`.
 * 2. Lỗi phạm vi ghi từ Rust (`forbidden path` / `not allowed`) → VẪN mở lại hộp thoại
 *    chọn vị trí như trước (Requirement 1.5).
 * 3. Sau khi bị từ chối, lượt lưu kế tới đích hợp lệ vẫn lưu được và revision công bố
 *    là nguồn SẠCH (Requirement 2.5) — chứng minh bằng hành vi: lượt lưu thứ ba chọn
 *    lại chính đích vừa lưu thì đi nhánh `reuseExistingSource` (không lệnh ghi nào),
 *    điều chỉ xảy ra khi provenance generated/temp đã bị tước.
 *
 * Phạm vi mock: chỉ các bề mặt KHÔNG thuộc đường lưu — viewer PDF, dashboard công cụ,
 * preview kết quả, prime first-frame. `planWorkspaceSaveWrite`,
 * `executeWorkspaceSaveWrite`, `planWorkspacePdfSave`, `createSavedWorkspaceRevision`,
 * i18n và store workspace đều là bản THẬT. Mọi ca dưới đây đều KHÔNG bake (không xoay,
 * không đổi thứ tự trang) nên `applyAcrobatEdits` không được gọi — đó là lý do stub
 * viewer không làm mỏng bằng chứng của đường lưu.
 *
 * Giới hạn đã biết:
 * - Băng lỗi của tab KHÔNG tự tắt: `handleSaveFile` không gọi `setError('')` ở đầu lượt,
 *   nên câu từ chối của lượt trước còn hiện sau một lượt lưu thành công. Đó là hành vi
 *   sẵn có của băng lỗi trong component (chỉ mở/đóng file và vài tác vụ mới xoá), không
 *   do lô này sinh ra, nên test không khẳng định băng lỗi biến mất.
 * - Bất biến provenance và vé thuê artifact TRÊN working file sau khi từ chối được khoá
 *   ở tầng lib (task 3.1, `workspaceFileSave.test.ts`). Ở đây chỉ quan sát được qua hành
 *   vi lượt lưu kế tiếp vì store của tab là nội bộ, không có cổng đọc ra ngoài.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WORKSPACE_SAVE_ARTIFACT_DESTINATION_MESSAGE_KEY } from '../lib/workspaceFileSave';
import enLocale from '../i18n/locales/en.json';
import viLocale from '../i18n/locales/vi.json';

const mocks = vi.hoisted(() => ({
    invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
    save: vi.fn<(options?: { title?: string; defaultPath?: string }) => Promise<string | null>>(),
    grantSequence: 0,
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/plugin-dialog', () => ({
    save: mocks.save,
    open: vi.fn(),
    ask: vi.fn(),
    confirm: vi.fn(),
    message: vi.fn(),
}));

// Bề mặt hiển thị, không nằm trên đường lưu: stub để mount rẻ và không nạp PDF thật.
vi.mock('./AcrobatViewer', () => ({ default: () => null }));
vi.mock('./imposition-tools/ImposerDashboard', () => ({ default: () => null }));
vi.mock('./OutputPreviewHost', () => ({ default: () => null }));
vi.mock('../lib/viewerFirstFrame', () => ({
    primeViewerFirstFrame: vi.fn(async () => null),
    waitForViewerFirstFrameGrace: vi.fn(async () => null),
}));

import ImpositionTab from './ImpositionTab';
import { markGeneratedWorkspaceFile } from '../lib/nativeFileAccess';

type SaveResult = 'saved' | 'cancelled' | 'failed';

const TAB_ID = 'tab-save-guard';
/** Artifact tạm của sidecar: `isEphemeralBackendPath` nhận ra qua thư mục `uploads`. */
const ARTIFACT_PATH = 'C:\\PrynX\\uploads\\9f0e2c1b7a4d4e0fbb1c8d2e3f405162.pdf';
const CUSTOMER_PATH = 'D:\\Khach\\Don-hang-1234.pdf';
const SECOND_CUSTOMER_PATH = 'D:\\Khach\\Don-hang-1234-b.pdf';

/** Chuỗi mà frontend dùng để nhận diện lỗi phạm vi ghi (Requirement 1.5, 4.2). */
const WRITE_SCOPE_MARKERS = ['not allowed', 'forbidden path'] as const;
/** Tiêu đề hộp thoại CHỈ nhánh lỗi phạm vi ghi mở ra (`ImpositionTab.tsx` performWrite). */
const WRITE_SCOPE_DIALOG_TITLE = 'Select save location (Original path restricted)';

function artifactWorkingFile(): File {
    const file = markGeneratedWorkspaceFile(
        new File(['%PDF-1.7 artifact'], 'ket-qua-binh-trang.pdf', { type: 'application/pdf' }),
    );
    Object.defineProperty(file, 'path', { value: ARTIFACT_PATH, configurable: true });
    return file;
}

function localeMessage(locale: Record<string, Record<string, string>>): string {
    const separator = WORKSPACE_SAVE_ARTIFACT_DESTINATION_MESSAGE_KEY.indexOf(':');
    const namespace = WORKSPACE_SAVE_ARTIFACT_DESTINATION_MESSAGE_KEY.slice(0, separator);
    const key = WORKSPACE_SAVE_ARTIFACT_DESTINATION_MESSAGE_KEY.slice(separator + 1);
    return locale[namespace]?.[key] ?? '';
}

/** Số lần lệnh ghi/copy đĩa được gọi — 0 nghĩa là chưa hề chạm đĩa. */
function diskWriteCalls(): string[] {
    return mocks.invoke.mock.calls
        .map(([command]) => command)
        .filter(command => command === 'copy_file_atomic' || command === 'write_file_atomic');
}

/** Tiêu đề của từng lượt mở hộp thoại lưu, để phân biệt lượt đầu với lượt fallback. */
function dialogTitles(): string[] {
    return mocks.save.mock.calls.map(([options]) => options?.title ?? '');
}

/**
 * Mô phỏng command chooser native của §SEC.15. `mocks.save` ở đây chỉ là driver
 * test cho lựa chọn/cancel; component child phải gọi `request_document_save_grant`,
 * không được gọi plugin-dialog trực tiếp.
 */
async function nativeGrantAwareInvoke(
    command: string,
    args?: Record<string, unknown>,
): Promise<unknown> {
    if (command !== 'request_document_save_grant') return undefined;
    const request = args?.request as { suggestedName?: string; title?: string } | undefined;
    const path = await mocks.save({
        defaultPath: request?.suggestedName,
        title: request?.title,
    });
    if (!path) return null;
    mocks.grantSequence += 1;
    return { path, grant: `0000000000000000000000000000000${mocks.grantSequence}` };
}

/**
 * Bắn đúng event mà menu Lưu / Ctrl+S dùng rồi đợi `app-save-result`.
 * `documentWindow.saveAsOnly` bật để bỏ qua cổng dirty và luôn hỏi vị trí lưu.
 */
async function triggerSave(sequence: number): Promise<SaveResult> {
    const requestId = `save-req-${sequence}`;
    const settled = new Promise<SaveResult>((resolve) => {
        const onResult = (event: Event) => {
            const detail = (event as CustomEvent<{ requestId?: string; result: SaveResult }>).detail;
            if (detail?.requestId !== requestId) return;
            window.removeEventListener('app-save-result', onResult);
            resolve(detail.result);
        };
        window.addEventListener('app-save-result', onResult);
    });
    let outcome: SaveResult = 'failed';
    await act(async () => {
        window.dispatchEvent(new CustomEvent('app-trigger-save', {
            detail: { tabId: TAB_ID, requestId },
        }));
        outcome = await settled;
    });
    return outcome;
}

async function mountTabWithArtifact(onTitleChange = vi.fn<(title: string) => void>()) {
    render(
        <ImpositionTab
            tabId={TAB_ID}
            isActive
            initialFile={artifactWorkingFile()}
            onTitleChange={onTitleChange}
            documentWindow={{ saveAsOnly: true, disableRecovery: true }}
        />,
    );
    // Đợi pipeline mở file đặt working file vào store (phase → workspace).
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    return { onTitleChange };
}

describe('chốt chặn Save As lên artifact tạm tại call site ImpositionTab', () => {
    beforeEach(() => {
        (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
        mocks.invoke.mockReset();
        mocks.save.mockReset();
        mocks.grantSequence = 0;
        mocks.invoke.mockImplementation(nativeGrantAwareInvoke);
    });

    afterEach(() => {
        cleanup();
        delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    });

    it('child hủy chooser native thì không có grant/sink ghi nào được dùng', async () => {
        await mountTabWithArtifact();
        mocks.save.mockResolvedValue(null);

        expect(await triggerSave(1)).toBe('cancelled');
        expect(diskWriteCalls()).toEqual([]);
        expect(mocks.invoke).toHaveBeenCalledWith('request_document_save_grant', {
            request: {
                suggestedName: 'ket-qua-binh-trang.pdf',
                title: 'Save PDF File',
            },
        });
        expect(mocks.grantSequence).toBe(0);
    });

    it('đích trùng artifact tạm bị từ chối mà KHÔNG mở lại hộp thoại chọn vị trí', async () => {
        const { onTitleChange } = await mountTabWithArtifact();
        onTitleChange.mockClear();
        mocks.save.mockResolvedValue(ARTIFACT_PATH);

        const result = await triggerSave(1);

        // Requirement 1.1 + 2.1: không lệnh ghi/copy nào chạy.
        expect(diskWriteCalls()).toEqual([]);
        // Requirement 1.3: hộp thoại mở đúng MỘT lần — không có lượt "chọn lại vị trí".
        expect(mocks.save).toHaveBeenCalledTimes(1);
        // Chốt theo ĐÚNG hộp thoại fallback, không chỉ theo số lần gọi: nếu sau này có
        // thêm một lượt hỏi vị trí hợp lệ nào khác thì đếm số lần vẫn đúng mà chốt chặn
        // đã mất. Tiêu đề dưới đây là của riêng nhánh lỗi phạm vi ghi.
        expect(dialogTitles()).not.toContain(WRITE_SCOPE_DIALOG_TITLE);
        // Requirement 1.4: không publish revision nên tiêu đề tab không đổi.
        expect(onTitleChange).not.toHaveBeenCalled();
        expect(result).toBe('cancelled');
        // Requirement 1.2: thông báo tiếng Việt hiện đúng câu của khoá i18n.
        expect(await screen.findByText(localeMessage(viLocale as Record<string, Record<string, string>>)))
            .toBeTruthy();
    });

    it('lỗi phạm vi ghi từ native VẪN mở lại hộp thoại chọn vị trí rồi lưu được', async () => {
        const { onTitleChange } = await mountTabWithArtifact();
        onTitleChange.mockClear();
        mocks.save
            .mockResolvedValueOnce(CUSTOMER_PATH)
            .mockResolvedValueOnce(SECOND_CUSTOMER_PATH);
        mocks.invoke.mockImplementation(async (command, args) => {
            if (command === 'copy_file_atomic' && args?.path === CUSTOMER_PATH) {
                throw new Error(`copy_file_atomic: forbidden path ${String(args?.path)}`);
            }
            return nativeGrantAwareInvoke(command, args);
        });

        const result = await triggerSave(1);

        // Requirement 1.5: đúng hai lượt hộp thoại và lượt hai là hộp "chọn lại vị trí"
        // của riêng nhánh lỗi phạm vi ghi.
        expect(mocks.save).toHaveBeenCalledTimes(2);
        expect(dialogTitles()).toEqual(['Save PDF File', WRITE_SCOPE_DIALOG_TITLE]);
        expect(diskWriteCalls()).toEqual(['copy_file_atomic', 'copy_file_atomic']);
        expect(mocks.invoke).toHaveBeenLastCalledWith('copy_file_atomic', {
            source: ARTIFACT_PATH,
            path: SECOND_CUSTOMER_PATH,
            saveGrant: '00000000000000000000000000000002',
        });
        expect(result).toBe('saved');
        expect(onTitleChange).toHaveBeenCalledWith('Don-hang-1234-b.pdf');
    });

    it('sau khi bị từ chối, lượt lưu kế tới đích hợp lệ lưu được và publish revision sạch', async () => {
        const { onTitleChange } = await mountTabWithArtifact();
        onTitleChange.mockClear();

        // Lượt 1: chọn nhầm chính artifact tạm → bị từ chối.
        mocks.save.mockResolvedValueOnce(ARTIFACT_PATH);
        expect(await triggerSave(1)).toBe('cancelled');
        expect(diskWriteCalls()).toEqual([]);

        // Lượt 2: chọn đích hợp lệ → lưu được (Requirement 1.5).
        mocks.save.mockResolvedValueOnce(CUSTOMER_PATH);
        expect(await triggerSave(2)).toBe('saved');
        expect(mocks.invoke).toHaveBeenLastCalledWith('copy_file_atomic', {
            source: ARTIFACT_PATH,
            path: CUSTOMER_PATH,
            saveGrant: '00000000000000000000000000000002',
        });
        expect(onTitleChange).toHaveBeenLastCalledWith('Don-hang-1234.pdf');

        // Lượt 3: chọn lại CHÍNH đích vừa lưu. Đây là phép thử phân biệt provenance:
        // nếu revision công bố ở lượt 2 còn mang `isGenerated`/`isTempUploadPath` thì
        // lượt này lại là `rejectArtifactDestination` → trả 'cancelled'. Ra 'saved' mà
        // KHÔNG lệnh ghi nào chạy thì chỉ có một nhánh sinh được: `reuseExistingSource`,
        // tức provenance đã sạch (Requirement 2.5).
        mocks.invoke.mockClear();
        mocks.save.mockResolvedValueOnce(CUSTOMER_PATH);
        expect(await triggerSave(3)).toBe('saved');
        expect(diskWriteCalls()).toEqual([]);
        expect(onTitleChange).toHaveBeenLastCalledWith('Don-hang-1234.pdf');
        // Không có lượt "chọn lại vị trí" nào trong cả ba lượt: nhánh từ chối artifact
        // không bao giờ đi qua `catch` lỗi phạm vi ghi (Requirement 1.3).
        expect(dialogTitles()).not.toContain(WRITE_SCOPE_DIALOG_TITLE);
    });
});

/**
 * Đóng proof gap i18n mà task 5.1 phát hiện: `i18nCatalog.test.ts` chỉ thu khoá từ
 * `t('literal')`. Call site gọi `t(outcome.messageKey)` bằng IDENTIFIER nên khoá này
 * vô hình với catalog test — xoá entry locale mà không có test nào đỏ, người dùng sẽ
 * thấy khoá thô trong hộp lỗi.
 */
describe('khoá i18n của thông báo từ chối đích artifact', () => {
    it.each([
        ['vi', viLocale as Record<string, Record<string, string>>],
        ['en', enLocale as Record<string, Record<string, string>>],
    ])('locale %s có câu thông báo không rỗng cho khoá được gọi động', (_locale, catalog) => {
        expect(localeMessage(catalog).trim().length).toBeGreaterThan(0);
    });

    it.each([
        ['vi', viLocale as Record<string, Record<string, string>>],
        ['en', enLocale as Record<string, Record<string, string>>],
    ])('câu thông báo locale %s không chứa chuỗi nhận diện lỗi phạm vi ghi', (_locale, catalog) => {
        // Requirement 4.2 ở tầng NỘI DUNG câu: hiện chỉ khoá ở tầng tên khoá. Nếu câu
        // chứa `not allowed` / `forbidden path`, nhánh catch của ImpositionTab sẽ hiểu
        // lỗi artifact thành lỗi quyền và mở lại hộp thoại chọn vị trí.
        const message = localeMessage(catalog).toLowerCase();
        for (const marker of WRITE_SCOPE_MARKERS) {
            expect(message).not.toContain(marker);
        }
    });
});
