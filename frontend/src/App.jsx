import React, { useEffect, useRef, useState, useCallback } from 'react';
import { styles } from './styles.js';

import logoIcon from './assets/logo-icon.png';

const WS_URL = 'ws://localhost:8000/ws/detect';

const CCTV_SLOTS = [
  { id: 'CCTV 01', location: 'Ruang Utama (Live Webcam)', isLive: true },
  { id: 'CCTV 02', location: 'Kamar Tidur', isLive: false },
  { id: 'CCTV 03', location: 'Dapur', isLive: false },
  { id: 'CCTV 04', location: 'Teras Depan', isLive: false },
  { id: 'CCTV 05', location: 'Ruang Keluarga', isLive: false },
  { id: 'CCTV 06', location: 'Kamar Mandi', isLive: false },
  { id: 'CCTV 07', location: 'Lorong', isLive: false },
  { id: 'CCTV 08', location: 'Tangga', isLive: false },
  { id: 'CCTV 09', location: 'Halaman Belakang', isLive: false },
];

function PhoneIcon({ color = '#FFFFFF', size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 36 24" fill={color}>
      <path d="M5 14C9 8 27 8 31 14L33 19C33 20 31 21 29 21L24 20C23 20 22 19 22 17L22 15C19 14 17 14 14 15L14 17C14 19 13 20 12 20L7 21C5 21 3 20 3 19L5 14Z" />
    </svg>
  );
}

export default function App() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const captureCanvasRef = useRef(null);
  const wsRef = useRef(null);
  const audioCtxRef = useRef(null);
  const isCameraOnRef = useRef(false);

  // State Koneksi & Deteksi
  const [isConnected, setIsConnected] = useState(false);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [fallActive, setFallActive] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [conf, setConf] = useState(0.5);
  const [latencyMs, setLatencyMs] = useState(0);
  const [detections, setDetections] = useState([]);

  // State Zoom per Kotak CCTV (null = mode grid 3x3, string id = kotak yang sedang di-zoom)
  const [zoomedCctvId, setZoomedCctvId] = useState(null);
  const [selectedIncident, setSelectedIncident] = useState(null);
  const [incidents, setIncidents] = useState([
    {
      id: 1,
      status: 'Fall Detected',
      time: 'Hari ini, 14:20',
      place: 'Ruang Utama',
      cctv: 'CCTV 01',
      thumbnail: null,
      detail: 'Terdeteksi posisi jatuh dengan confidence 89%.',
    },
    {
      id: 2,
      status: 'False Alarm',
      time: 'Hari ini, 11:05',
      place: 'Ruang Keluarga',
      cctv: 'CCTV 05',
      thumbnail: null,
      detail: 'Dibatalkan oleh operator (gerakan membungkuk).',
    },
    {
      id: 3,
      status: 'Case Closed',
      time: 'Kemarin, 19:42',
      place: 'Kamar Tidur',
      cctv: 'CCTV 02',
      thumbnail: null,
      detail: 'Penanganan selesai, kondisi aman.',
    },
  ]);

  // Helper pengecekan kelas fall murni (menghindari "no-fall" dianggap fall)
  const checkIsFall = (det) => {
    const lbl = (det.label || '').toLowerCase().trim();
    if (lbl.includes('no-fall') || lbl.includes('no_fall') || lbl.includes('non')) {
      return false;
    }
    return Boolean(det.is_fall) || lbl === 'fall' || lbl === 'jatuh';
  };

  // --- ALARM SUARA (Web Audio API) ---
  const triggerBeepAlarm = useCallback(() => {
    if (isMuted) return;
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') ctx.resume();

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.3);

      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.3);
    } catch (err) {
      console.warn('Menunggu interaksi user untuk audio:', err);
    }
  }, [isMuted]);

  // --- AMBIL SNAPSHOT THUMBNAIL SAAT TERJADI ALERT ---
  const captureSnapshot = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.readyState < 2) return null;
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = 240;
    tempCanvas.height = 160;
    const ctx = tempCanvas.getContext('2d');
    ctx.drawImage(video, 0, 0, tempCanvas.width, tempCanvas.height);
    return tempCanvas.toDataURL('image/jpeg', 0.7);
  }, []);

  // --- GAMBAR BOUNDING BOX YOLOv11 (HIJAU = NON-FALL, MERAH = FALL) ---
  const drawDetections = useCallback((items) => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;

    const ctx = canvas.getContext('2d');
    const w = video.videoWidth || 640;
    const h = video.videoHeight || 480;
    canvas.width = w;
    canvas.height = h;

    ctx.clearRect(0, 0, w, h);

    items.forEach((det) => {
      const [nx1, ny1, nx2, ny2] = det.box;
      const x1 = nx1 * w;
      const y1 = ny1 * h;
      const boxW = (nx2 - nx1) * w;
      const boxH = (ny2 - ny1) * h;

      const isFall = checkIsFall(det);
      // Merah untuk fall, Hijau untuk non-fall / normal
      const color = isFall ? '#DC2626' : '#16A34A';

      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.strokeRect(x1, y1, boxW, boxH);

      const label = `${det.label} ${Math.round(det.conf * 100)}%`;
      ctx.font = 'bold 14px monospace';
      const textWidth = ctx.measureText(label).width;

      ctx.fillStyle = color;
      ctx.fillRect(x1, y1 > 24 ? y1 - 24 : y1, textWidth + 12, 22);

      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(label, x1 + 6, y1 > 24 ? y1 - 8 : y1 + 15);
    });
  }, []);

  // --- KIRIM FRAME BINARY JPEG KE BACKEND ---
  const sendNextFrame = useCallback(() => {
    const video = videoRef.current;
    const ws = wsRef.current;

    if (!isCameraOnRef.current || !video || video.readyState < 2 || !ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    if (!captureCanvasRef.current) {
      captureCanvasRef.current = document.createElement('canvas');
    }
    const capCanvas = captureCanvasRef.current;
    capCanvas.width = video.videoWidth;
    capCanvas.height = video.videoHeight;

    const ctx = capCanvas.getContext('2d');
    ctx.drawImage(video, 0, 0, capCanvas.width, capCanvas.height);

    capCanvas.toBlob(
      (blob) => {
        if (blob && ws.readyState === WebSocket.OPEN && isCameraOnRef.current) {
          ws.send(blob);
        }
      },
      'image/jpeg',
      0.75
    );
  }, []);

  // --- WEBSOCKET CONNECTION ---
  useEffect(() => {
    let ws;
    let reconnectTimer;

    const connectWS = () => {
      ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        ws.send(JSON.stringify({ conf }));
        if (isCameraOnRef.current) sendNextFrame();
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          const dets = data.detections || [];
          setDetections(dets);
          setLatencyMs(data.ms || 0);
          drawDetections(dets);

          // Pastikan fall aktif hanya jika benar-benar ada deteksi kelas fall
          const hasRealFall = dets.some((d) => checkIsFall(d));
          const activeFall = Boolean(data.fall_active) && hasRealFall;
          setFallActive(activeFall);

          if (data.alert && hasRealFall) {
            triggerBeepAlarm();
            const snap = captureSnapshot();
            const nowStr = new Date().toLocaleTimeString('id-ID', {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            });
            const fallDets = dets.filter((d) => checkIsFall(d));
            const maxConf = fallDets.length
              ? Math.round(Math.max(...fallDets.map((d) => d.conf)) * 100)
              : 0;

            setIncidents((prev) => [
              {
                id: Date.now(),
                status: 'Fall Detected',
                time: `Hari ini, ${nowStr}`,
                place: 'Ruang Utama',
                cctv: 'CCTV 01',
                thumbnail: snap,
                detail: `Deteksi jatuh otomatis oleh YOLOv11 (Confidence: ${maxConf}%).`,
              },
              ...prev,
            ]);
          } else if (activeFall) {
            triggerBeepAlarm();
          }

          requestAnimationFrame(sendNextFrame);
        } catch (e) {
          console.error('Error parsing WS:', e);
        }
      };

      ws.onclose = () => {
        setIsConnected(false);
        reconnectTimer = setTimeout(connectWS, 2000);
      };

      ws.onerror = () => ws.close();
    };

    connectWS();
    return () => {
      clearTimeout(reconnectTimer);
      if (ws) ws.close();
    };
  }, [captureSnapshot, drawDetections, sendNextFrame, triggerBeepAlarm]);

  const handleConfChange = (e) => {
    const val = parseFloat(e.target.value);
    setConf(val);
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ conf: val }));
    }
  };

  const startWebcam = async (e) => {
    if (e) e.stopPropagation(); // Mencegah klik tombol memicu zoom kotak
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' },
        audio: false,
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.onloadedmetadata = () => {
          isCameraOnRef.current = true;
          setIsCameraOn(true);
          sendNextFrame();
        };
      }
    } catch (err) {
      alert('Gagal mengakses webcam: ' + err.message);
    }
  };

  const stopWebcam = () => {
    isCameraOnRef.current = false;
    setIsCameraOn(false);
    setFallActive(false);
    setDetections([]);
    if (videoRef.current && videoRef.current.srcObject) {
      videoRef.current.srcObject.getTracks().forEach((t) => t.stop());
      videoRef.current.srcObject = null;
    }
    if (canvasRef.current) {
      const ctx = canvasRef.current.getContext('2d');
      ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    }
  };

  const markFalseAlarm = (id) => {
    setIncidents((prev) =>
      prev.map((item) => (item.id === id ? { ...item, status: 'False Alarm' } : item))
    );
    setFallActive(false);
  };

  // Toggle zoom saat kotak CCTV diklik
  const handleCellClick = (slotId) => {
    setZoomedCctvId((prev) => (prev === slotId ? null : slotId));
  };

  return (
    <div>
      {/* ========= HEADER ========= */}
      <header style={styles.headerSection}>
        <div style={styles.logoMark}>
          <img src={logoIcon} width="38" height="38" alt="logo-icon" />
          <div style={styles.logoText}>
            <h2>DATUH</h2>
            <h6>Deteksi Jatuh</h6>
          </div>
        </div>

        <div style={styles.callBanner}>
          <a href="tel:081234567890" style={styles.callNumberLink}>
            <PhoneIcon color="#FFFFFF" size={34} />
            <span style={styles.phoneNumber}>0812-3456-7890</span>
          </a>
        </div>
      </header>

      {/* ========= MAIN SECTION ========= */}
      <section style={styles.mainSection}>

        {/* KAMERA CCTV */}
        <div style={styles.leftSection}>
          <h1>Monitor CCTV</h1>

          {/* GRID MONITOR CCTV 3x3 — KLIK PER KOTAK UNTUK ZOOM */}
          <div style={styles.cctvOuterContainer}>
              <div
                style={{
                  ...styles.cctvGrid,
                  gridTemplateColumns: zoomedCctvId ? '1fr' : 'repeat(3, 1fr)',
                  gridTemplateRows: zoomedCctvId ? '1fr' : 'repeat(3, 1fr)',
                }}
              >
                {CCTV_SLOTS.map((slot, index) => {
                  const isHidden = zoomedCctvId !== null && zoomedCctvId !== slot.id;
                  const isThisZoomed = zoomedCctvId === slot.id;

                  // Asumsi: Kita cek apakah slot kamera ini sedang jatuh (misal CCTV 01 atau berdasarkan state fallActive)
                  const isThisCameraFall = slot.id === 'CCTV 01' && fallActive;

                  return (
                    <div
                      key={slot.id}
                      onClick={() => handleCellClick(slot.id)}
                      title={isThisZoomed ? 'Klik untuk kembali ke tampilan 3x3' : `Klik untuk memperbesar ${slot.id}`}
                      style={{
                        ...styles.cctvCell,
                        display: isHidden ? 'none' : 'flex',
                        borderRight: !zoomedCctvId && (index + 1) % 3 !== 0 ? '3px solid #2C5E2E' : 'none',
                        borderBottom: !zoomedCctvId && index < 6 ? '3px solid #2C5E2E' : 'none',
                        // Border merah dihilangkan total, diganti badge
                        cursor: isThisZoomed ? 'zoom-out' : 'zoom-in',
                      }}
                    >
                      {slot.isLive ? (
                        <>
                          <video
                            ref={videoRef}
                            autoPlay
                            playsInline
                            muted
                            style={{
                              ...styles.webcamVideo,
                              display: isCameraOn ? 'block' : 'none',
                            }}
                          />
                          <canvas
                            ref={canvasRef}
                            style={{
                              ...styles.overlayCanvas,
                              display: isCameraOn ? 'block' : 'none',
                            }}
                          />
                          {!isCameraOn && (
                            <div style={styles.camOffOverlay}>
                              <span style={styles.camTag}>{slot.id} — {slot.location}</span>
                              <button onClick={startWebcam} style={styles.startCamPill}>
                                ▶ Aktifkan Kamera
                              </button>
                            </div>
                          )}
                          {isCameraOn && (
                            <span style={styles.liveBadge}>
                              ● LIVE {slot.id}
                            </span>
                          )}

                          {/* BADGE JATUH DI MASING-MASING KAMERA JIKA TERDETEKSI */}
                          {isThisCameraFall && (
                            <div style={styles.cameraFallBadge}>
                              🚨 JATUH
                            </div>
                          )}
                        </>
                      ) : (
                        <div style={styles.inactiveCell}>
                          <span style={styles.inactiveLabel}>{slot.id}</span>
                          <span style={styles.inactiveSub}>{slot.location}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

            {/* KAPSUL SAGE GREEN DI BAWAH GRID (CONTROL BAR KAMERA & MODEL) */}
            <div style={styles.sageControlBar}>
              <div style={styles.controlGroup}>
                {!isCameraOn ? (
                  <button onClick={startWebcam} style={styles.controlBtnGold}>
                    ▶ Mulai Deteksi
                  </button>
                ) : (
                  <button onClick={stopWebcam} style={styles.controlBtnRed}>
                    ⏹ Stop Kamera
                  </button>
                )}

                <button onClick={() => setIsMuted(!isMuted)} style={styles.controlBtnDark}>
                  {isMuted ? '🔇 Mute' : '🔊 Alarm On'}
                </button>
              </div>

              <div style={styles.controlGroup}>
                <label style={styles.sliderText}>
                  Conf: <strong>{Math.round(conf * 100)}%</strong>
                </label>
                <input
                  type="range"
                  min="0.1"
                  max="0.95"
                  step="0.05"
                  value={conf}
                  onChange={handleConfChange}
                  style={{ accentColor: '#E5CF7B', cursor: 'pointer' }}
                />
                <span style={styles.statusPill}>
                  {isConnected ? `WS OK (${latencyMs}ms)` : 'WS Offline'}
                </span>
              </div>
            </div>
          </div>  
        </div>

        {/* RIWAYAT */}
        <div style={styles.rightSection}>
          <div style={styles.riwayatOuterCard}>
            <div style={styles.riwayatHeaderContainer}>
              <h2 style={styles.riwayatHeading}>Riwayat</h2>
              {/* Status Aman / Terdeteksi Jatuh dipindah ke sini */}
              <div style={{
                ...styles.statusIndicatorBadge,
                backgroundColor: fallActive ? '#DC2626' : '#2C5E2E'
              }}>
                {fallActive ? '⚠️ Terdeteksi Jatuh' : '✅ Aman'}
              </div>
            </div>

            <div style={styles.riwayatInnerWhite}>
              <div style={styles.riwayatScrollArea}>
                {incidents.map((item) => {
                  const isFall = item.status === 'Fall Detected';
                  return (
                    <div key={item.id} style={styles.riwayatRow}>
                      <div style={styles.thumbBox}>
                        {item.thumbnail ? (
                          <img
                            src={item.thumbnail}
                            alt="Snapshot"
                            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          />
                        ) : null}
                      </div>

                      <div style={styles.riwayatInfo}>
                        <div
                          style={{
                            ...styles.riwayatStatus,
                            color: isFall ? '#B91C1C' : '#718B70',
                          }}
                        >
                          {item.status}
                        </div>
                        <div style={styles.riwayatMeta}>
                          Time, Place: {item.time} — {item.place}
                        </div>
                        <div style={styles.riwayatMeta}>CCTV No. : {item.cctv}</div>
                      </div>

                      <div style={styles.riwayatActions}>
                        {isFall ? (
                          <>
                            <button
                              onClick={() => markFalseAlarm(item.id)}
                              style={styles.circleGoldBtn}
                              title="Tandai sebagai False Alarm"
                            >
                              ✕
                            </button>
                            <a
                              href="tel:081234567890"
                              style={styles.circleSageBtn}
                              title="Hubungi Darurat"
                            >
                              <PhoneIcon color="#FFFFFF" size={18} />
                            </a>
                          </>
                        ) : (
                          <button
                            onClick={() => setSelectedIncident(item)}
                            style={styles.detailsLink}
                          >
                            Details
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

        </div>
      
      </section>

      {/* ========= FOOTER ========= */}
      <footer style={styles.footerSection}>
        <div style={styles.footerContent}>
          <h2 style={styles.footerHeading}>Tentang Datuh</h2>
          <p style={styles.footerDesc}>
            DATUH (Deteksi Jatuh) adalah sistem pemantauan keselamatan berbasis kecerdasan
            buatan (YOLOv11) yang mendeteksi insiden terjatuh secara real-time melalui kamera
            CCTV dan mengirimkan peringatan darurat otomatis kepada keluarga maupun tenaga medis.
          </p>
        </div>

        <div style={styles.footerDivider} />
        <div style={styles.copyright}>
          © 2026 Ruth-Puti.
          <br />
          All rights reserved.
        </div>
      </footer>

      {/* MODAL DETAIL INSIDEN */}
      {selectedIncident && (
        <div style={styles.modalBackdrop} onClick={() => setSelectedIncident(null)}>
          <div style={styles.modalBox} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 8px', color: '#193B28' }}>{selectedIncident.status}</h3>
            <p style={{ margin: '4px 0', fontSize: '14px' }}>
              <strong>Waktu & Lokasi:</strong> {selectedIncident.time} ({selectedIncident.place})
            </p>
            <p style={{ margin: '4px 0', fontSize: '14px' }}>
              <strong>Kamera:</strong> {selectedIncident.cctv}
            </p>
            <p style={{ margin: '10px 0 16px', fontSize: '14px', color: '#475569' }}>
              {selectedIncident.detail}
            </p>
            <button onClick={() => setSelectedIncident(null)} style={styles.controlBtnGold}>
              Tutup
            </button>
          </div>
        </div>
      )}
    </div>
  );
}