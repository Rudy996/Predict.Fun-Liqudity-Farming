"""Account loading and saving"""

from config import ACCOUNTS_FILE


def save_accounts_to_file(accounts: list, file_path: str = ACCOUNTS_FILE) -> None:
    """Saves accounts to file. Format: api_key,address,privy_key,proxy"""
    try:
        with open(file_path, "w", encoding="utf-8") as f:
            for acc in accounts:
                parts = [
                    (acc.get("api_key") or "").strip(),
                    (acc.get("predict_account_address") or "").strip(),
                    (acc.get("privy_wallet_private_key") or "").strip(),
                    (acc.get("proxy") or "").strip(),
                ]
                f.write(",".join(parts) + "\n")
    except Exception as e:
        print(f"Error saving {file_path}: {e}")


def load_accounts_from_file(file_path: str = ACCOUNTS_FILE) -> list:
    """Format: api_key,predict_account_address,privy_wallet_private_key,proxy"""
    accounts = []
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = [p.strip() for p in line.split(",")]
                if len(parts) < 3:
                    continue
                api_key, predict_addr, privy_key = parts[0], parts[1], parts[2]
                proxy = parts[3] if len(parts) > 3 else None
                if not predict_addr.startswith("0x"):
                    continue
                accounts.append({
                    "api_key": api_key,
                    "predict_account_address": predict_addr,
                    "privy_wallet_private_key": privy_key,
                    "proxy": proxy,
                })
    except FileNotFoundError:
        pass
    except Exception as e:
        print(f"Error reading {file_path}: {e}")
    return accounts
