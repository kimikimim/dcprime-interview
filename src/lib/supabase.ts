import { createClient } from '@supabase/supabase-js';

// dcprime-academy와 동일 프로젝트를 공유하고 interview 스키마로만 분리해서 사용
// anon key는 RLS로 보호되는 공개용 키라 코드에 직접 박아둠 (dcprime-students와 동일 관례)
export const supabaseUrl = 'https://smnakhjdtbqgwocwlluz.supabase.co';
export const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNtbmFraGpkdGJxZ3dvY3dsbHV6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4NDc2MDQsImV4cCI6MjA5MjQyMzYwNH0._jfUSWEVlMr8oapYLul33LRrhEnRJBSgppGNR1jshnA';

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  db: { schema: 'interview' },
  auth: {
    persistSession: false,
  },
});
