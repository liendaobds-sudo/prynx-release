// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Print worker out-of-process: driver GDI crash chỉ giết worker, không kéo UI.
    // Spawn: PrynX.exe --prynx-print-job <job.json> --prynx-print-result <out.json>
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--prynx-print-job") {
        let job_path = args.get(i + 1).map(|s| s.as_str()).unwrap_or("");
        let result_path = args
            .iter()
            .position(|a| a == "--prynx-print-result")
            .and_then(|j| args.get(j + 1))
            .map(|s| s.as_str())
            .unwrap_or("");
        if job_path.is_empty() || result_path.is_empty() {
            eprintln!("usage: --prynx-print-job <path> --prynx-print-result <path>");
            std::process::exit(2);
        }
        let code = app_lib::run_print_worker(job_path, result_path);
        std::process::exit(code);
    }
    app_lib::run();
}
