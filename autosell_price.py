"""Цена лимитной продажи AutoSell: сетка по decimalPrecision, «не хуже» запланированного дисконта."""

from __future__ import annotations

import math
import re
from typing import Any, Optional, Tuple

W18 = 10**18


def _parse_floatish(raw: Any) -> Optional[float]:
    if raw is None:
        return None
    if isinstance(raw, (int, float)) and math.isfinite(float(raw)):
        x = float(raw)
        if abs(x) < 1e12:
            return x
    s = str(raw).strip()
    if not s or s.lower() == "null":
        return None
    try:
        if re.match(r"^-?\d+$", s.replace("-", "", 1)):
            bi = int(s)
            if abs(bi) >= 10**12:
                return float(bi) / W18
            return float(bi)
        return float(s.replace(",", "."))
    except (ValueError, OverflowError):
        return None


def parse_avg_buy_price_0_1(position: dict) -> Optional[float]:
    """Средняя цена входа в доле 0…1 (как YES-цена)."""
    keys = (
        "averageBuyPriceUsd",
        "averageBuyPrice",
        "averagePrice",
        "avgBuyPrice",
        "avgPrice",
        "averageBuyPricePerShare",
    )
    for k in keys:
        if k in position:
            v = _parse_floatish(position.get(k))
            if v is not None and v > 0:
                if v > 1.0 and v < 1e15:
                    return v / W18
                if 0 < v <= 1.0:
                    return v
    m = position.get("market")
    if isinstance(m, dict):
        for k in keys:
            if k in m:
                v = _parse_floatish(m.get(k))
                if v is not None and v > 0:
                    if v > 1.0 and v < 1e15:
                        return v / W18
                    if 0 < v <= 1.0:
                        return v
    return None


def parse_position_shares(position: dict) -> Optional[float]:
    raw = position.get("amount") or position.get("shares") or position.get("size") or position.get("quantity")
    v = _parse_floatish(raw)
    if v is None or v <= 0:
        return None
    if v >= 1e9:
        return v / W18
    return v


def _decimal_places(decimal_precision: int) -> int:
    d = int(decimal_precision)
    if d <= 2:
        return 2
    return min(3, max(1, d))


def ceil_price_to_tick(price: float, decimal_precision: int) -> float:
    """
    Округление вверх по сетке тика (меньший убыток, чем строго по полу):
    цена лимитной продажи не ниже идеальной, если идеал не попал на сетку.
    """
    d = _decimal_places(decimal_precision)
    step = 10 ** (-d)
    if price <= 0:
        return step
    x = math.ceil(price / step - 1e-15) * step
    x = min(0.999, max(step, x))
    return round(x, d)


def compute_sell_price_and_effective_loss(
    avg_buy: float,
    max_loss_percent: float,
    decimal_precision: int,
) -> Tuple[float, float]:
    """
    Цель: avg * (1 - p/100). На сетке — ceil к тику (не продавать дешевле запланированного «пола»).
    Возвращает (limit_price_0_1, effective_loss_percent положительное число).
    """
    p = max(0.1, min(95.0, float(max_loss_percent)))
    if avg_buy <= 0 or avg_buy > 1.0:
        raise ValueError("avg_buy must be in (0, 1]")
    ideal = avg_buy * (1.0 - p / 100.0)
    ideal = max(0.001, min(0.999, ideal))
    limit_px = ceil_price_to_tick(ideal, decimal_precision)
    if limit_px <= 0:
        limit_px = ceil_price_to_tick(avg_buy * 0.5, decimal_precision)
    eff = (1.0 - limit_px / avg_buy) * 100.0
    return limit_px, eff


def outcome_to_side_key(outcome: Any) -> str:
    if outcome is None:
        return "yes"
    if isinstance(outcome, dict):
        name = (outcome.get("name") or outcome.get("label") or "").strip().lower()
    else:
        name = str(outcome).strip().lower()
    if name in ("no", "n"):
        return "no"
    return "yes"


def position_notional_usd(avg_buy_01: float, shares: float) -> float:
    """Оценка стоимости позиции в USDC: цена доли 0…1 × shares."""
    return max(0.0, float(avg_buy_01) * float(shares))


def _scalar_to_price_01(raw: Any) -> Optional[float]:
    v = _parse_floatish(raw)
    if v is None or v <= 0:
        return None
    if v > 1.0 and v < 1e15:
        return v / W18
    if 0 < v <= 1.0:
        return v
    return None


def parse_filled_amount_from_order(od: dict) -> Optional[float]:
    raw = (
        od.get("amountFilled")
        or od.get("amount_filled")
        or od.get("filledAmount")
        or od.get("filled")
        or od.get("filledSize")
        or od.get("cumFilled")
        or od.get("executedAmount")
    )
    return parse_position_shares({"amount": raw}) if raw is not None else None


def parse_avg_execution_price_01_from_order(od: dict) -> Optional[float]:
    """Средняя цена исполнения (доля 0…1), если API отдаёт отдельно от лимита."""
    for k in (
        "priceExecuted",
        "averageExecutionPrice",
        "averageFillPrice",
        "avgExecutionPrice",
        "averageExecutedPrice",
        "weightedAveragePrice",
        "filledAveragePrice",
        "executionPrice",
        "avgFillPrice",
    ):
        if k in od:
            p = _scalar_to_price_01(od.get(k))
            if p is not None:
                return p
    ex = od.get("execution")
    if isinstance(ex, dict):
        for k in ("priceExecuted", "averagePrice", "averageExecutionPrice", "price", "fillPrice"):
            if k in ex:
                p = _scalar_to_price_01(ex.get(k))
                if p is not None:
                    return p
    return None


def infer_sell_avg_price_01_from_contract_amounts(view: dict) -> Optional[float]:
    """
    Средняя цена продажи (доля 0…1) из полей on-chain ордера в GET /v1/orders/{hash} (data.order):
    для SELL (side=1) фактическая цена ≈ takerAmount/makerAmount в wei (см. ответ API).
    Не подставляет лимит — только факт из тела ордера.
    """
    if not isinstance(view, dict):
        return None
    ma = view.get("makerAmount") or view.get("maker_amount")
    ta = view.get("takerAmount") or view.get("taker_amount")
    if ma is None or ta is None:
        return None
    try:
        m_i = int(str(ma).strip())
        t_i = int(str(ta).strip())
    except (ValueError, OverflowError):
        return None
    if m_i <= 0:
        return None
    raw_side = view.get("side")
    try:
        s = int(raw_side) if raw_side is not None else 1
    except (TypeError, ValueError):
        s = 1
    if s != 1:
        return None
    r = t_i / m_i
    if not (math.isfinite(r) and r > 0):
        return None
    if r > 1.0 + 1e-9:
        return None
    return float(min(0.999999, max(r, 1e-12)))


def merge_predict_order_dict(od: dict) -> dict:
    """Сливает вложенные data/order/details/execution с корнем — вложенные перекрывают корень (актуальный статус)."""
    out = dict(od)
    for key in ("data", "order", "details", "result", "execution"):
        sub = od.get(key)
        if isinstance(sub, dict):
            out.update(sub)
            inner = sub.get("order")
            if isinstance(inner, dict):
                out.update(inner)
    return out


def parse_total_order_amount_shares(view: dict, fallback_shares: Optional[float] = None) -> Optional[float]:
    """Полный объём ордера в shares (для сравнения с amountFilled)."""
    for k in ("amount", "size", "totalAmount", "originalAmount", "quantity", "totalSize", "orderAmount", "total"):
        if k in view:
            v = parse_position_shares({"amount": view.get(k)})
            if v is not None and v > 0:
                return v
    return fallback_shares


# GET /v1/orders/{hash} → success.data.status (OpenAPI dev.predict.fun/get-order-by-hash):
# OPEN | FILLED | EXPIRED | CANCELLED | INVALIDATED — все пять ниже.
# Дополнительно: CLOSED / PARTIALLY_FILLED / CANCELED — на случай ответов списков или расширений API.
PREDICT_REST_ORDER_STATUS_TO_INTERNAL: dict[str, str] = {
    "OPEN": "open",
    "FILLED": "filled",
    "EXPIRED": "expired",
    "CANCELLED": "cancelled",
    "INVALIDATED": "invalidated",
    "CLOSED": "filled",
    "PARTIALLY_FILLED": "partially_filled",
    "CANCELED": "cancelled",
}


def map_predict_rest_order_status_token(raw: Any) -> Optional[str]:
    """Только токены из PREDICT_REST_ORDER_STATUS_TO_INTERNAL; иначе None (не угадываем синонимы)."""
    if raw is None:
        return None
    s = str(raw).strip().upper().replace(" ", "_").replace("-", "_")
    if not s:
        return None
    return PREDICT_REST_ORDER_STATUS_TO_INTERNAL.get(s)


def predict_rest_order_status_from_view(view: dict) -> Optional[str]:
    """Берёт status / orderStatus / state из ответа GET /v1/orders (см. dev.predict.fun)."""
    if view.get("fullyFilled") is True:
        return "filled"
    for key in ("status", "orderStatus", "state", "lifecycleStatus", "fillStatus"):
        v = view.get(key)
        if v is None:
            continue
        mapped = map_predict_rest_order_status_token(v)
        if mapped is not None:
            return mapped
    ex = view.get("execution")
    if isinstance(ex, dict):
        for key in ("status", "orderStatus", "state"):
            v = ex.get(key)
            if v is None:
                continue
            mapped = map_predict_rest_order_status_token(v)
            if mapped is not None:
                return mapped
    return None


def infer_filled_by_rest_amounts(
    amount_filled: Optional[float],
    total_amount: Optional[float],
) -> bool:
    """Полное исполнение по полям ответа API: amountFilled >= amount."""
    if amount_filled is None or total_amount is None:
        return False
    if total_amount <= 0:
        return False
    return amount_filled >= total_amount * 0.999


def infer_partial_by_rest_amounts(
    amount_filled: Optional[float],
    total_amount: Optional[float],
) -> bool:
    """Частичное исполнение: 0 < amountFilled < amount."""
    if amount_filled is None or total_amount is None:
        return False
    if total_amount <= 0:
        return False
    return 0 < amount_filled < total_amount * 0.999


def infer_filled_by_amount_strings_wei(view: dict) -> bool:
    """
    Predict API отдаёт amount / amountFilled как строки целых wei (см. OpenAPI dev.predict.fun).
    Сравнение float может ломаться; здесь сравниваем целые значения.
    """
    raw_af = view.get("amountFilled")
    raw_am = view.get("amount")
    if raw_af is None or raw_am is None:
        return False
    sa, sm = str(raw_af).strip(), str(raw_am).strip()
    if not sa.isdigit() or not sm.isdigit():
        return False
    try:
        a_i, m_i = int(sa), int(sm)
    except (ValueError, OverflowError):
        return False
    if m_i <= 0:
        return False
    return a_i * 1000 >= m_i * 999


def infer_partial_by_amount_strings_wei(view: dict) -> bool:
    raw_af = view.get("amountFilled")
    raw_am = view.get("amount")
    if raw_af is None or raw_am is None:
        return False
    sa, sm = str(raw_af).strip(), str(raw_am).strip()
    if not sa.isdigit() or not sm.isdigit():
        return False
    try:
        a_i, m_i = int(sa), int(sm)
    except (ValueError, OverflowError):
        return False
    if m_i <= 0:
        return False
    return 0 < a_i * 1000 < m_i * 999


def compute_fill_pnl_usd(
    avg_buy_01: float,
    filled_shares: float,
    avg_exec_01: float,
) -> Tuple[float, float, float]:
    """
    Проданная часть: себестоимость по AVG входа, выручка, PnL = выручка − себестоимость.
    Отрицательный PnL — убыток относительно входа по проданным шерам.
    """
    c = float(avg_buy_01) * float(filled_shares)
    pr = float(avg_exec_01) * float(filled_shares)
    return c, pr, pr - c
