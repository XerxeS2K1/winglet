"""Account-free HTTPS, owned by the gateway rather than an orphaned setup process."""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import logging
import os
import platform
import re
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
from pathlib import Path
from typing import Awaitable, Callable

import httpx

logger = logging.getLogger(__name__)
VERSION = "2026.9.3"
# Official Cloudflare release asset SHA-256 digests. Pin both version and content.
ASSETS = {
    ("Windows", "amd64"): ("cloudflared-windows-amd64.exe", "f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2"),
    ("Windows", "386"): ("cloudflared-windows-386.exe", "9b95ddc2eba67b86ed3dc4cc2a15881960563031b52ce564376af41fb91ad402"),
    ("Linux", "amd64"): ("cloudflared-linux-amd64", "77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2"),
    ("Linux", "386"): ("cloudflared-linux-386", "d6b2f917e2e78b3e3afba760af726e51751d10c2fcad4a2fb2a69feb4bd47421"),
    ("Linux", "arm64"): ("cloudflared-linux-arm64", "aaeb2d7d0da3614634c7e03ab13487a1522c2e79165ed2929cfe23d5e95b326d"),
    ("Linux", "arm"): ("cloudflared-linux-arm", "967dc371a3fedbf09e881c13ee7ba317155ebc336cbd4afb756b46fc6785e5af"),
    ("Darwin", "amd64"): ("cloudflared-darwin-amd64.tgz", "d1155d0837487f261183b15c1eab6c4ebcad9dc49b94675f1524c3564cea3977"),
    ("Darwin", "arm64"): ("cloudflared-darwin-arm64.tgz", "587c2cfb1c230fe36c7fa7727da78be459dae028cabe8c001291999350f07095"),
}
QUICK_URL = re.compile(r"https://[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com")
MAX_DOWNLOAD = 100 * 1024 * 1024
VERIFY_DEADLINE = 15  # seconds for one whole readiness check: httpx's timeout is per phase, so a trickle never trips it


def asset() -> tuple[str, str]:
    machine = platform.machine().lower()
    arch = {"x86_64": "amd64", "amd64": "amd64", "i386": "386", "i686": "386",
            "x86": "386", "aarch64": "arm64", "arm64": "arm64", "armv7l": "arm",
            "armv6l": "arm"}.get(machine)
    # Cloudflare publishes no native Windows ARM asset; do not silently install x86 emulation.
    try:
        return ASSETS[(platform.system(), arch)]
    except KeyError:
        raise RuntimeError(f"Automatic tunnels do not support {platform.system()} / {machine}. "
                           "Use `hermes winglet setup --public-url https://your-server`.") from None


def _digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def install(data_dir: Path, *, download: bool = True) -> Path:
    """User-local, bounded, checksum-verified download. No package manager or elevation."""
    name, expected = asset()
    directory = data_dir / "cloudflared" / VERSION
    archive = directory / name
    executable = directory / ("cloudflared.exe" if name.endswith(".exe") else "cloudflared")
    directory.mkdir(parents=True, exist_ok=True)
    if not archive.is_file() or _digest(archive) != expected:
        if not download:
            raise RuntimeError("cloudflared is missing or its checksum is invalid. Run `hermes winglet setup`.")
        url = f"https://github.com/cloudflare/cloudflared/releases/download/{VERSION}/{name}"
        request = urllib.request.Request(url, headers={"User-Agent": "Winglet-tunnel-setup"})
        temporary = None
        try:
            with urllib.request.urlopen(request, timeout=30) as response, tempfile.NamedTemporaryFile(
                    dir=directory, delete=False) as output:
                temporary = Path(output.name)
                size = 0
                while chunk := response.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_DOWNLOAD:
                        raise RuntimeError("cloudflared download exceeded the expected size.")
                    output.write(chunk)
            if _digest(temporary) != expected:
                raise RuntimeError("cloudflared checksum did not match Cloudflare's release. Nothing was executed.")
            temporary.replace(archive)
        finally:
            if temporary:
                temporary.unlink(missing_ok=True)
    if name.endswith(".tgz"):
        # Extract only this regular file, never archive paths, symlinks, or executable extras.
        with tarfile.open(archive, "r:gz") as tar:
            member = next((m for m in tar.getmembers() if m.name in ("cloudflared", "./cloudflared")
                           and m.isfile() and m.size <= MAX_DOWNLOAD), None)
            if member is None:
                raise RuntimeError("Cloudflare archive did not contain the expected executable.")
            with tar.extractfile(member) as source:
                contents = source.read(MAX_DOWNLOAD + 1)
            if not executable.is_file() or _digest(executable) != hashlib.sha256(contents).hexdigest():
                executable.write_bytes(contents)
    elif executable != archive:
        # Re-copy the verified asset on every start, so a changed extracted binary is never trusted.
        if not executable.is_file() or _digest(executable) != expected:
            executable.write_bytes(archive.read_bytes())
    if os.name != "nt":
        executable.chmod(0o700)
    return executable


def origin_url(host: str, port: int) -> str:
    host = host.strip().strip("[]")
    host = "127.0.0.1" if host in ("", "0.0.0.0") else "::1" if host == "::" else host
    return f"http://{'[' + host + ']' if ':' in host else host}:{port}"


async def verify_url(url: str, server_id: str) -> bool:
    """HTTPS request through Cloudflare, with no bearer token and no redirects."""
    if not QUICK_URL.fullmatch(url):
        return False
    async def check() -> bool:
        async with httpx.AsyncClient(timeout=8, follow_redirects=False) as client:
            response = await client.get(url + "/api/info")
            if response.status_code != 200 or len(response.content) > 64 * 1024:
                return False
            info = response.json()
            return isinstance(info, dict) and info.get("app") == "winglet" and info.get("server_id") == server_id
    try:
        return await asyncio.wait_for(check(), VERIFY_DEADLINE)
    except (httpx.HTTPError, ValueError, asyncio.TimeoutError):
        return False


class QuickTunnel:
    def __init__(self, directory: Path, origin: str, server_id: str,
                 changed: Callable[[str | None], Awaitable[None]], *, host_header: str = ""):
        self.directory, self.origin, self.server_id, self.changed = directory, origin, server_id, changed
        self.host_header = host_header
        self.process = None
        self.task = None
        # What the Connection screen shows: starting, ready or retrying, since when, and why it last failed.
        self.status: dict = {"state": "starting", "since": time.time(), "error": None, "retry_at": None}

    def _set(self, state: str, error: str | None = None, retry_at: float | None = None) -> None:
        self.status = {"state": state, "since": time.time(), "error": error, "retry_at": retry_at}

    def start(self) -> None:
        self.task = asyncio.create_task(self.run())

    async def stop(self) -> None:
        if self.task:
            self.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.task
            self.task = None

    async def _stop_process(self) -> None:
        process, self.process = self.process, None
        if process is None:
            return
        # EOF tells the worker to stop its child; it also fires if the gateway is killed/crashes.
        if process.stdin:
            process.stdin.close()
        try:
            await asyncio.wait_for(process.wait(), 10)
        except asyncio.TimeoutError:
            with contextlib.suppress(ProcessLookupError):
                process.kill()
            await process.wait()

    async def _session(self, executable: Path) -> None:
        config = executable.parent / "winglet-config.yml"
        config.write_text("{}\n", encoding="utf-8")
        options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
        self.process = await asyncio.create_subprocess_exec(
            sys.executable, str(Path(__file__).with_name("tunnel_worker.py")), str(executable), self.origin,
            str(config), self.host_header, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT, **options)
        candidate = asyncio.get_running_loop().create_future()

        async def read_output():
            while line := await self.process.stdout.readline():
                match = QUICK_URL.search(line.decode("utf-8", errors="replace"))
                if match and not candidate.done():
                    candidate.set_result(match.group())
            if not candidate.done():
                candidate.set_exception(RuntimeError("cloudflared exited before returning an HTTPS address."))

        reader = asyncio.create_task(read_output())
        try:
            url = await asyncio.wait_for(candidate, 45)
            deadline = asyncio.get_running_loop().time() + 90
            while self.process.returncode is None:
                if await verify_url(url, self.server_id):
                    await self.changed(url)
                    self._set("ready")
                    logger.info("[winglet] Automatic HTTPS is ready; run `hermes winglet pair`.")
                    await self.process.wait()
                    return
                if asyncio.get_running_loop().time() > deadline:
                    raise RuntimeError("Cloudflare's HTTPS address did not answer with this Winglet server.")
                await asyncio.sleep(2)
            raise RuntimeError("cloudflared exited during its HTTPS readiness check.")
        finally:
            reader.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await reader

    async def run(self) -> None:
        delay = 2
        try:
            while True:
                error = "Cloudflare closed the tunnel."
                try:
                    if self.status["state"] != "starting":
                        self._set("starting")
                    executable = await asyncio.to_thread(install, self.directory, download=False)
                    await self._session(executable)
                    delay = 2  # A healthy session resets startup-failure backoff before reconnecting.
                except (OSError, RuntimeError, asyncio.TimeoutError) as exc:
                    error = str(exc) or "Cloudflare didn't answer in time."
                    logger.warning("[winglet] Automatic HTTPS unavailable: %s; retrying in %ss", exc, delay)
                finally:
                    await self._stop_process()
                    await self.changed(None)
                self._set("retrying", error, time.time() + delay)
                await asyncio.sleep(delay)
                delay = min(60, delay * 2)
        finally:
            await self._stop_process()
