/**
 * Pravaah — Curriculum skill ID → friendly label lookup.
 *
 * Mirrors services/learning-engine/curriculum.py's CURRICULUM_SKILLS titles. Shared between
 * the dashboard (mistake/lesson grouping) and the session screen (default conversation topic).
 */

export const SKILL_LABELS: Record<string, string> = {
  past_simple_auxiliary: "Past Simple (did/didn't)",
  past_simple: "Past Simple",
  stative_verbs: "Stative Verbs",
  subject_verb_agreement: "Subject-Verb Agreement",
  be_verb_misuse: "Be-Verb Usage",
  prepositions: "Prepositions",
  articles: "Articles",
  collocations: "Collocations",
  sentence_structure: "Sentence Structure",
};

export function skillLabel(id?: string | null): string {
  if (!id) return "General";
  return SKILL_LABELS[id] || id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Plans saved before the title cleanup prefix the skill with a phase label.
const LEGACY_PLAN_LABEL = /^(Targeted Correction & Retry|Conversation Transfer|Real-World Transfer|Retention Review):\s*/i;

export function activityTitle(title?: string | null): string {
  return (title || "").replace(LEGACY_PLAN_LABEL, "").trim();
}

const LEGACY_OBJECTIVES: [RegExp, string][] = [
  [/^Targeted Correction & Retry for /i, "Learn the fix, then say it correctly yourself."],
  [/^Conversation Transfer for /i, "Use it naturally while you chat."],
  [/^Real-World Transfer for /i, "Use it in a real-life situation."],
  [/^Retention Review for /i, "Quick check so it sticks."],
];

export function activityObjective(objective?: string | null): string {
  const text = (objective || "").trim();
  const legacy = LEGACY_OBJECTIVES.find(([pattern]) => pattern.test(text));
  return legacy ? legacy[1] : text;
}
