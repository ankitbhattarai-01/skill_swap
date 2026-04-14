-- Enums
CREATE TYPE public.skill_level AS ENUM ('basic', 'intermediate', 'advanced');
CREATE TYPE public.learning_mode AS ENUM ('teaching', 'collaboration', 'mentorship');
CREATE TYPE public.session_status AS ENUM ('pending', 'accepted', 'rejected', 'active', 'completed', 'cancelled');

-- Profiles
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT,
  bio TEXT,
  avatar_url TEXT,
  credits INT NOT NULL DEFAULT 10,
  learning_mode public.learning_mode,
  onboarded BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Skills catalog
CREATE TABLE public.skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  category TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Teaching skills
CREATE TABLE public.user_teaching_skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  skill_id UUID NOT NULL REFERENCES public.skills(id) ON DELETE CASCADE,
  level public.skill_level NOT NULL DEFAULT 'basic',
  credits_per_hour INT NOT NULL DEFAULT 5,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, skill_id)
);

-- Learning skills
CREATE TABLE public.user_learning_skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  skill_id UUID NOT NULL REFERENCES public.skills(id) ON DELETE CASCADE,
  current_level public.skill_level NOT NULL DEFAULT 'basic',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, skill_id)
);

-- Sessions
CREATE TABLE public.sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  learner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  skill_id UUID NOT NULL REFERENCES public.skills(id) ON DELETE CASCADE,
  status public.session_status NOT NULL DEFAULT 'pending',
  credits INT NOT NULL DEFAULT 5,
  meet_link TEXT,
  scheduled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Messages
CREATE TABLE public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Credit transactions
CREATE TABLE public.credit_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  to_user UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  amount INT NOT NULL,
  session_id UUID REFERENCES public.sessions(id) ON DELETE SET NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Updated_at trigger
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER sessions_updated_at BEFORE UPDATE ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, credits)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    10
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Enable RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_teaching_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_learning_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_transactions ENABLE ROW LEVEL SECURITY;

-- Public read policies
CREATE POLICY "Profiles are publicly viewable" ON public.profiles FOR SELECT USING (true);
CREATE POLICY "Users update their own profile" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id);
CREATE POLICY "Users insert their own profile" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);

CREATE POLICY "Skills are publicly viewable" ON public.skills FOR SELECT USING (true);
CREATE POLICY "Authenticated can add skills" ON public.skills FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Teaching skills publicly viewable" ON public.user_teaching_skills FOR SELECT USING (true);
CREATE POLICY "Users manage own teaching skills" ON public.user_teaching_skills FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Learning skills publicly viewable" ON public.user_learning_skills FOR SELECT USING (true);
CREATE POLICY "Users manage own learning skills" ON public.user_learning_skills FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Sessions: only participants
CREATE POLICY "Participants view sessions" ON public.sessions FOR SELECT TO authenticated
  USING (auth.uid() = teacher_id OR auth.uid() = learner_id);
CREATE POLICY "Authenticated create sessions" ON public.sessions FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = learner_id OR auth.uid() = teacher_id);
CREATE POLICY "Participants update sessions" ON public.sessions FOR UPDATE TO authenticated
  USING (auth.uid() = teacher_id OR auth.uid() = learner_id);

-- Messages: only session participants
CREATE POLICY "Participants view messages" ON public.messages FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.sessions s WHERE s.id = session_id AND (s.teacher_id = auth.uid() OR s.learner_id = auth.uid())));
CREATE POLICY "Participants send messages" ON public.messages FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = sender_id AND EXISTS (SELECT 1 FROM public.sessions s WHERE s.id = session_id AND (s.teacher_id = auth.uid() OR s.learner_id = auth.uid())));

-- Credit transactions
CREATE POLICY "Users view their credit transactions" ON public.credit_transactions FOR SELECT TO authenticated
  USING (auth.uid() = from_user OR auth.uid() = to_user);

-- Realtime for messages
ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;

-- Seed skills catalog
INSERT INTO public.skills (name, category) VALUES
  ('JavaScript', 'Programming'),
  ('Python', 'Programming'),
  ('React', 'Frontend'),
  ('TypeScript', 'Programming'),
  ('CSS', 'Frontend'),
  ('HTML', 'Frontend'),
  ('UI/UX Design', 'Design'),
  ('Figma', 'Design'),
  ('Node.js', 'Backend'),
  ('SQL', 'Database'),
  ('Machine Learning', 'AI'),
  ('Public Speaking', 'Soft Skills'),
  ('Data Analysis', 'Data'),
  ('Photography', 'Creative'),
  ('Spanish', 'Language'),
  ('French', 'Language');
