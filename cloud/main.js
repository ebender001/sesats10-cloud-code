const { buildSesatsAIPrompt } = require("./prompts/sesatsAIPrompt");
const { callOpenAIResponse } = require("./services/openai");

function requireString(params, key) {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Parse.Error(
      Parse.Error.VALIDATION_ERROR,
      `Missing or invalid parameter: ${key}`
    );
  }
  return value.trim();
}

function optionalString(params, key) {
  const value = params[key];
  if (value == null) return "";
  return String(value);
}

const PROMPT_VERSION = 1;

Parse.Cloud.define("generateSesatsAIUpdate", async (request) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Parse.Error(
      Parse.Error.SCRIPT_FAILED,
      "Server configuration error: missing OPENAI_API_KEY"
    );
  }

  const model = process.env.OPENAI_MODEL || "gpt-4o";

  const questionId = requireString(request.params, "questionId");
  const questionText = requireString(request.params, "questionText");
  const distractorA = optionalString(request.params, "distractorA");
  const distractorB = optionalString(request.params, "distractorB");
  const distractorC = optionalString(request.params, "distractorC");
  const distractorD = optionalString(request.params, "distractorD");
  const distractorE = optionalString(request.params, "distractorE");
  const correctAnswer = requireString(request.params, "correctAnswer");
  const critique = optionalString(request.params, "critique");
  const title = optionalString(request.params, "title");
  const section = optionalString(request.params, "section");
  const examId = optionalString(request.params, "examId");

  let cachedText = null;
  try {
    cachedText = await getCachedInsight(questionId, PROMPT_VERSION, model);
  } catch (err) {
    console.error("Cache lookup failed:", err);
  }

  if (cachedText) {
    return {
      questionId,
      model,
      promptVersion: PROMPT_VERSION,
      text: String(cachedText),
      cached: true,
    };
  }

  const prompt = buildSesatsAIPrompt({
    questionId,
    title,
    section,
    examId,
    questionText,
    distractorA,
    distractorB,
    distractorC,
    distractorD,
    distractorE,
    correctAnswer,
    critique,
  });

  const { text, usage } = await callOpenAIResponse({
    apiKey,
    prompt,
    model,
    maxOutputTokens: 1200,
  });

  if (!text || !text.trim()) {
    throw new Parse.Error(
      Parse.Error.SCRIPT_FAILED,
      "AI returned empty response"
    );
  }

  const cleanText = text.trim();

  try {
    await logAIUsage({
      questionId,
      model,
      promptVersion: PROMPT_VERSION,
      usage,
    });
  } catch (err) {
    console.error("AI usage logging failed:", err);
  }

  try {
    await saveInsightCache({
      questionId,
      promptVersion: PROMPT_VERSION,
      model,
      text: cleanText,
    });
  } catch (err) {
    console.error("Cache save failed:", err);
  }

  return {
    questionId,
    model,
    promptVersion: PROMPT_VERSION,
    text: cleanText,
    cached: false,
  };
});

// Lets a user flag an AI Update as wrong, offensive, or otherwise problematic. Stored for
// manual review rather than auto-actioned, since there's no moderation queue UI yet.
Parse.Cloud.define("reportAIContent", async (request) => {
  const questionId = requireString(request.params, "questionId");
  const aiText = optionalString(request.params, "aiText").slice(0, 8000);
  const comment = optionalString(request.params, "comment").slice(0, 2000);
  const platform = optionalString(request.params, "platform");
  const appVersion = optionalString(request.params, "appVersion");

  const Report = Parse.Object.extend("AIContentReport");
  const report = new Report();

  report.set("questionId", questionId);
  report.set("aiText", aiText);
  report.set("comment", comment);
  report.set("platform", platform);
  report.set("appVersion", appVersion);
  report.set("status", "open");

  await report.save(null, { useMasterKey: true });

  return { received: true };
});

async function getCachedInsight(questionId, promptVersion, model) {
  if (typeof questionId !== "string" || !questionId.trim()) {
    console.error("Invalid id:", questionId);
    return null;
  }

  const Cache = Parse.Object.extend("AIInsightCache");
  const query = new Parse.Query(Cache);

  query.equalTo("questionId", questionId.trim());
  query.equalTo("promptVersion", Number(promptVersion));

  try {
    const result = await query.first({ useMasterKey: true });

    if (!result) return null;

    const text = result.get("text");
    if (!text || typeof text !== "string") return null;

    return text;
  } catch (err) {
    console.error("Cache lookup failed:", err);
    return null;
  }
}

async function saveInsightCache({ questionId, promptVersion, model, text }) {
  const normalizedID = typeof questionId === "string" ? questionId.trim() : "";
  const pVersion = Number(promptVersion);

  if (!normalizedID) {
    console.error("Invalid questionId:", questionId);
    return;
  }

  const Cache = Parse.Object.extend("AIInsightCache");

  const payload = {
    questionId: normalizedID,
    promptVersion: pVersion,
    model,
    text: String(text),
  };

  try {
    const cache = new Cache();
    Object.entries(payload).forEach(([k, v]) => cache.set(k, v));

    await cache.save(null, { useMasterKey: true });
  } catch (err) {
    if (err.code === 137) {
      try {
        const query = new Parse.Query(Cache);
        query.equalTo("questionId", normalizedID);
        query.equalTo("promptVersion", pVersion);
        query.equalTo("model", model);

        const existing = await query.first({ useMasterKey: true });

        if (existing) {
          existing.set("text", String(text));
          await existing.save(null, { useMasterKey: true });
        }
      } catch (updateErr) {
        console.error("Cache update after duplicate failed:", updateErr);
      }
    } else {
      console.error("Cache save failed:", err);
    }
  }
}

function getDateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

async function logAIUsage({
  questionId,
  model,
  promptVersion,
  usage,
}) {
  const inputTokens = Number(usage?.input_tokens ?? 0);
  const outputTokens = Number(usage?.output_tokens ?? 0);
  const totalTokens = Number(
    usage?.total_tokens ?? (inputTokens + outputTokens)
  );

  const inputRatePerMillion = 2.5;
  const outputRatePerMillion = 15.0;

  const estimatedInputCost = (inputTokens / 1_000_000) * inputRatePerMillion;
  const estimatedOutputCost = (outputTokens / 1_000_000) * outputRatePerMillion;
  const estimatedTotalCost = estimatedInputCost + estimatedOutputCost;

  const dateKey = getDateKey();

  const UsageLog = Parse.Object.extend("AIUsageLog");
  const log = new UsageLog();

  log.set("dateKey", dateKey);
  log.set("questionId", String(questionId));
  log.set("model", model);
  log.set("promptVersion", Number(promptVersion));
  log.set("inputTokens", inputTokens);
  log.set("outputTokens", outputTokens);
  log.set("totalTokens", totalTokens);
  log.set("estimatedInputCost", estimatedInputCost);
  log.set("estimatedOutputCost", estimatedOutputCost);
  log.set("estimatedTotalCost", estimatedTotalCost);

  await log.save(null, { useMasterKey: true });

  const Daily = Parse.Object.extend("AIUsageDaily");
  const query = new Parse.Query(Daily);
  query.equalTo("dateKey", dateKey);

  let daily = await query.first({ useMasterKey: true });

  if (!daily) {
    daily = new Daily();
    daily.set("dateKey", dateKey);
    daily.set("inputTokens", 0);
    daily.set("outputTokens", 0);
    daily.set("totalTokens", 0);
    daily.set("estimatedInputCost", 0);
    daily.set("estimatedOutputCost", 0);
    daily.set("estimatedTotalCost", 0);
    daily.set("callCount", 0);
  }

  daily.set("inputTokens", Number(daily.get("inputTokens") || 0) + inputTokens);
  daily.set("outputTokens", Number(daily.get("outputTokens") || 0) + outputTokens);
  daily.set("totalTokens", Number(daily.get("totalTokens") || 0) + totalTokens);
  daily.set(
    "estimatedInputCost",
    Number(daily.get("estimatedInputCost") || 0) + estimatedInputCost
  );
  daily.set(
    "estimatedOutputCost",
    Number(daily.get("estimatedOutputCost") || 0) + estimatedOutputCost
  );
  daily.set(
    "estimatedTotalCost",
    Number(daily.get("estimatedTotalCost") || 0) + estimatedTotalCost
  );
  daily.set("callCount", Number(daily.get("callCount") || 0) + 1);

  await daily.save(null, { useMasterKey: true });
}