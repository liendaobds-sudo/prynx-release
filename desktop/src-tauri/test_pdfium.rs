use pdfium_render::prelude::*;
fn main() {
    println!("Testing Pdfium bind...");
    let bindings = Pdfium::bind_to_system_library()
        .or_else(|_| Pdfium::bind_to_library("pdfium.dll"));
    match bindings {
        Ok(_) => println!("Pdfium bound successfully."),
        Err(e) => println!("Pdfium bind error: {:?}", e),
    }
}
