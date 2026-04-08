// Vercel serverless function to proxy NVIDIA API safely
// Env vars required: NVIDIA_API_KEY; optional: NVIDIA_MODEL, NVIDIA_ENDPOINT, CHAT_PASSWORD

const MAX_GUEST_PROMPTS = 3;
const WINDOW_MS = 60 * 60 * 1000; // 1 hour



// In-memory rate limiter bucket: clientId -> [timestamps]
const rateBucket = new Map();

const getClientId = (req) => {
  const ip =
    req.headers["cf-connecting-ip"] ||
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";
  return ip || "unknown";
};

const consumeQuotaIfGuest = (clientId, role) => {
  if (role !== "guest") return { allowed: true, remaining: null, resetAt: null };

  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const history = (rateBucket.get(clientId) || []).filter((t) => t > cutoff);

  if (history.length >= MAX_GUEST_PROMPTS) {
    const resetAt = new Date(history[0] + WINDOW_MS).toISOString();
    rateBucket.set(clientId, history); // keep pruned
    return { allowed: false, remaining: 0, resetAt };
  }

  history.push(now);
  rateBucket.set(clientId, history);
  return { allowed: true, remaining: MAX_GUEST_PROMPTS - history.length, resetAt: new Date(now + WINDOW_MS).toISOString() };
};

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

async function handler(req, res) {
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

  const { message = "", system = "", apiKey: clientKey = "", role = "guest" } = req.body || {};
  const clientId = getClientId(req);

  if (!message.trim()) {
    return res.status(400).json({ error: "message is required" });
  }

  const apiKey = clientKey.trim() || process.env.NVIDIA_API_KEY;
  const quota = consumeQuotaIfGuest(clientId, role);
  if (!quota.allowed) {
    return res.status(429).json({ error: "Rate limit: khách tối đa 3 prompt mỗi 60 phút.", remaining: 0, resetAt: quota.resetAt });
  }

  if (!apiKey) {
    // Không có key -> trả về phản hồi mock để demo, tránh lỗi 500 lặp lại
    const fallback = `Demo trả lời (không có NVIDIA_API_KEY):\n- Bạn hỏi: "${message}"\n- Thêm khóa bằng cách nhập apiKey trên giao diện hoặc đặt biến môi trường NVIDIA_API_KEY.`;
    return res.status(200).json({ reply: fallback, remaining: quota.remaining, resetAt: quota.resetAt });
  }

  const model = process.env.NVIDIA_MODEL || "meta/llama-3.1-8b-instruct";
  const endpoint = process.env.NVIDIA_ENDPOINT || "https://integrate.api.nvidia.com/v1/chat/completions";

  const payload = {
    model,
    messages: [
      { role: "system", content: system || "" },
      { role: "user", content: message }
    ],
    temperature: 0.7,
    max_tokens: 1500
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

module.exports = handler;
