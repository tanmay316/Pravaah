"""Offline API/Expo contract regressions: no credentials, services or network.

Load the real schemas and AST-extracted route bodies instead of importing main:
main imports the worker, loads .env and initializes provider SDKs. Only those
boundaries (Firestore, ranking, curriculum generation and token minting) are faked.
Run with Python's unittest; pytest is not required.
"""

import ast
import asyncio
from collections.abc import Callable
import copy
import json
import logging
from pathlib import Path
import runpy
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, Response
from pydantic import ValidationError


ROOT = Path(__file__).resolve().parents[1]
MODELS = runpy.run_path(str(ROOT / "services/api/app/models.py"))
MAIN = ROOT / "services/api/app/main.py"
SKILL = "past_simple_auxiliary"
OTHER_SKILL = "collocations"


class Increment:
    def __init__(self, value):
        self.value = value


class FakeSnapshot:
    def __init__(self, ref):
        self.reference = ref
        self.id = ref.path[-1]
        self.exists = ref.path in ref.db.data
        self.data = copy.deepcopy(ref.db.data.get(ref.path))

    def to_dict(self):
        return copy.deepcopy(self.data)


class FakeRef:
    def __init__(self, db, path=()):
        self.db, self.path = db, path

    def collection(self, name):
        return FakeRef(self.db, (*self.path, name))

    def document(self, name):
        return FakeRef(self.db, (*self.path, name))

    def get(self, transaction=None):
        snapshot = FakeSnapshot(self)
        if transaction is not None:
            assert not transaction.operations, "Firestore requires reads before writes"
            transaction.reads[self.path] = snapshot.to_dict()
        return snapshot

    def set(self, data, merge=False):
        self.db.writes.append((self.path, copy.deepcopy(data)))
        saved = self.db.data.setdefault(self.path, {}) if merge else {}

        def apply(target, changes):
            for key, value in changes.items():
                if isinstance(value, Increment):
                    target[key] = target.get(key, 0) + value.value
                elif isinstance(value, dict):
                    apply(target.setdefault(key, {}), value)
                else:
                    target[key] = copy.deepcopy(value)

        apply(saved, data)
        self.db.data[self.path] = saved

    def update(self, data):
        assert self.path in self.db.data, "Cannot update a nonexistent document"
        self.set(data, merge=True)

    def order_by(self, *args, **kwargs):
        return self

    def stream(self):
        return [FakeSnapshot(FakeRef(self.db, path)) for path in sorted(self.db.data)
                if path[:-1] == self.path]


class FakeDB(FakeRef):
    def __init__(self):
        self.data = {}
        self.writes = []
        self.before_commit: Callable[[], None] | None = None
        super().__init__(self)

    def transaction(self):
        return FakeTransaction(self)


class FakeTransaction:
    def __init__(self, db):
        self.db = db
        self.reads = {}
        self.operations = []

    def set(self, ref, data, merge=False):
        self.operations.append((ref, copy.deepcopy(data), merge))


def transactional(function):
    def run(transaction, *args, **kwargs):
        for _ in range(3):
            transaction.reads, transaction.operations = {}, []
            result = function(transaction, *args, **kwargs)
            hook, transaction.db.before_commit = transaction.db.before_commit, None
            if hook:
                hook()
            if any(transaction.db.data.get(path) != data for path, data in transaction.reads.items()):
                continue
            for ref, data, merge in transaction.operations:
                ref.set(data, merge=merge)
            return result
        raise AssertionError("Transaction retries exhausted")
    return run


def load_routes():
    names = {
        "_compact_text", "_compact_examples", "_resolve_tutor_context",
        "_session_token_metadata", "create_session", "refresh_session_token",
        "complete_session", "get_today_daily_plan", "_mint_livekit_token",
        "_save_started_session", "_finalize_session",
    }
    nodes = []
    for node in ast.parse(MAIN.read_text(encoding="utf-8")).body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names:
            node.decorator_list = []
            nodes.append(node)
    assert {n.name for n in nodes} == names
    namespace = {
        **MODELS, "asyncio": asyncio, "json": json, "uuid": uuid,
        "logging": logging, "datetime": datetime, "timezone": timezone,
        "timedelta": timedelta, "HTTPException": HTTPException,
        "Response": Response, "CurrentUser": dict, "RequestId": str,
        "firestore": SimpleNamespace(SERVER_TIMESTAMP="server_timestamp", Increment=Increment,
                         transactional=transactional),
        "CURRICULUM_SKILLS": {SKILL: {}, OTHER_SKILL: {}},
    }
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(MAIN), "exec"), namespace)
    return namespace


class TutorSessionContextTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.ns = load_routes()
        self.db = FakeDB()
        self.user = {"uid": "authenticated_learner", "name": "Token Name"}
        self.user_ref = self.db.collection("users").document(self.user["uid"])
        self.profile = {"display_name": "Learner", "hindi_support": "occasional", "pravaah_level": "C"}
        self.user_ref.set(self.profile)
        self.ranking = [
            {"skill_id": SKILL, "mastery": 0.35, "reason": "recent_mistakes",
             "recent_examples": [{"original": "I didn't went", "corrected": "I didn't go"}]},
            {"skill_id": OTHER_SKILL, "mastery": 0.4, "reason": "low_mastery", "recent_examples": []},
        ]
        self.ns.update(
            get_firestore_client=Mock(return_value=self.db),
            compute_focus_ranking=Mock(side_effect=lambda *args, **kwargs: copy.deepcopy(self.ranking)),
            generate_personalized_lesson=Mock(side_effect=self.generate_lesson),
            _mint_livekit_token=Mock(return_value=("offline-token", datetime.now(timezone.utc))),
            complete_daily_plan_activity=Mock(return_value={}),
            analyze_session_messages=AsyncMock(),
            process_event=AsyncMock(),
        )

    @staticmethod
    def generate_lesson(skill_id, mastery=0.5, stage=None, lesson_id=None):
        data = {"lesson_id": lesson_id or f"lsn_{skill_id}_offline", "target_skill_id": skill_id,
                "lesson_title": f"Lesson for {skill_id}", "rule_summary": f"Rule for {skill_id}",
                "practice_activity": f"Curriculum practice for {skill_id}"}
        return SimpleNamespace(model_dump=lambda: data)

    async def create(self, **options):
        return await self.ns["create_session"](
            MODELS["CreateSessionRequest"](**options), self.user, "test-request", Response())

    def saved(self, session_id):
        return self.user_ref.collection("sessions").document(session_id).get().to_dict()

    def metadata(self):
        return self.ns["_mint_livekit_token"].call_args.kwargs["metadata"]

    def add_activity(self, skill: str | None = SKILL):
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        activity = {"activity_id": "plan_today_act_1", "title": "Correct and retry",
                    "target_skill": skill, "mode": "grammar_practice", "duration_minutes": 10,
                    "objective": "Use the corrected form", "prompt_activity": "Explain, retry, then transfer.",
                    "stage": "guided_practice", "priority_reason": "recent_mistakes", "priority_rank": 1,
                    "source_examples": [{"original": "I didn't went", "corrected": "I didn't go"}]}
        self.user_ref.collection("daily_plans").document(today).set({"activities": [activity]})
        return today, activity

    async def test_free_conversation_gets_ranked_focus_and_compact_saved_context(self):
        result = await self.create(speech_language="hi", topic="My weekend")
        metadata = self.metadata()
        self.assertEqual(metadata["target_skill"], SKILL)
        self.assertEqual(metadata["practice_activity"], f"Curriculum practice for {SKILL}")
        self.assertEqual(metadata["speech_language"], "hi")
        self.assertEqual(metadata["hindi_support"], "occasional")
        self.assertEqual(metadata["user_id"], self.user["uid"])
        self.assertEqual(self.saved(result.session_id)["session_context"], metadata)
        self.ns["compute_focus_ranking"].assert_called_once_with(self.user["uid"], db=self.db)

    async def test_requested_skill_wins_over_top_ranking_and_unrelated_recommendation(self):
        self.user_ref.set({"recommended_lesson": {"lesson_id": "unrelated", "target_skill_id": SKILL,
                                                 "practice_activity": "Wrong lesson prompt"}}, merge=True)
        await self.create(mode="vocabulary_practice", target_skill=OTHER_SKILL)
        self.assertEqual(self.metadata()["target_skill"], OTHER_SKILL)
        self.assertEqual(self.metadata()["practice_activity"], f"Curriculum practice for {OTHER_SKILL}")
        self.assertEqual(self.metadata()["recent_examples"], [])

    async def test_daily_activity_resolves_prompt_by_id_without_phantom_lesson(self):
        today, activity = self.add_activity()
        result = await self.create(lesson_id=activity["activity_id"])
        self.assertEqual(self.metadata()["practice_activity"], activity["prompt_activity"])
        self.assertEqual(self.metadata()["lesson_title"], activity["title"])
        self.assertEqual(self.metadata()["target_skill"], SKILL)
        self.assertEqual(self.saved(result.session_id)["daily_plan_date"], today)
        self.assertFalse(self.user_ref.collection("lessons").document(activity["activity_id"]).get().exists)
        plan = self.user_ref.collection("daily_plans").document(today).get().to_dict()
        started = plan["activities"][0]
        self.assertEqual(started["status"], "in_progress")
        self.assertEqual(started["session_id"], result.session_id)
        self.assertTrue(started["started_at"])
        self.assertEqual(plan["completion_status"], "in_progress")

    async def test_activity_start_retries_conflict_without_losing_other_slot_progress(self):
        today, activity = self.add_activity()
        plan_ref = self.user_ref.collection("daily_plans").document(today)
        other = {**activity, "activity_id": "other", "is_completed": False}
        plan_ref.set({"activities": [activity, other]})

        def concurrent_completion():
            data = plan_ref.get().to_dict()
            data["activities"][1]["is_completed"] = True
            data["completed_minutes"] = 5
            plan_ref.set(data)

        self.db.before_commit = concurrent_completion
        result = await self.create(lesson_id=activity["activity_id"])
        plan = plan_ref.get().to_dict()
        self.assertEqual(plan["activities"][0]["session_id"], result.session_id)
        self.assertTrue(plan["activities"][1]["is_completed"])
        self.assertEqual(plan["completed_minutes"], 5)

    async def test_retry_activity_rejoins_same_session_with_saved_context_and_fresh_token(self):
        today, activity = self.add_activity()
        first = await self.create(lesson_id=activity["activity_id"], topic="Original topic", speech_language="hi")
        original = self.saved(first.session_id)
        self.ns["_mint_livekit_token"].return_value = ("fresh-token", datetime.now(timezone.utc))
        retry = await self.create(lesson_id=activity["activity_id"], topic="Different topic", speech_language="en")
        self.assertEqual(retry.session_id, first.session_id)
        self.assertEqual(retry.room_name, first.room_name)
        self.assertEqual(retry.livekit_token, "fresh-token")
        self.assertEqual(self.metadata(), original["session_context"])
        self.assertEqual(self.saved(first.session_id)["start_time"], original["start_time"])
        self.assertEqual(len(self.user_ref.collection("sessions").stream()), 1)
        self.assertEqual(self.user_ref.collection("daily_plans").document(today).get().to_dict()["activities"][0]["session_id"], first.session_id)

    async def test_token_failure_does_not_permanently_lock_daily_activity(self):
        _, activity = self.add_activity()
        self.ns["_mint_livekit_token"].side_effect = RuntimeError("Temporary signing failure")
        with self.assertRaises(RuntimeError):
            await self.create(lesson_id=activity["activity_id"])
        saved_id = self.user_ref.collection("sessions").stream()[0].id
        self.ns["_mint_livekit_token"].side_effect = None
        retry = await self.create(lesson_id=activity["activity_id"])
        self.assertEqual(retry.session_id, saved_id)
        self.assertEqual(len(self.user_ref.collection("sessions").stream()), 1)

    async def test_orphan_activity_session_id_can_be_replaced(self):
        today, activity = self.add_activity()
        plan_ref = self.user_ref.collection("daily_plans").document(today)
        plan_ref.set({"activities": [{**activity, "session_id": "missing-session", "status": "in_progress"}]})
        result = await self.create(lesson_id=activity["activity_id"])
        self.assertEqual(plan_ref.get().to_dict()["activities"][0]["session_id"], result.session_id)

    async def test_concurrent_activity_start_converges_on_one_session(self):
        today, activity = self.add_activity()
        plan_ref = self.user_ref.collection("daily_plans").document(today)

        def other_request_wins():
            self.user_ref.collection("sessions").document("winning-session").set({
                "session_id": "winning-session", "user_id": self.user["uid"], "state": "CREATED",
                "context_source": "daily_plan", "daily_activity_id": activity["activity_id"],
                "daily_plan_date": today, "target_skill": SKILL, "lesson_id": activity["activity_id"],
                "practice_activity": activity["prompt_activity"], "start_time": datetime.now(timezone.utc),
                "mode": "grammar_practice", "topic": "Winner's topic",
            })
            plan_ref.set({"activities": [{**activity, "session_id": "winning-session", "status": "in_progress"}]})

        self.db.before_commit = other_request_wins
        result = await self.create(lesson_id=activity["activity_id"])
        self.assertEqual(result.session_id, "winning-session")
        self.assertEqual(self.metadata()["topic"], "Winner's topic")
        self.assertEqual(len(self.user_ref.collection("sessions").stream()), 1)

    async def test_completed_activity_starts_separate_review_without_changing_plan(self):
        today, activity = self.add_activity()
        plan_ref = self.user_ref.collection("daily_plans").document(today)
        plan = {"activities": [{**activity, "is_completed": True, "session_id": "finished"}],
                "completed_minutes": 10, "completion_status": "completed"}
        plan_ref.set(plan)
        result = await self.create(lesson_id=activity["activity_id"])
        self.assertEqual(plan_ref.get().to_dict(), plan)
        self.assertIsNone(self.saved(result.session_id).get("daily_activity_id"))
        self.assertNotEqual(self.saved(result.session_id)["lesson_id"], activity["activity_id"])
        self.assertEqual(self.metadata()["practice_activity"], activity["prompt_activity"])

    async def test_legacy_activity_without_prompt_uses_curriculum_fallback(self):
        today, activity = self.add_activity()
        activity.pop("prompt_activity")
        self.user_ref.collection("daily_plans").document(today).set({"activities": [activity]})
        await self.create(lesson_id=activity["activity_id"])
        self.assertEqual(self.metadata()["practice_activity"], f"Curriculum practice for {SKILL}")

    async def test_legacy_started_activity_backfills_links_without_lesson_stub(self):
        today, activity = self.add_activity()
        self.user_ref.collection("sessions").document("legacy-start").set({
            "state": "IN_PROGRESS", "lesson_id": activity["activity_id"], "target_skill": SKILL,
            "mode": "grammar_practice", "start_time": datetime.now(timezone.utc),
        })
        self.user_ref.collection("daily_plans").document(today).set({
            "activities": [{**activity, "session_id": "legacy-start"}]})
        result = await self.create(lesson_id=activity["activity_id"])
        self.assertEqual(result.session_id, "legacy-start")
        self.assertEqual(self.saved(result.session_id)["daily_activity_id"], activity["activity_id"])
        self.assertEqual(self.saved(result.session_id)["daily_plan_date"], today)
        self.assertFalse(self.user_ref.collection("lessons").document(activity["activity_id"]).get().exists)

    async def test_foreign_session_pointer_never_grants_access_to_another_users_room(self):
        today, activity = self.add_activity()
        foreign = self.db.collection("users").document("other_user").collection("sessions").document("foreign-start")
        foreign.set({"state": "CREATED", "lesson_id": activity["activity_id"], "topic": "Private topic"})
        self.user_ref.collection("daily_plans").document(today).set({
            "activities": [{**activity, "session_id": "foreign-start"}]})
        result = await self.create(lesson_id=activity["activity_id"])
        self.assertNotEqual(result.session_id, "foreign-start")
        self.assertNotEqual(self.metadata()["topic"], "Private topic")
        self.assertEqual(foreign.get().to_dict()["topic"], "Private topic")

    async def test_completed_linked_session_is_not_reopened_before_completion_saved(self):
        today, activity = self.add_activity()
        first = await self.create(lesson_id=activity["activity_id"])
        self.user_ref.collection("sessions").document(first.session_id).update({
            "state": "COMPLETED", "end_time": datetime.now(timezone.utc)})
        self.ns["_mint_livekit_token"].reset_mock()
        with self.assertRaises(HTTPException) as caught:
            await self.create(lesson_id=activity["activity_id"])
        self.assertEqual(caught.exception.status_code, 409)
        self.assertIn("finish saving", caught.exception.detail)
        self.ns["_mint_livekit_token"].assert_not_called()
        self.assertEqual(len(self.user_ref.collection("sessions").stream()), 1)

    async def test_failed_session_can_be_replaced_without_erasing_its_history(self):
        today, activity = self.add_activity()
        first = await self.create(lesson_id=activity["activity_id"])
        self.user_ref.collection("sessions").document(first.session_id).update({"state": "FAILED"})
        retry = await self.create(lesson_id=activity["activity_id"])
        self.assertNotEqual(first.session_id, retry.session_id)
        self.assertEqual(self.saved(first.session_id)["state"], "FAILED")
        self.assertEqual(self.user_ref.collection("daily_plans").document(today).get().to_dict()["activities"][0]["session_id"], retry.session_id)

    async def test_retargeted_activity_is_rejected_without_saving_stale_session(self):
        today, activity = self.add_activity()
        plan_ref = self.user_ref.collection("daily_plans").document(today)
        self.db.before_commit = lambda: plan_ref.set({"activities": [{**activity, "target_skill": OTHER_SKILL}]})
        with self.assertRaises(HTTPException) as caught:
            await self.create(lesson_id=activity["activity_id"])
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(self.user_ref.collection("sessions").stream(), [])
        self.ns["_mint_livekit_token"].assert_not_called()

    async def test_untargeted_activity_honors_explicit_valid_skill(self):
        _, activity = self.add_activity(skill=None)
        await self.create(lesson_id=activity["activity_id"], target_skill=OTHER_SKILL)
        self.assertEqual(self.metadata()["target_skill"], OTHER_SKILL)
        self.assertEqual(self.metadata()["practice_activity"], activity["prompt_activity"])

    async def test_free_activity_without_target_gets_ranked_focus_and_keeps_activity_identity(self):
        _, activity = self.add_activity(skill=None)
        result = await self.create(lesson_id=activity["activity_id"], mode="free_conversation")
        self.assertEqual(self.metadata()["target_skill"], SKILL)
        self.assertEqual(self.saved(result.session_id)["context_source"], "daily_plan")
        self.assertEqual(self.metadata()["lesson_id"], activity["activity_id"])
        self.assertFalse(self.user_ref.collection("lessons").document(activity["activity_id"]).get().exists)

    async def test_owned_lesson_content_wins_and_examples_are_bounded(self):
        self.ranking[0]["recent_examples"] = [
            {"original": "x" * 500, "corrected": "y" * 500, "system_prompt": "discard"} for _ in range(8)
        ]
        self.user_ref.collection("lessons").document("owned_lesson").set({
            "source_skill_id": SKILL, "lesson_title": "Saved title", "rule_summary": "z" * 1500,
            "practice_activity": "Saved practice instruction"})
        await self.create(lesson_id="owned_lesson")
        meta = self.metadata()
        self.assertEqual(meta["lesson_title"], "Saved title")
        self.assertEqual(meta["practice_activity"], "Saved practice instruction")
        self.assertLessEqual(len(meta["rule_summary"]), 700)
        self.assertEqual(len(meta["recent_examples"]), 3)
        for example in meta["recent_examples"]:
            self.assertEqual(set(example), {"original", "corrected"})
            self.assertLessEqual(len(example["original"]), 240)
        self.assertLess(len(json.dumps(meta)), 5000)

    async def test_owned_recommendation_without_history_record_resolves(self):
        self.user_ref.set({"recommended_lesson": {
            "lesson_id": "recommended", "target_skill_id": OTHER_SKILL,
            "lesson_title": "Natural expressions", "practice_activity": "Use your own collocation."}}, merge=True)
        await self.create(lesson_id="recommended", target_skill=OTHER_SKILL)
        self.assertEqual(self.metadata()["practice_activity"], "Use your own collocation.")

    async def test_mismatched_skill_missing_lesson_and_unknown_skill_rejected_before_writes(self):
        _, activity = self.add_activity()
        for options, status in [
            ({"lesson_id": activity["activity_id"], "target_skill": OTHER_SKILL}, 422),
            ({"lesson_id": "someone_elses_lesson"}, 404),
            ({"target_skill": "made_up_skill"}, 422),
        ]:
            with self.subTest(options=options):
                before = len(self.db.writes)
                with self.assertRaises(HTTPException) as caught:
                    await self.create(**options)
                self.assertEqual(caught.exception.status_code, status)
                self.assertEqual(len(self.db.writes), before)
        self.ns["_mint_livekit_token"].assert_not_called()

    async def test_foreign_lesson_cannot_be_resolved(self):
        self.db.collection("users").document("other_user").collection("lessons").document("private").set({
            "source_skill_id": SKILL, "practice_activity": "Not this learner's content"})
        with self.assertRaises(HTTPException) as caught:
            await self.create(lesson_id="private")
        self.assertEqual(caught.exception.status_code, 404)

    async def test_rank_failure_degrades_to_unfocused_conversation_not_invented_weakness(self):
        self.ns["compute_focus_ranking"].side_effect = RuntimeError("offline unavailable")
        await self.create()
        self.assertIsNone(self.metadata()["target_skill"])
        self.assertEqual(self.metadata()["recent_examples"], [])

    async def test_assessment_mode_or_goal_never_loads_coaching(self):
        for options in ({"mode": "assessment", "conversation_goal": "grammar"},
                        {"conversation_goal": "assessment"}):
            with self.subTest(options=options):
                result = await self.create(**options, topic="Do not carry into assessment")
                self.assertEqual(self.metadata()["mode"], "assessment")
                self.assertEqual(self.metadata()["conversation_goal"], "assessment")
                self.assertIsNone(self.metadata()["target_skill"])
                self.assertIsNone(self.metadata()["topic"])
                self.assertEqual(self.metadata()["practice_activity"], "")
                self.assertEqual(self.metadata()["recent_examples"], [])
                self.assertEqual(self.saved(result.session_id)["session_context"], self.metadata())
        self.ns["compute_focus_ranking"].assert_not_called()
        self.ns["generate_personalized_lesson"].assert_not_called()

    async def test_assessment_rejects_explicit_coaching_context(self):
        with self.assertRaises(HTTPException) as caught:
            await self.create(mode="assessment", target_skill=SKILL)
        self.assertEqual(caught.exception.status_code, 422)

    async def test_refresh_preserves_full_snapshot_without_reranking(self):
        result = await self.create(speech_language="en")
        original = copy.deepcopy(self.metadata())
        self.ranking.reverse()
        self.user_ref.set({"hindi_support": "off"}, merge=True)
        await self.ns["refresh_session_token"](result.session_id, self.user, "refresh", Response())
        self.assertEqual(self.metadata(), original)
        self.ns["compute_focus_ranking"].assert_called_once()
        self.assertEqual(self.ns["_mint_livekit_token"].call_args.kwargs["participant_identity"], self.user["uid"])

    async def test_legacy_refresh_uses_saved_fields_overwrites_identity_and_strips_assessment_context(self):
        self.user_ref.collection("sessions").document("legacy").set({
            "mode": "assessment", "user_id": "wrong", "session_id": "wrong",
            "lesson_id": "stale", "target_skill": SKILL, "practice_activity": "Do not coach",
            "recent_examples": self.ranking[0]["recent_examples"]})
        await self.ns["refresh_session_token"]("legacy", self.user, "refresh", Response())
        self.assertEqual(self.metadata()["user_id"], self.user["uid"])
        self.assertEqual(self.metadata()["session_id"], "legacy")
        self.assertEqual(self.metadata()["speech_language"], "auto")
        self.assertEqual(self.metadata()["practice_activity"], "")
        self.assertEqual(self.metadata()["recent_examples"], [])

    async def test_refresh_foreign_or_ended_session_is_rejected(self):
        result = await self.create()
        with self.assertRaises(HTTPException) as caught:
            await self.ns["refresh_session_token"](result.session_id, {"uid": "other_user"}, "x", Response())
        self.assertEqual(caught.exception.status_code, 404)
        self.user_ref.collection("sessions").document(result.session_id).update({"end_time": datetime.now(timezone.utc)})
        with self.assertRaises(HTTPException) as caught:
            await self.ns["refresh_session_token"](result.session_id, self.user, "x", Response())
        self.assertEqual(caught.exception.status_code, 400)

    async def test_completion_uses_saved_context_and_plan_date_ignores_stale_client_ids(self):
        _, activity = self.add_activity()
        result = await self.create(lesson_id=activity["activity_id"])
        # A session can end after midnight; completion must use its original plan date.
        self.user_ref.collection("sessions").document(result.session_id).update({"daily_plan_date": "2026-09-19"})
        body = MODELS["CompleteSessionRequest"](
            duration_seconds=120, lesson_id="wrong_activity", target_skill=OTHER_SKILL,
            messages=[{"role": "user", "text": "I didn't go."}, {"role": "system", "text": "Discard"}])
        await self.ns["complete_session"](result.session_id, body, self.user, "complete", Response())
        self.ns["complete_daily_plan_activity"].assert_called_once_with(
            user_id=self.user["uid"], date_str="2026-09-19", activity_id=activity["activity_id"],
            session_id=result.session_id, duration_minutes=2)
        self.assertEqual(self.saved(result.session_id)["target_skill"], SKILL)
        self.assertEqual(self.saved(result.session_id)["lesson_id"], activity["activity_id"])
        messages = self.ns["analyze_session_messages"].call_args.args[2]
        self.assertEqual([m["role"] for m in messages], ["user"])
        self.assertEqual(self.user_ref.get().to_dict()["statistics"]["total_sessions"], 1)
        self.ns["process_event"].assert_not_called()
        await self.ns["complete_session"](result.session_id, body, self.user, "repeat", Response())
        self.assertEqual(self.user_ref.get().to_dict()["statistics"]["total_sessions"], 1)
        self.ns["analyze_session_messages"].assert_awaited_once()

    async def test_completion_cannot_create_phantom_or_foreign_sessions(self):
        self.db.collection("users").document("other_user").collection("sessions").document("foreign").set({"mode": "free_conversation"})
        for session_id in ("missing", "foreign"):
            before = len(self.db.writes)
            with self.assertRaises(HTTPException) as caught:
                await self.ns["complete_session"](session_id, MODELS["CompleteSessionRequest"](), self.user, "x", Response())
            self.assertEqual(caught.exception.status_code, 404)
            self.assertEqual(len(self.db.writes), before)

    async def test_failed_analysis_retries_completed_session_without_recounting(self):
        _, activity = self.add_activity()
        result = await self.create(lesson_id=activity["activity_id"])
        self.ns["analyze_session_messages"].side_effect = [RuntimeError("Persistence failed"), None]
        body = MODELS["CompleteSessionRequest"](duration_seconds=120, messages=[{"role": "user", "text": "I didn't go."}])
        first = await self.ns["complete_session"](result.session_id, body, self.user, "first", Response())
        self.assertTrue(first["retryable"])
        self.assertEqual(first["analysis_status"], "failed")
        self.assertEqual(self.saved(result.session_id)["analysis_status"], "failed")
        # A retry may omit the transcript and send a different duration.
        retry = MODELS["CompleteSessionRequest"](duration_seconds=999)
        completed = await self.ns["complete_session"](result.session_id, retry, self.user, "retry", Response())
        self.assertFalse(completed["retryable"])
        self.assertEqual(completed["analysis_status"], "completed")
        await self.ns["complete_session"](result.session_id, retry, self.user, "duplicate", Response())
        self.assertEqual(self.ns["analyze_session_messages"].await_count, 2)
        self.assertEqual(self.saved(result.session_id)["analysis_status"], "completed")
        self.assertEqual(self.saved(result.session_id)["duration_seconds"], 120)
        self.assertEqual(self.user_ref.get().to_dict()["statistics"]["total_sessions"], 1)
        self.assertEqual(self.user_ref.get().to_dict()["statistics"]["total_practice_minutes"], 2)
        self.ns["complete_daily_plan_activity"].assert_called_once()

    async def test_failed_plan_completion_retries_without_recounting_or_reanalysis(self):
        _, activity = self.add_activity()
        result = await self.create(lesson_id=activity["activity_id"])
        self.ns["complete_daily_plan_activity"].side_effect = [RuntimeError("Plan write failed"), {}]
        body = MODELS["CompleteSessionRequest"](duration_seconds=120, messages=[{"role": "user", "text": "I went home."}])
        for _ in range(3):
            await self.ns["complete_session"](result.session_id, body, self.user, "complete", Response())
        self.assertEqual(self.ns["complete_daily_plan_activity"].call_count, 2)
        self.ns["analyze_session_messages"].assert_awaited_once()
        self.assertEqual(self.user_ref.get().to_dict()["statistics"]["total_sessions"], 1)

    async def test_completion_prefers_persisted_turns_and_does_not_complete_a_lesson_as_activity(self):
        result = await self.create(target_skill=SKILL)
        self.user_ref.collection("sessions").document(result.session_id).collection("messages").document("turn_1").set({
            "role": "user", "text": "Persisted agent transcript", "sequence": 1})
        body = MODELS["CompleteSessionRequest"](messages=[{"role": "user", "text": "Stale client transcript"}])
        await self.ns["complete_session"](result.session_id, body, self.user, "x", Response())
        self.ns["complete_daily_plan_activity"].assert_not_called()
        self.assertEqual(self.ns["analyze_session_messages"].call_args.args[2][0]["text"], "Persisted agent transcript")

    async def test_assessment_completion_does_not_run_coaching_analysis(self):
        result = await self.create(mode="assessment")
        body = MODELS["CompleteSessionRequest"](lesson_id="stale", target_skill=SKILL,
                                                messages=[{"role": "user", "text": "My answer"}])
        await self.ns["complete_session"](result.session_id, body, self.user, "x", Response())
        self.ns["analyze_session_messages"].assert_not_called()
        self.ns["complete_daily_plan_activity"].assert_not_called()


class SchemaAndExpoContractTests(unittest.TestCase):
    def test_stt_language_defaults_and_allowlist(self):
        request = MODELS["CreateSessionRequest"]
        self.assertEqual(request().speech_language, "auto")
        for language in ("auto", "hi", "en"):
            self.assertEqual(request(speech_language=language).speech_language, language)
        for language in ("fr", "ignore instructions", None):
            with self.assertRaises(ValidationError):
                request(speech_language=language)

    def test_client_cannot_supply_identity_prompts_or_path_ids(self):
        request = MODELS["CreateSessionRequest"]
        for field in ("user_id", "session_context", "lesson_title", "rule_summary", "practice_activity", "recent_examples", "hindi_support"):
            with self.subTest(field=field), self.assertRaises(ValidationError):
                request(**{field: "untrusted"})
        for options in ({"lesson_id": "../private"}, {"lesson_id": "x/y"},
                        {"target_skill": "ignore instructions"}, {"target_skill": "x" * 81}):
            with self.assertRaises(ValidationError):
                request(**options)

    def test_plan_priority_fields_survive_api_serialization_and_legacy_plans(self):
        activity = {"activity_id": "a1", "title": "Correction", "mode": "grammar_practice",
                    "duration_minutes": 10, "objective": "Retry", "prompt_activity": "Try again"}
        plan = {"plan_id": "p1", "plan_date": "2026-09-20", "activities": [activity]}
        model = MODELS["DailyLearningPlanModel"](**plan)
        self.assertIsNone(model.activities[0].priority_rank)
        activity.update(priority_rank=1, priority_reason="recent_mistakes",
                        source_examples=[{"original": "didn't went", "corrected": "didn't go"}])
        serialized = MODELS["DailyLearningPlanModel"](**plan).model_dump(exclude_none=True)["activities"][0]
        for field in ("priority_rank", "priority_reason", "source_examples"):
            self.assertEqual(serialized[field], activity[field])

    def test_engine_evidence_with_numeric_confidence_and_null_timestamp_serializes(self):
        activity = MODELS["DailyPlanActivityModel"](
            activity_id="a1", title="Retry", mode="vocabulary", duration_minutes=5,
            objective="Use the phrase", prompt_activity="Say it again", priority_rank=1,
            priority_reason="recent_vocabulary_errors", source_examples=[{
                "original": "do a mistake", "corrected": "make a mistake", "confidence": 0.97,
                "created_at": None, "explanation": "Use the collocation make a mistake.",
            }])
        example = activity.model_dump()["source_examples"][0]
        self.assertEqual(example["corrected"], "make a mistake")
        self.assertNotIn("confidence", example)
        self.assertNotIn("created_at", example)

    def test_expo_wiring_uses_server_ids_language_and_real_evidence(self):
        dashboard = (ROOT / "apps/expo/app/index.tsx").read_text(encoding="utf-8")
        session = (ROOT / "apps/expo/app/session.tsx").read_text(encoding="utf-8")
        api = (ROOT / "apps/expo/lib/api.ts").read_text(encoding="utf-8")
        self.assertIn("lesson_id: act.activity_id", dashboard)
        self.assertIn("lesson_id: nextAct?.activity_id", dashboard)
        self.assertIn("lessonId: params.lesson_id", session)
        self.assertIn('speech_language: options.speechLanguage || "auto"', api)
        self.assertIn('useState<SpeechLanguage>("auto")', session)
        # Today's exercises stay readable: no raw engine instructions or correction
        # dumps on the cards. Recorded mistakes remain on the Mistakes tab.
        for field in ("source_examples", "prompt_activity", "priority_reason", "priority_rank"):
            self.assertNotIn(f"activity.{field}", dashboard)
        self.assertIn("skillLabel(activity.target_skill)", dashboard)
        # Exercise counts must come from the plan the server returned for the chosen goal.
        self.assertIn("orderedActivities.length", dashboard)
        self.assertIn("setDailyGoal(minutes)", dashboard)
        for option in ("echoCancellation", "noiseSuppression", "autoGainControl"):
            self.assertIn(f"{option}: true", session)
        self.assertIn("MICROPHONE_OPTIONS: AudioCaptureOptions", session)
        self.assertIn("setMicrophoneEnabled(true, MICROPHONE_OPTIONS)", session)
        self.assertIn("activeCorrection.explanation", session)
        self.assertNotIn("completeDailyActivity", session)
        self.assertNotIn("sessionSeconds * 0.45", session)
        self.assertNotIn("buildOptimisticActivities", dashboard)
        self.assertIn("getMistakes()", dashboard)
        self.assertIn("getVocabulary()", dashboard)


if __name__ == "__main__":
    # No service modules are imported; every I/O boundary in the extracted routes is mocked.
    # Do not patch socket.connect: Windows asyncio uses it for its local wakeup socketpair.
    unittest.main()