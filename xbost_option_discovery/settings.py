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
    max_sequence_length: int = 3
    focus_strikes: int = 3
    lag_windows: tuple = (1, 2, 3, 5, 10)
    # validation (§24)
    train_frac: float = 0.5
    validation_frac: float = 0.2
    oos_frac: float = 0.3
    min_oos_events: int = 20
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
                  "target_grid", "trail_grid"):
            v = d.get(k)
            if isinstance(v, tuple):
                d[k] = list(v)
        return d

    def configuration_hash(self):
        return hashlib.sha256(
            json.dumps(self.to_dict(), sort_keys=True).encode()).hexdigest()[:16]

    @classmethod
    def from_dict(cls, d):
        known = {f for f in cls.__dataclass_fields__}
        return cls(**{k: v for k, v in d.items() if k in known})
