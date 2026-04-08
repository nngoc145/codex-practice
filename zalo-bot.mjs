import { Zalo, ThreadType } from "zca-js";
import fetch from "node-fetch";

const API_ENDPOINT = "https://codex-practice-ten.vercel.app/api/chat";
// Sử dụng chính API Key mà bạn đang dùng bên frontend
const DEFAULT_API_KEY = "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";

const zalo = new Zalo();

console.log("==========================================");
console.log("🕒 Đang khởi tạo kết nối với Server Zalo...");
console.log("📱 Một mã QR sẽ xuất hiện trên màn hình Terminal.");
console.log("   -> Vui lòng mở ứng dụng Zalo trên điện thoại quét mã QR!");
console.log("==========================================");

try {
  // Thực thi đăng nhập và in mã QR
  const api = await zalo.loginQR();
  
  console.log("\\n✅ Đăng nhập Zalo thành công!");
  
  // Sự kiện lắng nghe tin nhắn đến
  api.listener.on("message", async (message) => {
    // Chỉ đọc tin nhắn văn bản thuần túy
    const isPlainText = typeof message.data.content === "string";
    
    // Bỏ qua tin nhắn do chính bạn gửi ra, hoặc tin nhắn hình ảnh/âm thanh
    if (message.isSelf || !isPlainText) return;
    
    // Chỉ xử lý tin nhắn cá nhân (không xử lý trong Group)
    if (message.type === ThreadType.User) {
      const userMsg = message.data.content;
      console.log(`\\n📩 [ZALO] Khách nhắn: ${userMsg}`);
      
      try {
        console.log("🧠 Đang gửi câu hỏi cho AI Agent xử lý...");
        const res = await fetch(API_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Origin": "https://codex-practice-ten.vercel.app"
          },
          body: JSON.stringify({
            message: userMsg,
            apiKey: DEFAULT_API_KEY,
            role: "member"
          })
        });
        
        const data = await res.json();
        
        if (data.reply) {
          console.log(`🤖 [AI] Phản hồi: ${data.reply}`);
          
          // Gửi đoạn phản hồi về lại cửa sổ chat Zalo cá nhân đó
          api.sendMessage(
            { msg: data.reply },
            message.threadId, 
            message.type
          );
          console.log("📤 Đã tự động nhắn trả qua Zalo thành công!");
        } else {
          console.log("⚠️ Không nhận được phản hồi phù hợp từ AI.");
        }
      } catch (err) {
        console.error("❌ Lỗi khi giao tiếp với AI backend:", err.message);
      }
    }
  });

  // Khởi động trình lắng nghe
  api.listener.start();
  console.log("👂 Bot đã bật và đang chờ tin nhắn Zalo đến...");
  
} catch (error) {
  console.error("❌ Xảy ra lỗi ngoài dự kiến:", error);
}
