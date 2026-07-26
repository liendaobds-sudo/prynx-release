import { useEffect } from 'react';
import { create } from 'zustand';

type Theme = 'light' | 'dark';

function readInitialTheme(): Theme {
  try {
    // Check local storage first
    const savedTheme = localStorage.getItem('theme') as Theme;
    if (savedTheme === 'light' || savedTheme === 'dark') {
      return savedTheme;
    }
    // Check system preference
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
  } catch {
    /* localStorage bị chặn (chế độ riêng tư) → dùng mặc định */
  }
  // Default to light (since Light is the new OhMyShot base)
  return 'light';
}

function applyTheme(theme: Theme) {
  const root = window.document.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(theme);
  try {
    localStorage.setItem('theme', theme);
  } catch {
    /* bỏ qua */
  }
}

/**
 * UIUX (audit 2026-07-27 §A-01): theme phải có MỘT nguồn chân lý.
 *
 * Trước đây `useTheme` giữ state bằng `useState` cục bộ, nên TitleBar (ThemeToggle)
 * và menu View trong App.tsx là hai bản sao độc lập: bấm nút ở titlebar thì class
 * `dark` đổi nhưng state của App.tsx đứng im → dấu ✓ ở mục "Giao diện Tối" hiển thị
 * sai, và bấm mục menu đó lại toggle từ giá trị cũ. Đưa state vào store zustand
 * (vẫn đồng bộ localStorage như cũ) thì mọi nơi gọi useTheme() đọc chung một giá trị.
 *
 * KHÔNG dùng appSettingsStore vì store đó lưu qua Tauri storage (bất đồng bộ) —
 * theme cần có ngay ở frame đầu để không nháy sáng khi mở app.
 */
interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: readInitialTheme(),
  setTheme: (theme) => {
    if (get().theme === theme) return;
    applyTheme(theme);
    set({ theme });
  },
  toggleTheme: () => {
    const next: Theme = get().theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    set({ theme: next });
  },
}));

export function useTheme() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);

  // Đồng bộ class lên <html> khi mount (bootstrap ở main.tsx đã làm sẵn cho frame
  // đầu tiên; effect này chỉ để an toàn nếu component được dùng ngoài app shell).
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return { theme, toggleTheme, setTheme };
}
