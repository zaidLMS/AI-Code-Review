const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

async function callOpenAI({ model, system, user, maxTokens, temperature }) {
  const apiKey = process.env.OPENAI_API_KEY;
  assert(apiKey, 'OPENAI_API_KEY is required for provider "openai"');
  const base = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature,
      max_tokens: maxTokens,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI error: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content || "";
}

async function callOpenRouter({ model, system, user, maxTokens, temperature }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  assert(apiKey, 'OPENROUTER_API_KEY is required for provider "openrouter"');
  const base = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature,
      max_tokens: maxTokens,
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter error: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content || "";
}

async function callOllama({ model, system, user, maxTokens, temperature }) {
  const base = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      options: { temperature, num_predict: maxTokens },
    }),
  });
  if (!res.ok) throw new Error(`Ollama error: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.message?.content || "";
}

async function callGoogle({ model, system, user, maxTokens, temperature }) {
  let llm = 0;
  // assert(apiKey, process.env.AI_API_KEY);
  const apiKey = process.env.AI_API_KEY;
  const base = process.env.BASE_URL || `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const res = await fetch(`${base}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              text: `${system}\n\n${user}`,
            },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Google error: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.candidates?.[0].content?.parts?.[0].text || "";
}

exports.callLLM = async (cfg) => {
  const p = (cfg.provider || "google").toLowerCase();
  if (p === "google") return callGoogle(cfg);
  if (p === "openai") return callOpenAI(cfg);
  if (p === "openrouter") return callOpenRouter(cfg);
  if (p === "ollama") return callOllama(cfg);
  throw new Error(`Unknown LLM provider: ${cfg.provider}`);
};
