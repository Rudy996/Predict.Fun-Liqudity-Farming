"""
Predict Fun Liquidity Provider - Electron UI
Run: python main.py
"""

import logging


class _NoPredictMakerSigner(logging.Filter):
    def filter(self, record):
        m = (record.getMessage() or "").lower()
        if "maker" in m and "signer" in m and "ignored" in m:
            return False
        return True


_f = _NoPredictMakerSigner()
logging.getLogger("predict_sdk").setLevel(logging.CRITICAL)
logging.getLogger("predict_sdk").addFilter(_f)
logging.getLogger().addFilter(_f)

import warnings

warnings.filterwarnings("ignore", message=".*Predict account.*")
warnings.filterwarnings("ignore", message=".*maker.*signer.*ignored.*")

import builtins
import logger as _logger

builtins.print = _logger.log_print

import os
import sys
import subprocess
import threading
import time
import urllib.request

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ELECTRON_UI_DIR = os.path.join(SCRIPT_DIR, "electron-ui")
SERVER_SCRIPT = os.path.join(SCRIPT_DIR, "server.py")
API_PORT = 8765


def find_python():
    for cmd in ["python", "python3", "py"]:
        try:
            subprocess.run([cmd, "--version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
            return cmd
        except Exception:
            continue
    return None


def find_node():
    for cmd in ["node", "node.exe"]:
        try:
            subprocess.run([cmd, "--version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
            return cmd
        except Exception:
            continue
    return None


def find_npm():
    for cmd in ["npm", "npm.cmd"]:
        try:
            subprocess.run([cmd, "--version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
            return cmd
        except Exception:
            continue
    return None


def wait_for_server(max_retries=30):
    for i in range(max_retries):
        try:
            resp = urllib.request.urlopen(f"http://127.0.0.1:{API_PORT}/api/config", timeout=2)
            if resp.status == 200:
                return True
        except Exception:
            pass
        time.sleep(1)
    return False


def main():
    print("=" * 50)
    print("  Predict Fun Liquidity Provider")
    print("=" * 50)
    print()

    python = find_python()
    if not python:
        print("Error: Python not found!")
        input("Press Enter to exit...")
        return

    node = find_node()
    if not node:
        print("Error: Node.js not found!")
        input("Press Enter to exit...")
        return

    npm = find_npm()
    if not npm:
        print("Error: npm not found!")
        input("Press Enter to exit...")
        return

    print(f"Python: {python}")
    print(f"Node.js: {node}")
    print()

    node_modules = os.path.join(ELECTRON_UI_DIR, "node_modules")
    if not os.path.exists(node_modules):
        print("Installing Electron dependencies...")
        subprocess.run([npm, "install"], cwd=ELECTRON_UI_DIR, check=True)
        print()

    print("Starting FastAPI server...")
    print("  Подробная диагностика: строки с префиксом [diag] в потоке [Server].")
    print("  Выключить: переменная среды PREDICT_FUN_VERBOSE_CONSOLE=0 или в app_state.json console_diagnostics: false")
    print()
    server_proc = subprocess.Popen(
        [python, SERVER_SCRIPT],
        cwd=SCRIPT_DIR,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )

    def server_log_reader():
        for line in server_proc.stdout:
            print(f"  [Server] {line.rstrip()}")

    log_thread = threading.Thread(target=server_log_reader, daemon=True)
    log_thread.start()

    if not wait_for_server():
        print("Error: Server did not start!")
        server_proc.terminate()
        input("Press Enter to exit...")
        return

    print("Server started!")
    print()

    print("Starting Electron UI...")
    try:
        subprocess.run(
            [npm, "run", "dev"],
            cwd=ELECTRON_UI_DIR,
            env={**os.environ, "PREDICT_FUN_SERVER_READY": "1"},
        )
    except KeyboardInterrupt:
        pass
    finally:
        print("\nStopping server...")
        server_proc.terminate()
        try:
            server_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server_proc.kill()
        print("Done.")


if __name__ == "__main__":
    main()
