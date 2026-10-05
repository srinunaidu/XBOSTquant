"""Iterative frontier search controller + continuous discovery loop state.

Iterative queues only — never unbounded recursion. Every hypothesis gets a
permanent global ID (H000001...); the global test counter is monotonic and
never reset between cycles. Semantic duplicates and parameter-only clones are
detected via canonical hashes and never counted as new discoveries.
"""
import hashlib
import json
import os
import re
import time
from collections import Counter, deque

FRONTIER_STATUSES = ("QUEUED", "EVALUATING", "EVALUATED", "REJECTED",
                     "PROMOTED", "DEFERRED")

CYCLE_STATUSES = ("CYCLE_DISCOVERY_FOUND", "CYCLE_NO_NEW_DISCOVERY",
                  "CYCLE_BUDGET_EXHAUSTED", "CYCLE_ERROR")

UNRESOLVED_CODES = (
    "ENTRY_PROMISING_EXIT_UNRESOLVED",
    "PREDICTIVE_BUT_TRADING_RULE_UNRESOLVED",
    "OOS_PROMISING_BUT_MULTIPLE_TESTING_FAILED",
    "ROBUST_SIGNAL_BUT_EXECUTION_UNAVAILABLE",
    "SHORT_HORIZON_EDGE",
    "TIME_SPECIFIC_EDGE",
    "CHAIN_RELATIONSHIP_PROMISING",
)

EXPLORATION_FAMILIES = (
    "RAW_PRICE", "MOMENTUM", "MEAN_REVERSION", "VOLATILITY", "VOLUME",
    "OPTION_TYPE_RELATIONSHIP", "STRIKE_RELATIONSHIP", "EXPIRY_RELATIONSHIP",
    "CHAIN_STATE", "SEQUENCE", "LEAD_LAG", "DIVERGENCE", "CONVERGENCE",
    "CATCHUP", "TIME_OF_DAY", "REGIME", "CROSS_CONTRACT", "RETURN_PATH",
    "EXIT_STRUCTURE",
)


def canonical_hash(definition: str) -> str:
    """Canonical hash (§5): normalize cosmetic naming so parameter-only clones
    and renamed duplicates map to the same hash."""
    s = str(definition).lower().strip()
    s = re.sub(r"[\s_\-]+", "_", s)
    # unify known aliases: momentum_5 threshold=1  ==  mom5 > 1
    s = s.replace("momentum_", "mom").replace("threshold=", "thr_")
    s = re.sub(r"\s*(>|>=|<|<=|==)\s*", r"\1", s)
    s = re.sub(r"(>=|<=|==|>|<|=)", "_thr_", s)
    s = re.sub(r"_thr_+", "_thr_", s)
    s = re.sub(r"_+", "_", s).strip("_")
    return hashlib.sha256(s.encode()).hexdigest()[:16]


class HypothesisRegistry:
    """Global research memory (§4): tested / rejected / promising /
    oos_rejected / exit_unresolved / robust / validated buckets, family stats,
    candidate hashes. IDs never reused; test count never reset."""

    def __init__(self):
        self.hypotheses = {}  # hid -> record
        self.by_signature = {}
        self.by_hash = {}
        self.clone_groups = {}  # canonical hash -> [hids]
        self.n = 0
        self.global_test_count = 0
        self.equivalence_groups = {}
        self.duplicate_count = 0
        self.clone_count = 0
        self.memory = {"tested": set(), "rejected": set(),
                       "promising": set(), "oos_rejected": set(),
                       "exit_unresolved": set(), "robust": set(),
                       "validated": set()}

    def signature(self, feature_sig, ts_rule, label, direction,
                  contract_scope, entry_rule, exit_rule, track="") -> str:
        return "|".join(str(x) for x in (
            feature_sig, ts_rule, label, direction,
            contract_scope, entry_rule, exit_rule, track))

    def register(self, kind, family, feature_sig, ts_rule="signal-close",
                 label="fwd_ret_5m", direction="long", contract_scope="chain",
                 entry_rule="signal-close", exit_rule="hold5/sl.5/tp1",
                 parent_ids=(), depth=1, reason="depth-1-scan",
                 cycle_id=0, track="") -> dict:
        sig = self.signature(feature_sig, ts_rule, label, direction,
                             contract_scope, entry_rule, exit_rule, track)
        if sig in self.by_signature:
            self.duplicate_count += 1
            hid = self.by_signature[sig]
            return {"hypothesis_id": hid, "duplicate": True,
                    "is_clone": False, "record": self.hypotheses[hid]}
        ch = canonical_hash(sig)
        is_clone = ch in self.by_hash
        if is_clone:
            self.clone_count += 1
        self.n += 1
        hid = f"H{self.n:06d}"
        rec = {"hypothesis_id": hid, "kind": kind, "family": family,
               "track": track,
               "feature_signature": str(feature_sig),
               "timestamp_rule": ts_rule, "label": label,
               "direction": direction, "contract_scope": contract_scope,
               "entry_rule": entry_rule, "exit_rule": exit_rule,
               "parent_ids": list(parent_ids), "combination_depth": int(depth),
               "reason_added": reason, "status": "REGISTERED",
               "canonical_hash": ch, "is_clone": bool(is_clone),
               "cycle_id": int(cycle_id)}
        self.hypotheses[hid] = rec
        self.by_signature[sig] = hid
        self.by_hash.setdefault(ch, hid)
        self.clone_groups.setdefault(ch, []).append(hid)
        self.equivalence_groups.setdefault(family, []).append(hid)
        self.memory["tested"].add(hid)
        return {"hypothesis_id": hid, "duplicate": False,
                "is_clone": bool(is_clone), "record": rec}

    def mark(self, hid, bucket):
        if hid in self.hypotheses and bucket in self.memory:
            self.memory[bucket].add(hid)

    def count_test(self, k=1):
        self.global_test_count += int(k)
        return self.global_test_count


class FrontierQueue:
    """Persistent frontier queue with research-priority scoring, diversity
    quotas, hard family stops, and unresolved-reason routing."""

    def __init__(self, max_family_share=0.30, max_size=5000):
        self.items = {}  # hid -> item
        self.max_family_share = float(max_family_share)
        self.max_size = int(max_size)
        self.stopped_families = set()  # >50% hard stop for next cycle
        self.dropped_overflow = 0

    def add(self, hid, family, feature_sig, depth, reason, train=0.0,
            val=0.0, oos=0.0, robust=0.0, parent_ids=(),
            unresolved_code="", next_action="evaluate"):
        if hid in self.items:
            return False
        if len(self.items) >= self.max_size:
            # queue-size limit (§29): drop lowest-priority QUEUED item
            queued = [it for it in self.items.values()
                      if it["status"] == "QUEUED"]
            if queued:
                worst = min(queued, key=lambda x: x.get("priority", 0.0))
                del self.items[worst["hypothesis_id"]]
                self.dropped_overflow += 1
            else:
                self.dropped_overflow += 1
                return False
        info = float(val) if val == val else 0.0
        item = {"hypothesis_id": hid, "parent_hypotheses": list(parent_ids),
                "family": family, "feature_signature": str(feature_sig),
                "combination_depth": int(depth), "reason_added": reason,
                "reason_promising": reason,
                "reason_unresolved": unresolved_code,
                "unresolved_code": unresolved_code,
                "next_action": next_action,
                "train_score": train, "validation_score": val,
                "OOS_score": oos, "robustness_score": robust,
                "priority": 0.0, "research_priority_score": 0.0,
                "status": "QUEUED",
                "information_gain": info, "novelty": 1.0}
        self.items[hid] = item
        return True

    def research_priority_score(self, item, family_counts, total,
                                sample_quality=1.0, exec_ok=False):
        """§23: determines investigation order ONLY — never overrides gates."""
        fam_share = (family_counts.get(item["family"], 0) / max(1, total))
        diversity = max(0.0, 1.0 - fam_share * 2.0)
        unresolved_boost = 0.2 if item.get("unresolved_code") else 0.0
        s = (0.25 * max(0.0, item.get("information_gain", 0.0))
             + 0.20 * max(0.0, item.get("validation_score", 0.0) or 0.0)
             + 0.15 * max(0.0, item.get("OOS_score", 0.0) or 0.0)
             + 0.10 * max(0.0, item.get("robustness_score", 0.0) or 0.0)
             + 0.10 * diversity
             + 0.10 * item.get("novelty", 1.0)
             + 0.05 * sample_quality
             + 0.05 * (1.0 if exec_ok else 0.0)
             + unresolved_boost)
        item["research_priority_score"] = s
        item["priority"] = s
        return s

    # legacy alias
    def compute_priority(self, item, family_counts, total):
        return self.research_priority_score(item, family_counts, total)

    def family_quota_ok(self, family, family_counts, total):
        if total == 0:
            return True
        share = family_counts.get(family, 0) / total
        return share < self.max_family_share

    def update_family_stops(self, fam_counts, total):
        """§7: >50% share hard-stops that family for the next cycle."""
        self.stopped_families = {
            f for f, c in fam_counts.items()
            if total > 0 and c / total > 0.50}
        return self.stopped_families

    def pop_batch(self, k, family_counts=None):
        queued = [it for it in self.items.values()
                  if it["status"] == "QUEUED"
                  and it["family"] not in self.stopped_families]
        for it in queued:
            self.research_priority_score(it, family_counts or {},
                                         len(self.items))
        queued.sort(key=lambda x: -x["priority"])
        return queued[:k]

    def exit_unresolved_items(self):
        return [it for it in self.items.values()
                if it.get("unresolved_code") == "ENTRY_PROMISING_EXIT_UNRESOLVED"
                and it["status"] == "QUEUED"]

    def set_status(self, hid, status):
        assert status in FRONTIER_STATUSES, status
        if hid in self.items:
            self.items[hid]["status"] = status

    def size(self, statuses=("QUEUED", "EVALUATING")):
        return sum(1 for it in self.items.values() if it["status"] in statuses)

    def to_json(self):
        return list(self.items.values())

    def load(self, items):
        for it in items or []:
            self.items[it["hypothesis_id"]] = it


class ConvergenceChecker:
    """Convergence ONLY if frontier empty AND no new family AND deltas < eps
    AND diversity saturated AND exit/trading-rule research exhausted."""

    def __init__(self, n=3, epsilon=0.01):
        self.n = int(n)
        self.eps = float(epsilon)
        self.history = deque(maxlen=max(3, int(n) * 2))

    def update(self, frontier_size, new_families, best_val_delta,
               best_oos_delta, diversity_saturated,
               exit_exhausted=True, trading_exhausted=True,
               best_train_delta=0.0):
        self.history.append({
            "frontier_size": int(frontier_size),
            "new_families": int(new_families),
            "best_train_delta": float(best_train_delta or 0.0),
            "best_val_delta": float(best_val_delta or 0.0),
            "best_oos_delta": float(best_oos_delta or 0.0),
            "diversity_saturated": bool(diversity_saturated),
            "exit_exhausted": bool(exit_exhausted),
            "trading_exhausted": bool(trading_exhausted)})
        if len(self.history) < self.n:
            return False
        tail = list(self.history)[-self.n:]
        return all(
            t["frontier_size"] == 0
            and t["new_families"] == 0
            and abs(t["best_train_delta"]) < self.eps
            and abs(t["best_val_delta"]) < self.eps
            and abs(t["best_oos_delta"]) < self.eps
            and t["diversity_saturated"]
            and t["exit_exhausted"]
            and t["trading_exhausted"] for t in tail)

    def drain_converged(self):
        if not self.history:
            return False
        t = self.history[-1]
        return (t["frontier_size"] == 0 and t["new_families"] == 0
                and abs(t["best_train_delta"]) < self.eps
                and abs(t["best_val_delta"]) < self.eps
                and abs(t["best_oos_delta"]) < self.eps)


class Watchdog:
    """§29 engine-error protection: round timeout, candidate timeout,
    memory check, heartbeat."""

    def __init__(self, round_timeout_s=600.0, candidate_timeout_s=120.0,
                 memory_budget_mb=2048.0):
        self.round_timeout_s = float(round_timeout_s)
        self.candidate_timeout_s = float(candidate_timeout_s)
        self.memory_budget_mb = float(memory_budget_mb)
        self.round_start = time.time()
        self.candidate_start = time.time()
        self.heartbeats = 0

    def start_round(self):
        self.round_start = time.time()

    def start_candidate(self):
        self.candidate_start = time.time()

    def round_expired(self):
        return (time.time() - self.round_start) > self.round_timeout_s

    def candidate_expired(self):
        return (time.time() - self.candidate_start) > self.candidate_timeout_s

    def memory_mb(self):
        try:
            import psutil as _p
            return _p.Process().memory_info().rss / 1e6
        except Exception:
            return float("nan")

    def memory_ok(self):
        m = self.memory_mb()
        return not (m == m and m > self.memory_budget_mb)

    def heartbeat(self):
        self.heartbeats += 1
        return {"heartbeat": self.heartbeats,
                "round_elapsed": round(time.time() - self.round_start, 1),
                "memory_mb": self.memory_mb()}


class SearchController:
    """Adaptive budget controller: soft targets may expand to hard ceilings
    while unresolved frontier remains and runtime remains."""

    def __init__(self, settings, t_start=None):
        self.s = settings
        self.t_start = t_start or time.time()
        self.round_logs = []

    def elapsed(self):
        return time.time() - self.t_start

    def remaining(self):
        return float(self.s.maxRuntimeSeconds) - self.elapsed()

    def soft_candidate_limit(self):
        return int(getattr(self.s, "soft_candidate_budget", 0)
                   or self.s.maxTotalCandidates)

    def hard_candidate_limit(self):
        return int(getattr(self.s, "hard_candidate_ceiling", 0)
                   or self.s.maxTotalCandidates)

    def hard_round_limit(self):
        return int(getattr(self.s, "hard_round_ceiling", 0)
                   or self.s.maxRounds)

    def may_expand_budget(self, frontier_size):
        return frontier_size > 0 and self.remaining() > 60.0

    def effective_candidate_limit(self, frontier_size, n_candidates):
        soft = self.soft_candidate_limit()
        if n_candidates < soft:
            return soft
        if self.may_expand_budget(frontier_size):
            return self.hard_candidate_limit()
        return soft

    def should_stop(self, n_rounds, n_candidates, frontier_size, converged):
        if converged:
            return True, "CONVERGED"
        if n_rounds >= self.hard_round_limit():
            return True, "HARD_ROUND_CEILING"
        if n_candidates >= self.hard_candidate_limit():
            return True, "HARD_CANDIDATE_CEILING"
        if self.remaining() <= 0:
            return True, "RUNTIME_EXHAUSTED"
        soft_rounds = int(self.s.maxRounds)
        soft_cands = self.soft_candidate_limit()
        if n_rounds >= soft_rounds and frontier_size == 0:
            return True, "SOFT_BUDGET_CONVERGED"
        if (n_rounds >= soft_rounds or n_candidates >= soft_cands) \
                and not self.may_expand_budget(frontier_size):
            return True, "BUDGET_NO_REMAINING"
        return False, ""


def build_next_cycle_plan(frontier, fam_counts, explored_fams,
                          blocked_fams, discoveries):
    """§27 NEXT_CYCLE_PLAN consumed automatically by the next cycle."""
    top_unresolved = sorted(
        [it for it in frontier.to_json() if it["status"] == "QUEUED"],
        key=lambda x: -x.get("priority", 0.0))[:10]
    total = max(1, sum(fam_counts.values()))
    over = [f for f, c in fam_counts.items() if c / total > 0.30]
    under = [f for f in EXPLORATION_FAMILIES
             if f not in explored_fams and f not in blocked_fams]
    return {
        "top_unresolved": [
            {"hypothesis_id": it["hypothesis_id"], "family": it["family"],
             "unresolved_code": it.get("unresolved_code", ""),
             "next_action": it.get("next_action", "evaluate"),
             "priority": round(it.get("priority", 0.0), 4)}
            for it in top_unresolved],
        "families_needing_exploration": under,
        "families_over_explored": over,
        "families_blocked": sorted(blocked_fams),
        "new_feature_proposals": [f"explore:{f}" for f in under[:5]],
        "new_exit_tests": int(sum(
            1 for it in frontier.to_json()
            if it.get("unresolved_code") == "ENTRY_PROMISING_EXIT_UNRESOLVED")),
        "recent_discoveries": discoveries[-5:],
    }


def save_checkpoint(path, payload):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(payload, f, indent=1, default=str)
    os.replace(tmp, path)


def load_checkpoint(path):
    with open(path) as f:
        return json.load(f)


class MethodMemory:
    """§19: learn from failure. Per-method attempts/coverage/signals/
    survivors/failures steer priority — failed methods deprioritize,
    exit-unresolved methods boost exit research. Never reruns blindly."""

    def __init__(self):
        self.methods = {}

    def _m(self, mid, requirements=""):
        return self.methods.setdefault(mid, {
            "method_id": mid, "data_requirements": requirements,
            "attempts": 0, "eligible_rows": 0, "coverage": 0.0,
            "signals_found": 0, "oos_survivors": 0, "validated_edges": 0,
            "failure_state": "", "failure_reason": "",
            "compute_total": 0.0, "average_compute": 0.0})

    def record(self, mid, eligible_rows, coverage, found_signal=False,
               oos_survived=False, validated=False, failure_state="",
               reason="", compute_s=0.0, requirements=""):
        m = self._m(mid, requirements)
        m["attempts"] += 1
        m["eligible_rows"] = int(eligible_rows)
        m["coverage"] = float(coverage)
        m["signals_found"] += int(bool(found_signal))
        m["oos_survivors"] += int(bool(oos_survived))
        m["validated_edges"] += int(bool(validated))
        if failure_state:
            m["failure_state"] = failure_state
            m["failure_reason"] = reason
        m["compute_total"] += float(compute_s)
        m["average_compute"] = m["compute_total"] / max(1, m["attempts"])
        return m

    def priority(self, mid, novelty=1.0, remaining=1.0):
        """§8: coverage × sample × history × novelty / cost (research
        prioritization only, never a trading-performance score). Untried
        methods score ~1.0; productive history raises, structural blocks
        lower steeply."""
        m = self.methods.get(mid)
        if m is None:
            return novelty * remaining
        cov = max(0.2, min(1.0, m["coverage"] * 10.0))
        samp = min(1.0, m["eligible_rows"] / 200.0)
        hist = 1.0 + m["signals_found"] - 2.0 * (
            m["attempts"] - m["signals_found"]) * 0.25
        hist = max(0.1, hist)
        if m["failure_state"] in ("NO_MATCHING_ROWS", "INSUFFICIENT_DATA",
                                  "UNSUPPORTED_METHOD", "INSUFFICIENT_VARIATION"):
            hist *= 0.2  # structurally blocked: deprioritize hard
        cost = max(0.5, m["average_compute"] * 10.0)
        return max(0.01, cov * samp * hist * novelty * remaining / cost)

    def to_json(self):
        return list(self.methods.values())

    def load(self, items):
        for it in items or []:
            self.methods[it["method_id"]] = it


# §4 relationship fallback chain: relax stepwise, never repeat impossibles
FALLBACK_CHAIN = ("cross_expiry", "same_expiry", "same_strike_cepe",
                  "adjacent_strike", "single_contract_temporal")


def next_fallback(failed_level, tried):
    """Return the next untried fallback level, or None when exhausted."""
    try:
        i = FALLBACK_CHAIN.index(failed_level)
    except ValueError:
        i = -1
    for lvl in FALLBACK_CHAIN[i + 1:]:
        if lvl not in tried:
            return lvl
    return None
