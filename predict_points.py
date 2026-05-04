"""Predict Points: активное окно награды по полю market.rewards (REST API)."""

from __future__ import annotations

import datetime
from typing import Any, Dict


def _parse_api_datetime(s: Any):
    if s is None:
        return None
    s = str(s).strip()
    if not s:
        return None
    s = s.replace("Z", "+00:00")
    try:
        return datetime.datetime.fromisoformat(s)
    except ValueError:
        return None


def market_info_has_active_predict_points(info: Dict) -> bool:
    """
    True если сейчас есть активная почасовая награда (rewards.current в интервале,
    hourlyRate > 0). Сравнение по UTC.
    """
    if not info or not isinstance(info, dict):
        return False
    rewards = info.get("rewards") or {}
    cur = rewards.get("current")
    if not cur or not isinstance(cur, dict):
        return False
    try:
        rate = float(cur.get("hourlyRate", 0))
    except (TypeError, ValueError):
        return False
    if rate <= 0:
        return False
    ts = _parse_api_datetime(cur.get("startsAt"))
    te = _parse_api_datetime(cur.get("endsAt"))
    if ts is None or te is None:
        return False
    now = datetime.datetime.now(datetime.timezone.utc)
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=datetime.timezone.utc)
    if te.tzinfo is None:
        te = te.replace(tzinfo=datetime.timezone.utc)
    return ts <= now < te
