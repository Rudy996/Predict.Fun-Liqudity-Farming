"""Orderbook history saving"""

import os
import json
from datetime import datetime
from config import MARKET_HISTORY_DIR


def save_orderbook(mid: str, ob: dict) -> None:
    try:
        from config import get_log_settings
        if not get_log_settings().get("log_orderbook", False):
            return
    except Exception:
        pass
    try:
        os.makedirs(MARKET_HISTORY_DIR, exist_ok=True)
        path = os.path.join(MARKET_HISTORY_DIR, f"{mid}.txt")
        record = {
            "received_at": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
            "market_id": mid,
            "orderbook": ob,
        }
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception:
        pass
