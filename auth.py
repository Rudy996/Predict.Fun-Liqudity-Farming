"""Authentication for Predict Fun API"""

import asyncio
from config import API_BASE_URL, format_proxy


def _explain_proxy_failure(exc: BaseException) -> str | None:
    """Человекочитаемое пояснение для типичных ошибок прокси."""
    msg = f"{type(exc).__name__}: {exc}"
    low = msg.lower()
    if "proxy" not in low and "502" not in low and "tunnel" not in low:
        return None
    return (
        "Ошибка прокси при обращении к api.predict.fun (часто 502 Bad Gateway на туннеле). "
        "Проверьте URL прокси, логин/пароль; для SOCKS5 убедитесь, что установлен пакет PySocks. "
        "Если прокси не нужен — очистите поле Proxy в форме подключения. "
        "Также отключите переменные окружения HTTP_PROXY/HTTPS_PROXY в системе, если они указывают на нерабочий прокси."
    )


def get_auth_headers(jwt_token: str, api_key: str) -> dict:
    return {
        "Content-Type": "application/json",
        "x-api-key": api_key,
        "Authorization": f"Bearer {jwt_token}",
    }


async def get_auth_jwt(
    api_key: str,
    predict_account_address: str,
    privy_wallet_private_key: str,
    proxy: str = None,
    log_func=print,
) -> str | None:
    def _sync_auth():
        import requests
        from predict_sdk import OrderBuilder, ChainId, OrderBuilderOptions

        privy_key = privy_wallet_private_key
        if privy_key.startswith("0x"):
            privy_key = privy_key[2:]

        builder = OrderBuilder.make(
            ChainId.BNB_MAINNET,
            privy_key,
            OrderBuilderOptions(predict_account=predict_account_address),
        )
        has_proxy = bool(proxy and str(proxy).strip())
        proxies = format_proxy(proxy) if has_proxy else None

        # Не подхватывать HTTP_PROXY/HTTPS_PROXY из окружения — только явный прокси из формы.
        sess = requests.Session()
        sess.trust_env = False
        req_kw = {"timeout": 15}
        if proxies:
            req_kw["proxies"] = proxies

        msg_resp = sess.get(
            f"{API_BASE_URL}/v1/auth/message",
            headers={"x-api-key": api_key},
            **req_kw,
        )
        if not msg_resp.ok:
            raise Exception(f"Error getting message: {msg_resp.status_code}")
        message = msg_resp.json()["data"]["message"]

        signature = builder.sign_predict_account_message(message)

        body = {
            "signer": predict_account_address,
            "message": message,
            "signature": signature,
        }
        jwt_resp = sess.post(
            f"{API_BASE_URL}/v1/auth",
            headers={"Content-Type": "application/json", "x-api-key": api_key},
            json=body,
            **req_kw,
        )
        if not jwt_resp.ok:
            raise Exception(f"JWT error: {jwt_resp.status_code}")
        return jwt_resp.json()["data"]["token"]

    try:
        jwt = await asyncio.to_thread(_sync_auth)
        log_func("Authentication successful")
        return jwt
    except Exception as e:
        hint = _explain_proxy_failure(e)
        if hint:
            log_func(f"Authentication error: {e}")
            log_func(hint)
            raise RuntimeError(f"{hint}\n\nТехнически: {e}") from e
        log_func(f"Authentication error: {e}")
        raise
