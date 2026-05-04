"""Predict Fun Liquidity Provider configuration"""

import os
import json
import re

# API
API_BASE_URL = "https://api.predict.fun"

# Data directory — all user data stored here, never in code
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(SCRIPT_DIR, "data")

def _ensure_data_dir():
    """Create data directory and default files if they don't exist."""
    os.makedirs(DATA_DIR, exist_ok=True)
    # Ensure all data files exist with safe defaults
    _ensure_file(ACCOUNTS_FILE, "[]")
    _ensure_file(SETTINGS_FILE, "{}")
    _ensure_file(LAST_MARKETS_FILE, "")
    _ensure_file(APP_STATE_FILE, "{}")
    _ensure_file(CREDENTIALS_FILE, "{}")
    _ensure_file(AUTOSELL_SETTINGS_FILE, '{"poll_interval_sec": 5}')
    _ensure_file(UPTIME_STATS_FILE, '{"stored_sec":0,"autosell_triggers_total":0}')
    os.makedirs(MARKET_HISTORY_DIR, exist_ok=True)
    os.makedirs(LOGS_DIR, exist_ok=True)
    _merge_default_logging_into_app_state_if_missing()


def _merge_default_logging_into_app_state_if_missing() -> None:
    """Если в app_state нет ключей — для нового пользователя Logging и Realtime Log выключены (false). Уже записанные значения не меняем."""
    try:
        with open(APP_STATE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        data = {}
    if not isinstance(data, dict):
        data = {}
    keys_defaults = (
        ("log_software", False),
        ("log_orderbook", False),
        ("log_orders", False),
        ("websocket_pool_realtime_log", False),
    )
    changed = False
    for k, v in keys_defaults:
        if k not in data:
            data[k] = v
            changed = True
    if changed:
        try:
            with open(APP_STATE_FILE, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
        except Exception:
            pass

def _ensure_file(path: str, default: str):
    if not os.path.exists(path):
        with open(path, "w", encoding="utf-8") as f:
            f.write(default)

# Files — all inside data/
ACCOUNTS_FILE = os.path.join(DATA_DIR, "accounts.txt")
SETTINGS_FILE = os.path.join(DATA_DIR, "token_settings.json")
LAST_MARKETS_FILE = os.path.join(DATA_DIR, "last_market_ids.txt")
MARKET_HISTORY_DIR = os.path.join(DATA_DIR, "market")
APP_STATE_FILE = os.path.join(DATA_DIR, "app_state.json")
CREDENTIALS_FILE = os.path.join(DATA_DIR, "credentials.json")
AUTOSELL_SETTINGS_FILE = os.path.join(DATA_DIR, "autosell_settings.json")
UPTIME_STATS_FILE = os.path.join(DATA_DIR, "uptime_stats.json")
LOGS_DIR = os.path.join(DATA_DIR, "logs")

# Лимитка: поле order.expiration (unix sec) в POST /v1/orders. Если «жизнь» от now слишком мала,
# API Predict отвечает create_order_expiry_too_soon (см. ContractOrder в OpenAPI).
AUTOSELL_MIN_ORDER_EXPIRATION_SEC = 120
AUTOSELL_MAX_ORDER_EXPIRATION_SEC = 2592000

# Default settings
DEFAULTS = {
    "position_size_usdt": 100.0,
    "position_size_shares": None,
    "min_spread": 0.2,
    # Автоподдержка ликвидности по стакану только после явного «Place» / включения в настройках
    "enabled": False,
    "target_liquidity": 1000.0,
    "max_auto_spread": 6.0,
    "liquidity_mode": "bid",
    "volatile_reposition_limit": 0,
    "volatile_window_seconds": 60,
    "volatile_cooldown_seconds": 3600,
    # Не переставлять из‑за мелкого расхождения preliminary vs ордер (дробление стакана, гонки тиков)
    "reposition_min_price_delta": 0.01,
    "websocket_pool_size": 20,
    "websocket_dedupe_identical_sec": 0.04,
    "websocket_connect_stagger_ms": 80,
    "websocket_slow_slot_rebalance_sec": 120,
    "websocket_slow_slot_min_spread": 10,
    "websocket_slow_slot_min_top": 24,
    "websocket_slow_slots_per_rebalance": 5,
    "websocket_dedupe_depth_levels": 64,
    "websocket_pool_verbose": False,
    "websocket_pool_realtime_log": False,
    "console_diagnostics": True,
    "insufficient_collateral_cooldown_sec": 1800,
    # Интервал опроса USDT-баланса на сервере (сек), как в async_v3 ~30 с
    "balance_poll_interval_sec": 30,
    "inspector_interval_sec": 5,
    "telegram_status_interval_minutes": 60,
    # Place All / Cancel All: одновременно не больше N рынков
    "orders_all_max_concurrent": 20,
    # Парсинг/загрузка рынков по API после коннекта и Add Market
    "market_load_max_concurrent": 10,
    "predict_points_require_active_reward": True,
    "predict_points_market_poll_sec": 600,
}

DEBUG_MODULES = False
DEBUG_LIQUIDITY_CALC = False

# ВРЕМЕННО: не показывать в логе приложения (UI) сообщения о WebSocket — пул, слоты, connect/disconnect.
# Включить обратно: True.
WEBSOCKET_UI_LOGS_ENABLED = False


def websocket_ui_logs_enabled() -> bool:
    return bool(WEBSOCKET_UI_LOGS_ENABLED)


def _read_app_state() -> dict:
    try:
        import json
        with open(APP_STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def get_telegram_config() -> tuple[str, str]:
    state = _read_app_state()
    if not state.get("telegram_enabled", True):
        return ("", "")
    return (
        state.get("telegram_token") or os.environ.get("TELEGRAM_TOKEN", ""),
        state.get("telegram_chat_id") or os.environ.get("TELEGRAM_CHAT_ID", ""),
    )


def get_telegram_status_interval_sec() -> int:
    state = _read_app_state()
    mins = state.get("telegram_status_interval_minutes")
    if mins is not None:
        return max(60, min(86400, int(mins) * 60))
    return 3600


def get_autosell_poll_interval_sec() -> float:
    """Интервал опроса GET /v1/positions для вкладки AutoSell (сек), 1…86400."""
    _ensure_data_dir()
    try:
        with open(AUTOSELL_SETTINGS_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
        v = float(d.get("poll_interval_sec", 5))
    except Exception:
        v = 5.0
    return max(1.0, min(86400.0, v))


def set_autosell_poll_interval_sec(sec: float) -> None:
    _ensure_data_dir()
    v = max(1.0, min(86400.0, float(sec)))
    try:
        with open(AUTOSELL_SETTINGS_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
    except Exception:
        d = {}
    d["poll_interval_sec"] = v
    with open(AUTOSELL_SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(d, f, indent=2)


def get_autosell_enabled() -> bool:
    """Главный выключатель AutoSell (autosell_settings.json). Без ключа — True (поведение как до опции)."""
    _ensure_data_dir()
    try:
        with open(AUTOSELL_SETTINGS_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
        if "enabled" not in d:
            return True
        return bool(d.get("enabled"))
    except Exception:
        return True


def set_autosell_enabled(enabled: bool) -> None:
    _ensure_data_dir()
    try:
        with open(AUTOSELL_SETTINGS_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
    except Exception:
        d = {}
    d["enabled"] = bool(enabled)
    with open(AUTOSELL_SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(d, f, indent=2)


def get_autosell_max_loss_percent() -> float:
    """Макс. дисконт от средней покупки для лимитной продажи AutoSell (%%), 0.1…95."""
    _ensure_data_dir()
    try:
        with open(AUTOSELL_SETTINGS_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
        v = float(d.get("max_loss_percent", 15))
    except Exception:
        v = 15.0
    return max(0.1, min(95.0, v))


def set_autosell_max_loss_percent(pct: float) -> None:
    _ensure_data_dir()
    v = max(0.1, min(95.0, float(pct)))
    try:
        with open(AUTOSELL_SETTINGS_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
    except Exception:
        d = {}
    d["max_loss_percent"] = v
    with open(AUTOSELL_SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(d, f, indent=2)


def get_autosell_order_status_interval_sec() -> float:
    """Интервал опроса GET /v1/orders (hash ордера) для карточек автопродажи (сек), 1…300."""
    _ensure_data_dir()
    try:
        with open(AUTOSELL_SETTINGS_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
        v = float(d.get("order_status_interval_sec", 3))
    except Exception:
        v = 3.0
    return max(1.0, min(300.0, v))


def set_autosell_order_status_interval_sec(sec: float) -> None:
    _ensure_data_dir()
    v = max(1.0, min(300.0, float(sec)))
    try:
        with open(AUTOSELL_SETTINGS_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
    except Exception:
        d = {}
    d["order_status_interval_sec"] = v
    with open(AUTOSELL_SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(d, f, indent=2)


def get_autosell_delay_before_sell_sec() -> float:
    """Пауза перед выставлением лимитной продажи (сек). 0 = без паузы."""
    _ensure_data_dir()
    try:
        with open(AUTOSELL_SETTINGS_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
        v = float(d.get("delay_before_sell_sec", 0))
    except Exception:
        v = 0.0
    return max(0.0, min(86400.0, v))


def set_autosell_delay_before_sell_sec(sec: float) -> None:
    _ensure_data_dir()
    v = max(0.0, min(86400.0, float(sec)))
    try:
        with open(AUTOSELL_SETTINGS_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
    except Exception:
        d = {}
    d["delay_before_sell_sec"] = v
    with open(AUTOSELL_SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(d, f, indent=2)


def normalize_autosell_order_expiration_sec(sec: float) -> float:
    """0 — без кастомного срока (SDK по умолчанию). Иначе не ниже минимума API."""
    v = max(0.0, min(float(AUTOSELL_MAX_ORDER_EXPIRATION_SEC), float(sec)))
    if 0 < v < float(AUTOSELL_MIN_ORDER_EXPIRATION_SEC):
        return float(AUTOSELL_MIN_ORDER_EXPIRATION_SEC)
    return v


def get_autosell_order_expiration_sec() -> float:
    """Срок жизни лимитного ордера (сек) в подписи. 0 = по умолчанию SDK (долгий срок)."""
    _ensure_data_dir()
    try:
        with open(AUTOSELL_SETTINGS_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
        v = float(d.get("order_expiration_sec", 0))
    except Exception:
        v = 0.0
    return normalize_autosell_order_expiration_sec(v)


def set_autosell_order_expiration_sec(sec: float) -> None:
    _ensure_data_dir()
    v = normalize_autosell_order_expiration_sec(sec)
    try:
        with open(AUTOSELL_SETTINGS_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
    except Exception:
        d = {}
    d["order_expiration_sec"] = v
    with open(AUTOSELL_SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(d, f, indent=2)


def get_balance_poll_interval_sec() -> int:
    """Интервал между опросами get_usdt_balance (сек). По умолчанию 30, как в async_v3."""
    state = _read_app_state()
    v = state.get("balance_poll_interval_sec")
    if v is not None:
        return max(1, min(600, int(v)))
    return int(DEFAULTS.get("balance_poll_interval_sec", 30))


def get_inspector_interval_sec() -> float:
    """Пауза между циклами инспектора ордеров (сек). Читается из app_state.json при каждом цикле."""
    state = _read_app_state()
    try:
        v = float(state.get("inspector_interval_sec", DEFAULTS.get("inspector_interval_sec", 5)))
    except (TypeError, ValueError):
        v = 5.0
    return max(1.0, min(300.0, v))


def get_log_settings() -> dict:
    state = _read_app_state()
    return {
        "log_software": bool(state.get("log_software", False)),
        "log_orderbook": bool(state.get("log_orderbook", False)),
        "log_orders": bool(state.get("log_orders", False)),
    }


def get_orders_all_max_concurrent() -> int:
    """Одновременных выставлений/отмен по разным рынкам (семафор в server)."""
    state = _read_app_state()
    d = int(DEFAULTS["orders_all_max_concurrent"])
    try:
        v = int(state.get("orders_all_max_concurrent", d))
    except (TypeError, ValueError):
        v = d
    return max(1, min(100, v))


def get_market_load_max_concurrent() -> int:
    """Одновременных запросов get_market_info при загрузке списка рынков."""
    state = _read_app_state()
    d = int(DEFAULTS["market_load_max_concurrent"])
    try:
        v = int(state.get("market_load_max_concurrent", d))
    except (TypeError, ValueError):
        v = d
    return max(1, min(100, v))


def get_predict_points_settings() -> dict:
    """Гейт ликвидности и фоновый опрос GET /v1/markets/{id} для актуального rewards."""
    state = _read_app_state()
    req = state.get("predict_points_require_active_reward", DEFAULTS["predict_points_require_active_reward"])
    if not isinstance(req, bool):
        req = bool(req)
    d = int(DEFAULTS["predict_points_market_poll_sec"])
    try:
        poll = int(state.get("predict_points_market_poll_sec", d))
    except (TypeError, ValueError):
        poll = d
    # 0 — не опрашивать (только данные с последней загрузки рынка)
    poll = max(0, min(7200, poll))
    return {"require_active_reward": req, "market_poll_sec": poll}


def get_console_diagnostics() -> bool:
    """Подробные строки [diag] в консоль (main.py → [Server]). Выкл: env PREDICT_FUN_VERBOSE_CONSOLE=0 или console_diagnostics:false в app_state.json."""
    env = os.environ.get("PREDICT_FUN_VERBOSE_CONSOLE", "").strip().lower()
    if env in ("0", "false", "no", "off"):
        return False
    if env in ("1", "true", "yes", "on"):
        return True
    state = _read_app_state()
    return bool(state.get("console_diagnostics", DEFAULTS["console_diagnostics"]))


def get_insufficient_collateral_cooldown_sec() -> int:
    state = _read_app_state()
    v = state.get("insufficient_collateral_cooldown_sec")
    if v is not None:
        return max(60, min(86400, int(v)))
    return DEFAULTS["insufficient_collateral_cooldown_sec"]


def get_websocket_pool_settings() -> dict:
    state = _read_app_state()
    n = max(1, min(32, int(state.get("websocket_pool_size", DEFAULTS["websocket_pool_size"]))))
    dedupe = max(0.0, min(0.5, float(state.get("websocket_dedupe_identical_sec", DEFAULTS["websocket_dedupe_identical_sec"]))))
    # Первый тик стакана на слоте 0 никогда не отбрасываем (раньше было в настройках).
    skip = False
    stag = max(0.0, min(2000.0, float(state.get("websocket_connect_stagger_ms", DEFAULTS["websocket_connect_stagger_ms"]))))
    rebal = max(0.0, min(600.0, float(state.get("websocket_slow_slot_rebalance_sec", DEFAULTS["websocket_slow_slot_rebalance_sec"]))))
    spread = max(1, min(500, int(state.get("websocket_slow_slot_min_spread", DEFAULTS["websocket_slow_slot_min_spread"]))))
    top_min = max(1, min(10_000, int(state.get("websocket_slow_slot_min_top", DEFAULTS["websocket_slow_slot_min_top"]))))
    # Сколько самых медленных слотов заменять за один цикл ребаланса.
    # Капим половиной пула, чтобы не выкинуть сразу слишком многих и не упереться в 429.
    per_rebal_default = int(DEFAULTS["websocket_slow_slots_per_rebalance"])
    per_rebal = max(1, min(max(1, n // 2), int(state.get("websocket_slow_slots_per_rebalance", per_rebal_default))))
    # Глубина уровней в fingerprint для дедупа/ранжирования слотов.
    dedupe_depth = max(1, min(64, int(state.get("websocket_dedupe_depth_levels", DEFAULTS["websocket_dedupe_depth_levels"]))))
    pv = state.get("websocket_pool_verbose", DEFAULTS["websocket_pool_verbose"])
    if not isinstance(pv, bool):
        pv = bool(pv)
    rt = state.get("websocket_pool_realtime_log", DEFAULTS["websocket_pool_realtime_log"])
    if not isinstance(rt, bool):
        rt = bool(rt)
    return {
        "pool_size": n,
        "skip_first": skip,
        "dedupe_identical_sec": dedupe,
        "stagger_ms": stag,
        "slow_slot_rebalance_sec": rebal,
        "slow_slot_min_spread": spread,
        "slow_slot_min_top": top_min,
        "slow_slots_per_rebalance": per_rebal,
        "dedupe_depth_levels": dedupe_depth,
        "pool_verbose": pv,
        "pool_realtime_log": rt,
    }


_IPV4 = re.compile(r"^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$")


def _looks_ipv4(s: str) -> bool:
    m = _IPV4.match(s.strip())
    if not m:
        return False
    try:
        return all(0 <= int(x) <= 255 for x in m.groups())
    except ValueError:
        return False


def _port_token(s: str) -> bool:
    return s.isdigit() and 1 <= int(s) <= 65535


def normalize_proxy_input(proxy_string) -> str | None:
    """
    Приводит ввод прокси к одному URL для HTTP(S)/SOCKS.
    Поддерживает: host:port, user:pass@host:port, http(s)://..., socks5://...,
    а также частые варианты ip:port:user:pass и user:pass:host:port.
    """
    if proxy_string is None:
        return None
    if isinstance(proxy_string, dict):
        return None
    if not isinstance(proxy_string, str):
        proxy_string = str(proxy_string)
    s = proxy_string.strip()
    if not s:
        return None
    for zw in ("\u200b", "\u200c", "\u200d", "\ufeff"):
        s = s.replace(zw, "")
    s = s.strip()
    if "\n" in s or "\r" in s:
        s = s.replace("\r\n", "\n").replace("\r", "\n")
        for line in s.split("\n"):
            t = line.strip()
            if t:
                s = t
                break
        else:
            return None
    s = s.strip()
    if not s:
        return None

    # socks5 host:port / socks4 host:port (без ://)
    m_alt = re.match(r"^(socks5h?|socks4a?|socks)\s+(.+)$", s, re.I)
    if m_alt:
        kind = m_alt.group(1).lower()
        if kind == "socks":
            kind = "socks5"
        rest = m_alt.group(2).strip()
        return f"{kind}://{rest}"

    low = s.lower()
    known = (
        "http://",
        "https://",
        "socks5://",
        "socks4://",
        "socks5h://",
        "socks4a://",
        "socks://",
    )
    if any(low.startswith(p) for p in known):
        return s

    # Уже есть user@host — только добавить схему
    if "@" in s and "://" not in s:
        return f"http://{s}"

    parts = s.split(":")
    # ip:port:user:pass
    if len(parts) >= 4 and _looks_ipv4(parts[0]) and _port_token(parts[1]):
        ip, port = parts[0], parts[1]
        user = parts[2]
        password = ":".join(parts[3:])
        return f"http://{user}:{password}@{ip}:{port}"

    # user:pass:host:port — host может быть IPv4, localhost или домен
    if len(parts) == 4 and _port_token(parts[3]):
        user, pwd, host, port = parts[0], parts[1], parts[2], parts[3]
        if _looks_ipv4(host) or host == "localhost" or "." in host:
            return f"http://{user}:{pwd}@{host}:{port}"

    # host:port или user:pass@host:port — префикс http://
    if "://" not in s:
        return f"http://{s}"
    return s


def format_proxy(proxy_string) -> dict | None:
    if not proxy_string:
        return None
    if isinstance(proxy_string, dict):
        return proxy_string
    if isinstance(proxy_string, str):
        normalized = normalize_proxy_input(proxy_string)
        if not normalized:
            return None
        return {"http": normalized, "https": normalized}
    return None


def format_proxy_for_aiohttp(proxy_string) -> str | None:
    if not proxy_string:
        return None
    if isinstance(proxy_string, str):
        return normalize_proxy_input(proxy_string)
    return None
