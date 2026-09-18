// 생기부 PDF 기반 개별질문 초안 생성 Edge Function
//
// 관리자가 학생의 생활기록부 PDF를 업로드하면, Gemini에 PDF를 직접 넘겨
// 예상 면접 질문 100개를 카테고리/근거와 함께 구조화된 JSON으로 받는다.
// AI는 초안만 생성하고, 실제 등록은 관리자가 검토 후 선택한 것만 진행한다
// (관리자 화면에서 체크박스로 골라 개별질문으로 등록).
//
// 배포: supabase functions deploy generate-questions-from-record
// 필요한 시크릿: GEMINI_API_KEY (generate-followup 함수와 공유)

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const RESPONSE_SCHEMA = {
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

function buildPrompt(count: number): string {
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST만 허용됩니다." }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  try {
    const { pdfBase64, count } = await req.json();
    if (!pdfBase64) {
      return new Response(JSON.stringify({ error: "pdfBase64가 필요합니다." }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
    const requestedCount = Number(count);
    const questionCount = Number.isFinite(requestedCount)
      ? Math.min(MAX_COUNT, Math.max(MIN_COUNT, Math.round(requestedCount)))
      : DEFAULT_COUNT;

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "GEMINI_API_KEY가 설정되지 않았습니다." }), {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
    const model = Deno.env.get("GEMINI_MODEL") ?? "gemini-3.6-flash";

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: buildPrompt(questionCount) }, { inline_data: { mime_type: "application/pdf", data: pdfBase64 } }],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: RESPONSE_SCHEMA,
            maxOutputTokens: Math.min(30000, Math.max(2000, questionCount * 200)),
          },
        }),
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error("Gemini API error:", errText);
      return new Response(JSON.stringify({ error: "AI 호출에 실패했습니다.", detail: errText }), {
        status: 502,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const geminiJson = await geminiRes.json();
    const text = geminiJson.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return new Response(JSON.stringify({ error: "AI 응답을 해석하지 못했습니다." }), {
        status: 502,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const parsed = JSON.parse(text);
    return new Response(JSON.stringify({ questions: parsed.questions ?? [] }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
