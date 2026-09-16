-- ============================================================
-- dcprime-interview (면접 대비반 전용 LMS) Supabase 셋업 SQL
-- 기존 대치프라임 DB(smnakhjdtbqgwocwlluz)에 그대로 추가 실행
-- Supabase SQL Editor에 전체 붙여넣고 한 번에 실행 (재실행해도 안전)
-- 다른 프로젝트와 테이블명이 겹치지 않도록 별도 스키마(interview) 사용
-- ============================================================

CREATE SCHEMA IF NOT EXISTS interview;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- public 스키마와 달리 새 스키마는 anon/authenticated에게 USAGE가 자동으로 주어지지 않음
-- (RLS 정책과는 별개로 스키마/테이블/함수 자체에 대한 권한을 명시적으로 열어줘야 함)
GRANT USAGE ON SCHEMA interview TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA interview GRANT ALL ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA interview GRANT ALL ON SEQUENCES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA interview GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;

-- ────────────────────────────────────────────
-- 1. 관리자 비번 설정
--    (사이트 공용 비번 게이트는 제거함 — dcprime.10 원본처럼 PIN 하나로
--     관리자/학생을 서버에서 판별하는 1단계 로그인 구조로 통일)
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS interview.config (
  key   text PRIMARY KEY,
  value text NOT NULL
);
ALTER TABLE interview.config ENABLE ROW LEVEL SECURITY;
-- 정책 없음 = anon 직접 조회 불가, 아래 verify 함수로만 확인

INSERT INTO interview.config (key, value) VALUES
  ('admin_password', '1250')
ON CONFLICT (key) DO NOTHING;

-- 이미 실행한 적이 있다면 예전 site_password 관련 객체 정리
DELETE FROM interview.config WHERE key = 'site_password';
DROP FUNCTION IF EXISTS interview.verify_site_password(text);

CREATE OR REPLACE FUNCTION interview.verify_admin_password(p_pw text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN EXISTS (SELECT 1 FROM interview.config WHERE key = 'admin_password' AND value = p_pw);
END;
$$;
GRANT EXECUTE ON FUNCTION interview.verify_admin_password(text) TO anon;

-- ────────────────────────────────────────────
-- 2. 학생 테이블
--    비밀번호 해시(password_hash)가 들어있어서 테이블 자체는 anon RLS 정책을 두지 않고
--    아래 SECURITY DEFINER 함수로만 읽고 쓰게 함 (staff_students보다 한 단계 더 보수적인 모델)
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS interview.students (
  id            uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  name          text        NOT NULL,
  school        text,
  grade         text,
  password_hash text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE interview.students ENABLE ROW LEVEL SECURITY;
-- 정책 없음 = anon 직접 접근 불가

CREATE OR REPLACE FUNCTION interview.students_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_interview_students_updated_at ON interview.students;
CREATE TRIGGER trg_interview_students_updated_at
  BEFORE UPDATE ON interview.students
  FOR EACH ROW EXECUTE FUNCTION interview.students_set_updated_at();

-- 학생 로그인: 비밀번호만 입력하면 본인을 찾아서 반환 (이름 선택 불필요)
CREATE OR REPLACE FUNCTION interview.verify_student_login(p_pw text)
RETURNS TABLE(id uuid, name text, school text, grade text)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
    SELECT s.id, s.name, s.school, s.grade
    FROM interview.students s
    WHERE s.password_hash = extensions.crypt(p_pw, s.password_hash);
END;
$$;
GRANT EXECUTE ON FUNCTION interview.verify_student_login(text) TO anon;

-- 관리자용 학생관리 CRUD (비밀번호는 항상 이 함수들을 통해서만 평문 → 해시)
CREATE OR REPLACE FUNCTION interview.admin_list_students()
RETURNS TABLE(id uuid, name text, school text, grade text, created_at timestamptz)
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT s.id, s.name, s.school, s.grade, s.created_at
  FROM interview.students s
  ORDER BY s.created_at DESC;
$$;
GRANT EXECUTE ON FUNCTION interview.admin_list_students() TO anon;

CREATE OR REPLACE FUNCTION interview.admin_create_student(p_name text, p_school text, p_grade text, p_password text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO interview.students (name, school, grade, password_hash)
  VALUES (p_name, p_school, p_grade, extensions.crypt(p_password, extensions.gen_salt('bf')))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
GRANT EXECUTE ON FUNCTION interview.admin_create_student(text, text, text, text) TO anon;

CREATE OR REPLACE FUNCTION interview.admin_update_student(p_id uuid, p_name text, p_school text, p_grade text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE interview.students
  SET name = p_name, school = p_school, grade = p_grade
  WHERE id = p_id;
END;
$$;
GRANT EXECUTE ON FUNCTION interview.admin_update_student(uuid, text, text, text) TO anon;

CREATE OR REPLACE FUNCTION interview.admin_set_student_password(p_id uuid, p_password text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE interview.students
  SET password_hash = extensions.crypt(p_password, extensions.gen_salt('bf'))
  WHERE id = p_id;
END;
$$;
GRANT EXECUTE ON FUNCTION interview.admin_set_student_password(uuid, text) TO anon;

CREATE OR REPLACE FUNCTION interview.admin_delete_student(p_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  DELETE FROM interview.students WHERE id = p_id;
END;
$$;
GRANT EXECUTE ON FUNCTION interview.admin_delete_student(uuid) TO anon;

-- ────────────────────────────────────────────
-- 3. 문제은행 (대학/전형별 기출·예상 질문)
--    RLS는 anon 전체 허용 (역할 구분은 앱 화면 단에서만 처리 — dcprime-students staff_students와 동일한 신뢰 모델)
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS interview.questions (
  id            uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  university    text        NOT NULL,
  department    text,
  track         text,
  category      text,
  question_text text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE interview.questions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon select interview_questions" ON interview.questions;
DROP POLICY IF EXISTS "anon insert interview_questions" ON interview.questions;
DROP POLICY IF EXISTS "anon update interview_questions" ON interview.questions;
DROP POLICY IF EXISTS "anon delete interview_questions" ON interview.questions;

CREATE POLICY "anon select interview_questions" ON interview.questions
  FOR SELECT TO anon USING (true);
CREATE POLICY "anon insert interview_questions" ON interview.questions
  FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon update interview_questions" ON interview.questions
  FOR UPDATE TO anon USING (true);
CREATE POLICY "anon delete interview_questions" ON interview.questions
  FOR DELETE TO anon USING (true);

CREATE INDEX IF NOT EXISTS idx_interview_questions_university ON interview.questions (university);

-- 데모용 샘플 질문
INSERT INTO interview.questions (university, department, track, category, question_text)
SELECT * FROM (VALUES
  ('서울대학교', '컴퓨터공학부', '지역균형', '전공적합성', '본인이 프로그래밍에 흥미를 느끼게 된 계기를 말해보세요.'),
  ('서울대학교', '컴퓨터공학부', '지역균형', '인성', '팀 프로젝트에서 갈등을 겪었던 경험과 해결 과정을 설명해보세요.'),
  ('연세대학교', '경영학과', '활동우수형', '전공적합성', '경영학을 선택한 이유와 관련 활동 경험을 말해보세요.'),
  ('고려대학교', '심리학과', '학업우수형', '인성', '자기소개서에 기재한 활동 중 가장 의미 있었던 활동은 무엇인가요.')
) AS v(university, department, track, category, question_text)
WHERE NOT EXISTS (SELECT 1 FROM interview.questions);

-- ────────────────────────────────────────────
-- 4. 학생 답변 (문제은행 질문별로 학생이 작성한 답변)
--    RLS는 anon 전체 허용 (questions와 동일한 신뢰 모델 — student_id는 클라이언트가
--    로그인 세션에서 들고 있는 값을 그대로 사용)
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS interview.answers (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  student_id  uuid        NOT NULL REFERENCES interview.students(id) ON DELETE CASCADE,
  question_id uuid        NOT NULL REFERENCES interview.questions(id) ON DELETE CASCADE,
  answer_text text        NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, question_id)
);
ALTER TABLE interview.answers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon select interview_answers" ON interview.answers;
DROP POLICY IF EXISTS "anon insert interview_answers" ON interview.answers;
DROP POLICY IF EXISTS "anon update interview_answers" ON interview.answers;

CREATE POLICY "anon select interview_answers" ON interview.answers
  FOR SELECT TO anon USING (true);
CREATE POLICY "anon insert interview_answers" ON interview.answers
  FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon update interview_answers" ON interview.answers
  FOR UPDATE TO anon USING (true);

CREATE OR REPLACE FUNCTION interview.answers_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_interview_answers_updated_at ON interview.answers;
CREATE TRIGGER trg_interview_answers_updated_at
  BEFORE UPDATE ON interview.answers
  FOR EACH ROW EXECUTE FUNCTION interview.answers_set_updated_at();

CREATE INDEX IF NOT EXISTS idx_interview_answers_student ON interview.answers (student_id);

-- ────────────────────────────────────────────
-- 4-1. 오늘의 목표 (일별 체크리스트, dcprime.10 chat.html의 goals 탭과 동일한 구조)
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS interview.goals (
  id         uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  student_id uuid        NOT NULL REFERENCES interview.students(id) ON DELETE CASCADE,
  date       date        NOT NULL,
  text       text        NOT NULL,
  done       boolean     NOT NULL DEFAULT false,
  sort_order int         NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE interview.goals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon select interview_goals" ON interview.goals;
DROP POLICY IF EXISTS "anon insert interview_goals" ON interview.goals;
DROP POLICY IF EXISTS "anon update interview_goals" ON interview.goals;
DROP POLICY IF EXISTS "anon delete interview_goals" ON interview.goals;

CREATE POLICY "anon select interview_goals" ON interview.goals
  FOR SELECT TO anon USING (true);
CREATE POLICY "anon insert interview_goals" ON interview.goals
  FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon update interview_goals" ON interview.goals
  FOR UPDATE TO anon USING (true);
CREATE POLICY "anon delete interview_goals" ON interview.goals
  FOR DELETE TO anon USING (true);

CREATE INDEX IF NOT EXISTS idx_interview_goals_student_date ON interview.goals (student_id, date);

-- ────────────────────────────────────────────
-- 4-2. 관리자 문제출제 (공통 질문 / 개별 질문)
--    공통 질문: visibility='common' — 전체 학생에게 노출
--    개별 질문: visibility='individual' — custom_question_targets에 매칭되는 학생에게만 노출
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS interview.custom_questions (
  id            uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  question_text text        NOT NULL,
  visibility    text        NOT NULL CHECK (visibility IN ('common', 'individual')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE interview.custom_questions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon select interview_custom_questions" ON interview.custom_questions;
DROP POLICY IF EXISTS "anon insert interview_custom_questions" ON interview.custom_questions;
DROP POLICY IF EXISTS "anon delete interview_custom_questions" ON interview.custom_questions;

CREATE POLICY "anon select interview_custom_questions" ON interview.custom_questions
  FOR SELECT TO anon USING (true);
CREATE POLICY "anon insert interview_custom_questions" ON interview.custom_questions
  FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon delete interview_custom_questions" ON interview.custom_questions
  FOR DELETE TO anon USING (true);

-- 개별 질문의 대상 학생 (한 질문에 여러 학생 중복 지정 가능)
CREATE TABLE IF NOT EXISTS interview.custom_question_targets (
  custom_question_id uuid NOT NULL REFERENCES interview.custom_questions(id) ON DELETE CASCADE,
  student_id          uuid NOT NULL REFERENCES interview.students(id) ON DELETE CASCADE,
  PRIMARY KEY (custom_question_id, student_id)
);
ALTER TABLE interview.custom_question_targets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon select interview_custom_question_targets" ON interview.custom_question_targets;
DROP POLICY IF EXISTS "anon insert interview_custom_question_targets" ON interview.custom_question_targets;
DROP POLICY IF EXISTS "anon delete interview_custom_question_targets" ON interview.custom_question_targets;

CREATE POLICY "anon select interview_custom_question_targets" ON interview.custom_question_targets
  FOR SELECT TO anon USING (true);
CREATE POLICY "anon insert interview_custom_question_targets" ON interview.custom_question_targets
  FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon delete interview_custom_question_targets" ON interview.custom_question_targets
  FOR DELETE TO anon USING (true);

-- 공통/개별 질문에 대한 학생 답변 (interview.answers와 동일한 구조, questions 대신 custom_questions 참조)
CREATE TABLE IF NOT EXISTS interview.custom_answers (
  id                 uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  student_id         uuid        NOT NULL REFERENCES interview.students(id) ON DELETE CASCADE,
  custom_question_id uuid        NOT NULL REFERENCES interview.custom_questions(id) ON DELETE CASCADE,
  answer_text        text        NOT NULL DEFAULT '',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, custom_question_id)
);
ALTER TABLE interview.custom_answers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon select interview_custom_answers" ON interview.custom_answers;
DROP POLICY IF EXISTS "anon insert interview_custom_answers" ON interview.custom_answers;
DROP POLICY IF EXISTS "anon update interview_custom_answers" ON interview.custom_answers;

CREATE POLICY "anon select interview_custom_answers" ON interview.custom_answers
  FOR SELECT TO anon USING (true);
CREATE POLICY "anon insert interview_custom_answers" ON interview.custom_answers
  FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon update interview_custom_answers" ON interview.custom_answers
  FOR UPDATE TO anon USING (true);

CREATE OR REPLACE FUNCTION interview.custom_answers_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_interview_custom_answers_updated_at ON interview.custom_answers;
CREATE TRIGGER trg_interview_custom_answers_updated_at
  BEFORE UPDATE ON interview.custom_answers
  FOR EACH ROW EXECUTE FUNCTION interview.custom_answers_set_updated_at();

-- ────────────────────────────────────────────
-- 5. 이미 만들어진 테이블/함수에 대한 권한 재부여
--    (스크립트를 이미 한 번 실행한 뒤 위의 GRANT/ALTER DEFAULT PRIVILEGES 구문이
--     새로 추가된 경우, 기존 객체에는 소급 적용되지 않으므로 여기서 명시적으로 다시 부여)
-- ────────────────────────────────────────────
GRANT ALL ON ALL TABLES IN SCHEMA interview TO anon, authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA interview TO anon, authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA interview TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
