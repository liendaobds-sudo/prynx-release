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

fn run_engine(request_json: &str) -> Result<String, String> {
    if request_json.len() > MAX_REQUEST_BYTES {
        return Err("Dieline request is too large".to_string());
    }
    crate::dieline_request::validate_request_json(request_json)?;

    ENGINE_CONTEXT.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot.is_none() {
            let mut context = Context::default();
            context
                .eval(Source::from_bytes(ENGINE_SOURCE))
                .map_err(format_js_error)?;
            *slot = Some(context);
        }

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
    fn bundled_engine_generates_default_dieline() {
        let request = include_str!("../tests/fixtures/dieline_default_request.json");
        let raw = super::run_engine(request).expect("bundled engine should run");
        let value: serde_json::Value = serde_json::from_str(&raw).expect("valid response JSON");
        assert_eq!(value["dieline"]["params"]["boxType"], "rte");
        assert!(value["dieline"]["panels"].as_array().is_some_and(|p| !p.is_empty()));
        assert!(value["nestingResult"]["countPerSheet"].as_u64().is_some_and(|n| n > 0));
    }
}
