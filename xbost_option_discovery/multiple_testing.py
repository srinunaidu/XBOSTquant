"""Multiple-testing (§25/§28): counts + BH + Holm + Bonferroni (diagnostics)."""
import numpy as np

COUNTS = {"features": 0, "relationships": 0, "sequences": 0, "states": 0, "params": 0, "candidates": 0}

def bh(pvals):
    p = np.asarray(pvals, dtype=float); n = len(p)
    order = np.argsort(p); adj = np.empty(n); prev = 1.0
    for i in reversed(range(n)):
        v = min(prev, p[order[i]] * n / (i + 1))
        adj[order[i]] = v; prev = v
    return adj


def holm(pvals, alpha=0.10):
    """Holm step-down adjusted p-values."""
    p = np.asarray(pvals, dtype=float); n = len(p)
    order = np.argsort(p); adj = np.empty(n)
    for rank, idx in enumerate(order):
        adj[idx] = min(1.0, p[idx] * (n - rank))
    # enforce monotonicity
    for rank in range(1, n):
        if adj[order[rank]] < adj[order[rank - 1]]:
            adj[order[rank]] = adj[order[rank - 1]]
    return adj


def bonferroni(pvals, alpha=0.10):
    p = np.asarray(pvals, dtype=float); n = len(p)
    return np.minimum(1.0, p * n)
