// Curated skill graph for the local suggestions engine. Pure data + lookups,
// no I/O. Relatedness is domain-internal by construction: every progression
// edge stays inside one domain (music → music, web → web), so a cross-domain
// hop like "Drums → SEO" cannot be produced from this module.
//
// Canonical keys are the NORMALIZED form of the primary display name
// (normalizeSkillName("Node.js") === "node js"), and the alias table maps
// normalized spelling variants onto those keys. Skills we've never heard of
// simply normalize and miss the graph — callers fall back to catalog
// co-occurrence or skip the progression tile entirely.

// lowercase → trim → separators (. - / _) to spaces → drop stray punctuation
// (keeping + and # so "c++" / "c#" survive as units) → collapse whitespace.
export function normalizeSkillName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[._/\\-]+/g, " ")
    .replace(/[^a-z0-9+# ]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Normalized alias → canonical key.
const ALIASES: Record<string, string> = {
  js: "javascript",
  "java script": "javascript",
  ts: "typescript",
  reactjs: "react",
  "react js": "react",
  nodejs: "node js",
  node: "node js",
  nextjs: "next js",
  // Alias lookup is single-hop, so every value must itself be a canonical key.
  "express js": "express",
  expressjs: "express",
  py: "python",
  postgres: "sql",
  postgresql: "sql",
  mysql: "sql",
  ml: "machine learning",
  ai: "machine learning",
  "ui ux": "ui ux design",
  uiux: "ui ux design",
  "uiux design": "ui ux design",
  ux: "ui ux design",
  "ui design": "ui ux design",
  "ux design": "ui ux design",
  html5: "html",
  css3: "css",
  "ms excel": "excel",
  spreadsheets: "excel",
  dsa: "data structures",
  "data structure": "data structures",
  photoshop: "photo editing",
  tailwind: "tailwind css",
  tailwindcss: "tailwind css",
  "social media": "social media marketing",
};

// normalize + alias lookup. Unknown names pass through normalization unchanged.
export function canonicalSkillKey(name: string): string {
  const norm = normalizeSkillName(name);
  return ALIASES[norm] ?? norm;
}

// Progression edges, ordered best-first. Keys and values are canonical keys.
// Every edge is domain-internal (the singing → public speaking and chess →
// data structures edges are deliberate near-domain picks, not free association).
const PROGRESSIONS: Record<string, string[]> = {
  // Web / frontend
  html: ["css", "javascript"],
  css: ["javascript", "ui ux design", "tailwind css"],
  javascript: ["typescript", "react", "node js"],
  typescript: ["react", "node js"],
  react: ["typescript", "next js", "node js"],
  "node js": ["sql", "express", "typescript"],
  "tailwind css": ["css", "react"],
  "next js": ["react", "typescript"],
  express: ["node js", "sql"],

  // Programming / data
  python: ["data analysis", "sql", "machine learning", "django"],
  sql: ["data analysis", "python", "node js"],
  "data analysis": ["machine learning", "python", "excel", "statistics"],
  "machine learning": ["data analysis", "python", "deep learning"],
  "deep learning": ["machine learning", "python"],
  java: ["data structures", "spring"],
  "c++": ["data structures"],
  "data structures": ["python", "java"],
  excel: ["data analysis", "sql"],
  statistics: ["data analysis", "machine learning"],
  django: ["python", "sql"],

  // Design / creative
  "ui ux design": ["figma", "html", "graphic design"],
  figma: ["ui ux design", "prototyping"],
  prototyping: ["figma", "ui ux design"],
  "graphic design": ["figma", "drawing", "photo editing"],
  photography: ["photo editing", "videography", "graphic design"],
  "photo editing": ["photography", "graphic design"],
  "video editing": ["videography", "photography", "motion graphics"],
  videography: ["video editing", "photography"],
  "motion graphics": ["video editing", "graphic design"],
  drawing: ["graphic design", "digital art"],
  "digital art": ["drawing", "graphic design"],

  // Music
  guitar: ["music theory", "songwriting", "piano"],
  "music theory": ["piano", "guitar", "composition"],
  piano: ["music theory", "composition"],
  composition: ["music theory", "piano"],
  singing: ["music theory", "public speaking"],
  drums: ["music theory", "guitar"],
  songwriting: ["music theory", "guitar"],
  violin: ["music theory"],
  ukulele: ["guitar", "music theory"],
  "bass guitar": ["guitar", "music theory"],
  "music production": ["music theory", "songwriting"],

  // Languages
  spanish: ["french", "portuguese", "italian"],
  french: ["spanish", "italian"],
  german: ["french", "english"],
  japanese: ["korean", "mandarin"],
  korean: ["japanese", "mandarin"],
  mandarin: ["japanese", "korean"],
  english: ["public speaking", "creative writing"],
  italian: ["spanish", "french"],
  portuguese: ["spanish"],

  // Soft skills / business
  "public speaking": ["communication", "interview skills", "leadership"],
  communication: ["public speaking", "leadership"],
  leadership: ["public speaking", "communication"],
  "interview skills": ["public speaking", "communication"],
  "digital marketing": ["seo", "content writing", "social media marketing"],
  seo: ["digital marketing", "content writing"],
  "content writing": ["seo", "creative writing", "copywriting"],
  "creative writing": ["content writing", "english"],
  copywriting: ["content writing", "digital marketing"],
  "social media marketing": ["digital marketing", "video editing"],

  // Lifestyle
  cooking: ["baking", "nutrition"],
  baking: ["cooking"],
  yoga: ["meditation", "fitness"],
  fitness: ["yoga", "nutrition"],
  meditation: ["yoga"],
  nutrition: ["cooking", "fitness"],
  chess: ["data structures", "public speaking"],
};

// Ordered next-skill candidates (canonical keys) for a skill, [] if unknown.
export function progressionTargets(name: string): string[] {
  return PROGRESSIONS[canonicalSkillKey(name)] ?? [];
}
