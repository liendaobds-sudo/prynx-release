//! LSMR cho CUT: giữ thứ tự CSR/đường chéo và recurrence SciPy 1.12.0.
//!
//! PERF (audit 2026-09-27 §CUT.NATIVE): chỉ chuyển vòng lặp số học vào Rust;
//! không đổi TRF, dung sai, số vòng tối đa, regularization hay bộ kiểm hình học.
//! Mảng NumPy được sao chép trước khi nhả GIL; callback hủy có quyền trả mọi
//! PyErr, kể cả BaseException. Không dùng fast-math, mul_add hay JᵀJ.
//!
//! Chuyển ngữ từ scipy/sparse/linalg/_isolve/lsmr.py (SciPy 1.12.0),
//! Copyright (C) 2010 David Fong and Michael Saunders; _sym_ortho từ lsqr.py,
//! Copyright (c) 2006, Systems Optimization Laboratory. Mã SciPy liên quan:
//! Copyright (c) 2001-2002 Enthought, Inc. 2003-2024, SciPy Developers.
//! All rights reserved.
//!
//! Hai thông báo BSD nguyên văn nằm trong doc của `cutline_lsmr_version`
//! phía dưới: vừa giữ trong source, vừa được PyO3 đưa vào `__doc__` của binary.

use numpy::{IntoPyArray, PyArray1, PyReadonlyArray1};
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;

struct CsrOperator {
    data: Vec<f64>,
    indices: Vec<usize>,
    indptr: Vec<usize>,
    rows: usize,
    cols: usize,
    scale: Vec<f64>,
    diagonal: Vec<f64>,
}

impl CsrOperator {
    #[allow(clippy::too_many_arguments)]
    fn new(
        data: Vec<f64>,
        indices: Vec<i64>,
        indptr: Vec<i64>,
        rows: usize,
        cols: usize,
        scale: Vec<f64>,
        diagonal: Vec<f64>,
    ) -> Result<Self, String> {
        let pointer_len = rows.checked_add(1).ok_or("Số hàng CSR vượt miền chỉ số")?;
        rows.checked_add(cols)
            .ok_or("Số hàng hệ CUT vượt miền chỉ số")?;
        if indptr.len() != pointer_len
            || indptr.first() != Some(&0)
            || indptr.last().and_then(|value| usize::try_from(*value).ok()) != Some(data.len())
            || indices.len() != data.len()
            || indptr.windows(2).any(|pair| pair[0] > pair[1])
        {
            return Err("Con trỏ và số phần tử CSR không hợp lệ".into());
        }
        if indices
            .iter()
            .any(|value| usize::try_from(*value).map_or(true, |index| index >= cols))
        {
            return Err("Chỉ số cột CSR nằm ngoài hệ CUT".into());
        }
        if scale.len() != cols || diagonal.len() != cols {
            return Err("Scale và đường chéo phải khớp số biến CUT".into());
        }
        if data
            .iter()
            .chain(&scale)
            .chain(&diagonal)
            .any(|value| !value.is_finite())
        {
            return Err("Ma trận, scale và đường chéo CUT phải hữu hạn".into());
        }
        // Các cổng trên chứng minh mọi pointer không âm và không vượt nnz.
        Ok(Self {
            data,
            indices: indices.into_iter().map(|value| value as usize).collect(),
            indptr: indptr.into_iter().map(|value| value as usize).collect(),
            rows,
            cols,
            scale,
            diagonal,
        })
    }

    fn output_rows(&self) -> usize {
        self.rows + self.cols
    }

    fn validate_rhs(&self, rhs: &[f64]) -> Result<(), String> {
        if rhs.len() != self.output_rows() || rhs.iter().any(|value| !value.is_finite()) {
            return Err("Vế phải CUT phải hữu hạn và có rows + cols phần tử".into());
        }
        Ok(())
    }

    fn matvec(&self, x: &[f64], scaled: &mut [f64], output: &mut [f64]) {
        for (index, value) in scaled.iter_mut().enumerate() {
            *value = x[index] * self.scale[index];
        }
        for (row, target) in output[..self.rows].iter_mut().enumerate() {
            let mut sum = 0.0;
            for entry in self.indptr[row]..self.indptr[row + 1] {
                sum += self.data[entry] * scaled[self.indices[entry]];
            }
            *target = sum;
        }
        for (index, target) in output[self.rows..].iter_mut().enumerate() {
            *target = self.diagonal[index] * x[index];
        }
    }

    fn rmatvec(&self, x: &[f64], output: &mut [f64]) {
        output.fill(0.0);
        // CSR của J là CSC của J.T; giữ cả thứ tự cột và duplicate nguồn.
        for (row, value) in x[..self.rows].iter().enumerate() {
            for entry in self.indptr[row]..self.indptr[row + 1] {
                output[self.indices[entry]] += self.data[entry] * value;
            }
        }
        for (index, target) in output.iter_mut().enumerate() {
            *target = self.scale[index] * *target;
            *target += self.diagonal[index] * x[self.rows + index];
        }
    }
}

#[derive(Clone, Copy)]
struct LsmrOptions {
    damp: f64,
    atol: f64,
    btol: f64,
    conlim: f64,
    maxiter: usize,
}

impl LsmrOptions {
    fn validate(&self) -> Result<(), String> {
        if [self.damp, self.atol, self.btol, self.conlim]
            .iter()
            .any(|value| !value.is_finite() || *value < 0.0)
        {
            return Err("Damping và ngưỡng LSMR phải hữu hạn, không âm".into());
        }
        Ok(())
    }
}

#[derive(Debug)]
struct LsmrResult {
    x: Vec<f64>,
    istop: u32,
    itn: usize,
    normr: f64,
    normar: f64,
    norma: f64,
    conda: f64,
    normx: f64,
}

fn norm(values: &[f64]) -> f64 {
    // Cùng tổng bình phương như numpy.linalg.norm, không đổi sang norm khác.
    // BLAS có thể nhóm tổng khác; oracle số và artifact phải kiểm sai khác ulp.
    let mut squared = 0.0;
    for value in values {
        squared += value * value;
    }
    squared.sqrt()
}

fn sign(value: f64) -> f64 {
    if value > 0.0 {
        1.0
    } else if value < 0.0 {
        -1.0
    } else if value.is_nan() {
        value
    } else {
        0.0
    }
}

fn sym_ortho(a: f64, b: f64) -> (f64, f64, f64) {
    if b == 0.0 {
        (sign(a), 0.0, a.abs())
    } else if a == 0.0 {
        (0.0, sign(b), b.abs())
    } else if b.abs() > a.abs() {
        let tau = a / b;
        let s = sign(b) / (1.0 + tau * tau).sqrt();
        (s * tau, s, b / s)
    } else {
        let tau = b / a;
        let c = sign(a) / (1.0 + tau * tau).sqrt();
        (c, c * tau, a / c)
    }
}

fn solve<E>(
    operator: &CsrOperator,
    rhs: &[f64],
    options: LsmrOptions,
    check_cancelled: impl FnMut() -> Result<(), E>,
) -> Result<LsmrResult, E> {
    solve_with_norm(
        operator,
        rhs,
        options,
        |values| Ok(norm(values)),
        check_cancelled,
    )
}

fn solve_with_norm<E>(
    operator: &CsrOperator,
    rhs: &[f64],
    options: LsmrOptions,
    mut evaluate_norm: impl FnMut(&[f64]) -> Result<f64, E>,
    mut check_cancelled: impl FnMut() -> Result<(), E>,
) -> Result<LsmrResult, E> {
    check_cancelled()?;
    let result = solve_inner(
        operator,
        rhs,
        options,
        &mut evaluate_norm,
        &mut check_cancelled,
    )?;
    check_cancelled()?;
    Ok(result)
}

fn solve_inner<E>(
    operator: &CsrOperator,
    rhs: &[f64],
    options: LsmrOptions,
    evaluate_norm: &mut impl FnMut(&[f64]) -> Result<f64, E>,
    check_cancelled: &mut impl FnMut() -> Result<(), E>,
) -> Result<LsmrResult, E> {
    let mut u = rhs.to_vec();
    let normb = evaluate_norm(rhs)?;
    let mut x = vec![0.0; operator.cols];
    let mut beta = normb;
    let mut v = vec![0.0; operator.cols];
    let mut alpha = 0.0;
    if beta > 0.0 {
        let inverse = 1.0 / beta;
        for value in &mut u {
            *value *= inverse;
        }
        operator.rmatvec(&u, &mut v);
        alpha = evaluate_norm(&v)?;
    }
    if alpha > 0.0 {
        let inverse = 1.0 / alpha;
        for value in &mut v {
            *value *= inverse;
        }
    }

    let mut itn = 0;
    let mut zetabar = alpha * beta;
    let mut alphabar = alpha;
    let mut rho = 1.0;
    let mut rhobar = 1.0;
    let mut cbar = 1.0;
    let mut sbar = 0.0;
    let mut h = v.clone();
    let mut hbar = vec![0.0; operator.cols];
    let mut betadd = beta;
    let mut betad = 0.0;
    let mut rhodold = 1.0;
    let mut tautildeold = 0.0;
    let mut thetatilde = 0.0;
    let mut zeta = 0.0;
    let mut residual_accumulated = 0.0;
    let mut norma_squared = alpha * alpha;
    let mut maxrbar: f64 = 0.0;
    let mut minrbar: f64 = 1e100;
    let mut norma = norma_squared.sqrt();
    let mut conda = 1.0;
    let mut normx = 0.0;
    let mut istop = 0;
    let ctol = if options.conlim > 0.0 {
        1.0 / options.conlim
    } else {
        0.0
    };
    let mut normr = beta;
    let mut normar = alpha * beta;

    if normar == 0.0 || normb == 0.0 {
        return Ok(LsmrResult {
            x,
            istop,
            itn,
            normr,
            normar,
            norma,
            conda,
            normx,
        });
    }

    let mut scaled = vec![0.0; operator.cols];
    let mut forward = vec![0.0; operator.output_rows()];
    let mut reverse = vec![0.0; operator.cols];
    while itn < options.maxiter {
        itn += 1;
        // Nhịp callback không giảm số vòng hay ngân sách hội tụ của LSMR.
        if itn % 16 == 0 {
            check_cancelled()?;
        }

        for value in &mut u {
            *value *= -alpha;
        }
        operator.matvec(&v, &mut scaled, &mut forward);
        for (value, projected) in u.iter_mut().zip(&forward) {
            *value += projected;
        }
        beta = evaluate_norm(&u)?;
        if beta > 0.0 {
            let inverse = 1.0 / beta;
            for value in &mut u {
                *value *= inverse;
            }
            for value in &mut v {
                *value *= -beta;
            }
            operator.rmatvec(&u, &mut reverse);
            for (value, projected) in v.iter_mut().zip(&reverse) {
                *value += projected;
            }
            alpha = evaluate_norm(&v)?;
            if alpha > 0.0 {
                let inverse = 1.0 / alpha;
                for value in &mut v {
                    *value *= inverse;
                }
            }
        }

        let (chat, shat, alphahat) = sym_ortho(alphabar, options.damp);
        let rhoold = rho;
        let (c, s, next_rho) = sym_ortho(alphahat, beta);
        rho = next_rho;
        let thetanew = s * alpha;
        alphabar = c * alpha;
        let rhobarold = rhobar;
        let zetaold = zeta;
        let thetabar = sbar * rho;
        let rhotemp = cbar * rho;
        (cbar, sbar, rhobar) = sym_ortho(cbar * rho, thetanew);
        zeta = cbar * zetabar;
        zetabar = -sbar * zetabar;

        let hbar_factor = -(thetabar * rho / (rhoold * rhobarold));
        for (value, previous) in hbar.iter_mut().zip(&h) {
            *value *= hbar_factor;
            *value += previous;
        }
        let x_factor = zeta / (rho * rhobar);
        for (value, direction) in x.iter_mut().zip(&hbar) {
            *value += x_factor * direction;
        }
        let h_factor = -(thetanew / rho);
        for (value, direction) in h.iter_mut().zip(&v) {
            *value *= h_factor;
            *value += direction;
        }

        let betaacute = chat * betadd;
        let betacheck = -shat * betadd;
        let betahat = c * betaacute;
        betadd = -s * betaacute;
        let thetatildeold = thetatilde;
        let (ctildeold, stildeold, rhotildeold) = sym_ortho(rhodold, thetabar);
        thetatilde = stildeold * rhobar;
        rhodold = ctildeold * rhobar;
        betad = -stildeold * betad + ctildeold * betahat;
        tautildeold = (zetaold - thetatildeold * tautildeold) / rhotildeold;
        let taud = (zeta - thetatilde * tautildeold) / rhodold;
        residual_accumulated += betacheck * betacheck;
        let residual_delta = betad - taud;
        normr = (residual_accumulated + residual_delta * residual_delta + betadd * betadd).sqrt();

        norma_squared += beta * beta;
        norma = norma_squared.sqrt();
        norma_squared += alpha * alpha;
        maxrbar = maxrbar.max(rhobarold);
        if itn > 1 {
            minrbar = minrbar.min(rhobarold);
        }
        conda = maxrbar.max(rhotemp) / minrbar.min(rhotemp);
        normar = zetabar.abs();
        normx = evaluate_norm(&x)?;
        let test1 = normr / normb;
        let test2 = if norma * normr != 0.0 {
            normar / (norma * normr)
        } else {
            f64::INFINITY
        };
        let test3 = 1.0 / conda;
        let t1 = test1 / (1.0 + norma * normx / normb);
        let rtol = options.btol + options.atol * norma * normx / normb;

        // Giữ thứ tự ưu tiên istop của SciPy; không chuyển thành else-if.
        if itn >= options.maxiter {
            istop = 7;
        }
        if 1.0 + test3 <= 1.0 {
            istop = 6;
        }
        if 1.0 + test2 <= 1.0 {
            istop = 5;
        }
        if 1.0 + t1 <= 1.0 {
            istop = 4;
        }
        if test3 <= ctol {
            istop = 3;
        }
        if test2 <= options.atol {
            istop = 2;
        }
        if test1 <= rtol {
            istop = 1;
        }
        if istop > 0 {
            break;
        }
    }
    Ok(LsmrResult {
        x,
        istop,
        itn,
        normr,
        normar,
        norma,
        conda,
        normx,
    })
}

type PythonLsmrResult<'py> = (
    Bound<'py, PyArray1<f64>>,
    u32,
    usize,
    f64,
    f64,
    f64,
    f64,
    f64,
);

/// Giải [J diag(scale); diag(diagonal)] x ≈ rhs; callback hủy phải ném exception.
#[pyfunction]
#[pyo3(signature = (data, indices, indptr, rows, cols, scale, diagonal, rhs,
                    damp=0.0, atol=1e-6, btol=1e-6, conlim=1e8, maxiter=None, cancel=None,
                    norm_provider=None))]
#[allow(clippy::too_many_arguments)]
pub fn cutline_lsmr<'py>(
    py: Python<'py>,
    data: PyReadonlyArray1<'py, f64>,
    indices: PyReadonlyArray1<'py, i64>,
    indptr: PyReadonlyArray1<'py, i64>,
    rows: usize,
    cols: usize,
    scale: PyReadonlyArray1<'py, f64>,
    diagonal: PyReadonlyArray1<'py, f64>,
    rhs: PyReadonlyArray1<'py, f64>,
    damp: f64,
    atol: f64,
    btol: f64,
    conlim: f64,
    maxiter: Option<usize>,
    cancel: Option<Py<PyAny>>,
    norm_provider: Option<Py<PyAny>>,
) -> PyResult<PythonLsmrResult<'py>> {
    if cancel
        .as_ref()
        .is_some_and(|callback| !callback.bind(py).is_callable())
    {
        return Err(PyValueError::new_err("Callback hủy CUT phải là callable"));
    }
    if norm_provider
        .as_ref()
        .is_some_and(|callback| !callback.bind(py).is_callable())
    {
        return Err(PyValueError::new_err("Provider norm CUT phải là callable"));
    }
    let operator = CsrOperator::new(
        data.as_array().iter().copied().collect(),
        indices.as_array().iter().copied().collect(),
        indptr.as_array().iter().copied().collect(),
        rows,
        cols,
        scale.as_array().iter().copied().collect(),
        diagonal.as_array().iter().copied().collect(),
    )
    .map_err(PyValueError::new_err)?;
    let rhs: Vec<f64> = rhs.as_array().iter().copied().collect();
    operator.validate_rhs(&rhs).map_err(PyValueError::new_err)?;
    let options = LsmrOptions {
        damp,
        atol,
        btol,
        conlim,
        maxiter: maxiter.unwrap_or(operator.output_rows().min(cols)),
    };
    options.validate().map_err(PyValueError::new_err)?;
    let result = py.detach(move || {
        let check_cancelled = || -> PyResult<()> {
            if let Some(callback) = &cancel {
                Python::attach(|py| callback.bind(py).call0().map(|_| ()))
            } else {
                Ok(())
            }
        };
        if let Some(provider) = norm_provider {
            // Dùng API Python/NumPy thay cho FFI DLL thô. Mỗi norm nhận một
            // bản sao do NumPy sở hữu; callback có giữ/mutate nó cũng không
            // làm đổi vector LSMR. Exception đi xuyên, không chạy lại solver.
            solve_with_norm(
                &operator,
                &rhs,
                options,
                |values| {
                    Python::attach(|py| {
                        let copied = values.to_vec().into_pyarray(py);
                        provider.bind(py).call1((copied,))?.extract::<f64>()
                    })
                },
                check_cancelled,
            )
        } else {
            solve(&operator, &rhs, options, check_cancelled)
        }
    })?;
    Ok((
        result.x.into_pyarray(py),
        result.istop,
        result.itn,
        result.normr,
        result.normar,
        result.norma,
        result.conda,
        result.normx,
    ))
}

/// Phiên bản hợp đồng CSR/LSMR; Python chỉ nối API đã được đối chứng.
///
/// Ghi công LSMR gốc (scipy/sparse/linalg/_isolve/lsmr.py, SciPy 1.12.0):
/// Copyright (C) 2010 David Fong and Michael Saunders
///
/// Giấy phép SciPy nguyên văn (scipy-1.12.0.dist-info/LICENSE.txt):
///
/// Copyright (c) 2001-2002 Enthought, Inc. 2003-2024, SciPy Developers.
/// All rights reserved.
///
/// Redistribution and use in source and binary forms, with or without
/// modification, are permitted provided that the following conditions
/// are met:
///
/// 1. Redistributions of source code must retain the above copyright
///    notice, this list of conditions and the following disclaimer.
///
/// 2. Redistributions in binary form must reproduce the above
///    copyright notice, this list of conditions and the following
///    disclaimer in the documentation and/or other materials provided
///    with the distribution.
///
/// 3. Neither the name of the copyright holder nor the names of its
///    contributors may be used to endorse or promote products derived
///    from this software without specific prior written permission.
///
/// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
/// "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
/// LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
/// A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
/// OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
/// SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
/// LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
/// DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
/// THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
/// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
/// OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
///
/// Giấy phép _sym_ortho nguyên văn (scipy/sparse/linalg/_isolve/lsqr.py):
///
/// Copyright (c) 2006, Systems Optimization Laboratory
/// All rights reserved.
///
/// Redistribution and use in source and binary forms, with or without
/// modification, are permitted provided that the following conditions are
/// met:
///
///     * Redistributions of source code must retain the above copyright
///       notice, this list of conditions and the following disclaimer.
///
///     * Redistributions in binary form must reproduce the above
///       copyright notice, this list of conditions and the following
///       disclaimer in the documentation and/or other materials provided
///       with the distribution.
///
///     * Neither the name of Stanford University nor the names of its
///       contributors may be used to endorse or promote products derived
///       from this software without specific prior written permission.
///
/// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
/// "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
/// LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
/// A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
/// OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
/// SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
/// LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
/// DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
/// THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
/// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
/// OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
#[pyfunction]
pub fn cutline_lsmr_version() -> u32 {
    2
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::convert::Infallible;

    fn options(maxiter: usize) -> LsmrOptions {
        LsmrOptions {
            damp: 0.0,
            atol: 1e-12,
            btol: 1e-12,
            conlim: 1e8,
            maxiter,
        }
    }

    fn run(operator: &CsrOperator, rhs: &[f64], options: LsmrOptions) -> LsmrResult {
        operator.validate_rhs(rhs).unwrap();
        options.validate().unwrap();
        solve(operator, rhs, options, || Ok::<(), Infallible>(())).unwrap()
    }

    fn near(actual: f64, expected: f64, epsilon: f64) {
        assert!(
            (actual - expected).abs() <= epsilon,
            "{actual:?} != {expected:?}"
        );
    }

    #[test]
    fn csr_products_keep_unsorted_duplicate_entries_and_diagonal() {
        let operator = CsrOperator::new(
            vec![2.0, -1.0, 0.5, 3.0, 4.0],
            vec![1, 0, 1, 0, 1],
            vec![0, 3, 5],
            2,
            2,
            vec![2.0, 3.0],
            vec![0.5, 0.25],
        )
        .unwrap();
        let mut forward = vec![0.0; 4];
        operator.matvec(&[2.0, 4.0], &mut [0.0; 2], &mut forward);
        assert_eq!(forward, vec![26.0, 60.0, 1.0, 1.0]);
        let mut reverse = vec![0.0; 2];
        operator.rmatvec(&[1.0, 2.0, 3.0, 4.0], &mut reverse);
        assert_eq!(reverse, vec![11.5, 32.5]);
    }

    #[test]
    fn regularized_solution_matches_scipy_fixture() {
        let operator = CsrOperator::new(
            vec![3.0, 1.0, 4.0, -1.0, 1.0, 1.0],
            vec![0, 2, 1, 2, 0, 1],
            vec![0, 2, 4, 6],
            3,
            3,
            vec![0.8, 1.2, 0.6],
            vec![0.2, 0.3, 0.1],
        )
        .unwrap();
        let result = run(&operator, &[1.0, -2.0, 0.5, 0.0, 0.0, 0.0], options(20));
        let expected = [0.78391138, -0.53791368, -1.20277232];
        for (actual, expected) in result.x.iter().zip(expected) {
            near(*actual, expected, 5e-9);
        }
        assert_eq!(result.istop, 2);
        assert_eq!(result.itn, 3);
        near(result.normr, 0.6154796215283154, 1e-12);
        near(result.norma, 5.63382640840131, 1e-11);
        near(result.normx, 1.5331436414055708, 1e-11);
    }

    #[test]
    fn rank_deficient_source_remains_least_squares_not_normal_equations() {
        let operator = CsrOperator::new(
            vec![1.0, 2.0, 1.0, 2.0, 4.0, 2.0],
            vec![0, 1, 2, 0, 1, 2],
            vec![0, 3, 6, 6],
            3,
            3,
            vec![1.0; 3],
            vec![0.0; 3],
        )
        .unwrap();
        let result = run(&operator, &[1.0, 2.0, 3.0, 0.0, 0.0, 0.0], options(20));
        for (actual, expected) in result.x.iter().zip([1.0 / 6.0, 1.0 / 3.0, 1.0 / 6.0]) {
            near(*actual, expected, 1e-12);
        }
        assert_eq!(result.istop, 2);
        near(result.normr, 3.0, 1e-12);
    }

    #[test]
    fn damping_matches_diagonal_closed_form() {
        let operator = CsrOperator::new(
            vec![2.0, 3.0],
            vec![0, 1],
            vec![0, 1, 2],
            2,
            2,
            vec![0.5, 2.0],
            vec![0.25, 0.75],
        )
        .unwrap();
        let result = run(
            &operator,
            &[2.0, -3.0, 0.0, 0.0],
            LsmrOptions {
                damp: 0.4,
                ..options(10)
            },
        );
        near(result.x[0], 2.0 / (1.0 + 0.25 * 0.25 + 0.4 * 0.4), 1e-12);
        near(result.x[1], -18.0 / (36.0 + 0.75 * 0.75 + 0.4 * 0.4), 1e-12);
    }

    #[test]
    fn empty_rhs_columns_and_zero_iterations_are_safe() {
        let operator =
            CsrOperator::new(vec![], vec![], vec![0, 0, 0], 2, 0, vec![], vec![]).unwrap();
        let result = run(&operator, &[3.0, 4.0], options(0));
        assert!(result.x.is_empty());
        assert_eq!((result.istop, result.itn), (0, 0));
        near(result.normr, 5.0, 0.0);
        let diagonal =
            CsrOperator::new(vec![], vec![], vec![0], 0, 1, vec![1.0], vec![2.0]).unwrap();
        let zero = run(&diagonal, &[0.0], options(10));
        assert_eq!(zero.x, vec![0.0]);
        assert_eq!((zero.istop, zero.itn, zero.normr), (0, 0, 0.0));
        let no_iterations = run(&diagonal, &[2.0], options(0));
        assert_eq!(no_iterations.x, vec![0.0]);
        assert_eq!((no_iterations.istop, no_iterations.itn), (0, 0));
    }

    #[test]
    fn validation_rejects_bad_csr_and_nonfinite_arguments() {
        for (indices, indptr) in [
            (vec![-1], vec![0, 1]),
            (vec![1], vec![0, 1]),
            (vec![0], vec![1, 1]),
            (vec![0], vec![0, 2]),
        ] {
            assert!(
                CsrOperator::new(vec![1.0], indices, indptr, 1, 1, vec![1.0], vec![0.0]).is_err()
            );
        }
        assert!(CsrOperator::new(
            vec![f64::NAN],
            vec![0],
            vec![0, 1],
            1,
            1,
            vec![1.0],
            vec![0.0]
        )
        .is_err());
        assert!(LsmrOptions {
            atol: -1.0,
            ..options(10)
        }
        .validate()
        .is_err());
        assert!(LsmrOptions {
            damp: f64::INFINITY,
            ..options(10)
        }
        .validate()
        .is_err());
        let operator =
            CsrOperator::new(vec![], vec![], vec![0], 0, 1, vec![1.0], vec![0.0]).unwrap();
        assert!(operator.validate_rhs(&[]).is_err());
        assert!(operator.validate_rhs(&[f64::NAN]).is_err());
    }

    #[test]
    fn cancellation_keeps_original_error_and_has_final_checkpoint() {
        let count = 64;
        let operator = CsrOperator::new(
            (1..=count).map(|value| 1.0 / value as f64).collect(),
            (0..count as i64).collect(),
            (0..=count as i64).collect(),
            count,
            count,
            vec![1.0; count],
            vec![0.0; count],
        )
        .unwrap();
        let mut calls = 0;
        let result = solve(
            &operator,
            &vec![1.0; count * 2],
            LsmrOptions {
                atol: 0.0,
                btol: 0.0,
                conlim: 0.0,
                ..options(40)
            },
            || {
                calls += 1;
                if calls == 2 {
                    Err("hủy gốc")
                } else {
                    Ok(())
                }
            },
        );
        assert!(matches!(result, Err("hủy gốc")));
        assert_eq!(calls, 2);
        let mut final_calls = 0;
        solve(&operator, &vec![0.0; count * 2], options(0), || {
            final_calls += 1;
            Ok::<(), Infallible>(())
        })
        .unwrap();
        assert_eq!(final_calls, 2);
    }

    #[test]
    fn symmetric_rotations_keep_zero_signs_and_extreme_ratio() {
        assert_eq!(sym_ortho(-0.0, 0.0), (0.0, 0.0, 0.0));
        assert_eq!(sym_ortho(0.0, -2.0), (0.0, -1.0, 2.0));
        let (c, s, r) = sym_ortho(3.0, 4.0);
        near(c, 0.6, 1e-15);
        near(s, 0.8, 1e-15);
        near(r, 5.0, 1e-15);
        let (_, _, r) = sym_ortho(1e300, 1e-300);
        assert!(r.is_finite());
    }
}
