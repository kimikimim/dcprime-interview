// Cloudflare Worker — 정적 사이트(dist) 앞단에서 /api/* 요청만 처리한다.
//
// Gemini API 키를 브라우저에 노출하지 않으려면 서버 쪽에서 호출해야 해서,
// 예전 Supabase Edge Function 2개(generate-followup, generate-questions-from-record)를
// 이 Worker로 옮겼다. 키는 Cloudflare 대시보드의 Secret(GEMINI_API_KEY)으로 설정한다.
// /api/* 이외의 요청은 wrangler.jsonc의 assets 설정에 따라 Worker를 거치지 않고 정적 파일로 응답한다.

interface Env {
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
}

const DEFAULT_MODEL = "gemini-3.6-flash";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function callGemini(env: Env, parts: unknown[], generationConfig: Record<string, unknown>): Promise<Response | string> {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) return json({ error: "GEMINI_API_KEY가 설정되지 않았습니다." }, 500);
  const model = env.GEMINI_MODEL ?? DEFAULT_MODEL;

  const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({ contents: [{ parts }], generationConfig }),
  });

  if (!geminiRes.ok) {
    const errText = await geminiRes.text();
    console.error("Gemini API error:", errText);
    return json({ error: "AI 호출에 실패했습니다.", detail: errText }, 502);
  }
  const geminiJson: any = await geminiRes.json();
  const text = geminiJson.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return json({ error: "AI 응답을 해석하지 못했습니다." }, 502);
  return text;
}

// ── 모의면접 꼬리질문: 음성 답변 → 받아적기 + 꼬리질문 1개 ──
const FOLLOWUP_SCHEMA = {
  type: "object",
  properties: {
    transcript: { type: "string", description: "학생 답변을 그대로 받아적은 한국어 텍스트" },
    followup_question: { type: "string", description: "답변 내용을 근거로 더 깊이 파고드는 한국어 면접 꼬리질문 1개" },
  },
  required: ["transcript", "followup_question"],
};

async function generateFollowup(req: Request, env: Env): Promise<Response> {
  const { questionText, audioBase64, mimeType, department } = (await req.json()) as any;
  if (!questionText || !audioBase64 || !mimeType) {
    return json({ error: "questionText, audioBase64, mimeType이 모두 필요합니다." }, 400);
  }

  const roleLine =
    typeof department === "string" && department.trim()
      ? `당신은 ${department.trim()} 전공 대학교수입니다.`
      : `당신은 대학교수입니다.`;

  const prompt = `${roleLine} 아래는 수시 면접에서 학생에게 던진 질문과, 그에 대한 학생의 음성 답변입니다.

면접 질문: ${questionText}

첨부된 음성을 듣고 다음을 한국어로 작성하세요.
1. transcript: 학생 답변 내용을 그대로 받아적은 텍스트
2. followup_question: 답변 내용을 근거로 더 깊이 파고드는 자연스러운 면접 꼬리질문 1개. 질문 문장 하나만 작성하고 다른 설명은 붙이지 않는다.`;

  const result = await callGemini(env, [{ text: prompt }, { inline_data: { mime_type: mimeType, data: audioBase64 } }], {
    responseMimeType: "application/json",
    responseSchema: FOLLOWUP_SCHEMA,
  });
  if (result instanceof Response) return result;

  const parsed = JSON.parse(result);
  return json({ transcript: parsed.transcript ?? "", followup_question: parsed.followup_question ?? "" });
}

// ── 생기부 PDF 기반 개별질문 초안 생성 (관리자가 검토 후 선택 등록) ──
const QUESTIONS_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: { type: "string", description: "질문 카테고리 (예: 세특-화학, 동아리활동, 진로활동, 리더십·인성, 최신 기술 트렌드 연계 등)" },
          source: { type: "string", description: "질문의 근거가 된 생기부 항목 요약" },
          question: { type: "string", description: "실제 면접에서 물어볼 법한 한국어 질문 문장" },
        },
        required: ["category", "source", "question"],
      },
    },
  },
  required: ["questions"],
};

function buildQuestionsPrompt(count: number): string {
  return `당신은 대학 수시 면접 전문 컨설턴트입니다. 첨부된 학생생활기록부(생기부) PDF를
분석하여, 실제 대학 면접에서 나올 법한 예상 질문을 정확히 ${count}개 생성하세요.

규칙:
1. 각 질문은 생기부의 구체적인 내용(활동명, 과목, 세부능력 및 특기사항 등)을
   근거로 삼는다. "지원동기가 무엇인가요" 같은 일반적이고 뻔한 질문은 최소화한다.
2. 다음 카테고리에 걸쳐 고르게 분포시킨다:
   세특(과목별) / 동아리활동 / 자율활동 / 진로활동 / 수상경력 /
   봉사활동 / 행동특성 및 종합의견 / 리더십·인성 / 최신 기술 트렌드 연계
3. 면접관이 실제로 구어체로 물어볼 법한 자연스러운 한국어 문장으로 작성한다.
4. 같은 활동을 여러 각도(사실 확인 → 이유·동기 → 배운 점 → 다른 상황에 적용)로
   파고드는 질문도 섞어서, 꼬리질문 대비 훈련에도 쓰일 수 있게 한다.
5. 각 질문마다 근거가 된 생기부 항목을 짧게 표기한다.
6. 정확히 ${count}개, 중복 없이 생성한다.`;
}

const MIN_COUNT = 1;
const MAX_COUNT = 150;
const DEFAULT_COUNT = 30;

async function generateQuestionsFromRecord(req: Request, env: Env): Promise<Response> {
  const { pdfBase64, count } = (await req.json()) as any;
  if (!pdfBase64) return json({ error: "pdfBase64가 필요합니다." }, 400);

  const requestedCount = Number(count);
  const questionCount = Number.isFinite(requestedCount)
    ? Math.min(MAX_COUNT, Math.max(MIN_COUNT, Math.round(requestedCount)))
    : DEFAULT_COUNT;

  const result = await callGemini(
    env,
    [{ text: buildQuestionsPrompt(questionCount) }, { inline_data: { mime_type: "application/pdf", data: pdfBase64 } }],
    {
      responseMimeType: "application/json",
      responseSchema: QUESTIONS_SCHEMA,
      maxOutputTokens: Math.min(30000, Math.max(2000, questionCount * 200)),
    }
  );
  if (result instanceof Response) return result;

  const parsed = JSON.parse(result);
  return json({ questions: parsed.questions ?? [] });
}

const ROUTES: Record<string, (req: Request, env: Env) => Promise<Response>> = {
  "/api/generate-followup": generateFollowup,
  "/api/generate-questions-from-record": generateQuestionsFromRecord,
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const handler = ROUTES[url.pathname];
    if (!handler) return json({ error: "Not found" }, 404);
    if (req.method !== "POST") return json({ error: "POST만 허용됩니다." }, 405);

    // 다른 사이트의 브라우저에서 이 API(=내 Gemini 키)를 가져다 쓰지 못하게 같은 출처만 허용
    const origin = req.headers.get("Origin");
    if (origin && new URL(origin).host !== url.host) return json({ error: "허용되지 않은 출처입니다." }, 403);

    try {
      return await handler(req, env);
    } catch (err) {
      console.error(err);
      return json({ error: String(err) }, 500);
    }
  },
};
