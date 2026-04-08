const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const chatHandler = require('./api/chat.js');
const agsCheckHandler = require('./api/ags-check.js');

const { Zalo, ThreadType, LoginQRCallbackEventType } = require("zca-js");


let zaloStatus = 'stopped';
let zaloQrBase64 = '';
let isZaloStarting = false;
let zaloInstance = null;
let zaloLogs = [];

const addZaloLog = (msg) => {
  const timeStr = new Date().toLocaleTimeString('vi-VN');
  zaloLogs.push(`[${timeStr}] ${msg}`);
  if (zaloLogs.length > 50) zaloLogs.shift();
  console.log(`[ZALO BOT] ${msg}`);
};

const startZaloBot = async () => {
  if (isZaloStarting || zaloStatus === 'active') return;
  isZaloStarting = true;
  zaloStatus = 'starting';
  
  if (!zaloInstance) zaloInstance = new Zalo();

  try {
    const api = await zaloInstance.loginQR(
      { console: false }, 
      (event) => {
        if (event.type === LoginQRCallbackEventType.QRCodeGenerated) {
          zaloQrBase64 = event.data.image;
          zaloStatus = 'qr_ready';
        } else if (event.type === LoginQRCallbackEventType.QRCodeExpired) {
          zaloStatus = 'expired';
          isZaloStarting = false;
          event.actions.abort();
        } else if (event.type === LoginQRCallbackEventType.QRCodeScanned) {
          zaloStatus = 'scanned';
        } else if (event.type === LoginQRCallbackEventType.QRCodeDeclined) {
          zaloStatus = 'declined';
          isZaloStarting = false;
          event.actions.abort();
        } else if (event.type === LoginQRCallbackEventType.GotLoginInfo) {
          zaloStatus = 'active';
          isZaloStarting = false;
        }
      }
    );

    zaloStatus = 'active';
    isZaloStarting = false;
    addZaloLog("Đăng nhập Zalo thành công. Đang lắng nghe...");

    api.listener.on("message", async (message) => {
      const isPlainText = typeof message.data.content === "string";
      if (message.isSelf || !isPlainText) return;
      
      if (message.type === ThreadType.Group) {
        const userMsg = message.data.content;
        addZaloLog(`📩 Nhóm nhắn: ${userMsg}`);
        try {
          addZaloLog(`🧠 Đang nhờ AI xử lý...`);
          const res = await aIEndpoint(userMsg);
          if (res) {
            api.sendMessage({ msg: res }, message.threadId, message.type);
            addZaloLog(`🤖 Đã trả lời trong Group: ${res}`);
          } else {
             addZaloLog(`⚠️ AI không trả về kết quả.`);
          }
        } catch(e) { addZaloLog(`❌ Lỗi AI: ${e.message}`); }
      }
    });

    api.listener.start();
  } catch (error) {
    zaloStatus = 'error';
    isZaloStarting = false;
    addZaloLog(`❌ Lỗi hệ thống: ${error.message}`);
  }
};

async function aIEndpoint(message) {
  try {
    const payload = {
      model: "meta/llama-3.1-8b-instruct",
      messages: [
        { role: "system", content: "Bạn là một AI Agent thông minh. Hãy trả lời ngắn gọn, trực tiếp, xưng 'tôi' và gọi người dùng là 'bạn'." },
        { role: "user", content: message }
      ],
      temperature: 0.7,
      max_tokens: 1500
    };

    const r = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer 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"
      },
      body: JSON.stringify(payload)
    });
    
    if (!r.ok) {
        const text = await r.text();
        addZaloLog(`❌ Lỗi API NVIDIA: ${r.status} - ${text}`);
        return null;
    }
    const d = await r.json();
    return d.choices?.[0]?.message?.content || null;
  } catch(e){ 
    addZaloLog(`❌ Lỗi Fetch: ${e.message}`);
    return null; 
  }
}

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

const sendJson = (res, statusCode, payload) => {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
};

const serveStatic = (pathname, res) => {
  const safePath = pathname === '/' ? '/zalo.html' : pathname;
  const filePath = path.join(ROOT, safePath.replace(/^\/+/, ''));

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
};

const createResShim = (res) => {
  return {
    status(code) {
      res.statusCode = code;
      return this;
    },
    json(payload) {
      sendJson(res, res.statusCode || 200, payload);
    },
    setHeader(...args) {
      res.setHeader(...args);
    },
    end(...args) {
      res.end(...args);
    }
  };
};

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname || '/';

  if (pathname === '/api/zalo-start' && req.method === 'POST') {
    startZaloBot();
    return sendJson(res, 200, { success: true });
  }

  if (pathname === '/api/zalo-logout' && req.method === 'POST') {
    zaloStatus = 'stopped';
    zaloQrBase64 = '';
    zaloLogs = ['[Hệ thống] Cán bộ đã đăng xuất. Vui lòng quét mã QR mới.'];
    return sendJson(res, 200, { success: true });
  }

  if (pathname === '/api/zalo-logs') {
    return sendJson(res, 200, { logs: zaloLogs });
  }

  if (pathname === '/api/zalo-status') {
    return sendJson(res, 200, { status: zaloStatus, qrBase64: zaloQrBase64 });
  }

  // Public health check
  if (pathname === '/ags-check') {
    const resShim = createResShim(res);
    return agsCheckHandler(req, resShim);
  }

  if (pathname === '/api/chat') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      let parsed = {};
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch (err) {
        return sendJson(res, 400, { error: 'Invalid JSON' });
      }

      // Attach body directly to the original request object so headers/origin stay intact
      req.body = parsed;
      const resShim = createResShim(res);
      chatHandler(req, resShim);
    });
    return;
  }

  serveStatic(pathname, res);
});

const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`Local server running at http://${HOST}:${PORT}`);
});
