"""Keep the suite off the machine it runs on.

A test reached the self-update path without naming a home, so a full run wrote a real update marker,
health stamp and attempt record into `~/.hermes` and installed a `winglet-update-watchdog` systemd
timer that was counting down to a rollback of the live plugin. Two things are pinned here: the systemd
user directory, and the default Hermes home that the update code falls back to.

Only these two are redirected. `HERMES_HOME`/`HOME` are left alone because other suites (pets, media)
resolve real paths through them and break when they move.
"""

from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def isolate_update_state(tmp_path_factory, monkeypatch):
    from plugin import self_update

    # Outside the test's own tmp_path: some suites assert that directory is empty.
    root = tmp_path_factory.mktemp("update-state")
    monkeypatch.setenv("XDG_CONFIG_HOME", str(root / "config"))
    home = root / "hermes-home"
    home.mkdir(exist_ok=True)
    real = self_update.hermes_home
    monkeypatch.setattr(self_update, "hermes_home",
                        lambda given=None: Path(given) if given else home)
    # Anything that imported the name directly keeps working, just not against the real home.
    monkeypatch.setattr(self_update, "home", real, raising=False)
    return home
