"""Offline voice-policy regressions. No SDK, model, microphone or network required.

Exercise production prompt/hook functions extracted by AST; stub only the SDK
boundary. These tests do not claim to measure acoustic accuracy or LLM behavior.
"""
import ast
import asyncio
import importlib.util
import json
import logging
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch


ROOT = Path(__file__).resolve().parents[1]
VOICE = ROOT / "services" / "voice-agent"
spec = importlib.util.spec_from_file_location("voice_coaching_policy", VOICE / "coaching.py")
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


class StopResponse(Exception):
    pass


class StubAgent:
    def __init__(self, *, instructions):
        self.instructions = instructions

    default = SimpleNamespace(llm_node=None)


def agent_namespace():
    tree = ast.parse((VOICE / "agent.py").read_text(encoding="utf-8"))
    names = {"DEFAULT_CONTEXT", "first_name", "parse_session_context", "build_mode_instructions",
             "build_greeting", "EnglishTutor", "run_parallel_accuracy_check"}
    nodes = [n for n in tree.body if getattr(n, "name", None) in names or (
        isinstance(n, ast.Assign) and any(getattr(t, "id", None) in names for t in n.targets))]
    namespace = {"asyncio": asyncio, "os": os, "json": json, "Agent": StubAgent,
                 "agent_llm": SimpleNamespace(StopResponse=StopResponse),
                 "logger": logging.getLogger("test-voice"), "AsyncOpenAI": Mock(),
                 "GEMINI_CARD_CHAIN": ["test-model"], "emit_event": AsyncMock(), "make_event": Mock(),
                 **{n: getattr(policy, n) for n in (
                     "is_meaningful_speech", "CorrectionCard", "CARD_INSTRUCTIONS")}}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(VOICE / "agent.py"), "exec"), namespace)
    return namespace


class SpeechPolicyTests(unittest.TestCase):
    def test_noise_is_not_an_utterance(self):
        for text in ("", "  ", "[Music]", "(Laughter)", "*sniff*", "...", "cough", "hmm"):
            with self.subTest(text=text):
                self.assertFalse(policy.is_meaningful_speech(text))

    def test_keep_real_short_answers_and_hindi(self):
        for text in ("I", "a", "go", "yes", "no", "ok", "you", "thanks", "bye", "हाँ", "जी", "नहीं", "मैं ठीक हूँ।"):
            with self.subTest(text=text):
                self.assertTrue(policy.is_meaningful_speech(text))

    def test_language_modes_and_verbatim_prompt(self):
        with patch.dict(os.environ, {}, clear=True):
            auto = policy.stt_options({})
            self.assertTrue(auto["detect_language"])
            self.assertEqual(auto["model"], "whisper-large-v3-turbo")
            hindi = policy.stt_options({"speech_language": "hi"})
            self.assertEqual(hindi["language"], "hi")
            self.assertEqual(hindi["model"], "whisper-large-v3")
            self.assertFalse(hindi["detect_language"])
            self.assertFalse(policy.stt_options({"speech_language": "en"})["detect_language"])
            self.assertTrue(policy.stt_options({"speech_language": "invalid"})["detect_language"])
            self.assertIn("do not translate or correct", auto["prompt"])

    def test_model_overrides(self):
        with patch.dict(os.environ, {"GROQ_STT_HINDI_MODEL": "custom", "GROQ_STT_MODEL": "fast"}):
            self.assertEqual(policy.stt_options({"speech_language": "hi"})["model"], "custom")
            self.assertEqual(policy.stt_options({})["model"], "fast")

    def test_card_requires_confidence_and_exact_evidence(self):
        card = {"has_card": True, "original": "I go yesterday", "corrected": "I went yesterday", "confidence": 0.95}
        self.assertIsNotNone(policy.CorrectionCard(**card).for_utterance("I go yesterday."))
        self.assertIsNone(policy.CorrectionCard(**card).for_utterance("I went yesterday."))
        self.assertIsNone(policy.CorrectionCard(**{**card, "confidence": 0.3}).for_utterance(card["original"]))
        self.assertIsNone(policy.CorrectionCard(**{**card, "corrected": card["original"]}).for_utterance(card["original"]))


class PromptTests(unittest.TestCase):
    def setUp(self):
        self.ns = agent_namespace()

    def test_all_practice_modes_teach_and_retry(self):
        for mode, goal in [("free_conversation", "intro"), ("roleplay", "roleplay"),
                           ("grammar_practice", "grammar"), ("vocabulary_practice", "vocabulary"),
                           ("free_conversation", "fluency")]:
            with self.subTest(mode=mode, goal=goal):
                prompt = self.ns["build_mode_instructions"](mode, "past_simple", {"conversation_goal": goal})
                self.assertIn("very next spoken response", prompt)
                self.assertIn("evaluate the retry", prompt)
                self.assertIn("exactly ONE", prompt)
                self.assertNotIn("Do NOT give grammar lectures, corrections", prompt)
                self.assertIn("Hindi/Hinglish is a bridge", prompt)

    def test_assessment_has_no_coaching_loop(self):
        prompt = self.ns["build_mode_instructions"]("assessment", None, {})
        self.assertNotIn("SPOKEN TEACHING LOOP", prompt)
        self.assertIn("Do NOT interrupt or give grammar corrections", prompt)

    def test_token_context_retains_lesson_and_language(self):
        source = {"rule_summary": "Use went", "practice_activity": "Talk about yesterday",
                  "lesson_title": "Past Simple", "recent_examples": [{"original": "go", "corrected": "went"}],
                  "speech_language": "hi"}
        context = self.ns["parse_session_context"](json.dumps(source))
        for key, value in source.items():
            self.assertEqual(context[key], value)
        prompt = self.ns["build_mode_instructions"]("free_conversation", "past_simple", context)
        self.assertIn("Use went", prompt)
        self.assertIn("Talk about yesterday", prompt)

    def test_greeting_never_reads_internal_lesson_instructions(self):
        greeting = self.ns["build_greeting"]({"mode": "grammar_practice", "practice_activity": "SECRET INTERNAL RULE"}, "past_simple")
        self.assertNotIn("SECRET INTERNAL RULE", greeting)


class VoiceHookTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.ns = agent_namespace()

    async def test_noise_stops_response_instead_of_normal_return(self):
        tutor = self.ns["EnglishTutor"]("u", "s")
        with self.assertRaises(StopResponse):
            await tutor.on_user_turn_completed(Mock(), SimpleNamespace(text_content="[Music]"))

    async def test_assessment_skips_cards_and_hook_does_not_invalidate_preemptive_context(self):
        tutor = self.ns["EnglishTutor"]("u", "s", room=Mock(), lesson_context={"mode": "assessment"})
        context = Mock()
        await tutor.on_user_turn_completed(context, SimpleNamespace(text_content="I go yesterday"))
        self.ns["AsyncOpenAI"].assert_not_called()
        context.truncate.assert_not_called()

    async def test_new_turn_cancels_stale_analysis_and_reuses_client(self):
        client = SimpleNamespace(close=AsyncMock())
        self.ns["AsyncOpenAI"].return_value = client
        started = asyncio.Event()

        async def delayed(*args):
            started.set()
            await asyncio.Event().wait()

        self.ns["run_parallel_accuracy_check"] = delayed
        tutor = self.ns["EnglishTutor"]("u", "s", room=Mock())
        with patch.dict(os.environ, {"GROQ_API_KEY": "offline-test", "VOICE_CARDS_ENABLED": "true"}):
            await tutor.on_user_turn_completed(Mock(), SimpleNamespace(text_content="I go yesterday"))
            old = tutor._card_task
            await started.wait()
            await tutor.on_user_turn_completed(Mock(), SimpleNamespace(text_content="I went yesterday"))
            await asyncio.gather(old, return_exceptions=True)
            self.assertTrue(old.cancelled())
            self.ns["AsyncOpenAI"].assert_called_once()
            await tutor.on_exit()
            self.assertTrue(tutor._card_task.cancelled())
            client.close.assert_awaited_once()

    async def test_visual_note_does_not_speak_a_second_response(self):
        response = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps({
            "has_card": True, "original": "I go yesterday", "corrected": "I went yesterday",
            "confidence": 0.95, "explanation": "Use past tense.",
        })))])
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=AsyncMock(return_value=response))))
        room = SimpleNamespace(local_participant=SimpleNamespace(publish_data=AsyncMock()))
        await self.ns["run_parallel_accuracy_check"](room, client, "model", "I go yesterday", 2)
        payload = json.loads(room.local_participant.publish_data.call_args.args[0])
        self.assertEqual(payload["turn_id"], 2)
        self.assertEqual(payload["corrected"], "I went yesterday")
        self.assertNotIn("spoken_tip", payload)

    async def test_invalid_model_json_does_not_break_voice(self):
        response = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="not JSON"))])
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=AsyncMock(return_value=response))))
        room = SimpleNamespace(local_participant=SimpleNamespace(publish_data=AsyncMock()))
        await self.ns["run_parallel_accuracy_check"](room, client, "model", "I go yesterday", 1)
        room.local_participant.publish_data.assert_not_called()

    async def test_model_boundary_trims_copy_only(self):
        tutor = self.ns["EnglishTutor"]("u", "s")
        context = Mock()
        recent = context.copy.return_value.truncate.return_value

        async def model(agent, chat, tools, settings):
            self.assertIs(chat, recent)
            yield "Say: I went yesterday. Can you say that again?"

        with patch.object(StubAgent.default, "llm_node", model):
            outputs = [chunk async for chunk in tutor.llm_node(context, [], None)]
        self.assertEqual(len(outputs), 1)
        context.truncate.assert_not_called()
        context.copy.return_value.truncate.assert_called_once_with(max_items=10)


if __name__ == "__main__":
    unittest.main()