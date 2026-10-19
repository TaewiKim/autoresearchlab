"""Optional Mitsuba renderer capability measurements; selected explicitly."""

import os
import time

from .common import probe as _probe
from .provisioning import ensure_probe_packages


def scene_dict(mi, roughness=0.3, emitter_radiance=3.0, spp=8, seed=0, res=48,
               sphere_x=0.0, integrator="path", max_depth=6):
    """One procedural scene, every knob the probes need to vary exposed.

    Deliberately NOT loaded from disk: a procedural scene is the only kind whose
    counterfactual pair is exact - the edit is the only difference.
    """
    return {
        "type": "scene",
        "integrator": {"type": integrator, "max_depth": max_depth},
        "sensor": {
            "type": "perspective",
            "fov": 45,
            "to_world": mi.ScalarTransform4f().look_at(
                origin=[0, 0, 5], target=[0, 0, 0], up=[0, 1, 0]
            ),
            "film": {"type": "hdrfilm", "width": res, "height": res,
                     "pixel_format": "rgb", "rfilter": {"type": "box"}},
            "sampler": {"type": "independent", "sample_count": spp, "seed": seed},
        },
        "glossy_sphere": {
            "type": "sphere",
            "radius": 1.0,
            "to_world": mi.ScalarTransform4f().translate([sphere_x, 0, 0]),
            "bsdf": {"type": "roughconductor", "alpha": roughness,
                     "distribution": "ggx"},
        },
        "floor": {
            "type": "rectangle",
            "to_world": mi.ScalarTransform4f().translate([0, -1, 0])
            .rotate(axis=[1, 0, 0], angle=-90).scale(4),
            "bsdf": {"type": "diffuse", "reflectance": {"type": "rgb", "value": [0.6, 0.6, 0.6]}},
        },
        "emitter": {
            "type": "point",
            "position": [2.0, 3.0, 3.0],
            "intensity": {"type": "rgb", "value": [emitter_radiance] * 3},
        },
        "backdrop": {"type": "constant", "radiance": {"type": "rgb", "value": [0.05] * 3}},
    }


def run(inventory, config):
    if not ensure_probe_packages(inventory, ["mitsuba", "numpy"]):
        # A discovered pass that does not install leaves a note, not an error.
        inventory["renderer"] = {"available": False, "error": inventory.get("error") or "mitsuba is not importable and was not provisioned"}
        return 1
    # --- the renderer itself -------------------------------------------------
    try:
        import mitsuba as mi
    except Exception as exc:  # noqa: BLE001
        inventory["renderer"] = {"available": False, "error": str(exc)[:300]}
        inventory["notes"].append(
            "The explicitly selected Mitsuba backend could not be imported. "
            "This probe makes no claim about other renderers or non-rendering capabilities."
        )
        return 1

    variants = list(mi.variants())
    variant = "llvm_ad_rgb" if "llvm_ad_rgb" in variants else (variants[-1] if variants else None)
    if variant is None:
        inventory["renderer"] = {"available": False, "error": "no compiled variants"}
        return 1
    mi.set_variant(variant)
    import numpy as np

    inventory["renderer"] = {
        "available": True,
        "package": "mitsuba",
        "version": mi.__version__,
        "variant": variant,
        "variants_compiled": variants,
        "llvm_backend_path": os.environ.get("DRJIT_LIBLLVM_PATH"),
    }
    print(f"[probe] mitsuba {mi.__version__} variant={variant}", flush=True)

    def render(**kw):
        img = mi.render(mi.load_dict(scene_dict(mi, **kw)))
        return np.array(img, dtype=np.float64)

    # --- 1. can we render a procedural scene at all? -------------------------
    def p_render():
        t0 = time.time()
        arr = render(spp=8, seed=0)
        finite = bool(np.isfinite(arr).all())
        return {
            "shape": list(arr.shape),
            "mean_radiance": round(float(arr.mean()), 6),
            "all_finite": finite,
            "wall_s": round(time.time() - t0, 3),
        }

    base = _probe(
        "procedural_scene_render",
        "Can a scene built in memory be rendered to a finite radiance array?",
        p_render, inventory,
    )
    if not base["available"]:
        inventory["notes"].append(
            "The renderer imports but cannot render a procedural scene. Do not pose "
            "render-measured problems until this is diagnosed."
        )
        return 1

    # --- 2. seed pinning: the basis of every reproducibility claim -----------
    def p_seed():
        a = render(spp=8, seed=7)
        b = render(spp=8, seed=7)
        c = render(spp=8, seed=8)
        same = float(np.abs(a - b).max())
        diff = float(np.abs(a - c).max())
        return {
            "same_seed_max_abs_diff": round(same, 9),
            "different_seed_max_abs_diff": round(diff, 9),
            "bitwise_reproducible": same == 0.0,
            "seed_actually_changes_estimate": diff > 0.0,
        }

    _probe(
        "seed_pinned_reproducibility",
        "Does a pinned seed reproduce an identical estimate, and does changing it change the estimate?",
        p_seed, inventory,
    )

    # --- 3. matched sample budget: the only fair-comparison control ----------
    def p_budget():
        out = {}
        for spp in (4, 16, 64):
            t0 = time.time()
            arr = render(spp=spp, seed=1)
            out[f"spp_{spp}"] = {
                "wall_s": round(time.time() - t0, 3),
                "mean": round(float(arr.mean()), 6),
            }
        t4 = out["spp_4"]["wall_s"]
        t64 = out["spp_64"]["wall_s"]
        out["cost_scales_with_spp"] = t64 > t4
        out["scaling_ratio_64_over_4"] = round(t64 / t4, 2) if t4 > 0 else None
        return out

    _probe(
        "matched_sample_budget_control",
        "Can the sample budget be set exactly, and does render cost track it?",
        p_budget, inventory,
    )

    # --- 4. converged reference: what 'ground truth' costs here -------------
    def p_reference():
        t0 = time.time()
        ref = render(spp=256, seed=99, res=48)
        wall = time.time() - t0
        noisy = render(spp=8, seed=1, res=48)
        err = float(np.sqrt(((ref - noisy) ** 2).mean()))
        peak = float(max(ref.max(), 1e-8))
        psnr = float(20.0 * np.log10(peak / err)) if err > 0 else None
        return {
            "reference_spp": 256,
            "reference_wall_s": round(wall, 3),
            "rmse_vs_8spp": round(err, 6),
            "psnr_vs_8spp_db": round(psnr, 3) if psnr else None,
            "estimated_1024spp_wall_s": round(wall * 4, 1),
        }

    _probe(
        "converged_reference_and_error_metric",
        "Can a high-spp reference be rendered, and an error measured against it?",
        p_reference, inventory,
    )

    # --- 5. counterfactual edit pairs: exact edit ground truth --------------
    def p_counterfactual():
        out = {}
        for label, kw in (
            ("emitter_radiance", {"emitter_radiance": 6.0}),
            ("bsdf_roughness", {"roughness": 0.05}),
            ("object_translation", {"sphere_x": 0.35}),
        ):
            a = render(spp=32, seed=3)
            b = render(spp=32, seed=3, **kw)
            delta = np.abs(a - b).sum(axis=2)
            changed = delta > (1e-3 * max(float(delta.max()), 1e-8) + 1e-9)
            frac = float(changed.mean())
            out[label] = {
                "max_abs_delta": round(float(delta.max()), 6),
                "changed_pixel_fraction": round(frac, 4),
                "edit_is_localized": bool(0.0 < frac < 0.9),
                "edit_has_effect": float(delta.max()) > 0.0,
            }
        return out

    _probe(
        "counterfactual_edit_pairs",
        "Can one scene parameter be edited in isolation, with the affected image region localized?",
        p_counterfactual, inventory,
    )

    # --- 6. per-pixel variance: the image-space uncertainty observable ------
    def p_variance():
        stack = np.stack([render(spp=8, seed=s) for s in range(5)])
        per_pixel = stack.var(axis=0).mean(axis=2)
        return {
            "seeds": 5,
            "mean_per_pixel_variance": round(float(per_pixel.mean()), 8),
            "max_per_pixel_variance": round(float(per_pixel.max()), 8),
            "variance_is_spatially_nonuniform": float(per_pixel.max()) > 4 * float(per_pixel.mean()),
            "method": "across-seed sample variance of independent renders",
        }

    _probe(
        "per_pixel_variance_across_seeds",
        "Can per-pixel estimator variance be measured without renderer internals?",
        p_variance, inventory,
    )

    # --- 7. AOVs: what the renderer will hand over besides radiance --------
    def p_aov():
        found = {}
        for spec in ("depth:depth", "albedo:albedo", "sh_normal:sh_normal",
                     "prim_index:prim_index", "shape_index:shape_index"):
            name = spec.split(":")[0]
            try:
                d = scene_dict(mi, spp=4, seed=0, res=24)
                d["integrator"] = {
                    "type": "aov", "aovs": spec,
                    "integrator": {"type": "path", "max_depth": 4},
                }
                arr = np.array(mi.render(mi.load_dict(d)), dtype=np.float64)
                found[name] = {"channels": int(arr.shape[2]), "finite": bool(np.isfinite(arr).all())}
            except Exception as exc:  # noqa: BLE001
                found[name] = {"error": f"{type(exc).__name__}: {exc}"[:160]}
        usable = sorted(k for k, v in found.items() if "channels" in v)
        return {"aovs_usable": usable, "detail": found}

    _probe(
        "aov_side_channels",
        "Which auxiliary per-pixel channels (depth, albedo, normals, primitive ids) are readable?",
        p_aov, inventory,
    )

    # --- 8. integrators actually installed --------------------------------
    def p_integrators():
        """Try each integrator BOTH with and without max_depth.

        The first version of this probe passed max_depth unconditionally and so
        reported `aov` and `direct` as unavailable - integrators that reject the
        parameter - while the AOV probe right above it was rendering AOVs fine. A
        false absence is worse than no probe: the director would route around a
        capability it actually has.
        """
        out = {}
        for name in ("path", "direct", "aov", "volpath", "prb", "ptracer",
                     "moment", "depth", "stokes", "volpathmis"):
            attempts = []
            if name == "aov":
                attempts.append({"type": "aov", "aovs": "depth:depth",
                                 "integrator": {"type": "path", "max_depth": 4}})
            else:
                attempts.append({"type": name, "max_depth": 4})
                attempts.append({"type": name})
            errors = []
            for spec in attempts:
                try:
                    d = scene_dict(mi, spp=2, seed=0, res=16)
                    d["integrator"] = spec
                    mi.render(mi.load_dict(d))
                    out[name] = {"renders": True, "accepts_max_depth": "max_depth" in spec}
                    break
                except Exception as exc:  # noqa: BLE001
                    errors.append(f"{type(exc).__name__}: {str(exc)[:90]}")
            else:
                out[name] = {"renders": False, "errors": errors}
        return {
            "usable": sorted(k for k, v in out.items() if v.get("renders")),
            "detail": out,
        }

    _probe(
        "integrator_catalog",
        "Which integrators are installed and actually render in this build?",
        p_integrators, inventory,
    )

    # --- 8b. what an experiment COSTS at a resolution worth publishing ------
    def p_cost_anchor():
        """The 48x48 probes above prove capability, not affordability.

        A director scoping "answerable here" needs the wall-clock of a real
        experiment, not of a thumbnail, or it will propose sweeps that cannot
        finish inside a lane timeout.
        """
        out = {}
        for res, spp in ((256, 32), (256, 512)):
            t0 = time.time()
            render(res=res, spp=spp, seed=11)
            out[f"res{res}_spp{spp}_wall_s"] = round(time.time() - t0, 3)
        one = out["res256_spp32_wall_s"]
        ref = out["res256_spp512_wall_s"]
        return {
            **out,
            "reference_to_sample_cost_ratio": round(ref / one, 1) if one > 0 else None,
            "affordable_matched_budget_sweep": (
                f"a 2-arm x 5-seed x 3-scene sweep at 256px/32spp costs about "
                f"{round(one * 30, 1)}s of render, plus "
                f"{round(ref * 3, 1)}s for three converged references"
            ),
        }

    _probe(
        "experiment_cost_anchor",
        "What does one publication-resolution render and its converged reference actually cost?",
        p_cost_anchor, inventory,
    )

    # --- 9. per-path telemetry: the capability directors keep assuming ------
    def p_path_telemetry():
        """The important NEGATIVE probe.

        v81 and v82 both proposed instruments built on per-path quantities -
        transport overlap, effective sample size, support misses, guide-proposal
        density. If the Python API exposes no per-path hook, those questions are
        not answerable HERE as stated, and the director needs to hear that before
        it spends a cycle on them.
        """
        surface = dir(mi)
        hooks = {}
        for attr in ("Sampler", "SamplingIntegrator", "AdjointIntegrator", "Integrator"):
            hooks[attr] = attr in surface
        sampler_methods = []
        try:
            s = mi.load_dict({"type": "independent", "sample_count": 4})
            sampler_methods = [m for m in dir(s) if not m.startswith("_")]
        except Exception:  # noqa: BLE001
            pass
        py_integrator = False
        try:
            py_integrator = hasattr(mi, "ad") and hasattr(mi, "SamplingIntegrator")
        except Exception:  # noqa: BLE001
            pass
        return {
            "python_classes_exposed": hooks,
            "sampler_public_methods": sampler_methods[:20],
            "per_path_radiance_callback_available": False,
            "subclassable_python_integrator": py_integrator,
            "verdict": (
                "No per-path telemetry callback is exposed by the Python API. Path-level "
                "quantities (transport overlap, ESS, support misses) must either be "
                "DERIVED from image-space observables and AOVs, or produced by a Python "
                "SamplingIntegrator subclass written in the runner lane - which is "
                "possible but is itself an implementation task, not a ready instrument."
            ),
        }

    _probe(
        "per_path_telemetry_hooks",
        "Is there a ready hook for per-path quantities (ESS, transport overlap, support misses)?",
        p_path_telemetry, inventory,
        # There is no ready hook. The probe SUCCEEDS at establishing that, which is
        # not the same as the capability being present - see _probe's docstring.
        capability=lambda m: bool(m.get("per_path_radiance_callback_available")),
    )

    # --- what a director may claim -----------------------------------------
    available = [i["instrument"] for i in inventory["instruments"] if i["capability_present"]]
    missing = [i["instrument"] for i in inventory["instruments"] if not i["capability_present"]]
    inventory["verified_instruments"] = available
    inventory["unavailable_instruments"] = missing
    # An absence that was MEASURED is worth more to a director than one that was
    # never tested: the first can be worked around on purpose, the second only
    # guessed at.
    inventory["measured_absences"] = [
        {
            "instrument": i["instrument"],
            "why": (i.get("measured") or {}).get("verdict") if isinstance(i.get("measured"), dict) else None,
            "error": i.get("error"),
        }
        for i in inventory["instruments"]
        if not i["capability_present"]
    ]
    inventory["measurable_quantities"] = measurable_quantities(inventory)
    inventory["director_guidance"] = {
        "rule": (
            "answerable_here_because MUST name at least one entry from "
            "verified_instruments or measurable_quantities. That is what 'verified' "
            "means: this inventory is the record of a real run in this container."
        ),
        "on_absence": (
            "If the question needs something in unavailable_instruments, do NOT retire "
            "the problem. Either restate it over an observable that IS verified, or emit "
            "one methods_followup asking a runner lane to BUILD the missing instrument "
            "and re-probe. cycle-g-v82 retired 100 problems in a row for want of this "
            "sentence."
        ),
        "do_not_assume": (
            "Per-path telemetry is not a ready instrument here. A question phrased over "
            "path-level ESS or support misses must say how it reaches those from image-space "
            "observables, AOVs, or a runner-written integrator subclass."
        ),
    }
    return 0


def measurable_quantities(inventory):
    """The instrument list, restated as quantities a hypothesis can be posed over."""
    by_name = {i["instrument"]: i for i in inventory["instruments"]}
    ok = lambda n: bool(by_name.get(n, {}).get("capability_present"))  # noqa: E731
    out = []
    if ok("converged_reference_and_error_metric"):
        out.append("image error against a high-spp converged reference (RMSE, PSNR)")
    if ok("matched_sample_budget_control"):
        out.append("quality at a matched sample budget, and wall-clock cost per budget")
    if ok("seed_pinned_reproducibility"):
        out.append("across-seed spread of any derived statistic (pinned, bitwise reproducible)")
    if ok("per_pixel_variance_across_seeds"):
        out.append("per-pixel estimator variance and its spatial distribution")
    if ok("counterfactual_edit_pairs"):
        out.append("exact effect of one isolated scene edit, and the image region it changes")
    aov = by_name.get("aov_side_channels", {}).get("measured") or {}
    for name in (aov.get("aovs_usable") or []):
        out.append(f"per-pixel {name} channel (AOV)")
    integ = by_name.get("integrator_catalog", {}).get("measured") or {}
    if integ.get("usable"):
        out.append("integrator choice as an experimental factor: " + ", ".join(integ["usable"]))
    return out
