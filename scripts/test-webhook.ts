// Simule un webhook Retell `call_analyzed` signé et l'envoie au handler.
//   npm run test:local             -> Telegram simulé (aucun message envoyé)
//   npm run test:local -- --live   -> envoie réellement sur Telegram (.env requis)
//   npm run test:local -- --url http://localhost:3000/api/retell-webhook
//     -> appelle un `vercel dev` en cours (mêmes clés que le .env chargé)
import { sign } from "retell-sdk";
import { POST } from "../api/retell-webhook";

const live = process.argv.includes("--live");
// npm avale `--url` (option npm) : on accepte aussi l'URL seule en argument.
const urlIdx = process.argv.indexOf("--url");
const url =
  urlIdx > -1
    ? process.argv[urlIdx + 1]
    : process.argv.find((arg) => /^https?:\/\//.test(arg));

if (live || url) {
  try {
    process.loadEnvFile(".env");
  } catch {
    console.warn("Pas de fichier .env, utilisation des variables d'environnement");
  }
} else {
  process.env.RETELL_API_KEY ||= "key_test_local";
  process.env.TELEGRAM_BOT_TOKEN ||= "123456:TEST";
  process.env.TELEGRAM_CHAT_ID ||= "999";
}
const apiKey = process.env.RETELL_API_KEY;
if (!apiKey) throw new Error("RETELL_API_KEY manquant");

const baseCall = {
  call_type: "phone_call",
  call_id: "call_test_0123456789abcdef",
  agent_id: "agent_test_123",
  call_status: "ended",
  direction: "inbound",
  from_number: "+32470123456",
  to_number: "+3225551234",
  start_timestamp: 1760000000000,
  end_timestamp: 1760000095000,
  duration_ms: 95000,
  disconnection_reason: "user_hangup",
  transcript: "Agent: Bonjour, assistant automatique de l'Entreprise Exemple...",
  call_analysis: {
    call_summary: "Le client souhaite 2 articles livrés.",
    user_sentiment: "Neutral",
    call_successful: true,
    in_voicemail: false,
    custom_analysis_data: {
      type_demande: "commande",
      nom: "Jean Dupont",
      telephone: "+32470123456",
      produit: "produit standard",
      mode: "livraison",
      adresse: "Rue des Tilleuls 5, 1400 Nivelles",
      date_souhaitee: "semaine prochaine",
      rappel_prioritaire: false,
      sms_patron:
        "Commande : Jean Dupont (+32470123456) - 2 articles, livraison Nivelles, semaine prochaine. À rappeler.",
    },
  },
};

const withData = (callId: string, extra: Record<string, unknown>) => ({
  ...baseCall,
  call_id: callId,
  call_analysis: {
    ...baseCall.call_analysis,
    custom_analysis_data: { ...baseCall.call_analysis.custom_analysis_data, ...extra },
  },
});

const scenarios: { label: string; expect: string; includes?: string[]; excludes?: string[]; call: any }[] = [
  { label: "demande standard", expect: "📞", call: baseCall },
  {
    label: "rappel prioritaire",
    expect: "🔴",
    call: withData("call_test_prio", {
      rappel_prioritaire: true,
      sms_patron: "URGENT : client sans chauffage, rappeler vite (+32470123456).",
    }),
  },
  {
    label: "démo serrurier",
    expect: "📞",
    includes: ["[Serrurier]", "Porte claquée"],
    call: {
      ...withData("call_test_serrurier", {
        type_demande: "dépannage",
        produit: "porte claquée",
        sms_patron: "Porte claquée chez Marie D., rappeler vite.",
      }),
      metadata: { source: "demo-site", demo: "serrurier" },
    },
  },
  {
    label: "extraction vide : jamais un message réduit à l'emoji",
    expect: "📞",
    includes: ["[Vétérinaire]", "sans demande exploitable", "12 s"],
    call: {
      ...baseCall,
      call_id: "call_test_vide",
      // extraction vide ET aucun résumé Retell : le message doit constater l'absence de demande
      call_analysis: {
        custom_analysis_data: {
          type_demande: "", nom: "", telephone: "", produit: "", mode: "", adresse: "", date_souhaitee: "",
          rappel_prioritaire: false, sms_patron: "",
        },
      },
      duration_ms: 12000,
      metadata: { demo: "veterinaire" },
    },
  },
  {
    label: "extraction vide avec résumé Retell",
    expect: "📞",
    includes: ["Le client a raccroché avant de donner sa demande."],
    call: {
      ...withData("call_test_resume", { type_demande: "", nom: "", produit: "", sms_patron: "" }),
      call_analysis: {
        call_summary: "Le client a raccroché avant de donner sa demande.",
        custom_analysis_data: { type_demande: "", nom: "", produit: "", sms_patron: "" },
      },
    },
  },
  {
    label: "métadonnée demo inconnue : affichée telle quelle, sans injection",
    expect: "📞",
    includes: ["[clinic-en]"],
    call: {
      ...withData("call_test_meta", { type_demande: "rendez-vous", produit: "consultation", sms_patron: "New patient request." }),
      metadata: { demo: "clinic-en" },
    },
  },
  {
    label: "métadonnée demo invalide : ignorée",
    expect: "📞",
    excludes: ["<b>", "["],
    call: {
      ...withData("call_test_meta2", { type_demande: "rendez-vous", produit: "consultation", sms_patron: "Demande simple." }),
      metadata: { demo: "<b>x</b>" },
    },
  },
];

const realFetch = globalThis.fetch;
let sent: string[] = [];
const mockTelegram = (status: number) => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith("https://api.telegram.org/")) {
      sent.push(JSON.parse(String(init?.body)).text);
      return new Response(status === 200 ? '{"ok":true}' : "boom", { status });
    }
    return realFetch(input, init);
  }) as typeof fetch;
};
const simulated = !live && !url;
if (simulated) mockTelegram(200);

async function call(body: string, signature?: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature) headers["x-retell-signature"] = signature;
  const req = new Request(url ?? "http://localhost/api/retell-webhook", {
    method: "POST",
    headers,
    body,
  });
  return url ? realFetch(req) : POST(req);
}

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? " - " + detail : ""}`);
};

for (const s of scenarios) {
  sent = [];
  const body = JSON.stringify({ event: "call_analyzed", call: s.call });
  const res = await call(body, await sign(body, apiKey));
  check(`${s.label}: HTTP 200`, res.status === 200, String(res.status));
  if (simulated) {
    check(`${s.label}: préfixe ${s.expect}`, sent[0]?.startsWith(s.expect) ?? false, sent[0]);
    for (const part of s.includes ?? []) check(`${s.label}: contient « ${part} »`, sent[0]?.includes(part) ?? false);
    for (const part of s.excludes ?? []) check(`${s.label}: ne contient pas « ${part} »`, !(sent[0]?.includes(part) ?? true));
    check(`${s.label}: pas un message réduit à l'emoji`, (sent[0]?.replace(/^\S+\s*/, "").trim().length ?? 0) > 0);
  }
}

{
  sent = [];
  const body = JSON.stringify({ event: "call_ended", call: baseCall });
  const res = await call(body, await sign(body, apiKey));
  check(
    "call_ended ignoré (200, rien envoyé)",
    res.status === 200 && (!simulated || sent.length === 0),
  );
}
{
  const body = JSON.stringify({ event: "call_analyzed", call: baseCall });
  const none = await call(body);
  check("sans signature -> 401", none.status === 401, String(none.status));
  const bad = await call(body, await sign(body, "autre_cle"));
  check("mauvaise clé -> 401", bad.status === 401, String(bad.status));
  const tampered = await call(body + " ", await sign(body, apiKey));
  check("corps modifié -> 401", tampered.status === 401, String(tampered.status));
}
if (simulated) {
  mockTelegram(500);
  const body = JSON.stringify({ event: "call_analyzed", call: baseCall });
  const res = await call(body, await sign(body, apiKey));
  check("Telegram en erreur -> 200 quand même", res.status === 200, String(res.status));
}

process.exit(failures ? 1 : 0);
