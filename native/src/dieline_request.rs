use serde_json::Value;

const NUMERIC_PARAMS: &[&str] = &[
    "L", "W", "D", "T", "C", "G", "TH", "HH", "HW", "HHL", "HFH", "SLW", "SLH",
    "TRW", "SLP", "LTW", "LTH", "DFH", "BF", "HR", "HM", "HS", "cupD1", "cupD2",
    "cupH", "cupCoverage", "envW", "envH", "envFH", "envSF", "envWindowW", "envWindowH",
    "envWindowX", "envWindowY", "trayTongueW", "sleeveGlue", "pizzaVentD",
];
const BOOLEAN_PARAMS: &[&str] = &[
    "lockTab", "handleHoles", "envWindow", "pizzaVent", "pizzaFrontLock", "pizzaCornerLock",
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
    one_of(params.get("boxType"), "params.boxType", &["rte", "slb", "gable", "paper_bag", "cup_sleeve", "pizza", "envelope", "tray"])?;
    one_of(params.get("glueSide"), "params.glueSide", &["left", "right"])?;
    one_of(params.get("panelOrder"), "params.panelOrder", &["WLWL", "LWLW"])?;
    one_of(params.get("handleShape"), "params.handleShape", &["oval", "roundRect"])?;
    one_of(params.get("handleY"), "params.handleY", &["bottom", "center"])?;
    one_of(params.get("gableStyle"), "params.gableStyle", &["flat", "pitched"])?;
    one_of(params.get("cupHeightType"), "params.cupHeightType", &["slant", "vertical"])?;
    one_of(params.get("cupFlapPosition"), "params.cupFlapPosition", &["right", "left", "none"])?;
    one_of(params.get("envFlapShape"), "params.envFlapShape", &["straight", "pointed", "rounded"])?;
    one_of(params.get("envStyle"), "params.envStyle", &["wallet", "pocket"])?;

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
    }
}
