"""A US-dollar to pound rate for the Usage screen, fetched once a day in the background.

Hermes prices usage in dollars; the app shows pounds. The phone never goes looking for a rate itself: the
gateway fetches one (Frankfurter, the European Central Bank's reference rates, no key), keeps the last good one
in a small file beside the database, and hands it to the app with the usage figures. A request only ever reads
the number already in memory, so a slow or dead rate service can never hold one up.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import time
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

# The newer endpoint first; the older one still answers but is marked deprecated. parse_rate reads either shape.
RATE_URLS = (
    "https://api.frankfurter.dev/v2/rates?base=USD&quotes=GBP",
    "https://api.frankfurter.dev/v1/latest?base=USD&symbols=GBP",
)
REFRESH_SECONDS = 24 * 3600
RETRY_FIRST_SECONDS = 5 * 60
RETRY_MAX_SECONDS = 6 * 3600
# A pound has not been worth less than 5p or more than five dollars; anything outside is a broken answer, not a rate.
RATE_MIN, RATE_MAX = 0.05, 5.0

Fetch = Callable[[], Awaitable[Any]]


def parse_rate(body: Any) -> Optional[float]:
    """The USD->GBP rate from a Frankfurter answer, or None if it isn't a believable one.

    v1: {"amount": 1.0, "base": "USD", "date": "2026-11-10", "rates": {"GBP": 0.74501}}
    v2: {"date": "2026-11-11", "base": "USD", "quote": "GBP", "rate": 0.74547}
    """
    if isinstance(body, list) and len(body) == 1:
        body = body[0]
    if not isinstance(body, dict):
        return None
    value = body.get("rate")
    if value is None and isinstance(body.get("rates"), dict):
        value = body["rates"].get("GBP")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    value = float(value)
    return value if math.isfinite(value) and RATE_MIN <= value <= RATE_MAX else None


async def frankfurter(client: Any) -> Any:
    """Ask Frankfurter with an httpx-style client. Returns the first answer that parses to a rate."""
    last: Exception = RuntimeError("no rate service answered")
    for url in RATE_URLS:
        try:
            resp = await client.get(url, headers={"accept": "application/json"})
            resp.raise_for_status()
            body = resp.json()
            if parse_rate(body) is not None:
                return body
            last = ValueError("the rate service answered, but not with a usable rate")
        except Exception as exc:  # noqa: BLE001 - any failure just means "try the next, then keep the last good rate"
            last = exc
    raise last


class UsdGbp:
    """The cached rate, its file, and the loop that keeps it fresh. ``fetch`` and ``clock`` are injected for tests."""

    def __init__(self, path: Path, fetch: Fetch, clock: Callable[[], float] = time.time):
        self.path = Path(path)
        self._fetch = fetch
        self._clock = clock
        self.rate: Optional[float] = None
        self.fetched_at: float = 0.0
        self._load()

    def _load(self) -> None:
        try:
            saved = json.loads(self.path.read_text(encoding="utf-8"))
            rate = parse_rate({"rate": saved.get("usd_gbp")})
            at = saved.get("fetched_at")
            if rate is not None:
                self.rate = rate
                self.fetched_at = float(at) if isinstance(at, (int, float)) and math.isfinite(at) else 0.0
        except (OSError, ValueError, AttributeError):
            pass  # no file yet, or a damaged one: start with no rate

    def _save(self) -> None:
        tmp = self.path.with_name(self.path.name + ".tmp")
        tmp.write_text(json.dumps({"usd_gbp": self.rate, "fetched_at": self.fetched_at}), encoding="utf-8")
        os.replace(tmp, self.path)

    def due(self) -> bool:
        return self.rate is None or self._clock() - self.fetched_at >= REFRESH_SECONDS

    async def refresh(self) -> bool:
        """One attempt. A failure of any kind keeps the last good rate and returns False."""
        try:
            rate = parse_rate(await self._fetch())
            if rate is None:
                logger.debug("[winglet] the exchange-rate answer had no usable rate")
                return False
            self.rate, self.fetched_at = rate, self._clock()
            try:
                await asyncio.to_thread(self._save)
            except OSError:
                logger.debug("[winglet] couldn't save the exchange rate", exc_info=True)
            return True
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug("[winglet] couldn't fetch the exchange rate", exc_info=True)
            return False

    async def run(self, sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep) -> None:
        """Fetch when due; after a failure retry with a growing wait (5 min doubling to 6 h)."""
        wait = RETRY_FIRST_SECONDS
        while True:
            if self.due():
                if await self.refresh():
                    wait = RETRY_FIRST_SECONDS
                else:
                    await sleep(wait)
                    wait = min(wait * 2, RETRY_MAX_SECONDS)
                    continue
            await sleep(max(60.0, REFRESH_SECONDS - (self._clock() - self.fetched_at)))
