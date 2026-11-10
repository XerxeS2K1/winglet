"""The out-of-process half of Winglet's self-update safety net.

Run by ``winglet-update-watchdog.timer`` (and usable by hand).  It reads the
marker the plugin wrote before the swap.  If the marker is still there ten
minutes later, the new version never reported health, so this restores the
named backup with the existing ``update_rollback.restore()``.

Imports only the standard library, ``update_rollback`` and ``rollback`` so it
works when the installed plugin package is too broken to import.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

try:  # installed next to update_rollback.py and rollback.py
    import rollback  # type: ignore
    import self_update  # type: ignore
except ImportError:  # package import during development/tests
    from . import rollback  # type: ignore
    from . import self_update  # type: ignore


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="winglet-update-watchdog")
    parser.add_argument("--home", default=None, help="Hermes home (default: HERMES_HOME or ~/.hermes)")
    args = parser.parse_args(argv)
    root = self_update.hermes_home(args.home)
    try:
        marker = self_update.read_marker(root)
    except ValueError as exc:
        print(f"Winglet update watchdog: {exc}")
        return 1
    decision = self_update.watchdog_decision(marker, now=__import__("time").time())
    if decision == "idle":
        return 0
    if decision == "ok":
        try:
            self_update.clear_marker(root)
        except ValueError as exc:
            print(f"Winglet update watchdog: {exc}")
            return 1
        return 0
    if decision == "broken":
        print("Winglet update watchdog: the update marker is incomplete; refusing to restore anything.")
        return 1
    if decision == "wait":
        return 0
    if not marker:
        return 0
    print(f"Winglet update {marker.get('from')} -> {marker.get('to')} did not report health. Rolling back.")
    return rollback.rollback(root)


if __name__ == "__main__":
    raise SystemExit(main())
