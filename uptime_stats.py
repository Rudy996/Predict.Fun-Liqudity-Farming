"""Накопительная статистика в data/uptime_stats.json (uptime + счётчики AutoSell)."""

from __future__ import annotations

import json
import os
import threading
import time
from typing import Any

from config import UPTIME_STATS_FILE, _ensure_data_dir

_lock = threading.Lock()


def load_usage_stats() -> tuple[float, int]:
    """stored_sec, autosell_triggers_total (успешные лимитки SELL)."""
    try:
        with open(UPTIME_STATS_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
        sec = float(d.get("stored_sec", 0) or 0)
        trig = int(d.get("autosell_triggers_total", 0) or 0)
        return sec, max(0, trig)
    except Exception:
        return 0.0, 0


def _write_file(app_state: Any) -> None:
    _ensure_data_dir()
    payload = {
        "stored_sec": float(app_state.uptime_stored_sec),
        "autosell_triggers_total": int(getattr(app_state, "autosell_triggers_lifetime", 0) or 0),
    }
    tmp = UPTIME_STATS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    os.replace(tmp, UPTIME_STATS_FILE)


def persist_interval(app_state: Any) -> None:
    """Добавить прошедшее время с последнего сохранения в stored_sec и записать файл."""
    now = time.time()
    with _lock:
        delta = max(0.0, now - app_state.uptime_last_persist_at)
        app_state.uptime_stored_sec += delta
        app_state.uptime_last_persist_at = now
        _write_file(app_state)


def bump_autosell_limit_placed(app_state: Any) -> None:
    """Успешное выставление лимитной продажи AutoSell (сессия + всё время, запись на диск)."""
    with _lock:
        app_state.autosell_triggers_session = int(getattr(app_state, "autosell_triggers_session", 0) or 0) + 1
        app_state.autosell_triggers_lifetime = int(getattr(app_state, "autosell_triggers_lifetime", 0) or 0) + 1
        _write_file(app_state)


def uptime_snapshot(app_state: Any) -> dict[str, int]:
    """session — с запуска процесса; lifetime — из файла + хвост uptime; счётчики AutoSell."""
    now = time.time()
    with _lock:
        stored = float(app_state.uptime_stored_sec)
        last = float(app_state.uptime_last_persist_at)
        lifetime_sec = stored + max(0.0, now - last)
    session_sec = max(0.0, now - float(app_state.server_started_at))
    return {
        "session_uptime_sec": int(session_sec),
        "lifetime_uptime_sec": int(lifetime_sec),
        "autosell_triggers_session": int(getattr(app_state, "autosell_triggers_session", 0) or 0),
        "autosell_triggers_lifetime": int(getattr(app_state, "autosell_triggers_lifetime", 0) or 0),
    }
