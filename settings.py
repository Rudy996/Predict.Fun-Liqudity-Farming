"""Token settings per market_id"""

import json
import os
import time
from typing import Dict, Optional
from config import (
    SETTINGS_FILE, DEFAULTS,
)


class TokenSettings:
    def __init__(
        self,
        market_id: str,
        position_size_usdt: Optional[float] = DEFAULTS["position_size_usdt"],
        position_size_shares: Optional[float] = DEFAULTS["position_size_shares"],
        min_spread: Optional[float] = DEFAULTS["min_spread"],
        enabled: bool = DEFAULTS["enabled"],
        target_liquidity: float = DEFAULTS["target_liquidity"],
        max_auto_spread: float = DEFAULTS["max_auto_spread"],
        liquidity_mode: str = DEFAULTS["liquidity_mode"],
        volatile_reposition_limit: Optional[int] = DEFAULTS["volatile_reposition_limit"],
        volatile_window_seconds: Optional[float] = DEFAULTS["volatile_window_seconds"],
        volatile_cooldown_seconds: Optional[float] = DEFAULTS["volatile_cooldown_seconds"],
        reposition_min_price_delta: float = DEFAULTS["reposition_min_price_delta"],
        is_custom: bool = False,
        settings_saved_at: Optional[float] = None,
    ):
        self.market_id = market_id
        self.position_size_usdt = position_size_usdt
        self.position_size_shares = position_size_shares
        self.min_spread = min_spread
        self.enabled = enabled
        self.target_liquidity = target_liquidity
        self.max_auto_spread = max_auto_spread
        self.liquidity_mode = liquidity_mode if liquidity_mode in ("bid", "ask") else DEFAULTS["liquidity_mode"]
        self.volatile_reposition_limit = volatile_reposition_limit if volatile_reposition_limit is not None else DEFAULTS["volatile_reposition_limit"]
        self.volatile_window_seconds = volatile_window_seconds if volatile_window_seconds is not None else DEFAULTS["volatile_window_seconds"]
        self.volatile_cooldown_seconds = volatile_cooldown_seconds if volatile_cooldown_seconds is not None else DEFAULTS["volatile_cooldown_seconds"]
        self.reposition_min_price_delta = float(
            reposition_min_price_delta
            if reposition_min_price_delta is not None
            else DEFAULTS["reposition_min_price_delta"]
        )
        self.is_custom = is_custom
        self.settings_saved_at = settings_saved_at

    def to_dict(self) -> Dict:
        return {k: v for k, v in self.__dict__.items()}

    @classmethod
    def from_dict(cls, data: Dict) -> "TokenSettings":
        return cls(
            market_id=data.get("market_id", ""),
            position_size_usdt=data.get("position_size_usdt", DEFAULTS["position_size_usdt"]),
            position_size_shares=data.get("position_size_shares", DEFAULTS["position_size_shares"]),
            min_spread=data.get("min_spread", DEFAULTS["min_spread"]),
            enabled=data.get("enabled", DEFAULTS["enabled"]),
            target_liquidity=data.get("target_liquidity", DEFAULTS["target_liquidity"]),
            max_auto_spread=data.get("max_auto_spread", DEFAULTS["max_auto_spread"]),
            liquidity_mode=data.get("liquidity_mode", DEFAULTS["liquidity_mode"]),
            volatile_reposition_limit=data.get("volatile_reposition_limit", DEFAULTS["volatile_reposition_limit"]),
            volatile_window_seconds=data.get("volatile_window_seconds", DEFAULTS["volatile_window_seconds"]),
            volatile_cooldown_seconds=data.get("volatile_cooldown_seconds", DEFAULTS["volatile_cooldown_seconds"]),
            reposition_min_price_delta=data.get("reposition_min_price_delta", DEFAULTS["reposition_min_price_delta"]),
            is_custom=data.get("is_custom", False),
            settings_saved_at=data.get("settings_saved_at"),
        )


class SettingsManager:
    def __init__(self, settings_file: str = SETTINGS_FILE):
        self.settings_file = settings_file
        self.settings: Dict[str, TokenSettings] = {}
        self.load_settings()

    def load_settings(self):
        if not os.path.exists(self.settings_file):
            self.settings = {}
            return
        try:
            with open(self.settings_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                self.settings = {mid: TokenSettings.from_dict(d) for mid, d in data.items()}
        except Exception:
            self.settings = {}

    def save_settings(self):
        try:
            data = {mid: s.to_dict() for mid, s in self.settings.items()}
            with open(self.settings_file, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
        except Exception as e:
            print(f"Error saving settings: {e}")

    def get_settings(self, market_id: str, use_defaults_if_not_custom: bool = False) -> TokenSettings:
        if market_id not in self.settings:
            self.settings[market_id] = TokenSettings(market_id=market_id)
        elif use_defaults_if_not_custom and not self.settings[market_id].is_custom:
            return TokenSettings(market_id=market_id)
        return self.settings[market_id]

    def get_settings_updated_at(self, market_id: str) -> float:
        s = self.settings.get(market_id)
        if not s or s.settings_saved_at is None:
            return 0.0
        return float(s.settings_saved_at)

    def update_settings(self, market_id: str, **kwargs):
        """Обновление полей. None допустим для сброса опциональных полей (размер позиции, min_spread, волатильность)."""
        settings = self.get_settings(market_id)
        nullable_keys = ("position_size_usdt", "position_size_shares", "min_spread")
        for k, v in kwargs.items():
            if not hasattr(settings, k):
                continue
            if v is None and k not in nullable_keys:
                continue
            setattr(settings, k, v)
        if settings.liquidity_mode not in ("bid", "ask"):
            settings.liquidity_mode = DEFAULTS["liquidity_mode"]
        settings.is_custom = True
        settings.settings_saved_at = time.time()
        self.save_settings()

    def remove_market_settings(self, market_id: str) -> bool:
        if market_id not in self.settings:
            return False
        del self.settings[market_id]
        self.save_settings()
        return True

    def remove_settings_for_market_ids(self, market_ids: list[str]) -> int:
        n = 0
        for mid in market_ids:
            if mid in self.settings:
                del self.settings[mid]
                n += 1
        if n:
            self.save_settings()
        return n
