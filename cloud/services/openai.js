 async function callOpenAIResponse({
  apiKey,
  prompt,
  model = process.env.OPENAI_MODEL || "gpt-4o",
  maxOutputTokens = 1200,
}) {
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY");
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_output_tokens: maxOutputTokens,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: prompt,
            },
          ],
        },
      ],
    }),
  });

  const rawText = await response.text();

  if (!response.ok) {
    throw new Error(`OpenAI error ${response.status}: ${rawText}`);
  }

  let json;
  try {
    json = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`Failed to parse OpenAI response: ${rawText}`);
  }

  // 🔥 Extract usage (important for cost tracking)
  const usage = {
    input_tokens: json?.usage?.input_tokens ?? 0,
    output_tokens: json?.usage?.output_tokens ?? 0,
    total_tokens: json?.usage?.total_tokens ?? 0,
  };

  console.log("OPENAI USAGE:", usage);

  // 🔥 Extract text (robust across models)
  let finalText = "";

  // Preferred shortcut field
  if (typeof json.output_text === "string" && json.output_text.trim()) {
    finalText = json.output_text.trim();
  } else if (Array.isArray(json.output)) {
    for (const item of json.output) {
      if (!Array.isArray(item.content)) continue;

      for (const content of item.content) {
        if (
          content &&
          content.type === "output_text" &&
          typeof content.text === "string"
        ) {
          finalText += content.text;
        }
      }
    }

    finalText = finalText.trim();
  }

  // 🔥 Fail hard if no usable text
  if (!finalText) {
    console.error("EMPTY OPENAI RESPONSE:", JSON.stringify(json));
    throw new Error("OpenAI returned empty text");
  }

  return {
    text: finalText,
    usage,
  };
}

module.exports = {
  callOpenAIResponse,
};