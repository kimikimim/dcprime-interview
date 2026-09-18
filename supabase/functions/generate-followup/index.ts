// 모의면접 꼬리질문 생성 Edge Function
//
// 학생이 본질문에 음성으로 답변하면, 그 오디오를 Gemini에 직접 넘겨
// (1) 답변 받아적기(transcript) (2) 답변 내용을 파고드는 꼬리질문 생성
// 을 한 번의 호출로 처리한다. STT를 별도로 돌리지 않는 이유는 Gemini가
// 오디오 입력을 직접 받아들이기 때문 (호출 1회로 비용/지연 최소화).
//
// 배포: supabase functions deploy generate-followup
// 필요한 시크릿: supabase secrets set GEMINI_API_KEY=... [GEMINI_MODEL=gemini-2.5-flash]

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    transcript: { type: "string", description: "학생 답변을 그대로 받아적은 한국어 텍스트" },
    followup_question: { type: "string", description: "답변 내용을 근거로 더 깊이 파고드는 한국어 면접 꼬리질문 1개" },
  },
  required: ["transcript", "followup_question"],
};

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
    const { questionText, audioBase64, mimeType, department } = await req.json();
    if (!questionText || !audioBase64 || !mimeType) {
      return new Response(JSON.stringify({ error: "questionText, audioBase64, mimeType이 모두 필요합니다." }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "GEMINI_API_KEY가 설정되지 않았습니다." }), {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
    const model = Deno.env.get("GEMINI_MODEL") ?? "gemini-3.6-flash";

    const roleLine =
      typeof department === "string" && department.trim()
        ? `당신은 ${department.trim()} 전공 대학교수입니다.`
        : `당신은 대학교수입니다.`;

    const prompt = `${roleLine} 아래는 수시 면접에서 학생에게 던진 질문과, 그에 대한 학생의 음성 답변입니다.

면접 질문: ${questionText}

첨부된 음성을 듣고 다음을 한국어로 작성하세요.
1. transcript: 학생 답변 내용을 그대로 받아적은 텍스트
2. followup_question: 답변 내용을 근거로 더 깊이 파고드는 자연스러운 면접 꼬리질문 1개. 질문 문장 하나만 작성하고 다른 설명은 붙이지 않는다.`;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: audioBase64 } }],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: RESPONSE_SCHEMA,
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
    return new Response(
      JSON.stringify({ transcript: parsed.transcript ?? "", followup_question: parsed.followup_question ?? "" }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
