from app.workers.nup_engine import _build_repeat_sheet_metadata


class _CountingMapping(list):
    def __init__(self, values):
        super().__init__(values)
        self.reads = 0

    def __getitem__(self, index):
        self.reads += 1
        return super().__getitem__(index)


def test_repeat_sheet_metadata_tracks_ordinal_per_source_page():
    assert _build_repeat_sheet_metadata([0, 0, 1, 0, 1]) == {
        0: (0, 0),
        1: (0, 1),
        2: (1, 0),
        3: (0, 2),
        4: (1, 1),
    }


def test_repeat_sheet_metadata_accepts_legacy_string_key_dict():
    assert _build_repeat_sheet_metadata({"0": 2, "1": 2, "2": 3}) == {
        0: (2, 0),
        1: (2, 1),
        2: (3, 0),
    }


def test_repeat_sheet_metadata_ignores_invalid_and_duplicate_dict_keys():
    assert _build_repeat_sheet_metadata({0: 2, "0": 2, "bad": 9}) == {
        0: (2, 0),
    }


def test_repeat_sheet_metadata_reads_mapping_once_per_sheet():
    mapping = _CountingMapping(index % 7 for index in range(10_000))

    metadata = _build_repeat_sheet_metadata(mapping)

    assert len(metadata) == len(mapping)
    assert mapping.reads == len(mapping)
