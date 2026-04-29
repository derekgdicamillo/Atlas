#!/usr/bin/env python3
# Atlas Prime Sprint 4: Chronos-Bolt forecaster.
# stdin: {"history": [<numbers>], "horizon": <int>, "model": "amazon/chronos-bolt-base"}
# stdout: {"p05": [...], "p50": [...], "p95": [...]}

import json
import sys

try:
    import numpy as np
except ImportError:
    print(json.dumps({"error": "numpy not installed"}))
    sys.exit(1)

try:
    from chronos import ChronosPipeline  # pip install chronos-forecasting
    HAS_CHRONOS = True
    IMPORT_ERR = None
except ImportError as e:
    HAS_CHRONOS = False
    IMPORT_ERR = str(e)

def main():
    payload = json.load(sys.stdin)
    history = np.array(payload["history"], dtype=float)
    horizon = int(payload["horizon"])
    model_name = payload.get("model", "amazon/chronos-bolt-base")

    if not HAS_CHRONOS:
        print(json.dumps({"error": f"chronos-forecasting not installed: {IMPORT_ERR}"}))
        sys.exit(1)

    if len(history) < 5:
        print(json.dumps({"error": f"insufficient history: {len(history)} (need >= 5)"}))
        sys.exit(1)

    try:
        import torch
        pipe = ChronosPipeline.from_pretrained(model_name, device_map="cpu", torch_dtype=torch.float32)
    except Exception as e:
        print(json.dumps({"error": f"chronos load failed: {e}"}))
        sys.exit(1)

    try:
        quantiles, _ = pipe.predict_quantiles(
            context=torch.tensor(history),
            prediction_length=horizon,
            quantile_levels=[0.05, 0.5, 0.95],
        )
        q = quantiles[0].numpy()
        print(json.dumps({
            "p05": q[:, 0].tolist(),
            "p50": q[:, 1].tolist(),
            "p95": q[:, 2].tolist(),
        }))
    except Exception as e:
        print(json.dumps({"error": f"chronos forecast failed: {e}"}))
        sys.exit(1)

if __name__ == "__main__":
    main()
