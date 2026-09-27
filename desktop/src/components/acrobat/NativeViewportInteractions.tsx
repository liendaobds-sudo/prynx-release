// UIUX (audit 2026-09-25 §R25.GPU.30): React giữ popup, native giữ vùng chọn và camera.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppSettingsStore } from '../../stores/appSettingsStore';
import { useTextMarkupStore, type TextMarkup } from '../../stores/useTextMarkupStore';
import { TextSelectionToolbar } from '../workspace/TextSelectionToolbar';
import { AcrobatCommentCard } from '../workspace/AcrobatCommentCard';
import type { UseNativeGpuViewportReturn } from '../../hooks/viewer/useNativeGpuViewport';
import { nativeTextLines, unionSelection, type NativeInteractionEvent, type NativeInteractionUpdate, type NativeSelection, type NativeTextBlocks } from '../../hooks/viewer/nativeViewportInteraction';

const EMPTY_BLOCKS: NativeTextBlocks = [];
export function NativeViewportInteractions({ api, tool, textBlocks = EMPTY_BLOCKS, page, active, event, onContextMenu, onDismiss }: {
  api: UseNativeGpuViewportReturn; tool: 'pointer' | 'hand'; textBlocks?: NativeTextBlocks; page: number; active: boolean;
  event: NativeInteractionEvent | null; onContextMenu?: (x: number, y: number) => void; onDismiss?: () => void;
}) {
  const [selection, setSelection] = useState<NativeSelection | null>(null);
  const interactiveLinks = useAppSettingsStore(s => s.enableInteractiveLinks);
  const selectionToolbar = useAppSettingsStore(s => s.enableTextSelectionToolbar);
  const markups = useTextMarkupStore(s => s.markups);
  const selectedMarkupId = useTextMarkupStore(s => s.selectedMarkupId);
  const activeCommentId = useTextMarkupStore(s => s.activeCommentId);
  const lines = useMemo(() => {
    // Không tạo canvas khi backend đã cung cấp glyph box chính xác.
    const fallback = textBlocks.some(b => b.lines?.some(l => l.chars?.some(c => !c.pdf_bbox)));
    const ctx = fallback ? document.createElement('canvas').getContext('2d') : null;
    const family = fallback ? getComputedStyle(document.body).fontFamily || 'sans-serif' : '';
    return nativeTextLines(textBlocks, interactiveLinks, ctx ? (text, h) => { ctx.font = `${Math.max(1, h)}px ${family}`; return ctx.measureText(text).width; } : undefined);
  }, [textBlocks, interactiveLinks]);
  const pageMarkups = useMemo(() => markups.filter(m => m.pageNum === page), [markups, page]);
  const nativeMarkups = useMemo(() => pageMarkups.map(m => ({ id: m.id, kind: m.type, bounds: m.rectPt, selected: m.id === selectedMarkupId || m.id === activeCommentId })), [pageMarkups, selectedMarkupId, activeCommentId]);
  const previous = useRef<{ tool: typeof tool; lines: typeof lines; markups: typeof nativeMarkups } | null>(null);
  const { isSceneReady, setInteraction } = api;
  useEffect(() => {
    if (!isSceneReady) { previous.current = null; return; }
    const last = previous.current; const update: NativeInteractionUpdate = {};
    if (!last || last.tool !== tool) update.tool = tool;
    if (!last || last.lines !== lines) update.text = lines;
    if (!last || last.markups !== nativeMarkups) update.markups = nativeMarkups;
    previous.current = { tool, lines, markups: nativeMarkups };
    if (Object.keys(update).length) void setInteraction(update);
  }, [isSceneReady, setInteraction, tool, lines, nativeMarkups]);
  const clear = () => { setSelection(null); void api.setInteraction({ clearSelection: true }); };
  const copy = () => { if (selection) void navigator.clipboard.writeText(selection.text).catch(error => console.error('Không sao chép được văn bản:', error)); clear(); };
  const callbacks = useRef({ onContextMenu, onDismiss, copy, clear }); callbacks.current = { onContextMenu, onDismiss, copy, clear };
  // Component mount lại sau tắt GPU: event của lease trước không được phát lại.
  const handledEvent = useRef<NativeInteractionEvent | null>(event);
  useEffect(() => {
    if (!event || !active || event === handledEvent.current) return;
    handledEvent.current = event;
    const store = useTextMarkupStore.getState();
    if (event.kind === 'selection') { setSelection(event.selection); store.setSelectedMarkupId(null); store.setActiveCommentId(null); }
    if (event.kind === 'dismiss') { setSelection(null); callbacks.current.onDismiss?.(); }
    if (event.kind === 'copy') { callbacks.current.copy(); }
    if (event.kind === 'context_menu') {
      const rect = api.containerRef.current?.getBoundingClientRect();
      if (rect) callbacks.current.onContextMenu?.(rect.left + event.x, rect.top + event.y);
    }
    if (event.kind === 'markup') {
      const target = store.markups.find(m => m.id === event.id && m.pageNum === page);
      if (target) { store.setSelectedMarkupId(store.selectedMarkupId === target.id ? null : target.id); if (target.type === 'comment') store.setActiveCommentId(store.activeCommentId === target.id ? null : target.id); }
    }
    if (event.kind === 'link' && interactiveLinks && /^(https?:\/\/|mailto:)/i.test(event.url)) {
      void import('@tauri-apps/plugin-shell').then(({ open }) => open(event.url)).catch(error => console.error('Không mở được liên kết:', error));
    }
  }, [event, active, api.containerRef, interactiveLinks, page]);
  const keyboard = useRef({ copy, clear, selection, active }); keyboard.current = { copy, clear, selection, active };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const v = keyboard.current; const el = e.target instanceof HTMLElement ? e.target : null;
      if (!v.active || !v.selection || el?.closest('input,textarea,[contenteditable="true"]')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') { e.preventDefault(); e.stopImmediatePropagation(); v.copy(); }
      else if (e.key === 'Escape') { e.preventDefault(); v.clear(); }
    };
    window.addEventListener('keydown', onKey, true); return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  const add = (type: TextMarkup['type'], comment?: string) => {
    const bounds = selection && unionSelection(selection.rects); if (!selection || !bounds) return;
    useTextMarkupStore.getState().addMarkup({ pageNum: page, type, rectPt: bounds, text: selection.text, comment }); clear();
  };
  if (!active || !api.camera) return null;
  const c = api.camera; const rect = selection && unionSelection(selection.rects);
  const width = c.viewport_width / c.dpr; const height = c.viewport_height / c.dpr;
  const comment = pageMarkups.find(m => m.id === activeCommentId);
  const store = useTextMarkupStore.getState();
  return <>
    {selectionToolbar && selection && rect && <TextSelectionToolbar visible x={Math.max(130, Math.min(width - 130, (rect.x + rect.width / 2) * c.zoom + c.pan_x))}
      y={Math.max(52, Math.min(height, rect.y * c.zoom + c.pan_y))} selectedText={selection.text} onCopy={copy}
      onHighlight={() => add('highlight')} onUnderline={() => add('underline')} onStrikethrough={() => add('strikethrough')}
      onComment={text => add('comment', text)} onClose={clear} />}
    {comment && <AcrobatCommentCard key={comment.id} markup={comment} containerWidth={width}
      x={Math.max(0, Math.min(width - 40, comment.rectPt.x * c.zoom + c.pan_x))} y={Math.max(10, Math.min(height - 220, comment.rectPt.y * c.zoom + c.pan_y))}
      onSaveComment={store.updateCommentText} onAddReply={store.addReply} onDeleteComment={store.deleteMarkup} onClose={() => store.setActiveCommentId(null)} />}
  </>;
}
