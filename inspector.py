"""Inspector: detect and cancel orphan orders"""

import asyncio
import json
import re
import threading
from typing import Awaitable, Callable, Dict, List, Optional, Set, Tuple, Union
import aiohttp
from config import API_BASE_URL, format_proxy_for_aiohttp, get_telegram_config
from logger import log_error_to_file

INSPECTOR_CYCLE_TIMEOUT_SEC = 25
PAGE_SIZE = 100
CANCEL_BATCH_SIZE = 50
TELEGRAM_API = "https://api.telegram.org/bot{token}/sendMessage"
TELEGRAM_FOOTER = '\n\nby <a href="https://t.me/rudy_web3"><b>Rudy vs Web3</b></a>'
PLAIN_TELEGRAM_FOOTER = "\n\nby Rudy vs Web3 — https://t.me/rudy_web3"


def _telegram_parse_error(err: str) -> bool:
    e = (err or "").lower()
    return any(
        x in e
        for x in (
            "entity",
            "parse",
            "unsupported",
            "start tag",
            "end tag",
            "can't find end",
            "unclosed",
        )
    )


def _telegram_message_to_plain(message: str) -> str:
    """Убрать HTML-теги для повторной отправки без parse_mode (если Telegram отклонил HTML)."""
    s = re.sub(r"<[^>]+>", "", message or "")
    return (s.strip() + PLAIN_TELEGRAM_FOOTER).strip()


def normalize_telegram_chat_id(raw: str) -> Union[int, str, None]:
    """Chat ID: целое (в т.ч. отрицательное для групп) или @channel username."""
    s = (raw or "").strip()
    if not s:
        return None
    if s.startswith("@"):
        return s
    try:
        return int(s)
    except ValueError:
        return s


def _telegram_result_from_raw(raw: str, http_status: int) -> Tuple[bool, str]:
    try:
        data = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        return False, (raw[:400] if raw else f"HTTP {http_status}, не JSON")[:400]

    if isinstance(data, dict) and data.get("ok") is True:
        return True, ""

    err_parts = []
    if isinstance(data, dict):
        desc = (data.get("description") or "").strip()
        if desc:
            err_parts.append(desc)
        ec = data.get("error_code")
        if ec is not None:
            err_parts.append(f"code={ec}")
    err = " ".join(err_parts) if err_parts else ""
    if not err:
        err = raw[:400] if raw else f"HTTP {http_status}"
    return False, err[:400]


async def send_telegram_with_credentials(
    token: str,
    chat_id: Union[int, str, None],
    message: str,
    *,
    plain_fallback: bool = True,
) -> Tuple[bool, str]:
    """Отправка с явными token/chat (как тест в async_v3 из полей формы). Возвращает (успех, текст ошибки от Telegram)."""
    t = (token or "").strip()
    if not t or chat_id is None:
        return False, "Укажите токен и Chat ID"
    text_html = (message or "") + TELEGRAM_FOOTER
    timeout = aiohttp.ClientTimeout(total=20)

    async def post_text(session: aiohttp.ClientSession, text: str, parse_mode: Optional[str]) -> Tuple[bool, str]:
        payload: dict = {
            "chat_id": chat_id,
            "text": text,
            "disable_web_page_preview": True,
        }
        if parse_mode:
            payload["parse_mode"] = parse_mode
        async with session.post(TELEGRAM_API.format(token=t), json=payload) as resp:
            raw = await resp.text()
            return _telegram_result_from_raw(raw, resp.status)

    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            ok, err = await post_text(session, text_html, "HTML")
            if ok:
                return True, ""
            if plain_fallback and _telegram_parse_error(err):
                plain = _telegram_message_to_plain(message or "")
                ok2, err2 = await post_text(session, plain, None)
                if ok2:
                    return True, ""
                return False, err2 or err
            return False, err[:400]
    except Exception as e:
        return False, str(e)[:400]


def _get_snapshot_safe(get_snapshot: Callable[[], dict]) -> dict:
    try:
        return get_snapshot() or {}
    except Exception:
        return {}


async def send_telegram_notification(message: str) -> Tuple[bool, str]:
    token, chat_raw = get_telegram_config()
    chat = normalize_telegram_chat_id((chat_raw or "").strip())
    return await send_telegram_with_credentials(token, chat, message)


async def fetch_all_open_orders(
    get_headers: Callable[[], dict],
    proxy_url: str | None,
    api_key: str | None = None,
    log_func=print,
    refresh_jwt: Optional[Callable[[], Awaitable[bool]]] = None,
) -> List[Dict]:
    """get_headers() вызывается перед каждым запросом — после refresh JWT снимок в server даёт новый Bearer."""
    all_orders = []
    after = None
    auth_retry_used = False
    while True:
        params = {"status": "OPEN", "first": str(PAGE_SIZE)}
        if api_key:
            params["apiKey"] = api_key.strip()
        if after:
            params["after"] = after
        try:
            headers = get_headers()
            connector = aiohttp.TCPConnector(force_close=True)
            async with aiohttp.ClientSession(connector=connector) as session:
                async with session.get(
                    f"{API_BASE_URL}/v1/orders",
                    headers=headers,
                    params=params,
                    proxy=proxy_url,
                    timeout=aiohttp.ClientTimeout(connect=5, total=12),
                ) as resp:
                    if resp.status == 401:
                        text = await resp.text()
                        if refresh_jwt and not auth_retry_used:
                            auth_retry_used = True
                            try:
                                ok = await refresh_jwt()
                            except Exception:
                                ok = False
                            if ok:
                                log_func("[Inspector] JWT refreshed after 401, retrying GET /v1/orders...")
                                continue
                        log_func(f"[Inspector] GET orders error: {resp.status} - {text[:200]}")
                        break
                    if not resp.ok:
                        text = await resp.text()
                        log_func(f"[Inspector] GET orders error: {resp.status} - {text[:200]}")
                        break
                    data = await resp.json()
                    orders = data.get("data", [])
                    all_orders.extend(orders)
                    cursor = data.get("cursor")
                    if not cursor or len(orders) < PAGE_SIZE:
                        break
                    after = cursor
        except (aiohttp.ClientError, asyncio.TimeoutError, Exception) as e:
            log_func(f"[Inspector] fetch orders error: {e}")
            try:
                loop = asyncio.get_event_loop()
                loop.run_in_executor(None, lambda ex=e: log_error_to_file("Inspector fetch orders", exception=ex))
            except Exception:
                pass
            break
    return all_orders


async def cancel_orders_direct(
    order_ids: List[str],
    headers: dict,
    proxy_url: str | None,
) -> bool:
    if not headers or not order_ids:
        return True
    for i in range(0, len(order_ids), CANCEL_BATCH_SIZE):
        batch = order_ids[i:i + CANCEL_BATCH_SIZE]
        try:
            connector = aiohttp.TCPConnector(force_close=True)
            async with aiohttp.ClientSession(connector=connector) as session:
                async with session.post(
                    f"{API_BASE_URL}/v1/orders/remove",
                    headers=headers,
                    json={"data": {"ids": [str(x) for x in batch]}},
                    proxy=proxy_url,
                    timeout=aiohttp.ClientTimeout(total=10),
                ) as resp:
                    if resp.status == 401:
                        return False
                    if not resp.ok:
                        return False
                    data = await resp.json()
                    if not data.get("success", True):
                        return False
        except Exception:
            return False
        if i + CANCEL_BATCH_SIZE < len(order_ids):
            await asyncio.sleep(0.5)
    return True


async def run_inspector_cycle(
    get_snapshot: Callable[[], dict],
    log_func=print,
    on_orders_count: Callable[[int, int], None] | None = None,
    refresh_jwt: Optional[Callable[[], Awaitable[bool]]] = None,
) -> None:
    def get_headers() -> dict:
        s = _get_snapshot_safe(get_snapshot)
        return s.get("headers") or {}

    if not get_headers():
        return
    snapshot = _get_snapshot_safe(get_snapshot)
    proxy_url = format_proxy_for_aiohttp(snapshot.get("proxy"))
    api_key = snapshot.get("api_key")
    expected: Set[str] = snapshot.get("expected") or set()
    managed: Set[str] = snapshot.get("managed") or set()
    if not isinstance(expected, set):
        expected = set(expected) if expected else set()
    if not isinstance(managed, set):
        managed = set(managed) if managed else set()

    api_orders = await fetch_all_open_orders(
        get_headers, proxy_url, api_key, log_func, refresh_jwt=refresh_jwt
    )
    autosell_ids: Set[str] = snapshot.get("autosell_expected_ids") or set()
    if not isinstance(autosell_ids, set):
        autosell_ids = set(autosell_ids) if autosell_ids else set()
    autosell_in_api = 0
    for o in api_orders:
        oid = o.get("id") or o.get("orderId")
        if oid and str(oid) in autosell_ids:
            autosell_in_api += 1
    if on_orders_count is not None:
        try:
            on_orders_count(len(api_orders), autosell_in_api)
        except Exception:
            pass
    if not api_orders or not managed:
        return

    snapshot = _get_snapshot_safe(get_snapshot)
    expected = snapshot.get("expected") or set()
    managed = snapshot.get("managed") or set()
    if not isinstance(expected, set):
        expected = set(expected) if expected else set()
    if not isinstance(managed, set):
        managed = set(managed) if managed else set()

    orphans = []
    for o in api_orders:
        mid = str(o.get("marketId", ""))
        if mid not in managed:
            continue
        oid = o.get("id") or o.get("orderId")
        if oid and str(oid) not in expected:
            orphans.append(str(oid))

    if orphans:
        from logger import debug_module
        debug_module("Inspector", "found orphans", {"count": len(orphans), "ids": orphans[:5]})
        ids_str = ", ".join(orphans[:10]) + ("..." if len(orphans) > 10 else "")
        log_func(f"[Inspector] Found {len(orphans)} orphan orders: {ids_str}")
        ok = await cancel_orders_direct(orphans, get_headers(), proxy_url)
        if ok:
            log_func(f"[Inspector] Cancelled {len(orphans)} orphan orders")


def _run_inspector_thread(
    get_snapshot: Callable[[], dict],
    log_func: Callable[[str], None],
    on_orders_count: Callable[[int, int], None] | None,
    stop_event: threading.Event,
    get_interval_sec: Callable[[], float],
    refresh_jwt: Optional[Callable[[], Awaitable[bool]]] = None,
) -> None:
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    async def _loop():
        while not stop_event.is_set():
            try:
                await asyncio.wait_for(
                    run_inspector_cycle(get_snapshot, log_func, on_orders_count, refresh_jwt=refresh_jwt),
                    timeout=INSPECTOR_CYCLE_TIMEOUT_SEC,
                )
            except asyncio.TimeoutError:
                log_func("[Inspector] Cycle timeout, retrying")
            except asyncio.CancelledError:
                break
            except Exception as e:
                log_func(f"[Inspector] Cycle error: {e}")
                try:
                    loop.run_in_executor(None, lambda ex=e: log_error_to_file("Inspector loop", exception=ex))
                except Exception:
                    pass
            try:
                interval = max(1.0, float(get_interval_sec()))
            except Exception:
                interval = 5.0
            remaining = interval
            while remaining > 0 and not stop_event.is_set():
                chunk = min(1.0, remaining)
                await asyncio.sleep(chunk)
                remaining -= chunk

    try:
        loop.run_until_complete(_loop())
    finally:
        loop.close()


class Inspector:
    def __init__(
        self,
        get_snapshot: Callable[[], dict],
        on_orders_count: Callable[[int, int], None] | None = None,
        log_func: Callable[[str], None] = print,
        get_interval_sec: Optional[Callable[[], float]] = None,
        refresh_jwt: Optional[Callable[[], Awaitable[bool]]] = None,
    ):
        self.get_snapshot = get_snapshot
        self.on_orders_count = on_orders_count
        self.log_func = log_func
        self._get_interval_sec = get_interval_sec or (lambda: 5.0)
        self._refresh_jwt = refresh_jwt
        self._thread: threading.Thread | None = None
        self._running = False
        self._stop_event = threading.Event()

    def start(self, _loop=None) -> None:
        if self._running:
            return
        self._running = True
        self._stop_event.clear()

        def _thread_target():
            try:
                _run_inspector_thread(
                    self.get_snapshot,
                    self.log_func,
                    self.on_orders_count,
                    self._stop_event,
                    self._get_interval_sec,
                    refresh_jwt=self._refresh_jwt,
                )
            except Exception as e:
                try:
                    self.log_func(f"[Inspector] Thread error: {e}")
                except Exception:
                    pass
            finally:
                self._running = False

        self._thread = threading.Thread(target=_thread_target, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._running = False
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=3)
        self._thread = None
