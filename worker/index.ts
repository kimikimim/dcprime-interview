// Cloudflare Worker — 정적 사이트(dist) 앞단에서 /api/* 요청만 처리한다.
//
// Gemini API 키를 브라우저에 노출하지 않으려면 서버 쪽에서 호출해야 해서,
// 예전 Supabase Edge Function 2개(generate-followup, generate-questions-from-record)를
// 이 Worker로 옮겼다. 키는 Cloudflare 대시보드의 Secret(GEMINI_API_KEY)으로 설정한다.
// /api/* 이외의 요청은 wrangler.jsonc의 assets 설정에 따라 Worker를 거치지 않고 정적 파일로 응답한다.

interface Env {
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  GEMINI_TTS_MODEL?: string;
  GEMINI_TTS_VOICE?: string;
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

// ── 모의면접 음성 전용 모드: 질문 문장을 Gemini TTS로 읽어 주는 음성(WAV) 생성 ──
const TTS_MODELS = ["gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts"];
const TTS_VOICES = new Set(["Kore", "Charon", "Orus", "Fenrir", "Puck", "Zephyr", "Aoede", "Leda", "Sulafat", "Gacrux", "Algieba", "Rasalgethi"]);
const TTS_DEFAULT_VOICE = "Charon";
// 말투(연기 지시) 프리셋. 바꾸면 캐시가 섞이지 않게 키에 이름을 포함시킴
const TTS_STYLES: Record<string, string> = {
  natural:
    "대학 면접장에서 교수 면접관이 학생에게 직접 말을 거는 것처럼, 정중하지만 자연스러운 구어체 억양으로 보통 속도로 말하세요. 글을 낭독하듯 또박또박 끊어 읽지 말고, 사람이 실제로 질문하듯 문장의 높낮이와 쉼을 자연스럽게 주세요.",
  warm:
    "친절하고 부드러운 교수님이 학생이 긴장하지 않도록 편안하게 질문하는 말투로, 따뜻하고 자연스럽게 보통 속도로 말하세요. 낭독하는 느낌 없이 대화하듯 말하세요.",
  serious:
    "실전 대학 면접의 중후하고 침착한 면접관 말투로, 군더더기 없이 담담하게 보통 속도로 말하세요. 로봇처럼 일정한 박자로 읽지 말고 사람처럼 자연스러운 억양을 쓰세요.",
};
const TTS_DEFAULT_STYLE = "natural";
const TTS_MAX_CHARS = 1500;

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Gemini TTS는 헤더 없는 16bit PCM을 돌려주므로 브라우저가 재생할 수 있게 WAV 헤더를 붙임
function pcmToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const write = (off: number, str: string) => [...str].forEach((c, i) => v.setUint8(off + i, c.charCodeAt(0)));
  write(0, "RIFF");
  v.setUint32(4, 36 + pcm.length, true);
  write(8, "WAVE");
  write(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  write(36, "data");
  v.setUint32(40, pcm.length, true);
  const out = new Uint8Array(44 + pcm.length);
  out.set(new Uint8Array(header), 0);
  out.set(pcm, 44);
  return out;
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function generateTts(req: Request, env: Env): Promise<Response> {
  const { text, voice, style } = (await req.json()) as any;
  if (typeof text !== "string" || !text.trim()) return json({ error: "text가 필요합니다." }, 400);
  if (text.length > TTS_MAX_CHARS) return json({ error: `text는 ${TTS_MAX_CHARS}자 이하여야 합니다.` }, 400);
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) return json({ error: "GEMINI_API_KEY가 설정되지 않았습니다." }, 500);

  const voiceName = typeof voice === "string" && TTS_VOICES.has(voice) ? voice : env.GEMINI_TTS_VOICE ?? TTS_DEFAULT_VOICE;
  const models = env.GEMINI_TTS_MODEL ? [env.GEMINI_TTS_MODEL] : TTS_MODELS;
  const styleName = typeof style === "string" && style in TTS_STYLES ? style : TTS_DEFAULT_STYLE;

  // 같은 질문은 한 번만 생성하고 이후에는 캐시에서 바로 응답 (질문 은행은 고정 텍스트라 적중률이 높음)
  const cache = (caches as any).default as Cache;
  const cacheKey = new Request(`https://tts-cache.internal/${await sha256Hex(`${models[0]}|${voiceName}|${styleName}|${text}`)}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const prompt = `${TTS_STYLES[styleName]} 아래 문장만 그대로 말하고 다른 말은 덧붙이지 마세요.\n\n${text}`;
  let lastErr = "";
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
          },
        }),
      });
      if (!res.ok) {
        lastErr = await res.text();
        console.error("Gemini TTS error:", model, res.status, lastErr);
        if (res.status === 404) break; // 모델 이름이 없으면 다음 후보로
        continue;
      }
      const j: any = await res.json();
      const part = j.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData?.data);
      if (!part) {
        lastErr = "오디오 응답이 비어 있습니다.";
        continue; // TTS 모델은 가끔 빈 응답을 주므로 한 번 더 시도
      }
      const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType ?? "")?.[1]) || 24000;
      const wav = pcmToWav(base64ToBytes(part.inlineData.data), rate);
      const out = new Response(wav, {
        headers: { "Content-Type": "audio/wav", "Cache-Control": "public, max-age=2592000" },
      });
      await cache.put(cacheKey, out.clone());
      return out;
    }
  }
  return json({ error: "음성 생성에 실패했습니다.", detail: lastErr }, 502);
}

const ROUTES: Record<string, (req: Request, env: Env) => Promise<Response>> = {
  "/api/tts": generateTts,
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
