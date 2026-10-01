"use strict";
/* ============================================================
   Escáner de Hoja de Ruta — lógica de cámara + backend
   ============================================================
   - Detección de bordes del documento con OpenCV.js
   - Auto-captura cuando el documento está encuadrado y estable
   - Control automático de linterna en poca luz (Android/Chrome)
   - Extracción de campos vía Google Apps Script (OCR + regex)
   - Cola local para reintentar guardados sin conexión
   ============================================================ */

const PROC_WIDTH = 320;              // ancho del canvas de trabajo para detección (rendimiento)
const STABLE_TICKS_REQUIRED = 5;     // ticks consecutivos estables para auto-capturar (~ tick*150ms)
const DETECTION_INTERVAL_MS = 150;
const LOW_LIGHT_THRESHOLD = 70;      // brillo medio (0-255) por debajo del cual se considera "poca luz"
const LOW_LIGHT_RECOVER = 100;       // brillo por encima del cual se considera "buena luz" (histéresis)
const LOW_LIGHT_TICKS_REQUIRED = 8;  // ticks sostenidos antes de actuar sobre la linterna
const MIN_QUAD_AREA_RATIO = 0.18;    // el documento debe cubrir al menos este % del cuadro para auto-capturar

const els = {
  video: document.getElementById("video"),
  overlay: document.getElementById("overlay"),
  statusPill: document.getElementById("status-pill"),
  btnTorch: document.getElementById("btn-torch"),
  lowLightBanner: document.getElementById("low-light-banner"),
  btnCapture: document.getElementById("btn-capture"),
  btnFlip: document.getElementById("btn-flip"),
  btnGallery: document.getElementById("btn-gallery"),
  previewImg: document.getElementById("preview-img"),
  btnRetake: document.getElementById("btn-retake"),
  btnUsePhoto: document.getElementById("btn-use-photo"),
  loadingText: document.getElementById("loading-text"),
  dataForm: document.getElementById("data-form"),
  extractWarning: document.getElementById("extract-warning"),
  btnBackToPreview: document.getElementById("btn-back-to-preview"),
  btnSave: document.getElementById("btn-save"),
  successText: document.getElementById("success-text"),
  successSub: document.getElementById("success-sub"),
  btnScanAnother: document.getElementById("btn-scan-another"),
  toast: document.getElementById("toast"),
  historyList: document.getElementById("history-list"),
  historyEmpty: document.getElementById("history-empty"),
  btnCloseHistory: document.getElementById("btn-close-history"),
};

const state = {
  stream: null,
  track: null,
  facingMode: "environment",
  detectionTimer: null,
  lastQuadProc: null,       // último cuadrilátero detectado, en espacio del canvas de proceso
  stableCount: 0,
  prevStable: null,         // {cx, cy, area} del tick anterior para comparar estabilidad
  autoCaptureLocked: false, // evita disparos repetidos mientras se procesa una captura
  lowLightTicks: 0,
  goodLightTicks: 0,
  torchOn: false,
  torchSupported: false,
  torchAuto: false,         // true = el encendido actual lo hizo la lógica automática
  torchManualLock: false,   // true = el usuario apagó manualmente; esperar recuperación de luz
  capturedCanvas: null,     // canvas con la foto ya recortada/enderezada
  driveFileId: null,        // id de Drive devuelto por "extract", reutilizado en "save"
  imageBase64: null,        // imagen actual en base64 (para guardar/cola offline)
  cvReady: false,
};

// ---------------------------------------------------------------
// Navegación entre pantallas
// ---------------------------------------------------------------
function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

function toast(msg, isError) {
  els.toast.textContent = msg;
  els.toast.classList.toggle("error", !!isError);
  els.toast.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.add("hidden"), 3200);
}

// ---------------------------------------------------------------
// OpenCV.js — esperar a que cargue
// ---------------------------------------------------------------
function waitForOpenCV() {
  return new Promise((resolve, reject) => {
    if (window.cv && window.cv.Mat) return resolve();
    const start = Date.now();
    const check = setInterval(() => {
      if (window.cv && window.cv.Mat) {
        clearInterval(check);
        resolve();
      } else if (window.__cvFailed || Date.now() - start > 15000) {
        clearInterval(check);
        reject(new Error("OpenCV.js no cargó"));
      }
    }, 100);
  });
}

// ---------------------------------------------------------------
// Cámara
// ---------------------------------------------------------------
async function startCamera() {
  stopCamera();
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: state.facingMode },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });
  } catch (err) {
    toast("No se pudo acceder a la cámara: " + err.message, true);
    return;
  }
  els.video.srcObject = state.stream;
  state.track = state.stream.getVideoTracks()[0];

  const caps = state.track.getCapabilities ? state.track.getCapabilities() : {};
  state.torchSupported = !!(caps && "torch" in caps);
  els.btnTorch.classList.toggle("hidden", !state.torchSupported);

  await new Promise((res) => {
    if (els.video.readyState >= 2) return res();
    els.video.onloadedmetadata = () => res();
  });
  els.video.play().catch(() => {});
  sizeOverlay();
  startDetectionLoop();
}

function stopCamera() {
  stopDetectionLoop();
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
    state.track = null;
  }
}

function sizeOverlay() {
  const rect = els.video.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  els.overlay.width = Math.round(rect.width * dpr);
  els.overlay.height = Math.round(rect.height * dpr);
  els.overlay.style.width = rect.width + "px";
  els.overlay.style.height = rect.height + "px";
  const ctx = els.overlay.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", sizeOverlay);

async function toggleTorch(forceOn) {
  if (!state.torchSupported || !state.track) return;
  const target = typeof forceOn === "boolean" ? forceOn : !state.torchOn;
  try {
    await state.track.applyConstraints({ advanced: [{ torch: target }] });
    state.torchOn = target;
    els.btnTorch.classList.toggle("on", target);
  } catch (err) {
    console.warn("No se pudo controlar la linterna", err);
  }
}

els.btnTorch.addEventListener("click", async () => {
  if (!state.torchSupported) {
    toast("Este navegador no permite controlar la linterna. Actívala manualmente.", true);
    return;
  }
  const goingOn = !state.torchOn;
  await toggleTorch(goingOn);
  state.torchAuto = false;
  if (!goingOn) {
    state.torchManualLock = true;
    state.goodLightTicks = 0;
  } else {
    state.torchManualLock = false;
  }
});

els.btnFlip.addEventListener("click", async () => {
  state.facingMode = state.facingMode === "environment" ? "user" : "environment";
  await startCamera();
});

// ---------------------------------------------------------------
// Bucle de detección: brillo (para linterna) + bordes del documento
// ---------------------------------------------------------------
function startDetectionLoop() {
  stopDetectionLoop();
  const proc = document.createElement("canvas");
  const vw = els.video.videoWidth || 1280;
  const vh = els.video.videoHeight || 720;
  proc.width = PROC_WIDTH;
  proc.height = Math.round(PROC_WIDTH * (vh / vw));
  const pctx = proc.getContext("2d", { willReadFrequently: true });

  state.detectionTimer = setInterval(() => {
    if (els.video.readyState < 2 || state.autoCaptureLocked) return;
    try {
      pctx.drawImage(els.video, 0, 0, proc.width, proc.height);
      processFrame(proc);
    } catch (err) {
      // frames ocasionales pueden fallar (p.ej. cámara cambiando) — se ignoran
    }
  }, DETECTION_INTERVAL_MS);
}

function stopDetectionLoop() {
  if (state.detectionTimer) {
    clearInterval(state.detectionTimer);
    state.detectionTimer = null;
  }
}

function processFrame(procCanvas) {
  if (!state.cvReady) return;
  const cv = window.cv;
  let src, gray, blurred, edges, kernel, contours, hierarchy;
  try {
    src = cv.imread(procCanvas);
    gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    // --- brillo medio (para decidir linterna) ---
    const meanBrightness = cv.mean(gray)[0];
    handleLightLevel(meanBrightness);

    // --- detección de bordes del documento ---
    blurred = new cv.Mat();
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    edges = new cv.Mat();
    cv.Canny(blurred, edges, 60, 160);
    kernel = cv.Mat.ones(3, 3, cv.CV_8U);
    cv.dilate(edges, edges, kernel);

    contours = new cv.MatVector();
    hierarchy = new cv.Mat();
    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    let best = null;
    let bestArea = 0;
    const frameArea = procCanvas.width * procCanvas.height;

    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const peri = cv.arcLength(cnt, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        const area = Math.abs(cv.contourArea(approx));
        if (area > bestArea && area > MIN_QUAD_AREA_RATIO * frameArea) {
          bestArea = area;
          if (best) best.delete();
          best = approx;
        } else {
          approx.delete();
        }
      } else {
        approx.delete();
      }
      cnt.delete();
    }

    if (best) {
      const pts = [];
      for (let i = 0; i < 4; i++) {
        pts.push({ x: best.data32S[i * 2], y: best.data32S[i * 2 + 1] });
      }
      best.delete();
      const ordered = orderPoints(pts);
      state.lastQuadProc = ordered;
      onQuadDetected(ordered, bestArea / frameArea);
    } else {
      state.lastQuadProc = null;
      onQuadLost();
    }
  } finally {
    [src, gray, blurred, edges, kernel, contours, hierarchy].forEach((m) => m && m.delete && m.delete());
  }

  drawOverlay();
}

function orderPoints(pts) {
  const sum = pts.map((p) => p.x + p.y);
  const diff = pts.map((p) => p.x - p.y);
  const tl = pts[sum.indexOf(Math.min(...sum))];
  const br = pts[sum.indexOf(Math.max(...sum))];
  const tr = pts[diff.indexOf(Math.max(...diff))];
  const bl = pts[diff.indexOf(Math.min(...diff))];
  return [tl, tr, br, bl];
}

// ---------------------------------------------------------------
// Estabilidad -> auto-captura
// ---------------------------------------------------------------
function onQuadDetected(quad, areaRatio) {
  const cx = (quad[0].x + quad[2].x) / 2;
  const cy = (quad[0].y + quad[2].y) / 2;
  const prev = state.prevStable;

  let stable = false;
  if (prev) {
    const dCx = Math.abs(cx - prev.cx);
    const dCy = Math.abs(cy - prev.cy);
    const dArea = Math.abs(areaRatio - prev.area);
    stable = dCx < 10 && dCy < 10 && dArea < 0.04;
  }
  state.prevStable = { cx, cy, area: areaRatio };
  state.stableCount = stable ? state.stableCount + 1 : 0;

  const readyToCapture = state.stableCount >= STABLE_TICKS_REQUIRED;
  els.statusPill.textContent = readyToCapture
    ? "¡Listo! Capturando…"
    : "Documento detectado — mantén el encuadre";
  els.statusPill.classList.toggle("found", true);
  els.statusPill.classList.toggle("capturing", readyToCapture);
  els.btnCapture.classList.add("auto");

  if (readyToCapture && !state.autoCaptureLocked) {
    state.autoCaptureLocked = true;
    doCapture();
  }
}

function onQuadLost() {
  state.stableCount = 0;
  state.prevStable = null;
  els.statusPill.textContent = "Buscando documento…";
  els.statusPill.classList.remove("found", "capturing");
  els.btnCapture.classList.remove("auto");
}

// ---------------------------------------------------------------
// Poca luz -> linterna automática
// ---------------------------------------------------------------
function handleLightLevel(brightness) {
  if (brightness < LOW_LIGHT_THRESHOLD) {
    state.lowLightTicks++;
    state.goodLightTicks = 0;
  } else if (brightness > LOW_LIGHT_RECOVER) {
    state.goodLightTicks++;
    state.lowLightTicks = 0;
  }

  const isLow = state.lowLightTicks >= LOW_LIGHT_TICKS_REQUIRED;
  els.lowLightBanner.classList.toggle("hidden", !isLow || state.torchOn);

  if (isLow && state.torchSupported && !state.torchOn && !state.torchManualLock) {
    toggleTorch(true);
    state.torchAuto = true;
  }
  if (state.goodLightTicks >= LOW_LIGHT_TICKS_REQUIRED) {
    if (state.torchOn && state.torchAuto) {
      toggleTorch(false);
      state.torchAuto = false;
    }
    state.torchManualLock = false; // la luz se recuperó: permitir que la lógica automática vuelva a actuar
  }
}

// ---------------------------------------------------------------
// Dibujo del contorno sobre el video (mapeo para object-fit: cover)
// ---------------------------------------------------------------
function drawOverlay() {
  const ctx = els.overlay.getContext("2d");
  const rect = els.video.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  if (!state.lastQuadProc) return;

  const vw = els.video.videoWidth;
  const vh = els.video.videoHeight;
  const scale = vw / PROC_WIDTH; // = vh / procHeight, misma proporción

  const cover = coverTransform(vw, vh, rect.width, rect.height);
  const pts = state.lastQuadProc.map((p) => {
    const vx = p.x * scale;
    const vy = p.y * scale;
    return { x: vx * cover.scale + cover.offsetX, y: vy * cover.scale + cover.offsetY };
  });

  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.lineWidth = 3;
  ctx.strokeStyle = state.stableCount >= STABLE_TICKS_REQUIRED ? "#22c55e" : "#fbbf24";
  ctx.fillStyle = state.stableCount >= STABLE_TICKS_REQUIRED ? "rgba(34,197,94,0.18)" : "rgba(251,191,36,0.12)";
  ctx.fill();
  ctx.stroke();
  pts.forEach((p) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();
  });
}

// object-fit: cover -> factor de escala y desplazamiento para mapear
// coordenadas del video fuente a coordenadas visibles en pantalla
function coverTransform(srcW, srcH, dstW, dstH) {
  const scale = Math.max(dstW / srcW, dstH / srcH);
  const drawnW = srcW * scale;
  const drawnH = srcH * scale;
  return { scale, offsetX: (dstW - drawnW) / 2, offsetY: (dstH - drawnH) / 2 };
}

// ---------------------------------------------------------------
// Captura (automática o manual)
// ---------------------------------------------------------------
els.btnCapture.addEventListener("click", () => {
  if (state.autoCaptureLocked) return;
  state.autoCaptureLocked = true;
  doCapture();
});

function doCapture() {
  stopDetectionLoop();
  const video = els.video;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const fullCanvas = document.createElement("canvas");
  fullCanvas.width = vw;
  fullCanvas.height = vh;
  fullCanvas.getContext("2d").drawImage(video, 0, 0, vw, vh);

  let finalCanvas = fullCanvas;
  if (state.lastQuadProc && window.cv && window.cv.Mat) {
    const scale = vw / PROC_WIDTH;
    const quadFull = state.lastQuadProc.map((p) => ({ x: p.x * scale, y: p.y * scale }));
    try {
      finalCanvas = warpDocument(fullCanvas, quadFull);
    } catch (err) {
      console.warn("No se pudo enderezar el documento, se usa la foto completa", err);
      finalCanvas = fullCanvas;
    }
  }

  state.capturedCanvas = finalCanvas;
  els.previewImg.src = finalCanvas.toDataURL("image/jpeg", 0.9);
  stopCamera();
  showScreen("screen-preview");
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function warpDocument(sourceCanvas, quad) {
  const cv = window.cv;
  const src = cv.imread(sourceCanvas);
  const widthA = dist(quad[2], quad[3]);
  const widthB = dist(quad[1], quad[0]);
  const maxWidth = Math.round(Math.max(widthA, widthB));
  const heightA = dist(quad[1], quad[2]);
  const heightB = dist(quad[0], quad[3]);
  const maxHeight = Math.round(Math.max(heightA, heightB));

  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    quad[0].x, quad[0].y, quad[1].x, quad[1].y, quad[2].x, quad[2].y, quad[3].x, quad[3].y,
  ]);
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, maxWidth, 0, maxWidth, maxHeight, 0, maxHeight]);
  const M = cv.getPerspectiveTransform(srcTri, dstTri);
  const dst = new cv.Mat();
  cv.warpPerspective(src, dst, M, new cv.Size(maxWidth, maxHeight), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());

  const outCanvas = document.createElement("canvas");
  outCanvas.width = maxWidth;
  outCanvas.height = maxHeight;
  cv.imshow(outCanvas, dst);

  [src, dst, M, srcTri, dstTri].forEach((m) => m.delete());
  return outCanvas;
}

// ---------------------------------------------------------------
// Pantalla de revisión de foto
// ---------------------------------------------------------------
els.btnRetake.addEventListener("click", async () => {
  state.autoCaptureLocked = false;
  state.stableCount = 0;
  showScreen("screen-camera");
  await startCamera();
});

els.btnUsePhoto.addEventListener("click", async () => {
  state.imageBase64 = canvasToResizedBase64(state.capturedCanvas, 1600, 0.85);
  showScreen("screen-loading");
  els.loadingText.textContent = "Extrayendo datos del documento…";
  await runExtract();
});

function canvasToResizedBase64(canvas, maxWidth, quality) {
  let target = canvas;
  if (canvas.width > maxWidth) {
    const scale = maxWidth / canvas.width;
    const c2 = document.createElement("canvas");
    c2.width = maxWidth;
    c2.height = Math.round(canvas.height * scale);
    c2.getContext("2d").drawImage(canvas, 0, 0, c2.width, c2.height);
    target = c2;
  }
  return target.toDataURL("image/jpeg", quality).split(",")[1];
}

// ---------------------------------------------------------------
// Backend: extraer y guardar
// ---------------------------------------------------------------
async function callBackend(action, payload, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 30000);
  try {
    const res = await fetch(window.APP_CONFIG.APPS_SCRIPT_URL, {
      method: "POST",
      // text/plain evita el preflight CORS que Apps Script no maneja bien
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action, token: window.APP_CONFIG.API_TOKEN, ...payload }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (!data.success) throw new Error(data.error || "Error del servidor");
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function runExtract() {
  try {
    const data = await callBackend("extract", { imageBase64: state.imageBase64 });
    state.driveFileId = data.driveFileId || null;
    fillForm(data.fields || {});
    els.extractWarning.classList.toggle("hidden", !data.warnings || data.warnings.length === 0);
    showScreen("screen-form");
  } catch (err) {
    console.warn("Extracción falló, se completa a mano:", err);
    state.driveFileId = null;
    fillForm({});
    els.extractWarning.classList.remove("hidden");
    els.extractWarning.textContent =
      "No se pudo conectar para leer el documento automáticamente. Completa los datos a mano; la foto se guarda de todas formas.";
    showScreen("screen-form");
  }
}

function fillForm(fields) {
  const map = {
    hojaRuta: "f-hoja-ruta",
    ordenVenta: "f-orden-venta",
    vehiculoConductor: "f-vehiculo",
    fechaDespacho: "f-fecha",
    cliente: "f-cliente",
    totalVolumenPeso: "f-total",
    casaMatriz: "f-casa-matriz",
  };
  Object.entries(map).forEach(([key, id]) => {
    const input = document.getElementById(id);
    input.value = fields[key] || "";
    input.classList.toggle("auto-filled", !!fields[key]);
  });
}

els.btnBackToPreview.addEventListener("click", () => {
  showScreen("screen-preview");
});

els.dataForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const formData = new FormData(els.dataForm);
  const fields = Object.fromEntries(formData.entries());

  els.btnSave.disabled = true;
  els.btnSave.textContent = "Guardando…";

  const record = {
    id: "rec_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
    fields,
    driveFileId: state.driveFileId,
    imageBase64: state.driveFileId ? null : state.imageBase64, // solo se reenvía la imagen si no quedó ya en Drive
    createdAt: new Date().toISOString(),
  };

  try {
    await callBackend("save", {
      driveFileId: record.driveFileId,
      imageBase64: record.imageBase64,
      fields: record.fields,
    });
    showSuccess(fields, false);
  } catch (err) {
    console.warn("Guardado falló, se encola localmente:", err);
    queueRecord(record);
    showSuccess(fields, true);
  } finally {
    els.btnSave.disabled = false;
    els.btnSave.textContent = "Guardar registro";
  }
});

function showSuccess(fields, queued) {
  els.successText.textContent = queued ? "Guardado localmente" : "Guardado correctamente";
  els.successSub.textContent = queued
    ? "Sin conexión: se enviará automáticamente cuando vuelva internet."
    : "Hoja de Ruta " + (fields.hojaRuta || "—");
  showScreen("screen-success");
}

els.btnScanAnother.addEventListener("click", async () => {
  state.autoCaptureLocked = false;
  state.stableCount = 0;
  state.driveFileId = null;
  state.imageBase64 = null;
  state.capturedCanvas = null;
  showScreen("screen-camera");
  await startCamera();
});

// ---------------------------------------------------------------
// Cola local de pendientes (sin conexión)
// ---------------------------------------------------------------
const QUEUE_KEY = "pendingScans";

function getQueue() {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
  } catch {
    return [];
  }
}
function setQueue(list) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(list));
  } catch (err) {
    console.warn("No se pudo guardar la cola local (¿almacenamiento lleno?)", err);
  }
}
function queueRecord(record) {
  const list = getQueue();
  list.push(record);
  setQueue(list);
  renderHistory();
}

async function flushQueue() {
  const list = getQueue();
  if (!list.length) return;
  const remaining = [];
  for (const record of list) {
    try {
      await callBackend("save", {
        driveFileId: record.driveFileId,
        imageBase64: record.imageBase64,
        fields: record.fields,
      });
    } catch (err) {
      remaining.push(record);
    }
  }
  setQueue(remaining);
  renderHistory();
  if (remaining.length < list.length) {
    toast(`${list.length - remaining.length} registro(s) pendiente(s) enviado(s).`);
  }
}

window.addEventListener("online", flushQueue);
setInterval(flushQueue, 45000);

function renderHistory() {
  const list = getQueue();
  els.historyEmpty.classList.toggle("hidden", list.length > 0);
  els.historyList.innerHTML = "";
  list.forEach((r) => {
    const li = document.createElement("li");
    const when = new Date(r.createdAt).toLocaleString("es-CL");
    li.innerHTML = `<strong>${r.fields.hojaRuta || "(sin N° Hoja de Ruta)"}</strong>
      <div class="h-meta">${r.fields.cliente || ""} · ${when}</div>`;
    els.historyList.appendChild(li);
  });
}

els.btnGallery.addEventListener("click", () => {
  renderHistory();
  showScreen("screen-history");
});
els.btnCloseHistory.addEventListener("click", () => showScreen("screen-camera"));

// ---------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------
async function init() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  renderHistory();
  try {
    await waitForOpenCV();
    state.cvReady = true;
  } catch (err) {
    toast("No se pudo cargar el motor de detección de bordes. Podrás igual tomar la foto manualmente.", true);
  }
  await startCamera();
  flushQueue();
}

init();
