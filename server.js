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

const chatHistories = new Map();
const activeSessions = new Map(); // [threadId_senderId] -> timestamp
const MAX_HISTORY_LENGTH = 10;

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
      // Cho phép cả tin nhắn hình ảnh
      if (message.isSelf) return;
      
      if (message.type === ThreadType.Group) {
        let userMsgStr = "";
        let photoUrl = "";

        if (typeof message.data.content === "string") {
            userMsgStr = message.data.content;
        } else if (message.data.content && typeof message.data.content === "object" && message.data.content.href) {
            photoUrl = message.data.content.href;
            // Nếu có text đi kèm khi gửi ảnh thì nó nằm trong description hoặc msg
            if (message.data.content.description) userMsgStr = message.data.content.description;
        }

        // Kiểm tra Session và Gọi Tên
        const lowerMsg = String(userMsgStr).toLowerCase();
        const keywordPattern = /\b(baby health|bé heo|be heo|heo|bé|be)\b/u;
        const sessionKey = `${message.threadId}_${message.senderId}`;
        const now = Date.now();
        let isTargeted = false;

        if (keywordPattern.test(lowerMsg)) {
            isTargeted = true; // Gọi tên trực tiếp bằng từ khóa
        } else {
             // Không gọi tên nhưng có Session còn hạn (5 phút)
            const lastActive = activeSessions.get(sessionKey);
            if (lastActive && (now - lastActive < 5 * 60 * 1000)) {
                isTargeted = true;
            }
        }

        if (!isTargeted) {
          return; // Bỏ qua nếu không gọi tên và không đang chat dở
        }

        // Cập nhật lại thời gian Session để duy trì mạch chat
        activeSessions.set(sessionKey, now);

        let senderName = "cô chú";
        try {
           const userInfoRes = await api.getUserInfo(message.senderId);
           const pInfo = userInfoRes?.changed_profiles?.[message.senderId] || userInfoRes?.[message.senderId];
           if (pInfo) {
              const name = pInfo.displayName || pInfo.name || pInfo.zaloName || "người lạ";
              const prefix = pInfo.gender === 0 ? "Chú" : "Cô";
              senderName = `${prefix} ${name}`;
           }
        } catch(e) { }

        addZaloLog(`📩 ${senderName} nhắn: ${userMsgStr || '[Ảnh đính kèm]'}`);
        try {
          addZaloLog(`🧠 Đang nhờ AI xử lý...`);
          // Chỉ cung cấp tên người chat làm ngữ cảnh, không ép máy phải nói "Chào..."
          const msgWithContext = `[Hệ thống chú thích: Người đang chat tên là ${senderName}]. Nội dung: ${userMsgStr}`;
          const res = await aIEndpoint(msgWithContext, photoUrl, message.threadId);
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

async function aIEndpoint(messageText, photoUrl, threadId) {
  try {
    // Lấy lịch sử cũ của phòng chat này
    const history = chatHistories.get(threadId) || [];
    
    // Đẩy content dạng Multi-modal nếu có ảnh
    let contentArr = [];
    if (messageText) contentArr.push({ type: "text", text: messageText });
    if (photoUrl) contentArr.push({ type: "image_url", image_url: { url: photoUrl } });
    
    history.push({ role: "user", content: contentArr.length > 0 ? contentArr : messageText });

    // Cấu trúc nội dung trò chuyện (Prompt)
    const payload = {
      model: "meta/llama-3.2-90b-vision-instruct", // Nâng model lên 90 tỉ Vision
      messages: [
        { 
          role: "system", 
          content: "Bạn đóng vai 'Bé Heo', AI ngộ nghĩnh, hài hước. Gọi người chat bằng ĐÚNG TÊN CỦA HỌ (trong ngoặc vuông đầu tin). LƯU Ý: CHỈ chào khi bắt đầu hội thoại, TUYỆT ĐỐI KHÔNG chào liên tục ở các câu tiếp theo. Nếu khách hàng gửi ẢNH XÉT NGHIỆM/ĐƠN THUỐC: Bạn TÓM TẮT sơ bộ các dòng có chữ khác thường, và BẮT BUỘC phải KHUYÊN người bệnh trực tiếp chụp gửi hoặc mang đến phòng khám của Bác Sĩ Ngọc để xin chẩn đoán chính xác nhất, tuyệt đối AI KHÔNG tự ý chẩn đoán y khoa. Dùng icon 🐷, ✨." 
        },
        ...history // Chèn lịch sử liên tục 
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
    const replyBot = d.choices?.[0]?.message?.content || null;
    
    if (replyBot) {
        // Lưu câu trả lời của AI vào bộ nhớ lịch sử
        history.push({ role: "assistant", content: replyBot });
        
        // Quét dọn bộ nhớ nếu quá dài (> 10 tin nhắn) để chống tốn tài nguyên
        if (history.length > MAX_HISTORY_LENGTH) {
            history.splice(0, history.length - MAX_HISTORY_LENGTH);
        }
        chatHistories.set(threadId, history);
    }

    return replyBot;
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
