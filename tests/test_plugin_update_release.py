"""Which Winglet release is the newest, and is it newer than the one running (plugin/hermes_api.py).

The server decides this itself from the GitHub releases of ONE hard-coded repository. The phone never names a
repository, a branch or a commit, and Hermes's own update check is not used for this answer (it reports
"provenance drift" for every sub-directory install, which is how Winglet is installed).
"""

import inspect
import json
import urllib.error
import urllib.request

import pytest

from plugin import hermes_api as api

REPO = "XerxeS2K1/winglet"
SHA = "a" * 40
SHA2 = "b" * 40


def release(tag, *, draft=False, prerelease=False, body="notes", **extra):
    return {"tag_name": tag, "draft": draft, "prerelease": prerelease, "body": body, "name": tag,
            "html_url": "https://evil.example/phish", **extra}


def plugin_yaml(version, requires='">=0.22.7"'):
    return f"name: winglet\nversion: {version}\nrequires_hermes: {requires}\ndescription: x\n"


class FakeGitHub:
    """Answers the few URLs the lookup is allowed to read, and records every one it is asked for."""

    def __init__(self, releases, tags=None, yamls=None):
        self.releases = releases
        self.tags = tags if tags is not None else {}
        self.yamls = yamls if yamls is not None else {}
        self.urls = []

    def __call__(self, url, *, text=False):
        self.urls.append(url)
        base = f"https://api.github.com/repos/{REPO}/"
        if url.startswith(base + "releases"):
            return self.releases
        if url.startswith(base + "git/ref/tags/"):
            return self.tags[url.rsplit("/", 1)[1]]
        if url.startswith(base + "git/tags/"):
            return self.tags[url.rsplit("/", 1)[1]]
        raw = f"https://raw.githubusercontent.com/{REPO}/"
        if url.startswith(raw):
            return self.yamls[url[len(raw):].split("/", 1)[0]]
        raise AssertionError(f"unexpected URL {url}")


def lightweight(sha):
    return {"object": {"type": "commit", "sha": sha}}


@pytest.fixture(autouse=True)
def fresh_cache():
    api._RELEASE_CACHE.clear()
    yield
    api._RELEASE_CACHE.clear()


# -- versions: strict, numeric, never guessed ------------------------------------------------------------------


@pytest.mark.parametrize("text,expected", [("0.10.5", (0, 10, 5)), ("1.0.0", (1, 0, 0)), ("0.9.12", (0, 9, 12)),
                                           ("10.20.30", (10, 20, 30))])
def test_plain_versions_parse(text, expected):
    assert api.parse_version(text) == expected


@pytest.mark.parametrize("text", ["", " ", None, 5, "0.10", "0.10.5.1", "v0.10.5", " 0.10.5", "0.10.5 ", "0.10.5\n",
                                  "0.10.5-beta.1", "0.10.5+build", "0.10.05", "00.1.2", "-1.0.0", "1e3.0.0", "a.b.c",
                                  "\u0663.0.0", "0.10.99999", "latest", "main", "0.10.x"])
def test_anything_that_is_not_plain_x_y_z_is_not_a_version(text):
    assert api.parse_version(text) is None


@pytest.mark.parametrize("tag,expected", [("v0.10.5", (0, 10, 5)), ("v1.2.3", (1, 2, 3))])
def test_release_tags_are_v_then_a_plain_version(tag, expected):
    assert api.parse_tag(tag) == expected


@pytest.mark.parametrize("tag", ["0.10.5", "v0.10.5-beta.1", "v0.10.5-rc.1", "V0.10.5", "vv0.10.5", "v0.10.5/../../x",
                                 "v0.10.5\n", "latest", "main", "", None, "v0.10"])
def test_other_tags_are_not_releases(tag):
    assert api.parse_tag(tag) is None


@pytest.mark.parametrize("candidate,current,newer", [
    ("0.10.5", "0.10.4", True), ("0.11.0", "0.10.9", True), ("1.0.0", "0.99.99", True),
    ("0.10.0", "0.9.9", True),  # numbers, not text: "0.10.0" sorts before "0.9.9" as a string
    ("0.10.4", "0.10.4", False), ("0.10.3", "0.10.4", False), ("0.9.9", "0.10.0", False),
    ("0.10.5", "garbage", False), ("garbage", "0.10.4", False), ("", "", False), (None, "0.10.4", False),
    ("0.10.5-beta.1", "0.10.4", False),
])
def test_only_a_real_newer_version_counts_as_newer(candidate, current, newer):
    assert api.is_newer(candidate, current) is newer


# -- the lookup: one hard-coded repository, stable releases only -----------------------------------------------


def test_the_lookup_cannot_be_pointed_at_another_repository():
    assert api.RELEASE_REPO == REPO
    assert not {"repo", "owner", "url", "ref"} & set(inspect.signature(api.latest_release).parameters)


def test_the_newest_stable_release_is_found_and_tied_to_its_commit():
    gh = FakeGitHub([release("v0.10.4"), release("v0.10.5", body="What's new"), release("v0.10.3")],
                    tags={"v0.10.5": lightweight(SHA)}, yamls={SHA: plugin_yaml("0.10.5")})
    found = api.latest_release(fetch=gh)
    assert found == {"version": "0.10.5", "tag": "v0.10.5", "sha": SHA, "notes": "What's new",
                     "url": f"https://github.com/{REPO}/releases/tag/v0.10.5", "requires_hermes": ">=0.22.7"}
    assert gh.urls and all(u.startswith((f"https://api.github.com/repos/{REPO}/",
                                         f"https://raw.githubusercontent.com/{REPO}/")) for u in gh.urls), gh.urls


def test_drafts_prereleases_and_odd_tags_are_never_offered():
    gh = FakeGitHub([release("v0.12.0", draft=True), release("v0.11.0", prerelease=True),
                     release("v0.11.0-beta.1"), release("v0.11.0-rc.1"), release("latest"), release("main"),
                     release("v9.9.9/../../x"), release("v0.10.4")],
                    tags={"v0.10.4": lightweight(SHA)}, yamls={SHA: plugin_yaml("0.10.4")})
    assert api.latest_release(fetch=gh)["version"] == "0.10.4"
    assert not any("0.12.0" in u or "0.11.0" in u or "latest" in u for u in gh.urls)


def test_a_patch_release_published_later_does_not_hide_the_highest_version():
    # GitHub's own "latest" is the most recently created, not the highest: a backport must not win.
    gh = FakeGitHub([release("v0.9.9"), release("v0.10.5"), release("v0.10.4")],
                    tags={"v0.10.5": lightweight(SHA)}, yamls={SHA: plugin_yaml("0.10.5")})
    assert api.latest_release(fetch=gh)["tag"] == "v0.10.5"


def test_no_stable_release_is_an_answer_not_an_error():
    assert api.latest_release(fetch=FakeGitHub([release("v1.0.0", draft=True), release("v0.2.0", prerelease=True)])) is None
    assert api.latest_release(fetch=FakeGitHub([])) is None


def test_an_annotated_tag_is_followed_to_the_commit_it_points_at():
    gh = FakeGitHub([release("v0.10.5")],
                    tags={"v0.10.5": {"object": {"type": "tag", "sha": SHA2}}, SHA2: {"object": {"type": "commit", "sha": SHA}}},
                    yamls={SHA: plugin_yaml("0.10.5")})
    assert api.latest_release(fetch=gh)["sha"] == SHA


@pytest.mark.parametrize("tag_answer", [
    {"object": {"type": "commit", "sha": "main"}},                 # not a commit id
    {"object": {"type": "commit", "sha": "A" * 40}},               # upper case is not what git prints
    {"object": {"type": "commit", "sha": "a" * 39}},
    {"object": {"type": "commit", "sha": "a" * 40 + "; rm -rf /"}},
    {"object": {"type": "blob", "sha": SHA}},                      # a tag on something that is not a commit
    {"object": {"type": "tag", "sha": SHA2}},                      # a tag of a tag of ... never resolves to a commit
    {"object": "x"}, {}, [], None,
])
def test_a_tag_that_does_not_resolve_to_a_plain_commit_id_is_refused(tag_answer):
    anything = type("Any", (dict,), {"__missing__": lambda self, key: plugin_yaml("0.10.5")})()  # would serve ANY id
    gh = FakeGitHub([release("v0.10.5")], tags={"v0.10.5": tag_answer, SHA2: {"object": {"type": "tag", "sha": SHA2}}},
                    yamls=anything)
    with pytest.raises(api.ReleaseCheckFailed):
        api.latest_release(fetch=gh)
    # refused on the id itself, before anything was read at that "commit"
    assert not any(u.startswith("https://raw.githubusercontent.com/") for u in gh.urls), gh.urls


def test_a_release_whose_plugin_says_another_version_is_refused():
    gh = FakeGitHub([release("v0.10.5")], tags={"v0.10.5": lightweight(SHA)}, yamls={SHA: plugin_yaml("0.10.4")})
    with pytest.raises(api.ReleaseCheckFailed, match="0.10.4"):
        api.latest_release(fetch=gh)


def test_a_release_without_a_readable_plugin_manifest_is_refused():
    gh = FakeGitHub([release("v0.10.5")], tags={"v0.10.5": lightweight(SHA)}, yamls={SHA: "name: winglet\n"})
    with pytest.raises(api.ReleaseCheckFailed):
        api.latest_release(fetch=gh)


def test_notes_are_text_and_bounded_and_the_link_is_built_not_trusted():
    gh = FakeGitHub([release("v0.10.5", body="x" * 20000, html_url="https://evil.example/")],
                    tags={"v0.10.5": lightweight(SHA)}, yamls={SHA: plugin_yaml("0.10.5")})
    found = api.latest_release(fetch=gh)
    assert len(found["notes"]) <= 4000
    assert found["url"] == f"https://github.com/{REPO}/releases/tag/v0.10.5"
    gh = FakeGitHub([release("v0.10.5", body=None)], tags={"v0.10.5": lightweight(SHA)}, yamls={SHA: plugin_yaml("0.10.5")})
    api._RELEASE_CACHE.clear()
    assert api.latest_release(fetch=gh)["notes"] == ""


def test_a_missing_hermes_requirement_is_none_not_a_guess():
    gh = FakeGitHub([release("v0.10.5")], tags={"v0.10.5": lightweight(SHA)},
                    yamls={SHA: "name: winglet\nversion: 0.10.5\ndescription: x\n"})
    assert api.latest_release(fetch=gh)["requires_hermes"] is None


@pytest.mark.parametrize("listing", ["nope", {"message": "rate limited"}, None, 5, [None], ["x"], [{"tag_name": 5}]])
def test_an_unexpected_answer_from_github_is_a_failed_check(listing):
    try:
        found = api.latest_release(fetch=FakeGitHub(listing))
    except api.ReleaseCheckFailed:
        return
    assert found is None  # entries that are not releases are skipped, never trusted


def test_a_network_failure_is_a_failed_check_and_is_not_remembered():
    def broken(url, *, text=False):
        raise OSError("offline")
    with pytest.raises(api.ReleaseCheckFailed):
        api.latest_release(fetch=broken)
    gh = FakeGitHub([release("v0.10.5")], tags={"v0.10.5": lightweight(SHA)}, yamls={SHA: plugin_yaml("0.10.5")})
    assert api.latest_release(fetch=gh)["version"] == "0.10.5"  # the failure did not poison the cache


# -- the ten-minute cache --------------------------------------------------------------------------------------


def test_the_answer_is_remembered_for_ten_minutes_unless_forced():
    clock = [1000.0]
    gh = FakeGitHub([release("v0.10.5")], tags={"v0.10.5": lightweight(SHA)}, yamls={SHA: plugin_yaml("0.10.5")})
    first = api.latest_release(fetch=gh, clock=lambda: clock[0])
    calls = len(gh.urls)
    clock[0] += 599
    assert api.latest_release(fetch=gh, clock=lambda: clock[0]) == first and len(gh.urls) == calls
    clock[0] += 2
    api.latest_release(fetch=gh, clock=lambda: clock[0])
    assert len(gh.urls) > calls  # 601 s: asked again
    calls = len(gh.urls)
    api.latest_release(fetch=gh, clock=lambda: clock[0])
    assert len(gh.urls) == calls
    api.latest_release(force=True, fetch=gh, clock=lambda: clock[0])
    assert len(gh.urls) > calls


def test_no_stable_release_is_remembered_too():
    gh = FakeGitHub([])
    api.latest_release(fetch=gh)
    api.latest_release(fetch=gh)
    assert len(gh.urls) == 1


# -- Hermes compatibility ----------------------------------------------------------------------------------------


@pytest.mark.parametrize("spec,running,ok", [
    (">=0.22.7", "0.23.0", True), (">=0.22.7", "0.22.7", True), (">=0.22.7", "0.22.6", False),
    (">=0.22.7,<0.24", "0.24.1", False), (">=0.22.7", "v0.23.0", True), (">=0.22.7", "0.23.0 (2026.11.5)", True),
    (None, "0.23.0", True),            # a plugin that asks for nothing is compatible
    (">=0.22.7", "", None), (">=0.22.7", None, None), (">=0.22.7", "nightly", None),   # cannot tell
    ("this is not a range", "0.23.0", None),
])
def test_the_running_hermes_is_checked_against_the_releases_requirement(spec, running, ok):
    assert api.hermes_supports(spec, running) is ok


# -- the only network code: where it may go --------------------------------------------------------------------


@pytest.mark.parametrize("url", [
    "http://api.github.com/repos/XerxeS2K1/winglet/releases",        # not https
    "https://api.github.com/repos/someone-else/winglet/releases",
    "https://api.github.com.evil.example/repos/XerxeS2K1/winglet/releases",
    "https://api.github.com/repos/XerxeS2K1/winglet-evil/releases",
    "https://evil.example/repos/XerxeS2K1/winglet/releases",
    "https://raw.githubusercontent.com/someone-else/winglet/" + "a" * 40 + "/plugin/plugin.yaml",
    "file:///etc/passwd", "ftp://api.github.com/repos/XerxeS2K1/winglet/releases",
    "https://user@api.github.com/repos/XerxeS2K1/winglet/releases",
])
def test_the_real_fetch_refuses_any_address_outside_the_one_repository(url, monkeypatch):
    def forbidden(*a, **k):
        raise AssertionError("must not connect")
    monkeypatch.setattr(urllib.request.OpenerDirector, "open", forbidden)
    monkeypatch.setattr(urllib.request, "urlopen", forbidden)
    with pytest.raises(api.ReleaseCheckFailed):
        api._github_get(url)


def test_a_redirect_may_not_leave_the_allowed_addresses():
    handler = api._SameRepoRedirect()
    req = urllib.request.Request(f"https://api.github.com/repos/{REPO}/releases")
    ok = handler.redirect_request(req, None, 301, "Moved", {}, f"https://api.github.com/repos/{REPO}/releases?page=2")
    assert ok is not None
    for target in ("https://evil.example/x", "http://api.github.com/repos/XerxeS2K1/winglet/releases",
                   "https://api.github.com/repos/other/winglet/releases", "file:///etc/passwd"):
        with pytest.raises(urllib.error.URLError):
            handler.redirect_request(req, None, 302, "Found", {}, target)


def test_a_huge_answer_is_refused_not_read_into_memory(monkeypatch):
    class Body:
        def __init__(self): self.asked = 0
        def read(self, n=-1):
            self.asked = n
            return b"x" * (n if n and n > 0 else 10 ** 8)
        def __enter__(self): return self
        def __exit__(self, *a): return False
        headers = {}
    body = Body()
    monkeypatch.setattr(urllib.request.OpenerDirector, "open", lambda self, *a, **k: body)
    with pytest.raises(api.ReleaseCheckFailed):
        api._github_get(f"https://api.github.com/repos/{REPO}/releases")
    assert 0 < body.asked <= 2_000_000  # it asked for a bounded amount, never "everything"


def test_json_comes_back_parsed_and_text_comes_back_as_text(monkeypatch):
    class Body:
        def __init__(self, data): self.data = data
        def read(self, n=-1): return self.data
        def __enter__(self): return self
        def __exit__(self, *a): return False
    monkeypatch.setattr(urllib.request.OpenerDirector, "open", lambda self, *a, **k: Body(json.dumps([{"a": 1}]).encode()))
    assert api._github_get(f"https://api.github.com/repos/{REPO}/releases") == [{"a": 1}]
    monkeypatch.setattr(urllib.request.OpenerDirector, "open", lambda self, *a, **k: Body(b"version: 1\n"))
    assert api._github_get(f"https://raw.githubusercontent.com/{REPO}/{SHA}/plugin/plugin.yaml", text=True) == "version: 1\n"


def test_an_asset_download_may_follow_github_to_its_cdn():
    """GitHub answers a release download with a redirect to its asset CDN, and has moved that host
    before (objects. -> release-assets.). A miss here refuses every self-update: the live server
    refused 0.11.1 with "redirect outside XerxeS2K1/winglet refused"."""
    handler = api._SameRepoRedirect(asset_redirect=True)
    req = urllib.request.Request(f"https://github.com/{REPO}/releases/download/v1.2.3/plugin.zip")
    for host in ("release-assets.githubusercontent.com", "objects.githubusercontent.com",
                 "github-releases.githubusercontent.com"):
        target = f"https://{host}/github-production-release-asset/1/abc?sig=x"
        assert handler.redirect_request(req, None, 302, "Found", {}, target) is not None, host
    with pytest.raises(urllib.error.URLError):
        handler.redirect_request(req, None, 302, "Found", {}, "https://release-assets.evil.example/x")


def test_the_cdn_is_not_trusted_for_the_release_metadata():
    handler = api._SameRepoRedirect()
    req = urllib.request.Request(f"https://api.github.com/repos/{REPO}/releases")
    with pytest.raises(urllib.error.URLError):
        handler.redirect_request(req, None, 302, "Found", {},
                                 "https://release-assets.githubusercontent.com/github-production-release-asset/1/abc")
