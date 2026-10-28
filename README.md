# GameState Coach

A React chat UI and native Node.js backend that send a manually uploaded game screenshot and game-aware coaching prompt to a Qwen3-VL vision-language model. It returns a short, streamed coaching tip; no screenshot capture, game integration, database, or conversation storage is involved.

Qwen3-VL is available as open model weights (the Qwen3-VL-8B-Instruct Hugging Face model card lists Apache-2.0). Running those weights yourself still requires suitable hardware and an inference server. This app uses an OpenAI-compatible chat-completions endpoint so you can use a hosted service or a local server without changing the app.

## Run locally

- Node.js 22+
- A Qwen-compatible endpoint and its API key (or a local OpenAI-compatible Qwen server)

```sh
npm install
cp .env.example .env
```

Set `QWEN_API_KEY` in `.env`, then start the app:

```sh
npm run dev
```

Open the Vite URL printed in the terminal.

### Provider settings

The example `.env` uses a DashScope-compatible endpoint and `qwen3-vl-plus`. Use the endpoint and model name provided by your Qwen service:

```dotenv
QWEN_API_KEY=your-provider-key
QWEN_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
QWEN_MODEL=qwen3-vl-plus
```

For a local inference server, point the same settings at its OpenAI-compatible API. For example, with vLLM listening on port 8000 and serving Qwen3-VL-8B-Instruct:

```dotenv
QWEN_API_KEY=local-dev-key
QWEN_BASE_URL=http://localhost:8000/v1
QWEN_MODEL=Qwen/Qwen3-VL-8B-Instruct
```

Configure the local server with the corresponding API key if it enforces authentication.

## Use

Choose a game, optionally add a map and side/role, attach a screenshot, and ask a question—or send the screenshot without a question for a general next-step tip. Screenshots are resized and converted to JPEG in the browser, sent with the latest message, and not stored by this app. The earlier chat text is included as context; earlier screenshots are not resent.

The prompt guidance for CS2 and Dota 2 lives in `server/prompt.js`. Unrecognized games use a general game-state checklist. Update those profiles and the offline checks in `eval/cases.json` as the coach expands.

## Checks

```sh
npm run build
npm test
```

Tests check the game-aware prompt guidance without requiring a model API key. Live screenshot coaching requires a configured model endpoint.
