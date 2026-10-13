const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const refs = {
  photoInput: $("#photoInput"),
  folderInput: $("#folderInput"),
  logoInput: $("#logoInput"),
  previewCanvas: $("#previewCanvas"),
  previewFrame: $("#previewFrame"),
  emptyPreview: $("#emptyPreview"),
  loadingPreview: $("#loadingPreview"),
  fullscreenCloseButton: $("#fullscreenCloseButton"),
  yawSlider: $("#yawSlider"),
  pitchSlider: $("#pitchSlider"),
  rollSlider: $("#rollSlider"),
  fovSlider: $("#fovSlider"),
  yawValue: $("#yawValue"),
  pitchValue: $("#pitchValue"),
  rollValue: $("#rollValue"),
  fileInfo: $("#fileInfo"),
  viewInfo: $("#viewInfo"),
  fixedText: $("#fixedText"),
  privacyStatus: $("#privacyStatus"),
  saveProgress: $("#saveProgress"),
  progressBar: $("#progressBar"),
  privacyProgress: $("#privacyProgress"),
  privacyProgressBar: $("#privacyProgressBar"),
  privacyDialog: $("#privacyDialog"),
  helpDialog: $("#helpDialog"),
  privacyHelpDialog: $("#privacyHelpDialog"),
  folderDialog: $("#folderDialog"),
  overwriteDialog: $("#overwriteDialog"),
  settingsDialog: $("#settingsDialog"),
  previewTip: $("#previewTip"),
  logoName: $("#logoName"),
  privacyRow: $(".privacy-row"),
};

const privacyRowHome = document.createComment("privacy-row-home");
refs.privacyRow.before(privacyRowHome);
if (!refs.loadingPreview) {
  refs.loadingPreview = document.createElement("div");
  refs.loadingPreview.id = "loadingPreview";
  refs.loadingPreview.className = "loading-preview hidden";
  refs.loadingPreview.setAttribute("aria-live", "polite");
  refs.loadingPreview.innerHTML = '<div class="loader"></div><strong>Caricamento foto in corso...</strong>';
  refs.previewFrame.appendChild(refs.loadingPreview);
}
if (!refs.fullscreenCloseButton) {
  refs.fullscreenCloseButton = document.createElement("button");
  refs.fullscreenCloseButton.id = "fullscreenCloseButton";
  refs.fullscreenCloseButton.className = "fullscreen-close hidden";
  refs.fullscreenCloseButton.type = "button";
  refs.fullscreenCloseButton.title = "Torna all'anteprima piccola";
  refs.fullscreenCloseButton.setAttribute("aria-label", "Torna all'anteprima piccola");
  refs.fullscreenCloseButton.textContent = "×";
  refs.previewFrame.appendChild(refs.fullscreenCloseButton);
}
if (!refs.privacyProgress) {
  refs.privacyProgress = document.createElement("div");
  refs.privacyProgress.id = "privacyProgress";
  refs.privacyProgress.className = "privacy-progress hidden";
  refs.privacyProgress.setAttribute("aria-live", "polite");
  refs.privacyProgress.innerHTML = '<strong>Salvataggio privacy in corso</strong><div class="privacy-progress-track"><div id="privacyProgressBar" class="privacy-progress-bar"></div></div>';
  refs.privacyRow.insertBefore(refs.privacyProgress, refs.privacyStatus);
  refs.privacyProgressBar = $("#privacyProgressBar");
}

const sourceCanvas = document.createElement("canvas");
const sourceCtx = sourceCanvas.getContext("2d", { willReadFrequently: true });
const previewCtx = refs.previewCanvas.getContext("2d", { willReadFrequently: true });

const state = {
  file: null,
  sourceData: null,
  sourceWidth: 0,
  sourceHeight: 0,
  folderFiles: [],
  folderIndex: -1,
  folderHandle: null,
  fileHandle: null,
  yaw: 0,
  pitch: 0,
  roll: 0,
  fov: 80,
  masks: [],
  activeTool: "",
  renderToken: 0,
  saving: false,
  savingMode: "",
  loading: false,
  lastOutputName: "",
  lastSavedUrl: "",
  settings: {
    orientedSuffix: "_ORIENTATA",
    maskedSuffix: "_MASCHERATO",
    jpegQuality: 0.98,
  },
  viewFixed: false,
  fixedYaw: 0,
  fixedPitch: 0,
  fixedRoll: 0,
  nadir: {
    effect: "mosaic",
    size: 26,
    mosaicScale: 1,
    logoImage: null,
    logoCanvas: null,
    logoData: null,
    logoName: "",
    logoOpacity: 0.78,
    logoFeather: 0.22,
    logoOval: 0,
    logoRotation: 0,
    logoOffsetX: 0,
    logoOffsetY: 0,
  },
};

const supportedFolderImagePattern = /\.(jpe?g|png)$/i;
const degToRad = Math.PI / 180;
const radToDeg = 180 / Math.PI;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function wrapLon(lon) {
  let wrapped = ((lon + 180) % 360 + 360) % 360 - 180;
  return wrapped === -180 ? 180 : wrapped;
}

function wrapDelta(delta) {
  return ((delta + 180) % 360 + 360) % 360 - 180;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function rotateVector(vector, yawDeg, pitchDeg, rollDeg) {
  let [x, y, z] = vector;

  const roll = rollDeg * degToRad;
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  let nx = cr * x - sr * y;
  let ny = sr * x + cr * y;
  x = nx;
  y = ny;

  const pitch = -pitchDeg * degToRad;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  ny = cp * y - sp * z;
  let nz = sp * y + cp * z;
  y = ny;
  z = nz;

  const yaw = yawDeg * degToRad;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  nx = cy * x + sy * z;
  nz = -sy * x + cy * z;
  return [nx, y, nz];
}

function lonLatFromVector(vector) {
  const [x, y, z] = vector;
  const lon = Math.atan2(x, z) * radToDeg;
  const lat = Math.asin(clamp(y, -1, 1)) * radToDeg;
  return [lon, lat];
}

function vectorFromLonLat(lonDeg, latDeg) {
  const lon = lonDeg * degToRad;
  const lat = latDeg * degToRad;
  const cosLat = Math.cos(lat);
  return [cosLat * Math.sin(lon), Math.sin(lat), cosLat * Math.cos(lon)];
}

function viewPointToLonLat(x, y, width, height) {
  const aspect = width / Math.max(1, height);
  const tanHalf = Math.tan((state.fov * degToRad) / 2);
  const nx = (2 * (x + 0.5) / width - 1) * aspect * tanHalf;
  const ny = (1 - 2 * (y + 0.5) / height) * tanHalf;
  const invLen = 1 / Math.hypot(nx, ny, 1);
  return lonLatFromVector(rotateVector([nx * invLen, ny * invLen, invLen], state.yaw, state.pitch, state.roll));
}

function sourceCoordinate(lon, lat) {
  const x = (((lon + 180) / 360) * state.sourceWidth + state.sourceWidth) % state.sourceWidth;
  const y = clamp(((90 - lat) / 180) * state.sourceHeight, 0, state.sourceHeight - 1);
  return [x, y];
}

function nearestPixel(x, y) {
  const sx = ((Math.round(x) % state.sourceWidth) + state.sourceWidth) % state.sourceWidth;
  const sy = clamp(Math.round(y), 0, state.sourceHeight - 1);
  const index = (sy * state.sourceWidth + sx) * 4;
  const data = state.sourceData;
  return [data[index], data[index + 1], data[index + 2], 255];
}

function mosaicPixel(lon, lat, blockSize) {
  const [x, y] = sourceCoordinate(lon, lat);
  const bx = Math.floor(x / blockSize) * blockSize + blockSize / 2;
  const by = Math.floor(y / blockSize) * blockSize + blockSize / 2;
  return nearestPixel(bx, by);
}

function maskContains(mask, lon, lat) {
  if (mask.shape === "cap") {
    const distance = mask.lat < 0 ? lat + 90 : 90 - lat;
    return distance >= 0 && distance <= mask.ry;
  }

  const dx = wrapDelta(lon - mask.lon);
  const dy = lat - mask.lat;
  if (mask.shape === "rect") {
    return Math.abs(dx) <= mask.rx && Math.abs(dy) <= mask.ry;
  }
  return (dx * dx) / (mask.rx * mask.rx) + (dy * dy) / (mask.ry * mask.ry) <= 1;
}

function logoPixelForNadir(lon, lat, baseColor) {
  const nadir = state.nadir;
  if (!nadir.logoData || lat < -90 || lat > -90 + nadir.size) {
    return null;
  }

  const radius = (lat + 90) / Math.max(1, nadir.size);
  let x = Math.sin(lon * degToRad) * radius - nadir.logoOffsetX;
  let y = -Math.cos(lon * degToRad) * radius - nadir.logoOffsetY;

  const rot = -nadir.logoRotation * degToRad;
  const cr = Math.cos(rot);
  const sr = Math.sin(rot);
  const rx = cr * x - sr * y;
  const ry = sr * x + cr * y;
  x = rx;
  y = ry;

  const oval = nadir.logoOval / 100;
  const scaleX = oval < 0 ? 1 + Math.abs(oval) : 1 - Math.min(0.45, oval * 0.55);
  const scaleY = oval > 0 ? 1 + oval : 1 - Math.min(0.45, Math.abs(oval) * 0.55);
  x /= Math.max(0.25, scaleX);
  y /= Math.max(0.25, scaleY);

  const logoRadius = Math.hypot(x, y);
  if (logoRadius > 1) {
    return null;
  }

  const lx = clamp(Math.round(((x + 1) / 2) * (nadir.logoCanvas.width - 1)), 0, nadir.logoCanvas.width - 1);
  const ly = clamp(Math.round(((y + 1) / 2) * (nadir.logoCanvas.height - 1)), 0, nadir.logoCanvas.height - 1);
  const index = (ly * nadir.logoCanvas.width + lx) * 4;
  const data = nadir.logoData.data;
  let alpha = (data[index + 3] / 255) * nadir.logoOpacity;

  if (nadir.logoFeather > 0 && logoRadius > 1 - nadir.logoFeather) {
    alpha *= clamp((1 - logoRadius) / nadir.logoFeather, 0, 1);
  }
  if (alpha <= 0.01) {
    return null;
  }

  return [
    Math.round(baseColor[0] * (1 - alpha) + data[index] * alpha),
    Math.round(baseColor[1] * (1 - alpha) + data[index + 1] * alpha),
    Math.round(baseColor[2] * (1 - alpha) + data[index + 2] * alpha),
    255,
  ];
}

function sampleColor(lon, lat, includeMasks) {
  let color = nearestPixel(...sourceCoordinate(lon, lat));
  if (!includeMasks || state.masks.length === 0) {
    return color;
  }

  for (const mask of state.masks) {
    if (!maskContains(mask, lon, lat)) {
      continue;
    }
    if (mask.tool === "nadir" && state.nadir.effect === "logo") {
      const logoColor = logoPixelForNadir(lon, lat, color);
      if (logoColor) {
        color = logoColor;
        continue;
      }
    }
    const block = Math.max(5, Math.round((mask.tool === "nadir" ? 28 : 16) * state.nadir.mosaicScale));
    color = mosaicPixel(lon, lat, block);
  }
  return color;
}

function renderPerspective() {
  if (!state.sourceData || state.saving) {
    return;
  }

  const rect = refs.previewFrame.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const width = Math.max(640, Math.round(rect.width * dpr));
  const height = Math.max(260, Math.round(rect.height * dpr));
  if (refs.previewCanvas.width !== width || refs.previewCanvas.height !== height) {
    refs.previewCanvas.width = width;
    refs.previewCanvas.height = height;
  }

  const token = ++state.renderToken;
  window.requestAnimationFrame(() => {
    if (token !== state.renderToken || !state.sourceData) {
      return;
    }
    const imageData = previewCtx.createImageData(width, height);
    const out = imageData.data;
    const aspect = width / height;
    const tanHalf = Math.tan((state.fov * degToRad) / 2);
    let index = 0;
    for (let y = 0; y < height; y++) {
      const ny = (1 - 2 * (y + 0.5) / height) * tanHalf;
      for (let x = 0; x < width; x++) {
        const nx = (2 * (x + 0.5) / width - 1) * aspect * tanHalf;
        const invLen = 1 / Math.hypot(nx, ny, 1);
        const [lon, lat] = lonLatFromVector(
          rotateVector([nx * invLen, ny * invLen, invLen], state.yaw, state.pitch, state.roll)
        );
        const color = sampleColor(lon, lat, true);
        out[index++] = color[0];
        out[index++] = color[1];
        out[index++] = color[2];
        out[index++] = 255;
      }
    }
    previewCtx.putImageData(imageData, 0, 0);
  });
}

function schedulePreview() {
  updateLabels();
  renderPerspective();
}

function updateLabels() {
  refs.yawValue.textContent = `${state.yaw.toFixed(1)}°`;
  refs.pitchValue.textContent = `${state.pitch.toFixed(1)}°`;
  refs.rollValue.textContent = `${state.roll.toFixed(1)}°`;
  refs.viewInfo.textContent = `Yaw ${state.yaw.toFixed(2)}° · Pitch ${state.pitch.toFixed(2)}° · Roll ${state.roll.toFixed(2)}° · FOV ${state.fov.toFixed(2)}°`;
  refs.yawSlider.value = state.yaw;
  refs.pitchSlider.value = state.pitch;
  refs.rollSlider.value = state.roll;
  refs.fovSlider.value = state.fov;
}

function updateControls() {
  const hasPhoto = Boolean(state.sourceData);
  const busy = state.saving || state.loading;
  $("#saveOrientedButton").disabled = !hasPhoto || busy;
  $("#overwriteButton").disabled = !hasPhoto || busy;
  $("#saveNextButton").disabled = !hasPhoto || busy || state.folderFiles.length <= 1 || state.folderIndex >= state.folderFiles.length - 1;
  $("#savePrivacyButton").disabled = !hasPhoto || busy || state.masks.length === 0;
  $("#resetPrivacyButton").disabled = !hasPhoto || busy || state.masks.length === 0;
  $("#previousButton").disabled = busy || state.folderFiles.length <= 1 || state.folderIndex <= 0;
  $("#nextButton").disabled = busy || state.folderFiles.length <= 1 || state.folderIndex >= state.folderFiles.length - 1;
  $("#refreshFolderButton").disabled = busy || state.folderFiles.length === 0;
  $("#openViewerButton").disabled = !state.lastSavedUrl;
  refs.emptyPreview.classList.toggle("hidden", hasPhoto || state.loading);
  refs.loadingPreview.classList.toggle("hidden", !state.loading);
  refs.privacyStatus.textContent = hasPhoto
    ? (state.masks.length ? `${state.masks.length} mascheramenti pronti.` : "Verifica foto corrente.")
    : "Verifica foto corrente.";
  $$(".privacy-button[data-tool]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tool === state.activeTool);
  });
  updateNadirDialog();
}

function probable360(file, bitmap) {
  if (!$("#filter360").checked) {
    return true;
  }
  const ratio = bitmap.width / Math.max(1, bitmap.height);
  if (ratio > 1.85 && ratio < 2.15) {
    return true;
  }
  return /360|pano|panorama|equi|sfer|sphere|vr/i.test(file.name);
}

function isSupportedFolderImage(file) {
  return supportedFolderImagePattern.test(file.name);
}

function folderSortKey(file) {
  return file.relativePath || file.webkitRelativePath || file.name;
}

function rememberRelativePath(file, path) {
  try {
    Object.defineProperty(file, "relativePath", { value: path, configurable: true });
  } catch {
    file.relativePath = path;
  }
  return file;
}

function rememberFileHandle(file, fileHandle, parentDirectoryHandle = null) {
  if (!fileHandle) {
    return file;
  }
  try {
    Object.defineProperty(file, "fileHandle", { value: fileHandle, configurable: true });
    Object.defineProperty(file, "parentDirectoryHandle", { value: parentDirectoryHandle, configurable: true });
  } catch {
    file.fileHandle = fileHandle;
    file.parentDirectoryHandle = parentDirectoryHandle;
  }
  return file;
}

function sortFolderFiles(files) {
  return files
    .filter(isSupportedFolderImage)
    .sort((a, b) => folderSortKey(a).localeCompare(folderSortKey(b), "it", { numeric: true, sensitivity: "base" }));
}

async function collectDirectoryImages(directoryHandle, prefix = "") {
  const files = [];
  for await (const [name, handle] of directoryHandle.entries()) {
    const path = `${prefix}${name}`;
    if (handle.kind === "file") {
      if (supportedFolderImagePattern.test(name)) {
        const file = await handle.getFile();
        files.push(rememberFileHandle(rememberRelativePath(file, path), handle, directoryHandle));
      }
    } else if (handle.kind === "directory") {
      files.push(...await collectDirectoryImages(handle, `${path}/`));
    }
  }
  return files;
}

async function loadFolderFiles(files) {
  const sortedFiles = sortFolderFiles(files);
  if (!sortedFiles.length) {
    alert("Nella cartella scelta non ho trovato immagini JPG, JPEG o PNG.");
    return;
  }
  await loadPhoto(sortedFiles[0], { files: sortedFiles, index: 0 });
}

async function refreshFolder(keepCurrent = true) {
  if (!state.folderHandle) {
    alert("Per aggiornare la cartella online occorre riaprire la cartella: il browser non conserva l'accesso diretto in questa modalità.");
    openFolderSelection();
    return;
  }
  const currentKey = keepCurrent && state.file ? folderSortKey(state.file) : "";
  setLoading(true, "Aggiornamento cartella in corso...");
  try {
    const files = sortFolderFiles(await collectDirectoryImages(state.folderHandle));
    if (!files.length) {
      alert("Nella cartella scelta non ho trovato immagini JPG, JPEG o PNG.");
      state.folderFiles = [];
      state.folderIndex = -1;
      updateControls();
      return;
    }
    const nextIndex = Math.max(0, files.findIndex((file) => folderSortKey(file) === currentKey));
    await loadPhoto(files[nextIndex], { files, index: nextIndex });
  } finally {
    setLoading(false);
    renderPerspective();
  }
}

async function openFolderSelection() {
  if (window.showDirectoryPicker) {
    try {
      const directoryHandle = await window.showDirectoryPicker({ mode: "readwrite" });
      state.folderHandle = directoryHandle;
      setLoading(true, "Lettura cartella in corso...");
      const files = await collectDirectoryImages(directoryHandle);
      await loadFolderFiles(files);
    } catch (error) {
      if (error.name !== "AbortError") {
        console.error(error);
        alert(`Impossibile leggere la cartella: ${error.message}`);
      }
    } finally {
      setLoading(false);
      renderPerspective();
    }
    return;
  }
  state.folderHandle = null;
  refs.folderInput.value = "";
  refs.folderInput.click();
}

async function openSinglePhotoSelection() {
  if (window.showOpenFilePicker) {
    try {
      const [fileHandle] = await window.showOpenFilePicker({
        multiple: false,
        types: [{
          description: "Foto 360",
          accept: { "image/*": [".jpg", ".jpeg", ".png"] },
        }],
      });
      const file = rememberFileHandle(await fileHandle.getFile(), fileHandle);
      state.folderHandle = null;
      await loadPhoto(file);
    } catch (error) {
      if (error.name !== "AbortError") {
        console.error(error);
        alert(`Impossibile aprire la foto: ${error.message}`);
      }
    }
    return;
  }
  state.folderHandle = null;
  refs.photoInput.value = "";
  refs.photoInput.click();
}

async function loadPhoto(file, folderContext = null) {
  if (!file) {
    return;
  }
  setLoading(true, "Caricamento foto in corso...");
  try {
    await nextFrame();
    const bitmap = await createImageBitmap(file, { imageOrientation: "none" });
    if (!probable360(file, bitmap)) {
      setLoading(false);
      alert("La foto selezionata non sembra una panoramica 360. Disattiva il filtro se vuoi aprirla comunque.");
      bitmap.close?.();
      return;
    }

    sourceCanvas.width = bitmap.width;
    sourceCanvas.height = bitmap.height;
    sourceCtx.drawImage(bitmap, 0, 0);
    bitmap.close?.();

    const imageData = sourceCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
    state.file = file;
    state.fileHandle = file.fileHandle || null;
    state.sourceData = imageData.data;
    state.sourceWidth = sourceCanvas.width;
    state.sourceHeight = sourceCanvas.height;
    state.masks = [];
    state.activeTool = "";
    state.lastOutputName = "";
    state.viewFixed = false;
    state.fixedYaw = 0;
    state.fixedPitch = 0;
    state.fixedRoll = 0;
    if (folderContext) {
      state.folderFiles = folderContext.files;
      state.folderIndex = folderContext.index;
    } else {
      state.folderFiles = [];
      state.folderIndex = -1;
    }

    refs.fileInfo.textContent = `${file.name} - ${state.sourceWidth}x${state.sourceHeight} - foto 360 online`;
    resetView(false);
    updateControls();
    renderPerspective();
  } catch (error) {
    console.error(error);
    alert(`Impossibile aprire la foto: ${error.message}`);
  } finally {
    setLoading(false);
    renderPerspective();
  }
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function setLoading(value, label = "Caricamento foto in corso...") {
  state.loading = value;
  refs.loadingPreview.querySelector("strong").textContent = label;
  updateControls();
}

function setBusy(value, label = "Salvataggio in corso", mode = "view") {
  state.saving = value;
  state.savingMode = value ? mode : "";
  const privacySave = value && mode === "privacy";
  refs.saveProgress.classList.toggle("hidden", !value || privacySave);
  refs.privacyProgress.classList.toggle("hidden", !privacySave);
  const progressPanel = privacySave ? refs.privacyProgress : refs.saveProgress;
  progressPanel.querySelector("strong").textContent = label;
  if (!value) {
    refs.progressBar.style.width = "0%";
    refs.privacyProgressBar.style.width = "0%";
  }
  updateControls();
}

function setProgress(value) {
  const bar = state.savingMode === "privacy" ? refs.privacyProgressBar : refs.progressBar;
  bar.style.width = `${Math.round(clamp(value, 0, 1) * 100)}%`;
}

function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem("orienta360-online-settings") || "{}");
    state.settings.orientedSuffix = stored.orientedSuffix || state.settings.orientedSuffix;
    state.settings.maskedSuffix = stored.maskedSuffix || state.settings.maskedSuffix;
    state.settings.jpegQuality = clamp(Number(stored.jpegQuality || state.settings.jpegQuality), 0.85, 1);
  } catch {
    // Ignore malformed local settings.
  }
}

function saveSettings() {
  localStorage.setItem("orienta360-online-settings", JSON.stringify(state.settings));
}

function syncSettingsDialog() {
  $("#orientedSuffix").value = state.settings.orientedSuffix;
  $("#maskedSuffix").value = state.settings.maskedSuffix;
  $("#jpegQuality").value = Math.round(state.settings.jpegQuality * 100);
  $("#jpegQualityValue").textContent = $("#jpegQuality").value;
}

function applySettingsFromDialog() {
  state.settings.orientedSuffix = $("#orientedSuffix").value.trim() || "_ORIENTATA";
  state.settings.maskedSuffix = $("#maskedSuffix").value.trim() || "_MASCHERATO";
  state.settings.jpegQuality = clamp(Number($("#jpegQuality").value) / 100, 0.85, 1);
  saveSettings();
}

function selectSettingsTab(name) {
  $$(".settings-tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.settingsTab === name);
  });
  $$(".settings-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.settingsPanel === name);
  });
}

function openSettings(tab = "general") {
  syncSettingsDialog();
  selectSettingsTab(tab);
  refs.settingsDialog.showModal();
}

function showLocalProgramNotice(programName) {
  alert(`Nella versione online il browser non può cercare o avviare direttamente ${programName} sul PC. Il percorso resta come promemoria per lavorare in modo coerente con l'app locale.`);
}

function currentOrientation() {
  return { yaw: state.yaw, pitch: state.pitch, roll: state.roll };
}

function fixedOrientation() {
  return { yaw: state.fixedYaw, pitch: state.fixedPitch, roll: state.fixedRoll };
}

function orientationForSave(includeMasks) {
  if (state.viewFixed) {
    return fixedOrientation();
  }
  return includeMasks ? { yaw: 0, pitch: 0, roll: 0 } : currentOrientation();
}

function resetView(render = true) {
  state.yaw = 0;
  state.pitch = 0;
  state.roll = 0;
  state.fov = 80;
  state.viewFixed = false;
  state.fixedYaw = 0;
  state.fixedPitch = 0;
  state.fixedRoll = 0;
  refs.fixedText.textContent = "Vista non fissata";
  updateLabels();
  if (render) {
    renderPerspective();
  }
}

function syncFullscreenPrivacy() {
  const fullscreen = document.fullscreenElement === refs.previewFrame;
  refs.previewFrame.classList.toggle("fullscreen-active", fullscreen);
  refs.fullscreenCloseButton.classList.toggle("hidden", !fullscreen);
  if (fullscreen) {
    refs.previewFrame.appendChild(refs.privacyRow);
  } else {
    privacyRowHome.after(refs.privacyRow);
  }
  renderPerspective();
}

function setSliderValue(name, value) {
  state[name] = Number(value);
  schedulePreview();
}

function addMaskAt(lon, lat, tool, append = true) {
  let mask;
  const fov = clamp(state.fov, 25, 120);
  if (tool === "faces") {
    mask = { tool, shape: "ellipse", lon, lat: clamp(lat, -88, 88), rx: clamp(fov * 0.038, 1, 5), ry: clamp(fov * 0.052, 1.3, 7) };
  } else if (tool === "plates") {
    mask = { tool, shape: "rect", lon, lat: clamp(lat, -88, 88), rx: clamp(fov * 0.055, 1.2, 7), ry: clamp(fov * 0.018, 0.45, 2.4) };
  } else if (tool === "photographer") {
    mask = { tool, shape: "ellipse", lon, lat: clamp(lat, -88, 88), rx: clamp(fov * 0.08, 2.4, 11), ry: clamp(fov * 0.15, 4, 20) };
  } else if (tool === "nadir") {
    mask = { tool, shape: "cap", lon: 0, lat: -90, rx: 180, ry: state.nadir.size };
  } else {
    return;
  }

  if (tool === "photographer" && !append) {
    const existingIndex = state.masks.findIndex((item) => item.tool === "photographer");
    if (existingIndex >= 0) {
      state.masks[existingIndex] = mask;
    } else {
      state.masks.push(mask);
    }
  } else if (tool === "nadir") {
    const existingIndex = state.masks.findIndex((item) => item.tool === "nadir");
    if (existingIndex >= 0) {
      state.masks[existingIndex] = mask;
    } else {
      state.masks.push(mask);
    }
  } else {
    state.masks.push(mask);
  }
  updateControls();
  renderPerspective();
}

function updateNadirMaskSize() {
  const nadir = state.masks.find((mask) => mask.tool === "nadir");
  if (nadir) {
    nadir.ry = state.nadir.size;
  }
}

function setActiveTool(tool) {
  state.activeTool = state.activeTool === tool ? "" : tool;
  if (state.activeTool === "nadir") {
    addMaskAt(0, -90, "nadir");
  }
  updateControls();
}

function undoMask() {
  if (state.masks.length === 0) {
    return;
  }
  state.masks.pop();
  updateControls();
  renderPerspective();
}

function eventCanvasPoint(event) {
  const rect = refs.previewCanvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / rect.width * refs.previewCanvas.width,
    y: (event.clientY - rect.top) / rect.height * refs.previewCanvas.height,
  };
}

let dragState = null;

function onPointerDown(event) {
  if (!state.sourceData) {
    return;
  }
  refs.previewCanvas.setPointerCapture(event.pointerId);
  dragState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    lastX: event.clientX,
    lastY: event.clientY,
    moved: false,
    lastTrailX: -9999,
    lastTrailY: -9999,
  };
  if (state.activeTool === "photographer" && event.ctrlKey) {
    addTrailMask(event);
  }
}

function addTrailMask(event) {
  if (!dragState) {
    return;
  }
  const dx = event.clientX - dragState.lastTrailX;
  const dy = event.clientY - dragState.lastTrailY;
  if (Math.hypot(dx, dy) < 26) {
    return;
  }
  dragState.lastTrailX = event.clientX;
  dragState.lastTrailY = event.clientY;
  const point = eventCanvasPoint(event);
  const [lon, lat] = viewPointToLonLat(point.x, point.y, refs.previewCanvas.width, refs.previewCanvas.height);
  addMaskAt(lon, lat, "photographer", true);
}

function onPointerMove(event) {
  if (!dragState || dragState.pointerId !== event.pointerId) {
    return;
  }
  const dx = event.clientX - dragState.lastX;
  const dy = event.clientY - dragState.lastY;
  if (Math.abs(event.clientX - dragState.startX) > 4 || Math.abs(event.clientY - dragState.startY) > 4) {
    dragState.moved = true;
  }

  if (state.activeTool === "photographer" && event.ctrlKey) {
    addTrailMask(event);
  } else {
    const speed = event.shiftKey ? 0.36 : 0.18;
    state.yaw = wrapLon(state.yaw + dx * speed);
    state.pitch = clamp(state.pitch - dy * speed, -89.5, 89.5);
    schedulePreview();
  }
  dragState.lastX = event.clientX;
  dragState.lastY = event.clientY;
}

function onPointerUp(event) {
  if (!dragState || dragState.pointerId !== event.pointerId) {
    return;
  }
  refs.previewCanvas.releasePointerCapture(event.pointerId);
  if (!dragState.moved && state.activeTool) {
    const point = eventCanvasPoint(event);
    const [lon, lat] = viewPointToLonLat(point.x, point.y, refs.previewCanvas.width, refs.previewCanvas.height);
    addMaskAt(lon, lat, state.activeTool, event.ctrlKey || state.activeTool !== "photographer");
  }
  dragState = null;
}

async function renderEquirectangular(includeMasks, orientation = currentOrientation()) {
  const width = state.sourceWidth;
  const height = state.sourceHeight;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const imageData = ctx.createImageData(width, height);
  const out = imageData.data;
  let index = 0;

  for (let y = 0; y < height; y++) {
    const lat = 90 - ((y + 0.5) / height) * 180;
    const cosLat = Math.cos(lat * degToRad);
    const sinLat = Math.sin(lat * degToRad);
    for (let x = 0; x < width; x++) {
      const lon = ((x + 0.5) / width) * 360 - 180;
      const lonRad = lon * degToRad;
      const vector = [
        cosLat * Math.sin(lonRad),
        sinLat,
        cosLat * Math.cos(lonRad),
      ];
      const [srcLon, srcLat] = lonLatFromVector(rotateVector(vector, orientation.yaw, orientation.pitch, orientation.roll));
      const color = sampleColor(srcLon, srcLat, includeMasks);
      out[index++] = color[0];
      out[index++] = color[1];
      out[index++] = color[2];
      out[index++] = 255;
    }
    if (y % 16 === 0) {
      setProgress(y / height);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  ctx.putImageData(imageData, 0, 0);
  if ($("#nadirHint").checked) {
    drawNadirHint(ctx, width, height);
  }
  setProgress(0.96);
  return canvas;
}

function drawNadirHint(ctx, width, height) {
  const x = width / 2;
  const y = height * 0.68;
  const size = Math.max(70, width * 0.038);
  const shaftWidth = size * 0.22;
  const shaftHeight = size * 0.72;
  const headHeight = size * 0.40;
  const textSize = Math.max(26, size * 0.26);
  ctx.save();
  ctx.translate(x, y);
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = size * 0.08;
  ctx.shadowOffsetY = size * 0.03;
  ctx.fillStyle = "rgba(255,255,255,0.94)";
  ctx.beginPath();
  ctx.rect(-shaftWidth / 2, -shaftHeight, shaftWidth, shaftHeight);
  ctx.moveTo(-size * 0.48, -headHeight * 0.08);
  ctx.lineTo(0, headHeight * 0.92);
  ctx.lineTo(size * 0.48, -headHeight * 0.08);
  ctx.closePath();
  ctx.fill();
  ctx.font = `700 ${textSize}px "Segoe UI", Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText("Scorri", 0, headHeight * 1.05);
  ctx.fillText("in basso", 0, headHeight * 1.05 + textSize * 1.05);
  ctx.closePath();
  ctx.restore();
}

async function canvasToJpegBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Creazione JPG non riuscita."));
      }
    }, "image/jpeg", state.settings.jpegQuality);
  });
}

function buildGpanoXmp(width, height) {
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about=""
 xmlns:GPano="http://ns.google.com/photos/1.0/panorama/"
 GPano:UsePanoramaViewer="True"
 GPano:ProjectionType="equirectangular"
 GPano:FullPanoWidthPixels="${width}"
 GPano:FullPanoHeightPixels="${height}"
 GPano:CroppedAreaImageWidthPixels="${width}"
 GPano:CroppedAreaImageHeightPixels="${height}"
 GPano:CroppedAreaLeftPixels="0"
 GPano:CroppedAreaTopPixels="0"
 GPano:PoseHeadingDegrees="0"/>
</rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

async function injectXmp(blob, width, height) {
  const source = new Uint8Array(await blob.arrayBuffer());
  if (source.length < 4 || source[0] !== 0xff || source[1] !== 0xd8) {
    return blob;
  }
  const header = "http://ns.adobe.com/xap/1.0/\0";
  const payload = new TextEncoder().encode(header + buildGpanoXmp(width, height));
  const length = payload.length + 2;
  if (length > 65535) {
    return blob;
  }
  const segment = new Uint8Array(payload.length + 4);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  segment[2] = (length >> 8) & 0xff;
  segment[3] = length & 0xff;
  segment.set(payload, 4);

  const output = new Uint8Array(source.length + segment.length);
  output.set(source.slice(0, 2), 0);
  output.set(segment, 2);
  output.set(source.slice(2), 2 + segment.length);
  return new Blob([output], { type: "image/jpeg" });
}

function outputName(includeMasks) {
  const original = state.file?.name || "foto360.jpg";
  const stem = original.replace(/\.[^.]+$/, "");
  const suffix = includeMasks ? state.settings.maskedSuffix : state.settings.orientedSuffix;
  return `${stem}${suffix || ""}.jpg`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1200);
}

function rememberSavedBlob(blob, filename) {
  if (state.lastSavedUrl) {
    URL.revokeObjectURL(state.lastSavedUrl);
  }
  state.lastSavedUrl = URL.createObjectURL(blob);
  state.lastOutputName = filename;
}

function savePickerOptions(suggestedName) {
  const options = {
    suggestedName,
    types: [{
      description: "JPEG 360",
      accept: { "image/jpeg": [".jpg", ".jpeg"] },
    }],
  };
  if (state.folderHandle) {
    options.startIn = state.folderHandle;
  }
  return options;
}

async function writeBlobToHandle(fileHandle, blob) {
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

function backupNameFor(file) {
  const original = file?.name || "foto360.jpg";
  const stem = original.replace(/\.[^.]+$/, "");
  const extension = original.match(/\.[^.]+$/)?.[0] || ".jpg";
  return `${stem}_BACKUP_ORIGINALE${extension}`;
}

async function backupOriginalIfPossible() {
  if (!state.file?.parentDirectoryHandle || !state.file) {
    return "";
  }
  const backupName = backupNameFor(state.file);
  const backupHandle = await state.file.parentDirectoryHandle.getFileHandle(backupName, { create: true });
  await writeBlobToHandle(backupHandle, state.file);
  return backupName;
}

async function ensureWritePermission(fileHandle) {
  if (!fileHandle?.queryPermission || !fileHandle?.requestPermission) {
    return true;
  }
  const options = { mode: "readwrite" };
  if (await fileHandle.queryPermission(options) === "granted") {
    return true;
  }
  return await fileHandle.requestPermission(options) === "granted";
}

async function pickSaveFile(suggestedName) {
  if (!window.showSaveFilePicker) {
    return null;
  }
  return window.showSaveFilePicker(savePickerOptions(suggestedName));
}

function askOverwriteConfirmation() {
  return new Promise((resolve) => {
    const confirmButton = $("#confirmOverwriteButton");
    const cancelButton = $("#cancelOverwriteButton");
    let done = false;
    const cleanup = (value) => {
      if (done) {
        return;
      }
      done = true;
      confirmButton.removeEventListener("click", onConfirm);
      cancelButton.removeEventListener("click", onCancel);
      refs.overwriteDialog.removeEventListener("close", onClose);
      resolve(value);
    };
    const onConfirm = () => {
      refs.overwriteDialog.close("confirm");
      cleanup(true);
    };
    const onCancel = () => {
      refs.overwriteDialog.close("cancel");
      cleanup(false);
    };
    const onClose = () => cleanup(refs.overwriteDialog.returnValue === "confirm");
    confirmButton.addEventListener("click", onConfirm);
    cancelButton.addEventListener("click", onCancel);
    refs.overwriteDialog.addEventListener("close", onClose);
    refs.overwriteDialog.showModal();
  });
}

async function prepareSaveTarget(includeMasks, mode, filename) {
  if (mode === "overwrite" && !includeMasks) {
    if (!await askOverwriteConfirmation()) {
      return { kind: "cancel" };
    }
    if (state.fileHandle) {
      return { kind: "overwrite" };
    }
    alert("Il browser non ha un permesso di scrittura sul file originale. Uso Salva come.");
  }

  if (mode === "copyNext" && !includeMasks) {
    const directoryHandle = state.file?.parentDirectoryHandle || state.folderHandle;
    if (directoryHandle?.getFileHandle) {
      return { kind: "folderCopy", directoryHandle };
    }
  }

  const fileHandle = await pickSaveFile(filename);
  return fileHandle ? { kind: "handle", fileHandle } : { kind: "download" };
}

async function rememberSavedFileInFolder(fileHandle, parentDirectoryHandle = null) {
  if (!fileHandle || !state.folderFiles.length) {
    return;
  }
  const file = rememberFileHandle(await fileHandle.getFile(), fileHandle, parentDirectoryHandle);
  rememberRelativePath(file, file.name);
  const key = folderSortKey(file);
  const existingIndex = state.folderFiles.findIndex((item) => folderSortKey(item) === key);
  if (existingIndex >= 0) {
    state.folderFiles[existingIndex] = file;
  } else {
    state.folderFiles.push(file);
  }
  state.folderFiles = sortFolderFiles(state.folderFiles);
  state.folderIndex = state.folderFiles.findIndex((item) => folderSortKey(item) === folderSortKey(state.file));
}

async function writePreparedSave(target, blob, filename) {
  if (target.kind === "cancel") {
    return "";
  }
  if (target.kind === "overwrite") {
    if (!await ensureWritePermission(state.fileHandle)) {
      throw new Error("Permesso di scrittura negato.");
    }
    await backupOriginalIfPossible();
    await writeBlobToHandle(state.fileHandle, blob);
    return state.file?.name || filename;
  }
  if (target.kind === "folderCopy") {
    const fileHandle = await target.directoryHandle.getFileHandle(filename, { create: true });
    await writeBlobToHandle(fileHandle, blob);
    await rememberSavedFileInFolder(fileHandle, target.directoryHandle);
    return filename;
  }
  if (target.kind === "handle") {
    await writeBlobToHandle(target.fileHandle, blob);
    await rememberSavedFileInFolder(target.fileHandle);
    return target.fileHandle.name || filename;
  }
  downloadBlob(blob, filename);
  return filename;
}

async function loadFolderIndex(index) {
  if (index < 0 || index >= state.folderFiles.length) {
    return;
  }
  let file = state.folderFiles[index];
  if (file.fileHandle) {
    const freshFile = rememberFileHandle(await file.fileHandle.getFile(), file.fileHandle, file.parentDirectoryHandle || null);
    rememberRelativePath(freshFile, folderSortKey(file));
    state.folderFiles[index] = freshFile;
    file = freshFile;
  }
  await loadPhoto(file, { files: state.folderFiles, index });
}

async function saveImage(includeMasks, mode = "saveAs") {
  if (!state.sourceData || state.saving) {
    return;
  }
  const filename = outputName(includeMasks);
  let target;
  try {
    target = await prepareSaveTarget(includeMasks, mode, filename);
    if (target.kind === "cancel") {
      return;
    }
  } catch (error) {
    if (error.name !== "AbortError") {
      console.error(error);
      alert(`Errore durante la scelta del file: ${error.message}`);
    }
    return;
  }
  setBusy(true, includeMasks ? "Salvataggio privacy in corso" : "Salvataggio in corso", includeMasks ? "privacy" : "view");
  try {
    const canvas = await renderEquirectangular(includeMasks, orientationForSave(includeMasks));
    const jpeg = await canvasToJpegBlob(canvas);
    const withXmp = await injectXmp(jpeg, canvas.width, canvas.height);
    const savedName = await writePreparedSave(target, withXmp, filename);
    if (!savedName) {
      return;
    }
    rememberSavedBlob(withXmp, savedName);
    refs.fixedText.textContent = includeMasks ? "Privacy salvata" : "Foto 360 salvata";
    setProgress(1);
    if (mode === "copyNext" && state.folderIndex < state.folderFiles.length - 1) {
      setTimeout(() => loadFolderIndex(state.folderIndex + 1), 250);
    }
  } catch (error) {
    console.error(error);
    if (error.name === "AbortError") {
      return;
    }
    alert(`Errore durante il salvataggio: ${error.message}`);
  } finally {
    setTimeout(() => setBusy(false), 450);
  }
}

async function loadLogo(file) {
  if (!file) {
    return;
  }
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  const maxSide = 1600;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  state.nadir.logoCanvas = canvas;
  state.nadir.logoData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  state.nadir.logoName = file.name;
  refs.logoName.textContent = file.name;
  state.nadir.effect = "logo";
  ensureNadirMask();
  updateNadirDialog();
  renderPerspective();
}

function ensureNadirMask() {
  if (!state.masks.some((mask) => mask.tool === "nadir")) {
    addMaskAt(0, -90, "nadir");
  } else {
    updateNadirMaskSize();
  }
}

function updateNadirDialog() {
  $("#nadirMosaicButton").classList.toggle("active", state.nadir.effect === "mosaic");
  $("#nadirLogoButton").classList.toggle("active", state.nadir.effect === "logo");
  $$(".logo-only").forEach((node) => node.classList.toggle("hidden", state.nadir.effect !== "logo"));
  $$(".mosaic-only").forEach((node) => node.classList.toggle("hidden", state.nadir.effect !== "mosaic"));
}

function resetNadirParams() {
  state.nadir.size = 26;
  state.nadir.mosaicScale = 1;
  state.nadir.logoOpacity = 0.78;
  state.nadir.logoFeather = 0.22;
  state.nadir.logoOval = 0;
  state.nadir.logoRotation = 0;
  state.nadir.logoOffsetX = 0;
  state.nadir.logoOffsetY = 0;
  $("#nadirSize").value = 26;
  $("#mosaicScale").value = 1;
  $("#logoOpacity").value = 78;
  $("#logoFeather").value = 22;
  $("#logoOval").value = 0;
  $("#logoRotation").value = 0;
  $("#logoOffsetX").value = 0;
  $("#logoOffsetY").value = 0;
  updateNadirMaskSize();
  renderPerspective();
}

function bindEvents() {
  $("#openPhotoButton").addEventListener("click", openSinglePhotoSelection);
  $("#openVideoButton").addEventListener("click", () => {
    alert("La sezione video online è in preparazione. Per ora i video restano nella versione locale sperimentale.");
  });
  $("#openFolderButton").addEventListener("click", () => {
    if (refs.folderDialog?.showModal) {
      refs.folderDialog.showModal();
    } else {
      openFolderSelection();
    }
  });
  $("#cancelFolderButton")?.addEventListener("click", () => refs.folderDialog?.close());
  $("#confirmFolderButton")?.addEventListener("click", () => {
    refs.folderDialog?.close();
    openFolderSelection();
  });
  refs.photoInput.addEventListener("change", () => loadPhoto(refs.photoInput.files[0]));
  refs.folderInput.addEventListener("change", () => {
    loadFolderFiles(Array.from(refs.folderInput.files || []));
  });

  $("#previousButton").addEventListener("click", () => {
    if (state.folderIndex > 0) {
      loadFolderIndex(state.folderIndex - 1);
    }
  });
  $("#nextButton").addEventListener("click", () => {
    if (state.folderIndex < state.folderFiles.length - 1) {
      loadFolderIndex(state.folderIndex + 1);
    }
  });
  $("#refreshFolderButton").addEventListener("click", () => refreshFolder(true));

  refs.yawSlider.addEventListener("input", (event) => setSliderValue("yaw", event.target.value));
  refs.pitchSlider.addEventListener("input", (event) => setSliderValue("pitch", event.target.value));
  refs.rollSlider.addEventListener("input", (event) => setSliderValue("roll", event.target.value));
  refs.fovSlider.addEventListener("input", (event) => setSliderValue("fov", event.target.value));

  $$(".step-button").forEach((button) => {
    button.addEventListener("click", () => {
      const [name, delta] = button.dataset.step.split(":");
      state[name] = name === "yaw"
        ? wrapLon(state[name] + Number(delta))
        : clamp(state[name] + Number(delta), name === "roll" ? -45 : -89.5, name === "roll" ? 45 : 89.5);
      schedulePreview();
    });
  });

  $$(".nav-arrow").forEach((button) => {
    button.addEventListener("click", () => {
      const [name, delta] = button.dataset.nudge.split(":");
      state[name] = name === "yaw" ? wrapLon(state[name] + Number(delta)) : clamp(state[name] + Number(delta), -89.5, 89.5);
      schedulePreview();
    });
  });

  $("#fixViewButton").addEventListener("click", () => {
    state.viewFixed = true;
    state.fixedYaw = state.yaw;
    state.fixedPitch = state.pitch;
    state.fixedRoll = state.roll;
    refs.fixedText.textContent = `Vista fissata: Yaw ${state.yaw.toFixed(2)}°, Pitch ${state.pitch.toFixed(2)}°, Roll ${state.roll.toFixed(2)}°`;
  });
  $("#resetViewButton").addEventListener("click", () => resetView());
  $("#saveOrientedButton").addEventListener("click", () => saveImage(false));
  $("#overwriteButton").addEventListener("click", () => saveImage(false, "overwrite"));
  $("#saveNextButton").addEventListener("click", () => saveImage(false, "copyNext"));
  $("#savePrivacyButton").addEventListener("click", () => saveImage(true));
  $("#resetPrivacyButton").addEventListener("click", () => {
    state.masks = [];
    updateControls();
    renderPerspective();
  });

  $$(".privacy-button[data-tool]").forEach((button) => {
    button.addEventListener("click", () => setActiveTool(button.dataset.tool));
  });
  $("#privacyTuneButton").addEventListener("click", () => refs.privacyDialog.showModal());
  $("#privacyHelpButton").addEventListener("click", () => refs.privacyHelpDialog.showModal());
  $("#helpButton").addEventListener("click", () => refs.helpDialog.showModal());
  $("#settingsButton").addEventListener("click", () => openSettings());
  $("#setViewerButton").addEventListener("click", () => openSettings("viewer"));
  $("#openViewerButton").addEventListener("click", () => {
    if (!state.lastSavedUrl) {
      return;
    }
    alert("Il browser non può avviare direttamente FSPViewer. Apro il risultato in una nuova scheda; per FSPViewer usa il JPG salvato da Esplora risorse o dalla barra download.");
    window.open(state.lastSavedUrl, "_blank", "noopener");
  });
  $$(".settings-tab").forEach((button) => {
    button.addEventListener("click", () => selectSettingsTab(button.dataset.settingsTab));
  });
  $("#closeSettingsButton").addEventListener("click", () => {
    applySettingsFromDialog();
    refs.settingsDialog.close();
  });
  $("#cancelSettingsButton").addEventListener("click", () => refs.settingsDialog.close());
  $("#jpegQuality").addEventListener("input", (event) => {
    $("#jpegQualityValue").textContent = event.target.value;
  });
  $("#resetSettingsButton").addEventListener("click", () => {
    state.settings.orientedSuffix = "_ORIENTATA";
    state.settings.maskedSuffix = "_MASCHERATO";
    state.settings.jpegQuality = 0.98;
    syncSettingsDialog();
    saveSettings();
  });
  $("#resetWindowButton").addEventListener("click", () => alert("Nella versione online dimensione e posizione dipendono dalla finestra del browser."));
  $("#browseFspButton").addEventListener("click", () => showLocalProgramNotice("FSPViewer"));
  $("#detectFspButton").addEventListener("click", () => showLocalProgramNotice("FSPViewer"));
  $("#browseVlcButton").addEventListener("click", () => showLocalProgramNotice("VLC Media Player"));
  $("#detectVlcButton").addEventListener("click", () => showLocalProgramNotice("VLC Media Player"));
  $("#fullscreenButton").addEventListener("click", () => refs.previewFrame.requestFullscreen?.());
  refs.fullscreenCloseButton.addEventListener("click", () => document.exitFullscreen?.());
  document.addEventListener("fullscreenchange", syncFullscreenPrivacy);
  $("#previewHelp").addEventListener("click", () => refs.previewTip.classList.toggle("hidden"));

  refs.previewCanvas.addEventListener("pointerdown", onPointerDown);
  refs.previewCanvas.addEventListener("pointermove", onPointerMove);
  refs.previewCanvas.addEventListener("pointerup", onPointerUp);
  refs.previewCanvas.addEventListener("pointercancel", onPointerUp);
  refs.previewCanvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    state.fov = clamp(state.fov + (event.deltaY > 0 ? 4 : -4), 25, 120);
    schedulePreview();
  }, { passive: false });

  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      undoMask();
    }
  });

  refs.logoInput.addEventListener("change", () => loadLogo(refs.logoInput.files[0]));
  $("#chooseLogoButton").addEventListener("click", () => refs.logoInput.click());
  $("#nadirMosaicButton").addEventListener("click", () => {
    state.nadir.effect = "mosaic";
    ensureNadirMask();
    updateNadirDialog();
    renderPerspective();
  });
  $("#nadirLogoButton").addEventListener("click", () => {
    state.nadir.effect = "logo";
    ensureNadirMask();
    updateNadirDialog();
    renderPerspective();
  });

  $("#nadirSize").addEventListener("input", (event) => {
    state.nadir.size = Number(event.target.value);
    ensureNadirMask();
    renderPerspective();
  });
  $("#mosaicScale").addEventListener("input", (event) => {
    state.nadir.mosaicScale = Number(event.target.value);
    renderPerspective();
  });
  $("#logoOpacity").addEventListener("input", (event) => {
    state.nadir.logoOpacity = Number(event.target.value) / 100;
    renderPerspective();
  });
  $("#logoFeather").addEventListener("input", (event) => {
    state.nadir.logoFeather = Number(event.target.value) / 100;
    renderPerspective();
  });
  $("#logoOval").addEventListener("input", (event) => {
    state.nadir.logoOval = Number(event.target.value);
    renderPerspective();
  });
  $("#logoRotation").addEventListener("input", (event) => {
    state.nadir.logoRotation = Number(event.target.value);
    renderPerspective();
  });
  $("#logoOffsetX").addEventListener("input", (event) => {
    state.nadir.logoOffsetX = Number(event.target.value) / 100;
    renderPerspective();
  });
  $("#logoOffsetY").addEventListener("input", (event) => {
    state.nadir.logoOffsetY = Number(event.target.value) / 100;
    renderPerspective();
  });
  $("#resetNadirButton").addEventListener("click", resetNadirParams);
  window.addEventListener("resize", () => renderPerspective());
}

loadSettings();
bindEvents();
updateControls();
updateLabels();
