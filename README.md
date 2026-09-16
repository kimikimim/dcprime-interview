# dcprime-interview

대치프라임 수시 면접 대비반 전용 학생 LMS. dcprime-academy와 같은 Supabase 프로젝트를 공유하되, `interview` 스키마로 분리해서 사용한다.

## 스택

- Astro + Tailwind v4 + Supabase JS (dcprime-academy, dcprime-students와 동일한 구성)

## 개발

```bash
npm install
npm run dev
```

## DB 설정

`supabase-setup.sql` 전체를 Supabase SQL Editor(스마낙히즈드트비지고콜루즈 프로젝트: smnakhjdtbqgwocwlluz)에 붙여넣고 한 번 실행한다. 재실행해도 안전하다.

- 사이트 공용 비밀번호 / 관리자 비밀번호는 `interview.config` 테이블에서 관리한다 (초기값: 사이트 `0000`, 관리자 `1250` — 운영 전에 반드시 변경할 것).
- 학생 비밀번호는 평문으로 저장되지 않고 `interview.students.password_hash`에 해시로만 저장된다. 관리자 페이지(`/admin`)에서 등록/재설정한다.

## 페이지 구성 (Phase 1 데모)

- `/` — 사이트 공용 비밀번호 → 학생 개인 비밀번호 2단계 로그인
- `/main` — 학생 메인 대시보드 (지원 현황 카드, 현재는 샘플 데이터)
- `/questions` — 문제은행 (대학/전형/유형별 필터)
- `/admin` — 관리자 로그인 + 학생관리 탭 (인적사항/비밀번호 CRUD)

## 다음 단계 (Phase 2)

- 과제 부여/제출, 모의면접 녹화 업로드 및 피드백, 개인 로드맵, 관리자 과제관리 탭
- 지원 현황을 샘플 데이터 대신 실제 `interview.applications` 테이블로 연동
