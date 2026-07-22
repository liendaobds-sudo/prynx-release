export {};

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __PRYNX_INVOKE__?: typeof import('@tauri-apps/api/core').invoke;
  }

  /** Tauri-created File objects may carry a native source path. */
  interface File {
    path?: string;
    isInMemory?: boolean;
  }
}
