// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TextDiffRequest, TextDiffWorkerResponse } from '../workers/textDiffProtocol';
import TextCompareTab from './TextCompareTab';

class FakeTextDiffWorker {
    static instances: FakeTextDiffWorker[] = [];
    readonly messages: TextDiffRequest[] = [];
    readonly terminate = vi.fn();
    onmessage: ((event: MessageEvent<TextDiffWorkerResponse>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;

    constructor() {
        FakeTextDiffWorker.instances.push(this);
    }

    postMessage(message: TextDiffRequest) {
        this.messages.push(message);
    }

    emit(response: TextDiffWorkerResponse) {
        this.onmessage?.({ data: response } as MessageEvent<TextDiffWorkerResponse>);
    }

    emitError(message: string) {
        this.onerror?.({ message } as ErrorEvent);
    }
}

describe('TextCompareTab — contract worker và hiển thị lỗi', () => {
    beforeEach(() => {
        FakeTextDiffWorker.instances = [];
        vi.stubGlobal('Worker', FakeTextDiffWorker);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    function enterTexts() {
        fireEvent.change(screen.getByPlaceholderText('Dán nội dung văn bản gốc vào đây...'), {
            target: { value: 'bản gốc' },
        });
        fireEvent.change(screen.getByPlaceholderText('Dán nội dung phiên bản mới vào đây...'), {
            target: { value: 'bản mới' },
        });
        fireEvent.click(screen.getByRole('button', { name: /Tiến hành so sánh Text/ }));
    }

    it('gửi đúng payload và render phần thêm/xóa', async () => {
        render(<TextCompareTab />);
        enterTexts();

        const worker = FakeTextDiffWorker.instances[0];
        expect(worker.messages[0]).toEqual({
            a: 'bản gốc',
            b: 'bản mới',
            mode: 'word',
            ignoreSpaces: false,
        });

        act(() => {
            worker.emit({
                ok: true,
                parts: [
                    { value: 'bản ', added: false, removed: false },
                    { value: 'gốc', added: false, removed: true },
                    { value: 'mới', added: true, removed: false },
                ],
            });
        });

        expect(await screen.findByText('mới')).toBeTruthy();
        expect(screen.getByText('gốc')).toBeTruthy();
    });

    it('hiển thị lỗi worker và không báo nhầm hai văn bản giống nhau', async () => {
        render(<TextCompareTab />);
        enterTexts();

        act(() => {
            FakeTextDiffWorker.instances[0].emit({ ok: false, error: 'worker hỏng' });
        });

        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toContain('worker hỏng');
        expect(screen.queryByText('✅ Hai đoạn văn bản giống nhau hoàn toàn')).toBeNull();
    });

    it('không lặp nhãn khi worker phát sinh lỗi runtime', async () => {
        render(<TextCompareTab />);
        enterTexts();

        act(() => {
            FakeTextDiffWorker.instances[0].emitError('worker crash');
        });

        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toBe('Lỗi xử lý nền: worker crash');
    });

    it('xóa cảnh báo khi người dùng sửa lại nội dung', async () => {
        render(<TextCompareTab />);
        enterTexts();
        act(() => {
            FakeTextDiffWorker.instances[0].emit({ ok: false, error: 'worker hỏng' });
        });
        await screen.findByRole('alert');

        fireEvent.change(screen.getByPlaceholderText('Dán nội dung văn bản gốc vào đây...'), {
            target: { value: 'bản gốc mới' },
        });
        await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    });
});
