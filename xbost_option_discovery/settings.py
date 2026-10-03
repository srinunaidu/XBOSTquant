"""Run settings (§7, §47). Every control is optional; defaults are configuration,
not dataset values. Settings are hashed for reproducibility."""
import hashlib
import json
from dataclasses import dataclass, field, asdict

@dataclass
class DiscoverySettings:
    # data scope (None = all discovered)
    data_path: str = ""
    date_from: str = ""
    date_to: str = ""
    expiries: list = field(default_factory=list)
    symbols: list = field(default_factory=list)
    strikes: list = field(default_factory=list)
    option_types: list = field(default_factory=list)
    # timeframe (§6)
    timeframe: str = "RAW"          # RAW or e.g. 5m
    align_grid: bool = False       # session-grid alignment (available, opt-in)
    grid_freq: str = "1min"
    min_joint_snapshots: int = 200  # honest synchronization gate threshold
    # liquidity/quality filters
    min_price: float = 0.0
    max_price: float = 1e12
    min_volume: float = 0.0
    min_oi: float = 0.0
    min_chain_completeness: float = 0.0
    # discovery
    forward_horizons: tuple = (1, 3, 5, 10, 15)
    event_zscore: float = 2.5
    divergence_threshold: float = 2.0
    min_events: int = 50
    cluster_minutes: int = 3
    surrogate_perms: int = 200
    max_sequence_length: int = 3
    focus_strikes: int = 3
    lag_windows: tuple = (1, 2, 3, 5, 10)
    allow_short: bool = False       # short-premium variants (opt-in)
    # validation (§24)
    train_frac: float = 0.5
    validation_frac: float = 0.2
    oos_frac: float = 0.3
    embargo_days: int = 0         # serial-correlation guard (0 = off)
    min_oos_events: int = 20
    paper_min_oos_events: int = 20
    cv_folds: int = 0               # purged K-fold OOS (0 = single split)
    dsr_threshold: float = 0.95
    min_fold_win_rate: float = 0.6
    corr_threshold: float = 0.99
    use_effective_n: bool = True
    hierarchical_fdr_alpha: float = 0.10
    # execution economics (RESEARCH_PRICE_MODEL default: costs informational)
    cost_mode: str = "ZERO"        # ZERO | REALISTIC
    cost_preset: str = "BANKNIFTY_OPT"
    lot_size: int = 15
    slippage_bps: float = 5.0
    brokerage_per_order: float = 20.0
    capital: float = 500000.0
    entry_fill: str = "close"       # close | next_open
    eod_square_off: bool = False
    # search controller (§4/§5/§44/§45): HARD SAFETY LIMITS, not stop targets
    maxRounds: int = 24
    maxTotalCandidates: int = 500
    maxRuntimeSeconds: float = 3600.0
    maxRawCandidatesPerRound: int = 60
    maxCombinationDepth: int = 3
    maxFeatureCombinations: int = 200
    maxPairCombinations: int = 120
    maxTripleCombinations: int = 80
    maxQuadCombinations: int = 40
    maxEvaluationBatch: int = 50
    minimumExplorationFraction: float = 0.30
    exploitFraction: float = 0.70
    topKConditional: int = 10
    # soft/hard budget adaptation (§44)
    soft_candidate_budget: int = 500
    hard_candidate_ceiling: int = 10000
    hard_round_ceiling: int = 200
    # convergence (§5/§46)
    convergence_N: int = 3
    convergence_epsilon: float = 0.01
    # diversity (§7)
    max_family_share: float = 0.30
    # exit discovery (§11)
    hold_grid: tuple = (1, 2, 3, 5, 8, 10, 15, 20, 30)
    stop_grid: tuple = (0.25, 0.5, 1.0, 1.5)
    target_grid: tuple = (0.5, 1.0, 2.0, 3.0)
    trail_grid: tuple = (0.5, 1.0)
    # OPTION_EXIT_DISCOVERY grids (§3/§5): research values, never defaults
    stop_pct_grid: tuple = (0.25, 0.5, 1.0, 1.5, 2.0)
    atr_stop_mults: tuple = (0.5, 1.0, 1.5)
    target_pct_grid: tuple = (0.5, 1.0, 2.0, 3.0)
    atr_target_mults: tuple = (0.5, 1.0, 1.5)
    trail_values: tuple = (0.5, 1.0)
    breakeven_triggers: tuple = (0.3, 0.5)
    trail_delays: tuple = (2, 3)
    profit_gates: tuple = (0.5, 1.0)
    max_exit_combos_per_entry: int = 40
    # contract universe budget (§9)
    max_contracts_per_hypothesis: int = 0  # 0 = all usable contracts
    # memory budget (§24/§29)
    memory_budget_mb: float = 2048.0
    # multiple testing / surrogates (§28/§36)
    n_perm: int = 200
    # checkpointing (§53)
    checkpoint_dir: str = ""
    resume_from: str = ""
    # execution (§17/28)
    cost_mode: str = "ZERO"        # ZERO | SPREAD (requires bid/ask)
    price_model: str = "RESEARCH_PRICE_MODEL"
    exit_sl_pct: float = 0.5
    exit_tp_pct: float = 1.0
    exit_hold_bars: int = 5
    # ranking (§42)
    ranking_objective: str = "composite"
    max_candidates: int = 200
    robustness_level: str = "standard"
    # reproducibility
    random_seed: int = 42
    engine_version: str = "od-tab-v1"
    feature_version: str = "dyn-v1"

    def to_dict(self):
        d = asdict(self)
        for k in ("forward_horizons", "lag_windows", "hold_grid", "stop_grid",
                  "target_grid", "trail_grid", "stop_pct_grid",
                  "atr_stop_mults", "target_pct_grid", "atr_target_mults",
                  "trail_values", "breakeven_triggers", "trail_delays",
                  "profit_gates"):
            v = d.get(k)
            if isinstance(v, tuple):
                d[k] = list(v)
        return d

    # budget aliases (§16/§17): SOFT/HARD candidate limits, soft/hard rounds
    @property
    def SOFT_CANDIDATE_LIMIT(self):
        return self.soft_candidate_budget

    @property
    def HARD_CANDIDATE_LIMIT(self):
        return self.hard_candidate_limit if hasattr(
            self, "hard_candidate_limit") else self.hard_candidate_ceiling

    @property
    def softMaxRounds(self):
        return self.maxRounds

    @property
    def hardMaxRounds(self):
        return self.hard_round_ceiling

    def configuration_hash(self):
        return hashlib.sha256(
            json.dumps(self.to_dict(), sort_keys=True).encode()).hexdigest()[:16]

    @classmethod
    def from_dict(cls, d):
        known = {f for f in cls.__dataclass_fields__}
        return cls(**{k: v for k, v in d.items() if k in known})
