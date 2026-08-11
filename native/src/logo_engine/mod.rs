//! Facade chuyển tiếp cho PrynX Logo Engine v2.
//!
//! Lô A giữ nguyên VTracer ở đường production nhưng buộc nó đi qua một hợp
//! đồng prepare/trace chung. Các tracer riêng sẽ cắm vào facade ở lô sau.

mod color;
mod contour;
mod curve_fit;
mod preprocess;
mod profiles;
mod qc;
mod request;
mod result;
mod scene;
mod simplify;
mod svg_writer;
mod topology;

#[cfg(test)]
mod artifact_tests;
#[cfg(test)]
mod curve_fit_tests;
#[cfg(test)]
mod preprocess_tests;
#[cfg(test)]
mod profile_tests;
#[cfg(test)]
mod topology_tests;

pub(crate) use profiles::{CORE_ENGINE_NAME, CORE_ENGINE_VERSION};
pub(crate) use request::{LogoEngineProfile, LogoEngineRequest};
pub(crate) use result::{
    build_structured_result, validate_structured_request, LogoStructuredResult,
    StructuredResultOptions, LOGO_STRUCTURED_RESULT_VERSION,
};
pub(crate) use scene::{EngineProvenance, VectorScene};
pub(crate) use svg_writer::PhysicalSizeMm;

// LOGO-ENGINE-V2 (audit 2026-08-10 Lô A): phase của engine riêng được chốt
// trong facade trước khi các lô preprocess/postprocess bắt đầu sử dụng.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LogoEnginePhase {
    Segment,
    Compose,
    Optimize,
    Preprocess,
    Trace,
    Postprocess,
    Quality,
    Write,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct LogoEngineProgress {
    pub(crate) phase: LogoEnginePhase,
    pub(crate) fraction: f32,
}

impl LogoEngineProgress {
    pub(crate) fn new(phase: LogoEnginePhase, fraction: f32) -> Self {
        Self {
            phase,
            fraction: fraction.clamp(0.0, 1.0),
        }
    }
}

pub(crate) struct LogoBackendOutput {
    pub(crate) svg: String,
    pub(crate) scene: Option<VectorScene>,
}

impl LogoBackendOutput {
    pub(crate) fn legacy_svg(svg: String) -> Self {
        Self { svg, scene: None }
    }
}

pub(crate) struct LogoEngineOutput {
    pub(crate) svg: String,
    pub(crate) scene: Option<VectorScene>,
    pub(crate) provenance: EngineProvenance,
}

pub(crate) struct PreparedLogoTrace<T> {
    payload: T,
    provenance: EngineProvenance,
}

pub(crate) trait LogoTraceBackend {
    type Prepared;
    type Cancel;

    fn engine_name(&self) -> &'static str;
    fn engine_version(&self) -> &'static str;
    fn prepare(&self, request: LogoEngineRequest) -> Result<Self::Prepared, String>;
    fn trace(
        &self,
        prepared: Self::Prepared,
        cancel: Self::Cancel,
        on_progress: &mut dyn FnMut(LogoEngineProgress),
    ) -> Result<LogoBackendOutput, String>;
}

pub(crate) struct LogoEngineFacade<B> {
    backend: B,
}

impl<B: LogoTraceBackend> LogoEngineFacade<B> {
    pub(crate) fn new(backend: B) -> Self {
        Self { backend }
    }

    pub(crate) fn prepare(
        &self,
        request: LogoEngineRequest,
    ) -> Result<PreparedLogoTrace<B::Prepared>, String> {
        // LOGO-ENGINE-V2 (audit 2026-08-10 Lô A): ghi provenance trước khi
        // backend cụ thể tiêu thụ request, không suy lại từ chuỗi SVG.
        let provenance = EngineProvenance {
            engine: self.backend.engine_name().to_string(),
            engine_version: self.backend.engine_version().to_string(),
            profile: request.profile.as_str().to_string(),
            settings_hash: request.settings_hash(),
        };
        let payload = self.backend.prepare(request)?;
        Ok(PreparedLogoTrace {
            payload,
            provenance,
        })
    }

    pub(crate) fn trace(
        &self,
        prepared: PreparedLogoTrace<B::Prepared>,
        cancel: B::Cancel,
        on_progress: &mut dyn FnMut(LogoEngineProgress),
    ) -> Result<LogoEngineOutput, String> {
        let output = self.backend.trace(prepared.payload, cancel, on_progress)?;
        Ok(LogoEngineOutput {
            svg: output.svg,
            scene: output.scene,
            provenance: prepared.provenance,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct EchoBackend;

    impl LogoTraceBackend for EchoBackend {
        type Prepared = String;
        type Cancel = ();

        fn engine_name(&self) -> &'static str {
            "echo"
        }

        fn engine_version(&self) -> &'static str {
            "1"
        }

        fn prepare(&self, request: LogoEngineRequest) -> Result<Self::Prepared, String> {
            Ok(format!("{}x{}", request.width, request.height))
        }

        fn trace(
            &self,
            prepared: Self::Prepared,
            _cancel: Self::Cancel,
            on_progress: &mut dyn FnMut(LogoEngineProgress),
        ) -> Result<LogoBackendOutput, String> {
            on_progress(LogoEngineProgress::new(LogoEnginePhase::Write, 2.0));
            Ok(LogoBackendOutput::legacy_svg(prepared))
        }
    }

    #[test]
    fn facade_keeps_output_and_attaches_provenance() {
        let request = LogoEngineRequest::from_legacy_api(
            12,
            8,
            vec![255; 12 * 8 * 4],
            "monochrome",
            vec![],
            0.5,
            4,
        )
        .unwrap();
        let facade = LogoEngineFacade::new(EchoBackend);
        let prepared = facade.prepare(request).unwrap();
        let mut reports = Vec::new();
        let output = facade
            .trace(prepared, (), &mut |progress| reports.push(progress))
            .unwrap();

        assert_eq!(output.svg, "12x8");
        assert!(output.scene.is_none());
        assert_eq!(output.provenance.engine, "echo");
        assert_eq!(output.provenance.profile, "silhouette");
        assert_eq!(output.provenance.settings_hash.len(), 64);
        assert_eq!(reports[0].fraction, 1.0);
    }
}
