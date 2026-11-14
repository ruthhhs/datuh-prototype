"""
Prototype pemantauan CCTV - deteksi orang jatuh (YOLOv11)
Install: pip install ultralytics opencv-python PySide6
Jalankan: python fall_monitor.py
"""
import os
import sys
import time
from collections import deque
from datetime import datetime

import cv2
from PySide6.QtCore import Qt, QThread, Signal
from PySide6.QtGui import QImage, QPixmap
from PySide6.QtWidgets import (QApplication, QFileDialog, QHBoxLayout, QLabel,
                               QLineEdit, QListWidget, QPushButton, QSlider,
                               QVBoxLayout, QWidget)
from ultralytics import YOLO

# ====== SESUAIKAN ======
MODEL_PATH = "best.pt"                      # hasil training dari Kaggle
FALL_CLASSES = {"fall", "no-fall"}          # nama kelas "jatuh" di datasetmu (huruf kecil)
IMG_SIZE = 640
WINDOW = 15      # jumlah frame terakhir yang dipantau
MIN_HITS = 8     # minimal frame berisi "jatuh" dalam WINDOW agar alarm dibunyikan
COOLDOWN = 10    # detik jeda antar alarm
SNAP_DIR = "snapshots"
# =======================


class DetectorThread(QThread):
    frame_ready = Signal(QImage)
    alert = Signal(str)
    status = Signal(str)

    def __init__(self, source, conf):
        super().__init__()
        self.source = source
        self.conf = conf
        self.running = True

    def run(self):
        model = YOLO(MODEL_PATH)
        names = model.names
        cap = cv2.VideoCapture(self.source)
        if not cap.isOpened():
            self.status.emit("Gagal membuka sumber video")
            return

        hits = deque(maxlen=WINDOW)
        last_alert = 0
        os.makedirs(SNAP_DIR, exist_ok=True)
        t_prev = time.time()

        while self.running:
            ok, frame = cap.read()
            if not ok:
                self.status.emit("Stream berhenti / video selesai")
                break

            res = model.predict(frame, conf=self.conf, imgsz=IMG_SIZE, verbose=False)[0]
            fall_now = any(names[int(c)].lower() in FALL_CLASSES for c in res.boxes.cls)
            hits.append(fall_now)

            annotated = res.plot()

            # alarm hanya jika jatuh terdeteksi konsisten (kurangi false alarm)
            if sum(hits) >= MIN_HITS and time.time() - last_alert > COOLDOWN:
                last_alert = time.time()
                ts = datetime.now().strftime("%Y%m%d_%H%M%S")
                cv2.imwrite(os.path.join(SNAP_DIR, f"fall_{ts}.jpg"), annotated)
                self.alert.emit(f"{datetime.now():%H:%M:%S} - ORANG JATUH TERDETEKSI")

            if sum(hits) >= MIN_HITS:
                cv2.putText(annotated, "ALERT: JATUH!", (20, 50),
                            cv2.FONT_HERSHEY_SIMPLEX, 1.4, (0, 0, 255), 3)

            fps = 1 / max(time.time() - t_prev, 1e-6)
            t_prev = time.time()
            cv2.putText(annotated, f"FPS {fps:.1f}", (20, annotated.shape[0] - 20),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)

            rgb = cv2.cvtColor(annotated, cv2.COLOR_BGR2RGB)
            h, w, ch = rgb.shape
            self.frame_ready.emit(QImage(rgb.data, w, h, ch * w, QImage.Format_RGB888).copy())

        cap.release()

    def stop(self):
        self.running = False
        self.wait()


class MainWindow(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Fall Detection Monitor - YOLOv11")
        self.thread = None

        self.video = QLabel("Belum ada video")
        self.video.setMinimumSize(800, 450)
        self.video.setAlignment(Qt.AlignCenter)
        self.video.setStyleSheet("background:#111;color:#aaa")

        self.src_input = QLineEdit("0")
        self.src_input.setPlaceholderText("0 (webcam) / rtsp://user:pass@ip:554/... / path video")
        btn_browse = QPushButton("Pilih File")
        btn_browse.clicked.connect(self.browse)
        self.btn_start = QPushButton("Mulai")
        self.btn_start.clicked.connect(self.toggle)

        self.conf_label = QLabel("Confidence: 0.50")
        self.conf_slider = QSlider(Qt.Horizontal)
        self.conf_slider.setRange(10, 95)
        self.conf_slider.setValue(50)
        self.conf_slider.valueChanged.connect(
            lambda v: self.conf_label.setText(f"Confidence: {v/100:.2f}"))

        self.log = QListWidget()
        self.status = QLabel("Siap")

        top = QHBoxLayout()
        top.addWidget(self.src_input)
        top.addWidget(btn_browse)
        top.addWidget(self.btn_start)

        side = QVBoxLayout()
        side.addWidget(self.conf_label)
        side.addWidget(self.conf_slider)
        side.addWidget(QLabel("Log alarm:"))
        side.addWidget(self.log)

        body = QHBoxLayout()
        body.addWidget(self.video, 3)
        body.addLayout(side, 1)

        root = QVBoxLayout(self)
        root.addLayout(top)
        root.addLayout(body)
        root.addWidget(self.status)

    def browse(self):
        path, _ = QFileDialog.getOpenFileName(self, "Pilih video", "", "Video (*.mp4 *.avi *.mkv)")
        if path:
            self.src_input.setText(path)

    def toggle(self):
        if self.thread and self.thread.isRunning():
            self.thread.stop()
            self.btn_start.setText("Mulai")
            return
        text = self.src_input.text().strip()
        source = int(text) if text.isdigit() else text
        self.thread = DetectorThread(source, self.conf_slider.value() / 100)
        self.thread.frame_ready.connect(self.show_frame)
        self.thread.alert.connect(self.on_alert)
        self.thread.status.connect(self.status.setText)
        self.thread.start()
        self.btn_start.setText("Stop")

    def show_frame(self, img):
        self.video.setPixmap(QPixmap.fromImage(img).scaled(
            self.video.size(), Qt.KeepAspectRatio, Qt.SmoothTransformation))

    def on_alert(self, msg):
        self.log.insertItem(0, msg)
        QApplication.beep()

    def closeEvent(self, e):
        if self.thread:
            self.thread.stop()
        e.accept()


if __name__ == "__main__":
    app = QApplication(sys.argv)
    w = MainWindow()
    w.resize(1100, 600)
    w.show()
    sys.exit(app.exec())