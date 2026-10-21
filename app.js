const appShell = document.querySelector(".app-shell");
const loginScreen = document.querySelector("#login-screen");
const loginForm = document.querySelector("#login-form");
const loginError = document.querySelector("#login-error");
const robotConfirm = document.querySelector("#robot-confirm");
const logoutButton = document.querySelector("#logout-button");
const DEMO_ACCOUNTS = {
  "1": { password: "1", role: "teacher", name: "Учитель", description: "Полный доступ", initials: "УЧ" },
  "2": { password: "2", role: "admin", name: "Администратор", description: "Рабочее пространство", initials: "АД" },
  "3": { password: "3", role: "worker", name: "Работник", description: "Доступ к камере", initials: "РБ" },
};
const VALID_ROLES = new Set(Object.values(DEMO_ACCOUNTS).map((account) => account.role));

let currentRole = null;

const video = document.querySelector("#camera-video");
const cameraButton = document.querySelector("#camera-button");
const cameraButtonLabel = document.querySelector("#camera-button-label");
const cameraSelect = document.querySelector("#camera-select");
const cameraLabel = document.querySelector("#selected-camera-label");
const systemStatus = document.querySelector("#system-status");
const monitorStatus = document.querySelector("#monitor-status");
const statusIndicator = document.querySelector(".status-indicator");
const placeholder = document.querySelector("#camera-placeholder");
const previewTitle = document.querySelector("#preview-title");
const previewDescription = document.querySelector("#preview-description");
const liveBadge = document.querySelector("#live-badge");
const cameraError = document.querySelector("#camera-error");
const cameraAlerts = document.querySelector("#camera-alerts");
const menuToggle = document.querySelector("#menu-toggle");
const sidebar = document.querySelector("#sidebar");
const sidebarScrim = document.querySelector("#sidebar-scrim");
const toast = document.querySelector("#toast");
const main = document.querySelector("main");
const workerAlerts = document.querySelector("#worker-alerts");
const historyRows = document.querySelector("#history-rows");

const HISTORY_KEY = "smena-violations-v1";
const EYE_CLOSED_THRESHOLD_MS = 3_000;
const DARKNESS_THRESHOLD_MS = 5_000;
const EYE_CLOSED_RATIO = 0.23;
const DARKNESS_MEAN_LUMA = 40;
const DARKNESS_PIXEL_LUMA = 52;
const DARKNESS_PIXEL_SHARE = 0.7;
const ANALYSIS_INTERVAL_MS = 120;
const MAX_HISTORY_EVENTS = 200;
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const VISION_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/vision_bundle.mjs";
const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm";

const brightnessCanvas = document.createElement("canvas");
brightnessCanvas.width = 32;
brightnessCanvas.height = 24;
const brightnessContext = brightnessCanvas.getContext("2d", { willReadFrequently: true });

let stream = null;
let landmarker = null;
let landmarkerPromise = null;
let analysisFrameId = null;
let lastStatusUpdate = 0;
let lastFrameAt = 0;
let toastTimeout;
let eyeClosedSince = null;
let darknessSince = null;
let eyeIncident = null;
let darknessIncident = null;
let historyEvents = loadHistory();

function loadHistory() {
  try {
    const stored = localStorage.getItem(HISTORY_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) throw new TypeError("Ожидался массив событий");
    return parsed.filter((event) =>
      event
      && typeof event.id === "string"
      && (event.type === "eyes" || event.type === "darkness")
      && typeof event.startedAt === "string"
      && Number.isFinite(Date.parse(event.startedAt))
      && typeof event.durationMs === "number",
    ).slice(0, MAX_HISTORY_EVENTS);
  } catch (error) {
    console.error("Не удалось прочитать историю нарушений:", error);
    window.setTimeout(() => showToast("Не удалось загрузить локальную историю нарушений."), 0);
    return [];
  }
}

function persistHistory() {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(historyEvents));
    renderWorkerData();
  } catch (error) {
    console.error("Не удалось сохранить историю нарушений:", error);
    showToast("Не удалось сохранить историю. Проверьте настройки хранилища браузера.");
  }
}

function updateClock() {
  const now = new Date();
  document.querySelector("#local-time").textContent = new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(now);
  document.querySelector("#local-date").textContent = new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(now);
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => toast.classList.remove("visible"), 4_500);
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes} мин ${seconds} сек` : `${seconds} сек`;
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function isToday(value) {
  const date = new Date(value);
  const now = new Date();
  return date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function renderWorkerData() {
  const activeIncidents = [eyeIncident, darknessIncident].filter(Boolean);
  const activeIds = new Set(activeIncidents.map((event) => event.id));
  const recentEvents = historyEvents
    .filter((event) => !activeIds.has(event.id))
    .slice(0, 5);

  document.querySelector("#active-alert-count").textContent = String(activeIncidents.length);
  document.querySelector("#today-event-count").textContent = String(
    historyEvents.filter((event) => isToday(event.startedAt)).length,
  );

  const navCount = document.querySelector("#nav-alert-count");
  navCount.textContent = String(activeIncidents.length);
  navCount.hidden = activeIncidents.length === 0;

  workerAlerts.replaceChildren();
  if (activeIncidents.length === 0 && recentEvents.length === 0) {
    const empty = createElement("div", "worker-empty");
    empty.append(
      createElement("span", "empty-check", "✓"),
    );
    const text = createElement("div");
    text.append(
      createElement("strong", "", "Пока нет предупреждений"),
      createElement("p", "", "Подключите камеру во вкладке «Камера» — здесь появятся события мониторинга."),
    );
    empty.append(text);
    workerAlerts.append(empty);
  } else {
    activeIncidents.forEach((event) => workerAlerts.append(createAlertCard(event, true)));
    recentEvents.forEach((event) => workerAlerts.append(createAlertCard(event, false)));
  }

  historyRows.replaceChildren();
  if (historyEvents.length === 0) {
    const row = createElement("tr", "history-empty-row");
    const cell = createElement("td", "", "Нарушений пока нет. История появится после срабатывания предупреждения.");
    cell.colSpan = 5;
    row.append(cell);
    historyRows.append(row);
  } else {
    historyEvents.forEach((event) => {
      const row = createElement("tr");
      const eventCell = createElement("td");
      const eventMain = createElement(
        "span",
        "history-event-title",
        event.type === "eyes" ? "Глаза закрыты" : "Полная темнота",
      );
      const eventNote = createElement(
        "span",
        "history-event-note",
        event.type === "eyes" ? "Порог: более 3 секунд" : "Порог: более 5 секунд",
      );
      eventCell.append(eventMain, eventNote);
      row.append(
        eventCell,
        createElement("td", "", event.camera || "Камера 1"),
        createElement("td", "", formatDateTime(event.startedAt)),
        createElement("td", "", event.endedAt ? formatDuration(event.durationMs) : "В процессе"),
      );
      const stateCell = createElement("td");
      const state = createElement(
        "span",
        `history-state ${event.endedAt ? (event.interrupted ? "interrupted" : "resolved") : "ongoing"}`,
        event.endedAt ? (event.interrupted ? "Контроль прерван" : "Завершено") : "Активно",
      );
      stateCell.append(state);
      row.append(stateCell);
      historyRows.append(row);
    });
  }
}

function renderCameraAlerts() {
  const activeIncidents = [eyeIncident, darknessIncident].filter(Boolean);
  cameraAlerts.replaceChildren();
  cameraAlerts.hidden = activeIncidents.length === 0;

  activeIncidents.forEach((event) => {
    const isEyes = event.type === "eyes";
    const elapsed = Math.max(0, Date.now() - Date.parse(event.startedAt));
    const alert = createElement("div", `camera-alert ${isEyes ? "alert-eyes" : "alert-dark"}`);
    alert.append(
      createElement("span", "camera-alert-icon", "!"),
      createElement(
        "strong",
        "",
        isEyes
          ? `Глаза закрыты · ${formatDuration(elapsed)}`
          : `В кадре темно · ${formatDuration(elapsed)}`,
      ),
      createElement("span", "camera-alert-label", "ПРЕДУПРЕЖДЕНИЕ"),
    );
    cameraAlerts.append(alert);
  });
}

function createAlertCard(event, active) {
  const isEyes = event.type === "eyes";
  const card = createElement("article", `worker-alert ${isEyes ? "alert-eyes" : "alert-dark"}${active ? " alert-active" : ""}`);
  const symbol = createElement("span", "alert-symbol", isEyes ? "!" : "◐");
  const content = createElement("div", "alert-content");
  content.append(
    createElement("strong", "", isEyes ? "Глаза закрыты более 3 секунд" : "Обнаружена полная темнота более 5 секунд"),
    createElement(
      "p",
      "",
      active
        ? `Камера: ${event.camera || "Камера 1"} · началось ${formatDateTime(event.startedAt)}`
        : `Камера: ${event.camera || "Камера 1"} · ${formatDateTime(event.startedAt)} · ${formatDuration(event.durationMs)}`,
    ),
  );
  card.append(symbol, content, createElement("span", "alert-state", active ? "АКТИВНО" : "ЗАПИСАНО"));
  return card;
}

function setMonitorStatus(message, running = Boolean(stream), problem = false) {
  monitorStatus.textContent = message;
  const workerStatus = document.querySelector("#worker-live-status");
  workerStatus.classList.toggle("monitor-running", running && !problem);
  workerStatus.classList.toggle("monitor-problem", problem);
  document.querySelector("#worker-live-label").textContent = message;
}

function setConnected(connected) {
  systemStatus.textContent = connected ? "Камера подключена" : "Ожидание подключения";
  statusIndicator.classList.toggle("connected", connected);
  liveBadge.hidden = !connected;
  placeholder.hidden = connected;
  cameraButtonLabel.textContent = connected ? "Отключить камеру" : "Подключить камеру";
  cameraButton.classList.toggle("disconnect-button", connected);
  cameraSelect.disabled = connected;
  if (!connected) {
    monitorStatus.textContent = "Подключите камеру для начала контроля";
    document.querySelector("#last-check-value").textContent = "—";
    document.querySelector("#last-check-caption").textContent = "Камера не подключена";
  }
}

function closeIncident(type, interrupted = false) {
  const incident = type === "eyes" ? eyeIncident : darknessIncident;
  if (!incident) return;
  incident.durationMs = Math.max(0, Date.now() - Date.parse(incident.startedAt));
  incident.endedAt = new Date().toISOString();
  incident.interrupted = interrupted;
  if (type === "eyes") {
    eyeIncident = null;
    eyeClosedSince = null;
  } else {
    darknessIncident = null;
    darknessSince = null;
  }
  persistHistory();
  renderCameraAlerts();
}

function stopMonitoring(interrupted = true) {
  if (analysisFrameId !== null) {
    cancelAnimationFrame(analysisFrameId);
    analysisFrameId = null;
  }
  lastFrameAt = 0;
  eyeClosedSince = null;
  darknessSince = null;
  closeIncident("eyes", interrupted);
  closeIncident("darkness", interrupted);
  if (landmarker) {
    landmarker.close();
    landmarker = null;
  }
  landmarkerPromise = null;
}

function stopCamera(interrupted = false) {
  stopMonitoring(interrupted);
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
  video.srcObject = null;
  cameraLabel.textContent = cameraSelect.selectedOptions[0]?.textContent || "Камера 1";
  setConnected(false);
  setMonitorStatus("Мониторинг не запущен", false);
  liveBadge.hidden = true;
  previewTitle.textContent = "Камера не подключена";
  previewDescription.textContent = "Разрешите доступ к камере, чтобы увидеть предпросмотр";
  renderWorkerData();
}

function getCameraError(error) {
  if (error.name === "NotAllowedError" || error.name === "SecurityError") {
    return "Доступ запрещён. Разрешите использование камеры в настройках браузера и попробуйте снова.";
  }
  if (error.name === "NotFoundError" || error.name === "OverconstrainedError") {
    return "Выбранная камера не найдена. Подключите камеру или выберите другое устройство.";
  }
  if (error.name === "NotReadableError") {
    return "Камера занята другим приложением. Закройте его и попробуйте снова.";
  }
  return "Не удалось подключить камеру. Проверьте подключение устройства и настройки браузера.";
}

async function refreshCameras() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter((device) => device.kind === "videoinput");
  const selectedId = cameraSelect.value;
  cameraSelect.replaceChildren();

  if (cameras.length === 0) {
    cameraSelect.add(new Option("Камера не найдена", ""));
    cameraSelect.disabled = true;
    cameraLabel.textContent = "Нет устройств";
    return;
  }

  cameras.forEach((camera, index) => {
    const label = camera.label || `Камера ${index + 1}`;
    cameraSelect.add(new Option(label, camera.deviceId));
  });

  if (cameras.some((camera) => camera.deviceId === selectedId)) {
    cameraSelect.value = selectedId;
  }
  cameraSelect.disabled = Boolean(stream);
  cameraLabel.textContent = cameraSelect.selectedOptions[0].textContent;
}

function loadFaceLandmarker() {
  if (landmarker) return Promise.resolve(landmarker);
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const vision = await import(VISION_URL);
      const fileset = await vision.FilesetResolver.forVisionTasks(WASM_URL);
      landmarker = await vision.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: MODEL_URL,
          delegate: "CPU",
        },
        runningMode: "VIDEO",
        numFaces: 1,
        minFaceDetectionConfidence: 0.55,
        minFacePresenceConfidence: 0.55,
        minTrackingConfidence: 0.5,
      });
      return landmarker;
    })().catch((error) => {
      landmarkerPromise = null;
      throw error;
    });
  }
  return landmarkerPromise;
}

function distance2D(first, second) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function eyeAspectRatio(landmarks, points) {
  const [outer, upperA, upperB, inner, lowerB, lowerA] = points.map((index) => landmarks[index]);
  const horizontal = distance2D(outer, inner);
  if (!horizontal) return 1;
  return (distance2D(upperA, lowerA) + distance2D(upperB, lowerB)) / (2 * horizontal);
}

function isEyesClosed(landmarks) {
  const leftRatio = eyeAspectRatio(landmarks, [33, 160, 158, 133, 153, 144]);
  const rightRatio = eyeAspectRatio(landmarks, [362, 385, 387, 263, 373, 380]);
  return leftRatio < EYE_CLOSED_RATIO && rightRatio < EYE_CLOSED_RATIO;
}

function measureFrameBrightness() {
  if (!brightnessContext || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
  brightnessContext.drawImage(video, 0, 0, brightnessCanvas.width, brightnessCanvas.height);
  const pixels = brightnessContext.getImageData(0, 0, brightnessCanvas.width, brightnessCanvas.height).data;
  let luminanceTotal = 0;
  let nearBlackPixels = 0;

  for (let index = 0; index < pixels.length; index += 4) {
    const luminance = (0.2126 * pixels[index]) + (0.7152 * pixels[index + 1]) + (0.0722 * pixels[index + 2]);
    luminanceTotal += luminance;
    if (luminance <= DARKNESS_PIXEL_LUMA) nearBlackPixels += 1;
  }

  const pixelCount = pixels.length / 4;
  const averageLuminance = luminanceTotal / pixelCount;
  const darkPixelShare = nearBlackPixels / pixelCount;
  return {
    averageLuminance,
    dark: averageLuminance <= DARKNESS_MEAN_LUMA && darkPixelShare >= DARKNESS_PIXEL_SHARE,
  };
}

function beginIncident(type, detectedAt, now) {
  const incident = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    type,
    camera: cameraSelect.selectedOptions[0]?.textContent || "Камера 1",
    startedAt: new Date(Date.now() - (now - detectedAt)).toISOString(),
    durationMs: now - detectedAt,
    endedAt: null,
    interrupted: false,
  };

  if (type === "eyes") eyeIncident = incident;
  else darknessIncident = incident;

  historyEvents.unshift(incident);
  historyEvents = historyEvents.slice(0, MAX_HISTORY_EVENTS);
  persistHistory();
  renderCameraAlerts();
  showToast(type === "eyes"
    ? "Предупреждение: глаза закрыты более 3 секунд."
    : "Предупреждение: в кадре полная темнота более 5 секунд.");
}

function updateCondition(type, condition, now, threshold) {
  const since = type === "eyes" ? eyeClosedSince : darknessSince;
  const incident = type === "eyes" ? eyeIncident : darknessIncident;

  if (!condition) {
    if (type === "eyes") eyeClosedSince = null;
    else darknessSince = null;
    if (incident) closeIncident(type, false);
    return;
  }

  const detectedAt = since ?? now;
  if (type === "eyes") eyeClosedSince = detectedAt;
  else darknessSince = detectedAt;

  if (!incident && now - detectedAt > threshold) {
    beginIncident(type, detectedAt, now);
  }
}

function updateLastCheck(now, faceDetected, brightness) {
  if (now - lastStatusUpdate < 1_000) return;
  lastStatusUpdate = now;
  document.querySelector("#last-check-value").textContent = new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date());
  document.querySelector("#last-check-caption").textContent = brightness?.dark
    ? `Тёмный кадр · яркость ${Math.round(brightness.averageLuminance)}/255`
    : brightness
      ? `Яркость ${Math.round(brightness.averageLuminance)}/255 · кадр виден`
      : "Ожидание кадра камеры";
  if (brightness?.dark) setMonitorStatus("Контроль активен · обнаружен тёмный кадр");
  else if (!faceDetected) setMonitorStatus("Контроль активен · лицо не обнаружено");
  else setMonitorStatus("Анализ лица и освещения активен");
}

function analyzeFrame(now) {
  if (!stream || !landmarker || !video.srcObject) {
    analysisFrameId = null;
    return;
  }

  if (document.hidden || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    eyeClosedSince = null;
    darknessSince = null;
    analysisFrameId = requestAnimationFrame(analyzeFrame);
    return;
  }

  if (lastFrameAt && now - lastFrameAt < ANALYSIS_INTERVAL_MS) {
    analysisFrameId = requestAnimationFrame(analyzeFrame);
    return;
  }

  if (lastFrameAt && now - lastFrameAt > 1_500) {
    eyeClosedSince = null;
    darknessSince = null;
    closeIncident("eyes", true);
    closeIncident("darkness", true);
  }
  lastFrameAt = now;

  try {
    const result = landmarker.detectForVideo(video, now);
    const landmarks = result.faceLandmarks?.[0];
    const brightness = measureFrameBrightness();
    updateCondition("darkness", Boolean(brightness?.dark), now, DARKNESS_THRESHOLD_MS);
    updateCondition(
      "eyes",
      Boolean(landmarks && isEyesClosed(landmarks)),
      now,
      EYE_CLOSED_THRESHOLD_MS,
    );
    updateLastCheck(now, Boolean(landmarks), brightness);
  } catch (error) {
    console.error("Ошибка анализа кадра камеры:", error);
    stopMonitoring(true);
    setMonitorStatus("Анализ остановлен из-за ошибки", true, true);
    showToast("Не удалось обработать видео. Переподключите камеру.");
    return;
  }

  analysisFrameId = requestAnimationFrame(analyzeFrame);
}

async function startMonitoring() {
  setMonitorStatus("Загрузка модели распознавания…");
  try {
    await loadFaceLandmarker();
    if (!stream) return;
    setMonitorStatus("Анализ лица и освещения активен");
    lastFrameAt = 0;
    analysisFrameId = requestAnimationFrame(analyzeFrame);
  } catch (error) {
    console.error("Не удалось загрузить модель распознавания лица:", error);
    setMonitorStatus("Модель анализа недоступна", true, true);
    showToast("Не удалось загрузить модель анализа. Проверьте интернет-соединение и попробуйте переподключить камеру.");
  }
}

async function connectCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    cameraError.textContent = "Браузер не поддерживает доступ к камере. Откройте сайт через защищённое соединение (HTTPS) или localhost.";
    cameraError.hidden = false;
    return;
  }

  cameraError.hidden = true;
  cameraButton.disabled = true;
  cameraButtonLabel.textContent = "Подключение…";

  try {
    const deviceId = cameraSelect.value;
    const constraints = {
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
        : { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
    };

    stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;
    await video.play();

    try {
      await refreshCameras();
      const activeTrack = stream.getVideoTracks()[0];
      if (activeTrack) {
        const activeDeviceId = activeTrack.getSettings().deviceId;
        if (activeDeviceId) cameraSelect.value = activeDeviceId;
      }
    } catch (error) {
      console.error("Не удалось получить список камер:", error);
    }

    cameraLabel.textContent = cameraSelect.selectedOptions[0]?.textContent || "Камера 1";
    setConnected(true);
    previewTitle.textContent = "Предпросмотр активен";
    previewDescription.textContent = "Кадры анализируются локально и не отправляются на сервер";
    void startMonitoring();

    stream.getVideoTracks().forEach((track) => {
      track.addEventListener("ended", () => {
        stopCamera(true);
        showToast("Камера отключилась.");
      }, { once: true });
    });
  } catch (error) {
    console.error("Не удалось подключить камеру:", error);
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
    video.srcObject = null;
    cameraSelect.disabled = false;
    cameraError.textContent = getCameraError(error);
    cameraError.hidden = false;
    cameraButtonLabel.textContent = "Подключить камеру";
    previewTitle.textContent = "Не удалось подключиться";
    previewDescription.textContent = "Проверьте разрешение браузера и подключение камеры";
  } finally {
    cameraButton.disabled = false;
    if (stream) cameraButtonLabel.textContent = "Отключить камеру";
  }
}

cameraButton.addEventListener("click", () => {
  if (stream) {
    stopCamera();
    cameraError.hidden = true;
  } else {
    connectCamera();
  }
});

cameraSelect.addEventListener("change", () => {
  cameraLabel.textContent = cameraSelect.selectedOptions[0]?.textContent || "Камера 1";
});

navigator.mediaDevices?.addEventListener?.("devicechange", () => {
  if (!stream) {
    refreshCameras().catch((error) => {
      console.error("Не удалось обновить список камер:", error);
      showToast("Не удалось обновить список камер.");
    });
  }
});

function closeMenu() {
  sidebar.classList.remove("open");
  sidebarScrim.classList.remove("visible");
  menuToggle.setAttribute("aria-expanded", "false");
  menuToggle.setAttribute("aria-label", "Открыть меню");
}

function updatePage() {
  if (!currentRole) return;

  const requestedRoute = window.location.hash;
  const allowedRoutes = currentRole === "teacher"
    ? new Set(["#home", "#camera", "#about", "#workers"])
    : currentRole === "admin"
      ? new Set(["#home", "#camera", "#workers"])
      : new Set(["#camera"]);
  const route = allowedRoutes.has(requestedRoute)
    ? requestedRoute
    : currentRole === "worker" ? "#camera" : "#home";
  if (route !== requestedRoute) {
    window.location.hash = route;
  }
  const isWorkers = route === "#workers";
  const isAbout = route === "#about";
  const isCamera = route === "#camera";
  main.dataset.view = isWorkers ? "workers" : isAbout ? "about" : isCamera ? "camera" : "home";
  document.querySelector("#breadcrumb-parent").textContent = "Рабочее пространство";
  document.querySelector("#breadcrumb-current").textContent = isWorkers
    ? "Кабинет работников"
    : isAbout ? "О проекте" : route === "#camera" ? "Камера" : "Главная";
  document.title = isWorkers
    ? "Кабинет работников — FocusDrive"
    : isAbout ? "О проекте — FocusDrive"
      : route === "#camera" ? "Модуль видеоконтроля — FocusDrive"
        : "FocusDrive — безопасность водителей";

  const activeHref = isWorkers
    ? "#workers"
    : isAbout ? "#about"
      : route === "#camera" ? "#camera" : "#home";
  sidebar.querySelectorAll(".nav-link").forEach((link) => {
    const active = link.getAttribute("href") === activeHref;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

function activateRole(role) {
  const account = Object.values(DEMO_ACCOUNTS).find((entry) => entry.role === role);
  if (!account) return;

  currentRole = role;
  document.body.dataset.role = role;
  document.querySelector("#user-role-name").textContent = account.name;
  document.querySelector("#user-role-description").textContent = account.description;
  document.querySelector(".avatar").textContent = account.initials;
  const topbarAvatar = document.querySelector("#topbar-avatar");
  topbarAvatar.textContent = account.initials;
  topbarAvatar.setAttribute("aria-label", account.name);
  appShell.hidden = false;
  loginScreen.hidden = true;
  window.location.hash = role === "worker" ? "#camera" : "#home";
  updatePage();
}

loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const username = document.querySelector("#login-username").value.trim();
  const password = document.querySelector("#login-password").value;
  const account = DEMO_ACCOUNTS[username];

  loginError.hidden = true;
  loginError.textContent = "";
  if (!username || !password) {
    loginError.textContent = "Введите логин и пароль.";
  } else if (!robotConfirm.checked) {
    loginError.textContent = "Подтвердите отметку «Я не робот», чтобы продолжить.";
  } else if (!account || account.password !== password) {
    loginError.textContent = "Неверный логин или пароль.";
  } else {
    sessionStorage.setItem("smena-role", account.role);
    activateRole(account.role);
    return;
  }

  loginError.hidden = false;
});

logoutButton.addEventListener("click", () => {
  stopCamera();
  sessionStorage.removeItem("smena-role");
  currentRole = null;
  delete document.body.dataset.role;
  appShell.hidden = true;
  loginScreen.hidden = false;
  loginForm.reset();
  loginError.hidden = true;
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  document.querySelector("#login-username").focus();
});

menuToggle.addEventListener("click", () => {
  const isOpen = menuToggle.getAttribute("aria-expanded") === "true";
  menuToggle.setAttribute("aria-expanded", String(!isOpen));
  menuToggle.setAttribute("aria-label", isOpen ? "Открыть меню" : "Закрыть меню");
  sidebar.classList.toggle("open", !isOpen);
  sidebarScrim.classList.toggle("visible", !isOpen);
});

sidebarScrim.addEventListener("click", closeMenu);
sidebar.querySelectorAll(".nav-link").forEach((link) => {
  link.addEventListener("click", () => {
    closeMenu();
    if (window.location.hash === link.getAttribute("href")) updatePage();
  });
});

window.addEventListener("hashchange", updatePage);
document.querySelector("#clear-history").addEventListener("click", () => {
  const activeIds = new Set([eyeIncident, darknessIncident].filter(Boolean).map((event) => event.id));
  const retainedEvents = historyEvents.filter((event) => activeIds.has(event.id));
  if (retainedEvents.length === historyEvents.length) {
    showToast("История уже пуста.");
    return;
  }
  if (!window.confirm("Удалить все завершённые записи о нарушениях?")) return;
  historyEvents = retainedEvents;
  persistHistory();
  showToast("Завершённые записи удалены.");
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    eyeClosedSince = null;
    darknessSince = null;
    closeIncident("eyes", true);
    closeIncident("darkness", true);
  }
});

window.addEventListener("pagehide", () => stopCamera(true));
updateClock();
const storedRole = sessionStorage.getItem("smena-role");
if (storedRole && VALID_ROLES.has(storedRole)) {
  activateRole(storedRole);
} else {
  sessionStorage.removeItem("smena-role");
  document.querySelector("#login-username").focus();
}
updatePage();
const interruptedEvents = historyEvents.filter((event) => !event.endedAt);
interruptedEvents.forEach((event) => {
  event.endedAt = new Date().toISOString();
  event.durationMs = Math.max(event.durationMs, Date.now() - Date.parse(event.startedAt));
  event.interrupted = true;
});
if (interruptedEvents.length) persistHistory();
renderWorkerData();
window.setInterval(updateClock, 60_000);
navigator.mediaDevices?.enumerateDevices?.().then((devices) => {
  const cameras = devices.filter((device) => device.kind === "videoinput");
  if (cameras.length) {
    cameraSelect.replaceChildren(...cameras.map((camera, index) => new Option(camera.label || `Камера ${index + 1}`, camera.deviceId)));
    cameraLabel.textContent = cameraSelect.selectedOptions[0].textContent;
  }
}).catch((error) => {
  console.error("Не удалось получить список камер:", error);
});
