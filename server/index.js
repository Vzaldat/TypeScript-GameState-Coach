import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { buildCoachPrompt } from "./prompt.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const port = Number(process.env.PORT) || 3001;
const maxRequestBytes = 8 * 1024 * 1024;
const maxImageBytes = 5 * 1024 * 1024;
const defaultBaseUrl = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const baseUrl = (process.env.QWEN_BASE_URL || defaultBaseUrl).replace(/\/+$/, "");
const model = process.env.QWEN_MODEL || "qwen3-vl-plus";

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/api/health") {
    sendJson(response, 200, { status: "ok", model });
    return;
  }

  if (request.method !== "POST" || request.url !== "/api/chat") {
    sendJson(response, 404, { error: "Not found." });
    return;
  }

  if (!process.env.QWEN_API_KEY) {
    sendJson(response, 503, {
      error: "Set QWEN_API_KEY in .env to enable the vision model.",
    });
    return;
  }

  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The request failed.";
    sendJson(response, message === "Request body is too large." ? 413 : 400, { error: message });
    return;
  }

  if (!isChatRequest(body)) {
    sendJson(response, 400, {
      error: "Choose a game and attach a screenshot or enter a question. Screenshots must be PNG, JPEG, or WebP under 5 MB.",
    });
    return;
  }

  const prompt = buildCoachPrompt({
    game: body.game,
    map: body.map ?? "",
    side: body.side ?? "",
    observation: body.message ?? "",
  });
  const messages = [
    { role: "system", content: prompt.prompt },
    ...body.history.map(({ role, content }) => ({ role, content })),
    {
      role: "user",
      content: makeUserContent(body.message ?? "", body.imageDataUrl),
    },
  ];

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders();

  const controller = new AbortController();
  response.on("close", () => controller.abort());

  try {
    await streamCompletion(messages, controller.signal, (token) => {
      if (!response.destroyed) {
        response.write(`event: token\ndata: ${JSON.stringify({ token })}\n\n`);
      }
    });
    if (!response.destroyed) response.write("event: done\ndata: {}\n\n");
  } catch (error) {
    if (!controller.signal.aborted) {
      console.error("Qwen chat request failed:", error);
      if (!response.destroyed) {
        response.write(
          `event: error\ndata: ${JSON.stringify({ message: getSafeErrorMessage(error) })}\n\n`,
        );
      }
    }
  } finally {
    if (!response.destroyed) response.end();
  }
});

server.listen(port, () => {
  console.log(`GameState Coach listening at http://localhost:${port} (model: ${model})`);
});

function isChatRequest(value) {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.game !== "string" ||
    value.game.trim().length === 0 ||
    value.game.length > 80 ||
    (value.map !== undefined && (typeof value.map !== "string" || value.map.length > 80)) ||
    (value.side !== undefined && (typeof value.side !== "string" || value.side.length > 80)) ||
    (value.message !== undefined &&
      (typeof value.message !== "string" || value.message.length > 4000)) ||
    (value.imageDataUrl !== undefined && !isImageDataUrl(value.imageDataUrl)) ||
    (value.message?.trim().length ?? 0) === 0 && value.imageDataUrl === undefined ||
    !Array.isArray(value.history) ||
    value.history.length > 12
  ) {
    return false;
  }

  return value.history.every(
    (item) =>
      item &&
      typeof item === "object" &&
      ["user", "assistant"].includes(item.role) &&
      typeof item.content === "string" &&
      item.content.length <= 4000,
  );
}

function isImageDataUrl(value) {
  if (typeof value !== "string" || value.length > maxImageBytes * 1.4) return false;
  const match = value.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  return Boolean(match && Buffer.byteLength(match[2], "base64") <= maxImageBytes);
}

function makeUserContent(message, imageDataUrl) {
  const text = message.trim() || "Please inspect this screenshot and give me your best immediate coaching tip.";
  if (!imageDataUrl) return text;
  return [
    { type: "text", text },
    { type: "image_url", image_url: { url: imageDataUrl } },
  ];
}

async function streamCompletion(messages, signal, onToken) {
  let endpoint;
  try {
    endpoint = new URL(`${baseUrl}/chat/completions`);
  } catch {
    throw new Error("QWEN_BASE_URL is not a valid URL.");
  }
  if (!["http:", "https:"].includes(endpoint.protocol)) {
    throw new Error("QWEN_BASE_URL must use HTTP or HTTPS.");
  }

  let upstream;
  try {
    upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.QWEN_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        max_tokens: 300,
        temperature: 0.4,
      }),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error("Could not connect to the configured Qwen endpoint.");
  }

  if (!upstream.ok) {
    throw new Error(`Qwen endpoint returned HTTP ${upstream.status}. Check the model, endpoint, and API key.`);
  }
  if (!upstream.body) throw new Error("Qwen endpoint returned an empty response.");

  const decoder = new TextDecoder();
  let pending = "";
  let receivedText = false;
  for await (const chunk of upstream.body) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        throw new Error("Qwen endpoint returned an invalid streaming response.");
      }
      const token = payload.choices?.[0]?.delta?.content;
      if (typeof token === "string" && token) {
        receivedText = true;
        onToken(token);
      }
    }
  }
  if (!receivedText) throw new Error("Qwen returned no coaching text. Check that the selected model supports chat completions.");
}

async function readJson(request) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > maxRequestBytes) {
      throw new Error("Request body is too large.");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function getSafeErrorMessage(error) {
  return error instanceof Error ? error.message : "The coaching request failed.";
}

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
