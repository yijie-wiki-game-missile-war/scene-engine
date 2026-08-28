from __future__ import annotations

import json
from pathlib import Path

import pytest

from scene_engine import ConfigurationError, DisplayCatalogIdentity


FIXTURE = Path(__file__).resolve().parents[1] / "fixtures/display-catalog-v1/identity.json"


def test_python_loads_the_display_build_identity_artifact() -> None:
    record = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert DisplayCatalogIdentity.from_record(record).to_record() == record


def test_catalog_identity_record_is_closed_and_sha256_only() -> None:
    valid = json.loads(FIXTURE.read_text(encoding="utf-8"))
    with pytest.raises(ConfigurationError, match="fields"):
        DisplayCatalogIdentity.from_record({**valid, "extra": "no"})
    with pytest.raises(ConfigurationError, match="SHA-256"):
        DisplayCatalogIdentity.from_record({**valid, "scene_catalog_hash": "ABC"})
