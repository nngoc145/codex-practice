import json
import mimetypes
import os
import shutil
import subprocess
import threading
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from imageio_ffmpeg import get_ffmpeg_exe
from yt_dlp import YoutubeDL


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
DOWNLOADS_DIR = DATA_DIR / "downloads"
FRAMES_DIR = DATA_DIR / "frames"

for directory in (DATA_DIR, DOWNLOADS_DIR, FRAMES_DIR):
    directory.mkdir(parents=True, exist_ok=True)


STATE_LOCK = threading.Lock()
STATE = {
    "jobs": [],
    "latest_job_id": None,
}


HTML_PAGE = """<!DOCTYPE html>
<html lang="vi">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Video Snapshot Explorer</title>
    <style>
      :root {
        --bg: #f5efe6;
        --panel: #fffaf3;
        --ink: #1f2937;
        --muted: #6b7280;
        --line: #e8d8c3;
        --accent: #bd5d2e;
        --accent-dark: #7f3417;
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        font-family: Georgia, "Times New Roman", serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(189, 93, 46, 0.16), transparent 30%),
          linear-gradient(180deg, #fff9f1 0%, var(--bg) 100%);
      }

      .shell {
        width: min(1100px, calc(100% - 32px));
        margin: 32px auto 56px;
      }

      .hero,
      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 24px;
        box-shadow: 0 18px 40px rgba(100, 54, 23, 0.08);
      }

      .hero {
        padding: 32px;
        margin-bottom: 20px;
      }

      h1 {
        margin: 0 0 10px;
        font-size: clamp(2rem, 4vw, 3.5rem);
        line-height: 1;
      }

      p {
        margin: 0;
        color: var(--muted);
        font-size: 1.05rem;
        line-height: 1.7;
      }

      form {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 12px;
        margin-top: 24px;
      }

      input {
        width: 100%;
        padding: 16px 18px;
        border-radius: 16px;
        border: 1px solid var(--line);
        font: inherit;
        background: #fff;
      }

      button {
        border: 0;
        border-radius: 16px;
        padding: 16px 22px;
        font: inherit;
        font-weight: 700;
        color: #fff;
        background: linear-gradient(135deg, var(--accent), var(--accent-dark));
        cursor: pointer;
      }

      .panel {
        padding: 24px;
      }

      .status {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border-radius: 999px;
        background: #fff;
        border: 1px solid var(--line);
        color: var(--muted);
        font-size: 0.95rem;
      }

      .layout {
        display: grid;
        grid-template-columns: 1.35fr 0.9fr;
        gap: 24px;
        margin-top: 18px;
      }

      .video-wrap {
        background: #120d0a;
        border-radius: 18px;
        overflow: hidden;
        min-height: 320px;
      }

      video {
        width: 100%;
        display: block;
        background: #120d0a;
      }

      .empty {
        display: grid;
        place-items: center;
        min-height: 320px;
        padding: 24px;
        text-align: center;
        color: #ccb8a1;
      }

      .meta {
        display: grid;
        gap: 12px;
        align-content: start;
      }

      .card {
        background: #fff;
        border: 1px solid var(--line);
        border-radius: 18px;
        padding: 16px;
      }

      .card h2 {
        margin: 0 0 8px;
        font-size: 1rem;
      }

      .poster-grid {
        margin-top: 20px;
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
        gap: 14px;
      }

      .poster {
        background: #fff;
        border: 1px solid var(--line);
        border-radius: 18px;
        overflow: hidden;
        cursor: pointer;
      }

      .poster img {
        display: block;
        width: 100%;
        aspect-ratio: 16 / 9;
        object-fit: cover;
      }

      .poster span {
        display: block;
        padding: 10px 12px 12px;
        font-size: 0.95rem;
        color: var(--ink);
      }

      .muted {
        color: var(--muted);
      }

      @media (max-width: 860px) {
        form,
        .layout {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <section class="hero">
        <h1>Video Snapshot Explorer</h1>
        <p>
          Nhập URL video YouTube hoặc TikTok. Backend sẽ tải video, trích poster mỗi 10 giây,
          rồi hiển thị player để bạn nhảy nhanh tới từng đoạn bằng poster tương ứng.
        </p>
        <form id="download-form">
          <input
            id="video-url"
            name="url"
            type="url"
            placeholder="Dán URL YouTube hoặc TikTok vào đây"
            required
          />
          <button type="submit">Tải Và Phân Tích</button>
        </form>
      </section>

      <section class="panel">
        <div class="status" id="status-pill">Chưa có job nào.</div>
        <div class="layout">
          <div class="video-wrap" id="player-shell">
            <div class="empty">Chưa có video. Hãy submit một URL để bắt đầu.</div>
          </div>
          <div class="meta" id="meta-shell">
            <div class="card">
              <h2>Thông tin xử lý</h2>
              <div class="muted" id="job-summary">Đang chờ tải dữ liệu.</div>
            </div>
          </div>
        </div>
        <div class="poster-grid" id="poster-grid"></div>
      </section>
    </div>

    <script>
      const form = document.getElementById("download-form");
      const urlInput = document.getElementById("video-url");
      const statusPill = document.getElementById("status-pill");
      const playerShell = document.getElementById("player-shell");
      const metaShell = document.getElementById("meta-shell");
      const summary = document.getElementById("job-summary");
      const posterGrid = document.getElementById("poster-grid");

      let currentJobId = null;
      let pollTimer = null;
      let currentVideo = null;

      function formatTime(seconds) {
        const total = Math.max(0, Math.floor(seconds || 0));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
        return `${m}:${String(s).padStart(2, "0")}`;
      }

      function setStatus(text) {
        statusPill.textContent = text;
      }

      function renderJob(job) {
        if (!job) {
          setStatus("Chưa có job nào.");
          summary.textContent = "Đang chờ tải dữ liệu.";
          metaShell.innerHTML = `
            <div class="card">
              <h2>Thông tin xử lý</h2>
              <div class="muted">Đang chờ tải dữ liệu.</div>
            </div>
          `;
          playerShell.innerHTML = '<div class="empty">Chưa có video. Hãy submit một URL để bắt đầu.</div>';
          posterGrid.innerHTML = "";
          return;
        }

        setStatus(`Trạng thái: ${job.status}`);

        const safeTitle = job.title || "Chưa có tiêu đề";
        summary.textContent = `${safeTitle} · ${job.frames.length} poster · ${job.status}`;

        metaShell.innerHTML = `
          <div class="card">
            <h2>Thông tin xử lý</h2>
            <div class="muted"><strong>URL:</strong> ${job.source_url}</div>
            <div class="muted"><strong>Tiêu đề:</strong> ${safeTitle}</div>
            <div class="muted"><strong>Thời lượng:</strong> ${formatTime(job.duration)}</div>
            <div class="muted"><strong>Poster:</strong> ${job.frames.length} ảnh</div>
            <div class="muted"><strong>Job ID:</strong> ${job.id}</div>
            <div class="muted"><strong>Thông báo:</strong> ${job.message}</div>
          </div>
        `;

        if (job.video_url) {
          playerShell.innerHTML = `
            <video id="video-player" controls preload="metadata" src="${job.video_url}"></video>
          `;
          currentVideo = document.getElementById("video-player");
        } else {
          playerShell.innerHTML = `<div class="empty">${job.message}</div>`;
          currentVideo = null;
        }

        posterGrid.innerHTML = "";
        for (const frame of job.frames) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "poster";
          button.innerHTML = `
            <img src="${frame.image_url}" alt="Poster tại ${formatTime(frame.time)}" />
            <span>${formatTime(frame.time)}</span>
          `;
          button.addEventListener("click", () => {
            if (!currentVideo) return;
            currentVideo.currentTime = frame.time;
            currentVideo.play();
          });
          posterGrid.appendChild(button);
        }
      }

      async function fetchState() {
        const response = await fetch("/api/state");
        const data = await response.json();
        const job = data.latest_job || null;
        currentJobId = job ? job.id : null;
        renderJob(job);

        if (job && job.status === "processing") {
          if (!pollTimer) {
            pollTimer = window.setInterval(fetchState, 1500);
          }
        } else if (pollTimer) {
          window.clearInterval(pollTimer);
          pollTimer = null;
        }
      }

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const url = urlInput.value.trim();
        if (!url) return;

        setStatus("Đang gửi job...");
        const response = await fetch("/api/download", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url })
        });

        const data = await response.json();
        if (!response.ok) {
          setStatus(`Lỗi: ${data.error || "Không tạo được job."}`);
          return;
        }

        currentJobId = data.job.id;
        renderJob(data.job);
        urlInput.value = "";
        if (!pollTimer) {
          pollTimer = window.setInterval(fetchState, 1500);
        }
      });

      fetchState();
    </script>
  </body>
</html>
"""


def timestamp_label(seconds: int) -> str:
    minutes, sec = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours:02d}-{minutes:02d}-{sec:02d}"
    return f"{minutes:02d}-{sec:02d}"


def serialize_job(job):
    return {
        "id": job["id"],
        "source_url": job["source_url"],
        "status": job["status"],
        "message": job["message"],
        "title": job.get("title"),
        "duration": job.get("duration", 0),
        "video_url": f"/media/{job['id']}/{job['video_path'].name}" if job.get("video_path") else None,
        "frames": [
            {
                "time": frame["time"],
                "image_url": f"/media/{job['id']}/frames/{frame['file'].name}",
            }
            for frame in job.get("frames", [])
        ],
    }


def get_latest_job():
    with STATE_LOCK:
        latest_id = STATE["latest_job_id"]
        if not latest_id:
            return None
        for job in reversed(STATE["jobs"]):
            if job["id"] == latest_id:
                return serialize_job(job)
    return None


def create_job(source_url: str):
    job_id = uuid.uuid4().hex[:10]
    job_dir = DOWNLOADS_DIR / job_id
    frame_dir = FRAMES_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    frame_dir.mkdir(parents=True, exist_ok=True)

    job = {
        "id": job_id,
        "source_url": source_url,
        "status": "processing",
        "message": "Đang tải video bằng yt-dlp...",
        "title": None,
        "duration": 0,
        "video_path": None,
        "job_dir": job_dir,
        "frame_dir": frame_dir,
        "frames": [],
    }

    with STATE_LOCK:
        STATE["jobs"].append(job)
        STATE["latest_job_id"] = job_id
    return job


def update_job(job, **fields):
    with STATE_LOCK:
        job.update(fields)


def pick_video_file(job_dir: Path):
    candidates = [path for path in job_dir.iterdir() if path.is_file() and path.suffix.lower() in {".mp4", ".mkv", ".webm", ".mov"}]
    if not candidates:
        return None
    return sorted(candidates, key=lambda path: path.stat().st_size, reverse=True)[0]


def download_and_extract(job):
    try:
        ydl_opts = {
            "outtmpl": str(job["job_dir"] / "%(title)s.%(ext)s"),
            "format": "bestvideo*+bestaudio/best",
            "merge_output_format": "mp4",
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "extractor_args": {
                "youtube": {
                    "player_client": ["android", "web", "tv_embedded"],
                }
            },
            "http_headers": {
                "User-Agent": (
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/135.0.0.0 Safari/537.36"
                )
            },
        }

        with YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(job["source_url"], download=True)

        video_path = pick_video_file(job["job_dir"])
        if not video_path:
            raise RuntimeError("Không tìm thấy file video sau khi tải xong.")

        duration = int(info.get("duration") or 0)
        title = info.get("title") or video_path.stem

        update_job(
            job,
            message="Đang trích poster mỗi 10 giây bằng ffmpeg...",
            title=title,
            duration=duration,
            video_path=video_path,
        )

        ffmpeg_path = get_ffmpeg_exe()
        pattern = job["frame_dir"] / "frame-%05d.jpg"
        command = [
            ffmpeg_path,
            "-y",
            "-i",
            str(video_path),
            "-vf",
            "fps=1/10,scale=480:-1",
            str(pattern),
        ]
        subprocess.run(command, check=True, capture_output=True)

        frames = []
        image_files = sorted(job["frame_dir"].glob("frame-*.jpg"))
        for index, image_file in enumerate(image_files):
            frames.append({"time": index * 10, "file": image_file})

        if not frames:
            raise RuntimeError("ffmpeg không tạo được poster nào.")

        update_job(
            job,
            status="ready",
            message="Hoàn tất. Hãy click vào poster để nhảy nhanh tới mốc thời gian tương ứng.",
            frames=frames,
        )
    except subprocess.CalledProcessError as exc:
        update_job(job, status="error", message=f"ffmpeg lỗi: {exc.stderr.decode('utf-8', errors='ignore')[:300]}")
    except Exception as exc:
        update_job(job, status="error", message=str(exc))


class AppHandler(BaseHTTPRequestHandler):
    def _send_json(self, payload, status=HTTPStatus.OK):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_html(self, html, status=HTTPStatus.OK):
        data = html.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_file(self, file_path: Path):
        if not file_path.exists() or not file_path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return

        content_type, _ = mimetypes.guess_type(str(file_path))
        data = file_path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == "/":
            self._send_html(HTML_PAGE)
            return

        if parsed.path == "/api/state":
            self._send_json({"latest_job": get_latest_job()})
            return

        if parsed.path.startswith("/media/"):
            parts = Path(parsed.path).parts
            # /media/<job_id>/<filename> or /media/<job_id>/frames/<filename>
            if len(parts) >= 4:
                job_id = parts[2]
                if len(parts) >= 5 and parts[3] == "frames":
                    self._send_file(FRAMES_DIR / job_id / parts[4])
                    return
                self._send_file(DOWNLOADS_DIR / job_id / parts[3])
                return

        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def do_POST(self):
        if self.path != "/api/download":
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return

        length = int(self.headers.get("Content-Length", "0"))
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except json.JSONDecodeError:
            self._send_json({"error": "Body JSON không hợp lệ."}, status=HTTPStatus.BAD_REQUEST)
            return

        source_url = (payload.get("url") or "").strip()
        if not source_url:
            self._send_json({"error": "Vui lòng nhập URL video."}, status=HTTPStatus.BAD_REQUEST)
            return

        job = create_job(source_url)
        worker = threading.Thread(target=download_and_extract, args=(job,), daemon=True)
        worker.start()
        self._send_json({"job": serialize_job(job)}, status=HTTPStatus.ACCEPTED)

    def log_message(self, format, *args):
        return


def main():
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer(("127.0.0.1", port), AppHandler)
    print(f"Server đang chạy tại http://127.0.0.1:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
