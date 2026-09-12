#[test]
fn test_render_and_pixel_verification() {
    let path = r"C:\Users\Khanh Pham\Desktop\Imposed_Tem thuc pham sach Duc An_.pdf";
    let cold_path = r"C:\Users\Khanh Pham\Desktop\test_cold_imposed.pdf";
    let before_png_path = r"C:\Users\Khanh Pham\Desktop\baseline_before.png";
    let after_png_path = r"C:\Users\Khanh Pham\Desktop\baseline_after.png";

    if !std::path::Path::new(path).exists() {
        eprintln!("Test file not found: {}", path);
        return;
    }
    if !std::path::Path::new(before_png_path).exists() {
        eprintln!("Baseline before PNG not found: {}", before_png_path);
        return;
    }

    // Ensure clean cold test file
    let _ = std::fs::remove_file(cold_path);
    std::fs::copy(path, cold_path).expect("Failed to copy test file to cold_path");

    // 1. Render tile with timing breakdown (Cold)
    std::env::set_var("PRYNX_PERF", "1");
    let (after_bytes, timing) = app_lib::render_tile_png_with_timing(
        cold_path,
        1,
        0.958,
        0,
        None,
        None,
        None,
        None,
    ).expect("Render tile failed");

    let _ = std::fs::remove_file(cold_path);

    println!("\n==========================================");
    println!("    AFTER OPTIMIZATION TIMING (COLD)      ");
    println!("==========================================");
    println!("Open Document : {:>6} ms", timing.open_ms);
    println!("PDFium Render : {:>6} ms", timing.pdfium_render_ms);
    println!("Convert Bitmap: {:>6} ms", timing.convert_ms);
    println!("Encode PNG    : {:>6} ms", timing.encode_ms);
    println!("Cache Write   : {:>6} ms", timing.cache_ms);
    println!("Total Time    : {:>6} ms", timing.total_ms);
    println!("==========================================\n");

    // 2. Save after PNG
    std::fs::write(after_png_path, &after_bytes).expect("Failed to write baseline_after.png");

    // 3. Load baseline before and compare
    let before_bytes = std::fs::read(before_png_path).expect("Failed to read baseline_before.png");

    println!("Baseline Before size: {} bytes", before_bytes.len());
    println!("Baseline After size : {} bytes", after_bytes.len());

    let before_img = image::load_from_memory(&before_bytes).expect("Failed to decode before PNG").to_rgba8();
    let after_img = image::load_from_memory(&after_bytes).expect("Failed to decode after PNG").to_rgba8();

    assert_eq!(before_img.dimensions(), after_img.dimensions(), "Image dimensions mismatch!");

    let (w, h) = before_img.dimensions();
    let total_pixels = (w * h) as usize;
    let mut diff_pixel_count = 0usize;
    let mut max_channel_diff = 0u8;

    for (p1, p2) in before_img.pixels().zip(after_img.pixels()) {
        let dr = (p1[0] as i16 - p2[0] as i16).abs() as u8;
        let dg = (p1[1] as i16 - p2[1] as i16).abs() as u8;
        let db = (p1[2] as i16 - p2[2] as i16).abs() as u8;
        let da = (p1[3] as i16 - p2[3] as i16).abs() as u8;

        let max_d = dr.max(dg).max(db).max(da);
        if max_d > 0 {
            diff_pixel_count += 1;
            max_channel_diff = max_channel_diff.max(max_d);
        }
    }

    println!("==========================================");
    println!("         PIXEL VERIFICATION REPORT        ");
    println!("==========================================");
    println!("Total Pixels     : {}", total_pixels);
    println!("Different Pixels : {} / {}", diff_pixel_count, total_pixels);
    println!("Max Channel Diff : {}", max_channel_diff);
    println!("==========================================\n");

    assert_eq!(diff_pixel_count, 0, "Pixel difference detected between before and after!");
    assert_eq!(max_channel_diff, 0, "Color shift detected between before and after!");
    println!(">>> VERIFICATION PASSED: 100% BIT-FOR-BIT ZERO PIXEL DIFF (Delta E = 0) <<<");
}
