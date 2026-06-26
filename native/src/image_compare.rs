use numpy::ndarray::Array2;
use numpy::{IntoPyArray, PyArray2, PyReadonlyArray2};
use pyo3::prelude::*;
use rayon::prelude::*;

/// Computes the absolute difference between two grayscale images and applies a threshold.
/// This runs in a single pass using Rayon for massive multi-threading speedups,
/// avoiding intermediate memory allocations.
#[pyfunction]
pub fn fast_diff_mask_gray<'py>(
    py: Python<'py>,
    img1: PyReadonlyArray2<'py, u8>,
    img2: PyReadonlyArray2<'py, u8>,
    threshold: u8,
) -> PyResult<Bound<'py, PyArray2<u8>>> {
    let arr1 = img1.as_array();
    let arr2 = img2.as_array();
    
    if arr1.shape() != arr2.shape() {
        return Err(pyo3::exceptions::PyValueError::new_err(
            format!("Images must have the same shape, got {:?} and {:?}", arr1.shape(), arr2.shape())
        ));
    }
    
    let dim = (arr1.shape()[0], arr1.shape()[1]);
    let mut result = Array2::<u8>::zeros(dim);
    
    // Try to get flat slices for max performance with rayon
    if let (Some(s1), Some(s2), Some(s_out)) = (arr1.as_slice(), arr2.as_slice(), result.as_slice_mut()) {
        s_out.par_iter_mut()
            .zip(s1.par_iter())
            .zip(s2.par_iter())
            .for_each(|((out, &v1), &v2)| {
                let diff = v1.abs_diff(v2);
                *out = if diff > threshold { 255 } else { 0 };
            });
    } else {
        // Fallback for non-contiguous arrays (rare for OpenCV images, but possible)
        py.allow_threads(|| {
            // Using ndarray's Zip for iteration
            use numpy::ndarray::Zip;
            Zip::from(&mut result)
                .and(&arr1)
                .and(&arr2)
                .for_each(|out, &v1, &v2| {
                    let diff = v1.abs_diff(v2);
                    *out = if diff > threshold { 255 } else { 0 };
                });
        });
    }
    
    Ok(result.into_pyarray(py))
}

pub fn register_module(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(fast_diff_mask_gray, m)?)?;
    Ok(())
}
