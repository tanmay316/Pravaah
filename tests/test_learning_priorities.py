"""Offline learning priorities: real snapshots/queries, no Firestore or provider calls."""

from contextlib import contextmanager, ExitStack
from collections.abc import Callable
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import importlib.util
import json
import os
from pathlib import Path
import socket
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch


NOW = datetime(2026, 9, 20, 12, tzinfo=timezone.utc)
DATE = "2026-09-20"
ENGINE = Path(__file__).resolve().parents[1] / "services" / "learning-engine"


class Increment:
    def __init__(self, value):
        self.value = value


class Snapshot:
    def __init__(self, ref):
        self.id = ref.id
        self.reference = ref
        self.exists = ref.path in ref.db.documents
        self.data = deepcopy(ref.db.documents.get(ref.path))

    def to_dict(self):
        return deepcopy(self.data)


class Document:
    def __init__(self, db, path):
        self.db, self.path = db, path
        self.id = path[-1]

    def collection(self, name):
        return Query(self.db, (*self.path, name))

    def get(self, transaction=None):
        snapshot = Snapshot(self)
        if transaction is not None:
            assert not transaction.operations, "Firestore requires reads before writes"
            transaction.reads[self.path] = snapshot.to_dict()
        return snapshot

    def set(self, data, merge=False):
        # Resolve server timestamps and copy values like a real database boundary.
        def resolve(value, previous=None):
            if value is self.db.server_timestamp:
                return NOW
            if isinstance(value, Increment):
                return (previous or 0) + value.value
            if isinstance(value, dict):
                existing = previous if isinstance(previous, dict) else {}
                return {**existing, **{k: resolve(v, existing.get(k)) for k, v in value.items()}}
            if isinstance(value, list):
                return [resolve(v) for v in value]
            return deepcopy(value)

        self.db.documents[self.path] = resolve(data, self.db.documents.get(self.path, {}) if merge else {})
        self.db.writes.append(self.path)


class Query:
    def __init__(self, db, path, filters=(), ordering=None, count=None):
        self.db, self.path = db, path
        self.filters, self.ordering, self.count = filters, ordering, count

    def document(self, name):
        return Document(self.db, (*self.path, name))

    def where(self, field, op, value):
        assert op == "=="
        return Query(self.db, self.path, (*self.filters, (field, value)), self.ordering, self.count)

    def order_by(self, field, direction="ASCENDING"):
        return Query(self.db, self.path, self.filters, (field, direction), self.count)

    def limit(self, count):
        return Query(self.db, self.path, self.filters, self.ordering, count)

    def stream(self):
        docs = [Document(self.db, p).get() for p in sorted(self.db.documents)
                if p[:-1] == self.path]
        for field, value in self.filters:
            docs = [d for d in docs if d.data.get(field) == value]
        if self.ordering:
            field, direction = self.ordering
            # Firestore order_by excludes records without the ordered field.
            docs = [d for d in docs if field in d.data]
            docs.sort(key=lambda d: str(d.data[field]), reverse=direction == "DESCENDING")
        return iter(docs[:self.count] if self.count is not None else docs)


class FakeFirestore:
    def __init__(self, server_timestamp):
        self.server_timestamp = server_timestamp
        self.documents = {}
        self.writes = []
        self.before_commit: Callable[[], None] | None = None

    def collection(self, name):
        return Query(self, (name,))

    def transaction(self):
        return Transaction(self)

    def batch(self):
        class Batch:
            def __init__(self):
                self.operations = []

            def set(self, ref, data, merge=False):
                self.operations.append((ref, data, merge))

            def commit(self):
                for ref, data, merge in self.operations:
                    ref.set(data, merge=merge)

        return Batch()


class Transaction:
    def __init__(self, db):
        self.db = db
        self.reads, self.operations = {}, []

    def set(self, ref, data, merge=False):
        self.operations.append((ref, data, merge))


def transactional(function):
    def run(transaction, *args, **kwargs):
        for _ in range(3):
            transaction.reads, transaction.operations = {}, []
            result = function(transaction, *args, **kwargs)
            hook, transaction.db.before_commit = transaction.db.before_commit, None
            if hook:
                hook()
            if any(transaction.db.documents.get(p) != value for p, value in transaction.reads.items()):
                continue
            for ref, data, merge in transaction.operations:
                ref.set(data, merge=merge)
            return result
        raise AssertionError("Transaction retries exhausted")
    return run


@contextmanager
def offline_engine():
    def forbidden(*args, **kwargs):
        raise AssertionError("Network/real Firebase is forbidden in learning priority tests")

    with ExitStack() as stack:
        stack.enter_context(patch.object(socket, "create_connection", forbidden))
        stack.enter_context(patch.object(socket.socket, "connect", forbidden))
        original_path = list(sys.path)
        stack.callback(lambda: sys.path.__setitem__(slice(None), original_path))
        stack.enter_context(patch.dict(sys.modules))
        # External adapters are inert even if their packages are not installed.
        # Curriculum/worker and their Pydantic validation remain real code.
        firestore = ModuleType("firebase_admin.firestore")
        firestore.SERVER_TIMESTAMP = object()
        firestore.Increment = Increment
        firestore.Query = SimpleNamespace(DESCENDING="DESCENDING")
        firestore.transactional = transactional
        firestore.client = forbidden
        firebase = ModuleType("firebase_admin")
        firebase.firestore = firestore
        firebase.credentials = SimpleNamespace(Certificate=forbidden)
        firebase.initialize_app = forbidden
        dotenv = ModuleType("dotenv")
        dotenv.load_dotenv = lambda *a, **kw: False
        sys.modules.update({"firebase_admin": firebase, "firebase_admin.firestore": firestore, "dotenv": dotenv})
        modules = []
        for name, filename in (("curriculum", "curriculum.py"), ("_priority_test_worker", "worker.py")):
            spec = importlib.util.spec_from_file_location(name, ENGINE / filename)
            module = importlib.util.module_from_spec(spec)
            sys.modules[name] = module
            spec.loader.exec_module(module)
            modules.append(module)
        curriculum, worker = modules

        class Clock(datetime):
            @classmethod
            def now(cls, tz=None):
                return NOW if tz else NOW.replace(tzinfo=None)

        stack.enter_context(patch.object(worker, "datetime", Clock))
        stack.enter_context(patch.object(worker, "CONFIDENCE_THRESHOLD", 0.75))
        db = FakeFirestore(firestore.SERVER_TIMESTAMP)
        stack.enter_context(patch.object(worker, "get_firestore_client", lambda: db))
        stack.enter_context(patch.object(worker, "_get_litellm", forbidden))
        yield curriculum, worker, db


def cases(*values):
    """Parameterize stdlib unittest function tests without a pytest dependency."""
    def decorate(test):
        test.cases = values
        return test
    return decorate


def run_offline(coroutine):
    """These explicit-evidence paths never suspend. Avoid Windows event-loop IPC
    sockets too, so the network guard can reject *every* connection attempt.
    """
    try:
        coroutine.send(None)
    except StopIteration as result:
        return result.value
    finally:
        coroutine.close()
    raise AssertionError("Offline learning path unexpectedly suspended for I/O")


def user(db, uid="learner"):
    return db.collection("users").document(uid)


def mistake(**overrides):
    return {
        "original": "I didn't went", "corrected": "I didn't go",
        "curriculum_skill_id": "past_simple_auxiliary", "category": "past_simple_auxiliary",
        "fact_type": "grammar_error", "confidence": 0.95, "severity": "high",
        "session_id": "s1", "message_id": "m1", "created_at": NOW,
        **overrides,
    }


def vocab(**overrides):
    return {
        "original_usage": "I made a party", "suggested_alternative": "I had a party",
        "curriculum_skill_id": "collocations", "fact_type": "vocabulary_error",
        "confidence": 0.95, "session_id": "s1", "message_id": "v1", "created_at": NOW,
        **overrides,
    }


def test_vocabulary_only_evidence_beats_generic_mastery(engine):
    _, worker, db = engine
    user(db).set({"skill_mastery": {"articles": 0.1, "collocations": 0.9}})
    user(db).collection("vocabulary").document("v1").set(vocab())
    ranking = worker.compute_focus_ranking("learner", db)
    assert ranking[0]["skill_id"] == "collocations"
    assert ranking[0]["recent_examples"][0]["original"] == "I made a party"
    plan = worker.get_or_create_daily_plan("learner", DATE)
    assert plan["activities"][0]["target_skill"] == "collocations"
    assert plan["activities"][0]["mode"] == "vocabulary"
    assert "I had a party" in plan["activities"][0]["prompt_activity"]


@cases(
    {"fact_type": "natural_alternative"}, {"fact_type": "no_issue"},
    {"confidence": 0.4}, {"confidence": None}, {"confidence": "nan"},
    {"original": " ", "corrected": "hello"}, {"corrected": "I didn't went"},
    {"role": "assistant"}, {"card_type": "translation"},
    {"original": "मुझे अंग्रेज़ी सीखनी है", "corrected": "I want to learn English"},
    {"original": "mujhe English seekhni hai", "corrected": "I want to learn English"},
    {"original": "kal main bazaar gaya tha", "corrected": "I went to the market yesterday"},
    {"language": "hi"},
)
def test_non_error_evidence_does_not_change_ranking(engine, changes):
    _, worker, db = engine
    before = worker.compute_focus_ranking("learner", db)
    user(db).collection("mistakes").document("bad").set(mistake(**changes))
    after = worker.compute_focus_ranking("learner", db)
    assert [(r["skill_id"], r["priority_score"]) for r in after] == [
        (r["skill_id"], r["priority_score"]) for r in before
    ]
    assert all(not r["recent_examples"] for r in after)


@cases((15, 2), (30, 4), (60, 6), (90, 6))
def test_plan_starts_with_ranked_retry_then_transfer(engine, minutes, count):
    curriculum, worker, db = engine
    user(db).collection("mistakes").document("m1").set(mistake())
    ranking = worker.compute_focus_ranking("learner", db)
    plan = curriculum.generate_daily_plan(
        "learner", minutes, current_focus="articles", date_str=DATE, priority_focus=ranking
    )
    assert sum(a.duration_minutes for a in plan.activities) == minutes == plan.planned_minutes
    assert len(plan.activities) == count
    first = plan.activities[0]
    assert first.target_skill == ranking[0]["skill_id"]
    assert first.mode == "grammar_practice"
    assert first.priority_rank == 1 and first.priority_reason
    assert first.source_examples[0]["original"] == "I didn't went"
    assert "I didn't go" in first.prompt_activity and "retry" in first.prompt_activity.lower()
    assert plan.activities[-1].mode in {"review", "free_conversation"}
    assert "I didn't go" in plan.activities[-1].prompt_activity


def test_evidence_refresh_keeps_ids_and_completed_progress(engine):
    _, worker, db = engine
    plan = worker.get_or_create_daily_plan("learner", DATE)
    ids = [a["activity_id"] for a in plan["activities"]]
    completed = worker.complete_daily_plan_activity(
        "learner", DATE, ids[0], "completed-session", 7,
        learner_speaking_time_seconds=123, idle_time_seconds=17,
    )
    user(db).collection("vocabulary").document("v1").set(vocab())
    refreshed = worker.get_or_create_daily_plan("learner", DATE)
    assert refreshed["activities"][0] == completed["activities"][0]
    assert [a["activity_id"] for a in refreshed["activities"]] == ids
    assert refreshed["activities"][1]["target_skill"] == "collocations"
    assert refreshed["completed_minutes"] == 7
    assert refreshed["total_learner_speaking_seconds"] == 123
    assert refreshed["total_idle_seconds"] == 17
    assert refreshed["current_activity_index"] == 1
    assert refreshed["plan_id"] == plan["plan_id"]
    forced = worker.get_or_create_daily_plan("learner", DATE, force_regenerate=True)
    assert forced["activities"][0] == completed["activities"][0]
    assert forced["completed_minutes"] == 7
    # An old client can still finish a previously fetched slot.
    finished = worker.complete_daily_plan_activity("learner", DATE, ids[1], "pending-session", 5)
    assert finished["completed_activities_count"] == 2
    duplicate = worker.complete_daily_plan_activity("learner", DATE, ids[1], "pending-session", 5)
    assert duplicate["completed_minutes"] == finished["completed_minutes"]


def test_unchanged_evidence_does_not_rewrite_plan(engine):
    _, worker, db = engine
    first = worker.get_or_create_daily_plan("learner", DATE)
    writes = len(db.writes)
    second = worker.get_or_create_daily_plan("learner", DATE)
    assert second == first
    assert len(db.writes) == writes


def test_recency_severity_dedup_and_fresh_skill_mastery(engine):
    _, worker, db = engine
    ref = user(db)
    ref.set({"skill_mastery": {"articles": 0.1, "collocations": 0.99}})
    ref.collection("skills").document("articles").set({"mastery": 0.99})
    ref.collection("vocabulary").document("v1").set(vocab(created_at=NOW.isoformat()))
    ref.collection("mistakes").document("duplicate").set(mistake(
        original="I made a party", corrected="I had a party", message_id="v1",
        curriculum_skill_id="collocations", fact_type="vocabulary_error", severity="medium",
        created_at=NOW.isoformat(),
    ))
    ref.collection("mistakes").document("old").set(mistake(created_at=(NOW - timedelta(days=60)).isoformat()))
    ranking = worker.compute_focus_ranking("learner", db)
    assert ranking[0]["skill_id"] == "collocations"
    assert ranking[0]["mistake_count"] == 1
    assert next(r for r in ranking if r["skill_id"] == "articles")["mastery"] == 0.99
    assert len({r["skill_id"] for r in ranking}) == len(ranking)


def test_failures_and_only_current_unfinished_lesson_deficits(engine):
    curriculum, worker, db = engine
    ref = user(db)
    ref.set({"skill_mastery": {s: 0.9 for s in curriculum.CURRICULUM_SKILLS}})
    ref.collection("skills").document("prepositions").set({"mastery": 0.9, "failed_repetitions": 2})
    rank = worker.compute_focus_ranking("learner", db)
    assert rank[0]["skill_id"] == "prepositions"
    assert rank[0]["stage"] == "guided_practice"
    ref.collection("skills").document("prepositions").set({"successful_repetitions": 2}, merge=True)
    ref.collection("skills").document("articles").set({"mastery": 0.5})
    ref.collection("skills").document("stative_verbs").set({"mastery": 0.5})
    ref.collection("lessons").document("active").set({
        "source_skill_id": "stative_verbs", "completion_status": "in_progress",
    })
    # Stale recommendations and completed failures must not bias the ranking.
    for status in ("recommended", "completed", "abandoned"):
        ref.collection("lessons").document(status).set({
            "source_skill_id": "articles", "completion_status": status, "failed_repetitions": 99,
        })
    rank = worker.compute_focus_ranking("learner", db)
    assert rank[0]["skill_id"] == "stative_verbs"
    assert rank[0]["reason"] == "unfinished_lesson"


@cases("activity", "lesson")
def test_explicit_in_progress_target_is_frozen(engine, tracking):
    _, worker, db = engine
    plan = worker.get_or_create_daily_plan("learner", DATE)
    activity = plan["activities"][0]
    if tracking == "activity":
        activity["status"] = "in_progress"
        user(db).collection("daily_plans").document(DATE).set(plan)
    else:
        user(db).collection("lessons").document(activity["activity_id"]).set({
            "completion_status": "in_progress", "source_skill_id": activity["target_skill"],
        })
    user(db).collection("vocabulary").document("v1").set(vocab())
    refreshed = worker.get_or_create_daily_plan("learner", DATE, force_regenerate=True)
    assert refreshed["activities"][0] == activity
    assert refreshed["activities"][1]["target_skill"] == "collocations"
    assert refreshed["planned_minutes"] == 30


def test_goal_change_preserves_all_issued_ids_and_completed_day(engine):
    _, worker, db = engine
    plan = worker.get_or_create_daily_plan("learner", DATE, 90)
    ids = [a["activity_id"] for a in plan["activities"]]
    smaller = worker.get_or_create_daily_plan("learner", DATE, 15, True)
    assert smaller["planned_minutes"] == 15
    assert [a["activity_id"] for a in smaller["activities"]] == ids
    for activity_id in ids:
        completed = worker.complete_daily_plan_activity("learner", DATE, activity_id)
    user(db).collection("vocabulary").document("v1").set(vocab())
    forced = worker.get_or_create_daily_plan("learner", DATE, 60, True)
    assert forced["activities"] == completed["activities"]
    assert forced["completed_minutes"] == completed["completed_minutes"]
    assert forced["completion_status"] == "completed"
    assert forced["current_activity_index"] == len(ids)


def test_mastery_saves_vocabulary_before_canonical_lesson_and_plan(engine):
    _, worker, db = engine
    ref = user(db)
    ref.set({"skill_mastery": {"collocations": 0.9, "articles": 0.1}, "pravaah_level": "C"})
    analysis = worker.SessionAnalysisResult(vocabulary=[worker.VocabularyOpportunityFact(**vocab())])
    messages = [{"message_id": "v1", "role": "user", "text": "I made a party", "sequence": 1},
                {"role": "assistant", "text": "Try saying 'I had a party'.", "sequence": 2},
                {"role": "user", "text": "I made a party", "sequence": 3}]
    result = run_offline(worker.update_learner_mastery("learner", "s1", analysis, messages))
    rank = worker.compute_focus_ranking("learner", db)
    plan = worker.get_or_create_daily_plan("learner", DATE)
    assert result["current_focus"] == rank[0]["skill_id"] == plan["activities"][0]["target_skill"] == "collocations"
    skill = ref.collection("skills").document("collocations").get().to_dict()
    assert skill["errors"] == 1 and skill["mastery"] == 0.82
    assert skill["failed_repetitions"] == 1
    assert "I had a party" in result["recommended_lesson"]["practice_activity"]
    # Idempotent reruns do not add errors or complete an unrelated daily slot.
    run_offline(worker.update_learner_mastery("learner", "s1", analysis, messages))
    assert ref.collection("skills").document("collocations").get().to_dict() == skill
    assert worker.get_or_create_daily_plan("learner", DATE)["completed_activities_count"] == 0


@cases("daily_activity_id", "daily_plan_activity_id", "activity_id", "lesson_id")
def test_daily_activity_history_does_not_collide_and_completes_saved_day(engine, field):
    _, worker, db = engine
    ref = user(db)
    yesterday = "2026-09-19"
    old = worker.get_or_create_daily_plan("learner", yesterday)
    activity_id = old["activities"][0]["activity_id"]
    today = worker.get_or_create_daily_plan("learner", DATE)
    # Same ID on two dates exposes accidental use of today's plan.
    today["activities"][0]["activity_id"] = activity_id
    ref.collection("daily_plans").document(DATE).set(today)
    unrelated_lesson = {"source_skill_id": "articles", "completion_status": "recommended"}
    ref.collection("lessons").document(activity_id).set(unrelated_lesson)
    ref.collection("sessions").document("s1").set({
        field: activity_id, "daily_plan_date": yesterday, "target_skill": "collocations",
        "duration_seconds": 120, "duration_minutes": 2,
    })
    analysis = worker.SessionAnalysisResult(vocabulary=[worker.VocabularyOpportunityFact(**vocab())])
    messages = [{"message_id": "v1", "role": "user", "text": "I made a party"}]
    run_offline(worker.update_learner_mastery("learner", "s1", analysis, messages))
    assert ref.collection("lessons").document(activity_id).get().to_dict() == unrelated_lesson
    histories = [d.to_dict() for d in ref.collection("lessons").stream()
                 if d.to_dict().get("session_id") == "s1"]
    assert len(histories) == 1
    assert histories[0]["daily_activity_id"] == activity_id
    assert histories[0]["daily_plan_date"] == yesterday
    assert histories[0]["completion_status"] == "completed"
    completed = ref.collection("daily_plans").document(yesterday).get().to_dict()
    assert completed["activities"][0]["is_completed"]
    assert completed["activities"][0]["status"] == "completed"
    assert completed["completed_minutes"] == 2
    assert ref.collection("daily_plans").document(DATE).get().to_dict() == today
    before = deepcopy(db.documents)
    run_offline(worker.update_learner_mastery("learner", "s1", analysis, messages))
    assert db.documents == before


def test_actual_lesson_id_is_not_a_daily_activity_even_when_ids_match(engine):
    _, worker, db = engine
    ref = user(db)
    plan = worker.get_or_create_daily_plan("learner", DATE)
    lesson_id = plan["activities"][0]["activity_id"]
    ref.collection("sessions").document("s1").set({
        "context_source": "lesson", "lesson_id": lesson_id, "target_skill": "collocations",
    })
    analysis = worker.SessionAnalysisResult(vocabulary=[worker.VocabularyOpportunityFact(**vocab())])
    run_offline(worker.update_learner_mastery("learner", "s1", analysis,
                                           [{"message_id": "v1", "role": "user", "text": "I made a party"}]))
    assert ref.collection("lessons").document(lesson_id).get().to_dict()["completion_status"] == "completed"
    assert ref.collection("daily_plans").document(DATE).get().to_dict() == plan


def test_plan_refresh_transaction_preserves_start_committed_during_refresh(engine):
    _, worker, db = engine
    plan = worker.get_or_create_daily_plan("learner", DATE)
    ref = user(db).collection("daily_plans").document(DATE)
    started = {**plan["activities"][0], "status": "in_progress", "session_id": "s1", "started_at": NOW.isoformat()}

    def concurrent_start():
        latest = ref.get().to_dict()
        latest["activities"][0] = started
        ref.set(latest)

    db.before_commit = concurrent_start
    user(db).collection("vocabulary").document("v1").set(vocab())
    refreshed = worker.get_or_create_daily_plan("learner", DATE, force_regenerate=True)
    assert refreshed["activities"][0] == started
    assert ref.get().to_dict()["activities"][0] == started


@cases(False, True)
def test_direct_analysis_updates_mastery_and_recommendation_once(engine, with_error):
    _, worker, db = engine
    payload = {"mistakes": [], "vocabulary": [vocab()] if with_error else []}
    response = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps(payload, default=str)))])
    provider = SimpleNamespace(acompletion=AsyncMock(return_value=response))
    messages = [{"message_id": "v1", "role": "user", "text": "I made a party" if with_error else "I went home."}]
    with patch.dict(os.environ, {"GROQ_API_KEY": "", "GEMINI_API_KEY": ""}), \
            patch.object(worker, "GEMINI_API_KEY", ""), patch.object(worker, "_get_litellm", return_value=provider):
        run_offline(worker.analyze_session_messages("learner", "s1", messages))
        ref = user(db)
        assert ref.get().to_dict()["recommended_lesson"]
        skill = "collocations" if with_error else "sentence_structure"
        assert ref.collection("skills").document(skill).get().to_dict()["attempts"] == 1
        before = deepcopy(db.documents)
        run_offline(worker.analyze_session_messages("learner", "s1", messages))
        assert db.documents == before
        provider.acompletion.assert_awaited_once()


def test_analysis_persistence_failure_is_retryable_with_cached_facts(engine):
    _, worker, db = engine
    payload = {"vocabulary": [vocab()]}
    response = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps(payload, default=str)))])
    provider = SimpleNamespace(acompletion=AsyncMock(return_value=response))
    messages = [{"message_id": "v1", "role": "user", "text": "I made a party"}]
    ref = user(db)
    with patch.dict(os.environ, {"GROQ_API_KEY": "", "GEMINI_API_KEY": ""}), \
            patch.object(worker, "GEMINI_API_KEY", ""), patch.object(worker, "_get_litellm", return_value=provider):
        # Fail after skills were persisted, before the recommendation can be saved.
        with patch.object(worker, "generate_personalized_lesson", side_effect=RuntimeError("Persistence unavailable")):
            with unittest.TestCase().assertRaises(RuntimeError):
                run_offline(worker.analyze_session_messages("learner", "s1", messages))
        skill = ref.collection("skills").document("collocations").get().to_dict()
        assert skill["errors"] == 1
        run_offline(worker.analyze_session_messages("learner", "s1", messages))
        assert ref.collection("skills").document("collocations").get().to_dict() == skill
        assert ref.get().to_dict()["recommended_lesson"]
        assert ref.collection("sessions").document("s1").get().to_dict()["analysis_status"] == "completed"
        provider.acompletion.assert_awaited_once()


def test_provider_exhaustion_does_not_reward_clean_usage_or_claim_success(engine):
    _, worker, db = engine
    provider = SimpleNamespace(acompletion=AsyncMock(side_effect=RuntimeError("Provider unavailable")))
    with patch.dict(os.environ, {"GROQ_API_KEY": "", "GEMINI_API_KEY": ""}), \
            patch.object(worker, "GEMINI_API_KEY", ""), patch.object(worker, "_get_litellm", return_value=provider):
        with unittest.TestCase().assertRaises(RuntimeError):
            run_offline(worker.analyze_session_messages("learner", "s1", [{"role": "user", "text": "I went home."}]))
    assert not list(user(db).collection("skills").stream())
    assert (user(db).collection("sessions").document("s1").get().to_dict() or {}).get("analysis_status") != "completed"


def test_api_start_refresh_completion_and_analysis_retry_share_durable_state(engine):
    """Real route bodies + real worker/curriculum, fake only external boundaries."""
    from test_tutor_session_context import load_routes

    curriculum, worker, db = engine
    ns = load_routes()
    ns.update(
        firestore=worker.firestore, get_firestore_client=lambda: db,
        datetime=worker.datetime, CURRICULUM_SKILLS=curriculum.CURRICULUM_SKILLS,
        compute_focus_ranking=worker.compute_focus_ranking,
        generate_personalized_lesson=curriculum.generate_personalized_lesson,
        complete_daily_plan_activity=worker.complete_daily_plan_activity,
        analyze_session_messages=worker.analyze_session_messages,
        _mint_livekit_token=lambda *a, **kw: ("offline-token", NOW),
        asyncio=SimpleNamespace(to_thread=AsyncMock(side_effect=lambda fn, *a: fn(*a))),
    )
    ref = user(db)
    plan = worker.get_or_create_daily_plan("learner", DATE)
    activity_id = plan["activities"][0]["activity_id"]
    identity = {"uid": "learner"}
    created = run_offline(ns["create_session"](
        ns["CreateSessionRequest"](lesson_id=activity_id), identity, "start", ns["Response"]()))
    session_id = created.session_id
    started = ref.collection("daily_plans").document(DATE).get().to_dict()["activities"][0]
    assert started["session_id"] == session_id and started["status"] == "in_progress"
    assert not ref.collection("lessons").document(activity_id).get().exists
    ref.collection("vocabulary").document("new-evidence").set(vocab())
    refreshed = worker.get_or_create_daily_plan("learner", DATE, force_regenerate=True)
    assert refreshed["activities"][0] == started

    next_day = "2026-09-21"
    untouched_plan = worker.get_or_create_daily_plan("learner", next_day)

    class Tomorrow(datetime):
        @classmethod
        def now(cls, tz=None):
            return NOW + timedelta(days=1)

    ns["datetime"] = Tomorrow
    payload = {"vocabulary": [vocab(session_id=session_id)]}
    response = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps(payload, default=str)))])
    provider = SimpleNamespace(acompletion=AsyncMock(return_value=response))
    body = ns["CompleteSessionRequest"](duration_seconds=120, messages=[{"role": "user", "text": "I made a party"}])
    with patch.dict(os.environ, {"GROQ_API_KEY": "", "GEMINI_API_KEY": ""}), \
            patch.object(worker, "GEMINI_API_KEY", ""), patch.object(worker, "datetime", Tomorrow), \
            patch.object(worker, "_get_litellm", return_value=provider):
        with patch.object(worker, "generate_personalized_lesson", side_effect=RuntimeError("Recommendation save failed")):
            run_offline(ns["complete_session"](session_id, body, identity, "first", ns["Response"]()))
        saved = ref.collection("sessions").document(session_id).get().to_dict()
        assert saved["state"] == "COMPLETED" and saved["analysis_status"] == "failed"
        assert ref.collection("skills").document("collocations").get().to_dict()["errors"] == 1
        retry = ns["CompleteSessionRequest"]()  # Resume using the durably saved transcript.
        run_offline(ns["complete_session"](session_id, retry, identity, "retry", ns["Response"]()))
        before = deepcopy(db.documents)
        run_offline(ns["complete_session"](session_id, retry, identity, "duplicate", ns["Response"]()))
        assert db.documents == before
        provider.acompletion.assert_awaited_once()
    assert ref.get().to_dict()["statistics"]["total_sessions"] == 1
    assert ref.get().to_dict()["statistics"]["total_practice_minutes"] == 2
    assert ref.get().to_dict()["recommended_lesson"]["target_skill_id"] == "collocations"
    assert ref.collection("sessions").document(session_id).get().to_dict()["analysis_status"] == "completed"
    assert ref.collection("daily_plans").document(DATE).get().to_dict()["completed_minutes"] == 2
    assert ref.collection("daily_plans").document(next_day).get().to_dict() == untouched_plan
    assert not ref.collection("lessons").document(activity_id).get().exists


def test_new_failed_retry_not_hidden_by_old_successes(engine):
    _, worker, db = engine
    ref = user(db)
    ref.collection("skills").document("collocations").set({
        "mastery": 0.9, "successful_repetitions": 10, "failed_repetitions": 0,
    })
    analysis = worker.SessionAnalysisResult(vocabulary=[worker.VocabularyOpportunityFact(**vocab())])
    messages = [{"message_id": "v1", "role": "user", "text": "I made a party", "sequence": 1},
                {"role": "assistant", "text": "Try saying 'I had a party'.", "sequence": 2},
                {"role": "user", "text": "I made a party", "sequence": 3}]
    run_offline(worker.update_learner_mastery("learner", "s1", analysis, messages))
    assert worker.compute_focus_ranking("learner", db)[0]["unresolved_repetitions"] == 1


def test_unrelated_or_hindi_reply_does_not_count_as_failed_retry(engine):
    _, worker, _ = engine
    analysis = worker.SessionAnalysisResult(mistakes=[worker.GrammarMistakeFact(**mistake())])
    messages = [{"message_id": "m1", "role": "user", "text": "I didn't went", "sequence": 1},
                {"role": "assistant", "text": "Try saying 'I agree'.", "sequence": 2},
                {"role": "user", "text": "I disagree", "sequence": 3}]
    assert worker._repetition_evidence(analysis, messages) == ({}, {})
    messages[1]["text"] = "Try saying 'I didn't go'."
    messages[2]["text"] = "mujhe samajh nahi aaya"
    assert worker._repetition_evidence(analysis, messages) == ({}, {})


def test_missing_classification_or_confidence_is_not_validated_evidence(engine):
    _, worker, db = engine
    for key in ("confidence", "fact_type", "session_id", "message_id"):
        data = mistake()
        data.pop(key)
        user(db).collection("mistakes").document(key).set(data)
    assert all(r["mistake_count"] == 0 for r in worker.compute_focus_ranking("learner", db))


def test_optional_vocabulary_does_not_refresh_plan(engine):
    _, worker, db = engine
    plan = worker.get_or_create_daily_plan("learner", DATE)
    user(db).collection("vocabulary").document("optional").set(vocab(fact_type="natural_alternative"))
    assert worker.get_or_create_daily_plan("learner", DATE) == plan


def test_ranking_failure_keeps_existing_plan_and_legacy_mock_reads_are_safe(engine):
    _, worker, _ = engine
    plan = worker.get_or_create_daily_plan("learner", DATE)
    with patch.object(worker, "compute_focus_ranking", side_effect=RuntimeError("offline read failure")):
        assert worker.get_or_create_daily_plan("learner", DATE, force_regenerate=True) == plan
    # Unconfigured MagicMock snapshots must never turn into learner evidence.
    rank = worker.compute_focus_ranking("mock-user", db=MagicMock())
    assert all(not r["recent_examples"] for r in rank)


@cases(
    {"fact_type": "natural_alternative"}, {"confidence": 0.2},
    {"original": "mujhe English seekhni hai", "corrected": "I want to learn English"},
)
def test_unsafe_facts_never_create_failures_or_mastery_penalties(engine, changes):
    _, worker, db = engine
    data = mistake(**changes)
    analysis = worker.SessionAnalysisResult(mistakes=[worker.GrammarMistakeFact(**data)])
    messages = [{"message_id": "m1", "role": "user", "text": data["original"], "sequence": 1},
                {"role": "assistant", "text": f"Try saying '{data['corrected']}'.", "sequence": 2},
                {"role": "user", "text": data["original"], "sequence": 3}]
    assert worker._repetition_evidence(analysis, messages) == ({}, {})
    run_offline(worker.update_learner_mastery("learner", "s1", analysis, messages))
    assert not user(db).collection("skills").document("past_simple_auxiliary").get().exists
    assert all(r["mistake_count"] == 0 for r in worker.compute_focus_ranking("learner", db))


def test_tutor_only_quote_cannot_be_learner_error(engine):
    _, worker, _ = engine
    analysis = worker.SessionAnalysisResult(mistakes=[worker.GrammarMistakeFact(**mistake())])
    messages = [{"message_id": "m1", "role": "assistant", "text": "I didn't went", "sequence": 1},
                {"role": "user", "text": "I went home", "sequence": 2}]
    assert worker._analysis_errors(analysis, messages) == []


def test_legacy_inputs_and_user_isolation(engine):
    curriculum, worker, db = engine
    for minutes in (15, 30, 60, 90):
        plan = curriculum.generate_daily_plan("legacy", minutes, ["articles"], "articles", {"articles": 0.3}, DATE)
        assert plan.activities[0].target_skill == "articles" and plan.planned_minutes == minutes
    first = worker.get_or_create_daily_plan("one", DATE)
    second = worker.get_or_create_daily_plan("two", DATE)
    assert first["plan_id"] != second["plan_id"]
    user(db, "one").collection("vocabulary").document("v1").set(vocab())
    worker.get_or_create_daily_plan("one", DATE)
    assert worker.get_or_create_daily_plan("two", DATE) == second


def test_assessment_uses_ranking_and_keeps_completed_records(engine):
    _, worker, db = engine
    plan = worker.get_or_create_daily_plan("learner", DATE)
    completed = worker.complete_daily_plan_activity("learner", DATE, plan["activities"][0]["activity_id"])
    user(db).collection("vocabulary").document("v1").set(vocab())
    result = run_offline(worker.apply_proficiency_assessment(
        "learner", assessment_input={"pravaah_level": "B", "goal_minutes": 30},
    ))
    rank = worker.compute_focus_ranking("learner", db)
    assert result["recommended_lesson"]["target_skill_id"] == rank[0]["skill_id"]
    assert result["daily_plan"]["activities"][0] == completed["activities"][0]
    assert result["daily_plan"]["activities"][1]["target_skill"] == rank[0]["skill_id"]


class LearningPriorityTests(unittest.TestCase):
    """Collected by both unittest and pytest, without depending on pytest."""


def _install_cases():
    """Each parameterized method gets fresh modules and an isolated fake database."""
    for name, function in sorted(globals().items()):
        if not name.startswith("test_") or not callable(function):
            continue
        function.__test__ = False  # Don't collect function-style templates as pytest fixtures.
        for index, arguments in enumerate(getattr(function, "cases", ((),))):
            args = arguments if isinstance(arguments, tuple) else (arguments,)

            def run(self, function=function, args=args):
                with offline_engine() as engine:
                    function(engine, *args)

            setattr(LearningPriorityTests, f"{name}_{index}", run)


_install_cases()


if __name__ == "__main__":
    unittest.main()