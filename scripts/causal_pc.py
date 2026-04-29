#!/usr/bin/env python3
# Atlas Prime Sprint 4: PC algorithm with bootstrap-stability selection.
# stdin: {"observations": [[v1, v2, ...], ...], "var_names": [...], "n_iter": 100, "stability_threshold": 0.7}
# stdout: {"edges": [{"from": <name>, "to": <name>, "stability": <float>}, ...]}

import json
import sys

try:
    import numpy as np
except ImportError:
    print(json.dumps({"error": "numpy not installed"}))
    sys.exit(1)

try:
    from causaldag import partial_correlation, pcalg
    HAS_CAUSALDAG = True
except ImportError:
    HAS_CAUSALDAG = False

def main():
    payload = json.load(sys.stdin)
    X = np.array(payload["observations"], dtype=float)
    names = payload["var_names"]
    n_iter = int(payload.get("n_iter", 100))
    threshold = float(payload.get("stability_threshold", 0.7))

    if not HAS_CAUSALDAG:
        print(json.dumps({"error": "causaldag not installed; pip install causaldag"}))
        sys.exit(1)

    if X.shape[0] < 30:
        print(json.dumps({"error": f"insufficient observations: {X.shape[0]} (need >=30)"}))
        sys.exit(1)

    edge_counts = {}
    for _ in range(n_iter):
        idx = np.random.choice(len(X), len(X), replace=True)
        sample = X[idx]
        try:
            ci_test = partial_correlation(sample)
            cpdag = pcalg(ci_test, alpha=0.05)
            for i, j in cpdag.directed_edges:
                edge_counts[(i, j)] = edge_counts.get((i, j), 0) + 1
        except Exception:
            continue

    edges = []
    for (i, j), count in edge_counts.items():
        stability = count / n_iter
        if stability >= threshold:
            edges.append({"from": names[i], "to": names[j], "stability": stability})

    print(json.dumps({"edges": edges}))

if __name__ == "__main__":
    main()
