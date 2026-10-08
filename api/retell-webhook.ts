import { verify } from "retell-sdk";

// Webhook Retell : ne traite que `call_analyzed`, envoie le résumé sur Telegram.
// Doc : https://docs.retellai.com/features/webhook-overview
//       https://docs.retellai.com/features/secure-webhook

type CustomData = Record<string, unknown>;

interface RetellCall {
  call_id?: string;
  duration_ms?: number;
  // Métadonnées posées à la création de l'appel (ex. { demo: "serrurier" } pour les démos du site).
  metadata?: Record<string, unknown>;
  call_analysis?: { custom_analysis_data?: CustomData; call_summary?: string };
}

interface RetellWebhookBody {
  event?: string;
  call?: RetellCall;
}

// Libellés des démos publiques (métadonnée `demo`) ; une valeur inconnue est affichée telle quelle.
const DEMO_LABELS: Record<string, string> = {
  serrurier: "Serrurier",
  veterinaire: "Vétérinaire",
  generique: "Plomberie",
  dental: "Dental clinic",
  realestate: "Real estate",
  legal: "Law firm",
};

const TELEGRAM_TIMEOUT_MS = 3000; // Retell attend 5 s (réglage dashboard) à 10 s (doc)
const TELEGRAM_MAX_LENGTH = 4096;

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const asString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : value == null ? "" : String(value);

// Retell peut renvoyer un booléen ou une chaîne selon le type de champ configuré.
const asBoolean = (value: unknown): boolean => {
  if (typeof value === "boolean") return value;
  return ["true", "oui", "yes", "1"].includes(asString(value).toLowerCase());
};

function buildMessage(data: CustomData, call: RetellCall = {}): string {
  const priority = asBoolean(data.rappel_prioritaire);
  // 🔴 priority callback; 📞 otherwise.
  const emoji = priority ? "🔴" : "📞";

  let text = asString(data.sms_patron);
  if (!text) {
    // Repli si l'analyse n'a pas produit de sms_patron.
    text = [
      data.type_demande,
      data.produit,
      data.mode,
      data.nom,
      data.telephone,
      data.adresse,
      data.date_souhaitee,
    ]
      .map(asString)
      .filter(Boolean)
      .join(" | ");
  }
  if (!text) {
    // Jamais de message réduit à un emoji : résumé Retell, sinon constat explicite.
    const summary = asString(call.call_analysis?.call_summary).slice(0, 300);
    const seconds = call.duration_ms ? Math.round(call.duration_ms / 1000) : 0;
    text = summary || `Appel terminé sans demande exploitable${seconds ? ` (${seconds} s)` : ""}.`;
  }

  // Démos publiques du site : on indique laquelle (métadonnée posée par le site).
  const demo = asString(call.metadata?.demo);
  const label = /^[a-z0-9-]{1,30}$/.test(demo) ? `[${DEMO_LABELS[demo] ?? demo}] ` : "";
  return `${emoji} ${label}${text}`.slice(0, TELEGRAM_MAX_LENGTH);
}

async function sendTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    throw new Error("TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID manquant");
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Telegram HTTP ${res.status}: ${await res.text()}`);
  }
}

export async function POST(request: Request): Promise<Response> {
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) {
    console.error("RETELL_API_KEY manquant");
    return json(500, { error: "server_misconfigured" });
  }

  // Corps brut obligatoire pour la signature (pas de JSON.stringify du body parsé).
  const rawBody = await request.text();
  const signature = request.headers.get("x-retell-signature");

  let valid = false;
  try {
    valid = !!signature && (await verify(rawBody, apiKey, signature));
  } catch (err) {
    console.error("Erreur de vérification de signature", err);
  }
  if (!valid) {
    console.warn("Signature Retell invalide ou absente");
    return json(401, { error: "invalid_signature" });
  }

  let payload: RetellWebhookBody;
  try {
    payload = JSON.parse(rawBody) as RetellWebhookBody;
  } catch {
    return json(400, { error: "invalid_json" });
  }

  if (payload.event !== "call_analyzed") {
    return json(200, { ok: true, ignored: payload.event ?? null });
  }

  const callId = payload.call?.call_id;
  const data = payload.call?.call_analysis?.custom_analysis_data;
  if (!data) {
    console.warn(`call_analyzed sans custom_analysis_data (call_id=${callId})`);
    return json(200, { ok: true, skipped: "no_custom_analysis_data" });
  }

  try {
    await sendTelegram(buildMessage(data, payload.call));
  } catch (err) {
    // On répond 200 quand même pour éviter les retries Retell.
    console.error(`Échec Telegram (call_id=${callId})`, err);
  }
  return json(200, { ok: true });
}
