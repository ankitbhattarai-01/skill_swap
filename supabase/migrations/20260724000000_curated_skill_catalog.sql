-- Curated, selection-only skill catalog.
--
-- WHY
-- ---
-- Until now any authenticated user could INSERT into public.skills, so the
-- catalog grew whatever people typed. Two things broke because of that:
--
--   1. Matching density. "Bike Riding" / "bike riding" / "Cycling" become three
--      separate rows with one user each and zero counterparties. Every one is a
--      guaranteed dead end, and the suggestions engine had to grow guards to
--      route around skills that can never produce a match.
--
--   2. Verification credibility. The verify-skill quiz is a ten-question
--      written knowledge check. That is a defensible signal for Python or music
--      theory and a meaningless one for a psychomotor skill, but nothing
--      stopped a practical skill from entering the catalog and being offered a
--      badge it could never legitimately earn.
--
-- The catalog below is built on one rule, and that rule is the answer to
-- "why isn't <X> on your platform?":
--
--      Every skill is teachable over video with a laptop, and at most an
--      inexpensive instrument.
--
-- That admits guitar, flute, madal and harmonium (cheap, widely owned) while
-- excluding anything needing a car, a kitchen, an espresso machine, a gym or a
-- physical space to share with the learner.
--
-- WHAT THIS DOES
-- --------------
-- Adds skills.is_active, seeds ~380 curated skills across 20 categories,
-- deactivates everything else, and removes the authenticated INSERT policy so
-- the restriction is enforced by the database rather than only hidden in the UI.
--
-- NON-DESTRUCTIVE BY DESIGN. Off-catalog skills are deactivated, never deleted:
-- sessions, skill_verifications and user_teaching_skills all carry FKs to
-- public.skills, and deleting rows would cascade through completed session
-- history. Deactivated rows stay readable so existing records still render;
-- they are simply no longer offered in any picker.
--
-- To also clear the user_teaching_skills / user_learning_skills rows that point
-- at deactivated skills, run the companion migration
-- 20260724010000_prune_offcatalog_user_skills.sql afterwards.

-- ---------------------------------------------------------------------------
-- 1. Activation flag
-- ---------------------------------------------------------------------------

ALTER TABLE public.skills
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN public.skills.is_active IS
  'False for skills retired from the curated catalog. Retired skills stay readable so existing sessions and profiles render, but are hidden from every picker and from suggestion candidates.';

-- Every catalog read filters on is_active, so index the live subset rather than
-- the whole table.
CREATE INDEX IF NOT EXISTS skills_active_name_idx
  ON public.skills (name) WHERE is_active;

-- ---------------------------------------------------------------------------
-- 2. The curated catalog
-- ---------------------------------------------------------------------------
-- Staged in a real (not TEMP) table so the script behaves identically whether
-- it runs through the Supabase SQL editor, psql, or the CLI, none of which
-- agree on transaction scoping. Dropped at the end of the script.

DROP TABLE IF EXISTS public.skill_catalog_seed;
CREATE TABLE public.skill_catalog_seed (name TEXT PRIMARY KEY, category TEXT NOT NULL);

INSERT INTO public.skill_catalog_seed (name, category) VALUES
-- ── Coding / Tech ──────────────────────────────────────────────────────────
('Python', 'Programming Languages'),
('JavaScript', 'Programming Languages'),
('TypeScript', 'Programming Languages'),
('Java', 'Programming Languages'),
('C', 'Programming Languages'),
('C++', 'Programming Languages'),
('C#', 'Programming Languages'),
('Go', 'Programming Languages'),
('Rust', 'Programming Languages'),
('Kotlin', 'Programming Languages'),
('Swift', 'Programming Languages'),
('PHP', 'Programming Languages'),
('Ruby', 'Programming Languages'),
('Dart', 'Programming Languages'),
('Scala', 'Programming Languages'),
('R', 'Programming Languages'),
('MATLAB', 'Programming Languages'),
('Perl', 'Programming Languages'),
('Lua', 'Programming Languages'),
('Haskell', 'Programming Languages'),
('Elixir', 'Programming Languages'),
('Julia', 'Programming Languages'),
('Assembly Language', 'Programming Languages'),
('Objective-C', 'Programming Languages'),
('Shell Scripting', 'Programming Languages'),
('PowerShell', 'Programming Languages'),
('Regular Expressions', 'Programming Languages'),

('HTML', 'Web Development'),
('CSS', 'Web Development'),
('React', 'Web Development'),
('Next.js', 'Web Development'),
('Vue.js', 'Web Development'),
('Angular', 'Web Development'),
('Svelte', 'Web Development'),
('Astro', 'Web Development'),
('Nuxt.js', 'Web Development'),
('Node.js', 'Web Development'),
('Express.js', 'Web Development'),
('Django', 'Web Development'),
('Flask', 'Web Development'),
('FastAPI', 'Web Development'),
('Laravel', 'Web Development'),
('Spring Boot', 'Web Development'),
('Ruby on Rails', 'Web Development'),
('ASP.NET Core', 'Web Development'),
('Tailwind CSS', 'Web Development'),
('Bootstrap', 'Web Development'),
('Sass', 'Web Development'),
('jQuery', 'Web Development'),
('GraphQL', 'Web Development'),
('REST API Design', 'Web Development'),
('WordPress', 'Web Development'),
('Vite', 'Web Development'),
('Webpack', 'Web Development'),
('Redux', 'Web Development'),
('Responsive Web Design', 'Web Development'),
('Web Accessibility', 'Web Development'),
('Web Performance Optimization', 'Web Development'),
('Progressive Web Apps', 'Web Development'),
('WebSockets', 'Web Development'),
('Authentication and Authorization', 'Web Development'),
('Browser DevTools', 'Web Development'),

('Android Development', 'Mobile Development'),
('iOS Development', 'Mobile Development'),
('React Native', 'Mobile Development'),
('Flutter', 'Mobile Development'),
('SwiftUI', 'Mobile Development'),
('Jetpack Compose', 'Mobile Development'),
('Ionic', 'Mobile Development'),
('Expo', 'Mobile Development'),
('Kotlin Multiplatform', 'Mobile Development'),
('App Store Deployment', 'Mobile Development'),
('Mobile App Architecture', 'Mobile Development'),
('Push Notifications', 'Mobile Development'),

('Machine Learning', 'Data & AI'),
('Deep Learning', 'Data & AI'),
('Data Analysis', 'Data & AI'),
('Data Science', 'Data & AI'),
('Pandas', 'Data & AI'),
('NumPy', 'Data & AI'),
('Matplotlib', 'Data & AI'),
('TensorFlow', 'Data & AI'),
('PyTorch', 'Data & AI'),
('Scikit-learn', 'Data & AI'),
('Computer Vision', 'Data & AI'),
('Natural Language Processing', 'Data & AI'),
('Data Visualization', 'Data & AI'),
('Power BI', 'Data & AI'),
('Tableau', 'Data & AI'),
('Excel for Data Analysis', 'Data & AI'),
('Statistics for Data Science', 'Data & AI'),
('Prompt Engineering', 'Data & AI'),
('Large Language Models', 'Data & AI'),
('MLOps', 'Data & AI'),
('Apache Spark', 'Data & AI'),
('Data Engineering', 'Data & AI'),
('R for Data Analysis', 'Data & AI'),
('Reinforcement Learning', 'Data & AI'),
('Time Series Analysis', 'Data & AI'),
('Feature Engineering', 'Data & AI'),
('Jupyter Notebooks', 'Data & AI'),
('Web Scraping', 'Data & AI'),

('SQL', 'Databases'),
('PostgreSQL', 'Databases'),
('MySQL', 'Databases'),
('MongoDB', 'Databases'),
('SQLite', 'Databases'),
('Redis', 'Databases'),
('Firebase', 'Databases'),
('Supabase', 'Databases'),
('Microsoft SQL Server', 'Databases'),
('Oracle Database', 'Databases'),
('Elasticsearch', 'Databases'),
('Neo4j', 'Databases'),
('Database Design', 'Databases'),
('Database Normalization', 'Databases'),
('Query Optimization', 'Databases'),
('Data Modeling', 'Databases'),

('Amazon Web Services', 'Cloud & DevOps'),
('Microsoft Azure', 'Cloud & DevOps'),
('Google Cloud Platform', 'Cloud & DevOps'),
('Docker', 'Cloud & DevOps'),
('Kubernetes', 'Cloud & DevOps'),
('CI/CD', 'Cloud & DevOps'),
('GitHub Actions', 'Cloud & DevOps'),
('Jenkins', 'Cloud & DevOps'),
('Terraform', 'Cloud & DevOps'),
('Ansible', 'Cloud & DevOps'),
('Linux Administration', 'Cloud & DevOps'),
('Nginx', 'Cloud & DevOps'),
('Serverless Architecture', 'Cloud & DevOps'),
('Git and GitHub', 'Cloud & DevOps'),
('Monitoring and Observability', 'Cloud & DevOps'),
('Cloudflare', 'Cloud & DevOps'),
('Vercel Deployment', 'Cloud & DevOps'),
('Networking Fundamentals', 'Cloud & DevOps'),
('System Administration', 'Cloud & DevOps'),
('Infrastructure as Code', 'Cloud & DevOps'),

('Ethical Hacking', 'Cybersecurity'),
('Network Security', 'Cybersecurity'),
('Penetration Testing', 'Cybersecurity'),
('Cryptography', 'Cybersecurity'),
('Web Application Security', 'Cybersecurity'),
('Digital Forensics', 'Cybersecurity'),
('Malware Analysis', 'Cybersecurity'),
('Security Auditing', 'Cybersecurity'),
('OWASP Top 10', 'Cybersecurity'),
('Capture The Flag', 'Cybersecurity'),
('Secure Coding', 'Cybersecurity'),
('Incident Response', 'Cybersecurity'),
('Cloud Security', 'Cybersecurity'),
('Identity and Access Management', 'Cybersecurity'),

('Unity', 'Game Development'),
('Unreal Engine', 'Game Development'),
('Godot', 'Game Development'),
('Game Design', 'Game Development'),
('Pygame', 'Game Development'),
('Roblox Studio', 'Game Development'),
('2D Game Art', 'Game Development'),
('Game Physics', 'Game Development'),
('Level Design', 'Game Development'),
('Multiplayer Networking', 'Game Development'),
('Shader Programming', 'Game Development'),

('Data Structures', 'Computer Science'),
('Algorithms', 'Computer Science'),
('Object-Oriented Programming', 'Computer Science'),
('System Design', 'Computer Science'),
('Design Patterns', 'Computer Science'),
('Clean Code', 'Computer Science'),
('Test-Driven Development', 'Computer Science'),
('Software Testing', 'Computer Science'),
('Debugging', 'Computer Science'),
('Software Architecture', 'Computer Science'),
('Microservices', 'Computer Science'),
('Agile and Scrum', 'Computer Science'),
('Technical Interview Preparation', 'Computer Science'),
('Competitive Programming', 'Computer Science'),
('Operating Systems', 'Computer Science'),
('Computer Networks', 'Computer Science'),
('Computer Architecture', 'Computer Science'),
('Compiler Design', 'Computer Science'),
('Theory of Computation', 'Computer Science'),
('Code Review', 'Computer Science'),
('Version Control Workflows', 'Computer Science'),

-- ── Academic subjects ──────────────────────────────────────────────────────
('Algebra', 'Mathematics'),
('Calculus', 'Mathematics'),
('Linear Algebra', 'Mathematics'),
('Geometry', 'Mathematics'),
('Trigonometry', 'Mathematics'),
('Statistics', 'Mathematics'),
('Probability', 'Mathematics'),
('Discrete Mathematics', 'Mathematics'),
('Differential Equations', 'Mathematics'),
('Number Theory', 'Mathematics'),
('Numerical Methods', 'Mathematics'),
('Vector Calculus', 'Mathematics'),
('Complex Analysis', 'Mathematics'),
('Real Analysis', 'Mathematics'),
('Abstract Algebra', 'Mathematics'),
('Graph Theory', 'Mathematics'),
('Mathematical Logic', 'Mathematics'),
('Mathematical Olympiad', 'Mathematics'),

('Physics', 'Science'),
('Chemistry', 'Science'),
('Biology', 'Science'),
('Organic Chemistry', 'Science'),
('Physical Chemistry', 'Science'),
('Inorganic Chemistry', 'Science'),
('Biochemistry', 'Science'),
('Astronomy', 'Science'),
('Environmental Science', 'Science'),
('Genetics', 'Science'),
('Microbiology', 'Science'),
('Biotechnology', 'Science'),
('Human Anatomy', 'Science'),
('Botany', 'Science'),
('Zoology', 'Science'),
('Neuroscience', 'Science'),
('Geology', 'Science'),
('Quantum Mechanics', 'Science'),
('Electromagnetism', 'Science'),

('Electronics', 'Engineering'),
('Circuit Analysis', 'Engineering'),
('Digital Logic Design', 'Engineering'),
('Embedded Systems', 'Engineering'),
('Arduino', 'Engineering'),
('Raspberry Pi', 'Engineering'),
('Internet of Things', 'Engineering'),
('Robotics', 'Engineering'),
('Control Systems', 'Engineering'),
('Signal Processing', 'Engineering'),
('VLSI Design', 'Engineering'),
('PCB Design', 'Engineering'),
('AutoCAD', 'Engineering'),
('SolidWorks', 'Engineering'),
('Engineering Drawing', 'Engineering'),
('Thermodynamics', 'Engineering'),
('Fluid Mechanics', 'Engineering'),
('Structural Analysis', 'Engineering'),
('Material Science', 'Engineering'),
('Surveying', 'Engineering'),

('Accounting', 'Business & Economics'),
('Microeconomics', 'Business & Economics'),
('Macroeconomics', 'Business & Economics'),
('Financial Literacy', 'Business & Economics'),
('Financial Modeling', 'Business & Economics'),
('Business Studies', 'Business & Economics'),
('Entrepreneurship', 'Business & Economics'),
('Project Management', 'Business & Economics'),
('Marketing Fundamentals', 'Business & Economics'),
('Digital Marketing', 'Business & Economics'),
('Search Engine Optimization', 'Business & Economics'),
('Content Marketing', 'Business & Economics'),
('Business Analytics', 'Business & Economics'),
('Stock Market Basics', 'Business & Economics'),
('Supply Chain Management', 'Business & Economics'),
('Human Resource Management', 'Business & Economics'),
('Cost Accounting', 'Business & Economics'),
('Taxation Basics', 'Business & Economics'),
('Business Communication', 'Business & Economics'),

('History', 'Humanities'),
('Geography', 'Humanities'),
('Political Science', 'Humanities'),
('Psychology', 'Humanities'),
('Sociology', 'Humanities'),
('Philosophy', 'Humanities'),
('Literature', 'Humanities'),
('Anthropology', 'Humanities'),
('International Relations', 'Humanities'),
('Ethics', 'Humanities'),
('Logic and Critical Thinking', 'Humanities'),
('Constitutional Studies', 'Humanities'),
('Journalism', 'Humanities'),
('Media Studies', 'Humanities'),
('Comparative Religion', 'Humanities'),
('Archaeology', 'Humanities'),

('Academic Writing', 'Academic Skills'),
('Research Methodology', 'Academic Skills'),
('Thesis Writing', 'Academic Skills'),
('Literature Review', 'Academic Skills'),
('Citation and Referencing', 'Academic Skills'),
('Scientific Writing', 'Academic Skills'),
('Essay Writing', 'Academic Skills'),
('Creative Writing', 'Academic Skills'),
('Study Techniques', 'Academic Skills'),
('Note-taking', 'Academic Skills'),
('Exam Strategy', 'Academic Skills'),
('Time Management', 'Academic Skills'),
('Presentation Skills', 'Academic Skills'),
('Public Speaking', 'Academic Skills'),
('Debate', 'Academic Skills'),
('SAT Preparation', 'Academic Skills'),
('GRE Preparation', 'Academic Skills'),
('GMAT Preparation', 'Academic Skills'),

-- ── Music ──────────────────────────────────────────────────────────────────
-- 'Guitar' must keep exactly this name: verify-skill matches it verbatim to
-- serve the fixed question bank instead of calling the model.
('Guitar', 'Musical Instruments'),
('Electric Guitar', 'Musical Instruments'),
('Bass Guitar', 'Musical Instruments'),
('Classical Guitar', 'Musical Instruments'),
('Piano', 'Musical Instruments'),
('Keyboard', 'Musical Instruments'),
('Violin', 'Musical Instruments'),
('Flute', 'Musical Instruments'),
('Bansuri', 'Musical Instruments'),
('Madal', 'Musical Instruments'),
('Harmonium', 'Musical Instruments'),
('Tabla', 'Musical Instruments'),
('Sitar', 'Musical Instruments'),
('Sarangi', 'Musical Instruments'),
('Dholak', 'Musical Instruments'),
('Ukulele', 'Musical Instruments'),
('Drums', 'Musical Instruments'),
('Cajon', 'Musical Instruments'),
('Djembe', 'Musical Instruments'),
('Saxophone', 'Musical Instruments'),
('Trumpet', 'Musical Instruments'),
('Clarinet', 'Musical Instruments'),
('Cello', 'Musical Instruments'),
('Banjo', 'Musical Instruments'),
('Mandolin', 'Musical Instruments'),
('Kalimba', 'Musical Instruments'),
('Melodica', 'Musical Instruments'),
('Recorder', 'Musical Instruments'),

('Music Theory', 'Music Theory & Production'),
('Singing', 'Music Theory & Production'),
('Vocal Training', 'Music Theory & Production'),
('Ear Training', 'Music Theory & Production'),
('Sight Reading', 'Music Theory & Production'),
('Songwriting', 'Music Theory & Production'),
('Music Composition', 'Music Theory & Production'),
('Music Production', 'Music Theory & Production'),
('FL Studio', 'Music Theory & Production'),
('Ableton Live', 'Music Theory & Production'),
('GarageBand', 'Music Theory & Production'),
('Audacity', 'Music Theory & Production'),
('Mixing and Mastering', 'Music Theory & Production'),
('Home Recording', 'Music Theory & Production'),
('Sound Design', 'Music Theory & Production'),
('DJing', 'Music Theory & Production'),
('Beatboxing', 'Music Theory & Production'),
('Rhythm and Timing', 'Music Theory & Production'),
('Music Notation Software', 'Music Theory & Production'),
('Nepali Folk Music', 'Music Theory & Production'),
('Classical Music Theory', 'Music Theory & Production'),

-- ── Languages ──────────────────────────────────────────────────────────────
('English', 'Languages'),
('English Grammar', 'Languages'),
('English Speaking', 'Languages'),
('English Pronunciation', 'Languages'),
('Business English', 'Languages'),
('IELTS Preparation', 'Languages'),
('TOEFL Preparation', 'Languages'),
('PTE Preparation', 'Languages'),
('Duolingo English Test', 'Languages'),
('Nepali', 'Languages'),
('Hindi', 'Languages'),
('Newari', 'Languages'),
('Maithili', 'Languages'),
('Sanskrit', 'Languages'),
('Bengali', 'Languages'),
('Urdu', 'Languages'),
('Tamil', 'Languages'),
('Spanish', 'Languages'),
('French', 'Languages'),
('German', 'Languages'),
('Italian', 'Languages'),
('Portuguese', 'Languages'),
('Dutch', 'Languages'),
('Swedish', 'Languages'),
('Russian', 'Languages'),
('Turkish', 'Languages'),
('Arabic', 'Languages'),
('Japanese', 'Languages'),
('Korean', 'Languages'),
('Mandarin Chinese', 'Languages'),
('Thai', 'Languages'),
('Vietnamese', 'Languages'),
('Indonesian', 'Languages'),
('Sign Language', 'Languages'),
('Translation', 'Languages'),

-- ── Design ─────────────────────────────────────────────────────────────────
('Figma', 'Design Tools'),
('Adobe Photoshop', 'Design Tools'),
('Adobe Illustrator', 'Design Tools'),
('Adobe XD', 'Design Tools'),
('Adobe InDesign', 'Design Tools'),
('Adobe Premiere Pro', 'Design Tools'),
('Adobe After Effects', 'Design Tools'),
('Adobe Lightroom', 'Design Tools'),
('DaVinci Resolve', 'Design Tools'),
('Canva', 'Design Tools'),
('Blender', 'Design Tools'),
('Sketch', 'Design Tools'),
('CorelDRAW', 'Design Tools'),
('Affinity Designer', 'Design Tools'),
('Procreate', 'Design Tools'),
('Inkscape', 'Design Tools'),
('GIMP', 'Design Tools'),
('Framer', 'Design Tools'),
('Webflow', 'Design Tools'),

('UI Design', 'Design & Creative'),
('UX Design', 'Design & Creative'),
('User Research', 'Design & Creative'),
('Usability Testing', 'Design & Creative'),
('Wireframing', 'Design & Creative'),
('Prototyping', 'Design & Creative'),
('Design Systems', 'Design & Creative'),
('Information Architecture', 'Design & Creative'),
('Graphic Design', 'Design & Creative'),
('Logo Design', 'Design & Creative'),
('Brand Identity', 'Design & Creative'),
('Typography', 'Design & Creative'),
('Color Theory', 'Design & Creative'),
('Poster Design', 'Design & Creative'),
('Illustration', 'Design & Creative'),
('Digital Art', 'Design & Creative'),
('Character Design', 'Design & Creative'),
('Storyboarding', 'Design & Creative'),
('3D Modeling', 'Design & Creative'),
('Motion Graphics', 'Design & Creative'),
('Animation', 'Design & Creative'),
('Video Editing', 'Design & Creative');

-- ---------------------------------------------------------------------------
-- 3. Reconcile the live table against the seed
-- ---------------------------------------------------------------------------

-- 3a. Adopt rows that already exist under a different casing or category:
-- rename to the canonical form and reactivate, so user_teaching_skills and
-- completed sessions keep pointing at the same skill id.
--
-- The NOT EXISTS guard covers the case where BOTH 'Python' and 'python' exist:
-- renaming the second to 'Python' would violate skills.name UNIQUE, so it is
-- left alone and falls through to 3c, which deactivates it.
UPDATE public.skills s
SET name = c.name,
    category = c.category,
    is_active = TRUE
FROM public.skill_catalog_seed c
WHERE lower(s.name) = lower(c.name)
  AND NOT EXISTS (
    SELECT 1 FROM public.skills other
    WHERE other.name = c.name AND other.id <> s.id
  );

-- 3b. Insert the rest.
INSERT INTO public.skills (name, category, is_active)
SELECT c.name, c.category, TRUE
FROM public.skill_catalog_seed c
WHERE NOT EXISTS (
  SELECT 1 FROM public.skills s WHERE s.name = c.name
);

-- 3c. Retire everything that is not an exact catalog entry. After 3a this
-- catches genuinely off-catalog skills ("Bike Riding") and any casing
-- duplicates left behind.
UPDATE public.skills s
SET is_active = FALSE
WHERE s.is_active
  AND NOT EXISTS (
    SELECT 1 FROM public.skill_catalog_seed c WHERE c.name = s.name
  );

DROP TABLE public.skill_catalog_seed;

-- ---------------------------------------------------------------------------
-- 4. Close user-driven catalog writes
-- ---------------------------------------------------------------------------
-- The UI no longer offers an "Add <typed text>" affordance, but hiding a button
-- is not enforcement: the anon key is public, so anyone could still POST to
-- /rest/v1/skills. Dropping the policy makes the database the gate.
--
-- public.admin_create_skill is SECURITY DEFINER and runs as its owner, so the
-- admin catalog page keeps working and stays the only way in.

DROP POLICY IF EXISTS "Authenticated can add skills" ON public.skills;
REVOKE INSERT ON public.skills FROM authenticated;

-- The BEFORE INSERT safety trigger (check_skill_safe) stays in place. It now
-- only ever sees admin-authored rows, which is the right belt-and-braces.

-- ---------------------------------------------------------------------------
-- 5. Result
-- ---------------------------------------------------------------------------

SELECT
  count(*) FILTER (WHERE is_active)       AS active_skills,
  count(*) FILTER (WHERE NOT is_active)   AS retired_skills,
  count(DISTINCT category) FILTER (WHERE is_active) AS active_categories
FROM public.skills;
