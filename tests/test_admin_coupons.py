"""Offline tests for coupons, cost estimates and admin rate limits (AST-extracted, no services)."""

import ast
import hashlib
import re
import secrets
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
import runpy
from types import SimpleNamespace
from typing import Optional

from pydantic import ValidationError

from test_tutor_session_context import FakeDB, Increment, transactional

ROOT = Path(__file__).resolve().parents[1]
MODELS = runpy.run_path(str(ROOT / "services/api/app/models.py"))
ADMIN = ROOT / "services/api/app/admin.py"


def load_admin():
    names = {"_as_utc", "_redeem", "_sum_models", "estimate_cost", "_fingerprint", "take_user_budget",
             "_random_code", "_is_premium", "_coupon_view", "_admin_emails", "is_admin_user",
             "reserve_ai_time", "refund_ai_time", "pricing_view", "ist_day", "ai_usage_view"}
    constants = {"CODE_ALPHABET", "COUPONS", "IST", "PLAN_META", "STATS"}
    nodes = []
    for node in ast.parse(ADMIN.read_text(encoding="utf-8")).body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names:
            node.decorator_list = []
            nodes.append(node)
        elif isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id in constants for t in node.targets):
            nodes.append(node)
    namespace = {
        **MODELS, "datetime": datetime, "timezone": timezone, "timedelta": timedelta, "re": re,
        "hashlib": hashlib, "secrets": secrets, "Optional": Optional,
        "firestore": SimpleNamespace(transactional=transactional, Increment=Increment),
    }
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(ADMIN), "exec"), namespace)
    return namespace


class CouponTests(unittest.TestCase):
    def setUp(self):
        self.ns = load_admin()
        self.db = FakeDB()
        self.now = datetime(2026, 10, 18, tzinfo=timezone.utc)
        self.user_ref = self.db.collection("users").document("u1")
        self.user_ref.set({"email": "learner@example.com", "plan": "free"})

    def coupon(self, code, **fields):
        base = {"kind": "pro", "pro_days": 30, "max_redemptions": 1, "redemptions": 0, "active": True}
        self.db.collection("coupons").document(code).set({**base, **fields})

    def redeem(self, code, uid="u1"):
        return self.ns["_redeem"](self.db, uid, code, self.now)

    def test_pro_coupon_unlocks_premium_once_per_user(self):
        self.coupon("LAUNCH30", max_redemptions=5)
        result = self.redeem("LAUNCH30")
        self.assertTrue(result["ok"])
        profile = self.user_ref.get().to_dict()
        self.assertEqual(profile["plan"], "premium")
        self.assertEqual(profile["premium_until"], self.now + timedelta(days=30))
        self.assertEqual(profile["premium_source"], "coupon")
        again = self.redeem("LAUNCH30")
        self.assertFalse(again["ok"])
        self.assertIn("already used", again["reason"])
        coupon = self.db.collection("coupons").document("LAUNCH30").get().to_dict()
        self.assertEqual(coupon["redemptions"], 1)

    def test_pro_coupon_extends_existing_premium_instead_of_resetting_it(self):
        self.user_ref.set({"plan": "premium", "premium_until": self.now + timedelta(days=10)}, merge=True)
        self.coupon("MORE30")
        self.redeem("MORE30")
        self.assertEqual(self.user_ref.get().to_dict()["premium_until"], self.now + timedelta(days=40))

    def test_lifetime_premium_is_never_shortened(self):
        self.user_ref.set({"plan": "premium", "premium_until": None, "premium_source": "admin"}, merge=True)
        self.coupon("FREE7", pro_days=7)
        self.redeem("FREE7")
        profile = self.user_ref.get().to_dict()
        self.assertIsNone(profile["premium_until"])
        self.assertEqual(profile["premium_source"], "admin")

    def test_discount_coupon_is_saved_for_checkout(self):
        self.coupon("SAVE20", kind="discount", percent_off=20, pro_days=None)
        result = self.redeem("SAVE20")
        self.assertEqual(result["kind"], "discount")
        profile = self.user_ref.get().to_dict()
        self.assertEqual(profile["plan"], "free")
        self.assertEqual(profile["discount_coupon"]["percent_off"], 20)

    def test_invalid_expired_inactive_and_exhausted_coupons_are_rejected(self):
        self.coupon("OLD", expires_at=self.now - timedelta(days=1))
        self.coupon("OFF", active=False)
        self.coupon("FULL", redemptions=1, max_redemptions=1)
        for code in ("MISSING", "OLD", "OFF", "FULL"):
            with self.subTest(code=code):
                self.assertFalse(self.redeem(code)["ok"])
        self.assertEqual(self.user_ref.get().to_dict()["plan"], "free")

    def test_shared_coupon_respects_max_redemptions_across_users(self):
        self.coupon("TEAM2", max_redemptions=2)
        for uid in ("a", "b", "c"):
            self.db.collection("users").document(uid).set({"plan": "free"})
        self.assertTrue(self.redeem("TEAM2", "a")["ok"])
        self.assertTrue(self.redeem("TEAM2", "b")["ok"])
        self.assertFalse(self.redeem("TEAM2", "c")["ok"])

    def test_random_codes_are_readable_and_unique(self):
        codes = {self.ns["_random_code"]("PRAVAAH") for _ in range(200)}
        self.assertEqual(len(codes), 200)
        for code in codes:
            self.assertRegex(code, r"^PRAVAAH-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$")

    def test_coupon_request_validation(self):
        create = MODELS["CreateCouponRequest"]
        self.assertEqual(create(kind="pro", code="DIWALI50").code, "DIWALI50")
        for bad in ("diwali", "A", "HAS SPACE", "../X"):
            with self.subTest(code=bad), self.assertRaises(ValidationError):
                create(kind="pro", code=bad)
        with self.assertRaises(ValidationError):
            create(kind="discount", percent_off=150)
        with self.assertRaises(ValidationError):
            create(kind="pro", count=1000)


class CostAndBudgetTests(unittest.TestCase):
    def setUp(self):
        self.ns = load_admin()

    def test_cost_estimate_combines_tokens_audio_and_agent_minutes(self):
        rates = MODELS["CostSettings"](llm_input_per_million=1.0, llm_output_per_million=2.0,
                                       stt_per_hour=0.36, tts_per_million_chars=10.0,
                                       livekit_per_agent_minute=0.01)
        usage = {
            "llm": {"qwen": {"prompt_tokens": 500_000, "completion_tokens": 100_000},
                    "gpt-oss": {"prompt_tokens": 500_000, "completion_tokens": 0}},
            "stt": {"whisper": {"audio_seconds": 600}},
            "tts": {"edge": {"characters": 100_000}},
            "agent_seconds": 300,
        }
        cost = self.ns["estimate_cost"](usage, rates)
        self.assertAlmostEqual(cost["llm"], 1.0 + 0.2)
        self.assertAlmostEqual(cost["stt"], 0.06)
        self.assertAlmostEqual(cost["tts"], 1.0)
        self.assertAlmostEqual(cost["livekit"], 0.05)
        self.assertAlmostEqual(cost["total"], 2.31)
        self.assertEqual(self.ns["estimate_cost"]({}, rates)["total"], 0)

    def test_per_user_budget_blocks_after_limit_and_resets_each_window(self):
        db = FakeDB()
        db.collection("users").document("u1").set({})
        take = self.ns["take_user_budget"]
        self.assertTrue(all(take(db, "u1", "bugs", "2026-10-18", 3) for _ in range(3)))
        self.assertFalse(take(db, "u1", "bugs", "2026-10-18", 3))
        self.assertTrue(take(db, "u1", "bugs", "2026-10-19", 3))

    def test_error_fingerprint_groups_occurrences_with_different_ids(self):
        fp = self.ns["_fingerprint"]
        self.assertEqual(fp("app", "Session 4f9a2c81d0 failed after 1203 ms"),
                         fp("app", "Session 0b77e1f3aa failed after 87 ms"))
        self.assertNotEqual(fp("app", "Network error"), fp("app", "Microphone denied"))

    def test_agent_usage_report_is_bounded(self):
        report = MODELS["AgentUsageReport"]
        with self.assertRaises(ValidationError):
            report(session_id="session-1234", llm={"m": {"prompt_tokens": 10**12}})
        with self.assertRaises(ValidationError):
            report(session_id="session-1234", extra_field=1)

    def test_pre_authorized_admin_needs_a_verified_email(self):
        db = FakeDB()
        db.collection("admin_config").document("access").set({"emails": ["owner@example.com"]})
        is_admin = self.ns["is_admin_user"]
        spoof = {"uid": "spoof", "email": "Owner@example.com", "email_verified": False}
        self.assertFalse(is_admin(db, spoof, {}))
        owner = {"uid": "owner", "email": "Owner@example.com", "email_verified": True}
        self.assertTrue(is_admin(db, owner, {}))
        self.assertEqual(db.collection("users").document("owner").get().to_dict()["role"], "admin")
        self.assertFalse(is_admin(db, {"uid": "x", "email": "other@example.com", "email_verified": True}, {}))
        self.assertTrue(self.ns["_is_premium"]({"role": "admin"}, datetime.now(timezone.utc)))


class AiLimitTests(unittest.TestCase):
    def setUp(self):
        self.ns = load_admin()
        self.db = FakeDB()
        self.db.collection("users").document("u1").set({"plan": "premium"})
        self.limits = MODELS["AiLimits"](premium_sessions_per_day=3, premium_minutes_per_day=40,
                                         premium_minutes_per_month=100, max_session_minutes=30,
                                         global_minutes_per_day=500)
        self.now = datetime(2026, 10, 18, 6, 0, tzinfo=timezone.utc)

    def reserve(self, requested=1800, premium=True, admin=False, limits=None, now=None):
        return self.ns["reserve_ai_time"](self.db, "u1", now or self.now, limits or self.limits,
                                          requested, premium, admin)

    def usage(self):
        return self.db.collection("users").document("u1").get().to_dict()["ai_usage"]

    def test_daily_minutes_cap_shortens_then_blocks_sessions(self):
        self.assertEqual(self.reserve(), (1800, None))            # 30 of 40 minutes
        self.assertEqual(self.reserve(), (600, None))             # only 10 minutes left today
        granted, denial = self.reserve()
        self.assertEqual(granted, 0)
        self.assertIn("today's 40 minutes", denial)
        self.assertEqual(self.usage()["day_seconds"], 2400)

    def test_session_count_and_session_length_caps(self):
        limits = self.limits.model_copy(update={"premium_minutes_per_day": 600, "premium_minutes_per_month": 5000})
        self.assertEqual(self.reserve(requested=99999, limits=limits)[0], 1800)  # capped at 30 min
        self.reserve(limits=limits)
        self.reserve(limits=limits)
        granted, denial = self.reserve(limits=limits)
        self.assertEqual(granted, 0)
        self.assertIn("3 coach sessions", denial)

    def test_monthly_cap_and_new_day_reset(self):
        limits = self.limits.model_copy(update={"premium_minutes_per_day": 60, "premium_sessions_per_day": 50})
        for day in range(3):
            self.reserve(requested=1800, limits=limits, now=self.now + timedelta(days=day))
            self.reserve(requested=1800, limits=limits, now=self.now + timedelta(days=day))
        granted, denial = self.reserve(limits=limits, now=self.now + timedelta(days=4))
        self.assertEqual(granted, 0)
        self.assertIn("this month's", denial)
        self.assertEqual(self.usage()["month_seconds"], 6000)

    def test_global_budget_kill_switch_and_admin_bypass(self):
        self.db.collection("admin_stats").document("2026-10-18").set({"ai_seconds_reserved": 500 * 60})
        self.assertIn("fully booked", self.reserve()[1])
        self.assertEqual(self.reserve(admin=True)[0], 1800)
        paused = self.limits.model_copy(update={"ai_enabled": False})
        self.assertIn("paused", self.reserve(limits=paused)[1])
        self.assertEqual(self.reserve(limits=paused, admin=True)[0], 1800)

    def test_demo_is_not_charged_against_premium_caps(self):
        self.db.collection("users").document("u1").set({"plan": "free"})
        self.assertEqual(self.reserve(requested=300, premium=False), (300, None))

    def test_refund_returns_unused_time_to_the_day_it_was_charged(self):
        self.reserve()
        refunded = self.ns["refund_ai_time"](self.db, "u1", 1800, 300, self.now)
        self.assertEqual(refunded, 1500)
        self.assertEqual(self.usage()["day_seconds"], 300)
        self.assertEqual(self.usage()["month_seconds"], 300)
        stats = self.db.collection("admin_stats").document("2026-10-18").get().to_dict()
        self.assertEqual(stats["ai_seconds_reserved"], 300)
        self.assertEqual(self.ns["refund_ai_time"](self.db, "u1", 1800, 5000, self.now), 0)

    def test_day_boundaries_follow_indian_time(self):
        late_utc = datetime(2026, 10, 18, 19, 0, tzinfo=timezone.utc)  # 00:30 on the 19th in India
        self.assertEqual(self.ns["ist_day"](late_utc), "2026-10-19")


class PricingTests(unittest.TestCase):
    def setUp(self):
        self.ns = load_admin()
        self.now = datetime(2026, 10, 18, tzinfo=timezone.utc)

    def view(self, **plans):
        config = MODELS["PricingConfig"](**plans)
        return {p["id"]: p for p in self.ns["pricing_view"](config, self.now)}

    def test_regular_prices_without_a_sale(self):
        plans = self.view()
        self.assertEqual(plans["monthly"]["effective_price_inr"], 299)
        self.assertIsNone(plans["monthly"]["sale_price_inr"])
        self.assertEqual(plans["yearly"]["save_vs_monthly_percent"], 44)

    def test_running_sale_shows_cut_price_and_expired_sale_does_not(self):
        plans = self.view(monthly={"price_inr": 299, "sale_price_inr": 199, "sale_label": "Diwali offer",
                                   "sale_ends_at": self.now + timedelta(days=3)})
        monthly = plans["monthly"]
        self.assertEqual((monthly["price_inr"], monthly["effective_price_inr"]), (299, 199))
        self.assertEqual(monthly["sale_percent_off"], 33)
        self.assertEqual(monthly["sale_label"], "Diwali offer")
        expired = self.view(monthly={"price_inr": 299, "sale_price_inr": 199,
                                     "sale_ends_at": self.now - timedelta(minutes=1)})
        self.assertEqual(expired["monthly"]["effective_price_inr"], 299)
        self.assertEqual(expired["monthly"]["sale_label"], "")

    def test_price_increase_and_invalid_sale(self):
        self.assertEqual(self.view(monthly={"price_inr": 399})["monthly"]["effective_price_inr"], 399)
        with self.assertRaises(ValidationError):
            MODELS["PlanPrice"](price_inr=299, sale_price_inr=299)
        with self.assertRaises(ValidationError):
            MODELS["PlanPrice"](price_inr=-1)


if __name__ == "__main__":
    unittest.main()
