"""XBOST Option-Native Discovery Engine v2 — configuration (spec §20-23)."""
from dataclasses import dataclass, field

@dataclass
class DiscoveryConfig:
    # splits by trading day (spec §21 default 50/20/20/10)
    split_fractions: tuple = (0.5, 0.2, 0.2, 0.1)
    # minimum sample requirements (spec §22, configurable)
    min_raw_occurrences: int = 50
    min_independent_events: int = 20
    min_independent_days: int = 5
    # event clustering (spec §23): signals within N minutes = 1 event
    cluster_minutes: int = 3
    # rolling windows
    return_windows: tuple = (1, 2, 3, 5, 10, 15)
    range_windows: tuple = (3, 5, 10)
    rolling_history: int = 120  # for percentile/z-score normalization (past only)
    # lead/lag (spec §16)
    lags: tuple = (1, 2, 3, 5)
    # sequences (spec §17): lengths 3,4,5 only
    seq_lengths: tuple = (3, 4, 5)
    # forward horizons (spec §14)
    forward_windows: tuple = (1, 3, 5, 10)
    # permutation (spec §26)
    permutation_count: int = 200
    random_seed: int = 42
    # time-of-day buckets (spec §18)
    tod_buckets: tuple = (
        ("09:15-10:00", "09:15", "10:00"),
        ("10:00-11:00", "10:00", "11:00"),
        ("11:00-12:00", "11:00", "12:00"),
        ("12:00-13:00", "12:00", "13:00"),
        ("13:00-14:00", "13:00", "14:00"),
        ("14:00-15:00", "14:00", "15:00"),
        ("15:00-15:30", "15:00", "15:30"),
    )
    # cross-strike focus: top-N strikes by volume when dataset is long-format
    focus_strikes_n: int = 3
    # research price model label (spec §30)
    price_model: str = "RESEARCH_PRICE_MODEL"

CONFIG = DiscoveryConfig()
