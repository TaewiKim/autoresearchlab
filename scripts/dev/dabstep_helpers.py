"""Validated fee-rule matching helpers for the DABStep corpus (Skills layer).

Implements ONLY the matching semantics documented in manual.md section 5
("Understanding Payment Processing Fees") and its Notes, plus the
no-constraint principle (a field with no constraint content - null, [], "" -
matches all values, exactly like the manual's explicit null rule). It encodes
no task-specific knowledge: no fee IDs, no merchants, no answers.

Field semantics (manual.md section 5):
- card_scheme: string; rule applies to that scheme (null = all).
- account_type: list; merchant's account type must be in it ([]/null = all).
- capture_delay: string spec '3-5' | '>5' | '<3' | 'immediate' | 'manual';
  merchants carry a concrete value ('1', '2', '7', 'immediate', 'manual').
  Numeric merchant values are compared numerically against numeric specs;
  non-numeric values match only the same literal spec.
- monthly_fraud_level: percent range, e.g. '7.7%-8.3%' or '>8.3%'; compared
  against the merchant's monthly fraud ratio = fraud volume / total volume
  (natural month), in percent.
- monthly_volume: euro range with k/m suffixes, e.g. '100k-1m'; compared
  against the merchant's monthly total volume (natural month).
- merchant_category_code: list of ints ([]/null = all).
- is_credit: bool (null = both).
- aci: list of letters ([]/null = all).
- intracountry: bool-ish 0/1/null; True = issuer country == acquirer country.
- fee = fixed_amount + rate * transaction_value / 10000 (manual Notes).
"""
from __future__ import annotations

import json
import os
import re


def _is_unconstrained(value):
    return value is None or value == [] or value == ""


def _parse_money(tok: str) -> float:
    tok = tok.strip().lower()
    mult = 1.0
    if tok.endswith("k"):
        mult, tok = 1_000.0, tok[:-1]
    elif tok.endswith("m"):
        mult, tok = 1_000_000.0, tok[:-1]
    return float(tok) * mult


def _parse_percent(tok: str) -> float:
    return float(tok.strip().rstrip("%"))


def range_matches(spec: str, value: float, parse=float) -> bool:
    """Evaluate a range-encoded string spec ('a-b', '>x', '<x') numerically."""
    spec = spec.strip()
    if spec.startswith(">"):
        return value > parse(spec[1:])
    if spec.startswith("<"):
        return value < parse(spec[1:])
    if "-" in spec:
        lo, hi = spec.split("-", 1)
        return parse(lo) <= value <= parse(hi)
    return value == parse(spec)


def capture_delay_matches(rule_spec, merchant_value) -> bool:
    if _is_unconstrained(rule_spec):
        return True
    spec = str(rule_spec).strip()
    mv = str(merchant_value).strip()
    if re.fullmatch(r"-?\d+(\.\d+)?", mv):
        n = float(mv)
        if spec == "immediate" or spec == "manual":
            return False
        return range_matches(spec, n)
    return mv == spec


def monthly_fraud_matches(rule_spec, fraud_ratio_percent) -> bool:
    if _is_unconstrained(rule_spec):
        return True
    return range_matches(str(rule_spec), float(fraud_ratio_percent), _parse_percent)


def monthly_volume_matches(rule_spec, monthly_volume_eur) -> bool:
    if _is_unconstrained(rule_spec):
        return True
    return range_matches(str(rule_spec), float(monthly_volume_eur), _parse_money)


def match_fee_rule(rule: dict, ctx: dict) -> bool:
    """ctx carries the dimensions the QUESTION pins. A dimension absent from
    ctx (or None) is not part of the question and is ignored — only supplied
    dimensions can exclude a rule. (Rule-side no-constraint fields match all
    values per the manual's null rule.)"""

    def has(k):
        return k in ctx and ctx[k] is not None

    if not _is_unconstrained(rule.get("card_scheme")) and has("card_scheme"):
        if str(ctx["card_scheme"]) != str(rule["card_scheme"]):
            return False
    if not _is_unconstrained(rule.get("account_type")) and has("account_type"):
        if ctx["account_type"] not in rule["account_type"]:
            return False
    if not _is_unconstrained(rule.get("capture_delay")) and has("capture_delay"):
        if not capture_delay_matches(rule["capture_delay"], ctx["capture_delay"]):
            return False
    if not _is_unconstrained(rule.get("monthly_fraud_level")) and has("monthly_fraud_level"):
        if not monthly_fraud_matches(rule["monthly_fraud_level"], ctx["monthly_fraud_level"]):
            return False
    if not _is_unconstrained(rule.get("monthly_volume")) and has("monthly_volume"):
        if not monthly_volume_matches(rule["monthly_volume"], ctx["monthly_volume"]):
            return False
    if not _is_unconstrained(rule.get("merchant_category_code")) and has("merchant_category_code"):
        if int(ctx["merchant_category_code"]) not in [int(x) for x in rule["merchant_category_code"]]:
            return False
    if rule.get("is_credit") is not None and rule.get("is_credit") != "" and has("is_credit"):
        if bool(ctx["is_credit"]) != bool(rule["is_credit"]):
            return False
    if not _is_unconstrained(rule.get("aci")) and has("aci"):
        if str(ctx["aci"]) not in [str(a) for a in rule["aci"]]:
            return False
    if rule.get("intracountry") is not None and rule.get("intracountry") != "" and has("intracountry"):
        if bool(ctx["intracountry"]) != bool(rule["intracountry"]):
            return False
    return True


def fee_amount(rule: dict, transaction_value: float) -> float:
    """fee = fixed_amount + rate * transaction_value / 10000 (manual Notes)."""
    return float(rule["fixed_amount"]) + float(rule["rate"]) * float(transaction_value) / 10000.0


def load_fees(csv_root: str | None = None):
    root = csv_root or os.environ["RESEARCHLAB_CSV_ROOT"]
    with open(os.path.join(root, "fees.json"), "r", encoding="utf-8") as fh:
        return json.load(fh)


def load_merchant(merchant_name: str, csv_root: str | None = None):
    root = csv_root or os.environ["RESEARCHLAB_CSV_ROOT"]
    with open(os.path.join(root, "merchant_data.json"), "r", encoding="utf-8") as fh:
        for m in json.load(fh):
            if m.get("merchant") == merchant_name:
                return m
    return None


def month_context(payments_df, merchant_name: str, year: int, month: int):
    """Monthly volume and fraud ratio (percent) for a natural month
    (manual Notes: natural months, day 1 through the last day)."""
    df = payments_df
    sel = df[(df["merchant"] == merchant_name) & (df["year"] == year)]
    import calendar

    first_doy = sum(calendar.monthrange(year, m)[1] for m in range(1, month)) + 1
    last_doy = first_doy + calendar.monthrange(year, month)[1] - 1
    mdf = sel[(sel["day_of_year"] >= first_doy) & (sel["day_of_year"] <= last_doy)]
    total = float(mdf["eur_amount"].sum())
    fraud = float(mdf.loc[mdf["has_fraudulent_dispute"], "eur_amount"].sum())
    return {
        "month_df": mdf,
        "monthly_volume": total,
        "monthly_fraud_level": (fraud / total * 100.0) if total else 0.0,
    }
