"""plugin.yaml states which Hermes it works with, and Hermes's own gate reads it the way we expect."""
from pathlib import Path

import pytest
import yaml

MANIFEST = Path(__file__).resolve().parents[1] / "plugin" / "plugin.yaml"


def _manifest():
    return yaml.safe_load(MANIFEST.read_text(encoding="utf-8"))


def test_manifest_declares_a_minimum_hermes():
    spec = _manifest().get("requires_hermes")
    assert isinstance(spec, str) and spec.startswith(">="), spec


def test_hermes_gate_accepts_supported_versions_and_refuses_older(monkeypatch):
    manifests = pytest.importorskip("hermes_cli.plugins_manifest")
    if not hasattr(manifests, "requires_hermes_error"):
        pytest.skip("this Hermes has no requires_hermes gate")
    manifest = _manifest()
    for running in ("0.22.7", "0.23.0", "0.23.1"):
        monkeypatch.setattr(manifests, "running_hermes_version", lambda running=running: running)
        assert manifests.requires_hermes_error(manifest) is None, running
    monkeypatch.setattr(manifests, "running_hermes_version", lambda: "0.22.5")
    assert manifests.requires_hermes_error(manifest) is not None
