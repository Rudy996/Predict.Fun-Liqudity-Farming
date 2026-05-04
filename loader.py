"""Market loading by ID"""

import asyncio
import os
import re
import urllib.request
from typing import Dict, List, Optional, Tuple

from api import APIClient

STATUS_REGISTERED = "REGISTERED"


def remove_market_ids_from_saved_file(file_path: str, remove_ids: set[str]) -> int:
    """Удаляет ID из last_market_ids.txt (запятая или перевод строки). Возвращает число удалённых записей."""
    if not remove_ids:
        return 0
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            raw = f.read().strip()
    except Exception:
        return 0
    if not raw:
        return 0
    ids = [x.strip() for x in re.split(r"[\n,]+", raw) if x.strip()]
    before = len(ids)
    new_ids = [x for x in ids if x not in remove_ids]
    if len(new_ids) == before:
        return 0
    try:
        d = os.path.dirname(os.path.abspath(file_path))
        if d:
            os.makedirs(d, exist_ok=True)
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(",".join(new_ids))
    except Exception:
        return 0
    return before - len(new_ids)


def read_market_ids_from_saved_file(file_path: str) -> List[str]:
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            raw = f.read().strip()
    except Exception:
        return []
    if not raw:
        return []
    return [x.strip() for x in re.split(r"[\n,]+", raw) if x.strip()]


def write_market_ids_to_saved_file(file_path: str, ids: List[str]) -> None:
    d = os.path.dirname(os.path.abspath(file_path))
    if d:
        os.makedirs(d, exist_ok=True)
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(",".join(ids))


def merge_market_ids_into_saved_file(file_path: str, new_ids: List[str]) -> None:
    """Добавляет новые id к сохранённому списку, порядок: сначала уже сохранённые, затем новые, без дубликатов."""
    existing = read_market_ids_from_saved_file(file_path)
    seen: set[str] = set()
    merged: List[str] = []
    for x in existing + new_ids:
        s = (x or "").strip()
        if not s or s in seen:
            continue
        seen.add(s)
        merged.append(s)
    write_market_ids_to_saved_file(file_path, merged)


def _fetch_image_bytes(url: str) -> Optional[bytes]:
    if not url or not url.strip():
        return None
    full_url = url.strip()
    if not full_url.startswith("http"):
        full_url = "https://api.predict.fun" + (full_url if full_url.startswith("/") else "/" + full_url)
    urls_to_try = [full_url]
    if "." not in full_url.split("/")[-1]:
        urls_to_try.extend([full_url + ".png", full_url + ".webp", full_url + ".jpg"])
    for u in urls_to_try:
        try:
            req = urllib.request.Request(u, headers={"User-Agent": "PredictFun-Liquidity/1.0"})
            with urllib.request.urlopen(req, timeout=3) as resp:
                data = resp.read()
            if data and len(data) > 100:
                return data
        except Exception:
            continue
    return None


async def load_markets(
    market_ids: List[str],
    api_client: APIClient,
    log_func=print,
    on_progress=None,
    max_concurrent: int = 10,
) -> Tuple[Dict[str, dict], List[str]]:
    valid_ids = [m.strip() for m in market_ids if m.strip()]
    total = len(valid_ids)
    n = max(1, min(100, int(max_concurrent)))
    sem = asyncio.Semaphore(n)

    async def fetch_one(mid: str):
        async with sem:
            try:
                info = await api_client.get_market_info(mid, log_func)
                if info:
                    img_url = info.get("imageUrl") or info.get("image_url")
                    if img_url:
                        try:
                            img_data = await asyncio.to_thread(_fetch_image_bytes, img_url)
                            if img_data:
                                info = {**info, "_image_data": img_data}
                        except Exception:
                            pass
                return mid, info
            except Exception:
                return mid, None

    tasks = [asyncio.create_task(fetch_one(mid)) for mid in valid_ids]
    markets: Dict[str, dict] = {}
    skipped_not_registered: List[str] = []
    for i, fut in enumerate(asyncio.as_completed(tasks), 1):
        mid, info = await fut
        from logger import debug_module
        debug_module("Loader", f"loaded market_id={mid}", {
            "status": info.get("status") if info else None,
            "title": (info.get("title") or "")[:40] if info else None,
        })
        if info:
            status = (info.get("status") or "").strip().upper()
            if status == STATUS_REGISTERED:
                markets[mid] = info
                title = info.get("title") or info.get("question") or mid
                log_func(f"Loaded market {mid}: {str(title)[:50]}...")
            else:
                log_func(f"Market {mid} skipped: status={status or 'unknown'}")
                skipped_not_registered.append(mid)
        if on_progress:
            try:
                on_progress(i, total)
            except Exception:
                pass
    return markets, skipped_not_registered
