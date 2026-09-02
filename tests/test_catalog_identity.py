from __future__ import annotations

import scene_engine
from scene_engine import ProductCheckpoint


def test_python_publication_has_no_display_catalog_identity_coupling() -> None:
    assert not hasattr(scene_engine, "DisplayCatalogIdentity")
    assert "display_catalog" not in ProductCheckpoint.__dataclass_fields__
