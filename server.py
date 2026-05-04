"""FastAPI server for Predict Fun Liquidity Provider"""

import sys

# Windows: консоль по умолчанию cp1251, print() падает на символах вроде "->"(U+2192).
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

import asyncio
import copy
import html
import json
from datetime import datetime, timezone
import os
import re
import time
import threading
from contextlib import asynccontextmanager
from typing import Any, Dict, Optional, Tuple, Union

# Краткое окно, когда последние слоты уже offline, а переподключающиеся ещё не успели: _live_count=0. Без задержки UI мигает "0/20".
_WS_AGGREGATE_OFFLINE_SEC = 0.65
_ws_aggregate_offline_task: Optional[asyncio.Task] = None


def _cancel_ws_aggregate_offline() -> None:
    global _ws_aggregate_offline_task
    t = _ws_aggregate_offline_task
    if t is not None and not t.done():
        t.cancel()
    _ws_aggregate_offline_task = None

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import logging
import warnings


class _SuppressPredictSdkMakerSignerNoise(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        m = (record.getMessage() or "").lower()
        if "maker" in m and "signer" in m and "ignored" in m:
            return False
        return True


# predict_sdk спамит WARNING при Predict account — глушим до импорта executor (там же импорт sdk).
_ps = _SuppressPredictSdkMakerSignerNoise()
for _name in ("predict_sdk", ""):
    _lg = logging.getLogger(_name)
    _lg.setLevel(logging.CRITICAL)
    _lg.addFilter(_ps)
logging.getLogger().addFilter(_ps)
warnings.filterwarnings("ignore", message=r".*[Mm]aker.*[Ss]igner.*[Ii]gnored.*")
warnings.filterwarnings("ignore", message=r".*[Pp]redict account.*")

from config import (
    API_BASE_URL, ACCOUNTS_FILE, SETTINGS_FILE, LAST_MARKETS_FILE,
    APP_STATE_FILE, DEFAULTS, CREDENTIALS_FILE,
    get_websocket_pool_settings, get_telegram_config, get_log_settings,
    get_insufficient_collateral_cooldown_sec, format_proxy_for_aiohttp,
    get_orders_all_max_concurrent, get_market_load_max_concurrent,
    get_balance_poll_interval_sec, get_telegram_status_interval_sec,
    get_autosell_poll_interval_sec, set_autosell_poll_interval_sec,
    get_autosell_enabled, set_autosell_enabled,
    get_autosell_max_loss_percent, set_autosell_max_loss_percent,
    get_autosell_order_status_interval_sec, set_autosell_order_status_interval_sec,
    get_autosell_delay_before_sell_sec, set_autosell_delay_before_sell_sec,
    get_autosell_order_expiration_sec, set_autosell_order_expiration_sec,
    get_inspector_interval_sec,
    get_predict_points_settings,
    websocket_ui_logs_enabled,
)
from settings import TokenSettings, SettingsManager

# Серийная обработка авто-ликвидности по рынку (как один поток решений на рынок в async_v3)
_liquidity_tick_locks: Dict[str, asyncio.Lock] = {}


def _liquidity_tick_lock_for(market_id: str) -> asyncio.Lock:
    lock = _liquidity_tick_locks.get(market_id)
    if lock is None:
        lock = asyncio.Lock()
        _liquidity_tick_locks[market_id] = lock
    return lock


def _clear_liquidity_tick_locks() -> None:
    _liquidity_tick_locks.clear()


from accounts import load_accounts_from_file, save_accounts_to_file
from auth import get_auth_jwt, get_auth_headers
from api import APIClient
from websocket import WebSocketClient, WebSocketPool
from executor import Executor
from calculator import Calculator
from market import MarketModule
from predict_points import market_info_has_active_predict_points
from balance import BalanceUpdater
from loader import (
    load_markets,
    merge_market_ids_into_saved_file,
    read_market_ids_from_saved_file,
    remove_market_ids_from_saved_file,
)
from inspector import (
    Inspector,
    fetch_all_open_orders,
    cancel_orders_direct,
    send_telegram_with_credentials,
    send_telegram_notification,
    normalize_telegram_chat_id,
)
from logger import diag_print, setup_logging
from autosell_price import (
    compute_sell_price_and_effective_loss,
    infer_filled_by_amount_strings_wei,
    infer_filled_by_rest_amounts,
    infer_partial_by_amount_strings_wei,
    infer_partial_by_rest_amounts,
    merge_predict_order_dict,
    outcome_to_side_key,
    parse_avg_buy_price_0_1,
    parse_filled_amount_from_order,
    parse_position_shares,
    parse_total_order_amount_shares,
    predict_rest_order_status_from_view,
)


class ConnectRequest(BaseModel):
    api_key: str
    predict_account_address: str
    privy_wallet_private_key: str
    proxy: Optional[str] = None


class AutosellPollIntervalRequest(BaseModel):
    interval_sec: float


class AutosellSettingsRequest(BaseModel):
    """Опциональные поля: переданные обновляются в autosell_settings.json."""
    enabled: Optional[bool] = None
    interval_sec: Optional[float] = None
    max_loss_percent: Optional[float] = None
    order_status_interval_sec: Optional[float] = None
    delay_before_sell_sec: Optional[float] = None
    order_expiration_sec: Optional[float] = None


class MarketLoadRequest(BaseModel):
    market_ids: list[str]


class MarketImportRequest(BaseModel):
    """Импорт из JSON: список id и/или объекты с настройками (как экспорт или token_settings.json)."""
    apply_settings: bool = False
    data: Union[dict, list]


class MarketRemoveAllRequest(BaseModel):
    """Удалить все загруженные рынки; при remove_settings=True — также записи в token_settings.json."""
    remove_settings: bool = False


class SettingsUpdate(BaseModel):
    position_size_usdt: Optional[float] = None
    position_size_shares: Optional[float] = None
    min_spread: Optional[float] = None
    enabled: Optional[bool] = None
    target_liquidity: Optional[float] = None
    max_auto_spread: Optional[float] = None
    liquidity_mode: Optional[str] = None
    volatile_reposition_limit: Optional[int] = None
    volatile_window_seconds: Optional[float] = None
    volatile_cooldown_seconds: Optional[float] = None
    reposition_min_price_delta: Optional[float] = None


class GlobalSettingsUpdate(BaseModel):
    market_ids: list[str]
    position_size_usdt: Optional[float] = None
    position_size_shares: Optional[float] = None
    min_spread: Optional[float] = None
    enabled: Optional[bool] = None
    target_liquidity: Optional[float] = None
    max_auto_spread: Optional[float] = None
    liquidity_mode: Optional[str] = None
    volatile_reposition_limit: Optional[int] = None
    volatile_window_seconds: Optional[float] = None
    volatile_cooldown_seconds: Optional[float] = None
    reposition_min_price_delta: Optional[float] = None


class OrderPlaceRequest(BaseModel):
    outcome: str
    price: float
    shares: float


class CancelRequest(BaseModel):
    cancel_reason: Optional[str] = None


class GlobalConfigUpdate(BaseModel):
    websocket_pool_size: Optional[int] = None
    websocket_dedupe_identical_sec: Optional[float] = None
    websocket_connect_stagger_ms: Optional[int] = None
    websocket_slow_slot_rebalance_sec: Optional[int] = None
    websocket_slow_slot_min_spread: Optional[int] = None
    websocket_slow_slot_min_top: Optional[int] = None
    websocket_slow_slots_per_rebalance: Optional[int] = None
    websocket_dedupe_depth_levels: Optional[int] = None
    websocket_pool_verbose: Optional[bool] = None
    websocket_pool_realtime_log: Optional[bool] = None
    telegram_enabled: Optional[bool] = None
    telegram_token: Optional[str] = None
    telegram_chat_id: Optional[str] = None
    telegram_status_interval_minutes: Optional[int] = None
    insufficient_collateral_cooldown_sec: Optional[int] = None
    balance_poll_interval_sec: Optional[int] = None
    inspector_interval_sec: Optional[float] = None
    log_software: Optional[bool] = None
    log_orderbook: Optional[bool] = None
    log_orders: Optional[bool] = None
    sort_mode: Optional[int] = None
    inspector_enabled: Optional[bool] = None
    console_diagnostics: Optional[bool] = None
    orders_all_max_concurrent: Optional[int] = None
    market_load_max_concurrent: Optional[int] = None
    predict_points_require_active_reward: Optional[bool] = None
    predict_points_market_poll_sec: Optional[int] = None


class TelegramTestRequest(BaseModel):
    """Режим теста: как в async_v3 — сводка как периодический статус или баланс как уведомление об изменении."""
    mode: str = "summary"  # "summary" | "balance"
    telegram_token: Optional[str] = None
    telegram_chat_id: Optional[str] = None


class AppState:
    def __init__(self):
        self.connected = False
        self.jwt_token: Optional[str] = None
        self.api_client: Optional[APIClient] = None
        self.executor: Optional[Executor] = None
        self.ws_pool: Optional[WebSocketPool] = None
        self.ws_client_single: Optional[WebSocketClient] = None
        self.balance_updater: Optional[BalanceUpdater] = None
        self.inspector: Optional[Inspector] = None
        self.settings_manager: Optional[SettingsManager] = None
        self.market_modules: dict[str, MarketModule] = {}
        self.market_info: dict[str, dict] = {}
        self.current_account: Optional[dict] = None
        self.balance: float = 0.0
        self.balance_updated_at: float = 0.0
        self.inspector_orders_count: int = 0
        self.inspector_autosell_open_count: int = 0
        self.inspector_orders_updated_at: float = 0.0
        self.inspector_enabled: bool = False
        self.ws_last_update: float = 0.0
        self.ws_connected: bool = False
        self.log_messages: list[dict] = []
        self.max_log_messages = 5000
        # Снимок последнего состояния рынка (для цепочки on_market_state_changed), не путать с защитой от волатильности
        self._market_state_cache: dict[str, dict] = {}
        # Как async_v3 MainWindow._volatile_state: окно переставлений / cooldown по рынку
        self._liquidity_volatile: dict[str, dict] = {}
        self._log_lock = threading.Lock()
        # Market loading progress
        self.market_loading_progress: Optional[dict] = None  # {"current": int, "total": int, "loading": bool}
        # Сессия: автоликвидность по стакану только после явного действия (Place / включить в настройках).
        # Не загружается из файла — после перезапуска софта слежение выключено, пока снова не нажмёшь.
        self.liquidity_armed: set[str] = set()
        # Периодическая сводка в Telegram (как QTimer в async_v3)
        self._telegram_periodic_task: Optional[asyncio.Task] = None
        # Первый ответ опроса USDT после connect — без Telegram (не спам «новый баланс» при старте)
        self._balance_change_suppress_first_telegram: bool = False
        # AutoSell: периодический GET /v1/positions (интервал в autosell_settings.json)
        self.autosell_poll_interval_sec: float = 5.0
        # Отдельный интервал опроса ордера (GET /v1/orders/{hash}) для карточек автопродажи
        self.autosell_order_status_interval_sec: float = 3.0
        self.autosell_delay_before_sell_sec: float = 0.0
        self.autosell_order_expiration_sec: float = 0.0
        self.autosell_pending_delay_tasks: list = []
        self.autosell_positions: list = []
        self.autosell_positions_updated_at: float = 0.0
        # True после первого завершённого GET /v1/positions в сессии (даже если список пуст)
        self.autosell_positions_first_fetch_done: bool = False
        # Подэтапы первой загрузки: idle | requesting_positions | enriching_markets | assembling
        self.autosell_positions_load_stage: str = "idle"
        self.autosell_enrich_progress: Optional[dict] = None  # {"current": int, "total": int}
        # кэш GET /v1/markets/{id} для заголовков/картинок в AutoSell
        self.autosell_market_cache: dict = {}
        # AutoSell: снимок id позиций при первом успешном GET (не трогаем); новые — не из этого множества
        self.autosell_baseline_position_ids: Optional[set] = None
        self.autosell_sell_attempted_ids: set = set()
        # Карточки «новая позиция → лимит на продажу» (последние сверху)
        self.autosell_tracked_sells: list = []
        self.server_started_at: float = time.time()
        # Uptime: накопленное время в data/uptime_stats.json + хвост с uptime_last_persist_at
        self.uptime_stored_sec: float = 0.0
        self.uptime_last_persist_at: float = time.time()
        self._uptime_persist_task: Optional[asyncio.Task] = None
        # AutoSell: успешные лимитки SELL (сессия = процесс; lifetime в data/uptime_stats.json)
        self.autosell_triggers_session: int = 0
        self.autosell_triggers_lifetime: int = 0
        # Predict Points: последнее известное состояние награды (для отмены при пропадании)
        self._points_reward_prev: dict[str, bool] = {}
        self._predict_points_poll_task: Optional[asyncio.Task] = None

    def add_log(self, message: str, level: str = "info"):
        try:
            from logger import log_print, mask_sensitive
            log_print(f"[{level}] {mask_sensitive(message)}")
        except Exception:
            pass
        entry = {"message": message, "level": level, "timestamp": time.time()}
        with self._log_lock:
            self.log_messages.append(entry)
            if len(self.log_messages) > self.max_log_messages:
                self.log_messages = self.log_messages[-self.max_log_messages:]

    def get_logs_since(self, timestamp: float) -> list[dict]:
        with self._log_lock:
            return [m for m in self.log_messages if m["timestamp"] > timestamp]

    def clear_logs(self) -> None:
        with self._log_lock:
            self.log_messages.clear()

    def cleanup(self):
        t = getattr(self, "_telegram_periodic_task", None)
        if t is not None and not t.done():
            try:
                t.cancel()
            except Exception:
                pass
        self._telegram_periodic_task = None
        t_pp = getattr(self, "_predict_points_poll_task", None)
        if t_pp is not None and not t_pp.done():
            try:
                t_pp.cancel()
            except Exception:
                pass
        self._predict_points_poll_task = None
        self._points_reward_prev.clear()
        _cancel_ws_aggregate_offline()
        for name in ["inspector", "balance_updater", "ws_pool", "ws_client_single"]:
            obj = getattr(self, name, None)
            if obj:
                try:
                    obj.stop()
                except Exception:
                    pass
            setattr(self, name, None)
        self.jwt_token = None
        self.api_client = None
        self.executor = None
        self.current_account = None
        self.connected = False
        self.balance = 0.0
        self.balance_updated_at = 0.0
        self.inspector_orders_count = 0
        self.inspector_autosell_open_count = 0
        self.inspector_orders_updated_at = 0.0
        self.inspector_enabled = False
        self.ws_connected = False
        self.market_modules.clear()
        self.market_info.clear()
        self._market_state_cache.clear()
        self._liquidity_volatile.clear()
        self.market_loading_progress = None
        self.liquidity_armed.clear()
        self._balance_change_suppress_first_telegram = False
        _autosell_cancel_delay_tasks()
        _autosell_cancel_poll_task()
        self.autosell_positions = []
        self.autosell_positions_updated_at = 0.0
        self.autosell_positions_first_fetch_done = False
        self.autosell_positions_load_stage = "idle"
        self.autosell_enrich_progress = None
        self.autosell_market_cache = {}
        self.autosell_baseline_position_ids = None
        self.autosell_sell_attempted_ids = set()
        self.autosell_tracked_sells = []
        _clear_liquidity_tick_locks()

app_state = AppState()

_autosell_pos_lock = asyncio.Lock()
_autosell_poll_task: Optional[asyncio.Task] = None
_autosell_order_status_task: Optional[asyncio.Task] = None
# Параллельные GET /v1/markets/{id} при обогащении карточек AutoSell (не по одному).
_AUTOSELL_MARKET_INFO_CONCURRENCY = 10


def _autosell_cancel_poll_task() -> None:
    global _autosell_poll_task, _autosell_order_status_task
    for t in (_autosell_poll_task, _autosell_order_status_task):
        if t is not None and not t.done():
            try:
                t.cancel()
            except Exception:
                pass
    _autosell_poll_task = None
    _autosell_order_status_task = None


def _autosell_cancel_delay_tasks() -> None:
    for t in list(getattr(app_state, "autosell_pending_delay_tasks", None) or []):
        if t is not None and not t.done():
            try:
                t.cancel()
            except Exception:
                pass
    app_state.autosell_pending_delay_tasks = []


def _autosell_position_market_id(p: dict) -> Optional[str]:
    mid = p.get("marketId") or p.get("market_id")
    if mid not in (None, ""):
        return str(mid)
    m = p.get("market")
    if isinstance(m, dict) and m.get("id") is not None:
        return str(m["id"])
    return None


_AVG_FLAT_KEYS = (
    "averagePrice",
    "averageBuyPrice",
    "avgPrice",
    "averageEntryPrice",
    "average_entry_price",
    "avg_entry_price",
    "entryPrice",
    "entry_price",
)
_AVG_NEST_PARENTS = ("token", "outcome", "position", "market", "details", "data")


def _autosell_flatten_avg_price_inplace(row: dict) -> None:
    """Если API отдал среднюю цену только внутри token/outcome/market — дублируем наверх для UI."""
    if any(row.get(k) not in (None, "") for k in _AVG_FLAT_KEYS):
        return
    for parent in _AVG_NEST_PARENTS:
        sub = row.get(parent)
        if not isinstance(sub, dict):
            continue
        for fk in _AVG_FLAT_KEYS:
            v = sub.get(fk)
            if v is not None and v != "":
                row.setdefault("averagePrice", v)
                return


def _parse_wei_like_float(raw: object) -> Optional[float]:
    if raw is None:
        return None
    if isinstance(raw, bool):
        return None
    if isinstance(raw, (int, float)):
        x = float(raw)
        if abs(x) < 1e12:
            return x
        return x / 1e18
    s = str(raw).strip()
    if not s or s == "null":
        return None
    try:
        if "." in s or "e" in s.lower():
            return float(s)
        bi = int(s)
        if abs(bi) < 10**12:
            return float(bi)
        return float(bi) / 1e18
    except (ValueError, OverflowError):
        return None


def _autosell_attach_usd_inplace(row: dict) -> None:
    """Оценка стоимости позиции в USD: поле из API или shares × средняя цена."""
    if row.get("_display_value_usd") is not None:
        return
    for k in (
        "valueUsd",
        "usdValue",
        "positionValueUsd",
        "value_usd",
        "notionalUsd",
        "totalUsd",
        "usdValueLocked",
        "positionValue",
    ):
        v = row.get(k)
        if v is not None and v != "":
            try:
                row["_display_value_usd"] = round(float(v), 2)
                return
            except (TypeError, ValueError):
                continue
    sh = _parse_wei_like_float(row.get("shares") or row.get("amount") or row.get("size"))
    pr = _parse_wei_like_float(
        row.get("averagePrice")
        or row.get("averageBuyPrice")
        or row.get("avgPrice")
        or row.get("entryPrice")
    )
    if sh is not None and pr is not None and sh >= 0 and pr >= 0:
        row["_display_value_usd"] = round(sh * pr, 2)


async def _autosell_enrich_positions_rows(positions: list, track_progress: bool = False) -> list:
    """Подмешивает название и картинку рынка из GET /v1/markets/{id} (кэш на сессию)."""
    if not positions or not app_state.api_client:
        return positions
    cache: dict = app_state.autosell_market_cache
    ids_order: list[str] = []
    seen: set = set()
    for p in positions:
        if not isinstance(p, dict):
            continue
        mid = _autosell_position_market_id(p)
        if mid and mid not in cache and mid not in seen:
            seen.add(mid)
            ids_order.append(mid)
    n_ids = len(ids_order)
    if track_progress:
        if n_ids > 0:
            app_state.autosell_enrich_progress = {"current": 0, "total": n_ids}
        else:
            app_state.autosell_enrich_progress = None

    sem = asyncio.Semaphore(max(1, int(_AUTOSELL_MARKET_INFO_CONCURRENCY)))
    progress_lock = asyncio.Lock()
    done_box: list[int] = [0]

    async def fetch_and_store(mid: str) -> None:
        async with sem:
            info = await app_state.api_client.get_market_info(mid, log_func=lambda _: None)
            if isinstance(info, dict):
                cache[mid] = {
                    "title": (info.get("title") or info.get("question") or info.get("name") or "").strip(),
                    "image": (
                        (info.get("image") or info.get("imageUrl") or info.get("icon") or info.get("thumbnail") or "")
                    ).strip(),
                }
            else:
                cache[mid] = {"title": "", "image": ""}
        if track_progress:
            async with progress_lock:
                done_box[0] += 1
                app_state.autosell_enrich_progress = {"current": done_box[0], "total": n_ids}

    if ids_order:
        await asyncio.gather(*(fetch_and_store(mid) for mid in ids_order))
    if track_progress:
        app_state.autosell_positions_load_stage = "assembling"
        app_state.autosell_enrich_progress = None
    out: list = []
    for p in positions:
        if not isinstance(p, dict):
            out.append(p)
            continue
        row = dict(p)
        _autosell_flatten_avg_price_inplace(row)
        mid = _autosell_position_market_id(p)
        if mid and mid in cache:
            c = cache[mid]
            if c.get("title"):
                row["_display_market_title"] = c["title"]
            if c.get("image"):
                row["_display_market_image"] = c["image"]
        _autosell_attach_usd_inplace(row)
        out.append(row)
    return out


AUTOSELL_TRACKED_MAX = 80


def _autosell_log_wall_ms() -> str:
    """Локальное время HH:MM:SS.mmm для журнала UI."""
    dt = datetime.now()
    return dt.strftime("%H:%M:%S") + f".{dt.microsecond // 1000:03d}"


def _autosell_row_id(p: dict) -> Optional[str]:
    rid = p.get("id")
    return str(rid) if rid is not None and str(rid).strip() != "" else None


def _autosell_market_image_url(market: dict) -> str:
    if not isinstance(market, dict):
        return ""
    return (
        (market.get("image") or market.get("imageUrl") or market.get("icon") or market.get("thumbnail") or "")
        .strip()
    )


def _autosell_merge_order_api_into_row(row: dict, od: dict) -> None:
    """Дополняет строку трекинга из GET /v1/orders/{hash}: статус ордера (в стакане / исполнен и т.д.)."""
    sh0 = row.get("shares")
    view = merge_predict_order_dict(od)
    no = od.get("order")
    if isinstance(no, dict) and no.get("hash"):
        row.setdefault("order_hash", str(no["hash"]).strip())
    row["amount_filled"] = view.get("amountFilled") or view.get("amount_filled")

    mid = row.get("market_id")
    if mid and not row.get("market_image"):
        c = app_state.autosell_market_cache.get(str(mid))
        if isinstance(c, dict):
            img = (c.get("image") or "").strip()
            if img:
                row["market_image"] = img

    api_st = predict_rest_order_status_from_view(view)
    amt = parse_filled_amount_from_order(view)
    try:
        tot = float(sh0) if sh0 is not None and float(sh0) > 0 else None
    except (TypeError, ValueError):
        tot = None
    if tot is None or tot <= 0:
        tot = parse_total_order_amount_shares(view, None)
    vol_filled = infer_filled_by_rest_amounts(amt, tot) or infer_filled_by_amount_strings_wei(view)
    vol_partial = (not vol_filled) and (
        infer_partial_by_rest_amounts(amt, tot) or infer_partial_by_amount_strings_wei(view)
    )

    if api_st == "filled" or vol_filled:
        row["status"] = "filled"
    elif api_st in ("cancelled", "expired", "invalidated"):
        row["status"] = api_st
    elif api_st == "partially_filled" or (
        vol_partial and api_st not in ("cancelled", "expired", "invalidated")
    ):
        row["status"] = "partially_filled"
    elif api_st == "open":
        row["status"] = "open"
    elif api_st is None:
        if vol_filled:
            row["status"] = "filled"
        elif vol_partial:
            row["status"] = "partially_filled"
        else:
            row["status"] = "open"
    else:
        row["status"] = "open"

    for k in (
        "pnl_usd",
        "proceeds_usd",
        "cost_sold_usd",
        "fill_avg_price",
        "filled_shares",
        "cost_basis_usd",
    ):
        row.pop(k, None)


async def _autosell_update_tracked_order_statuses() -> None:
    """Обновляет строки autosell_tracked_sells по GET /v1/orders/{hash} (отдельный интервал в настройках)."""
    if not app_state.api_client or not app_state.connected:
        return
    for row in app_state.autosell_tracked_sells:
        st = row.get("status")
        if st == "delay":
            continue
        if st in ("cancelled", "expired", "invalidated", "error"):
            continue
        if st == "filled":
            continue
        prev_st = st
        oid = row.get("order_id")
        oh = str(row.get("order_hash") or "").strip()
        if not oh:
            if oid:
                row["order_updated_at"] = time.time()
            continue
        try:
            od = await app_state.api_client.get_order(oh, log_func=lambda _: None)
            if od:
                _autosell_merge_order_api_into_row(row, od)
        except Exception as e:
            try:
                app_state.add_log(f"AutoSell GET ордер {oh}: {e}", "warning")
            except Exception:
                pass
        row["order_updated_at"] = time.time()
        new_st = row.get("status")
        if prev_st != "filled" and new_st == "filled":
            mid = row.get("market_id")
            placed = row.get("updated_at")
            sec = None
            if isinstance(placed, (int, float)) and float(placed) > 0:
                sec = time.time() - float(placed)
            if sec is not None and sec >= 0:
                app_state.add_log(
                    f"AutoSell [{_autosell_log_wall_ms()}] лимитка исполнена (ответ API), "
                    f"рынок={mid} — с момента выставления лимита ~{sec:.2f} с",
                    "info",
                )
            else:
                app_state.add_log(
                    f"AutoSell [{_autosell_log_wall_ms()}] лимитка исполнена (ответ API), рынок={mid}",
                    "info",
                )
            sec_tg = sec if (sec is not None and sec >= 0) else None
            await _autosell_telegram_send_html(_telegram_msg_autosell_filled(row, sec_tg))


def _autosell_place_context(p: dict, loss_pct: float) -> tuple[Optional[dict], Optional[dict]]:
    """(error_row, None) при ошибке валидации или (None, ctx) для выставления лимита."""
    if not isinstance(p, dict):
        return (None, None)
    pid = _autosell_row_id(p)
    if not pid:
        return (None, None)
    market = p.get("market") if isinstance(p.get("market"), dict) else {}
    mimg = _autosell_market_image_url(market)
    mid = market.get("id")
    title = (market.get("title") or market.get("question") or "").strip()
    if mid is None:
        return (
            {
                "position_id": pid,
                "market_id": "",
                "market_image": mimg or None,
                "title": title or "—",
                "outcome": "",
                "avg_buy": None,
                "target_loss_percent": loss_pct,
                "effective_loss_percent": None,
                "limit_price": None,
                "shares": None,
                "order_id": None,
                "status": "error",
                "error": "Нет market.id в позиции",
                "updated_at": time.time(),
            },
            None,
        )
    mid_str = str(mid)
    dec_prec = int(market.get("decimalPrecision") or 3)
    avg = parse_avg_buy_price_0_1(p)
    shares = parse_position_shares(p)
    oc_key = outcome_to_side_key(p.get("outcome"))
    if avg is None or shares is None or avg <= 0 or shares <= 0:
        return (
            {
                "position_id": pid,
                "market_id": mid_str,
                "market_image": mimg or None,
                "title": title or f"Рынок {mid_str}",
                "outcome": oc_key,
                "avg_buy": avg,
                "target_loss_percent": loss_pct,
                "effective_loss_percent": None,
                "limit_price": None,
                "shares": shares,
                "order_id": None,
                "status": "error",
                "error": "Не удалось разобрать среднюю цену или объём позиции",
                "updated_at": time.time(),
            },
            None,
        )
    try:
        limit_px, eff_loss = compute_sell_price_and_effective_loss(avg, loss_pct, dec_prec)
    except Exception as e:
        return (
            {
                "position_id": pid,
                "market_id": mid_str,
                "market_image": mimg or None,
                "title": title or f"Рынок {mid_str}",
                "outcome": oc_key,
                "avg_buy": avg,
                "target_loss_percent": loss_pct,
                "effective_loss_percent": None,
                "limit_price": None,
                "shares": shares,
                "order_id": None,
                "status": "error",
                "error": str(e)[:200],
                "updated_at": time.time(),
            },
            None,
        )
    notional = limit_px * shares
    if notional < 1.0:
        return (
            {
                "position_id": pid,
                "market_id": mid_str,
                "market_image": mimg or None,
                "title": title or f"Рынок {mid_str}",
                "outcome": oc_key,
                "avg_buy": avg,
                "target_loss_percent": loss_pct,
                "effective_loss_percent": eff_loss,
                "limit_price": limit_px,
                "shares": shares,
                "order_id": None,
                "status": "error",
                "error": f"Номинал лимитки ${notional:.2f} < $1 (мин. ордер)",
                "updated_at": time.time(),
            },
            None,
        )
    return (
        None,
        {
            "pid": pid,
            "mid_str": mid_str,
            "market": market,
            "mimg": mimg,
            "title": title,
            "avg": avg,
            "shares": shares,
            "oc_key": oc_key,
            "limit_px": limit_px,
            "eff_loss": eff_loss,
            "dec_prec": dec_prec,
        },
    )


async def _autosell_execute_limit_from_ctx(
    ctx: dict,
    *,
    loss_pct: float,
    update_row: Optional[dict] = None,
    order_expiration_sec: Optional[int] = None,
) -> None:
    pid = ctx["pid"]
    mid_str = ctx["mid_str"]
    market = ctx["market"]
    mimg = ctx["mimg"]
    title = ctx["title"]
    avg = ctx["avg"]
    shares = ctx["shares"]
    oc_key = ctx["oc_key"]
    limit_px = ctx["limit_px"]
    eff_loss = ctx["eff_loss"]
    t_iter = time.perf_counter()
    prep_ms = (time.perf_counter() - t_iter) * 1000
    app_state.add_log(
        f"AutoSell [{_autosell_log_wall_ms()}] рынок={mid_str} {oc_key.upper()} — "
        f"лимит SELL ~{limit_px * 100:.2f}¢ (цель ≈−{eff_loss:.1f}% от AVG), shares={shares}, "
        f"подготовка ~{prep_ms:.0f} ms, отправляем в API…",
        "info",
    )
    t_api = time.perf_counter()
    oe_arg = int(order_expiration_sec) if order_expiration_sec and int(order_expiration_sec) > 0 else None
    res, err = await app_state.executor.place_sell_limit_order(
        mid_str,
        oc_key,
        limit_px,
        shares,
        market,
        title or mid_str,
        order_expiration_sec=oe_arg,
    )
    api_ms = (time.perf_counter() - t_api) * 1000
    now = time.time()
    base = {
        "position_id": pid,
        "market_id": mid_str,
        "market_image": mimg or None,
        "title": title or f"Рынок {mid_str}",
        "outcome": oc_key,
        "avg_buy": avg,
        "target_loss_percent": loss_pct,
        "effective_loss_percent": eff_loss,
        "limit_price": limit_px,
        "shares": shares,
        "updated_at": now,
    }
    if oe_arg:
        base["order_expiration_sec"] = float(oe_arg)
    if res and not err:
        base.update(
            {
                "order_id": res.get("order_id"),
                "order_hash": res.get("order_hash"),
                "status": "open",
                "error": None,
                "order_updated_at": now,
                "amount_filled": "0",
            }
        )
        if update_row is not None:
            update_row.clear()
            update_row.update(base)
        else:
            _autosell_push_tracked(base)
        app_state.add_log(
            f"AutoSell [{_autosell_log_wall_ms()}] лимитка создана: API ответ за ~{api_ms:.0f} ms — "
            f"{mid_str} {oc_key.upper()} ~{limit_px * 100:.2f}¢ (≈−{eff_loss:.1f}% от входа)",
            "info",
        )
        try:
            from uptime_stats import bump_autosell_limit_placed

            bump_autosell_limit_placed(app_state)
        except Exception:
            pass
        await _autosell_telegram_send_html(_telegram_msg_autosell_limit_placed(ctx, limit_px))
    else:
        base["order_id"] = None
        base["order_hash"] = None
        base["status"] = "error"
        base["error"] = err or "Не удалось выставить продажу"
        if update_row is not None:
            update_row.clear()
            update_row.update(base)
        else:
            _autosell_push_tracked(base)
        app_state.add_log(
            f"AutoSell [{_autosell_log_wall_ms()}] лимитка отклонена за ~{api_ms:.0f} ms — рынок={mid_str}: {err or 'ошибка'}",
            "warning",
        )


async def _autosell_run_delayed_sell(
    snapshot: dict,
    row: dict,
    delay_sec: float,
    loss_pct: float,
    order_expiration_sec: Optional[int],
) -> None:
    try:
        await asyncio.sleep(max(0.0, float(delay_sec)))
        if not app_state.connected or not app_state.executor or not app_state.api_client:
            row["status"] = "error"
            row["error"] = "Отключено до выставления лимита"
            row["updated_at"] = time.time()
            return
        err_row, ctx = _autosell_place_context(snapshot, loss_pct)
        if err_row is not None:
            row.clear()
            row.update(err_row)
            return
        if not ctx:
            row["status"] = "error"
            row["error"] = "Позиция недоступна"
            row["updated_at"] = time.time()
            return
        app_state.add_log(
            f"AutoSell [{_autosell_log_wall_ms()}] задержка истекла — выставляем лимит, рынок={ctx['mid_str']}",
            "info",
        )
        await _autosell_execute_limit_from_ctx(
            ctx,
            loss_pct=loss_pct,
            update_row=row,
            order_expiration_sec=order_expiration_sec,
        )
    except asyncio.CancelledError:
        row["status"] = "error"
        row["error"] = "Отмена"
        row["updated_at"] = time.time()
        raise


async def _autosell_place_for_new_positions(
    rows: list,
    poll_timing: Optional[dict] = None,
) -> None:
    if not app_state.connected or not app_state.executor or not app_state.api_client:
        return
    baseline = app_state.autosell_baseline_position_ids
    if baseline is None:
        return
    loss_pct = float(get_autosell_max_loss_percent())
    delay_sec = float(get_autosell_delay_before_sell_sec())
    oe_cfg = float(get_autosell_order_expiration_sec())
    order_expiration_opt = int(oe_cfg) if oe_cfg > 0 else None
    to_process: list = []
    for p in rows:
        if not isinstance(p, dict):
            continue
        pid = _autosell_row_id(p)
        if not pid:
            continue
        if pid in baseline or pid in app_state.autosell_sell_attempted_ids:
            continue
        to_process.append(p)
    if not to_process:
        return
    if poll_timing:
        g = float(poll_timing.get("get_ms") or 0.0)
        e = float(poll_timing.get("enrich_ms") or 0.0)
        s = float(poll_timing.get("sched_ms") or 0.0)
        app_state.add_log(
            f"AutoSell [{_autosell_log_wall_ms()}] новая позиция (не в baseline): начинаем лимит SELL — "
            f"тайминг цикла: GET ~{g:.0f} ms, обогащение ~{e:.0f} ms, до обработчика ~{s:.0f} ms "
            f"(после обогащения: очередь event loop / фоновая задача)",
            "info",
        )
    for p in to_process:
        pid = _autosell_row_id(p)
        if not pid:
            continue
        app_state.autosell_sell_attempted_ids.add(pid)
        err_row, ctx = _autosell_place_context(p, loss_pct)
        if err_row is not None:
            er = (err_row.get("error") or "").strip()
            if "Нет market.id" in er:
                app_state.add_log(
                    f"AutoSell [{_autosell_log_wall_ms()}] нет market.id в позиции — лимит не выставляем",
                    "warning",
                )
            elif "Не удалось разобрать" in er:
                app_state.add_log(
                    f"AutoSell [{_autosell_log_wall_ms()}] рынок={err_row.get('market_id', '')}: не разобрали AVG/shares — пропуск",
                    "warning",
                )
            elif "Номинал лимитки" in er:
                app_state.add_log(
                    f"AutoSell [{_autosell_log_wall_ms()}] рынок={err_row.get('market_id', '')}: номинал < $1 — не шлём",
                    "warning",
                )
            else:
                app_state.add_log(
                    f"AutoSell [{_autosell_log_wall_ms()}] рынок={err_row.get('market_id', '')}: {er[:160]}",
                    "warning",
                )
            _autosell_push_tracked(err_row)
            continue
        if not ctx:
            continue
        if delay_sec > 0:
            ends = time.time() + delay_sec
            snap = copy.deepcopy(p)
            row = _autosell_push_tracked(
                {
                    "position_id": ctx["pid"],
                    "market_id": ctx["mid_str"],
                    "market_image": ctx["mimg"] or None,
                    "title": ctx["title"] or f"Рынок {ctx['mid_str']}",
                    "outcome": ctx["oc_key"],
                    "avg_buy": ctx["avg"],
                    "target_loss_percent": loss_pct,
                    "effective_loss_percent": ctx["eff_loss"],
                    "limit_price": ctx["limit_px"],
                    "shares": ctx["shares"],
                    "order_id": None,
                    "order_hash": None,
                    "status": "delay",
                    "error": None,
                    "updated_at": time.time(),
                    "delay_ends_at": ends,
                    "order_expiration_sec": float(order_expiration_opt) if order_expiration_opt else None,
                }
            )
            app_state.add_log(
                f"AutoSell [{_autosell_log_wall_ms()}] рынок={ctx['mid_str']}: пауза {delay_sec:.0f} с перед лимитом SELL",
                "info",
            )

            async def _run() -> None:
                await _autosell_run_delayed_sell(snap, row, delay_sec, loss_pct, order_expiration_opt)

            t = asyncio.create_task(_run())

            def _done(_f: asyncio.Task) -> None:
                try:
                    app_state.autosell_pending_delay_tasks.remove(t)
                except ValueError:
                    pass

            app_state.autosell_pending_delay_tasks.append(t)
            t.add_done_callback(_done)
        else:
            await _autosell_execute_limit_from_ctx(
                ctx,
                loss_pct=loss_pct,
                update_row=None,
                order_expiration_sec=order_expiration_opt,
            )


def _autosell_push_tracked(entry: dict) -> dict:
    app_state.autosell_tracked_sells.insert(0, entry)
    if len(app_state.autosell_tracked_sells) > AUTOSELL_TRACKED_MAX:
        app_state.autosell_tracked_sells = app_state.autosell_tracked_sells[:AUTOSELL_TRACKED_MAX]
    return entry


async def _autosell_after_positions_refresh(rows: list, poll_timing: Optional[dict] = None) -> None:
    await _autosell_place_for_new_positions(rows, poll_timing=poll_timing)


async def _autosell_refresh_positions_async() -> None:
    if not app_state.api_client or not app_state.connected:
        return
    is_first_fetch = not app_state.autosell_positions_first_fetch_done
    rows_out: list = []
    ok = False
    timing_for_task: Optional[dict] = None
    async with _autosell_pos_lock:
        try:
            if is_first_fetch:
                app_state.autosell_positions_load_stage = "requesting_positions"
                app_state.autosell_enrich_progress = None
            t_pg0 = time.perf_counter()
            pos = await app_state.api_client.get_positions(log_func=lambda _: None)
            rows = list(pos) if pos else []
            t_pg1 = time.perf_counter()
            if is_first_fetch:
                app_state.autosell_positions_load_stage = "enriching_markets"
            rows = await _autosell_enrich_positions_rows(rows, track_progress=is_first_fetch)
            t_pg2 = time.perf_counter()
            app_state.autosell_positions = rows
            app_state.autosell_positions_updated_at = time.time()
            if is_first_fetch:
                app_state.autosell_baseline_position_ids = {
                    str(p.get("id")) for p in rows if isinstance(p, dict) and p.get("id") is not None
                }
            rows_out = list(rows)
            app_state.autosell_positions_first_fetch_done = True
            ok = True
            timing_for_task = {
                "get_ms": (t_pg1 - t_pg0) * 1000,
                "enrich_ms": (t_pg2 - t_pg1) * 1000,
                "t_mono_after_enrich": t_pg2,
            }
        except Exception:
            app_state.autosell_positions = []
            timing_for_task = None
        if is_first_fetch:
            app_state.autosell_positions_load_stage = "idle"
            app_state.autosell_enrich_progress = None
    if ok and rows_out is not None:
        if timing_for_task:
            t_sched = time.perf_counter()
            timing_for_task["sched_ms"] = (t_sched - timing_for_task["t_mono_after_enrich"]) * 1000
        asyncio.create_task(_autosell_after_positions_refresh(rows_out, timing_for_task))


async def _autosell_poll_loop() -> None:
    try:
        while app_state.connected:
            await _autosell_refresh_positions_async()
            sec = max(1.0, float(getattr(app_state, "autosell_poll_interval_sec", 5.0)))
            await asyncio.sleep(sec)
    except asyncio.CancelledError:
        raise


async def _autosell_order_status_loop() -> None:
    while app_state.connected:
        try:
            await _autosell_update_tracked_order_statuses()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            try:
                app_state.add_log(f"AutoSell опрос статусов ордеров: {e}", "warning")
            except Exception:
                pass
        try:
            sec = max(1.0, float(getattr(app_state, "autosell_order_status_interval_sec", 3.0)))
            await asyncio.sleep(sec)
        except asyncio.CancelledError:
            raise


async def _start_autosell_poll_session_async() -> None:
    global _autosell_poll_task, _autosell_order_status_task
    _autosell_cancel_delay_tasks()
    _autosell_cancel_poll_task()
    app_state.autosell_positions = []
    app_state.autosell_positions_updated_at = 0.0
    app_state.autosell_positions_first_fetch_done = False
    app_state.autosell_positions_load_stage = "idle"
    app_state.autosell_enrich_progress = None
    app_state.autosell_market_cache = {}
    app_state.autosell_baseline_position_ids = None
    app_state.autosell_sell_attempted_ids = set()
    app_state.autosell_tracked_sells = []
    app_state.autosell_poll_interval_sec = float(get_autosell_poll_interval_sec())
    app_state.autosell_order_status_interval_sec = float(get_autosell_order_status_interval_sec())
    app_state.autosell_delay_before_sell_sec = float(get_autosell_delay_before_sell_sec())
    app_state.autosell_order_expiration_sec = float(get_autosell_order_expiration_sec())
    if not get_autosell_enabled():
        try:
            app_state.add_log("AutoSell выключен — опрос позиций и автопродажа не запускаются", "info")
        except Exception:
            pass
        return
    try:
        _autosell_poll_task = asyncio.create_task(_autosell_poll_loop())
    except Exception as e:
        try:
            app_state.add_log(f"AutoSell: не запущен опрос позиций: {e}", "error")
        except Exception:
            pass
    try:
        _autosell_order_status_task = asyncio.create_task(_autosell_order_status_loop())
    except Exception as e:
        try:
            app_state.add_log(f"AutoSell: не запущен опрос ордеров: {e}", "error")
        except Exception:
            pass


def _is_liquidity_volatile_cooldown(market_id: str) -> bool:
    """Как async_v3 MainWindow.is_volatile_cooldown."""
    st = app_state._liquidity_volatile.get(market_id)
    if not st:
        return False
    until = st.get("cooldown_until")
    if until is None:
        return False
    if time.time() >= until:
        st["cooldown_until"] = None
        return False
    return True


def _liquidity_volatile_cooldown_until_ts(market_id: str) -> Optional[float]:
    """Unix-время окончания паузы по волатильности (сек), если активна; иначе None."""
    if not _is_liquidity_volatile_cooldown(market_id):
        return None
    st = app_state._liquidity_volatile.get(market_id)
    if not st:
        return None
    u = st.get("cooldown_until")
    return float(u) if u is not None else None


def _liquidity_volatile_before_place(market_id: str) -> bool:
    """Как async_v3 MainWindow._volatile_before_place — False = не выставлять (в паузе по волатильности)."""
    sm = app_state.settings_manager
    if not sm:
        return True
    settings = sm.get_settings(market_id)
    limit = getattr(settings, "volatile_reposition_limit", 0) or 0
    window_sec = getattr(settings, "volatile_window_seconds", 60) or 0
    if limit <= 0 or window_sec <= 0:
        return True
    now = time.time()
    st = app_state._liquidity_volatile.setdefault(
        market_id, {"window_start": None, "reposition_count": 0, "cooldown_until": None}
    )
    if st.get("cooldown_until") is not None and now < st["cooldown_until"]:
        return False
    if st.get("cooldown_until") is not None and now >= st["cooldown_until"]:
        st["cooldown_until"] = None
    window_start = st.get("window_start")
    if window_start is None or (now - window_start) > window_sec:
        st["window_start"] = now
        st["reposition_count"] = 0
    return True


def _liquidity_volatile_on_cancel_done(market_id: str) -> None:
    """Как async_v3 MainWindow._volatile_on_cancel_done — после любой успешной отмены (счётчик в окне)."""
    sm = app_state.settings_manager
    if not sm:
        return
    settings = sm.get_settings(market_id)
    limit = getattr(settings, "volatile_reposition_limit", 0) or 0
    window_sec = getattr(settings, "volatile_window_seconds", 60) or 0
    cooldown_sec = getattr(settings, "volatile_cooldown_seconds", 3600) or 0
    if limit <= 0 or window_sec <= 0:
        return
    now = time.time()
    st = app_state._liquidity_volatile.setdefault(
        market_id, {"window_start": None, "reposition_count": 0, "cooldown_until": None}
    )
    if st.get("cooldown_until") is not None:
        return
    window_start = st.get("window_start")
    if window_start is None or (now - window_start) > window_sec:
        return
    st["reposition_count"] = st.get("reposition_count", 0) + 1
    info = app_state.market_info.get(market_id, {})
    title = (info.get("title") or market_id)[:30]
    if st["reposition_count"] >= limit:
        st["cooldown_until"] = now + cooldown_sec
        until_ts = datetime.fromtimestamp(st["cooldown_until"]).strftime("%H:%M:%S")
        app_state.add_log(
            f"[{market_id} | {title}] Защита от волатильности: {st['reposition_count']} переставлений за окно — пауза до {until_ts}",
            "warning",
        )
    else:
        remaining = max(0, int(window_start + window_sec - now))
        app_state.add_log(
            f"[{market_id} | {title}] Переставление {st['reposition_count']}/{limit}, в окне осталось ~{remaining} сек",
            "info",
        )


def _strip_all_can_place_for_client(oi: dict) -> dict:
    oi = dict(oi)
    oi["can_place_yes"] = False
    oi["can_place_no"] = False
    oi["can_place_yes_liquidity"] = False
    oi["can_place_no_liquidity"] = False
    oi["can_place_yes_spread"] = False
    oi["can_place_no_spread"] = False
    return oi


def _order_info_for_client(market_id: str, order_info: Optional[dict]) -> Optional[dict]:
    """Гейты для UI и автоликвидности: Predict Points, затем пауза волатильности."""
    if not order_info:
        return order_info
    oi = dict(order_info)
    predict_blocked = False
    st = get_predict_points_settings()
    if st["require_active_reward"]:
        if not market_info_has_active_predict_points(app_state.market_info.get(market_id, {})):
            oi = _strip_all_can_place_for_client(oi)
            predict_blocked = True
    oi["predict_points_blocked"] = predict_blocked
    if _is_liquidity_volatile_cooldown(market_id):
        oi = _strip_all_can_place_for_client(oi)
    return oi


def _sync_points_reward_prev_for_market(mid: str, info: dict) -> None:
    if not get_predict_points_settings()["require_active_reward"]:
        app_state._points_reward_prev.pop(mid, None)
        return
    app_state._points_reward_prev[mid] = market_info_has_active_predict_points(info)


def _maybe_start_predict_points_poll_task() -> None:
    if app_state._predict_points_poll_task and not app_state._predict_points_poll_task.done():
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    app_state._predict_points_poll_task = loop.create_task(_predict_points_market_poll_loop())


async def _predict_points_market_poll_loop() -> None:
    """
    Фоновый GET /v1/markets/{id} по всем загруженным рынкам — актуальный rewards (разрабы могут
    менять расписание). При пропадании активной награды — отмена ордеров без chain place.
    """
    while app_state.connected:
        st = get_predict_points_settings()
        interval = st["market_poll_sec"]
        if not st["require_active_reward"] or interval <= 0:
            try:
                await asyncio.sleep(120)
            except asyncio.CancelledError:
                raise
            continue
        try:
            await asyncio.sleep(interval)
        except asyncio.CancelledError:
            raise
        if not app_state.connected:
            break
        api = app_state.api_client
        if not api:
            continue
        mids = list(app_state.market_modules.keys())
        if not mids:
            continue
        sem = asyncio.Semaphore(get_market_load_max_concurrent())

        async def _poll_one(mid: str) -> None:
            async with sem:
                try:
                    info = await api.get_market_info(mid, log_func=lambda _: None)
                except Exception:
                    return
                if not info:
                    return
                app_state.market_info[mid] = info
                sts = get_predict_points_settings()
                if sts["require_active_reward"]:
                    new_active = market_info_has_active_predict_points(info)
                    prev_known = app_state._points_reward_prev.get(mid)
                    if prev_known is True and new_active is False:
                        ex = app_state.executor
                        if ex:
                            active = ex.get_active_orders(mid)
                            if active.get("yes") or active.get("no"):
                                title = (info.get("title") or info.get("question") or mid)[:120]
                                app_state.add_log(
                                    f"Predict Points: награда закончилась — отмена ордеров [{mid[:14]}…] {title[:50]}",
                                    "warning",
                                )
                                await ex.enqueue_cancel(
                                    mid,
                                    market_title=title,
                                    cancel_reason="predict_points_ended",
                                    chain_replace=False,
                                )
                    app_state._points_reward_prev[mid] = new_active
                else:
                    app_state._points_reward_prev.pop(mid, None)
                recalculate_market_state_from_last_orderbook(mid)

        await asyncio.gather(*(_poll_one(m) for m in mids))


def _websocket_ui_log(message: str, level: str = "info") -> None:
    """Лог в UI только если включены сообщения о WebSocket (см. config.WEBSOCKET_UI_LOGS_ENABLED)."""
    if not websocket_ui_logs_enabled():
        return
    app_state.add_log(message, level)


def extract_nickname_from_account_data(data: Optional[dict]) -> str:
    """Как в Qt GUI: nickname / username / name, в т.ч. во вложенных объектах. Без ведущего @."""
    def _strip_at(s: str) -> str:
        s = (s or "").strip()
        return s[1:].strip() if s.startswith("@") else s

    if not data:
        return ""
    n = _strip_at(data.get("nickname") or data.get("username") or data.get("name") or "")
    if n:
        return n
    for key in ("user", "profile", "account"):
        nested = data.get(key)
        if isinstance(nested, dict):
            n2 = _strip_at(nested.get("nickname") or nested.get("username") or nested.get("name") or "")
            if n2:
                return n2
    return ""


def _short_addr(addr: str, left: int = 6, right: int = 4) -> str:
    a = (addr or "").strip()
    if len(a) <= left + right + 2:
        return a or "—"
    return f"{a[:left]}…{a[-right:]}"


def _build_telegram_periodic_status_message() -> str:
    """Текст как async_v3 MainWindow._send_status_report (без демо-блока)."""
    balance = float(app_state.balance)
    balance_str = f"${balance:,.2f}"
    prelim, placed = _compute_telegram_status_counts()
    n_markets = len(app_state.market_modules)
    api_str = _inspector_orders_api_caption()
    uptime_str = _telegram_uptime_str()
    now_str = datetime.now().strftime("%H:%M:%S")
    return (
        f"📊 <b>Статус</b> ({now_str})\n\n"
        f"💰 Баланс: {balance_str}\n\n"
        f"📈 Рынков: {n_markets}\n"
        f"📍 Можно выставить: {prelim}\n"
        f"✅ Выставлено: {placed}\n"
        f"📋 API ордеров: {api_str}\n\n"
        f"⏱ Аптайм: {uptime_str}"
    )


async def _telegram_periodic_status_loop() -> None:
    """Периодическая сводка в Telegram — в Qt запускалась с таймером после загрузки рынков."""
    while app_state.connected:
        try:
            await asyncio.sleep(get_telegram_status_interval_sec())
        except asyncio.CancelledError:
            raise
        if not app_state.connected:
            break
        token, chat_raw = get_telegram_config()
        if not token or not (chat_raw or "").strip():
            continue
        try:
            msg = _build_telegram_periodic_status_message()
            await send_telegram_notification(msg)
        except Exception:
            pass


def _compute_telegram_status_counts() -> tuple[int, int]:
    """Как _send_status_report / счётчики в async_v3 gui (счётчики preliminary vs выставлено)."""
    prelim = 0
    placed = 0
    ex = app_state.executor
    if not ex:
        return 0, 0
    for mid, mod in app_state.market_modules.items():
        if ex.is_collateral_cooldown(mid):
            continue
        state = mod.get_last_state()
        if not state:
            continue
        oi = state.get("order_info")
        if not oi:
            continue
        oi = _order_info_for_client(mid, oi)
        if oi.get("can_place_yes") and not ex.is_outcome_blocked(mid, "yes"):
            prelim += 1
        if oi.get("can_place_no") and not ex.is_outcome_blocked(mid, "no"):
            prelim += 1
        active = ex.get_active_orders(mid)
        if active.get("yes"):
            placed += 1
        if active.get("no"):
            placed += 1
    return prelim, placed


def _telegram_uptime_str() -> str:
    sec = max(0, int(time.time() - app_state.server_started_at))
    hours, remainder = divmod(sec, 3600)
    minutes, _ = divmod(remainder, 60)
    return f"{hours}h {minutes}m"


def _tg_autosell_escape(s: object, maxlen: int = 400) -> str:
    return html.escape(str(s)[:maxlen], quote=True)


async def _autosell_telegram_send_html(message: str) -> None:
    tok, chat_raw = get_telegram_config()
    if not tok or not (chat_raw or "").strip():
        return
    try:
        await send_telegram_notification(message)
    except Exception:
        pass


def _autosell_outcome_for_telegram(outcome: object) -> str:
    """Исход как в API/UI: Yes / No; иначе исходная строка (экранирование HTML)."""
    o = str(outcome or "").strip()
    if not o:
        return "—"
    low = o.lower()
    if low in ("yes", "y"):
        return "Yes"
    if low in ("no", "n"):
        return "No"
    return html.escape(o[:160], quote=True)


def _autosell_format_duration_ru(sec: float) -> str:
    """Коротко, без склонений «минут/минуты»."""
    if sec < 90:
        return f"{sec:.0f} с"
    if sec < 3600:
        return f"{sec / 60.0:.0f} мин."
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    if m == 0:
        return f"{h} ч"
    return f"{h} ч {m} мин."


def _telegram_msg_autosell_limit_placed(ctx: dict, limit_px: float) -> str:
    title = _tg_autosell_escape(ctx.get("title") or "—")
    oc = _autosell_outcome_for_telegram(ctx.get("oc_key"))
    shares = ctx.get("shares")
    try:
        n_sh = float(shares)
        shares_line = f"{n_sh:.4f} долей"
    except (TypeError, ValueError):
        shares_line = "—"
    cents = limit_px * 100.0
    return (
        f"🎯 <b>AutoSell: лимит на продажу выставлен</b>\n\n"
        f"📌 <b>Рынок:</b> {title}\n"
        f"🎯 <b>Исход:</b> {oc}\n\n"
        f"💰 <b>Цена в заявке:</b> ~{cents:.2f}¢ за одну долю\n"
        f"📦 <b>Количество:</b> {shares_line}"
    )


def _telegram_msg_autosell_filled(row: dict, sec_since_place: Optional[float]) -> str:
    title = _tg_autosell_escape(row.get("title") or "—")
    oc = _autosell_outcome_for_telegram(row.get("outcome"))
    lp_f = None
    try:
        if row.get("limit_price") is not None:
            lp_f = float(row["limit_price"])
    except (TypeError, ValueError):
        pass
    sh = None
    try:
        if row.get("shares") is not None:
            sh = float(row["shares"])
    except (TypeError, ValueError):
        pass
    lines = [
        f"✅ <b>AutoSell: лимитка исполнена</b>\n\n",
        f"📌 <b>Рынок:</b> {title}\n",
        f"🎯 <b>Исход:</b> {oc}\n",
    ]
    if lp_f is not None:
        lines.append(f"\n💰 <b>Цена по заявке:</b> ~{lp_f * 100:.2f}¢ за одну долю")
    if sh is not None:
        lines.append(f"\n📦 <b>Объём:</b> {sh:.4f} долей")
    if sec_since_place is not None and sec_since_place >= 0:
        human = _autosell_format_duration_ru(sec_since_place)
        lines.append(f"\n\n⏱ От выставления заявки до сделки прошло ~{human}.")
    return "".join(lines)


def serialize_settings(s: TokenSettings) -> dict:
    return s.to_dict()


def _all_export_market_ids_ordered() -> list[str]:
    """Объединяет id из сохранённого файла и из текущей сессии (как в async_v3 — поделиться списком и пресетами)."""
    saved = read_market_ids_from_saved_file(LAST_MARKETS_FILE)
    loaded = list(app_state.market_info.keys())
    seen: set[str] = set()
    out: list[str] = []
    for x in saved + loaded:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out


def _unique_id_list(ids: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for x in ids:
        s = (x or "").strip()
        if not s or s in seen:
            continue
        seen.add(s)
        out.append(s)
    return out


def parse_market_import_root(data: Any) -> Tuple[list[str], dict[str, dict]]:
    """Разбор JSON импорта: возвращает (market_ids, настройки по id, если есть в файле)."""
    settings_out: dict[str, dict] = {}
    raw_ids: list[str] = []

    def _consume_settings_key(mid: str, d: dict) -> None:
        sm = str(mid).strip()
        if not sm:
            return
        if sm not in raw_ids:
            raw_ids.append(sm)
        settings_out[sm] = d

    if isinstance(data, list):
        for item in data:
            if isinstance(item, str) and item.strip():
                raw_ids.append(item.strip())
            elif isinstance(item, dict):
                mid = item.get("market_id") or item.get("id") or item.get("marketId")
                if mid:
                    mid = str(mid).strip()
                    raw_ids.append(mid)
                    if "settings" in item and isinstance(item["settings"], dict):
                        settings_out[mid] = item["settings"]
                    else:
                        skip = {
                            "market_id",
                            "id",
                            "marketId",
                            "title",
                            "question",
                            "slug",
                            "imageUrl",
                            "status",
                            "categorySlug",
                            "isNegRisk",
                            "decimalPrecision",
                        }
                        inner = {k: v for k, v in item.items() if k not in skip}
                        if inner:
                            settings_out[mid] = inner
        return _unique_id_list(raw_ids), settings_out

    if not isinstance(data, dict):
        return [], {}

    known_top = {
        "version",
        "export_kind",
        "market_ids",
        "ids",
        "markets",
        "settings",
        "app",
        "include_settings",
        "apply_settings",
        "data",
    }
    if isinstance(data.get("settings"), dict):
        for mid, d in data["settings"].items():
            if isinstance(d, dict):
                _consume_settings_key(mid, d)

    for key in ("market_ids", "ids"):
        arr = data.get(key)
        if isinstance(arr, list):
            for x in arr:
                s = str(x).strip()
                if s:
                    raw_ids.append(s)

    markets_arr = data.get("markets")
    if isinstance(markets_arr, list):
        for item in markets_arr:
            if not isinstance(item, dict):
                continue
            mid = item.get("market_id") or item.get("id") or item.get("marketId")
            if not mid:
                continue
            mid = str(mid).strip()
            raw_ids.append(mid)
            if "settings" in item and isinstance(item["settings"], dict):
                settings_out[mid] = item["settings"]
            else:
                skip = {
                    "market_id",
                    "id",
                    "marketId",
                    "title",
                    "question",
                    "slug",
                    "imageUrl",
                    "status",
                    "categorySlug",
                    "isNegRisk",
                    "decimalPrecision",
                }
                inner = {k: v for k, v in item.items() if k not in skip}
                if inner:
                    settings_out[mid] = inner

    if not raw_ids and not settings_out:
        flat_ok = True
        for k, v in data.items():
            if k in known_top or not isinstance(v, dict):
                flat_ok = False
                break
        if flat_ok and data:
            for mid, d in data.items():
                if isinstance(d, dict):
                    _consume_settings_key(mid, d)

    return _unique_id_list(raw_ids), settings_out


def _teardown_market_session(market_id: str) -> None:
    app_state.liquidity_armed.discard(market_id)
    app_state._liquidity_volatile.pop(market_id, None)
    app_state._market_state_cache.pop(market_id, None)
    app_state.market_modules.pop(market_id, None)
    app_state.market_info.pop(market_id, None)
    app_state._points_reward_prev.pop(market_id, None)
    if app_state.ws_pool:
        app_state.ws_pool.unsubscribe_orderbook(market_id)
    elif app_state.ws_client_single:
        app_state.ws_client_single.unsubscribe_orderbook(market_id)
    if app_state.executor:
        app_state.executor.active_orders.pop(market_id, None)
    _liquidity_tick_locks.pop(market_id, None)
    if getattr(app_state, "autosell_market_cache", None):
        app_state.autosell_market_cache.pop(market_id, None)


async def _do_load_markets(market_ids: list[str]) -> dict:
    if not app_state.connected or not app_state.api_client:
        return {"success": False, "error": "Not connected"}
    try:
        diag_print("server", "load markets", f"загрузка {len(market_ids)} рынков; WS уже поднят — только subscribe новых")
        markets, skipped_ids = await load_markets(
            market_ids,
            app_state.api_client,
            log_func=lambda m: app_state.add_log(m, "info"),
            max_concurrent=get_market_load_max_concurrent(),
        )
        if skipped_ids:
            app_state.add_log(
                f"Не загружены (не REGISTERED), убраны из сохранённого списка: {', '.join(skipped_ids[:25])}"
                + (f" ... +{len(skipped_ids) - 25}" if len(skipped_ids) > 25 else ""),
                "info",
            )
        _ensure_websocket_started()
        for mid, info in markets.items():
            app_state.market_info[mid] = info
            mod = MarketModule(mid, info, app_state.settings_manager.get_settings, on_market_state_changed)
            app_state.market_modules[mid] = mod
            _sync_points_reward_prev_for_market(mid, info)
            if app_state.ws_pool:
                app_state.ws_pool.subscribe_orderbook(mid)
            elif app_state.ws_client_single:
                app_state.ws_client_single.subscribe_orderbook(mid)
        if market_ids:
            try:
                skip_set = set(skipped_ids)
                cleaned = [x.strip() for x in market_ids if x.strip() and x.strip() not in skip_set]
                merge_market_ids_into_saved_file(LAST_MARKETS_FILE, cleaned)
            except Exception:
                pass
        maybe_start_inspector_after_markets(len(markets))
        return {"success": True, "loaded": {mid: {"title": info.get("title", "")} for mid, info in markets.items()}, "count": len(markets)}
    except Exception as e:
        return {"success": False, "error": str(e)}


def serialize_order_info(oi):
    if oi is None:
        return None
    result = dict(oi)
    if "settings" in result and hasattr(result["settings"], "to_dict"):
        result["settings"] = result["settings"].to_dict()
    return result


def serialize_market_state(market_id: str):
    mod = app_state.market_modules.get(market_id)
    if not mod:
        return None
    state = mod.get_last_state()
    if not state:
        return None
    info = app_state.market_info.get(market_id, {})
    settings = app_state.settings_manager.get_settings(market_id) if app_state.settings_manager else None
    active_orders = app_state.executor.get_active_orders(market_id) if app_state.executor else {"yes": None, "no": None}
    order_info = _order_info_for_client(market_id, state.get("order_info"))
    orderbook = state.get("orderbook")
    collateral_cooldown = False
    outcome_blocked_yes = False
    outcome_blocked_no = False
    if app_state.executor:
        collateral_cooldown = app_state.executor.is_collateral_cooldown(market_id)
        outcome_blocked_yes = app_state.executor.is_outcome_blocked(market_id, "yes")
        outcome_blocked_no = app_state.executor.is_outcome_blocked(market_id, "no")
    return {
        "market_id": market_id,
        "title": info.get("title", ""),
        "question": info.get("question", ""),
        "slug": info.get("slug") or "",
        "categorySlug": info.get("categorySlug") or "",
        "status": info.get("status", ""),
        "decimalPrecision": info.get("decimalPrecision", 3),
        "imageUrl": info.get("imageUrl"),
        "order_info": serialize_order_info(order_info),
        "orderbook": orderbook,
        "settings": serialize_settings(settings) if settings else None,
        "settings_updated_at": app_state.settings_manager.get_settings_updated_at(market_id)
        if app_state.settings_manager
        else 0.0,
        "update_time": state.get("update_time"),
        "prev_orderbook_time": state.get("prev_orderbook_time"),
        "mid_price": state.get("mid_price"),
        "best_bid": state.get("best_bid"),
        "best_ask": state.get("best_ask"),
        "active_orders": active_orders,
        "collateral_cooldown": collateral_cooldown,
        "collateral_cooldown_until": (
            app_state.executor.get_collateral_cooldown_until_ts(market_id)
            if app_state.executor
            else None
        ),
        "outcome_blocked_yes": outcome_blocked_yes,
        "outcome_blocked_no": outcome_blocked_no,
        "liquidity_session_armed": market_id in app_state.liquidity_armed,
        "liquidity_volatile_in_cooldown": _is_liquidity_volatile_cooldown(market_id),
        "liquidity_volatile_cooldown_until": _liquidity_volatile_cooldown_until_ts(market_id),
        "rewards": info.get("rewards"),
    }


def _format_auto_cancel_reason(
    cancel_yes: bool,
    cancel_no: bool,
    order_info: dict,
    active_orders: dict,
) -> str:
    parts = []
    buy_yes = order_info.get("buy_yes") or {}
    buy_no = order_info.get("buy_no") or {}
    cur_yes = active_orders.get("yes")
    cur_no = active_orders.get("no")
    if cancel_yes:
        if cur_yes and not order_info.get("can_place_yes", True):
            parts.append("YES: нельзя выставить по калькулятору")
        elif cur_yes and buy_yes:
            parts.append(
                f"YES: цена {cur_yes.get('price', 0):.4f} → нужна {buy_yes.get('price', 0):.4f}"
            )
        else:
            parts.append("YES: отмена")
    if cancel_no:
        if cur_no and not order_info.get("can_place_no", True):
            parts.append("NO: нельзя выставить по калькулятору")
        elif cur_no and buy_no:
            parts.append(
                f"NO: цена {cur_no.get('price', 0):.4f} → нужна {buy_no.get('price', 0):.4f}"
            )
        else:
            parts.append("NO: отмена")
    return "; ".join(parts) if parts else "orderbook / preliminary"


def _schedule_auto_liquidity_tick(market_id: str) -> None:
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    loop.create_task(_auto_liquidity_on_orderbook_tick(market_id))


async def _auto_liquidity_on_orderbook_tick(market_id: str) -> None:
    ex = app_state.executor
    if not ex or not app_state.connected:
        return
    sm = app_state.settings_manager
    if not sm:
        return
    settings = sm.get_settings(market_id)
    if not settings or not getattr(settings, "enabled", False):
        return
    if market_id not in app_state.liquidity_armed:
        return
    mod = app_state.market_modules.get(market_id)
    if not mod:
        return
    if ex.is_market_liquidity_busy(market_id):
        return
    lock = _liquidity_tick_lock_for(market_id)
    async with lock:
        ex2 = app_state.executor
        if not ex2 or not app_state.connected:
            return
        if market_id not in app_state.liquidity_armed:
            return
        state = mod.get_last_state()
        if not state:
            return
        order_info = state.get("order_info")
        ob = state.get("orderbook")
        if not order_info or not ob:
            return
        active = ex2.get_active_orders(market_id)
        cy, cn = mod.should_cancel_and_replace(order_info, active, settings)
        info = app_state.market_info.get(market_id, {})
        title = (info.get("title") or info.get("question") or market_id)[:120]
        mid_yes = float(order_info.get("mid_price_yes") or 0.0)
        prev_t = state.get("prev_orderbook_time")
        curr_t = state.get("update_time")
        if cy or cn:
            reason = _format_auto_cancel_reason(cy, cn, order_info, active)
            app_state.add_log(
                f"Авто-ликвидность: отмена [{market_id[:16]}…] — {reason}",
                "info",
            )
            await ex2.enqueue_cancel(
                market_id,
                market_title=title,
                cancel_reason=reason,
                chain_replace=True,
            )
            return
        if not _liquidity_volatile_before_place(market_id):
            return
        await ex2.enqueue_place_orders(
            market_id,
            order_info,
            mid_yes,
            info,
            title,
            orderbook=ob,
            settings=settings,
            prev_orderbook_time=prev_t,
            curr_orderbook_time=curr_t,
        )


async def _after_cancel_try_place(market_id: str) -> None:
    ex = app_state.executor
    if not ex or not app_state.connected:
        return
    sm = app_state.settings_manager
    if not sm:
        return
    settings = sm.get_settings(market_id)
    if not settings or not getattr(settings, "enabled", False):
        return
    if market_id not in app_state.liquidity_armed:
        return
    mod = app_state.market_modules.get(market_id)
    if not mod:
        return
    lock = _liquidity_tick_lock_for(market_id)
    async with lock:
        ex2 = app_state.executor
        if not ex2 or not app_state.connected:
            return
        if market_id not in app_state.liquidity_armed:
            return
        state = mod.get_last_state()
        if not state:
            return
        ob = state.get("orderbook")
        if not ob:
            return
        order_info = state.get("order_info")
        if not order_info:
            return
        prev_t = state.get("prev_orderbook_time")
        curr_t = state.get("update_time")
        active = ex2.get_active_orders(market_id)
        cy, cn = mod.should_cancel_and_replace(order_info, active, settings)
        if cy or cn:
            return
        if not _liquidity_volatile_before_place(market_id):
            return
        info = app_state.market_info.get(market_id, {})
        title = (info.get("title") or info.get("question") or market_id)[:120]
        mid_yes = float(order_info.get("mid_price_yes") or 0.0)
        await ex2.enqueue_place_orders(
            market_id,
            order_info,
            mid_yes,
            info,
            title,
            orderbook=ob,
            settings=settings,
            prev_orderbook_time=prev_t,
            curr_orderbook_time=curr_t,
        )


def _on_cancel_done_chain_place(market_id: str) -> None:
    ex = app_state.executor
    if not ex:
        return
    if not ex._chain_place_after_cancel.pop(market_id, False):
        return
    try:
        asyncio.get_running_loop().create_task(_after_cancel_try_place(market_id))
    except RuntimeError:
        pass


def process_orderbook_for_market(market_id: str, orderbook: dict):
    mod = app_state.market_modules.get(market_id)
    if not mod:
        return
    def get_active_orders(mid):
        if app_state.executor:
            return app_state.executor.get_active_orders(mid)
        return {"yes": None, "no": None}
    try:
        order_info = mod.process_orderbook(orderbook, lambda: get_active_orders(market_id), emit_state=True)
    except Exception as e:
        app_state.add_log(f"Ошибка обработки стакана {market_id}: {e}", "error")
        return
    if order_info is None:
        return
    order_info = _order_info_for_client(market_id, order_info)
    if order_info is None:
        return
    mod.replace_order_info_and_emit(order_info)
    _schedule_auto_liquidity_tick(market_id)


def recalculate_market_state_from_last_orderbook(market_id: str) -> None:
    """Пересчитать order_info с последним стаканом (после смены настроек без нового WS тика)."""
    mod = app_state.market_modules.get(market_id)
    if not mod:
        return
    state = mod.get_last_state()
    if not state:
        return
    orderbook = state.get("orderbook")
    if orderbook:
        process_orderbook_for_market(market_id, orderbook)


def on_orderbook_update(market_id: str, orderbook: dict):
    app_state.ws_last_update = time.time()
    process_orderbook_for_market(market_id, orderbook)

def on_ws_connection_change(connected: bool):
    global _ws_aggregate_offline_task
    try:
        p = app_state.ws_pool
        if p:
            live = sum(1 for c in p.clients if c.connected)
            diag_print(
                "server",
                "on_ws_connection_change - агрегат по пулу",
                f"аргумент connected={connected} | живых TCP сейчас={live}/{len(p.clients)} | UI ws_connected обновляется с задержкой при 'все 0'",
            )
        else:
            sc = app_state.ws_client_single
            diag_print(
                "server",
                "on_ws_connection_change - одиночный клиент",
                f"connected={connected} | c.connected={getattr(sc, 'connected', None)}",
            )
    except Exception:
        pass

    loop = asyncio.get_running_loop()

    if connected:
        _cancel_ws_aggregate_offline()
        if not app_state.ws_connected:
            app_state.ws_connected = True
            _websocket_ui_log("WebSocket подключён", "info")
        return

    async def _delayed_offline() -> None:
        global _ws_aggregate_offline_task
        try:
            await asyncio.sleep(_WS_AGGREGATE_OFFLINE_SEC)
            p2 = app_state.ws_pool
            if p2:
                if sum(1 for c in p2.clients if c.connected) > 0:
                    return
            else:
                sc2 = app_state.ws_client_single
                if sc2 is not None and getattr(sc2, "connected", False):
                    return
            if app_state.ws_connected:
                app_state.ws_connected = False
                _websocket_ui_log("WebSocket отключён", "info")
        except asyncio.CancelledError:
            raise
        finally:
            _ws_aggregate_offline_task = None

    _cancel_ws_aggregate_offline()
    _ws_aggregate_offline_task = loop.create_task(_delayed_offline())


def _ensure_websocket_started() -> None:
    """
    Поднять WebSocket (пул или одиночный клиент), если есть подключённая сессия, а WS ещё не создан.
    Иначе при пустом last_market_ids.txt connect не создаёт ws_pool — добавление рынка не делает subscribe.
    """
    if app_state.ws_pool is not None or app_state.ws_client_single is not None:
        return
    if not app_state.connected or not app_state.current_account:
        return
    api_key = app_state.current_account.get("api_key")
    if not api_key:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = asyncio.get_event_loop()
    ws_settings = get_websocket_pool_settings()
    pool_size = ws_settings["pool_size"]
    diag_print(
        "server",
        "_ensure_websocket_started",
        f"создаю WS: pool_size={pool_size} (типично не было сохранённых рынков при connect)",
    )
    if pool_size > 1:
        app_state.ws_pool = WebSocketPool(
            api_key=api_key,
            on_orderbook_update=on_orderbook_update,
            on_heartbeat=None,
            on_connection_change=on_ws_connection_change,
            log_func=_websocket_ui_log,
            num_connections=pool_size,
            skip_first=ws_settings["skip_first"],
            dedupe_window=ws_settings["dedupe_identical_sec"],
            stagger_ms=ws_settings["stagger_ms"],
            slow_rebalance_sec=ws_settings["slow_slot_rebalance_sec"],
            slow_min_spread=ws_settings["slow_slot_min_spread"],
            slow_min_top=ws_settings["slow_slot_min_top"],
            slow_slots_per_rebalance=ws_settings["slow_slots_per_rebalance"],
            dedupe_depth_levels=ws_settings["dedupe_depth_levels"],
            pool_verbose=ws_settings["pool_verbose"],
            realtime_log=ws_settings["pool_realtime_log"],
        )
        if loop.is_running():
            app_state.ws_pool.start(loop)
        app_state.add_log("WebSocket pool запущен (отложенно — не было клиента при старте сессии)", "info")
    else:
        app_state.ws_client_single = WebSocketClient(
            api_key=api_key,
            on_orderbook_update=on_orderbook_update,
            on_connection_change=on_ws_connection_change,
            log_func=_websocket_ui_log,
        )
        if loop.is_running():
            app_state.ws_client_single.start(loop)
        app_state.add_log("WebSocket запущен (отложенно — не было клиента при старте сессии)", "info")


def on_balance_updated(address: str, balance: float, ts: float):
    """Обновление баланса с опроса; при заметном изменении — Telegram как в async_v3.
    Первое получение баланса с цепочки после подключения не уведомляем — только последующие изменения."""
    old = app_state.balance
    app_state.balance = balance
    app_state.balance_updated_at = ts
    if app_state._balance_change_suppress_first_telegram:
        app_state._balance_change_suppress_first_telegram = False
        return
    token, _ = get_telegram_config()
    if not token:
        return
    if abs(balance - old) <= 0.001:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return

    sign = "+" if balance - old > 0 else ""
    msg = (
        f"💰 <b>Баланс обновлён</b>\n"
        f"{sign}{balance - old:,.2f} USDT → ${balance:,.2f}"
    )

    async def _send():
        try:
            await send_telegram_notification(msg)
        except Exception:
            pass

    loop.create_task(_send())

def on_inspector_orders_count(total_open: int, autosell_open: int):
    app_state.inspector_orders_count = total_open
    app_state.inspector_autosell_open_count = max(0, int(autosell_open))
    app_state.inspector_orders_updated_at = time.time()

def on_market_state_changed(market_id: str, state: dict):
    app_state._market_state_cache[market_id] = state


def _inspector_orders_api_caption() -> str:
    n = int(getattr(app_state, "inspector_orders_count", 0) or 0)
    a = int(getattr(app_state, "inspector_autosell_open_count", 0) or 0)
    if a > 0:
        return f"{n} (+{a} AutoSell)"
    return str(n)


def _inspector_autosell_expected_ids() -> set:
    """ID лимиток AutoSell, которые инспектор не должен считать сиротами."""
    out: set = set()
    skip_status = {"filled", "cancelled", "expired", "invalidated", "error", "delay"}
    for row in app_state.autosell_tracked_sells or []:
        if not isinstance(row, dict):
            continue
        if row.get("status") in skip_status:
            continue
        oid = row.get("order_id")
        if oid:
            out.add(str(oid))
    return out


def _inspector_get_snapshot():
    liq_ids = app_state.executor.get_all_active_order_ids() if app_state.executor else set()
    auto_ids = _inspector_autosell_expected_ids()
    # JWT держит Executor после refresh; app_state.jwt_token обновляется в on_jwt_refreshed — иначе инспектор шлёт старый Bearer.
    jwt = None
    if app_state.executor:
        jwt = app_state.executor.jwt_token
    elif app_state.jwt_token:
        jwt = app_state.jwt_token
    return {
        "expected": liq_ids | auto_ids,
        "autosell_expected_ids": auto_ids,
        "managed": set(app_state.market_modules.keys()),
        "headers": get_auth_headers(jwt, app_state.current_account["api_key"]) if jwt and app_state.current_account else {},
        "proxy": app_state.current_account.get("proxy") if app_state.current_account else None,
        "api_key": app_state.current_account.get("api_key") if app_state.current_account else None,
    }


async def _inspector_refresh_jwt() -> bool:
    ex = app_state.executor
    if not ex:
        return False
    return await ex._refresh_jwt()


def attach_inspector() -> bool:
    if not app_state.connected or not app_state.executor:
        return False
    if app_state.inspector:
        return True
    app_state.inspector = Inspector(
        get_snapshot=_inspector_get_snapshot,
        on_orders_count=on_inspector_orders_count,
        log_func=lambda m: app_state.add_log(m, "info"),
        get_interval_sec=get_inspector_interval_sec,
        refresh_jwt=_inspector_refresh_jwt,
    )
    app_state.inspector.start()
    app_state.inspector_enabled = True
    return True


def maybe_start_inspector_after_markets(loaded_count: int) -> None:
    """После загрузки рынков сразу запускает инспектор, если он включён в app_state.json."""
    if loaded_count <= 0:
        return
    _maybe_start_predict_points_poll_task()
    if app_state.inspector:
        return
    try:
        with open(APP_STATE_FILE, "r", encoding="utf-8") as f:
            st = json.load(f)
        if not st.get("inspector_enabled", True):
            app_state.add_log("Inspector отключён в настройках — не запускаем", "info")
            return
    except Exception:
        pass
    if attach_inspector():
        app_state.add_log("Inspector запущен", "info")


@asynccontextmanager
async def lifespan(app: FastAPI):
    from config import _ensure_data_dir
    from uptime_stats import load_usage_stats, persist_interval

    _ensure_data_dir()
    stored_sec, trig_total = load_usage_stats()
    app_state.uptime_stored_sec = stored_sec
    app_state.autosell_triggers_lifetime = trig_total
    app_state.uptime_last_persist_at = time.time()

    async def _uptime_periodic_loop():
        while True:
            try:
                await asyncio.sleep(60)
                persist_interval(app_state)
            except asyncio.CancelledError:
                break
            except Exception:
                pass

    app_state._uptime_persist_task = asyncio.create_task(_uptime_periodic_loop())
    setup_logging()
    app_state.settings_manager = SettingsManager()
    diag_print("server", "FastAPI lifespan start", "логи [diag] идут в stdout → консоль main.py как [Server]; session log в data/logs")
    app_state.add_log("Сервер запущен", "info")
    yield
    app_state.add_log("Сервер остановлен", "info")
    t = getattr(app_state, "_uptime_persist_task", None)
    if t is not None and not t.done():
        t.cancel()
        try:
            await t
        except asyncio.CancelledError:
            pass
    app_state._uptime_persist_task = None
    try:
        persist_interval(app_state)
    except Exception:
        pass
    app_state.cleanup()

app = FastAPI(title="Predict Fun Liquidity Provider", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])


def _save_credentials(data: dict):
    try:
        with open(CREDENTIALS_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
    except Exception:
        pass


def _load_saved_credentials() -> dict:
    try:
        with open(CREDENTIALS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


async def _load_saved_markets():
    """Load markets from LAST_MARKETS_FILE after connect."""
    try:
        with open(LAST_MARKETS_FILE, "r", encoding="utf-8") as f:
            raw = f.read().strip()
        if not raw:
            _ensure_websocket_started()
            return
        # Совместимость с async_v3 (через запятую) и с новой записью (по строкам)
        market_ids = [x.strip() for x in re.split(r"[\n,]+", raw) if x.strip()]
        if not market_ids:
            _ensure_websocket_started()
            return
        total = len(market_ids)
        app_state.add_log(f"Auto-loading {total} saved markets...", "info")
        app_state.market_loading_progress = {"current": 0, "total": total, "loading": True}

        def on_progress(loaded, total_count):
            app_state.market_loading_progress = {"current": loaded, "total": total_count, "loading": True}

        markets, skipped_ids = await load_markets(
            market_ids,
            app_state.api_client,
            log_func=lambda m: app_state.add_log(m, "info"),
            on_progress=on_progress,
            max_concurrent=get_market_load_max_concurrent(),
        )
        if skipped_ids:
            n = remove_market_ids_from_saved_file(LAST_MARKETS_FILE, set(skipped_ids))
            if n:
                preview = ", ".join(skipped_ids[:20])
                more = f" (+{len(skipped_ids) - 20} ещё)" if len(skipped_ids) > 20 else ""
                app_state.add_log(
                    f"Удалено из сохранённого списка ({n}): не REGISTERED (RESOLVED и др.) — {preview}{more}",
                    "info",
                )
        loaded_mids = list(markets.keys())
        for mid, info in markets.items():
            app_state.market_info[mid] = info
            mod = MarketModule(mid, info, app_state.settings_manager.get_settings, on_market_state_changed)
            app_state.market_modules[mid] = mod
            _sync_points_reward_prev_for_market(mid, info)
        _ensure_websocket_started()
        for mid in loaded_mids:
            if app_state.ws_pool:
                app_state.ws_pool.subscribe_orderbook(mid)
            elif app_state.ws_client_single:
                app_state.ws_client_single.subscribe_orderbook(mid)
        diag_print(
            "server",
            "WebSocket",
            f"subscribe_orderbook для {len(loaded_mids)} рынков после автозагрузки",
        )
        app_state.market_loading_progress = {"current": len(markets), "total": total, "loading": False}
        app_state.add_log(f"Loaded {len(markets)} markets successfully", "info")
        maybe_start_inspector_after_markets(len(markets))
    except Exception as e:
        app_state.market_loading_progress = None
        app_state.add_log(f"Ошибка загрузки сохранённых рынков: {e}", "error")


@app.get("/api/credentials")
async def get_credentials():
    return _load_saved_credentials()


@app.get("/api/accounts")
async def get_accounts():
    from accounts import load_accounts_from_file
    accounts = load_accounts_from_file()
    return {"accounts": accounts}


@app.delete("/api/accounts/{index}")
async def delete_account(index: int):
    from accounts import load_accounts_from_file, save_accounts_to_file
    accounts = load_accounts_from_file()
    if 0 <= index < len(accounts):
        accounts.pop(index)
        save_accounts_to_file(accounts)
        return {"success": True}
    return {"success": False, "error": "Index out of range"}


@app.put("/api/accounts/{index}")
async def update_account(index: int, data: dict):
    from accounts import load_accounts_from_file, save_accounts_to_file
    accounts = load_accounts_from_file()
    if 0 <= index < len(accounts):
        accounts[index] = {
            "api_key": data.get("api_key", accounts[index].get("api_key", "")),
            "predict_account_address": data.get("predict_account_address", accounts[index].get("predict_account_address", "")),
            "privy_wallet_private_key": data.get("privy_wallet_private_key", accounts[index].get("privy_wallet_private_key", "")),
            "proxy": data.get("proxy"),
        }
        save_accounts_to_file(accounts)
        return {"success": True}
    return {"success": False, "error": "Index out of range"}


@app.get("/api/market-loading")
async def get_market_loading_progress():
    return app_state.market_loading_progress or {"current": 0, "total": 0, "loading": False}


@app.post("/api/auth/connect")
async def connect(req: ConnectRequest):
    try:
        diag_print("server", "POST /api/auth/connect", "cleanup(): гашу старые ws_pool/ws_client_single/executor")
        app_state.cleanup()
        app_state.settings_manager = SettingsManager()
        app_state.add_log("Аутентификация...", "info")
        jwt_token = await get_auth_jwt(
            req.api_key, req.predict_account_address,
            req.privy_wallet_private_key, req.proxy,
            log_func=lambda m: app_state.add_log(m, "info"),
        )
        if not jwt_token:
            return {"success": False, "error": "Аутентификация не удалась"}
        diag_print("server", "connect", "JWT получен → APIClient, Executor, BalanceUpdater; WebSocket поднимется в _load_saved_markets")
        api_client = APIClient(req.api_key, jwt_token, req.proxy)
        account_info = await api_client.get_account_info()
        if not account_info:
            return {"success": False, "error": "Cannot get account info"}
        balance = account_info.get("balance", 0)
        address = account_info.get("address") or account_info.get("walletAddress") or req.predict_account_address
        nick = extract_nickname_from_account_data(account_info)
        app_state.connected = True
        app_state.jwt_token = jwt_token
        app_state.api_client = api_client
        app_state.current_account = {
            "api_key": req.api_key,
            "predict_account_address": req.predict_account_address,
            "privy_wallet_private_key": req.privy_wallet_private_key,
            "proxy": req.proxy,
        }
        app_state.balance = balance
        app_state.balance_updated_at = time.time()
        app_state.executor = Executor(
            api_key=req.api_key, jwt_token=jwt_token,
            predict_account_address=req.predict_account_address,
            privy_wallet_private_key=req.privy_wallet_private_key,
            proxy=req.proxy, log_func=lambda m: app_state.add_log(m, "info"),
            api_client=api_client,
        )

        def _on_collateral_cooldown(mid: str):
            app_state.add_log(f"Рынок {mid} вошёл в cooldown коллатераля", "warning")

        def _executor_on_cancel_done(mid: str):
            _liquidity_volatile_on_cancel_done(mid)
            _on_cancel_done_chain_place(mid)

        app_state.executor.on_cancel_done = _executor_on_cancel_done
        app_state.executor.on_collateral_cooldown = _on_collateral_cooldown

        def _sync_jwt_from_executor(new_jwt: str) -> None:
            app_state.jwt_token = new_jwt

        app_state.executor.on_jwt_refreshed = _sync_jwt_from_executor

        async def _referral():
            try:
                ok = await api_client.set_referral("26F1B")
                if ok:
                    app_state.add_log("Братишка, ты успешно стал моим рефералом, спасибо!", "info")
                else:
                    app_state.add_log("Жалко, что ты не стал моим рефералом :(", "info")
            except Exception:
                pass

        asyncio.create_task(_referral())

        # Первый колбэк опроса USDT по цепочке — только синхронизация с уже показанным балансом из connect, без Telegram
        app_state._balance_change_suppress_first_telegram = True
        app_state.balance_updater = BalanceUpdater(
            get_balance_fn=lambda: api_client.get_usdt_balance(
                req.predict_account_address, req.privy_wallet_private_key
            ),
            on_updated=on_balance_updated,
            address=address,
            interval_sec=float(get_balance_poll_interval_sec()),
            interval_getter=get_balance_poll_interval_sec,
        )
        loop = asyncio.get_event_loop()
        if loop.is_running():
            app_state.balance_updater.start(loop)
        accounts = load_accounts_from_file()
        if not any(a["predict_account_address"] == req.predict_account_address for a in accounts):
            accounts.append(app_state.current_account)
            save_accounts_to_file(accounts)
        # Save credentials for auto-fill
        _save_credentials({
            "api_key": req.api_key,
            "predict_account_address": req.predict_account_address,
            "privy_wallet_private_key": req.privy_wallet_private_key,
            "proxy": req.proxy or "",
        })
        # Auto-load previously saved markets
        diag_print("server", "connect", "вызов _load_saved_markets() — загрузка рынков и старт WebSocket")
        await _load_saved_markets()
        if app_state._telegram_periodic_task and not app_state._telegram_periodic_task.done():
            try:
                app_state._telegram_periodic_task.cancel()
            except Exception:
                pass
        try:
            app_state._telegram_periodic_task = asyncio.create_task(_telegram_periodic_status_loop())
        except Exception:
            app_state._telegram_periodic_task = None
        await _start_autosell_poll_session_async()
        return {"success": True, "jwt_token": jwt_token, "account_info": {"address": address, "balance": balance, "nickname": nick}}
    except Exception as e:
        app_state.add_log(f"Ошибка подключения: {e}", "error")
        return {"success": False, "error": str(e)}

@app.post("/api/auth/disconnect")
async def disconnect():
    diag_print("server", "POST /api/auth/disconnect", "cleanup(): останавливаю WS и модули")
    app_state.cleanup()
    return {"success": True}


@app.get("/api/auth/status")
async def auth_status():
    """Сессия живёт на сервере; после F5 в Electron UI перезапрашивает и восстанавливает connected без повторного POST /connect."""
    return {
        "connected": bool(app_state.connected),
        "ws_connected": bool(getattr(app_state, "ws_connected", False)),
    }


@app.get("/api/stats")
async def get_server_stats():
    """Uptime сессии (процесс) и накопленный за всё время (data/uptime_stats.json)."""
    from uptime_stats import uptime_snapshot

    return uptime_snapshot(app_state)


@app.get("/api/autosell")
async def get_autosell_state():
    """Состояние вкладки AutoSell: позиции через периодический GET /v1/positions."""
    poll = float(get_autosell_poll_interval_sec())
    max_loss = float(get_autosell_max_loss_percent())
    ord_poll = float(get_autosell_order_status_interval_sec())
    delay_b = float(get_autosell_delay_before_sell_sec())
    oe = float(get_autosell_order_expiration_sec())
    aen = bool(get_autosell_enabled())
    if not app_state.connected:
        return {
            "connected": False,
            "autosell_enabled": aen,
            "poll_interval_sec": poll,
            "order_status_interval_sec": ord_poll,
            "max_loss_percent": max_loss,
            "delay_before_sell_sec": delay_b,
            "order_expiration_sec": oe,
            "tracked_sells": [],
            "positions": [],
            "positions_updated_at": 0.0,
            "positions_first_fetch_done": False,
            "positions_load_stage": "idle",
            "positions_enrich_progress": None,
        }
    if not aen:
        return {
            "connected": True,
            "autosell_enabled": False,
            "poll_interval_sec": poll,
            "order_status_interval_sec": ord_poll,
            "max_loss_percent": max_loss,
            "delay_before_sell_sec": delay_b,
            "order_expiration_sec": oe,
            "tracked_sells": [],
            "positions": [],
            "positions_updated_at": 0.0,
            "positions_first_fetch_done": True,
            "positions_load_stage": "idle",
            "positions_enrich_progress": None,
        }
    return {
        "connected": True,
        "autosell_enabled": True,
        "poll_interval_sec": float(app_state.autosell_poll_interval_sec),
        "order_status_interval_sec": float(app_state.autosell_order_status_interval_sec),
        "max_loss_percent": max_loss,
        "delay_before_sell_sec": float(get_autosell_delay_before_sell_sec()),
        "order_expiration_sec": float(get_autosell_order_expiration_sec()),
        "tracked_sells": list(app_state.autosell_tracked_sells),
        "positions": app_state.autosell_positions,
        "positions_updated_at": app_state.autosell_positions_updated_at,
        "positions_first_fetch_done": bool(app_state.autosell_positions_first_fetch_done),
        "positions_load_stage": app_state.autosell_positions_load_stage,
        "positions_enrich_progress": app_state.autosell_enrich_progress,
    }


@app.post("/api/autosell/settings")
async def autosell_set_settings(req: AutosellSettingsRequest):
    """Сохранить интервал опроса и/или макс. минус от AVG buy (autosell_settings.json)."""
    if not app_state.connected:
        return {"success": False, "error": "Not connected"}
    if req.enabled is not None:
        set_autosell_enabled(req.enabled)
    if req.interval_sec is not None:
        set_autosell_poll_interval_sec(req.interval_sec)
        app_state.autosell_poll_interval_sec = float(get_autosell_poll_interval_sec())
    if req.max_loss_percent is not None:
        set_autosell_max_loss_percent(req.max_loss_percent)
    if req.order_status_interval_sec is not None:
        set_autosell_order_status_interval_sec(req.order_status_interval_sec)
        app_state.autosell_order_status_interval_sec = float(get_autosell_order_status_interval_sec())
    if req.delay_before_sell_sec is not None:
        set_autosell_delay_before_sell_sec(req.delay_before_sell_sec)
        app_state.autosell_delay_before_sell_sec = float(get_autosell_delay_before_sell_sec())
    if req.order_expiration_sec is not None:
        set_autosell_order_expiration_sec(req.order_expiration_sec)
        app_state.autosell_order_expiration_sec = float(get_autosell_order_expiration_sec())
    if req.enabled is not None:
        await _start_autosell_poll_session_async()
    return {
        "success": True,
        "autosell_enabled": bool(get_autosell_enabled()),
        "poll_interval_sec": float(app_state.autosell_poll_interval_sec),
        "order_status_interval_sec": float(app_state.autosell_order_status_interval_sec),
        "max_loss_percent": float(get_autosell_max_loss_percent()),
        "delay_before_sell_sec": float(get_autosell_delay_before_sell_sec()),
        "order_expiration_sec": float(get_autosell_order_expiration_sec()),
    }


@app.post("/api/autosell/poll-interval")
async def autosell_set_poll_interval(req: AutosellPollIntervalRequest):
    if not app_state.connected:
        return {"success": False, "error": "Not connected"}
    set_autosell_poll_interval_sec(req.interval_sec)
    app_state.autosell_poll_interval_sec = float(get_autosell_poll_interval_sec())
    return {"success": True, "poll_interval_sec": app_state.autosell_poll_interval_sec}


@app.get("/api/account/info")
async def account_info():
    if not app_state.api_client:
        return {"error": "Not connected"}
    info = await app_state.api_client.get_account_info()
    if info:
        addr = info.get("address") or info.get("walletAddress") or ""
        return {
            "address": addr,
            "nickname": extract_nickname_from_account_data(info),
            "balance": info.get("balance", 0),
            "balance_updated_at": app_state.balance_updated_at,
        }
    return {"error": "Cannot fetch"}

@app.get("/api/account/balance")
async def account_balance():
    return {"balance": app_state.balance, "updated_at": app_state.balance_updated_at}

@app.post("/api/account/refresh-balance")
async def refresh_balance():
    if not app_state.api_client or not app_state.current_account:
        return {"success": False, "error": "Not connected"}
    acc = app_state.current_account

    def _read_bal():
        return app_state.api_client.get_usdt_balance(
            acc["predict_account_address"], acc["privy_wallet_private_key"]
        )

    bal = await asyncio.to_thread(_read_bal)
    if bal is not None:
        app_state.balance = bal
        app_state.balance_updated_at = time.time()
        return {"success": True, "balance": bal}
    return {"success": False, "error": "Cannot fetch balance"}


@app.post("/api/markets/load")
async def load_markets_endpoint(req: MarketLoadRequest):
    return await _do_load_markets(req.market_ids)


@app.get("/api/markets/export")
async def export_markets(include_settings: bool = Query(False)):
    sm = app_state.settings_manager
    ids = _all_export_market_ids_ordered()
    if include_settings and sm:
        markets: list[dict] = []
        for mid in ids:
            ts = sm.settings.get(mid)
            if ts is None:
                ts = TokenSettings(market_id=mid)
            markets.append(serialize_settings(ts))
        return {
            "version": 1,
            "app": "predict-fun-liquidity",
            "export_kind": "full",
            "market_ids": ids,
            "markets": markets,
        }
    return {
        "version": 1,
        "app": "predict-fun-liquidity",
        "export_kind": "ids_only",
        "market_ids": ids,
    }


@app.post("/api/markets/import")
async def import_markets_endpoint(req: MarketImportRequest):
    if not app_state.connected or not app_state.api_client:
        return {"success": False, "error": "Not connected"}
    ids, settings_map = parse_market_import_root(req.data)
    if not ids:
        return {"success": False, "error": "В файле не найдено ни одного market id"}

    sm = app_state.settings_manager
    if not sm:
        return {"success": False, "error": "Settings not available"}

    loaded = set(app_state.market_info.keys())
    to_load = [mid for mid in ids if mid not in loaded]
    skipped_existing = len(ids) - len(to_load)

    # «Только id»: не трогаем настройки из файла; подгружаем только те рынки, которых ещё нет (остальные пропускаем).
    if not req.apply_settings:
        if not to_load:
            app_state.add_log(
                f"Импорт (только id): все {len(ids)} id уже в списке загруженных — новых нет",
                "info",
            )
            return {
                "success": True,
                "count": 0,
                "loaded": {},
                "skipped_existing_count": skipped_existing,
                "message": "Все id из файла уже загружены",
            }
        res = await _do_load_markets(to_load)
        if isinstance(res, dict):
            res["skipped_existing_count"] = skipped_existing
        if res.get("success"):
            app_state.add_log(
                f"Импорт (только id): добавлено {res.get('count', 0)}, пропущено уже загруженных: {skipped_existing}",
                "info",
            )
        return res

    # «С настройками»: для уже загруженных id из файла — обновить token_settings; для новых — записать настройки до load, затем подгрузить.
    updated_existing_settings = 0
    applied_from_file = False
    for mid in ids:
        if mid not in settings_map:
            continue
        d = settings_map[mid]
        sm.settings[mid] = TokenSettings.from_dict({**d, "market_id": mid})
        sm.settings[mid].is_custom = True
        sm.settings[mid].settings_saved_at = time.time()
        applied_from_file = True
        if mid in loaded:
            recalculate_market_state_from_last_orderbook(mid)
            updated_existing_settings += 1

    if applied_from_file:
        sm.save_settings()
        app_state.add_log(
            f"Импорт (с настройками): обновлены настройки у {updated_existing_settings} уже загруженных рынков",
            "info",
        )
    elif not settings_map:
        app_state.add_log("Импорт (с настройками): в файле только список id — блоков настроек нет", "info")

    if not to_load:
        return {
            "success": True,
            "count": 0,
            "loaded": {},
            "skipped_existing_count": skipped_existing,
            "updated_existing_settings_count": updated_existing_settings,
            "message": "Новых id для загрузки нет; настройки по файлу применены к уже загруженным (если были в файле)",
        }

    res = await _do_load_markets(to_load)
    if isinstance(res, dict):
        res["skipped_existing_count"] = skipped_existing
        res["updated_existing_settings_count"] = updated_existing_settings
    if res.get("success"):
        app_state.add_log(f"Импорт: подгружено новых рынков: {res.get('count', 0)}", "info")
    return res


@app.post("/api/markets/remove-all")
async def remove_all_markets_endpoint(req: MarketRemoveAllRequest):
    mids = list(app_state.market_modules.keys())
    for mid in mids:
        _teardown_market_session(mid)
    try:
        with open(LAST_MARKETS_FILE, "w", encoding="utf-8") as f:
            f.write("")
    except Exception:
        pass
    removed_settings = 0
    if req.remove_settings and app_state.settings_manager and mids:
        removed_settings = app_state.settings_manager.remove_settings_for_market_ids(mids)
    if mids:
        app_state.add_log(
            f"Удалены все рынки ({len(mids)}); настройки в файле: {'очищены' if req.remove_settings else 'сохранены'}",
            "info",
        )
    return {"success": True, "removed_count": len(mids), "removed_settings_count": removed_settings}


@app.delete("/api/markets/{market_id}")
async def remove_market(market_id: str):
    _teardown_market_session(market_id)
    try:
        remove_market_ids_from_saved_file(LAST_MARKETS_FILE, {market_id})
    except Exception:
        pass
    return {"success": True}

@app.get("/api/markets")
async def list_markets():
    out = []
    for mid, info in app_state.market_info.items():
        out.append({
            "market_id": mid,
            "id": info.get("id", mid),
            "title": info.get("title", ""),
            "question": info.get("question", ""),
            "slug": info.get("slug", ""),
            "status": info.get("status", ""),
            "decimalPrecision": info.get("decimalPrecision", 3),
            "imageUrl": info.get("imageUrl"),
            "categorySlug": info.get("categorySlug"),
            "isNegRisk": info.get("isNegRisk", False),
        })
    return {"markets": out}

@app.get("/api/markets/state")
async def get_all_markets_state():
    result = {}
    for mid in app_state.market_modules:
        state = serialize_market_state(mid)
        if state:
            result[mid] = state
    return result

@app.get("/api/markets/{market_id}/state")
async def get_market_state(market_id: str):
    state = serialize_market_state(market_id)
    return state if state else {"error": "Not found"}

@app.post("/api/markets/category/{slug}")
async def fetch_category(slug: str):
    if not app_state.api_client:
        return {"error": "Not connected"}
    data = await app_state.api_client.get_category_by_slug(slug, log_func=lambda m: app_state.add_log(m, "info"))
    if data and "markets" in data:
        return {
            "title": data.get("title") or data.get("question") or "Категория",
            "imageUrl": data.get("imageUrl") or data.get("image_url"),
            "markets": data["markets"],
        }
    return {"error": "Cannot fetch category"}


@app.get("/api/settings")
async def get_all_settings():
    if not app_state.settings_manager:
        return {"settings": {}}
    return {"settings": {mid: serialize_settings(s) for mid, s in app_state.settings_manager.settings.items()}}


# ВАЖНО: статический путь /global должен быть ДО /{market_id}, иначе FastAPI матчит market_id="global" и массовое обновление не вызывается.
@app.put("/api/settings/global")
async def update_global_settings(req: GlobalSettingsUpdate):
    if not app_state.settings_manager:
        return {"success": False, "error": "Settings not available"}
    data = req.model_dump(exclude_unset=True)
    market_ids = data.pop("market_ids", [])
    count = 0
    sm = app_state.settings_manager
    for mid in market_ids:
        old_en = sm.get_settings(mid).enabled
        sm.update_settings(mid, **data)
        new_en = sm.get_settings(mid).enabled
        if old_en is False and new_en is True:
            app_state.liquidity_armed.add(mid)
        elif new_en is False:
            app_state.liquidity_armed.discard(mid)
        recalculate_market_state_from_last_orderbook(mid)
        count += 1
    return {"success": True, "updated_count": count}


@app.get("/api/settings/{market_id}")
async def get_market_settings(market_id: str):
    if not app_state.settings_manager:
        return {"error": "Settings not available"}
    return serialize_settings(app_state.settings_manager.get_settings(market_id))


@app.put("/api/settings/{market_id}")
async def update_market_settings(market_id: str, req: SettingsUpdate):
    if not app_state.settings_manager:
        return {"success": False, "error": "Settings not available"}
    sm = app_state.settings_manager
    old_en = sm.get_settings(market_id).enabled
    data = req.model_dump(exclude_unset=True)
    sm.update_settings(market_id, **data)
    new_en = sm.get_settings(market_id).enabled
    # В armed только при явном включении (false→true). Сохранение с enabled:true из файла не «включает слежение» само по себе.
    if old_en is False and new_en is True:
        app_state.liquidity_armed.add(market_id)
    elif new_en is False:
        app_state.liquidity_armed.discard(market_id)
    recalculate_market_state_from_last_orderbook(market_id)
    return {
        "success": True,
        "settings": serialize_settings(sm.get_settings(market_id)),
        "settings_updated_at": sm.get_settings_updated_at(market_id),
    }


@app.post("/api/liquidity/arm/{market_id}")
async def arm_liquidity_session(market_id: str):
    """Явное включение слежения за рынком (кнопка Place): не зависит от того, был ли enabled:true в settings.json."""
    if not app_state.settings_manager:
        return {"success": False, "error": "Settings not available"}
    sm = app_state.settings_manager
    app_state.liquidity_armed.add(market_id)
    sm.update_settings(market_id, enabled=True)
    recalculate_market_state_from_last_orderbook(market_id)
    return {
        "success": True,
        "settings": serialize_settings(sm.get_settings(market_id)),
        "settings_updated_at": sm.get_settings_updated_at(market_id),
    }


@app.post("/api/orders/place/{market_id}")
async def place_order(market_id: str, req: OrderPlaceRequest):
    if not app_state.executor:
        return {"success": False, "error": "Executor not initialized"}
    mod = app_state.market_modules.get(market_id)
    if not mod:
        return {"success": False, "error": "Рынок не загружен"}
    state = mod.get_last_state()
    raw_oi = (state or {}).get("order_info")
    oi = _order_info_for_client(market_id, raw_oi)
    v_err = app_state.executor.validate_manual_liquidity_place(market_id, req.outcome, oi)
    if v_err:
        return {"success": False, "error": v_err}
    market_info = app_state.market_info.get(market_id, {})
    try:
        result, err = await app_state.executor.place_order(
            market_id, req.outcome, req.price, req.shares, market_info, market_info.get("title", ""),
        )
        if result is None:
            return {"success": False, "error": err or "Ордер не создан"}
        return {"success": True, "order": result}
    except Exception as e:
        return {"success": False, "error": str(e)}

@app.post("/api/orders/cancel/{market_id}")
async def cancel_order(market_id: str, req: CancelRequest = None):
    if not app_state.executor:
        return {"success": False, "error": "Executor not initialized"}
    reason = req.cancel_reason if req else "manual"
    market_info = app_state.market_info.get(market_id, {})
    # Сначала снимаем слежение — иначе тик стакана успевает снова выставить (гонка с WS)
    app_state.liquidity_armed.discard(market_id)
    if app_state.settings_manager:
        app_state.settings_manager.update_settings(market_id, enabled=False)
    try:
        result = await app_state.executor.enqueue_cancel(market_id, market_info.get("title", ""), reason)
        return {"success": result}
    except Exception as e:
        return {"success": False, "error": str(e)}

@app.post("/api/orders/cancel-all")
async def cancel_all_orders():
    if not app_state.executor:
        return {"success": False, "error": "Executor not initialized"}
    sem = asyncio.Semaphore(get_orders_all_max_concurrent())
    mids = list(app_state.market_modules.keys())
    app_state.liquidity_armed.clear()
    if app_state.settings_manager:
        for mid in mids:
            app_state.settings_manager.update_settings(mid, enabled=False)

    async def _cancel_one(mid: str) -> int:
        async with sem:
            try:
                market_info = app_state.market_info.get(mid, {})
                await app_state.executor.enqueue_cancel(mid, market_info.get("title", ""), "cancel_all")
                return 1
            except Exception:
                return 0

    parts = await asyncio.gather(*(_cancel_one(mid) for mid in mids))
    count = sum(parts)
    return {"success": True, "cancelled_count": count}

@app.post("/api/orders/place-all")
async def place_all_orders():
    if not app_state.executor:
        return {"success": False, "error": "Executor not initialized"}
    sem = asyncio.Semaphore(get_orders_all_max_concurrent())
    work = []
    sm = app_state.settings_manager
    for mid, mod in app_state.market_modules.items():
        state = mod.get_last_state()
        if not state:
            continue
        order_info = state.get("order_info")
        if not order_info:
            continue
        if sm:
            sm.update_settings(mid, enabled=True)
        app_state.liquidity_armed.add(mid)
        settings = sm.get_settings(mid) if sm else None
        if not settings:
            continue
        market_info = app_state.market_info.get(mid, {})
        orderbook = state.get("orderbook")
        work.append((mid, order_info, state, market_info, orderbook, settings))

    async def _place_one(
        mid: str,
        order_info: dict,
        state: dict,
        market_info: dict,
        orderbook,
        settings,
    ) -> bool:
        async with sem:
            try:
                if not _liquidity_volatile_before_place(mid):
                    return False
                return await app_state.executor.enqueue_place_orders(
                    mid,
                    order_info,
                    state.get("mid_price", 0.5),
                    market_info,
                    market_info.get("title", ""),
                    orderbook,
                    settings,
                    state.get("prev_orderbook_time"),
                    state.get("update_time"),
                )
            except Exception:
                return False

    results = await asyncio.gather(
        *(
            _place_one(mid, oi, st, mi, ob, se)
            for mid, oi, st, mi, ob, se in work
        )
    )
    placed = sum(1 for r in results if r)
    return {"success": True, "placed_count": placed}

@app.get("/api/orders/active")
async def get_all_active_orders():
    if not app_state.executor:
        return {}
    return {mid: app_state.executor.get_active_orders(mid) for mid in app_state.market_modules}

@app.get("/api/orders/active/{market_id}")
async def get_market_active_orders(market_id: str):
    if not app_state.executor:
        return {"yes": None, "no": None}
    return app_state.executor.get_active_orders(market_id)

@app.get("/api/orders/api-count")
async def get_api_orders_count():
    return {
        "count": app_state.inspector_orders_count,
        "autosell_open": app_state.inspector_autosell_open_count,
        "updated_at": app_state.ws_last_update,
    }


@app.post("/api/inspector/enable")
async def enable_inspector():
    if not app_state.connected or not app_state.executor:
        return {"success": False, "error": "Not connected"}
    if app_state.inspector:
        return {"success": True, "already_enabled": True}
    if attach_inspector():
        return {"success": True}
    return {"success": False, "error": "Cannot start inspector"}

@app.post("/api/inspector/disable")
async def disable_inspector():
    if app_state.inspector:
        try:
            app_state.inspector.stop()
        except Exception:
            pass
        app_state.inspector = None
    app_state.inspector_enabled = False
    return {"success": True}

@app.get("/api/inspector/status")
async def inspector_status():
    return {
        "enabled": app_state.inspector_enabled,
        "orders_count": app_state.inspector_orders_count,
        "autosell_open": app_state.inspector_autosell_open_count,
        "updated_at": app_state.ws_last_update,
    }


@app.get("/api/ws/status")
async def ws_status():
    pool = app_state.ws_pool
    if pool:
        return {"connected": app_state.ws_connected, "pool_size": len(pool.clients), "live_slots": sum(1 for c in pool.clients if c.connected), "last_update": app_state.ws_last_update}
    return {"connected": app_state.ws_connected, "pool_size": 1, "live_slots": 1 if app_state.ws_connected else 0, "last_update": app_state.ws_last_update}


@app.get("/api/config")
async def get_config():
    ws_settings = get_websocket_pool_settings()
    log_settings = get_log_settings()
    telegram_token, telegram_chat_id = get_telegram_config()
    try:
        with open(APP_STATE_FILE, "r", encoding="utf-8") as f:
            app_state_data = json.load(f)
    except Exception:
        app_state_data = {}
    return {
        "websocket_pool_size": ws_settings["pool_size"],
        "websocket_dedupe_identical_sec": ws_settings["dedupe_identical_sec"],
        "websocket_connect_stagger_ms": ws_settings["stagger_ms"],
        "websocket_slow_slot_rebalance_sec": ws_settings["slow_slot_rebalance_sec"],
        "websocket_slow_slot_min_spread": ws_settings["slow_slot_min_spread"],
        "websocket_slow_slot_min_top": ws_settings["slow_slot_min_top"],
        "websocket_slow_slots_per_rebalance": ws_settings["slow_slots_per_rebalance"],
        "websocket_dedupe_depth_levels": ws_settings["dedupe_depth_levels"],
        "websocket_pool_verbose": ws_settings["pool_verbose"],
        "websocket_pool_realtime_log": ws_settings["pool_realtime_log"],
        "telegram_enabled": app_state_data.get("telegram_enabled", False),
        "telegram_token": telegram_token,
        "telegram_chat_id": telegram_chat_id,
        "telegram_status_interval_minutes": app_state_data.get("telegram_status_interval_minutes", 60),
        "insufficient_collateral_cooldown_sec": get_insufficient_collateral_cooldown_sec(),
        "balance_poll_interval_sec": get_balance_poll_interval_sec(),
        "inspector_interval_sec": get_inspector_interval_sec(),
        "log_software": log_settings["log_software"],
        "log_orderbook": log_settings["log_orderbook"],
        "log_orders": log_settings["log_orders"],
        "sort_mode": app_state_data.get("sort_mode", 0),
        "inspector_enabled": app_state_data.get("inspector_enabled", True),
        "console_diagnostics": app_state_data.get("console_diagnostics", DEFAULTS.get("console_diagnostics", True)),
        "orders_all_max_concurrent": get_orders_all_max_concurrent(),
        "market_load_max_concurrent": get_market_load_max_concurrent(),
        "predict_points_require_active_reward": get_predict_points_settings()["require_active_reward"],
        "predict_points_market_poll_sec": get_predict_points_settings()["market_poll_sec"],
    }

@app.put("/api/config")
async def update_config(req: GlobalConfigUpdate):
    try:
        with open(APP_STATE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        data = {}
    for k, v in req.model_dump(exclude_none=True).items():
        data[k] = v
    try:
        with open(APP_STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
    except Exception as e:
        return {"success": False, "error": str(e)}
    return {"success": True}


@app.post("/api/telegram/test")
async def telegram_test(req: TelegramTestRequest):
    ot = (req.telegram_token or "").strip()
    oc = (req.telegram_chat_id or "").strip()
    if ot and oc:
        token, chat_raw = ot, oc
    else:
        token, chat_raw = get_telegram_config()

    chat = normalize_telegram_chat_id(chat_raw)
    if not (token and chat is not None):
        return {
            "success": False,
            "error": "Укажите Bot Token и Chat ID в настройках (или сохраните их) и повторите тест.",
        }

    mode = (req.mode or "summary").strip().lower()
    if mode not in ("summary", "balance"):
        mode = "summary"

    balance = float(app_state.balance)
    n_markets = len(app_state.market_modules)

    if mode == "summary":
        now_str = datetime.now().strftime("%H:%M:%S")
        balance_str = f"${balance:,.2f}"
        prelim, placed = _compute_telegram_status_counts()
        api_str = _inspector_orders_api_caption()
        uptime_str = _telegram_uptime_str()
        # Демо-статистика для примера (не реальные метрики биржи)
        seed = int(time.time() // 120) % 10000
        demo_volume = round(120.0 + (seed % 80) + (n_markets * 3.5), 2)
        demo_latency = 28 + (seed % 45)
        demo_ws_hint = max(0, n_markets * 12 + (seed % 200))
        msg = (
            f"🧪 <b>Тест</b>\n"
            f"📊 <b>Сводка</b> ({now_str})\n\n"
            f"💰 Баланс: {balance_str}\n"
            f"📈 Рынков в работе: {n_markets}\n"
            f"📍 Можно выставить: {prelim}\n"
            f"✅ Выставлено: {placed}\n"
            f"📋 API ордеров: {api_str}\n"
            f"⏱ Аптайм сервера: {uptime_str}\n\n"
            f"<i>Пример статистики (демо):</i>\n"
            f"• Оценка событий WS за сессию: ~{demo_ws_hint}\n"
            f"• Оборот лимиток (пример): {demo_volume} USDT\n"
            f"• Задержка API (пример): {demo_latency} мс"
        )
    else:
        balance_str = f"${balance:,.2f}"
        seed = int(time.time() // 60) % 5000
        demo_delta = round(4.5 + (seed % 120) / 10.0, 2)
        msg = (
            f"🧪 <b>Тест</b>\n"
            f"💰 <b>Баланс</b>\n\n"
            f"Текущий: {balance_str}\n\n"
            f"<i>Пример «изменения» (демо, не фактическое движение средств):</i>\n"
            f"+{demo_delta} USDT"
        )

    ok, err_tg = await send_telegram_with_credentials(token, chat, msg)
    if ok:
        return {"success": True}
    return {"success": False, "error": err_tg or "Не удалось отправить"}


@app.get("/api/logs")
async def get_logs(since: float = 0):
    return {"logs": app_state.get_logs_since(since)}


@app.post("/api/logs/clear")
async def clear_logs():
    app_state.clear_logs()
    return {"success": True}


def _sse_state_interval_sec() -> float:
    """Баланс: актуальные данные в UI и нагрузка при сотнях рынков."""
    n = len(app_state.market_modules)
    if n <= 40:
        return 0.4
    if n <= 120:
        return 0.7
    if n <= 250:
        return 1.1
    return 1.6


@app.get("/api/events")
async def events():
    async def event_stream():
        last_log_ts = time.time()
        last_state_ts = time.time()
        while True:
            new_logs = app_state.get_logs_since(last_log_ts)
            if new_logs:
                last_log_ts = max(m["timestamp"] for m in new_logs)
                for log in new_logs:
                    yield f"event: log\ndata: {json.dumps(log, ensure_ascii=False)}\n\n"
            now = time.time()
            state_iv = _sse_state_interval_sec()
            if now - last_state_ts >= state_iv:
                last_state_ts = now
                states = {}
                for mid in app_state.market_modules:
                    state = serialize_market_state(mid)
                    if state:
                        states[mid] = state
                if states:
                    yield f"event: state\ndata: {json.dumps(states, ensure_ascii=False)}\n\n"
            status = {
                "connected": app_state.connected,
                "ws_connected": app_state.ws_connected,
                "balance": app_state.balance,
                "balance_updated_at": app_state.balance_updated_at,
                "inspector_orders_count": app_state.inspector_orders_count,
                "inspector_autosell_open_count": app_state.inspector_autosell_open_count,
                "inspector_orders_updated_at": app_state.inspector_orders_updated_at,
                "inspector_enabled": app_state.inspector_enabled,
                "ws_last_update": app_state.ws_last_update,
                "market_loading_progress": app_state.market_loading_progress,
            }
            yield f"event: status\ndata: {json.dumps(status)}\n\n"
            await asyncio.sleep(0.25)
    return StreamingResponse(event_stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"})


def main():
    import uvicorn
    setup_logging()
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="warning")

if __name__ == "__main__":
    main()
