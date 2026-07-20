use std::cell::RefCell;

use boa_engine::{Context, Source};
use pyo3::exceptions::PyRuntimeError;
use pyo3::prelude::*;

const ENGINE_SOURCE: &str = include_str!("generated/dieline_engine.bundle.js");
const MAX_REQUEST_BYTES: usize = 128 * 1024;
const MAX_RESPONSE_BYTES: usize = 24 * 1024 * 1024;

thread_local! {
    // Boa contexts are intentionally thread-local: they are not Send, and
    // parsing the bundled engine on every preview request would cause jitter.
    static ENGINE_CONTEXT: RefCell<Option<Context>> = const { RefCell::new(None) };
}

fn format_js_error(error: boa_engine::JsError) -> String {
    format!("{error}")
}

fn ensure_engine_context(slot: &mut Option<Context>) -> Result<(), String> {
    if slot.is_none() {
        let mut context = Context::default();
        context
            .eval(Source::from_bytes(ENGINE_SOURCE))
            .map_err(format_js_error)?;
        *slot = Some(context);
    }
    Ok(())
}

fn warm_engine() -> Result<(), String> {
    ENGINE_CONTEXT.with(|slot| ensure_engine_context(&mut slot.borrow_mut()))
}

fn run_engine(request_json: &str) -> Result<String, String> {
    if request_json.len() > MAX_REQUEST_BYTES {
        return Err("Dieline request is too large".to_string());
    }
    crate::dieline_request::validate_request_json(request_json)?;

    ENGINE_CONTEXT.with(|slot| {
        let mut slot = slot.borrow_mut();
        ensure_engine_context(&mut slot)?;
        let context = slot.as_mut().expect("context initialized");
        // Serialize the JSON as a JavaScript string literal. User-controlled
        // data never becomes executable source.
        let quoted = serde_json::to_string(request_json)
            .map_err(|_| "Could not encode dieline request".to_string())?;
        let script = format!("__prynxGenerateDieline({quoted})");
        let value = context
            .eval(Source::from_bytes(script.as_bytes()))
            .map_err(format_js_error)?;
        let result = value
            .to_string(context)
            .map_err(format_js_error)?
            .to_std_string_escaped();

        if result.len() > MAX_RESPONSE_BYTES {
            return Err("Dieline result is too large".to_string());
        }
        serde_json::from_str::<serde_json::Value>(&result)
            .map_err(|_| "Dieline engine returned invalid JSON".to_string())?;
        Ok(result)
    })
}

/// Parse and initialize the protected engine without generating user data.
/// The backend calls this on its dedicated worker so the first preview is warm.
#[pyfunction]
pub fn warm_dieline_engine(py: Python<'_>) -> PyResult<()> {
    py.detach(warm_engine).map_err(PyRuntimeError::new_err)
}

#[pyfunction]
pub fn generate_dieline_json(
    py: Python<'_>,
    request_json: String,
    license_token: String,
    hwid: String,
    license_key: String,
) -> PyResult<String> {
    py.detach(move || {
        crate::dieline_license::authorize_dieline(&license_token, &hwid, &license_key)?;
        run_engine(&request_json)
    })
    .map_err(PyRuntimeError::new_err)
}

#[cfg(test)]
mod tests {
    #[test]
    fn rejects_non_json_input() {
        assert!(super::run_engine("not-json").is_err());
    }

    #[test]
    fn bundled_engine_warms_then_generates_default_dieline() {
        super::warm_engine().expect("engine warmup should succeed");
        let request = include_str!("../tests/fixtures/dieline_default_request.json");
        let raw = super::run_engine(request).expect("bundled engine should run");
        let value: serde_json::Value = serde_json::from_str(&raw).expect("valid response JSON");
        assert_eq!(value["dieline"]["params"]["boxType"], "rte");
        assert!(value["dieline"]["panels"]
            .as_array()
            .is_some_and(|p| !p.is_empty()));
        assert!(value["nestingResult"]["countPerSheet"]
            .as_u64()
            .is_some_and(|n| n > 0));
    }

    #[test]
    fn bundled_slb_has_only_one_visible_tuck_fold() {
        let mut request: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/dieline_default_request.json"
        ))
        .expect("valid request fixture");
        request["params"]["boxType"] = serde_json::Value::String("slb".to_owned());
        request["includeNesting"] = serde_json::Value::Bool(false);

        let raw = super::run_engine(&request.to_string()).expect("bundled SLB engine should run");
        let value: serde_json::Value = serde_json::from_str(&raw).expect("valid response JSON");
        let dieline = &value["dieline"];
        let top_threshold = request["params"]["D"].as_f64().unwrap()
            + request["params"]["W"].as_f64().unwrap()
            - 5.0;

        let visible_top_creases = dieline["allPaths"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|path| {
                if path["tag"] != "CREASE" {
                    return false;
                }
                let Some(points) = path["points"].as_array() else {
                    return false;
                };
                if points.len() != 2 {
                    return false;
                }
                let (Some(y1), Some(y2)) = (points[0]["y"].as_f64(), points[1]["y"].as_f64())
                else {
                    return false;
                };
                (y1 - y2).abs() < f64::EPSILON && y1 > top_threshold
            })
            .count();
        assert_eq!(
            visible_top_creases, 1,
            "SLB top tuck must expose one fold line"
        );

        let tuck_panel = dieline["panels"]
            .as_array()
            .unwrap()
            .iter()
            .find(|panel| panel["name"] == "tuck_top")
            .expect("SLB tuck_top panel");
        let false_tuck_creases = tuck_panel["paths"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|path| path["tag"] == "CREASE")
            .count();
        assert_eq!(
            false_tuck_creases, 0,
            "tuck panel must not add a duplicate crease"
        );
    }
}
