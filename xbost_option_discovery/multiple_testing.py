"""Multiple-testing (§25): counts + BH + permutation."""
import numpy as np

COUNTS = {"features": 0, "relationships": 0, "sequences": 0, "states": 0, "params": 0, "candidates": 0}

def bh(pvals):
    p = np.asarray(pvals, dtype=float); n = len(p)
    order = np.argsort(p); adj = np.empty(n); prev = 1.0
    for i in reversed(range(n)):
        v = min(prev, p[order[i]] * n / (i + 1))
        adj[order[i]] = v; prev = v
    return adj
