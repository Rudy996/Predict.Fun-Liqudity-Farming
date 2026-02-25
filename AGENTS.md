## Cursor Cloud specific instructions

This is a Python 3 tkinter desktop application (Predict.fun liquidity provision bot). No local backend services or databases are required — the app connects to external Predict.fun REST API, WebSocket, and BNB Chain.

### Running the application

```
DISPLAY=:1 python3 main.py
```

The GUI requires a display server. In the cloud VM, `DISPLAY=:1` is already available via Xvfb. The `python3-tk` system package must be installed for tkinter to work.

### Dependencies

Install with `pip install -r requirements.txt`. Key packages: `predict-sdk`, `requests`, `websocket-client`.

### Lint / syntax checks

No project-level linter is configured. Use `pyflakes *.py` or `python3 -m py_compile <file>.py` for quick checks.

### Credentials

The app loads accounts from `accounts.txt` (format: `api_key,predict_account_address,privy_wallet_private_key,proxy`). Without valid accounts, the GUI starts but cannot connect to markets. A placeholder `accounts.txt` with only comments is sufficient for the app to launch without errors.

### Gotchas

- The startup "About developer" dialog (`show_about_dialog`) is modal and blocks the main window until dismissed — click "Закрыть" to proceed.
- `accounts.txt` must exist (even empty/comments-only) or the app prints a "file not found" warning to stdout. The GUI still launches.
- All UI text is in Russian.
