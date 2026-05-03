// Skill progression hints for AI suggestions.
//
// When a user already has skill X in their teaching or learning list, we
// suggest the related "next" skills below as natural follow-ups
// ("You learned HTML — try CSS next"). This map is fed to the Gemini
// prompt as a grounding signal so it doesn't invent prerequisite chains.
//
// Keys and values are matched case-insensitively against skills.name in
// the DB. Keep entries lowercase here.
//
// Future direction (P5-L-003): this is a hand-curated 20-entry map. As the
// skill catalog grows, the right home for these edges is a DB table (e.g.
// `skill_progressions(from_skill_id uuid, to_skill_id uuid, weight int)`)
// administered from /admin/skills. The AI grounding call would then read
// that table at request time. Leaving the static map here intentionally
// because the AI suggestions feature is still in stub mode and migrating to
// a table before there's real product signal would be premature.

export const SKILL_PROGRESSIONS: Record<string, string[]> = {
  html: ["css", "javascript"],
  css: ["tailwind", "javascript", "sass"],
  javascript: ["typescript", "react", "node.js"],
  typescript: ["react", "next.js", "node.js"],
  react: ["next.js", "typescript", "redux"],
  "next.js": ["typescript", "vercel", "tailwind"],
  "node.js": ["express", "mongodb", "postgresql"],
  python: ["pandas", "numpy", "flask", "django"],
  pandas: ["numpy", "matplotlib", "scikit-learn"],
  numpy: ["pandas", "matplotlib"],
  flask: ["postgresql", "docker"],
  django: ["postgresql", "docker", "celery"],
  java: ["spring", "kotlin"],
  c: ["c++", "rust"],
  "c++": ["rust", "cmake"],
  sql: ["postgresql", "mysql"],
  postgresql: ["sql", "supabase"],
  figma: ["ui design", "ux design", "prototyping"],
  photoshop: ["illustrator", "ui design"],
};

// Returns suggested next skills for a list of skills the user already has.
// Filters out skills the user already knows.
export function suggestNextSkills(
  knownSkills: string[],
  limit = 5,
): { from: string; suggest: string }[] {
  const known = new Set(knownSkills.map((s) => s.toLowerCase()));
  const out: { from: string; suggest: string }[] = [];

  for (const skill of knownSkills) {
    const next = SKILL_PROGRESSIONS[skill.toLowerCase()];
    if (!next) continue;
    for (const candidate of next) {
      if (known.has(candidate)) continue;
      out.push({ from: skill, suggest: candidate });
      if (out.length >= limit) return out;
    }
  }

  return out;
}
