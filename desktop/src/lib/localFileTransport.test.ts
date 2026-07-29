// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prepareFileForUpload } from './api';
import { fetchLocalFileBuffer, localFileUrl } from './localFileTransport';
import { detectColorSpace, getFileArrayBuffer } from './utils';

type TauriWindow = Window & { __TAURI_INTERNALS__?: Record<string, never> };
const tauriWindow = window as TauriWindow;

describe('local file transport', () => {
  beforeEach(() => {
    tauriWindow.__TAURI_INTERNALS__ = {};
  });

  afterEach(() => {
    delete tauriWindow.__TAURI_INTERNALS__;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('mã hóa đường dẫn và gửi đúng một byte range', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([2, 3, 4]), { status: 206 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchLocalFileBuffer('D:\\jobs\\mẫu in.pdf', {
      start: 2,
      endExclusive: 5,
    })).resolves.toEqual(expect.any(ArrayBuffer));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(localFileUrl('D:\\jobs\\mẫu in.pdf'));
    expect((fetchMock.mock.calls[0][1]?.headers as Headers).get('Range')).toBe('bytes=2-4');
  });

  it('không coi body của response lỗi là dữ liệu file', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('/DeviceRGB', { status: 403 }),
    ));

    await expect(fetchLocalFileBuffer('D:\\jobs\\card.pdf')).rejects.toThrow('HTTP 403');
  });

  it('đọc file có path qua localfile, không probe asset protocol', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const file = new File([], 'card.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'path', { value: 'D:\\jobs\\card.pdf' });

    const result = new Uint8Array(await getFileArrayBuffer(file));

    expect([...result]).toEqual([0x25, 0x50, 0x44, 0x46]);
    expect(String(fetchMock.mock.calls[0][0])).toContain('localfile.localhost');
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('asset.localhost');
  });

  it('khôi phục fake File thành blob thật trước khi upload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200 }),
    ));
    const file = new File([], 'card.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'path', { value: '\\\\server\\jobs\\card.pdf' });

    const prepared = await prepareFileForUpload(file);

    expect(prepared.size).toBe(4);
    expect((prepared as File).path).toBe('\\\\server\\jobs\\card.pdf');
  });

  it('dừng an toàn thay vì trả lại fake File 0 byte', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('forbidden', { status: 403 }),
    ));
    const file = new File([], 'card.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'path', { value: 'D:\\jobs\\card.pdf' });

    await expect(prepareFileForUpload(file)).rejects.toThrow('Không đọc được file gốc trên đĩa');
  });

  it('dò hệ màu dùng byte PDF thật và bỏ qua response 403', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pdf = new File(['/DeviceCMYK /DeviceCMYK'], 'press.pdf', { type: 'application/pdf' });
    Object.defineProperty(pdf, 'path', { value: 'D:\\jobs\\press.pdf' });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('backend unavailable', { status: 500 }))
      .mockResolvedValueOnce(new Response('/DeviceCMYK /DeviceCMYK', { status: 206 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(detectColorSpace(pdf)).resolves.toBe('CMYK');

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(new Response('backend unavailable', { status: 500 }))
      .mockResolvedValueOnce(new Response('/DeviceRGB', { status: 403 }));
    await expect(detectColorSpace(pdf)).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});
