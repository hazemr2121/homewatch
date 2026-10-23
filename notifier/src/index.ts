import { connect } from "mqtt";

// ---------- config ----------

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

const config = {
  botToken: env("TELEGRAM_BOT_TOKEN"),
  chatId: env("TELEGRAM_CHAT_ID"),
  mqttUrl: env("MQTT_URL", "mqtt://mosquitto:1883"),
  frigateUrl: env("FRIGATE_URL", "http://frigate:5000"),
  telegramApi: env("TELEGRAM_API_URL", "https://api.telegram.org"),
  labels: new Set(
    env("ALERT_LABELS", "person")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ),
  minScore: Number(env("ALERT_MIN_SCORE", "0.7")),
  cooldownMs: Number(env("ALERT_COOLDOWN_SECONDS", "120")) * 1000,
  enableCommands: env("ENABLE_COMMANDS", "true") === "true",
};

// ---------- types ----------

interface FrigateObject {
  id: string;
  camera: string;
  label: string;
  top_score: number;
  false_positive: boolean;
  entered_zones: string[];
}

interface FrigateEvent {
  type: "new" | "update" | "end";
  before: FrigateObject;
  after: FrigateObject;
}

interface TelegramUpdate {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
}

// ---------- helpers ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tg = (method: string) => `${config.telegramApi}/bot${config.botToken}/${method}`;
const time = () => new Date().toLocaleTimeString("en-GB");

async function fetchJpeg(path: string): Promise<Blob | null> {
  try {
    const res = await fetch(`${config.frigateUrl}${path}`, { signal: AbortSignal.timeout(10_000) });
    return res.ok ? await res.blob() : null;
  } catch {
    return null;
  }
}

async function sendMessage(text: string): Promise<void> {
  const res = await fetch(tg("sendMessage"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: config.chatId, text }),
  });
  if (!res.ok) throw new Error(`sendMessage ${res.status}: ${await res.text()}`);
}

async function sendPhoto(photo: Blob, caption: string): Promise<void> {
  const form = new FormData();
  form.append("chat_id", config.chatId);
  form.append("caption", caption);
  form.append("photo", photo, "snapshot.jpg");
  const res = await fetch(tg("sendPhoto"), { method: "POST", body: form });
  if (!res.ok) throw new Error(`sendPhoto ${res.status}: ${await res.text()}`);
}

/** Send a photo if we have one, otherwise fall back to text. */
async function notify(photo: Blob | null, caption: string): Promise<void> {
  if (photo) await sendPhoto(photo, caption);
  else await sendMessage(caption);
}

// ---------- alerts (Frigate -> MQTT -> Telegram) ----------

const alertedEvents = new Set<string>();
const lastAlertAt = new Map<string, number>();

function shouldAlert(obj: FrigateObject): boolean {
  if (alertedEvents.has(obj.id)) return false;
  if (obj.false_positive) return false;
  if (!config.labels.has(obj.label)) return false;
  if (obj.top_score < config.minScore) return false;

  const key = `${obj.camera}:${obj.label}`;
  const last = lastAlertAt.get(key) ?? 0;
  if (Date.now() - last < config.cooldownMs) return false;

  lastAlertAt.set(key, Date.now());
  alertedEvents.add(obj.id);
  if (alertedEvents.size > 1000) alertedEvents.clear(); // keep memory bounded
  return true;
}

async function handleEvent(event: FrigateEvent): Promise<void> {
  if (event.type === "end") return;
  const obj = event.after;
  if (!shouldAlert(obj)) return;

  await sleep(1500); // give Frigate a moment to pick a good snapshot
  const photo =
    (await fetchJpeg(`/api/events/${obj.id}/snapshot.jpg?bbox=1`)) ??
    (await fetchJpeg(`/api/${obj.camera}/latest.jpg`));

  const zones = obj.entered_zones.length ? ` in ${obj.entered_zones.join(", ")}` : "";
  const caption = `🚨 ${obj.label} on ${obj.camera}${zones} (${Math.round(obj.top_score * 100)}%) at ${time()}`;
  await notify(photo, caption);
  console.log(`alert sent: ${caption}`);
}

function startAlerts(): void {
  const client = connect(config.mqttUrl, { reconnectPeriod: 5000 });

  client.on("connect", () => {
    console.log(`connected to MQTT at ${config.mqttUrl}`);
    client.subscribe("frigate/events");
  });
  client.on("error", (err) => console.error("MQTT error:", err.message));
  client.on("message", (_topic, payload) => {
    let event: FrigateEvent;
    try {
      event = JSON.parse(payload.toString()) as FrigateEvent;
    } catch {
      return;
    }
    handleEvent(event).catch((err) => console.error("alert failed:", err));
  });

  const shutdown = () => {
    client.end(true);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// ---------- commands (Telegram -> Frigate) ----------

async function listCameras(): Promise<string[]> {
  try {
    const res = await fetch(`${config.frigateUrl}/api/config`, { signal: AbortSignal.timeout(10_000) });
    const cfg = (await res.json()) as { cameras?: Record<string, unknown> };
    return Object.keys(cfg.cameras ?? {});
  } catch {
    return [];
  }
}

async function handleCommand(text: string): Promise<void> {
  const [rawCmd = "", arg] = text.split(/\s+/);
  const cmd = rawCmd.split("@")[0]; // strip /cmd@BotName

  switch (cmd) {
    case "/snap": {
      const cameras = await listCameras();
      const camera = arg ?? cameras[0];
      if (!camera) return sendMessage("No cameras found.");
      const photo = await fetchJpeg(`/api/${camera}/latest.jpg`);
      if (!photo) return sendMessage(`Couldn't get a snapshot from "${camera}".`);
      return sendPhoto(photo, `📷 ${camera} at ${time()}`);
    }
    case "/cameras": {
      const cameras = await listCameras();
      return sendMessage(cameras.length ? cameras.join("\n") : "No cameras found.");
    }
    case "/start":
    case "/help":
      return sendMessage("/snap [camera] - live snapshot\n/cameras - list cameras");
  }
}

async function pollCommands(): Promise<void> {
  let offset = 0;
  for (;;) {
    try {
      const res = await fetch(tg(`getUpdates?timeout=50&offset=${offset}`), {
        signal: AbortSignal.timeout(60_000),
      });
      const data = (await res.json()) as { ok: boolean; result?: TelegramUpdate[] };
      if (!data.ok) throw new Error(`getUpdates failed (is another app polling this bot?)`);

      for (const update of data.result ?? []) {
        offset = update.update_id + 1;
        const msg = update.message;
        // Only answer the configured chat - nobody else can pull snapshots.
        if (!msg?.text || String(msg.chat.id) !== config.chatId) continue;
        await handleCommand(msg.text.trim()).catch((err) => console.error("command failed:", err));
      }
    } catch (err) {
      console.error("polling error:", (err as Error).message);
      await sleep(5000);
    }
  }
}

// ---------- main ----------

startAlerts();
if (config.enableCommands) void pollCommands();
console.log(`notifier up - alerting on [${[...config.labels].join(", ")}]`);
