"""Vetted CS/graphics validation helpers (Skills layer).

The computer-science / rendering analog of ``omics_helpers.py``. The analyst's
per-cycle blueprints for graphics and rendering work kept re-implementing asset
discovery, image loading, and quality metrics from scratch (and a bare
``pd.read_csv`` makes no sense for a scene file or an EXR render), which blocked
the lab-runner from producing a substantive, measured render comparison. This
module is the validated, reusable implementation a graphics/CS blueprint should
IMPORT instead of re-deriving::

    import cs_helpers as cs
    scenes = cs.find_scene_files()                       # .pbrt/.xml/.obj/.gltf/.blend
    rendered = cs.load_image("out.png")                  # float array in [0,1]
    reference = cs.load_image("reference.png")
    m = cs.image_quality_metrics(rendered, reference)    # {"mse","psnr","ssim"}
    master = cs.build_render_master_table(records)       # one row per render config

Encodes only general graphics/CS conventions — no hypothesis-, scene-, or
answer-specific knowledge. numpy + pandas only; image decoding uses imageio or
PIL when available and records a clear data_unavailable error otherwise (never a
silent crash). Keep in sync with the analyst CS blueprint rules in
src/agents/analyst/query_plan.js.
"""
from __future__ import annotations

import math
import os
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

import numpy as np
import pandas as pd

# Scene / asset description formats a rendering or geometry workflow consumes.
_SCENE_EXTS = (".pbrt", ".xml", ".obj", ".gltf", ".glb", ".blend", ".fbx", ".ply", ".usd", ".usda")
# Image formats a renderer emits or a reference render is stored as.
_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".exr", ".hdr", ".ppm", ".pfm")


def assets_root() -> Path:
    """The scene/asset directory the lab-runner passes via the environment.

    Reuses RESEARCHLAB_CSV_ROOT (the cycle's materialised dataset directory) so
    the same plumbing that delivers tabular data delivers scenes/reference
    renders for a graphics cycle."""
    return Path(os.environ.get("RESEARCHLAB_CSV_ROOT", ".")).resolve()


def _iter_files(root: str | Path | None, exts: tuple) -> List[Path]:
    base = Path(root) if root else assets_root()
    if not base.exists():
        return []
    return sorted(p for p in base.rglob("*") if p.is_file() and p.suffix.lower() in exts)


def find_scene_files(root: str | Path | None = None) -> List[Path]:
    """All scene/asset description files under the asset root (may be empty)."""
    return _iter_files(root, _SCENE_EXTS)


def find_images(root: str | Path | None = None) -> List[Path]:
    """All image files under the asset root (rendered outputs / references)."""
    return _iter_files(root, _IMAGE_EXTS)


def load_image(path: str | Path) -> np.ndarray:
    """Load an image as a float32 array in [0, 1], shape (H, W) or (H, W, C).

    Tries imageio first (handles EXR/HDR/PFM), then PIL. Raises a clear error —
    not a tokenizer/format crash — when no decoder is available or the file is
    absent, so the blueprint can record a data_unavailable resolution."""
    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(f"image not found: {path} — record data_unavailable rather than guessing")
    arr: Optional[np.ndarray] = None
    try:
        import imageio.v3 as iio  # type: ignore

        arr = np.asarray(iio.imread(path))
    except Exception:  # noqa: BLE001 — fall back to PIL
        try:
            from PIL import Image  # type: ignore

            with Image.open(path) as im:
                arr = np.asarray(im.convert("RGB"))
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(
                f"no image decoder available for {path} (install imageio or pillow); "
                "record the missing dependency rather than pretending the render loaded"
            ) from exc
    arr = np.asarray(arr, dtype=np.float32)
    # Normalise 8/16-bit integer ranges to [0,1]; leave float HDR data as-is.
    if np.issubdtype(arr.dtype, np.floating) and arr.max(initial=0.0) > 1.5:
        # already float but in a larger range (e.g. 0..255 stored as float)
        if arr.max() <= 255.0:
            arr = arr / 255.0
    return arr


def _align(a: np.ndarray, b: np.ndarray) -> tuple:
    """Crop two images to a common shape so metrics are well defined."""
    if a.ndim == 3 and b.ndim == 2:
        b = np.repeat(b[:, :, None], a.shape[2], axis=2)
    if b.ndim == 3 and a.ndim == 2:
        a = np.repeat(a[:, :, None], b.shape[2], axis=2)
    h = min(a.shape[0], b.shape[0])
    w = min(a.shape[1], b.shape[1])
    a = a[:h, :w]
    b = b[:h, :w]
    if a.ndim == 3 and b.ndim == 3:
        c = min(a.shape[2], b.shape[2])
        a, b = a[:, :, :c], b[:, :, :c]
    return a, b


def image_quality_metrics(rendered: np.ndarray, reference: np.ndarray) -> Dict[str, float]:
    """Quantitative comparison of a rendered image against a reference.

    Returns MSE, PSNR (dB), and a simplified global SSIM. Inputs are aligned to a
    common shape first. Values assume a [0,1] dynamic range (data_range=1.0)."""
    a, b = _align(np.asarray(rendered, dtype=np.float64), np.asarray(reference, dtype=np.float64))
    mse = float(np.mean((a - b) ** 2))
    if mse <= 1e-12:
        psnr = float("inf")
    else:
        psnr = float(10.0 * math.log10(1.0 / mse))
    # Simplified single-window SSIM (global statistics over the whole image).
    # Documented as global — a windowed SSIM would need scipy/skimage; this keeps
    # the helper dependency-light while still giving a structural similarity.
    mu_a, mu_b = a.mean(), b.mean()
    va, vb = a.var(), b.var()
    cov = float(np.mean((a - mu_a) * (b - mu_b)))
    c1, c2 = (0.01) ** 2, (0.03) ** 2
    ssim = float(((2 * mu_a * mu_b + c1) * (2 * cov + c2)) / ((mu_a**2 + mu_b**2 + c1) * (va + vb + c2)))
    return {"mse": mse, "psnr": psnr, "ssim": ssim}


def build_render_master_table(records: Iterable[Dict[str, Any]]) -> pd.DataFrame:
    """Canonical render-comparison master table: one row per render config.

    Each record is a dict describing one (scene × method × setting) render, e.g.::

        {"scene": "cornell-box", "method": "path-tracing", "spp": 256,
         "render_time_s": 12.4, "psnr": 31.2, "ssim": 0.97}

    Missing keys become NaN so downstream hypothesis tests (e.g. equal-time or
    equal-quality method comparisons) can rely on a stable column set."""
    rows = list(records)
    df = pd.DataFrame(rows)
    # Stable ordering of the common comparison columns when present.
    preferred = ["scene", "method", "setting", "samples_per_pixel", "spp", "resolution",
                 "render_time_s", "fps", "mse", "psnr", "ssim"]
    ordered = [c for c in preferred if c in df.columns] + [c for c in df.columns if c not in preferred]
    return df[ordered] if ordered else df


def parse_render_log(path: str | Path) -> Dict[str, Any]:
    """Best-effort extraction of timing / sample-count from a renderer log.

    Looks for common patterns (``render time``, ``spp``/``samples``, ``fps``).
    Returns whatever it finds; absent fields are simply omitted."""
    import re

    out: Dict[str, Any] = {}
    try:
        text = Path(path).read_text(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        return out
    t = re.search(r"(?:render(?:ing)?\s*time|elapsed)\D*([\d.]+)\s*(ms|s|sec)?", text, re.I)
    if t:
        val = float(t.group(1))
        if (t.group(2) or "").lower() == "ms":
            val /= 1000.0
        out["render_time_s"] = val
    s = re.search(r"(\d+)\s*(?:spp|samples? per pixel|samples)", text, re.I)
    if s:
        out["samples_per_pixel"] = int(s.group(1))
    f = re.search(r"([\d.]+)\s*fps", text, re.I)
    if f:
        out["fps"] = float(f.group(1))
    return out
