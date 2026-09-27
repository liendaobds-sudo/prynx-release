// UIUX (audit 2026-09-25 §R25.GPU.30): hợp đồng tương tác độc lập backend render.
export interface NativeRect { x: number; y: number; width: number; height: number }
export interface NativeSelection { text: string; rects: NativeRect[] }
export interface NativeTextLine { glyphs: Array<{ text: string; bounds: NativeRect }>; link: string | null; pdf_coordinates: boolean }
export interface NativeMarkup { id: string; kind: 'highlight' | 'underline' | 'strikethrough' | 'comment'; bounds: NativeRect; selected: boolean }
export interface NativeInteractionUpdate { tool?: 'pointer' | 'hand'; text?: NativeTextLine[]; markups?: NativeMarkup[]; clearSelection?: boolean }
// UIUX (audit 2026-09-27 §V27.CAMERA): HWND chỉ chuyển các lệnh xem trang;
// cùng handler menu giữ hiệu chuẩn/điều hướng, không mở quyền lệnh sửa hoặc file.
const NATIVE_VIEWER_COMMANDS = ['fit-page', 'zoom-100', 'fit-width', 'zoom-in', 'zoom-out',
  'prev-page', 'next-page', 'first-page', 'last-page'] as const;
export type NativeViewerCommand = typeof NATIVE_VIEWER_COMMANDS[number];
export function isNativeViewerCommand(value: unknown): value is NativeViewerCommand {
  return typeof value === 'string' && (NATIVE_VIEWER_COMMANDS as readonly string[]).includes(value);
}
export type NativeInteractionEvent =
  | { kind: 'selection'; selection: NativeSelection | null }
  | { kind: 'context_menu'; x: number; y: number }
  | { kind: 'link'; url: string }
  | { kind: 'markup'; id: string }
  | { kind: 'wheel'; delta_y: number; at_top: boolean; at_bottom: boolean; viewport_height: number }
  | { kind: 'viewer_command'; command: NativeViewerCommand }
  | { kind: 'dismiss' }
  | { kind: 'copy' };
export type NativeTextBlocks = Array<{ lines?: Array<{
  bbox: { x: number; y: number; w: number; h: number };
  chars?: Array<{ c: string; pdf_bbox?: NativeRect }>;
}> }>;
export function textLink(text: string): string | null {
  const email = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  if (email) return `mailto:${email[1]}`;
  const url = text.match(/((?:https?:\/\/|www\.)[^\s]+)/i)?.[1];
  return url ? (/^https?:\/\//i.test(url) ? url : `https://${url}`) : null;
}
export function nativeTextLines(blocks: NativeTextBlocks, links: boolean, measure?: (text: string, height: number) => number): NativeTextLine[] {
  return blocks.flatMap(b => b.lines ?? []).filter(l => l.chars?.length).map(l => {
    const chars = l.chars!; const text = chars.map(c => c.c).join('');
    const precise = chars.every(c => c.pdf_bbox);
    // Backend cũ chỉ có bbox dòng: dùng cùng phép fit bề ngang của lớp DOM.
    const widths = precise ? [] : chars.map(c => Math.max(0, measure?.(c.c, l.bbox.h) ?? Array.from(c.c).length));
    const sum = widths.reduce((a, b) => a + b, 0) || 1; let advance = 0;
    return { link: links ? textLink(text) : null, pdf_coordinates: precise, glyphs: chars.map((c, i) => {
      const bounds = precise ? c.pdf_bbox! : { x: l.bbox.x + advance / sum * l.bbox.w, y: l.bbox.y, width: widths[i] / sum * l.bbox.w, height: l.bbox.h };
      if (!precise) advance += widths[i];
      return { text: c.c, bounds };
    }) };
  });
}
export function unionSelection(rects: NativeRect[]): NativeRect | null {
  if (!rects.length) return null;
  const x = Math.min(...rects.map(r => r.x)); const y = Math.min(...rects.map(r => r.y));
  return { x, y, width: Math.max(...rects.map(r => r.x + r.width)) - x, height: Math.max(...rects.map(r => r.y + r.height)) - y };
}
export function nativePopupExclusions(viewport: DOMRect, dpr: number, popups: DOMRect[]): NativeRect[] {
  return popups.flatMap(p => {
    const x = Math.max(p.left, viewport.left); const y = Math.max(p.top, viewport.top);
    const right = Math.min(p.right, viewport.right); const bottom = Math.min(p.bottom, viewport.bottom);
    const originX = Math.round(viewport.left * dpr); const originY = Math.round(viewport.top * dpr);
    const leftPx = Math.max(0, Math.floor(x * dpr) - originX); const topPx = Math.max(0, Math.floor(y * dpr) - originY);
    return right > x && bottom > y ? [{ x: leftPx, y: topPx,
      width: Math.ceil(right * dpr) - originX - leftPx, height: Math.ceil(bottom * dpr) - originY - topPx }] : [];
  });
}
