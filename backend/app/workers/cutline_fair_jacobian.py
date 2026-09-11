"""Đạo hàm thưa của residual neo tự do; không chọn hay chứng nhận nghiệm.

PERF (audit 2026-09-10 §SIMPERF.2): tính đạo hàm giải tích thay hàng nghìn
lần thử sai phân. Giữ nguyên residual và nhánh chặn mẫu số độ cong của
solver; helper không nhập solver để tránh phụ thuộc vòng hoặc đổi bộ kiểm.
"""
from __future__ import annotations

import numpy as np
from scipy.sparse import coo_matrix, csr_matrix


def _curvature_gradient(velocity, acceleration):
    """Đạo hàm κ=cross(v,a)/max(|v|³,1e-20), kể cả khi mẫu số bị chặn."""
    speed = np.linalg.norm(velocity, axis=1)
    denominator = np.maximum(speed**3, 1e-20)
    numerator = velocity[:, 0]*acceleration[:, 1]-velocity[:, 1]*acceleration[:, 0]
    gradient_v = np.column_stack([acceleration[:, 1], -acceleration[:, 0]])/denominator[:, None]
    unclamped = speed**3 > 1e-20
    scale = np.where(unclamped, numerator*3*speed/denominator**2, 0.)
    gradient_v -= scale[:, None]*velocity
    gradient_a = np.column_stack([-velocity[:, 1], velocity[:, 0]])/denominator[:, None]
    return gradient_v, gradient_a


def _curvature_value_gradient(curves, values, angle_delta, *, end=False):
    """Qua control-points để giữ đúng cả hướng độc lập tại góc được khóa."""
    if end:
        velocity = 3*(curves[:, 3]-curves[:, 2])
        acceleration = 6*(curves[:, 3]-2*curves[:, 2]+curves[:, 1])
    else:
        velocity = 3*(curves[:, 1]-curves[:, 0])
        acceleration = 6*(curves[:, 2]-2*curves[:, 1]+curves[:, 0])
    gv, ga = _curvature_gradient(velocity, acceleration)
    zeros = np.zeros_like(gv)
    if end:
        gradients = np.stack([zeros, 6*ga, -3*gv-12*ga, 3*gv+6*ga], axis=1)
    else:
        gradients = np.stack([-3*gv+6*ga, 3*gv-12*ga, 6*ga, zeros], axis=1)
    tangent = np.column_stack([np.cos(values[:, 2]), np.sin(values[:, 2])])
    incoming = np.column_stack([np.cos(values[:, 2]+angle_delta), np.sin(values[:, 2]+angle_delta)])
    outgoing = np.exp(values[:, 3, None])*tangent
    incoming = np.roll(np.exp(values[:, 4, None])*incoming, -1, axis=0)
    rotate = lambda vectors: np.column_stack([-vectors[:, 1], vectors[:, 0]])
    left, right = np.zeros((len(curves), 5)), np.zeros((len(curves), 5))
    left[:, :2] = gradients[:, 0]+gradients[:, 1]
    right[:, :2] = gradients[:, 2]+gradients[:, 3]
    left[:, 2] = np.sum(gradients[:, 1]*rotate(outgoing), axis=1)
    left[:, 3] = np.sum(gradients[:, 1]*outgoing, axis=1)
    right[:, 2] = -np.sum(gradients[:, 2]*rotate(incoming), axis=1)
    right[:, 4] = -np.sum(gradients[:, 2]*incoming, axis=1)
    return left, right


def build_fair_jacobian(indices, parameters, weights, fair_scale, smooth, free, angle_delta):
    """Chuẩn bị cấu trúc cho một vòng đối ứng; mỗi lần gọi nhận values/curves.

    ``curves`` phải là kết quả decode của cùng ``values``. Chỉ các biến free
    có cột trong Jacobian; các neo/góc khóa không được solver dịch chuyển.
    Cấu trúc và Bernstein cố định trong vòng này, còn đạo hàm được tính lại
    tại mỗi nghiệm. Không lưu cache toàn cục hoặc thay ngưỡng hội tụ.
    """
    count, samples = len(smooth), len(indices)
    # Dòng data có thứ tự x,y như residual.ravel, chạm hai neo; độ cong
    # chạm ba neo. Modulo giữ quan hệ này cả qua seam của ring đóng.
    knots = np.column_stack([indices, (indices+1) % count])
    cols = (knots[:, :, None]*5+np.arange(5)).reshape(samples, 10)
    rows = np.repeat(np.arange(2*samples), 10)
    columns = np.repeat(cols, 2, axis=0).ravel()
    neighbours = np.column_stack([(np.arange(count)-1) % count,
                                  np.arange(count), (np.arange(count)+1) % count])
    fair_columns = (neighbours[:, :, None]*5+np.arange(5)).reshape(count, 15)
    rows = np.r_[rows, np.repeat(2*samples+np.arange(count), 15)]
    columns = np.r_[columns, fair_columns.ravel()]
    t, u = parameters, 1-parameters
    b0, b1, b2, b3 = u**3, 3*u*u*t, 3*u*t*t, t**3
    left_anchor = (b0+b1)*weights
    right_anchor = (b2+b3)*weights
    left_weight = b1*weights
    right_weight = -(b2*weights)

    # PERF (audit 2026-09-11 §CUTRUNTIME.CSR): cấu trúc thưa và cột free
    # không đổi trong một vòng đối ứng. Dựng ánh xạ COO -> CSR một lần,
    # các bước Newton chỉ điền đạo hàm mới vào đúng thứ tự cũ. Ring 1/2 neo
    # có cột trùng ở seam nên giữ phép cộng duplicate của SciPy như trước.
    selector = np.asarray(free)
    pattern = None
    gather = None
    if count >= 3 and selector.dtype.kind == "b" and selector.shape == (5*count,):
        pattern = coo_matrix((np.arange(len(rows), dtype=np.int64)+1, (rows, columns)),
                             shape=(2*samples+count, 5*count)).tocsr()[:, free]
        gather = pattern.data - 1

    def jacobian(values, curves):
        angles = values[:, 2]
        outgoing = np.exp(values[:, 3, None])*np.column_stack([np.cos(angles), np.sin(angles)])
        incoming = np.exp(values[:, 4, None])*np.column_stack([
            np.cos(angles+angle_delta), np.sin(angles+angle_delta)])
        left_vectors = left_weight[:, None]*outgoing[indices]
        right_vectors = right_weight[:, None]*incoming[(indices+1) % count]
        data = np.zeros((samples, 2, 2, 5))
        data[:, 0, 0, 0] = left_anchor
        data[:, 1, 0, 1] = left_anchor
        data[:, 0, 1, 0] = right_anchor
        data[:, 1, 1, 1] = right_anchor
        data[:, :, 0, 3] = left_vectors
        data[:, :, 1, 4] = right_vectors
        data[:, 0, 0, 2], data[:, 1, 0, 2] = -left_vectors[:, 1], left_vectors[:, 0]
        data[:, 0, 1, 2], data[:, 1, 1, 2] = -right_vectors[:, 1], right_vectors[:, 0]
        start_left, start_right = _curvature_value_gradient(curves, values, angle_delta)
        end_left, end_right = _curvature_value_gradient(curves, values, angle_delta, end=True)
        fair_data = np.stack([-np.roll(end_left, 1, axis=0),
                              start_left-np.roll(end_right, 1, axis=0), start_right], axis=1)
        fair_data *= (fair_scale*smooth)[:, None, None]
        derivatives = np.r_[data.ravel(), fair_data.ravel()]
        if pattern is None:
            matrix = coo_matrix((derivatives, (rows, columns)),
                                shape=(2*samples+count, 5*count)).tocsr()[:, free]
        else:
            # eliminate_zeros và solver có thể sửa CSR tại chỗ. Mỗi lần trả
            # một bộ mảng riêng để không làm hỏng cấu trúc của lần kế tiếp.
            matrix = csr_matrix((derivatives[gather], pattern.indices.copy(),
                                 pattern.indptr.copy()), shape=pattern.shape)
        # Bỏ phần tử bằng 0 thật, không cắt các đạo hàm nhỏ: LSMR không phải
        # nhân các ô không có ảnh hưởng, và không thay bài toán tuyến tính.
        matrix.eliminate_zeros()
        return matrix

    return jacobian
