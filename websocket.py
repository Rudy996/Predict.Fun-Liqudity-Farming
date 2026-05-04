"""WebSocket client for Predict Fun"""

import asyncio
import json
import random
import threading
import time
from typing import Callable, Dict, List, Optional

from logger import diag_print, log_error_to_file, log_print

try:
    import websockets
    HAS_WEBSOCKETS = True
except ImportError:
    HAS_WEBSOCKETS = False

# Пауза перед повторным connect: в async_v3 было ровно 5 с у всех -> гонка и риск 429. Разносим по слотам + jitter.
_RECONNECT_BASE_SEC = 3.8
_RECONNECT_SLOT_STEP_SEC = 0.16
_RECONNECT_JITTER_SEC = 2.6
_RECONNECT_CAP_SEC = 28.0
_SINGLE_CLIENT_JITTER_SEC = 1.2


def _human_ws_exception(exc: BaseException) -> str:
    """Одна строка для лога: тип + str (у websockets.ConnectionClosed в str уже code/reason)."""
    try:
        name = type(exc).__name__
        body = str(exc).strip()
        if body:
            return f"{name}: {body}"[:300]
        return name
    except Exception:
        return repr(exc)[:200]


def _orderbook_fingerprint(ob: dict, depth: int = 64):
    """
    Фингерпринт стакана для дедупа в пуле. Депт=0 → только топ (как раньше).
    Депт>0 → берём первые N уровней с каждой стороны. Это:
      1) делает «гонку» между слотами чаще (любое изменение глубины тоже создаёт уникальный fp),
         что точнее ранжирует слоты по скорости,
      2) перестаёт «глотать» обновления, в которых поменялось только глубже первого уровня.
    Если есть только одна сторона — фингерпринт всё равно не None, чтобы N идентичных копий
    из разных слотов не пробивали дедуп.
    """
    bids = ob.get("bids") or []
    asks = ob.get("asks") or []
    if not bids and not asks:
        return None
    d = max(1, int(depth)) if int(depth) > 0 else 1
    def _norm(side):
        if not side:
            return ()
        out = []
        for row in side[:d]:
            try:
                if isinstance(row, (list, tuple)) and len(row) >= 2:
                    out.append((float(row[0]), float(row[1])))
                else:
                    out.append(row)
            except (TypeError, ValueError):
                out.append(row)
        return tuple(out)
    try:
        return (_norm(bids), _norm(asks))
    except Exception:
        return None


class WebSocketClient:
    def __init__(
        self,
        api_key: Optional[str] = None,
        on_orderbook_update: Optional[Callable[[str, dict], None]] = None,
        on_heartbeat: Optional[Callable[[], None]] = None,
        on_connection_change: Optional[Callable[[bool], None]] = None,
        log_func: Optional[Callable[[str], None]] = None,
        instance_label: str = "",
        drop_first_orderbook_tick: bool = False,
        connect_stagger_sec: float = 0.0,
        log_periodic_ping: bool = True,
        reconnect_delay_sec: Optional[float] = None,
    ):
        self.api_key = api_key
        self.on_orderbook_update = on_orderbook_update
        self.on_heartbeat = on_heartbeat
        self.on_connection_change = on_connection_change
        self.log_func = log_func or (lambda _: None)
        self.instance_label = instance_label
        self.drop_first_orderbook_tick = drop_first_orderbook_tick
        self.connect_stagger_sec = float(connect_stagger_sec) if connect_stagger_sec else 0.0
        self.log_periodic_ping = log_periodic_ping
        self.ws = None
        self.connected = False
        self.subscriptions: Dict[str, None] = {}
        self.request_id_counter = 0
        self._task = None
        self._running = False
        self._loop = None
        self._reconnect_attempt = 0
        self._orderbook_ticks_per_market: Dict[str, int] = {}
        self._initial_stagger_done = False
        if reconnect_delay_sec is None:
            self._reconnect_delay_sec = 5.0 + random.uniform(0.0, _SINGLE_CLIENT_JITTER_SEC)
        else:
            self._reconnect_delay_sec = float(reconnect_delay_sec)
        ws_url = "wss://ws.predict.fun/ws"
        if api_key:
            ws_url += f"?apiKey={api_key}"
        self.ws_url = ws_url

    def _emit_log(self, msg: str):
        prefix = f"[WebSocket{self.instance_label}]" if self.instance_label else "[WebSocket]"
        self.log_func(f"{prefix} {msg}")

    def _get_next_request_id(self) -> int:
        self.request_id_counter += 1
        return self.request_id_counter

    async def _run(self):
        if not HAS_WEBSOCKETS:
            log_error_to_file("websockets not installed", context="pip install websockets")
            return
        self._running = True
        loop_iter = 0
        while self._running:
            loop_iter += 1
            reported_live = False
            offline_note = ""
            reconnect_explanation_logged = False
            slot_tag = (self.instance_label or "").strip() or "single"
            diag_print(
                "ws-client",
                f"итерация #{loop_iter} цикла reconnect",
                f"слот [{slot_tag}] running={self._running} подписок_рынков={len(self.subscriptions)}",
            )
            try:
                if self.connect_stagger_sec > 0 and not self._initial_stagger_done:
                    diag_print("ws-client", "stagger перед первым коннектом", f"слот [{slot_tag}] sleep {self.connect_stagger_sec:.3f}s")
                    await asyncio.sleep(self.connect_stagger_sec)
                    self._initial_stagger_done = True
                diag_print("ws-client", "открываю WebSocket", f"слот [{slot_tag}] → wss://ws.predict.fun/ws?apiKey=(скрыт) ping 10s/10s")
                async with websockets.connect(
                    self.ws_url,
                    ping_interval=10,
                    ping_timeout=10,
                    close_timeout=5,
                ) as ws:
                    self.ws = ws
                    self.connected = True
                    self._reconnect_attempt = 0
                    self._orderbook_ticks_per_market.clear()
                    self._emit_log("Connected")
                    reported_live = True
                    diag_print(
                        "ws-client",
                        "сокет установлен → on_connection_change(True) для пула",
                        f"слот [{slot_tag}] затем subscribe на {len(self.subscriptions)} рынков",
                    )
                    if self.on_connection_change:
                        try:
                            self.on_connection_change(True)
                        except Exception:
                            pass
                    await asyncio.sleep(0.5)
                    for mid in list(self.subscriptions.keys()):
                        await self._subscribe(mid)
                    diag_print("ws-client", "подписки отправлены", f"слот [{slot_tag}] markets={len(self.subscriptions)}")
                    ping_log_task = None
                    if self.log_periodic_ping:
                        ping_log_task = asyncio.create_task(self._ping_pong_log_loop())
                    try:
                        async for message in ws:
                            if not self._running:
                                break
                            try:
                                data = json.loads(message)
                                if data.get("type") == "M" and data.get("topic") == "heartbeat":
                                    ts = data.get("data")
                                    await self._send_heartbeat(ws, ts)
                                    if self.on_heartbeat:
                                        try:
                                            self.on_heartbeat()
                                        except Exception:
                                            pass
                                    continue
                                if data.get("type") == "R":
                                    continue
                                if data.get("type") == "M":
                                    topic = data.get("topic", "")
                                    if topic.startswith("predictOrderbook/"):
                                        mid = topic.split("/")[1]
                                        ob = data.get("data", {})
                                        if ob and (ob.get("bids") or ob.get("asks")):
                                            if self.drop_first_orderbook_tick:
                                                cnt = self._orderbook_ticks_per_market.get(mid, 0)
                                                self._orderbook_ticks_per_market[mid] = cnt + 1
                                                if cnt == 0:
                                                    continue
                                            from logger import debug_module
                                            debug_module("WebSocket", f"orderbook market_id={mid}", {
                                                "bids": len(ob.get("bids", [])),
                                                "asks": len(ob.get("asks", [])),
                                            })
                                            if self.on_orderbook_update:
                                                try:
                                                    self.on_orderbook_update(mid, ob)
                                                except Exception as e:
                                                    log_error_to_file(
                                                        f"on_orderbook_update: {e}",
                                                        exception=e,
                                                        context=f"market_id={mid}",
                                                    )
                            except json.JSONDecodeError:
                                pass
                            except Exception as e:
                                log_error_to_file("WebSocket message", exception=e, context="websocket")
                    finally:
                        if ping_log_task:
                            ping_log_task.cancel()
                            try:
                                await ping_log_task
                            except asyncio.CancelledError:
                                pass
            except asyncio.CancelledError:
                offline_note = "остановка"
                diag_print("ws-client", "asyncio.CancelledError — остановка задачи", f"слот [{slot_tag}] reported_live={reported_live}")
                self._emit_log("Stopped")
                break
            except Exception as e:
                self._reconnect_attempt += 1
                attempt_suffix = f" (попытка {self._reconnect_attempt})" if self._reconnect_attempt > 1 else ""
                err_msg = str(e) if e else repr(e)
                offline_note = f"{type(e).__name__}: {err_msg[:160]}"
                human = _human_ws_exception(e)
                diag_print(
                    "ws-client",
                    "исключение в цикле WebSocket",
                    f"слот [{slot_tag}] {type(e).__name__} уже_был_онлайн={reported_live} msg={err_msg[:120]}",
                )
                hint = ""
                if "429" in err_msg:
                    hint = " | подсказка: лимит сессий/429 — уменьши websocket_pool_size"
                elif "ping" in err_msg.lower() or "pong" in err_msg.lower() or "timeout" in err_msg.lower():
                    hint = " | подсказка: ping/pong или таймаут сети"
                if self._running:
                    self._emit_log(
                        f"Реконнект через {self._reconnect_delay_sec:.2f} с{attempt_suffix} | причина: {human}{hint}"
                    )
                    reconnect_explanation_logged = True
                log_error_to_file("WebSocket error", exception=e if isinstance(e, Exception) else None, context="websocket")
            finally:
                self.ws = None
                self.connected = False
                if reported_live:
                    if not offline_note and not self._running:
                        offline_note = "остановка"
                    if not offline_note:
                        offline_note = "канал закрыт (сервер или сеть)"
                    diag_print(
                        "ws-client",
                        "finally: снимаю слот с линии → on_connection_change(False)",
                        f"слот [{slot_tag}] причина={offline_note[:180]}",
                    )
                    self._emit_log(f"Слот офлайн — {offline_note}")
                    if self.on_connection_change:
                        try:
                            self.on_connection_change(False)
                        except Exception:
                            pass
            if self._running:
                w = self._reconnect_delay_sec
                if not reconnect_explanation_logged:
                    self._emit_log(
                        f"Повтор через {w:.2f} с | причина: закрытие без исключения в этом цикле (часто штатный close от сервера/сети), детали в строке 'Слот офлайн' выше"
                    )
                diag_print("ws-client", "пауза перед следующей попыткой", f"слот [{slot_tag}] sleep {w:.2f}s")
                await asyncio.sleep(w)
        self.connected = False

    async def _subscribe(self, market_id: str):
        req_id = self._get_next_request_id()
        msg = {"method": "subscribe", "requestId": req_id, "params": [f"predictOrderbook/{market_id}"]}
        if self.ws:
            await self.ws.send(json.dumps(msg))

    async def _ping_pong_log_loop(self):
        while self._running and self.connected:
            try:
                await asyncio.sleep(10)
                if self._running and self.connected and self.ws:
                    self._emit_log("ping <-> pong")
            except asyncio.CancelledError:
                break

    async def _send_heartbeat(self, ws, ts):
        req_id = self._get_next_request_id()
        msg = {"method": "heartbeat", "requestId": req_id, "params": {"ts": ts}}
        await ws.send(json.dumps(msg))

    def subscribe_orderbook(self, market_id: str):
        self.subscriptions[market_id] = None
        if self.connected and self.ws and self._loop and self._loop.is_running():
            asyncio.run_coroutine_threadsafe(self._subscribe(market_id), self._loop)

    def unsubscribe_orderbook(self, market_id: str):
        self.subscriptions.pop(market_id, None)

    def start(self, loop: asyncio.AbstractEventLoop):
        self._loop = loop
        self._task = asyncio.run_coroutine_threadsafe(self._run(), loop)

    def stop(self):
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
        self._task = None
        self._loop = None


class WebSocketPool:
    def __init__(
        self,
        api_key: str,
        on_orderbook_update: Callable[[str, dict], None],
        on_heartbeat: Optional[Callable[[], None]] = None,
        on_connection_change: Optional[Callable[[bool], None]] = None,
        log_func: Optional[Callable[[str], None]] = None,
        num_connections: int = 1,
        skip_first: bool = False,
        dedupe_window: float = 0.0,
        stagger_ms: float = 0.0,
        slow_rebalance_sec: float = 0.0,
        slow_min_spread: int = 10,
        slow_min_top: int = 24,
        pool_verbose: bool = False,
        slow_slots_per_rebalance: int = 1,
        dedupe_depth_levels: int = 64,
        rotate_inter_slot_pause_sec: float = 1.5,
        realtime_log: bool = False,
    ):
        self._api_key = api_key
        self.on_orderbook_update = on_orderbook_update
        self.on_heartbeat = on_heartbeat
        self.on_connection_change = on_connection_change
        self.log_func = log_func or (lambda _: None)
        self.num_connections = max(1, min(32, num_connections))
        self._pool_skip_first = skip_first
        self._dedupe_window = dedupe_window
        self._stagger_ms = stagger_ms
        self._slow_rebalance_sec = slow_rebalance_sec
        self._slow_min_spread = slow_min_spread
        self._slow_min_top = slow_min_top
        # сколько самых медленных слотов заменять за один цикл ребаланса
        self._slow_slots_per_rebalance = max(1, min(self.num_connections, int(slow_slots_per_rebalance)))
        # сколько уровней с каждой стороны включаем в fingerprint для dedup/ранжирования
        self._dedupe_depth_levels = max(1, min(64, int(dedupe_depth_levels)))
        # пауза между заменой соседних слотов в одной волне ребаланса (анти-429)
        self._rotate_inter_slot_pause_sec = max(0.0, float(rotate_inter_slot_pause_sec))
        # Real-time лог пула в серверный stdout: каждый CONNECT/DISCONNECT/FORWARD/DUP-DROP/ROT-*
        self._realtime_log = bool(realtime_log)
        self._lock = threading.Lock()
        self._last_fp: Dict[str, tuple] = {}
        self._last_fp_time: Dict[str, float] = {}
        self._live_count = 0
        self._last_hb_wall = 0.0
        self._slot_win_counts = [0] * self.num_connections
        self.clients: List[WebSocketClient] = [self._create_client(i) for i in range(self.num_connections)]
        self._running = False
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._status_task: Optional[asyncio.Task] = None
        self._rebalance_task: Optional[asyncio.Task] = None
        self._pool_status_interval_sec = 15.0
        self._replace_in_progress = False
        self._pool_verbose = pool_verbose
        self._dup_since_status = [0] * self.num_connections
        self._win_snap = [0] * self.num_connections

    def _rt(self, action: str, msg: str = "") -> None:
        """Real-time строка в stdout сервера (виден в консоли main.py как [Server] [ws-rt] ...)."""
        if not self._realtime_log:
            return
        try:
            live = sum(1 for c in self.clients if c.connected)
            log_print(f"[ws-rt] {action:<10} live={live:>2}/{self.num_connections} {msg}")
        except Exception:
            pass

    def _make_client_log(self, slot_idx: int):
        """Прокси для лог-канала клиента: ui-лог как был + realtime в stdout, если включено."""
        ui_log = self.log_func
        n = self.num_connections
        def _client_log(message: str):
            try:
                ui_log(message)
            except Exception:
                pass
            if self._realtime_log:
                try:
                    live = sum(1 for c in self.clients if c.connected)
                    log_print(f"[ws-rt] CLIENT     live={live:>2}/{n} slot={slot_idx + 1} {message}")
                except Exception:
                    pass
        return _client_log

    def _create_client(self, slot_idx: int, connect_stagger_sec: Optional[float] = None) -> WebSocketClient:
        n = self.num_connections
        if connect_stagger_sec is None:
            stagger_sec = max(0.0, self._stagger_ms) / 1000.0
            stagger = (slot_idx * stagger_sec) if stagger_sec > 0 else 0.0
        else:
            stagger = float(connect_stagger_sec)
        label = f" {slot_idx + 1}/{n}"
        drop_first = bool(self._pool_skip_first and slot_idx == 0)
        delay = min(
            _RECONNECT_BASE_SEC + slot_idx * _RECONNECT_SLOT_STEP_SEC + random.uniform(0.0, _RECONNECT_JITTER_SEC),
            _RECONNECT_CAP_SEC,
        )
        return WebSocketClient(
            api_key=self._api_key,
            on_orderbook_update=self._make_ob_callback(slot_idx),
            on_heartbeat=self._heartbeat_throttled,
            on_connection_change=self._connection_slot(slot_idx),
            log_func=self._make_client_log(slot_idx),
            instance_label=label,
            drop_first_orderbook_tick=drop_first,
            connect_stagger_sec=stagger,
            log_periodic_ping=(n <= 1),
            reconnect_delay_sec=delay,
        )

    def _make_ob_callback(self, slot_idx: int):
        def _inner(mid: str, ob: dict):
            self._maybe_forward_orderbook(mid, ob, slot_idx)
        return _inner

    def _heartbeat_throttled(self):
        now = time.time()
        if now - self._last_hb_wall < 0.4:
            return
        self._last_hb_wall = now
        if self.on_heartbeat:
            try:
                self.on_heartbeat()
            except Exception:
                pass

    def _connection_slot(self, slot_idx: int):
        def _inner(connected: bool):
            with self._lock:
                old_live = self._live_count
                if connected:
                    self._live_count += 1
                else:
                    self._live_count = max(0, self._live_count - 1)
                live = self._live_count
                alive = live > 0
            diag_print(
                "ws-pool",
                "колбэк слота (агрегат для UI)",
                f"слот {slot_idx + 1}/{self.num_connections}: connected={connected} | "
                f"_live_count {old_live}→{live} | "
                f"признак «есть_хоть_один»={alive} (им станет app_state.ws_connected)",
            )
            if old_live > 0 and live == 0:
                n = self.num_connections
                self.log_func(
                    f"[WebSocket pool] Сейчас 0/{n} живых сокетов (ни один слот не в connected). "
                    f"Приложение само не «перезапускает пул целиком»: у каждого слота свой цикл и свой reconnect. "
                    f"Если все нули сразу — обычно общая причина: лимит по apiKey (429), обрыв сети, или сервер закрыл все соединения. "
                    f"Смотри по времени строки «Слот офлайн — …» выше. При частых 429 уменьши websocket_pool_size."
                )
            self._rt(
                "CONNECT" if connected else "DISCONNECT",
                f"slot={slot_idx + 1} ({old_live}→{live})",
            )
            if self.on_connection_change:
                try:
                    self.on_connection_change(alive)
                except Exception:
                    pass
        return _inner

    async def _pool_status_loop(self):
        try:
            await asyncio.sleep(3.0)
            while self._running:
                n_live = sum(1 for c in self.clients if c.connected)
                n_sub = len(self.clients[0].subscriptions) if self.clients else 0
                self.log_func(f"[WebSocket pool] OK — active {n_live}/{self.num_connections}, subs: {n_sub}")
                if self._pool_verbose and self.num_connections > 1:
                    with self._lock:
                        cur_w = list(self._slot_win_counts)
                        dups = list(self._dup_since_status)
                        self._dup_since_status = [0] * self.num_connections
                    dwin = [max(0, cur_w[i] - self._win_snap[i]) for i in range(self.num_connections)]
                    self._win_snap = cur_w[:]
                    tw = sum(dwin)
                    td = sum(dups)
                    by_win = sorted(range(self.num_connections), key=lambda i: dwin[i], reverse=True)
                    by_dup = sorted(range(self.num_connections), key=lambda i: dups[i], reverse=True)
                    top_w = ", ".join(f"{i+1}:{dwin[i]}" for i in by_win[:5] if dwin[i] > 0) or "-"
                    top_d = ", ".join(f"{i+1}:{dups[i]}" for i in by_dup[:5] if dups[i] > 0) or "-"
                    self.log_func(f"[WebSocket pool] Stats ~{self._pool_status_interval_sec:.0f}s: unique={tw}, best=[{top_w}], dedup={td}, worst=[{top_d}]")
                await asyncio.sleep(self._pool_status_interval_sec)
        except asyncio.CancelledError:
            pass

    def _maybe_forward_orderbook(self, mid: str, ob: dict, slot_idx: int):
        fp = _orderbook_fingerprint(ob, self._dedupe_depth_levels)
        now = time.monotonic()
        if self._dedupe_window > 0 and fp is not None:
            with self._lock:
                prev = self._last_fp.get(mid)
                tprev = self._last_fp_time.get(mid, 0.0)
                if prev == fp and (now - tprev) < self._dedupe_window:
                    if self._pool_verbose and 0 <= slot_idx < self.num_connections:
                        self._dup_since_status[slot_idx] += 1
                    if self._realtime_log:
                        age_ms = int((now - tprev) * 1000)
                        self._rt(
                            "DUP-DROP",
                            f"slot={slot_idx + 1} mid={mid} age={age_ms}ms",
                        )
                    return
                self._last_fp[mid] = fp
                self._last_fp_time[mid] = now
        if self.on_orderbook_update:
            with self._lock:
                if 0 <= slot_idx < self.num_connections:
                    self._slot_win_counts[slot_idx] += 1
            if self._realtime_log:
                bids = ob.get("bids") or []
                asks = ob.get("asks") or []
                bb = "-"
                ba = "-"
                try:
                    if bids and isinstance(bids[0], (list, tuple)) and len(bids[0]) >= 2:
                        bb = f"{float(bids[0][0]):.4f}@{float(bids[0][1]):.2f}"
                    if asks and isinstance(asks[0], (list, tuple)) and len(asks[0]) >= 2:
                        ba = f"{float(asks[0][0]):.4f}@{float(asks[0][1]):.2f}"
                except (TypeError, ValueError):
                    pass
                self._rt(
                    "FORWARD",
                    f"slot={slot_idx + 1} mid={mid} lvls={len(bids)}/{len(asks)} top={bb}|{ba}",
                )
            try:
                self.on_orderbook_update(mid, ob)
            except Exception as e:
                log_error_to_file(f"on_orderbook_update: {e}", exception=e, context=f"market_id={mid}")

    async def _rebalance_loop(self):
        try:
            first_wait = min(45.0, self._slow_rebalance_sec) if self._slow_rebalance_sec > 0 else 0.0
            if first_wait > 0:
                await asyncio.sleep(first_wait)
            while self._running:
                if not self._running:
                    break
                await self._maybe_rotate_slowest()
                await asyncio.sleep(self._slow_rebalance_sec)
        except asyncio.CancelledError:
            pass

    async def _maybe_rotate_slowest(self):
        """
        Главный механизм «дать жить только быстрым слотам»:
          - смотрим win-счётчики за прошедший интервал,
          - находим лидера (mx) и группу самых медленных,
          - заменяем до K (slow_slots_per_rebalance) слотов, у которых отставание
            от лидера >= slow_min_spread, и при этом mx >= slow_min_top
            (значит вообще была активность).
        Между заменами выдерживаем паузу, чтобы избежать 429 на параллельные connect.
        """
        if self._replace_in_progress or self.num_connections < 2 or self._slow_rebalance_sec <= 0:
            return
        with self._lock:
            wins = list(self._slot_win_counts)
            self._slot_win_counts = [0] * self.num_connections
            self._win_snap = [0] * self.num_connections
        connected = [i for i, c in enumerate(self.clients) if c.connected]
        if len(connected) < 2:
            return
        i_max = max(connected, key=lambda i: wins[i])
        mx = wins[i_max]
        if mx < self._slow_min_top:
            return
        # все слоты, отстающие от лидера на min_spread и больше; включая отключенные/«молчащие»
        candidates = [
            i for i in range(self.num_connections)
            if i != i_max and (mx - wins[i]) >= self._slow_min_spread
        ]
        if not candidates:
            return
        # Сортируем по возрастанию wins (самый медленный первым). При равенстве —
        # «не подключенные» приоритетнее: они либо в reconnect, либо «молчат».
        candidates.sort(key=lambda i: (wins[i], 1 if self.clients[i].connected else 0))
        k = min(self._slow_slots_per_rebalance, len(candidates))
        to_replace = candidates[:k]

        self._replace_in_progress = True
        try:
            wins_str = ", ".join(f"{i+1}:{wins[i]}" for i in to_replace)
            self.log_func(
                f"[WebSocket pool] Rotating {k}/{self.num_connections} slowest slots "
                f"[{wins_str}] vs best {i_max+1}:{mx}"
            )
            self._rt(
                "ROT-PLAN",
                f"replace_k={k} cands=[{wins_str}] leader=slot{i_max + 1}:{mx}",
            )
            for j, idx in enumerate(to_replace):
                if not self._running:
                    break
                if j > 0 and self._rotate_inter_slot_pause_sec > 0:
                    await asyncio.sleep(self._rotate_inter_slot_pause_sec)
                await self._async_replace_slot(idx)
        finally:
            self._replace_in_progress = False

    async def _async_replace_slot(self, idx: int):
        if not self._running or idx < 0 or idx >= len(self.clients):
            return
        old = self.clients[idx]
        subs = list(old.subscriptions.keys())
        diag_print(
            "ws-pool",
            "rebalance: заменяю один слот (остальные не трогаю)",
            f"idx={idx + 1}/{self.num_connections} рынков={len(subs)} → old.stop(), пауза 0.45s, новый клиент",
        )
        self._rt("ROT-START", f"slot={idx + 1} subs={len(subs)} (stop old, pause 0.45s)")
        old.stop()
        await asyncio.sleep(0.45)
        if not self._running:
            return
        new_c = self._create_client(idx, connect_stagger_sec=0.0)
        for mid in subs:
            new_c.subscriptions[mid] = None
        self.clients[idx] = new_c
        if self._loop:
            new_c.start(self._loop)
        self._rt("ROT-DONE", f"slot={idx + 1} new client started")

    @property
    def connected(self) -> bool:
        return any(c.connected for c in self.clients)

    def start(self, loop: asyncio.AbstractEventLoop):
        self._running = True
        self._loop = loop
        diag_print(
            "ws-pool",
            "start: запускаю независимые asyncio-задачи на каждый слот",
            f"n={self.num_connections} stagger_ms={self._stagger_ms} dedupe_sec={self._dedupe_window} slow_rebal={self._slow_rebalance_sec}",
        )
        self._rt(
            "POOL-START",
            f"n={self.num_connections} dedupe={self._dedupe_window}s depth={self._dedupe_depth_levels} "
            f"rebal={self._slow_rebalance_sec}s rot_per_cycle={self._slow_slots_per_rebalance}",
        )
        for c in self.clients:
            c.start(loop)
        if self.num_connections > 1:
            self._status_task = loop.create_task(self._pool_status_loop())
            if self._slow_rebalance_sec > 0:
                self._rebalance_task = loop.create_task(self._rebalance_loop())

    def stop(self):
        self._running = False
        diag_print("ws-pool", "stop: снимаю пул (cancel задач клиентов)", f"n={self.num_connections}")
        self._rt("POOL-STOP", f"n={self.num_connections}")
        if self._status_task and not self._status_task.done():
            self._status_task.cancel()
        self._status_task = None
        if self._rebalance_task and not self._rebalance_task.done():
            self._rebalance_task.cancel()
        self._rebalance_task = None
        self._loop = None
        for c in self.clients:
            c.stop()

    def subscribe_orderbook(self, market_id: str):
        for c in self.clients:
            c.subscribe_orderbook(market_id)
        self._rt("SUBSCRIBE", f"mid={market_id} → {self.num_connections} slots")

    def unsubscribe_orderbook(self, market_id: str):
        with self._lock:
            self._last_fp.pop(market_id, None)
            self._last_fp_time.pop(market_id, None)
        for c in self.clients:
            c.unsubscribe_orderbook(market_id)
        self._rt("UNSUBSCR.", f"mid={market_id}")
