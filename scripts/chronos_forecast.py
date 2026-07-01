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
    # chronos-forecasting 2.x: BaseChronosPipeline dispatches to the right
    # class per checkpoint (ChronosPipeline for T5, ChronosBoltPipeline for
    # bolt). Loading bolt weights through the old ChronosPipeline class fails
    # with "unexpected keyword argument 'input_patch_size'".
    from chronos import BaseChronosPipeline as _Pipeline
    HAS_CHRONOS = True
    IMPORT_ERR = None
except ImportError:
    try:
        from chronos import ChronosPipeline as _Pipeline  # chronos 1.x fallback
        HAS_CHRONOS = True
        IMPORT_ERR = None
    except ImportError as e:
        _Pipeline = None
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
        pipe = _Pipeline.from_pretrained(model_name, device_map="cpu", dtype=torch.float32)
    except Exception as e:
        print(json.dumps({"error": f"chronos load failed: {e}"}))
        sys.exit(1)

    try:
        # chronos 2.x renamed the first param context= → inputs; pass
        # positionally so both 1.x and 2.x signatures work.
        quantiles, _ = pipe.predict_quantiles(
            torch.tensor(history),
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
