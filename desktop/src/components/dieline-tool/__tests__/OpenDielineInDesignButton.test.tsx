// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DielineModel } from '../../../lib/dieline/types';
import OpenDielineInDesignButton from '../OpenDielineInDesignButton';

const mocks = vi.hoisted(() => ({
    buildDielinePdfBlob: vi.fn(),
    downloadPDF: vi.fn(),
    ensurePathBackedPdf: vi.fn(),
    launchDesignApp: vi.fn(),
    requestFeatureAction: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
}));

vi.mock('../../../lib/dieline/exportPDF', () => ({
    buildDielinePdfBlob: mocks.buildDielinePdfBlob,
    downloadPDF: mocks.downloadPDF,
}));
vi.mock('../../../lib/designAppLauncher', () => ({
    ensurePathBackedPdf: mocks.ensurePathBackedPdf,
    launchDesignApp: mocks.launchDesignApp,
}));
vi.mock('../../../hooks/useToolActivationGuard', () => ({
    useFeatureActionGuard: () => mocks.requestFeatureAction,
}));
vi.mock('../../../i18n', () => ({ tv: (value: string) => value }));
vi.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('sonner', () => ({
    toast: {
        error: mocks.error,
        loading: mocks.loading,
        dismiss: mocks.dismiss,
        warning: vi.fn(),
        success: vi.fn(),
    },
}));

const model = {
    standardCode: 'RMB',
    params: { L: 220, W: 160, D: 60 },
} as DielineModel;
const buttonLabel = 'misc.openInDesign:mo_bang_illustrator_corel';
const tempPath = 'C:\\Temp\\prynx_edit_RMB_220x160x60_2D.pdf';

function openMenu() {
    fireEvent.click(screen.getByRole('button', { name: buttonLabel }));
    return screen.getByRole('menu');
}

describe('OpenDielineInDesignButton', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.buildDielinePdfBlob.mockReset();
        mocks.ensurePathBackedPdf.mockReset();
        mocks.launchDesignApp.mockReset();
        mocks.requestFeatureAction.mockReset();
        mocks.buildDielinePdfBlob.mockResolvedValue(new Blob(['%PDF-1.7'], { type: 'application/pdf' }));
        mocks.ensurePathBackedPdf.mockResolvedValue(tempPath);
        mocks.launchDesignApp.mockResolvedValue(undefined);
        mocks.requestFeatureAction.mockImplementation((_featureId: string, action: () => void) => {
            action();
            return true;
        });
        Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    });

    afterEach(() => {
        cleanup();
        delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    });

    it.each([
        { label: 'Adobe Illustrator', which: 'illustrator' },
        { label: 'CorelDRAW', which: 'corel' },
    ])('mở bản 2D trực tiếp bằng $label qua file tạm, không tải xuống', async ({ label, which }) => {
        const blob = new Blob(['%PDF-1.7'], { type: 'application/pdf' });
        mocks.buildDielinePdfBlob.mockResolvedValue(blob);
        render(<OpenDielineInDesignButton model={model} />);

        openMenu();
        expect(mocks.buildDielinePdfBlob).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('menuitem', { name: label }));

        await waitFor(() => expect(mocks.launchDesignApp).toHaveBeenCalledWith(which, tempPath));
        expect(mocks.requestFeatureAction).toHaveBeenCalledWith('packaging.dieline', expect.any(Function));
        expect(mocks.requestFeatureAction).toHaveBeenCalledWith('prepress.app_bridge', expect.any(Function));
        expect(mocks.buildDielinePdfBlob).toHaveBeenCalledExactlyOnceWith(model);
        expect(mocks.ensurePathBackedPdf).toHaveBeenCalledExactlyOnceWith(blob, 'RMB_220x160x60_2D.pdf');
        expect(mocks.downloadPDF).not.toHaveBeenCalled();
        expect(screen.queryByRole('menu')).toBeNull();
        expect(mocks.error).not.toHaveBeenCalled();
    });

    it('không mở ứng dụng khi không tạo được PDF', async () => {
        mocks.buildDielinePdfBlob.mockResolvedValue(null);
        render(<OpenDielineInDesignButton model={model} />);
        openMenu();
        fireEvent.click(screen.getByRole('menuitem', { name: 'Adobe Illustrator' }));

        await waitFor(() => expect(mocks.error).toHaveBeenCalled());
        expect(mocks.ensurePathBackedPdf).not.toHaveBeenCalled();
        expect(mocks.launchDesignApp).not.toHaveBeenCalled();
        expect(mocks.downloadPDF).not.toHaveBeenCalled();
    });

    it('báo lỗi dựng PDF và không tạo file tạm hoặc mở ứng dụng', async () => {
        mocks.buildDielinePdfBlob.mockRejectedValue(new Error('Không dựng được PDF'));
        render(<OpenDielineInDesignButton model={model} />);
        openMenu();
        fireEvent.click(screen.getByRole('menuitem', { name: 'CorelDRAW' }));

        await waitFor(() => expect(mocks.error).toHaveBeenCalled());
        expect(mocks.ensurePathBackedPdf).not.toHaveBeenCalled();
        expect(mocks.launchDesignApp).not.toHaveBeenCalled();
    });

    it('báo lỗi ghi file tạm và không mở ứng dụng', async () => {
        mocks.ensurePathBackedPdf.mockRejectedValue(new Error('Không ghi được file tạm'));
        render(<OpenDielineInDesignButton model={model} />);
        openMenu();
        fireEvent.click(screen.getByRole('menuitem', { name: 'CorelDRAW' }));

        await waitFor(() => expect(mocks.error).toHaveBeenCalled());
        expect(mocks.launchDesignApp).not.toHaveBeenCalled();
    });

    it('báo lỗi khởi chạy và cho thử mở lại', async () => {
        mocks.launchDesignApp.mockRejectedValue(new Error('Không tìm thấy ứng dụng'));
        render(<OpenDielineInDesignButton model={model} />);
        openMenu();
        fireEvent.click(screen.getByRole('menuitem', { name: 'Adobe Illustrator' }));

        await waitFor(() => expect(mocks.error).toHaveBeenCalled());
        const button = screen.getByRole('button', { name: buttonLabel }) as HTMLButtonElement;
        expect(button.disabled).toBe(false);
        openMenu();
        expect(screen.getByRole('menuitem', { name: 'CorelDRAW' })).toBeTruthy();
    });

    it.each(['packaging.dieline', 'prepress.app_bridge'])('đọc lại quyền %s trước khi dựng file', (deniedFeature) => {
        mocks.requestFeatureAction.mockImplementation((featureId: string, action: () => void) => {
            if (featureId === deniedFeature) return false;
            action();
            return true;
        });
        render(<OpenDielineInDesignButton model={model} />);
        openMenu();
        fireEvent.click(screen.getByRole('menuitem', { name: 'Adobe Illustrator' }));

        expect(mocks.requestFeatureAction).toHaveBeenCalledWith(deniedFeature, expect.any(Function));
        expect(mocks.buildDielinePdfBlob).not.toHaveBeenCalled();
        expect(mocks.ensurePathBackedPdf).not.toHaveBeenCalled();
        expect(mocks.launchDesignApp).not.toHaveBeenCalled();
    });

    it('khóa nút khi model hiện tại chưa được phép xuất', () => {
        render(<OpenDielineInDesignButton model={model} disabled />);
        const button = screen.getByRole('button', { name: buttonLabel }) as HTMLButtonElement;
        expect(button.disabled).toBe(true);
        fireEvent.click(button);
        expect(screen.queryByRole('menu')).toBeNull();
        expect(mocks.buildDielinePdfBlob).not.toHaveBeenCalled();
    });

    it('không cho khởi chạy lặp trong lúc đang dựng PDF', async () => {
        let resolvePdf!: (value: Blob | null) => void;
        const pendingPdf = new Promise<Blob | null>((resolve) => { resolvePdf = resolve; });
        mocks.buildDielinePdfBlob.mockReturnValue(pendingPdf);
        render(<OpenDielineInDesignButton model={model} />);
        openMenu();
        fireEvent.click(screen.getByRole('menuitem', { name: 'Adobe Illustrator' }));

        const button = screen.getByRole('button') as HTMLButtonElement;
        await waitFor(() => expect(button.disabled).toBe(true));
        fireEvent.click(button);
        expect(mocks.buildDielinePdfBlob).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('menu')).toBeNull();

        await act(async () => {
            resolvePdf(new Blob(['%PDF-1.7'], { type: 'application/pdf' }));
            await pendingPdf;
        });
        await waitFor(() => expect(mocks.launchDesignApp).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(button.disabled).toBe(false));
    });

    it('đóng menu bằng Escape hoặc bấm ra ngoài mà không dựng PDF', () => {
        render(<OpenDielineInDesignButton model={model} />);
        openMenu();
        fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Adobe Illustrator' }), { key: 'Escape' });
        expect(screen.queryByRole('menu')).toBeNull();

        openMenu();
        fireEvent.pointerDown(document.body);
        fireEvent.mouseDown(document.body);
        fireEvent.click(document.body);
        expect(screen.queryByRole('menu')).toBeNull();
        expect(mocks.buildDielinePdfBlob).not.toHaveBeenCalled();
    });
});
