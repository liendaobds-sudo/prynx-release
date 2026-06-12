//! Shared PDFium initialization helper.

use pdfium_render::prelude::*;
use std::path::PathBuf;

/// Load PDFium from known locations.
pub fn load_pdfium() -> Pdfium {
    // 1. PDFIUM_DLL_PATH env var (explicit — full path to dir containing pdfium.dll)
    if let Ok(path) = std::env::var("PDFIUM_DLL_PATH") {
        let dll_path = PathBuf::from(&path).join("pdfium.dll");
        if dll_path.exists() {
            if let Ok(bindings) = Pdfium::bind_to_library(dll_path.to_str().unwrap()) {
                return Pdfium::new(bindings);
            }
        }
        // Try the platform-specific name helper
        if let Ok(bindings) = Pdfium::bind_to_library(
            Pdfium::pdfium_platform_library_name_at_path(&path)
        ) {
            return Pdfium::new(bindings);
        }
    }

    // 2. VIRTUAL_ENV/Lib/site-packages/pypdfium2_raw/pdfium.dll
    if let Ok(venv) = std::env::var("VIRTUAL_ENV") {
        let dll_path = PathBuf::from(&venv)
            .join("Lib")
            .join("site-packages")
            .join("pypdfium2_raw")
            .join("pdfium.dll");
        if dll_path.exists() {
            if let Ok(bindings) = Pdfium::bind_to_library(dll_path.to_str().unwrap()) {
                return Pdfium::new(bindings);
            }
        }
    }

    // 3. System library
    Pdfium::new(
        Pdfium::bind_to_system_library()
            .expect("Cannot find pdfium.dll. Set PDFIUM_DLL_PATH or VIRTUAL_ENV env var.")
    )
}
