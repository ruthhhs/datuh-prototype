"""
Backend deteksi orang jatuh (YOLOv11) - FastAPI + WebSocket
Jalankan: uvicorn main:app --reload --port 8000
"""
import asyncio
import json
import threading
import time
from collections import deque

import cv2
import numpy as np
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from ultralytics import YOLO

# ====== SESUAIKAN ======
MODEL_PATH = "models/best.pt"
FALL_CLASSES = {"fall", "no-fall"}  # nama kelas
IMG_SIZE = 640        # turunkan ke 416/320 kalau lambat di CPU
DEFAULT_CONF = 0.5
WINDOW = 15           # jumlah frame terakhir yang dipantau per koneksi
MIN_HITS = 3          # minimal frame "jatuh" dalam WINDOW agar status jatuh aktif
COOLDOWN = 5         # detik jeda antar alarm
# =======================

app = FastAPI(title="Fall Detection API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # ganti dengan domain frontend saat deploy
    allow_methods=["*"],
    allow_headers=["*"],
)

model = YOLO(MODEL_PATH)
model.predict(np.zeros((IMG_SIZE, IMG_SIZE, 3), dtype=np.uint8), verbose=False)  # warm-up
model_lock = threading.Lock()  # satu model dipakai banyak koneksi


def infer(frame: np.ndarray, conf: float) -> list[dict]:
    with model_lock:
        r = model.predict(frame, conf=conf, imgsz=IMG_SIZE, verbose=False)[0]
    dets = []
    # xyxyn = koordinat ternormalisasi 0-1, jadi frontend bebas skala canvas
    for box, c, cl in zip(r.boxes.xyxyn.tolist(), r.boxes.conf.tolist(), r.boxes.cls.tolist()):
        name = model.names[int(cl)]
        dets.append({
            "label": name,
            "conf": round(c, 3),
            "box": [round(v, 4) for v in box],
            "is_fall": name.lower() in FALL_CLASSES,
        })
    return dets


@app.get("/health")
def health():
    return {"status": "ok", "classes": model.names, "fall_classes": sorted(FALL_CLASSES)}


@app.websocket("/ws/detect")
async def ws_detect(ws: WebSocket):
    """
    Protokol:
      client -> server (binary): satu frame JPEG
      client -> server (text)  : {"conf": 0.6}  (opsional, ubah threshold)
      server -> client (JSON)  : {detections, fall_active, alert, ms}
    Client sebaiknya kirim frame berikutnya SETELAH menerima balasan (hindari antrean).
    """
    await ws.accept()
    loop = asyncio.get_running_loop()
    hits: deque = deque(maxlen=WINDOW)
    last_alert = 0.0
    conf = DEFAULT_CONF

    while True:
        msg = await ws.receive()
        if msg["type"] == "websocket.disconnect":
            break

        if msg.get("text"):
            try:
                conf = float(json.loads(msg["text"]).get("conf", conf))
            except (ValueError, TypeError):
                pass
            continue

        data = msg.get("bytes")
        if not data:
            continue
        frame = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        if frame is None:
            continue

        t0 = time.time()
        dets = await loop.run_in_executor(None, infer, frame, conf)  # jangan blok event loop

        hits.append(any(d["is_fall"] for d in dets))
        fall_active = sum(hits) >= MIN_HITS
        alert = False
        if fall_active and time.time() - last_alert > COOLDOWN:
            alert = True
            last_alert = time.time()

        await ws.send_json({
            "detections": dets,
            "fall_active": fall_active,
            "alert": alert,
            "ms": round((time.time() - t0) * 1000),
        })