// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    WorkspaceContext,
    createWorkspaceStore,
} from '../../stores/useWorkspaceStore';
import LayerPanel from './LayerPanel';

vi.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../lib/api', () => ({
    getApiUrl: () => 'http://127.0.0.1:8321/api',
}));

type Deferred<T> = {
    promise: Promise<T>;
    resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((fulfill) => {
        resolve = fulfill;
    });
    return { promise, resolve };
}

function nativePdf(): File {
    const file = new File(['pdf'], 'source.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'path', { value: 'C:\\source.pdf' });
    return file;
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe('LayerPanel — owner OCG của Working PDF', () => {
    it('bỏ toàn bộ response native-path cũ khi backend owner đổi giữa request', async () => {
        // PARITY (audit 2026-08-29 §MAP-NEST-10): object ID từ native PDF
        // không được gắn vào Working PDF mới, kể cả hai revision dùng cùng File.
        const pendingResponse = deferred<Response>();
        const fetchMock = vi.fn().mockReturnValue(pendingResponse.promise);
        vi.stubGlobal('fetch', fetchMock);

        const file = nativePdf();
        const store = createWorkspaceStore();
        store.getState().setFile(file);
        store.getState().setIsLayerPanelOpen(true);

        render(
            <WorkspaceContext.Provider value={store}>
                <LayerPanel />
            </WorkspaceContext.Provider>,
        );

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/imposition/pdf-layers');

        act(() => {
            store.getState().setSelectionFileId('working-owner-b');
        });

        await act(async () => {
            pendingResponse.resolve({
                ok: true,
                json: async () => ({
                    layers: [{
                        id: 101,
                        name: 'Layer từ source cũ',
                        visible: false,
                        locked: true,
                        depth: 0,
                        children: [],
                        color: '#000000',
                    }],
                }),
            } as Response);
            await pendingResponse.promise;
            await Promise.resolve();
        });

        await waitFor(() => {
            const state = store.getState();
            expect(state.selectionFileId).toBe('working-owner-b');
            expect(state.pdfOcgLayers).toEqual([]);
            expect(state.hiddenOcgLayerIds).toEqual([]);
            expect(state.lockedOcgLayerIds).toEqual([]);
            expect(state.ocgVisibilityProvenance).toMatchObject({
                intent: 'source-default',
                sourceFile: null,
                sourceFileId: '',
                sourceEditGeneration: -1,
                baselineLoaded: false,
                sourceDefaultHiddenLayerIds: [],
            });
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
