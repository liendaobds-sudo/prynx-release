use serde_json::Value;

const NUMERIC_PARAMS: &[&str] = &[
    "L", "W", "D", "T", "C", "G", "TH", "HH", "HW", "HHL", "HFH", "SLW", "SLH",
    "TRW", "SLP", "LTW", "LTH", "DFH", "BF", "HR", "HM", "HS", "cupD1", "cupD2",
    "cupH", "cupCoverage", "envW", "envH", "envFH", "envSF", "envWindowW", "envWindowH",
    "envWindowX", "envWindowY", "trayTongueW", "sleeveGlue", "lidD", "lidGap", "pizzaVentD",
    // [HANGING-WINDOW 2026-07-27] Hộp treo có cửa sổ: rộng/cao cửa sổ + cao tai treo.
    // Kèm ABD (chiều sâu đáy dán) trước đây bị bỏ sót khỏi bản sao này.
    "WNW", "WNH", "HTH", "ABD",
];
const BOOLEAN_PARAMS: &[&str] = &[
    "lockTab", "handleHoles", "envWindow", "pizzaVent", "pizzaFrontLock", "pizzaCornerLock",
    // [HANGING-WINDOW 2026-07-27] Công tắc cửa sổ mặt trước của hộp treo.
    "hgbWindow",
];
const STRING_PARAMS: &[&str] = &[
    "glueSide", "boxType", "panelOrder", "handleShape", "handleY", "gableStyle",
    "cupHeightType", "cupFlapPosition", "envFlapShape", "envStyle",
];

fn number_in(value: Option<&Value>, label: &str, min: f64, max: f64) -> Result<f64, String> {
    let number = value.and_then(Value::as_f64)
        .ok_or_else(|| format!("{label} must be a finite number"))?;
    if !number.is_finite() || number < min || number > max {
        return Err(format!("{label} is outside the allowed range"));
    }
    Ok(number)
}

fn one_of(value: Option<&Value>, label: &str, allowed: &[&str]) -> Result<(), String> {
    let text = value.and_then(Value::as_str)
        .ok_or_else(|| format!("{label} must be a string"))?;
    if !allowed.contains(&text) { return Err(format!("{label} is invalid")); }
    Ok(())
}

pub fn validate_request_json(request_json: &str) -> Result<Value, String> {
    let root: Value = serde_json::from_str(request_json)
        .map_err(|_| "Dieline request is not valid JSON".to_string())?;
    let params = root.get("params").and_then(Value::as_object)
        .ok_or_else(|| "Dieline params are required".to_string())?;
    for key in NUMERIC_PARAMS { number_in(params.get(*key), &format!("params.{key}"), 0.0, 10_000.0)?; }
    for key in BOOLEAN_PARAMS {
        if !params.get(*key).is_some_and(Value::is_boolean) {
            return Err(format!("params.{key} must be boolean"));
        }
    }
    for key in STRING_PARAMS {
        if !params.get(*key).is_some_and(Value::is_string) {
            return Err(format!("params.{key} must be a string"));
        }
    }
    // [HANGING-WINDOW 2026-07-27] Đây là BẢN SAO THỨ BA của allow-list boxType
    // (sau runtimeValidation.ts và backend/app/api/routes/dieline_validation.py) và
    // chạy TRƯỚC Boa. Thiếu loại hộp ở đây làm route trả 422 "Không thể tạo khuôn
    // với thông số này." — thông báo mờ, không chỉ ra tầng nào chặn. Thêm loại hộp
    // mới phải sửa ĐỦ BA ĐẦU.
    one_of(params.get("boxType"), "params.boxType", &["rte", "slb", "auto_bottom", "gable", "paper_bag", "cup_sleeve", "pizza", "envelope", "tray", "double_tray", "hanging_window", "flip_top_tuck"])?;
    one_of(params.get("glueSide"), "params.glueSide", &["left", "right"])?;
    one_of(params.get("panelOrder"), "params.panelOrder", &["WLWL", "LWLW"])?;
    one_of(params.get("handleShape"), "params.handleShape", &["oval", "roundRect"])?;
    one_of(params.get("handleY"), "params.handleY", &["bottom", "center"])?;
    one_of(params.get("gableStyle"), "params.gableStyle", &["flat", "pitched"])?;
    one_of(params.get("cupHeightType"), "params.cupHeightType", &["slant", "vertical"])?;
    one_of(params.get("cupFlapPosition"), "params.cupFlapPosition", &["right", "left", "none"])?;
    one_of(params.get("envFlapShape"), "params.envFlapShape", &["straight", "pointed", "rounded"])?;
    one_of(params.get("envStyle"), "params.envStyle", &["wallet", "pocket"])?;

    if root
        .get("includeNesting")
        .is_some_and(|value| !value.is_boolean())
    {
        return Err("includeNesting must be boolean".to_string());
    }

    let nesting = root.get("nestingConfig").and_then(Value::as_object)
        .ok_or_else(|| "Nesting config is required".to_string())?;
    let sheet = nesting.get("sheet").and_then(Value::as_object)
        .ok_or_else(|| "Nesting sheet is required".to_string())?;
    let sleeve = nesting.get("sleeveSheet").and_then(Value::as_object)
        .ok_or_else(|| "Sleeve sheet is required".to_string())?;
    let margin = nesting.get("margin").and_then(Value::as_object)
        .ok_or_else(|| "Nesting margin is required".to_string())?;
    for (label, value) in [
        ("sheet.width", sheet.get("width")), ("sheet.height", sheet.get("height")),
        ("sleeveSheet.width", sleeve.get("width")), ("sleeveSheet.height", sleeve.get("height")),
    ] { number_in(value, label, 50.0, 5_000.0)?; }
    for key in ["top", "right", "bottom", "left"] {
        number_in(margin.get(key), &format!("margin.{key}"), 0.0, 500.0)?;
    }
    number_in(nesting.get("gripperMargin"), "gripperMargin", 0.0, 500.0)?;
    number_in(nesting.get("dieGap"), "dieGap", 0.0, 100.0)?;
    number_in(nesting.get("gutter"), "gutter", 0.0, 100.0)?;
    one_of(nesting.get("rotation"), "rotation", &["none", "90", "auto"])?;
    one_of(nesting.get("sheetOrientation"), "sheetOrientation", &["auto", "portrait", "landscape"])?;
    one_of(nesting.get("nestingMode"), "nestingMode", &["grid", "smart"])?;
    one_of(nesting.get("trayNestingMode"), "trayNestingMode", &["combined", "split"])?;
    Ok(root)
}

#[cfg(test)]
mod tests {
    #[test]
    fn rejects_missing_dimensions_and_huge_sheets() {
        let valid = include_str!("../tests/fixtures/dieline_default_request.json");
        let mut value: serde_json::Value = serde_json::from_str(valid).unwrap();
        value["params"].as_object_mut().unwrap().remove("L");
        assert!(super::validate_request_json(&value.to_string()).is_err());
        let mut value: serde_json::Value = serde_json::from_str(valid).unwrap();
        value["params"]["envStyle"] = serde_json::json!("unsupported");
        assert!(super::validate_request_json(&value.to_string()).is_err());
        let mut value: serde_json::Value = serde_json::from_str(valid).unwrap();
        value["nestingConfig"]["sheet"]["width"] = serde_json::json!(1e100);
        assert!(super::validate_request_json(&value.to_string()).is_err());
        let mut value: serde_json::Value = serde_json::from_str(valid).unwrap();
        value["includeNesting"] = serde_json::json!("yes");
        assert!(super::validate_request_json(&value.to_string()).is_err());
    }

    #[test]
    fn accepts_double_tray() {
        let valid = include_str!("../tests/fixtures/dieline_default_request.json");
        let mut value: serde_json::Value = serde_json::from_str(valid).unwrap();
        value["params"]["boxType"] = serde_json::json!("double_tray");
        assert!(super::validate_request_json(&value.to_string()).is_ok());
    }

    /// [HANGING-WINDOW 2026-07-27] Hộp treo có cửa sổ phải qua được tầng validate
    /// Rust. Trước khi vá, allow-list ở đây thiếu `hanging_window` nên engine bị
    /// chặn trước cả khi Boa chạy.
    #[test]
    fn accepts_hanging_window() {
        let valid = include_str!("../tests/fixtures/dieline_default_request.json");
        let mut value: serde_json::Value = serde_json::from_str(valid).unwrap();
        value["params"]["boxType"] = serde_json::json!("hanging_window");
        assert!(super::validate_request_json(&value.to_string()).is_ok());
    }
    /// [FLIP-TOP-TUCK 2026-08-02 §FTT.3] Loại hộp mới phải qua validation
    /// Rust trước khi bundle TypeScript được gọi.
    #[test]
    fn accepts_flip_top_tuck() {
        let valid = include_str!("../tests/fixtures/dieline_default_request.json");
        let mut value: serde_json::Value = serde_json::from_str(valid).unwrap();
        value["params"]["boxType"] = serde_json::json!("flip_top_tuck");
        assert!(super::validate_request_json(&value.to_string()).is_ok());
    }


    /// Fixture phải mang đủ mọi khoá mới, nếu không NUMERIC/BOOLEAN_PARAMS mở rộng
    /// sẽ làm mọi request thiếu khoá bị từ chối.
    #[test]
    fn fixture_has_hanging_window_params() {
        let valid = include_str!("../tests/fixtures/dieline_default_request.json");
        let value: serde_json::Value = serde_json::from_str(valid).unwrap();
        let params = value["params"].as_object().expect("params object");
        for key in ["WNW", "WNH", "HTH", "ABD"] {
            assert!(params.get(key).is_some_and(|v| v.is_number()), "thiếu số {key}");
        }
        assert!(
            params.get("hgbWindow").is_some_and(|v| v.is_boolean()),
            "thiếu boolean hgbWindow",
        );
    }
}
