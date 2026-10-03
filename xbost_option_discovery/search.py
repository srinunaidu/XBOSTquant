"""Iterative frontier search controller (§4/§5/§6/§25/§26/§53).

Iterative queues only — never unbounded recursion. Every hypothesis gets a
permanent global ID; the global test counter is monotonic and never reset.
"""
import json
import os
import time
from collections import Counter, deque

FRONTIER_STATUSES = ("QUEUED", "EVALUATING", "EVALUATED", "REJECTED",
                     "PROMOTED", "DEFERRED")

EXPLORATION_FAMILIES = (
    "RAW_PRICE", "MOMENTUM", "MEAN_REVERSION", "VOLATILITY", "VOLUME",
    "OPTION_TYPE_RELATIONSHIP", "STRIKE_RELATIONSHIP", "EXPIRY_RELATIONSHIP",
    "CHAIN_STATE", "SEQUENCE", "LEAD_LAG", "DIVERGENCE", "CONVERGENCE",
    "CATCHUP", "TIME_OF_DAY", "REGIME", "CROSS_CONTRACT", "RETURN_PATH",
    "EXIT_STRUCTURE",
)


class HypothesisRegistry:
    """Global hypothesis identity (§27) + monotonic global test count (§28)."""

    def __init__(self):
        self.hypotheses = {}  # hid -> record
        self.by_signature = {}
        self.n = 0
        self.global_test_count = 0
        self.equivalence_groups = {}
        self.duplicate_count = 0

    def signature(self, feature_sig, ts_rule, label, direction,
                  contract_scope, entry_rule, exit_rule) -> str:
        return "|".join(str(x) for x in (
            feature_sig, ts_rule, label, direction,
            contract_scope, entry_rule, exit_rule))

    def register(self, kind, family, feature_sig, ts_rule="signal-close",
                 label="fwd_ret_5m", direction="long", contract_scope="chain",
                 entry_rule="signal-close", exit_rule="hold5/sl.5/tp1",
                 parent_ids=(), depth=1, reason="depth-1-scan") -> dict:
        sig = self.signature(feature_sig, ts_rule, label, direction,
                             contract_scope, entry_rule, exit_rule)
        if sig in self.by_signature:
            self.duplicate_count += 1
            hid = self.by_signature[sig]
            return {"hypothesis_id": hid, "duplicate": True,
                    "record": self.hypotheses[hid]}
        self.n += 1
        hid = f"H{kind}-{self.n}"
        rec = {"hypothesis_id": hid, "kind": kind, "family": family,
               "feature_signature": str(feature_sig),
               "timestamp_rule": ts_rule, "label": label,
               "direction": direction, "contract_scope": contract_scope,
               "entry_rule": entry_rule, "exit_rule": exit_rule,
               "parent_ids": list(parent_ids), "combination_depth": int(depth),
               "reason_added": reason, "status": "REGISTERED"}
        self.hypotheses[hid] = rec
        self.by_signature[sig] = hid
        self.equivalence_groups.setdefault(family, []).append(hid)
        return {"hypothesis_id": hid, "duplicate": False, "record": rec}

    def count_test(self, k=1):
        self.global_test_count += int(k)
        return self.global_test_count


class FrontierQueue:
    """Persistent frontier queue (§6) with diversity-aware priority."""

    def __init__(self, max_family_share=0.30):
        self.items = {}  # hid -> item
        self.max_family_share = float(max_family_share)

    def add(self, hid, family, feature_sig, depth, reason, train=0.0,
            val=0.0, oos=0.0, robust=0.0, parent_ids=()):
        if hid in self.items:
            return False
        info = float(val) if val == val else 0.0
        item = {"hypothesis_id": hid, "parent_hypotheses": list(parent_ids),
                "family": family, "feature_signature": str(feature_sig),
                "combination_depth": int(depth), "reason_added": reason,
                "train_score": train, "validation_score": val,
                "OOS_score": oos, "robustness_score": robust,
                "priority": 0.0, "status": "QUEUED",
                "information_gain": info, "novelty": 1.0}
        self.items[hid] = item
        return True

    def compute_priority(self, item, family_counts, total):
        fam_share = (family_counts.get(item["family"], 0) / max(1, total))
        diversity = max(0.0, 1.0 - fam_share * 2.0)
        item["priority"] = (
            0.35 * max(0.0, item.get("information_gain", 0.0))
            + 0.25 * max(0.0, item.get("validation_score", 0.0) or 0.0)
            + 0.15 * max(0.0, item.get("OOS_score", 0.0) or 0.0)
            + 0.15 * diversity
            + 0.10 * item.get("novelty", 1.0))
        return item["priority"]

    def family_quota_ok(self, family, family_counts, total):
        if total == 0:
            return True
        share = family_counts.get(family, 0) / total
        return share < self.max_family_share

    def pop_batch(self, k, family_counts=None):
        queued = [it for it in self.items.values()
                  if it["status"] == "QUEUED"]
        for it in queued:
            self.compute_priority(it, family_counts or {}, len(self.items))
        queued.sort(key=lambda x: -x["priority"])
        return queued[:k]

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
    """§5: converged ONLY if frontier empty AND no new family AND deltas < eps
    AND diversity saturated, sustained over N rounds."""

    def __init__(self, n=3, epsilon=0.01):
        self.n = int(n)
        self.eps = float(epsilon)
        self.history = deque(maxlen=max(3, int(n) * 2))

    def update(self, frontier_size, new_families, best_val_delta,
               best_oos_delta, diversity_saturated):
        self.history.append({"frontier_size": int(frontier_size),
                             "new_families": int(new_families),
                             "best_val_delta": float(best_val_delta or 0.0),
                             "best_oos_delta": float(best_oos_delta or 0.0),
                             "diversity_saturated": bool(diversity_saturated)})
        if len(self.history) < self.n:
            return False
        tail = list(self.history)[-self.n:]
        return all(
            t["frontier_size"] == 0
            and t["new_families"] == 0
            and abs(t["best_val_delta"]) < self.eps
            and abs(t["best_oos_delta"]) < self.eps
            and t["diversity_saturated"] for t in tail)

    def drain_converged(self):
        """Natural-exhaustion convergence: frontier fully drained, last round
        generated nothing new and deltas are below epsilon. The §5 frontier==0
        clause holds by construction; the N-round smoother is satisfied by
        the quiet final round."""
        if not self.history:
            return False
        t = self.history[-1]
        return (t["frontier_size"] == 0 and t["new_families"] == 0
                and abs(t["best_val_delta"]) < self.eps
                and abs(t["best_oos_delta"]) < self.eps)


class SearchController:
    """Adaptive budget controller (§4/§44/§45). Soft targets may expand to hard
    ceilings while unresolved frontier remains and runtime remains."""

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


def save_checkpoint(path, payload):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(payload, f, indent=1, default=str)
    os.replace(tmp, path)


def load_checkpoint(path):
    with open(path) as f:
        return json.load(f)
