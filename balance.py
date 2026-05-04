"""Balance updater"""

import asyncio
import time
from typing import Callable, Optional


class BalanceUpdater:
    def __init__(
        self,
        get_balance_fn: Callable[[], Optional[float]],
        on_updated: Callable[[str, float, float], None],
        address: str,
        interval_sec: float = 60,
        interval_getter: Optional[Callable[[], float]] = None,
    ):
        self.get_balance_fn = get_balance_fn
        self.on_updated = on_updated
        self.address = address
        self.interval_sec = interval_sec
        self.interval_getter = interval_getter
        self._task: Optional[asyncio.Task] = None

    def start(self, loop: asyncio.AbstractEventLoop):
        if self._task and not self._task.done():
            return

        async def _run():
            while True:
                try:
                    balance = await asyncio.to_thread(self.get_balance_fn)
                    if balance is not None:
                        self.on_updated(self.address, balance, time.time())
                except Exception:
                    pass
                iv = self.interval_getter() if self.interval_getter else self.interval_sec
                try:
                    iv = float(iv)
                except (TypeError, ValueError):
                    iv = self.interval_sec
                await asyncio.sleep(max(1.0, iv))

        self._task = asyncio.run_coroutine_threadsafe(_run(), loop)

    def stop(self):
        if self._task:
            self._task.cancel()
            self._task = None
