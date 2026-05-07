/**
 * Wiom AI booking-assistant — ephemeral-token broker for OpenAI Realtime API.
 *
 * The browser cannot hold the OpenAI API key. This Worker mints a short-lived
 * client_secret that the browser uses ONLY for one WebRTC SDP handshake with
 * api.openai.com/v1/realtime. The secret expires in ~60s and grants access to
 * one session — safe to ship to the browser.
 *
 * Voice agent prompt + tool spec are sourced verbatim from the reference
 * Wiom prototype:
 *   https://github.com/ryangerardwilson/wiom-customer-location-prototype
 *   (backend/lib/address-agent.js — buildAddressAgentInstructions, submitAddressPacketTool)
 *
 * Secrets (set via `wrangler secret put`):
 *   OPENAI_API_KEY     — sk-... (required)
 *   ALLOWED_ORIGINS    — comma-separated list of origins allowed to call this
 *                        worker. Defaults to "*". Tighten for production.
 */

const MODEL = "gpt-realtime"; // Hinglish-friendly OpenAI Realtime
const VOICE = "alloy";        // matches the reference prototype

/* Tool spec — verbatim from address-agent.js */
const submitAddressPacketTool = {
  type: "function",
  name: "submit_address_packet",
  description: "Submit the completed install-address verification packet.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      typed_address: {
        type: "string",
        description: "The full address originally provided by the app.",
      },
      confirmed_landmark: {
        type: "string",
        description:
          "The landmark already confirmed by the app, OR the landmark captured during this voice call when the app did not pre-confirm one.",
      },
      is_currently_at_home: {
        type: "boolean",
        description:
          "True only when the customer explicitly confirms they are currently at home.",
      },
      floor: {
        type: "string",
        enum: ["", "Ground floor", "1st floor", "2nd floor", "3rd floor+"],
      },
      building_color: {
        type: "string",
        description:
          "Building/house/front-side color or closest useful visual description.",
      },
      customer_direction: {
        type: "string",
        description:
          "Practical direction note from the customer to help find the home.",
      },
      missing_fields: {
        type: "array",
        items: { type: "string" },
        description: "Any unresolved fields at submission time.",
      },
      confidence: {
        type: "string",
        enum: ["low", "medium", "high"],
      },
    },
    required: [
      "typed_address",
      "confirmed_landmark",
      "is_currently_at_home",
      "floor",
      "building_color",
      "customer_direction",
      "missing_fields",
      "confidence",
    ],
  },
};

/* System prompt — adapted from buildAddressAgentInstructions() in
   address-agent.js, with two adaptations for v5:
   1. We don't have GPS / serviceable city — just the typed address.
   2. We support a D2 variant where the landmark was NOT pre-confirmed by
      the form, so the AI must capture it during the call. This adds one
      conditional rule; everything else is verbatim. */
function buildInstructions({ variant, typedAddress, confirmedLandmark }) {
  const ta = typedAddress || "not provided";
  const cl = confirmedLandmark || "not provided";

  const landmarkVariantBlock =
    variant === "D2" || !confirmedLandmark
      ? `Variant note: confirmed_landmark was NOT pre-confirmed by the app. Before asking for direction, ask the customer once for a nearby identifiable landmark (mandir, school, hospital, bank, petrol pump, mall etc.) and capture their words as confirmed_landmark in the final tool call.`
      : `Variant note: confirmed_landmark is pre-confirmed by the app — do not ask the customer to restate it.`;

  return `
You are Wiom's Hinglish home-verification voice agent.

Goal:
Verify the typed install-address packet without trying to recapture the full
address by voice. The app already collected the precise address and landmark.
Your call must confirm only:
1. whether the customer is currently at home
2. the customer's floor
3. the building color
4. practical directions that help a technician find the home from the landmark
   or nearby road

Known app context:
- Typed full address from app: ${ta}
- Confirmed landmark from app: ${cl}

${landmarkVariantBlock}

Required verification fields:
- is_currently_at_home: true only after the customer explicitly says they are
  currently at home / wahi ghar par hain
- floor: ground floor, 1st floor, 2nd floor, or 3rd floor+
- building_color: color of the building/house/front side, in the customer's own words
- customer_direction: a practical direction note from a road/turn/landmark to
  the home, in the customer's own words

Conversation rules:
- Speak in simple Hinglish.
- Speak loudly, slowly, and clearly, like a phone support agent.
- Opening line must be exactly: "Kya aap abhi isi ghar par hain?"
- Do not say any prefix before the opening line. Never start with "Bilkul",
  "Theek hai", "Namaste", "Hello", or "Haan".
- If the customer is not currently at home, this is a blocker. Do not ask floor
  or directions. Say: "Ye step ghar par hoke complete karna zaroori hai." Then
  call the tool with is_currently_at_home=false and missing_fields containing
  "currently_at_home".
- Never ask the customer to repeat the full address.
- Never replace, rewrite, or infer the typed full address from speech.
- Never ask them to restate the confirmed landmark unless you need to phrase the
  direction question around it.
- If the customer is currently at home, ask for floor if not already provided
  in the answer.
- Ask for building color as a short nudge: "Building ka color kya hai?"
- If the user says the color is mixed, faded, or not sure, capture the closest
  useful description in their own words.
- Then ask for a practical direction note. The direction must help a technician
  find the door, e.g. "Jharsa Road se pehle right lo, mandir dikhega, mera ghar
  mandir ke bagal mein hai."
- If the customer gives a vague direction like "landmark ke paas hai", ask once
  for more specific turn/gali/door-facing detail.
- Ask one short follow-up at a time.
- Do not explain the process unless the customer asks.
- Match the customer's spoken language/register. If the customer speaks mostly
  Hindi, answer in Hindi/Hinglish. If the customer speaks English, answer in
  English. If they mix, mirror the mix.
- Speak numbers in the same language/register the customer is using. Examples:
  if the customer says "sector saintis" or "sector saintees", say "saintis";
  if they say "sector thirty seven", say "thirty seven"; if they say "plot
  pandrah sau chauvan", say the number back that way, not as English digits.
- Do not ask for fields already provided in this call.
- Floor is required if and only if is_currently_at_home=true.
- Building color is required if and only if is_currently_at_home=true.
- Customer direction is required if and only if is_currently_at_home=true.
- When required verification fields are complete, summarize only the verification
  facts, not the full address: "Aap abhi ghar par hain, floor ___ hai, building
  color ___ hai, aur direction ___ hai. Sahi?"
- Do not call the submit_address_packet tool until the customer confirms by
  voice with a clear yes/haan/sahi/confirm/ok.
- If the customer corrects floor, building color, or direction during
  confirmation, update it, summarize again, and ask for confirmation again.
- After confirmation, say one short closing line like "Theek hai, verification
  ho gaya" and then call the submit_address_packet tool.

Completion criteria:
- If customer is not currently at home: immediately submit blocker result with
  is_currently_at_home=false.
- If customer is currently at home: floor is present, building_color is present,
  customer_direction is present, and customer has explicitly confirmed the
  spoken verification summary.

Do not claim serviceability is approved. Only say that details are ready for
serviceability check.
`.trim();
}

function corsHeaders(origin, allowed) {
  const allowAll = !allowed || allowed === "*";
  const allowList = allowAll ? null : allowed.split(",").map((s) => s.trim());
  const allowedOrigin =
    allowAll ? "*" : (origin && allowList.includes(origin)) ? origin : allowList[0] || "*";
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env.ALLOWED_ORIGINS);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, model: MODEL }), {
        headers: { "Content-Type": "application/json", ...cors },
      });
    }

    if (req.method !== "POST" || url.pathname !== "/token") {
      return new Response("Not found", { status: 404, headers: cors });
    }

    if (!env.OPENAI_API_KEY) {
      return new Response(JSON.stringify({ error: "OPENAI_API_KEY not configured on worker" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...cors },
      });
    }

    let body = {};
    try { body = await req.json(); } catch (_) {}
    const variant = body.variant === "D1" ? "D1" : "D2";
    const typedAddress = typeof body.address === "string" ? body.address.slice(0, 240) : "";
    const confirmedLandmark = typeof body.landmark === "string" ? body.landmark.slice(0, 120) : "";

    const instructions = buildInstructions({ variant, typedAddress, confirmedLandmark });

    /* Session config — values mirror address-agent.js buildRealtimeSessionConfig. */
    const sessionConfig = {
      model: MODEL,
      voice: VOICE,
      instructions,
      modalities: ["audio", "text"],
      input_audio_transcription: {
        model: "gpt-4o-mini-transcribe",
        language: "hi",
      },
      turn_detection: {
        type: "server_vad",
        threshold: 0.78,
        prefix_padding_ms: 450,
        silence_duration_ms: 850,
        interrupt_response: false,
        create_response: true,
      },
      tools: [submitAddressPacketTool],
      tool_choice: "auto",
    };

    const r = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(sessionConfig),
    });

    const text = await r.text();
    return new Response(text, {
      status: r.status,
      headers: { "Content-Type": "application/json", ...cors },
    });
  },
};
