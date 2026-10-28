import { useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  imageDataUrl?: string;
};

type ChatEvent = {
  event: string;
  data: { token?: string; message?: string };
};

const maxImageFileSize = 15 * 1024 * 1024;
const maxEncodedImageSize = 4 * 1024 * 1024;

async function optimizeImage(file: File): Promise<string> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    throw new Error("Choose a PNG, JPEG, or WebP screenshot.");
  }
  if (file.size > maxImageFileSize) {
    throw new Error("Screenshot is too large. Choose an image under 15 MB.");
  }

  const bitmap = await createImageBitmap(file);
  try {
    let scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Could not process this screenshot.");

      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const image = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.82 - attempt * 0.08),
      );
      if (!image) throw new Error("Could not process this screenshot.");
      if (image.size <= maxEncodedImageSize) {
        return await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(new Error("Could not read the processed screenshot."));
          reader.readAsDataURL(image);
        });
      }
      scale *= 0.75;
    }
    throw new Error("Could not reduce the screenshot enough. Choose a smaller image.");
  } finally {
    bitmap.close();
  }
}

async function* readEvents(response: Response): AsyncGenerator<ChatEvent> {
  if (!response.body) throw new Error("The server did not start a response stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";

    for (const rawEvent of events) {
      const event = rawEvent.match(/^event: (.+)$/m)?.[1];
      const data = rawEvent.match(/^data: (.+)$/m)?.[1];
      if (event && data) yield { event, data: JSON.parse(data) as ChatEvent["data"] };
    }
    if (done) break;
  }
}

export default function App() {
  const [game, setGame] = useState("CS2");
  const [customGame, setCustomGame] = useState("");
  const [map, setMap] = useState("");
  const [side, setSide] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [imageName, setImageName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const endOfChat = useRef<HTMLDivElement>(null);

  function updateAssistantMessage(index: number, content: string) {
    setMessages((current) =>
      current.map((message, itemIndex) =>
        itemIndex === index ? { ...message, content: message.content + content } : message,
      ),
    );
  }

  async function attachImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError("");
    try {
      setImageDataUrl(await optimizeImage(file));
      setImageName(file.name);
    } catch (imageError) {
      setError(imageError instanceof Error ? imageError.message : "Could not load this screenshot.");
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    if (loading || (!message && !imageDataUrl)) return;

    const selectedImage = imageDataUrl ?? undefined;
    const userMessage: ChatMessage = {
      role: "user",
      content: message,
      imageDataUrl: selectedImage,
    };
    const history = messages.map(({ role, content, imageDataUrl: previousImage }) => ({
      role,
      content: content || (previousImage ? "I shared a gameplay screenshot." : ""),
    })).filter((item) => item.content).slice(-12);
    const assistantIndex = messages.length + 1;
    setMessages((current) => [...current, userMessage, { role: "assistant", content: "" }]);
    setDraft("");
    setImageDataUrl(null);
    setImageName("");
    setError("");
    setLoading(true);
    requestAnimationFrame(() => endOfChat.current?.scrollIntoView({ behavior: "smooth" }));

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          game: game === "Other" ? customGame : game,
          map,
          side,
          message,
          imageDataUrl: selectedImage,
          history,
        }),
      });

      if (!response.ok) {
        const result = (await response.json()) as { error?: string };
        throw new Error(result.error || "Could not start the coaching request.");
      }

      for await (const eventMessage of readEvents(response)) {
        if (eventMessage.event === "token") {
          updateAssistantMessage(assistantIndex, eventMessage.data.token ?? "");
        }
        if (eventMessage.event === "error") {
          throw new Error(eventMessage.data.message ?? "The coaching request failed.");
        }
      }
    } catch (requestError) {
      setMessages((current) => current.filter((_, index) => index !== assistantIndex));
      setError(requestError instanceof Error ? requestError.message : "The coaching request failed.");
    } finally {
      setLoading(false);
      requestAnimationFrame(() => endOfChat.current?.scrollIntoView({ behavior: "smooth" }));
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  const selectedGame = game === "Other" ? customGame : game;

  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="GameState Coach home">
          <span className="brand-mark">G</span>
          <span>GAMESTATE<span className="brand-light"> / COACH</span></span>
        </a>
        <span className="status"><span className="status-dot" /> QWEN3-VL COACH</span>
      </header>

      <section className="hero">
        <div className="eyebrow"><span>LIVE</span> SCREENSHOT GAME COACH</div>
        <h1>Read the round.<br /><em>Make your move.</em></h1>
        <p className="intro">Share a screenshot and ask. Get a focused tip from a vision-language coach.</p>
      </section>

      <section className="chat-layout">
        <aside className="context-card">
          <div className="card-heading">
            <span className="step-number">01</span>
            <div><h2>Game context</h2><p>Helps focus the advice.</p></div>
          </div>
          <label htmlFor="game">GAME</label>
          <select id="game" value={game} onChange={(event) => setGame(event.target.value)} disabled={loading}>
            <option value="CS2">Counter-Strike 2</option>
            <option value="Dota 2">Dota 2</option>
            <option value="Other">Other game</option>
          </select>
          {game === "Other" && (
            <input
              className="custom-game"
              aria-label="Game name"
              placeholder="Enter game name"
              value={customGame}
              onChange={(event) => setCustomGame(event.target.value)}
              required
              disabled={loading}
            />
          )}
          <label htmlFor="map">MAP <span className="optional">OPTIONAL</span></label>
          <input id="map" value={map} onChange={(event) => setMap(event.target.value)} placeholder="e.g. Mirage" maxLength={80} disabled={loading} />
          <label htmlFor="side">SIDE / ROLE <span className="optional">OPTIONAL</span></label>
          <input id="side" value={side} onChange={(event) => setSide(event.target.value)} placeholder="e.g. CT, position" maxLength={80} disabled={loading} />
          <div className="context-note">
            <span className="status-dot" />
            <p>Only the screenshot you attach is sent with your latest message.</p>
          </div>
        </aside>

        <section className="chat-card" aria-label="Coach chat">
          <div className="chat-header">
            <div className="card-heading">
              <span className="step-number">02</span>
              <div><h2>Coach chat</h2><p>{selectedGame || "Choose a game"} · screenshot-aware</p></div>
            </div>
            {messages.length > 0 && (
              <button className="new-chat" type="button" onClick={() => { setMessages([]); setError(""); }} disabled={loading}>
                NEW CHAT
              </button>
            )}
          </div>

          <div className="chat-messages" aria-live="polite">
            {messages.length === 0 ? (
              <div className="welcome-message">
                <span className="empty-icon">↗</span>
                <h3>What’s happening in game?</h3>
                <p>Attach a screenshot and ask for your next move, buy, rotation, or fight decision.</p>
                <div className="suggestions">
                  <button type="button" onClick={() => setDraft("What should I do next?")} disabled={loading}>What should I do next?</button>
                  <button type="button" onClick={() => setDraft("Is this a good buy for the round?")} disabled={loading}>Is this a good buy?</button>
                </div>
              </div>
            ) : messages.map((message, index) => (
              <article className={`message ${message.role}`} key={`${index}-${message.role}`}>
                <div className="message-label">{message.role === "user" ? "YOU" : "COACH"}</div>
                {message.imageDataUrl && (
                  <img className="message-image" src={message.imageDataUrl} alt="Attached gameplay screenshot" />
                )}
                {message.content && <p>{message.content}</p>}
                {message.role === "assistant" && !message.content && loading && (
                  <p className="thinking"><span /> Looking at the game state…</p>
                )}
              </article>
            ))}
            <div ref={endOfChat} />
          </div>

          {error && <p className="error-message" role="alert">{error}</p>}

          <form className="composer" onSubmit={sendMessage}>
            {imageDataUrl && (
              <div className="attachment-preview">
                <img src={imageDataUrl} alt="Screenshot selected for upload" />
                <span>{imageName}</span>
                <button type="button" aria-label="Remove screenshot" onClick={() => { setImageDataUrl(null); setImageName(""); }}>×</button>
              </div>
            )}
            <div className="composer-row">
              <input
                ref={imageInput}
                className="file-input"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={attachImage}
                aria-label="Upload screenshot"
              />
              <button className="attach-button" type="button" onClick={() => imageInput.current?.click()} disabled={loading} aria-label="Attach screenshot">
                +
              </button>
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                placeholder="Ask your coach… (Shift + Enter for a new line)"
                maxLength={4000}
                rows={2}
                aria-label="Message your coach"
              />
              <button className="send-button" type="submit" disabled={loading || (!draft.trim() && !imageDataUrl) || (game === "Other" && !customGame.trim())} aria-label="Send message">
                {loading ? <span className="send-spinner" /> : "↑"}
              </button>
            </div>
            <div className="composer-foot">
              <span>PNG / JPEG / WEBP · SCREENSHOTS OPTIMIZED BEFORE SENDING</span>
              <span>SHIFT + ENTER FOR NEW LINE</span>
            </div>
          </form>
        </section>
      </section>

      <footer>
        <span>VISION MODEL · MANUAL SCREENSHOT</span>
        <span>KEEP YOUR EYES IN THE GAME <span className="footer-arrow">↗</span></span>
      </footer>
    </main>
  );
}
