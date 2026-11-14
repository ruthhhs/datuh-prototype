import React, { useEffect, useRef, useState, useCallback } from 'react';

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
    <div style={styles.wrapper}>
      {/* =========================================================
          SECTION 1: DARK GREEN HERO & MONITOR CCTV (TANPA NAVBAR)
         ========================================================= */}
      <section style={styles.topSection}>
        {/* LOGO HEADER DATUH */}
        <header style={styles.logoHeader}>
          <div style={styles.logoMark}>
            <svg width="38" height="38" viewBox="0 0 40 40" fill="none">
              <path d="M10 8C18 8 26 14 28 24L18 28L12 18L10 8Z" fill="#E5CF7B" />
              <circle cx="13" cy="29" r="4.5" fill="#E5CF7B" />
            </svg>
            <div>
              <div style={styles.logoTitle}>DATUH</div>
              <div style={styles.logoSub}>Deteksi Jatuh</div>
            </div>
          </div>
        </header>

        {/* JUDUL MONITOR CCTV */}
        <h1 style={styles.mainHeading}>Monitor CCTV</h1>

        {/* BANNER DARURAT SAAT FALL ACTIVE */}
        {fallActive && (
          <div style={styles.emergencyStrip}>
            <span>🚨 PERINGATAN: ORANG JATUH TERDETEKSI DI CCTV 01!</span>
            <button onClick={() => setFallActive(false)} style={styles.emergencyResetBtn}>
              Matikan Alarm
            </button>
          </div>
        )}

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
                    outline: slot.isLive && fallActive ? '4px solid #DC2626' : 'none',
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
                          ● LIVE {slot.id} ({detections.length} obj)
                        </span>
                      )}
                    </>
                  ) : (
                    <div style={styles.inactiveCell}>
                      <span style={styles.inactiveLabel}>{slot.id}</span>
                      <span style={styles.inactiveSub}>{slot.location}</span>
                      {isThisZoomed && (
                        <span style={{ fontSize: '11px', marginTop: '8px', fontWeight: 700 }}>
                          (Kamera tidak terhubung — klik kotak untuk kembali)
                        </span>
                      )}
                    </div>
                  )}

                  {/* Indikator kecil di pojok saat mode zoom aktif */}
                  {isThisZoomed && (
                    <span style={styles.zoomHintCorner}>🔍 Klik kotak untuk keluar zoom</span>
                  )}
                </div>
              );
            })}

            {/* Label statis sesuai desain mockup (non-interaktif, zoom lewat klik kotak) */}
            {!zoomedCctvId && (
              <div style={styles.zoomHintPill}>
                Press to Zoom In
              </div>
            )}
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
      </section>

      {/* =========================================================
          SECTION 2: CREAM BACKGROUND — RIWAYAT & MAU TELP?
         ========================================================= */}
      <section style={styles.middleSection}>
        <div style={styles.riwayatOuterCard}>
          <h2 style={styles.riwayatHeading}>Riwayat</h2>

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

        {/* BANNER "Mau telp? 0812-3456-7890" */}
        <div style={styles.callBanner}>
          <span style={styles.callLabel}>Mau telp?</span>
          <a href="tel:081234567890" style={styles.callNumberLink}>
            <PhoneIcon color="#FFFFFF" size={34} />
            <span style={styles.phoneNumber}>0812-3456-7890</span>
          </a>
        </div>
      </section>

      {/* =========================================================
          SECTION 3: FOOTER — TENTANG DATUH & COPYRIGHT
         ========================================================= */}
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

function PhoneIcon({ color = '#FFFFFF', size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 36 24" fill={color}>
      <path d="M5 14C9 8 27 8 31 14L33 19C33 20 31 21 29 21L24 20C23 20 22 19 22 17L22 15C19 14 17 14 14 15L14 17C14 19 13 20 12 20L7 21C5 21 3 20 3 19L5 14Z" />
    </svg>
  );
}

const styles = {
  wrapper: {
    fontFamily: "'Space Mono', 'Courier New', monospace",
    margin: 0,
    padding: 0,
    width: '100%',
    overflowX: 'hidden',
  },

  // --- SECTION 1 ---
  topSection: {
    backgroundColor: '#193B28',
    minHeight: '100vh',
    padding: '28px 24px 64px',
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },
  logoHeader: {
    display: 'flex',
    justifyContent: 'center',
    marginBottom: '28px',
  },
  logoMark: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  },
  logoTitle: {
    color: '#E5CF7B',
    fontSize: '26px',
    fontWeight: 800,
    letterSpacing: '2px',
    lineHeight: 1,
  },
  logoSub: {
    color: '#E5CF7B',
    fontSize: '10px',
    letterSpacing: '1px',
    marginTop: '2px',
  },

  mainHeading: {
    color: '#E5CF7B',
    fontSize: '42px',
    fontWeight: 700,
    margin: '0 0 24px',
    letterSpacing: '1px',
    textAlign: 'center',
  },

  emergencyStrip: {
    backgroundColor: '#DC2626',
    color: '#FFFFFF',
    padding: '12px 24px',
    borderRadius: '999px',
    marginBottom: '20px',
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    fontWeight: 700,
    fontSize: '14px',
    boxShadow: '0 0 20px rgba(220, 38, 38, 0.6)',
  },
  emergencyResetBtn: {
    backgroundColor: '#FFFFFF',
    color: '#DC2626',
    border: 'none',
    borderRadius: '999px',
    padding: '5px 14px',
    fontWeight: 700,
    cursor: 'pointer',
  },

  cctvOuterContainer: {
    width: '100%',
    maxWidth: '720px',
    display: 'flex',
    flexDirection: 'column',
    gap: '24px',
  },
  cctvGrid: {
    position: 'relative',
    width: '100%',
    aspectRatio: '16 / 10',
    backgroundColor: '#E5CF7B',
    borderRadius: '26px',
    border: '3px solid #2C5E2E',
    display: 'grid',
    overflow: 'hidden',
    boxShadow: '0 12px 32px rgba(0,0,0,0.3)',
  },
  cctvCell: {
    position: 'relative',
    width: '100%',
    height: '100%',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'background-color 0.15s ease',
  },
  webcamVideo: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  },
  overlayCanvas: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
  },
  camOffOverlay: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '8px',
    padding: '8px',
    textAlign: 'center',
  },
  camTag: {
    fontSize: '11px',
    fontWeight: 700,
    color: '#193B28',
  },
  startCamPill: {
    backgroundColor: '#193B28',
    color: '#E5CF7B',
    border: 'none',
    borderRadius: '999px',
    padding: '6px 14px',
    fontSize: '11px',
    fontWeight: 700,
    cursor: 'pointer',
  },
  liveBadge: {
    position: 'absolute',
    top: '8px',
    left: '8px',
    backgroundColor: 'rgba(25, 59, 40, 0.85)',
    color: '#E5CF7B',
    fontSize: '10px',
    fontWeight: 700,
    padding: '3px 8px',
    borderRadius: '6px',
  },
  inactiveCell: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    opacity: 0.45,
    color: '#193B28',
  },
  inactiveLabel: {
    fontSize: '12px',
    fontWeight: 700,
  },
  inactiveSub: {
    fontSize: '10px',
  },

  // Petunjuk statis di bawah tengah grid (tidak bisa diklik, pointerEvents: 'none')
  zoomHintPill: {
    position: 'absolute',
    bottom: '12px',
    left: '50%',
    transform: 'translateX(-50%)',
    backgroundColor: '#F1F5F9',
    color: '#1E293B',
    border: '1px solid #94A3B8',
    borderRadius: '999px',
    padding: '4px 36px',
    fontSize: '11px',
    fontWeight: 700,
    boxShadow: '0 2px 6px rgba(0,0,0,0.2)',
    pointerEvents: 'none',
    zIndex: 10,
  },
  zoomHintCorner: {
    position: 'absolute',
    bottom: '10px',
    right: '12px',
    backgroundColor: 'rgba(25, 59, 40, 0.85)',
    color: '#E5CF7B',
    padding: '4px 12px',
    borderRadius: '999px',
    fontSize: '11px',
    fontWeight: 700,
    pointerEvents: 'none',
  },

  // Kapsul Sage Green di bawah Grid CCTV
  sageControlBar: {
    width: '100%',
    minHeight: '58px',
    backgroundColor: '#718B70',
    borderRadius: '20px',
    padding: '10px 20px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '12px',
    boxSizing: 'border-box',
  },
  controlGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  },
  controlBtnGold: {
    backgroundColor: '#E5CF7B',
    color: '#193B28',
    border: 'none',
    borderRadius: '999px',
    padding: '7px 16px',
    fontSize: '12px',
    fontWeight: 700,
    cursor: 'pointer',
  },
  controlBtnRed: {
    backgroundColor: '#DC2626',
    color: '#FFFFFF',
    border: 'none',
    borderRadius: '999px',
    padding: '7px 16px',
    fontSize: '12px',
    fontWeight: 700,
    cursor: 'pointer',
  },
  controlBtnDark: {
    backgroundColor: '#193B28',
    color: '#E5CF7B',
    border: 'none',
    borderRadius: '999px',
    padding: '7px 14px',
    fontSize: '12px',
    fontWeight: 700,
    cursor: 'pointer',
  },
  sliderText: {
    color: '#FFFFFF',
    fontSize: '12px',
  },
  statusPill: {
    backgroundColor: 'rgba(25, 59, 40, 0.55)',
    color: '#E5CF7B',
    padding: '4px 10px',
    borderRadius: '999px',
    fontSize: '11px',
    fontWeight: 700,
  },

  // --- SECTION 2: RIWAYAT & CALL BANNER ---
  middleSection: {
    backgroundColor: '#F4EFE6',
    padding: '64px 24px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '28px',
  },
  riwayatOuterCard: {
    width: '100%',
    maxWidth: '720px',
    backgroundColor: '#718B70',
    borderRadius: '22px',
    padding: '22px 26px 28px',
    boxSizing: 'border-box',
  },
  riwayatHeading: {
    color: '#FFFFFF',
    fontSize: '24px',
    fontWeight: 700,
    margin: '0 0 16px 18px',
  },
  riwayatInnerWhite: {
    backgroundColor: '#FFFFFF',
    borderRadius: '4px',
    padding: '16px',
  },
  riwayatScrollArea: {
    maxHeight: '340px',
    overflowY: 'auto',
    paddingRight: '10px',
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
  },
  riwayatRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    paddingBottom: '14px',
    borderBottom: '1.5px solid #E5CF7B',
  },
  thumbBox: {
    width: '120px',
    height: '72px',
    backgroundColor: '#E5CF7B',
    flexShrink: 0,
    overflow: 'hidden',
  },
  riwayatInfo: {
    flex: 1,
  },
  riwayatStatus: {
    fontSize: '20px',
    fontWeight: 700,
    marginBottom: '4px',
  },
  riwayatMeta: {
    fontSize: '12px',
    color: '#5C725B',
    lineHeight: 1.4,
  },
  riwayatActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
  },
  circleGoldBtn: {
    width: '42px',
    height: '42px',
    borderRadius: '50%',
    backgroundColor: '#E5CF7B',
    color: '#FFFFFF',
    border: 'none',
    fontSize: '18px',
    fontWeight: 700,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  circleSageBtn: {
    width: '42px',
    height: '42px',
    borderRadius: '50%',
    backgroundColor: '#718B70',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    textDecoration: 'none',
  },
  detailsLink: {
    background: 'none',
    border: 'none',
    color: '#718B70',
    textDecoration: 'underline',
    fontStyle: 'italic',
    fontSize: '13px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },

  // Banner "Mau telp?"
  callBanner: {
    width: '100%',
    maxWidth: '720px',
    backgroundColor: '#718B70',
    borderRadius: '18px',
    padding: '20px 44px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '16px',
    boxSizing: 'border-box',
  },
  callLabel: {
    color: '#FFFFFF',
    fontSize: '24px',
    fontWeight: 700,
  },
  callNumberLink: {
    display: 'flex',
    alignItems: 'center',
    gap: '18px',
    textDecoration: 'none',
    color: '#FFFFFF',
  },
  phoneNumber: {
    fontSize: '26px',
    fontWeight: 700,
    letterSpacing: '1px',
  },

  // --- SECTION 3: FOOTER ---
  footerSection: {
    backgroundColor: '#193B28',
    padding: '56px 24px 36px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },
  footerContent: {
    width: '100%',
    maxWidth: '720px',
  },
  footerHeading: {
    color: '#E5CF7B',
    fontSize: '32px',
    fontWeight: 700,
    margin: '0 0 14px',
  },
  footerDesc: {
    color: '#E5CF7B',
    fontSize: '13px',
    lineHeight: 1.7,
    margin: '0 0 48px',
    maxWidth: '620px',
  },
  footerDivider: {
    width: '100%',
    maxWidth: '820px',
    height: '1px',
    backgroundColor: 'rgba(229, 207, 123, 0.35)',
    marginBottom: '20px',
  },
  copyright: {
    color: '#E5CF7B',
    fontSize: '12px',
    textAlign: 'center',
    lineHeight: 1.6,
  },

  // Modal Detail
  modalBackdrop: {
    position: 'fixed',
    inset: 0,
    backgroundColor: 'rgba(0,0,0,0.55)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
  },
  modalBox: {
    backgroundColor: '#F4EFE6',
    border: '3px solid #718B70',
    borderRadius: '16px',
    padding: '24px',
    maxWidth: '400px',
    width: '90%',
  },
};