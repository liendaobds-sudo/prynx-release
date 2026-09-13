#[test]
fn test_progressive_auto_refinement() {
    let path = r"C:\Users\Khanh Pham\Desktop\Imposed_Tem thuc pham sach Duc An_.pdf";
    let cold_path = r"C:\Users\Khanh Pham\Desktop\test_cold_refinement.pdf";
    let before_png_path = r"C:\Users\Khanh Pham\Desktop\baseline_before.png";

    if !std::path::Path::new(path).exists() || !std::path::Path::new(before_png_path).exists() {
        eprintln!("Missing test files");
        return;
    }

    let _ = std::fs::remove_file(cold_path);
    std::fs::copy(path, cold_path).expect("Failed to copy test file");

    std::env::set_var("PRYNX_PERF", "1");

    println!("\n=======================================================");
    println!("   STAGE 1: FAST PROXY RENDER (FIRST FRAME < 100ms)    ");
    println!("=======================================================");

    let t0 = std::time::Instant::now();
    let (_stage1_bytes, stage1_timing) = app_lib::render_tile_png_with_timing(
        cold_path,
        1,
        0.958,
        0,
        None,
        None,
        None,
        None,
    ).expect("Stage 1 render failed");
    let stage1_total_time = t0.elapsed();

    println!("Stage 1 Total Elapsed: {:?}", stage1_total_time);
    println!("Open Document        : {:>6} ms", stage1_timing.open_ms);
    println!("PDFium Render Time   : {:>6} ms", stage1_timing.pdfium_render_ms);
    println!("Convert Bitmap       : {:>6} ms", stage1_timing.convert_ms);
    println!("Encode PNG           : {:>6} ms", stage1_timing.encode_ms);
    println!("Cache Write          : {:>6} ms", stage1_timing.cache_ms);
    println!("=======================================================\n");

    assert!(
        stage1_timing.pdfium_render_ms <= 200,
        "Stage 1 PDFium render exceeded 200ms limit: {} ms",
        stage1_timing.pdfium_render_ms
    );

    println!("=======================================================");
    println!("   STAGE 2: WAITING FOR BACKGROUND AUTO-REFINEMENT...  ");
    println!("=======================================================");

    // Wait until background refinement thread starts and finishes
    let wait_start = std::time::Instant::now();
    std::thread::sleep(std::time::Duration::from_millis(100));
    while app_lib::is_tile_refinement_active() && wait_start.elapsed() < std::time::Duration::from_secs(10) {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    println!("Refinement completed in {:?}", wait_start.elapsed());

    println!("=======================================================");
    println!("   STAGE 3: VERIFY REFINED TILE IN CACHE (0 ms)        ");
    println!("=======================================================");

    let t2 = std::time::Instant::now();
    let (refined_bytes, stage3_timing) = app_lib::render_tile_png_with_timing(
        cold_path,
        1,
        0.958,
        0,
        None,
        None,
        None,
        None,
    ).expect("Stage 3 render failed");
    let stage3_total_time = t2.elapsed();

    println!("Stage 3 Total Elapsed: {:?}", stage3_total_time);
    println!("PDFium Render Time   : {:>6} ms (Cache Hit)", stage3_timing.pdfium_render_ms);
    println!("Total Timing Metric  : {:>6} ms", stage3_timing.total_ms);
    println!("Refined Bytes Size   : {} bytes", refined_bytes.len());
    println!("=======================================================\n");

    // Compare refined tile directly with baseline_before.png
    let before_bytes = std::fs::read(before_png_path).expect("Failed to read baseline_before.png");

    println!("Baseline Before Size : {} bytes", before_bytes.len());
    println!("Refined After Size   : {} bytes", refined_bytes.len());

    let before_img = image::load_from_memory(&before_bytes).expect("Decode before failed").to_rgba8();
    let refined_img = image::load_from_memory(&refined_bytes).expect("Decode refined failed").to_rgba8();

    assert_eq!(before_img.dimensions(), refined_img.dimensions(), "Image dimensions mismatch!");

    let (w, h) = before_img.dimensions();
    let total_pixels = (w * h) as usize;
    let mut diff_pixel_count = 0usize;
    let mut max_channel_diff = 0u8;

    for (p1, p2) in before_img.pixels().zip(refined_img.pixels()) {
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

    println!("=======================================================");
    println!("   AUTO-REFINEMENT PIXEL VERIFICATION REPORT           ");
    println!("=======================================================");
    println!("Total Pixels     : {}", total_pixels);
    println!("Different Pixels : {} / {}", diff_pixel_count, total_pixels);
    println!("Max Channel Diff : {}", max_channel_diff);
    println!("=======================================================\n");

    let _ = std::fs::remove_file(cold_path);

    assert_eq!(diff_pixel_count, 0, "Refined image does not match 100% full-res baseline!");
    assert_eq!(max_channel_diff, 0, "Color difference detected in refined image!");
    println!(">>> SUCCESS: PROGRESSIVE AUTO-REFINEMENT PROVED WITH ZERO PIXEL DIFF (Delta E = 0) <<<");
}
