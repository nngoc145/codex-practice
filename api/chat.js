// Vercel serverless function to proxy NVIDIA API safely
// Env vars required: NVIDIA_API_KEY; optional: NVIDIA_MODEL, NVIDIA_ENDPOINT, CHAT_PASSWORD

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const getRequestOrigin = (req) => {
  const direct = req.headers.origin || "";
  if (direct) return direct;
  const ref = req.headers.referer || "";
  try {
    return ref ? new URL(ref).origin : "";
  } catch {
    return "";
  }
};

export default async function handler(req, res) {
  const origin = getRequestOrigin(req);
  const hasAllowlist = allowedOrigins.length > 0;
  const originAllowed = !hasAllowlist || allowedOrigins.includes(origin);

  // Strict CORS: only allow configured origins
  if (hasAllowlist && origin && originAllowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else if (hasAllowlist) {
    return res.status(403).json({ error: "Origin not allowed" });
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*"); // fallback if no allowlist set
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { message = "", system = "", password = "", apiKey: clientKey = "" } = req.body || {};

  const requiredPass = process.env.CHAT_PASSWORD || "";
  if (requiredPass && password !== requiredPass) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!message.trim()) {
    return res.status(400).json({ error: "message is required" });
  }

  const apiKey = clientKey.trim() || process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Missing NVIDIA_API_KEY" });
  }

  const model = process.env.NVIDIA_MODEL || "meta/llama-3.1-8b-instruct";
  const endpoint = process.env.NVIDIA_ENDPOINT || "https://integrate.api.nvidia.com/v1/chat/completions";

  const payload = {
    model,
    messages: [
      { role: "system", content: system || "" },
      { role: "user", content: message }
    ],
    temperature: 0.4,
    max_tokens: 500
  };

  try {
    const r = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({ error: text || "NVIDIA API error" });
    }
    const data = await r.json();
    const reply = data?.choices?.[0]?.message?.content || "";
    return res.status(200).json({ reply: reply || "(empty reply)" });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Proxy error" });
  }
}
