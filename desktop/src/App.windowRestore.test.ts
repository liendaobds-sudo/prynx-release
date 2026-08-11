import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('chính sách khôi phục cửa sổ PrynX', () => {
  it('chỉ dùng một đường kéo native cho thanh tiêu đề', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
    const start = source.indexOf('function TitleBar');
    const end = source.indexOf('const SPLASH_MIN_MS', start);
    const titleBar = source.slice(start, end);

    expect(titleBar).toContain('data-tauri-drag-region');
    expect(titleBar).not.toContain('.startDragging()');
  });

  it('unminimize trước khi hiện và có lưới phục hồi khi taskbar trả focus', () => {
    const source = readFileSync(resolve(process.cwd(), 'src-tauri/src/lib.rs'), 'utf8');
    const revealStart = source.indexOf('fn reveal_main_window');
    const revealEnd = source.indexOf('#[tauri::command]', revealStart);
    const reveal = source.slice(revealStart, revealEnd);
    const unminimizeAt = reveal.indexOf('.unminimize()');
    const showAt = reveal.indexOf('.show()');

    expect(unminimizeAt).toBeGreaterThanOrEqual(0);
    expect(unminimizeAt).toBeLessThan(showAt);

    const eventStart = source.indexOf('.on_window_event(|window, event|');
    const eventEnd = source.indexOf('.setup(|app|', eventStart);
    const eventGuard = source.slice(eventStart, eventEnd);
    expect(eventGuard).toContain('tauri::WindowEvent::Focused(true)');
    expect(eventGuard).toContain('window.is_minimized()');
    expect(eventGuard).toContain('window.unminimize()');
  });
});
