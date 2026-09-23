//! Worker benchmark riêng: chạy protocol/PPE thật, tuyệt đối không khởi tạo UI.

fn accepts_worker_args(args: &[String]) -> bool {
    args.len() == 1 && args[0] == "--prynx-render-worker"
}

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if !accepts_worker_args(&args) {
        eprintln!("Chỉ dùng --prynx-render-worker cùng harness benchmark qua stdin/stdout.");
        std::process::exit(2);
    }
    // PERF (audit 2026-09-23 §R23.LOG-ONLY): cùng entry với worker production,
    // không gọi app_lib::run() nên không mở WebView hoặc đụng phiên app của user.
    std::process::exit(app_lib::run_render_worker_stdio());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chi_nhan_che_do_worker_khong_co_nhanh_gui() {
        assert!(accepts_worker_args(&["--prynx-render-worker".into()]));
        assert!(!accepts_worker_args(&[]));
        assert!(!accepts_worker_args(&["--help".into()]));
        assert!(!accepts_worker_args(&["--prynx-render-worker".into(), "extra".into()]));
    }
}
