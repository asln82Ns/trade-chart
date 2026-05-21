"""Static asset configuration for the supported futures.

min_qty_increment: smallest position-sizing step. Drives the trade UI's
quantity step + validation. Picked per-asset to mirror the smallest CME
contract size relative to the standard:
  * 0.1 — a 1/10-size micro exists at CME (MNG, MCL, MNQ, MYM, MGC, MHG,
    M6E, M6B, MCD, M6S, MJY). 0.1 standard = 1 micro, P&L tracks 1:1 modulo
    spread/commissions.
  * 0.2 — Silver: SIL is 1/5 of SI. Even-tenths (0.2/0.4/...) snap to
    integer SIL count; 0.1 wouldn't.
  * 1.0 — no clean micro available (HO, PL, 6N), or the contract is
    already a micro (MBT). Treat as integer-only.
"""

ASSETS = {
    "NG": {
        "name": "Natural Gas",
        "description": "NYMEX Natural Gas",
        "dataset": "GLBX.MDP3",
        "tick_size": 0.001,
        "point_value": 10000.0,
        "month_codes": "FGHJKMNQUVXZ",
        "price_decimals": 3,
        "min_qty_increment": 0.1,
    },
    "CL": {
        "name": "Crude Oil",
        "description": "NYMEX WTI Crude",
        "dataset": "GLBX.MDP3",
        "tick_size": 0.01,
        "point_value": 1000.0,
        "month_codes": "FGHJKMNQUVXZ",
        "price_decimals": 2,
        "min_qty_increment": 0.1,
    },
    "HO": {
        "name": "ULSD (Heating Oil)",
        "description": "NYMEX NY Harbor ULSD",
        "dataset": "GLBX.MDP3",
        "tick_size": 0.0001,
        "point_value": 42000.0,
        "month_codes": "FGHJKMNQUVXZ",
        "price_decimals": 4,
        "min_qty_increment": 1.0,
    },
    "NQ": {
        "name": "Nasdaq 100 E-mini",
        "description": "CME E-mini Nasdaq 100",
        "dataset": "GLBX.MDP3",
        "tick_size": 0.25,
        "point_value": 20.0,
        "month_codes": "HMUZ",
        "price_decimals": 2,
        "min_qty_increment": 0.1,
    },
    "YM": {
        "name": "Dow E-mini",
        "description": "CBOT E-mini Dow",
        "dataset": "GLBX.MDP3",
        "tick_size": 1.0,
        "point_value": 5.0,
        "month_codes": "HMUZ",
        "price_decimals": 0,
        "min_qty_increment": 0.1,
    },
    "NKD": {
        "name": "Nikkei 225 (USD)",
        "description": "CME Nikkei 225 Dollar",
        "dataset": "GLBX.MDP3",
        "tick_size": 5.0,              # 5.00 index points = $25.00 per contract
        "point_value": 5.0,            # $5.00 per index point
        "month_codes": "HMUZ",         # quarterly March cycle
        "price_decimals": 0,
        "min_qty_increment": 0.1,      # MNK (Micro Nikkei USD) is 1/10 of NKD
    },
    "GC": {
        "name": "Gold",
        "description": "COMEX Gold",
        "dataset": "GLBX.MDP3",
        "tick_size": 0.10,
        "point_value": 100.0,
        "month_codes": "GJMQVZ",
        "price_decimals": 1,
        "min_qty_increment": 0.1,
    },
    "SI": {
        "name": "Silver",
        "description": "COMEX Silver",
        "dataset": "GLBX.MDP3",
        "tick_size": 0.005,
        "point_value": 5000.0,
        "month_codes": "FGHJKMNQUVXZ",
        "price_decimals": 3,
        "min_qty_increment": 0.2,
    },
    "HG": {
        "name": "Copper",
        "description": "COMEX Copper",
        "dataset": "GLBX.MDP3",
        "tick_size": 0.0005,           # $0.0005/lb = $12.50 per 25,000 lb contract
        "point_value": 25000.0,
        "month_codes": "HKNUZ",        # active delivery cycle: Mar/May/Jul/Sep/Dec
        "price_decimals": 4,
        "min_qty_increment": 0.1,      # MHG (Micro Copper) is 1/10 of HG
    },
    "PL": {
        "name": "Platinum",
        "description": "NYMEX Platinum",
        "dataset": "GLBX.MDP3",
        "tick_size": 0.10,
        "point_value": 50.0,
        "month_codes": "FJNV",
        "price_decimals": 1,
        "min_qty_increment": 1.0,
    },
    "MBT": {
        "name": "Micro Bitcoin",
        "description": "CME Micro Bitcoin",
        "dataset": "GLBX.MDP3",
        "tick_size": 5.0,
        "point_value": 0.10,
        "month_codes": "FGHJKMNQUVXZ",
        "price_decimals": 0,
        "min_qty_increment": 1.0,
    },
    "6E": {
        "name": "Euro FX",
        "description": "CME Euro FX",
        "dataset": "GLBX.MDP3",
        "tick_size": 0.00005,
        "point_value": 125000.0,
        "month_codes": "HMUZ",
        "price_decimals": 5,
        "min_qty_increment": 0.1,
    },
    "6B": {
        "name": "British Pound",
        "description": "CME British Pound",
        "dataset": "GLBX.MDP3",
        "tick_size": 0.0001,
        "point_value": 62500.0,
        "month_codes": "HMUZ",
        "price_decimals": 4,
        "min_qty_increment": 0.1,
    },
    "6C": {
        "name": "Canadian Dollar",
        "description": "CME Canadian Dollar",
        "dataset": "GLBX.MDP3",
        "tick_size": 0.00005,
        "point_value": 100000.0,
        "month_codes": "HMUZ",
        "price_decimals": 5,
        "min_qty_increment": 0.1,
    },
    "6S": {
        "name": "Swiss Franc",
        "description": "CME Swiss Franc",
        "dataset": "GLBX.MDP3",
        "tick_size": 0.0001,
        "point_value": 125000.0,
        "month_codes": "HMUZ",
        "price_decimals": 4,
        "min_qty_increment": 0.1,
    },
    "6J": {
        "name": "Japanese Yen",
        "description": "CME Japanese Yen",
        "dataset": "GLBX.MDP3",
        "tick_size": 0.0000005,
        "point_value": 12500000.0,
        "month_codes": "HMUZ",
        "price_decimals": 7,
        "min_qty_increment": 0.1,
    },
    "6N": {
        "name": "New Zealand Dollar",
        "description": "CME New Zealand Dollar",
        "dataset": "GLBX.MDP3",
        "tick_size": 0.0001,
        "point_value": 100000.0,
        "month_codes": "HMUZ",
        "price_decimals": 4,
        "min_qty_increment": 1.0,
    },
    "6A": {
        "name": "Australian Dollar",
        "description": "CME Australian Dollar",
        "dataset": "GLBX.MDP3",
        "tick_size": 0.0001,           # $0.0001/AUD = $10.00 per 100,000 AUD
        "point_value": 100000.0,
        "month_codes": "HMUZ",
        "price_decimals": 4,
        "min_qty_increment": 0.1,      # M6A (Micro AUD) is 1/10 of 6A
    },
}

# Standard CME month-to-letter mapping.
MONTH_LETTER = {
    1: "F", 2: "G", 3: "H", 4: "J", 5: "K", 6: "M",
    7: "N", 8: "Q", 9: "U", 10: "V", 11: "X", 12: "Z",
}
LETTER_MONTH = {v: k for k, v in MONTH_LETTER.items()}


def get_asset(symbol: str) -> dict:
    symbol = symbol.upper()
    if symbol not in ASSETS:
        raise KeyError(f"Unknown asset: {symbol}. Supported: {list(ASSETS)}")
    return ASSETS[symbol]


def list_assets() -> list[dict]:
    return [
        {
            "symbol": sym,
            "name": cfg["name"],
            "description": cfg["description"],
            "tick_size": cfg["tick_size"],
            "point_value": cfg["point_value"],
            "price_decimals": cfg["price_decimals"],
            "min_qty_increment": cfg.get("min_qty_increment", 1.0),
        }
        for sym, cfg in ASSETS.items()
    ]
