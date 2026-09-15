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
