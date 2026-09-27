import { expect, it } from 'vitest';
import { isNativeViewerCommand, nativePopupExclusions, nativeTextLines, textLink, unionSelection } from './nativeViewportInteraction';
it('allowlist native chỉ nhận lệnh Fit, zoom và điều hướng trang', () => {
  for (const command of ['fit-page', 'zoom-100', 'fit-width', 'zoom-in', 'zoom-out',
    'prev-page', 'next-page', 'first-page', 'last-page']) expect(isNativeViewerCommand(command)).toBe(true);
});
it('lệnh native ngoài hợp đồng hoặc sai kiểu không được phát vào menu toàn cục', () => {
  for (const command of ['delete-pages', 'open', 'save', 'FIT-PAGE', ' next-page', '',
    null, undefined, 0, true, [], { cmd: 'next-page' }]) expect(isNativeViewerCommand(command)).toBe(false);
});
it('truyền glyph PDF gốc để native áp CropBox/Rotate/UserUnit một lần', () => {
  const r = { x: 10, y: 700, width: 8, height: 11 };
  const lines = nativeTextLines([{ lines: [{ bbox: { x: 0, y: 0, w: 8, h: 11 }, chars: [{ c: 'ệ', pdf_bbox: r }] }] }], true);
  expect(lines[0]).toEqual({ link: null, pdf_coordinates: true, glyphs: [{ text: 'ệ', bounds: r }] });
});
it('backend cũ vẫn giữ đầy đủ chữ, fit theo bbox dòng và không cắt Unicode', () => {
  const lines = nativeTextLines([{ lines: [{ bbox: { x: 10, y: 20, w: 40, h: 10 }, chars: [{ c: 'ệ' }, { c: '😀' }] }] }], false);
  expect(lines[0].pdf_coordinates).toBe(false);
  expect(lines[0].glyphs.map(g => g.text)).toEqual(['ệ', '😀']);
  expect(lines[0].glyphs[1].bounds).toEqual({ x: 30, y: 20, width: 20, height: 10 });
});
it('chỉ tạo liên kết web/email giống lớp chọn chữ', () => {
  expect(textLink('www.example.com')).toBe('https://www.example.com');
  expect(textLink('a@example.com')).toBe('mailto:a@example.com');
  expect(textLink('javascript:alert(1)')).toBeNull();
});
it('vùng popup cắt theo viewport, làm tròn phủ đủ pixel ở DPR phân số', () => {
  const v = { left: 100, top: 50, right: 900, bottom: 650 } as DOMRect;
  const p = { left: 90, top: 60.5, right: 180.5, bottom: 90.2 } as DOMRect;
  expect(nativePopupExclusions(v, 1.5, [p])).toEqual([{ x: 0, y: 15, width: 121, height: 46 }]);
  expect(nativePopupExclusions(v, 1.5, [{ ...p, right: 99 } as DOMRect])).toEqual([]);
});
it('markup lưu bằng điểm trang, không lưu pixel zoom', () => {
  expect(unionSelection([{ x: 10, y: 20, width: 30, height: 10 }, { x: 5, y: 40, width: 50, height: 10 }])).toEqual({ x: 5, y: 20, width: 50, height: 30 });
});
it('vùng popup dùng cùng gốc HWND đã làm tròn khi panel có CSS pixel phân số', () => {
  const view = { left: 100.3, top: 50.3, right: 900, bottom: 650 } as DOMRect;
  const popup = { left: 110.1, top: 60.1, right: 180.5, bottom: 90.2 } as DOMRect;
  expect(nativePopupExclusions(view, 1.5, [popup])).toEqual([{ x: 15, y: 15, width: 106, height: 46 }]);
});
