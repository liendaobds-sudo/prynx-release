from __future__ import annotations

import hashlib
from contextlib import contextmanager

from app.workers.model_cache import ensure_model


class _Response:
    def __init__(self, content: bytes):
        self.content = content

    def raise_for_status(self):
        return None

    def iter_bytes(self, chunk_size: int):
        del chunk_size
        yield self.content


def _stream_for(content: bytes):
    @contextmanager
    def stream(*_args, **_kwargs):
        yield _Response(content)

    return stream


def test_valid_bundled_model_wins_without_network(tmp_path, monkeypatch):
    content = b'bundled-model'
    expected = hashlib.sha256(content).hexdigest()
    bundled = tmp_path / 'bundle'
    bundled.mkdir()
    (bundled / 'model.onnx').write_bytes(content)
    monkeypatch.setattr('app.workers.model_cache.httpx.stream', lambda *_a, **_k: (_ for _ in ()).throw(AssertionError('network')))

    resolved = ensure_model(
        filename='model.onnx', url='https://invalid', expected_sha256=expected,
        cache_dir=str(tmp_path / 'cache'), bundled_dir=str(bundled),
    )

    assert resolved == str(bundled / 'model.onnx')


def test_invalid_cache_is_replaced_atomically_after_hash_check(tmp_path, monkeypatch):
    content = b'verified-model'
    expected = hashlib.sha256(content).hexdigest()
    cache = tmp_path / 'cache'
    cache.mkdir()
    target = cache / 'model.onnx'
    target.write_bytes(b'partial')
    monkeypatch.setattr('app.workers.model_cache.httpx.stream', _stream_for(content))

    resolved = ensure_model(
        filename='model.onnx', url='https://model', expected_sha256=expected,
        cache_dir=str(cache),
    )

    assert resolved == str(target)
    assert target.read_bytes() == content
    assert not list(cache.glob('*.part'))


def test_hash_mismatch_never_promotes_part_file(tmp_path, monkeypatch):
    cache = tmp_path / 'cache'
    monkeypatch.setattr('app.workers.model_cache.httpx.stream', _stream_for(b'wrong'))

    try:
        ensure_model(
            filename='model.onnx', url='https://model', expected_sha256='0' * 64,
            cache_dir=str(cache),
        )
    except RuntimeError as exc:
        assert 'SHA-256' in str(exc)
    else:
        raise AssertionError('Model sai hash phải bị từ chối')

    assert not (cache / 'model.onnx').exists()
    assert not list(cache.glob('*.part'))
