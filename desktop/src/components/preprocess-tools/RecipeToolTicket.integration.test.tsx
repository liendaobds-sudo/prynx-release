// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
  getWorkingFile: vi.fn(),
  prepareFileForUpload: vi.fn(),
  uploadPDF: vi.fn(),
  workspaceState: {
    fileSizeStr: '1 MB',
    outputPreviewProfileId: 'fogra39',
    outputPreviewRenderingIntent: 'relative',
    setOutputPreviewProfileId: vi.fn(),
    setOutputPreviewRenderingIntent: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../hooks/useWorkingPdf', () => ({
  useWorkingPdf: () => mocks.getWorkingFile,
}));
vi.mock('../../lib/api', () => ({
  authenticatedFetch: mocks.authenticatedFetch,
  getApiUrl: () => 'http://127.0.0.1:8321/api',
  prepareFileForUpload: mocks.prepareFileForUpload,
  uploadPDF: mocks.uploadPDF,
}));
vi.mock('../../stores/useWorkspaceStore', () => ({
  useWorkspaceStore: (selector: (state: typeof mocks.workspaceState) => unknown) => (
    selector(mocks.workspaceState)
  ),
  workspaceDocumentIdentity: () => 'mock-document',
}));

import {
  recipeRecorder,
  recipeRecorderStore,
  type RecipeOperationTicket,
} from '../../lib/recipe/RecipeRecorder';
import ConvertColorsTool from './ConvertColorsTool';
import OptimizeTool from './OptimizeTool';

beforeEach(() => {
  vi.clearAllMocks();
  recipeRecorderStore.setState({
    isRecording: false,
    ownerTabId: null,
    activeTabId: null,
    sessionId: 0,
    draftSteps: [],
    pendingNote: null,
  });
  mocks.getWorkingFile.mockResolvedValue(null);
  mocks.prepareFileForUpload.mockImplementation(async (file: File) => file);
  mocks.uploadPDF.mockResolvedValue({ id: 'fid-1' });
  mocks.authenticatedFetch.mockImplementation(async (url: string) => {
    if (url.includes('/icc-profiles')) {
      return {
        ok: true,
        json: async () => ({
          profiles: [
            { id: 'fogra39', name: 'FOGRA39', description: '', available: true },
          ],
        }),
      };
    }
    if (url.includes('/download/')) {
      return { ok: true, blob: async () => new Blob(['pdf'], { type: 'application/pdf' }) };
    }
    return {
      ok: true,
      json: async () => ({ success: true, output_filename: 'Converted.pdf', log: [] }),
    };
  });
});

describe('Prepress recorder ticket — callback bất đồng bộ', () => {
  it('Convert Colors truyền đúng ticket và chờ commit hoàn tất mới kết thúc job', async () => {
    recipeRecorder.start('tab-a');
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const onFileFixed = vi.fn((
      ...args: [Blob, string, string | undefined, RecipeOperationTicket | null | undefined]
    ) => {
      void args;
      return commitGate;
    });

    render(
      <ConvertColorsTool
        tabId="tab-a"
        pdfFile={new File(['source'], 'source.pdf', { type: 'application/pdf' })}
        onFileFixed={onFileFixed}
      />,
    );

    // CMYK mới yêu cầu preview hợp lệ; test ticket dùng Grayscale để đi thẳng
    // qua cùng execute contract và chỉ khóa hành vi commit bất đồng bộ.
    fireEvent.click(screen.getByRole('button', { name: /chuyen_sang_den_trang/ }));

    const runButton = screen.getByRole('button', { name: 'preprocess.common:run' }) as HTMLButtonElement;
    fireEvent.click(runButton);

    await waitFor(() => expect(onFileFixed).toHaveBeenCalledTimes(1));
    const ticket = onFileFixed.mock.calls[0][3];
    expect(ticket).toMatchObject({ ownerTabId: 'tab-a' });
    expect(runButton.disabled).toBe(true);

    releaseCommit();
    await waitFor(() => expect(runButton.disabled).toBe(false));
  });

  it('Optimize truyền đúng ticket và không kết thúc trước callback commit', async () => {
    recipeRecorder.start('tab-a');
    mocks.authenticatedFetch.mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['pdf'], { type: 'application/pdf' }),
      headers: { get: () => '10' },
    });
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const onFileFixed = vi.fn((
      ...args: [Blob, string, string | undefined, RecipeOperationTicket | null | undefined]
    ) => {
      void args;
      return commitGate;
    });

    render(
      <OptimizeTool
        tabId="tab-a"
        pdfFile={new File(['source'], 'source.pdf', { type: 'application/pdf' })}
        onFileFixed={onFileFixed}
      />,
    );

    const runButton = screen.getByRole('button', { name: 'preprocess.common:run' }) as HTMLButtonElement;
    fireEvent.click(runButton);

    await waitFor(() => expect(onFileFixed).toHaveBeenCalledTimes(1));
    expect(onFileFixed.mock.calls[0][3]).toMatchObject({ ownerTabId: 'tab-a' });
    expect(runButton.disabled).toBe(true);

    releaseCommit();
    await waitFor(() => expect(runButton.disabled).toBe(false));
  });
});
