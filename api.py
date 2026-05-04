"""Async API client for Predict Fun"""

import asyncio
import json
import aiohttp
from typing import Any, Dict, List, Optional
from config import API_BASE_URL, format_proxy_for_aiohttp
from auth import get_auth_headers


class APIClient:
    def __init__(self, api_key: str, jwt_token: str, proxy: Optional[str] = None):
        self.api_key = api_key
        self.jwt_token = jwt_token
        self.proxy_url = format_proxy_for_aiohttp(proxy) if proxy else None
        self.headers = get_auth_headers(jwt_token, api_key)

    def update_token(self, jwt_token: str):
        self.jwt_token = jwt_token
        self.headers = get_auth_headers(jwt_token, self.api_key)

    async def get_category_by_slug(self, slug: str, log_func=None) -> Optional[Dict]:
        if log_func is None:
            log_func = print
        url = f"{API_BASE_URL}/v1/categories/{slug}"
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    url,
                    headers=self.headers,
                    proxy=self.proxy_url,
                    timeout=aiohttp.ClientTimeout(total=15),
                ) as resp:
                    if not resp.ok:
                        log_func(f"Category error {slug}: {resp.status}")
                        return None
                    data = await resp.json()
                    if data.get("success") and "data" in data:
                        return data["data"]
                    return None
        except Exception as e:
            log_func(f"Category request error {slug}: {e}")
            return None

    async def get_market_info(self, market_id: str, log_func=None) -> Optional[Dict]:
        if log_func is None:
            log_func = print
        url = f"{API_BASE_URL}/v1/markets/{market_id}"
        for attempt in range(1, 4):
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.get(
                        url,
                        headers=self.headers,
                        proxy=self.proxy_url,
                        timeout=aiohttp.ClientTimeout(total=10),
                    ) as resp:
                        if not resp.ok:
                            if attempt < 3:
                                await asyncio.sleep(1)
                                continue
                            return None
                        data = await resp.json()
                        if data.get("success") and "data" in data:
                            result = data["data"]
                            try:
                                from logger import debug_module
                                debug_module("API", f"get_market_info market_id={market_id}", {
                                    "status": result.get("status"),
                                    "title": (result.get("title") or "")[:30],
                                })
                            except ImportError:
                                pass
                            return result
                        return None
            except Exception as e:
                log_func(f"Market request error {market_id}: {e}")
                if attempt < 3:
                    await asyncio.sleep(1)
        return None

    async def set_referral(self, code: str) -> bool:
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"{API_BASE_URL}/v1/account/referral",
                    headers={**self.headers, "Content-Type": "application/json"},
                    json={"data": {"referralCode": code}},
                    proxy=self.proxy_url,
                    timeout=aiohttp.ClientTimeout(total=10),
                ) as resp:
                    data = await resp.json() if resp.ok else {}
                    return bool(data.get("success"))
        except Exception:
            return False

    async def get_positions(self, log_func=None) -> Optional[List[Dict[str, Any]]]:
        """GET /v1/positions — открытые позиции аккаунта (для AutoSell)."""
        if log_func is None:
            log_func = print
        url = f"{API_BASE_URL}/v1/positions"
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    url,
                    headers=self.headers,
                    proxy=self.proxy_url,
                    timeout=aiohttp.ClientTimeout(total=20),
                ) as resp:
                    text = await resp.text()
                    if not resp.ok:
                        log_func(f"get_positions HTTP {resp.status}: {text[:200]}")
                        return None
                    data = json.loads(text)
                    if not data.get("success"):
                        return None
                    d = data.get("data")
                    if isinstance(d, list):
                        return d
                    if isinstance(d, dict):
                        inner = d.get("positions")
                        if isinstance(inner, list):
                            return inner
                        if d:
                            return [d]
                    return []
        except Exception as e:
            log_func(f"get_positions error: {e}")
            return None

    @staticmethod
    def _parse_get_order_body(data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        if not isinstance(data, dict):
            return None
        if data.get("success") is False:
            return None
        d = data.get("data")
        if isinstance(d, dict) and isinstance(d.get("data"), dict):
            d = d["data"]
        if not isinstance(d, dict):
            od = data.get("order")
            d = od if isinstance(od, dict) else None
        if not isinstance(d, dict):
            if any(
                k in data
                for k in ("id", "orderId", "status", "orderStatus", "amountFilled")
            ):
                d = data
        return d if isinstance(d, dict) else None

    async def _get_order_by_path_segment(
        self, segment: str, log_func
    ) -> Optional[Dict[str, Any]]:
        """GET /v1/orders/{segment}, segment = order.hash."""
        url = f"{API_BASE_URL}/v1/orders/{segment}"
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    url,
                    headers=self.headers,
                    proxy=self.proxy_url,
                    timeout=aiohttp.ClientTimeout(total=15),
                ) as resp:
                    text = await resp.text()
                    if not resp.ok:
                        if resp.status != 404:
                            log_func(f"get_order HTTP {resp.status}: {text[:200]}")
                        return None
                    data = json.loads(text)
                    d = self._parse_get_order_body(data)
                    if d is None and isinstance(data, dict) and data.get("success") is False:
                        log_func(f"get_order success=false: {text[:200]}")
                    return d
        except Exception as e:
            log_func(f"get_order error: {e}")
            return None

    async def get_order(self, order_hash: str, log_func=None) -> Optional[Dict[str, Any]]:
        """
        Только GET /v1/orders/{hash} — hash из data.order.hash (dev.predict.fun, Orders).
        """
        if log_func is None:
            log_func = print
        h = str(order_hash).strip()
        if not h:
            return None
        return await self._get_order_by_path_segment(h, log_func)

    async def get_account_info(self) -> Optional[Dict]:
        for ep in ["/v1/user", "/v1/account", "/v1/me"]:
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.get(
                        f"{API_BASE_URL}{ep}",
                        headers=self.headers,
                        proxy=self.proxy_url,
                        timeout=aiohttp.ClientTimeout(total=5),
                    ) as resp:
                        if resp.ok:
                            data = await resp.json()
                            if data.get("success") and "data" in data:
                                return data["data"]
            except Exception:
                continue
        return None

    def get_usdt_balance(
        self,
        predict_account_address: str,
        privy_wallet_private_key: str,
    ) -> Optional[float]:
        from predict_sdk import OrderBuilder, ChainId, OrderBuilderOptions
        privy_key = privy_wallet_private_key
        if privy_key.startswith("0x"):
            privy_key = privy_key[2:]
        builder = OrderBuilder.make(
            ChainId.BNB_MAINNET,
            privy_key,
            OrderBuilderOptions(predict_account=predict_account_address),
        )
        try:
            balance_wei = builder.balance_of()
            return float(balance_wei) / (10**18)
        except Exception:
            return None
