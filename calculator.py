"""Liquidity and limit order calculator"""

from typing import Dict, Optional
from settings import TokenSettings

MIN_ORDER_VALUE_USD = 1.0
MIN_ORDER_PRICE = 0.001


class Calculator:
    @staticmethod
    def calculate_liquidity_before_price(
        orderbook: Dict, our_price: float, outcome: str = "yes",
        our_active_order: Optional[Dict] = None
    ) -> float:
        try:
            bids = orderbook.get("bids", [])
            asks = orderbook.get("asks", [])
            if not bids or not asks:
                return 0.0
            total_liquidity = 0.0
            if outcome.lower() == "yes":
                for price, shares in bids:
                    if price > our_price:
                        total_liquidity += float(price) * float(shares)
                    else:
                        break
            elif outcome.lower() == "no":
                for yes_price, shares in asks:
                    no_price = 1.0 - float(yes_price)
                    if no_price > our_price:
                        total_liquidity += no_price * float(shares)
                    else:
                        break
            if our_active_order:
                op, os_ = our_active_order.get("price", 0), our_active_order.get("shares", 0)
                if outcome.lower() in ("yes", "no") and op > our_price:
                    total_liquidity -= op * os_
            return max(0.0, total_liquidity)
        except Exception:
            return 0.0

    @staticmethod
    def calculate_liquidity_by_asks(
        orderbook: Dict, our_price: float, outcome: str = "yes",
        our_active_order: Optional[Dict] = None
    ) -> float:
        try:
            bids = orderbook.get("bids", [])
            asks = orderbook.get("asks", [])
            if not bids or not asks:
                return 0.0
            total_liquidity = 0.0
            eps = 1e-9
            if outcome.lower() == "yes":
                for price, shares in bids:
                    p, s = float(price), float(shares)
                    if p <= our_price + eps:
                        break
                    total_liquidity += (1.0 - p) * s
            elif outcome.lower() == "no":
                for yes_price, shares in asks:
                    no_price = 1.0 - float(yes_price)
                    if no_price <= our_price + eps:
                        break
                    total_liquidity += float(yes_price) * float(shares)
            if our_active_order:
                op, os_ = our_active_order.get("price", 0), our_active_order.get("shares", 0)
                if outcome.lower() in ("yes", "no") and op > our_price:
                    total_liquidity -= (1.0 - op) * os_
            return max(0.0, total_liquidity)
        except Exception:
            return 0.0

    @staticmethod
    def round_price_by_precision(price: float, decimal_precision: int) -> float:
        return round(price, 2 if decimal_precision == 2 else 3)

    @staticmethod
    def round_shares_to_tenths(shares: float, price: float) -> float:
        shares_rounded = round(shares, 1)
        while shares_rounded * price < MIN_ORDER_VALUE_USD:
            shares_rounded += 0.1
        return shares_rounded

    @staticmethod
    def adjust_to_min_order_value(shares: float, price: float) -> float:
        if price <= 0:
            return max(shares, MIN_ORDER_VALUE_USD / MIN_ORDER_PRICE)
        if shares * price < MIN_ORDER_VALUE_USD:
            return MIN_ORDER_VALUE_USD / price
        return shares

    @staticmethod
    def find_price_by_target_liquidity(
        orderbook: Dict, target_liquidity: float, outcome: str = "yes",
        decimal_precision: int = 3
    ) -> float:
        """Calculate BID price: find price where cumulative liquidity >= target_liquidity up to best bid."""
        try:
            bids = orderbook.get("bids", [])
            asks = orderbook.get("asks", [])
            if not bids or not asks:
                return 0.0
            acc = 0.0
            tick = 1 / (10 ** decimal_precision)
            if outcome.lower() == "yes":
                for price, shares in bids:
                    acc += float(price) * float(shares)
                    if acc >= target_liquidity:
                        return round(float(price) - tick, decimal_precision)
                return round(float(bids[-1][0]) - tick, decimal_precision)
            else:
                for yes_price, shares in asks:
                    no_price = round(1.0 - float(yes_price), 4)
                    acc += no_price * float(shares)
                    if acc >= target_liquidity:
                        return round(no_price - tick, decimal_precision)
                last_no = round(1.0 - float(asks[-1][0]), 4)
                return round(last_no - tick, decimal_precision)
        except Exception:
            return 0.0

    @staticmethod
    def find_price_by_target_liquidity_asks(
        orderbook: Dict, target_liquidity: float, outcome: str = "yes",
        decimal_precision: int = 3
    ) -> float:
        """Calculate ASK price: find price where cumulative liquidity >= target_liquidity."""
        try:
            bids = orderbook.get("bids", [])
            asks = orderbook.get("asks", [])
            if not bids or not asks:
                return 0.0
            acc = 0.0
            tick = 1 / (10 ** decimal_precision)
            if outcome.lower() == "yes":
                for price, shares in bids:
                    p, s = float(price), float(shares)
                    acc += (1.0 - p) * s
                    if acc >= target_liquidity:
                        return round(p - tick, decimal_precision)
                return round(float(bids[-1][0]) - tick, decimal_precision)
            else:
                for yes_price, shares in asks:
                    no_price = 1.0 - float(yes_price)
                    acc += float(yes_price) * float(shares)
                    if acc >= target_liquidity:
                        return round(no_price - tick, decimal_precision)
                last_no = 1.0 - float(asks[-1][0])
                return round(last_no - tick, decimal_precision)
        except Exception:
            return 0.0

    @staticmethod
    def get_orders_before_us_str(
        orderbook: Dict, outcome: str, our_price: float,
        upper_bound: float, decimal_precision: int = 3
    ) -> str:
        """Returns list of prices between our price and the upper bound."""
        try:
            bids = orderbook.get("bids", [])
            asks = orderbook.get("asks", [])
            if not bids or not asks:
                return ""
            eps = 1e-9
            prices = []
            if outcome.lower() == "yes":
                for price, _ in bids:
                    p = float(price)
                    if our_price + eps < p < upper_bound - eps:
                        prices.append(round(p, 2 if decimal_precision == 2 else 3))
                    elif p <= our_price + eps:
                        break
            else:
                for yes_price, _ in asks:
                    no_p = 1.0 - float(yes_price)
                    if our_price + eps < no_p < upper_bound - eps:
                        prices.append(round(no_p, 2 if decimal_precision == 2 else 3))
                    elif no_p <= our_price + eps:
                        break
            if not prices:
                return ""
            seen = set()
            unique = []
            for x in prices:
                if x not in seen:
                    seen.add(x)
                    unique.append(x)
            unique.sort()
            if len(unique) <= 2:
                return ", ".join(f"{p*100:.1f}¢" for p in unique)
            return f"{unique[0]*100:.1f}¢ — {unique[-1]*100:.1f}¢"
        except Exception:
            return ""

    @staticmethod
    def calculate_limit_orders(
        orderbook: Dict, settings: TokenSettings,
        decimal_precision: int = 3, active_orders: Optional[Dict] = None
    ) -> Optional[Dict]:
        try:
            bids = orderbook.get("bids", [])
            asks = orderbook.get("asks", [])
            if not bids or not asks:
                return None

            use_ask = getattr(settings, "liquidity_mode", "bid") == "ask"
            best_bid_yes = float(bids[0][0])
            best_ask_yes = float(asks[0][0])
            mid_price_yes = (best_bid_yes + best_ask_yes) / 2
            mid_price_no = 1.0 - mid_price_yes

            find_price = (
                Calculator.find_price_by_target_liquidity_asks
                if use_ask
                else Calculator.find_price_by_target_liquidity
            )
            target_liq = settings.target_liquidity or 1000.0
            max_s = (settings.max_auto_spread or 6.0) / 100.0

            buy_price_yes = find_price(orderbook, target_liq, "yes", decimal_precision)
            buy_price_no = find_price(orderbook, target_liq, "no", decimal_precision)

            buy_price_yes = max(buy_price_yes, mid_price_yes - max_s)
            buy_price_no = max(buy_price_no, mid_price_no - max_s)

            buy_price_yes = Calculator.round_price_by_precision(buy_price_yes, decimal_precision)
            buy_price_no = Calculator.round_price_by_precision(buy_price_no, decimal_precision)

            tick = 1 / (10 ** decimal_precision)
            best_no_ask = 1.0 - best_bid_yes
            buy_price_yes = max(min(buy_price_yes, float(best_ask_yes) - tick, 0.999), MIN_ORDER_PRICE)
            buy_price_no = max(min(buy_price_no, best_no_ask - tick, 0.999), MIN_ORDER_PRICE)

            our_yes = active_orders.get("yes") if active_orders else None
            our_no = active_orders.get("no") if active_orders else None

            if settings.position_size_usdt is not None:
                usd = settings.position_size_usdt
                buy_shares_yes = Calculator.adjust_to_min_order_value(usd / buy_price_yes, buy_price_yes)
                buy_shares_yes = Calculator.round_shares_to_tenths(buy_shares_yes, buy_price_yes)
                buy_value_yes_usd = buy_shares_yes * buy_price_yes

                buy_shares_no = Calculator.adjust_to_min_order_value(usd / buy_price_no, buy_price_no)
                buy_shares_no = Calculator.round_shares_to_tenths(buy_shares_no, buy_price_no)
                buy_value_no_usd = buy_shares_no * buy_price_no
            elif settings.position_size_shares is not None:
                sh = settings.position_size_shares
                buy_shares_yes = Calculator.adjust_to_min_order_value(sh, buy_price_yes)
                buy_shares_yes = Calculator.round_shares_to_tenths(buy_shares_yes, buy_price_yes)
                buy_value_yes_usd = buy_shares_yes * buy_price_yes

                buy_shares_no = Calculator.adjust_to_min_order_value(sh, buy_price_no)
                buy_shares_no = Calculator.round_shares_to_tenths(buy_shares_no, buy_price_no)
                buy_value_no_usd = buy_shares_no * buy_price_no
            else:
                return None

            total_value_usd = max(buy_value_yes_usd, buy_value_no_usd)

            calc_liq = (
                Calculator.calculate_liquidity_by_asks
                if use_ask
                else Calculator.calculate_liquidity_before_price
            )
            liquidity_yes = calc_liq(orderbook, buy_price_yes, "yes", our_yes)
            liquidity_no = calc_liq(orderbook, buy_price_no, "no", our_no)

            min_liquidity = settings.target_liquidity or 1000.0
            can_place_yes_liq = liquidity_yes >= min_liquidity
            can_place_no_liq = liquidity_no >= min_liquidity

            min_spread_cents = settings.min_spread or 0.2
            min_spread_d = min_spread_cents / 100.0
            spread_yes = abs(mid_price_yes - buy_price_yes)
            spread_no = abs(mid_price_no - buy_price_no)
            can_place_yes_spr = not (buy_price_yes <= MIN_ORDER_PRICE and spread_yes < min_spread_d)
            can_place_no_spr = not (buy_price_no <= MIN_ORDER_PRICE and spread_no < min_spread_d)

            can_place_yes = can_place_yes_liq and can_place_yes_spr
            can_place_no = can_place_no_liq and can_place_no_spr

            try:
                from logger import debug_module
                debug_module("Calculator", "Limit order calculation", {
                    "buy_yes": buy_price_yes, "buy_no": buy_price_no,
                    "liq_yes": liquidity_yes, "liq_no": liquidity_no,
                    "can_yes": can_place_yes, "can_no": can_place_no,
                })
            except ImportError:
                pass

            return {
                "mid_price_yes": mid_price_yes, "mid_price_no": mid_price_no,
                "best_bid_yes": best_bid_yes, "best_ask_yes": best_ask_yes,
                "buy_yes": {"price": buy_price_yes, "shares": buy_shares_yes, "value_usd": buy_value_yes_usd},
                "buy_no": {"price": buy_price_no, "shares": buy_shares_no, "value_usd": buy_value_no_usd},
                "total_value_usd": total_value_usd,
                "liquidity_yes": liquidity_yes, "liquidity_no": liquidity_no,
                "can_place_yes": can_place_yes, "can_place_no": can_place_no,
                "min_liquidity": min_liquidity,
                "spread_yes": spread_yes, "spread_no": spread_no,
                "min_spread": min_spread_cents,
                "can_place_yes_liquidity": can_place_yes_liq,
                "can_place_no_liquidity": can_place_no_liq,
                "can_place_yes_spread": can_place_yes_spr,
                "can_place_no_spread": can_place_no_spr,
            }
        except Exception as e:
            print(f"Calculation error: {e}")
            return None
