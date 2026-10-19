"""A small standard-library capability check, requiring no renderer or SDK."""
import json
import platform
import statistics
import sys

from .common import probe


def run(inventory, config):
    def measure():
        values = json.loads(json.dumps([1.0, 2.0, 3.0, 4.0]))
        return {
            "interpreter": sys.executable,
            "python_version": platform.python_version(),
            "count": len(values), "mean": statistics.mean(values),
            "sample_variance": statistics.variance(values),
            "json_round_trip": values == [1.0, 2.0, 3.0, 4.0],
        }

    entry = probe(
        "python_standard_library_statistics",
        "Can this interpreter round-trip numeric JSON and calculate finite sample summaries?",
        measure, inventory,
        capability=lambda m: m["json_round_trip"] and m["mean"] == 2.5 and m["sample_variance"] > 0,
    )
    if entry["available"]:
        inventory["measurable_quantities"] = ["count, mean and sample variance of supplied finite numeric values"]
    inventory["notes"].append("Only a fixed standard-library arithmetic/serialization fixture was measured; no domain-specific experiment was run.")
    return 0 if entry["available"] else 1
