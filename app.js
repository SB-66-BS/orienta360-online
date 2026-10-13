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
  privacyDialog: $("#privacyDialog"),
  helpDialog: $("#helpDialog"),
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
  yaw: 0,
  pitch: 0,
  roll: 0,
  fov: 80,
  masks: [],
  activeTool: "",
  renderToken: 0,
  saving: false,
  loading: false,
  lastOutputName: "",
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
  $("#savePrivacyButton").disabled = !hasPhoto || busy || state.masks.length === 0;
  $("#savePrivacyButtonTop").disabled = !hasPhoto || busy || state.masks.length === 0;
  $("#resetPrivacyButton").disabled = !hasPhoto || busy || state.masks.length === 0;
  $("#previousButton").disabled = busy || state.folderFiles.length <= 1 || state.folderIndex <= 0;
  $("#nextButton").disabled = busy || state.folderFiles.length <= 1 || state.folderIndex >= state.folderFiles.length - 1;
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

function setBusy(value, label = "Salvataggio in corso") {
  state.saving = value;
  refs.saveProgress.classList.toggle("hidden", !value);
  refs.saveProgress.querySelector("strong").textContent = label;
  if (!value) {
    refs.progressBar.style.width = "0%";
  }
  updateControls();
}

function setProgress(value) {
  refs.progressBar.style.width = `${Math.round(clamp(value, 0, 1) * 100)}%`;
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
  const y = height * 0.915;
  const size = Math.max(42, width * 0.025);
  ctx.save();
  ctx.translate(x, y);
  ctx.lineWidth = Math.max(6, size * 0.12);
  ctx.strokeStyle = "#0f766e";
  ctx.fillStyle = "#48e06f";
  ctx.beginPath();
  ctx.moveTo(-size * 0.7, -size * 0.2);
  ctx.lineTo(0, size * 0.55);
  ctx.lineTo(size * 0.7, -size * 0.2);
  ctx.lineTo(size * 0.45, -size * 0.45);
  ctx.lineTo(0, size * 0.05);
  ctx.lineTo(-size * 0.45, -size * 0.45);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
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
    }, "image/jpeg", 0.98);
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
  return `${stem}${includeMasks ? "_MASCHERATO" : "_ORIENTATA"}.jpg`;
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

async function saveImage(includeMasks) {
  if (!state.sourceData || state.saving) {
    return;
  }
  setBusy(true, includeMasks ? "Salvataggio privacy in corso" : "Salvataggio in corso");
  try {
    const canvas = await renderEquirectangular(includeMasks, orientationForSave(includeMasks));
    const jpeg = await canvasToJpegBlob(canvas);
    const withXmp = await injectXmp(jpeg, canvas.width, canvas.height);
    const filename = outputName(includeMasks);
    downloadBlob(withXmp, filename);
    state.lastOutputName = filename;
    refs.fixedText.textContent = includeMasks ? "Privacy salvata" : "Foto 360 salvata";
    setProgress(1);
  } catch (error) {
    console.error(error);
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
  $("#openPhotoButton").addEventListener("click", () => refs.photoInput.click());
  $("#openFolderButton").addEventListener("click", () => refs.folderInput.click());
  refs.photoInput.addEventListener("change", () => loadPhoto(refs.photoInput.files[0]));
  refs.folderInput.addEventListener("change", () => {
    const files = Array.from(refs.folderInput.files || [])
      .filter((file) => /\.jpe?g$/i.test(file.name))
      .sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name));
    if (files.length) {
      loadPhoto(files[0], { files, index: 0 });
    }
  });

  $("#previousButton").addEventListener("click", () => {
    if (state.folderIndex > 0) {
      loadPhoto(state.folderFiles[state.folderIndex - 1], { files: state.folderFiles, index: state.folderIndex - 1 });
    }
  });
  $("#nextButton").addEventListener("click", () => {
    if (state.folderIndex < state.folderFiles.length - 1) {
      loadPhoto(state.folderFiles[state.folderIndex + 1], { files: state.folderFiles, index: state.folderIndex + 1 });
    }
  });

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
  $("#savePrivacyButton").addEventListener("click", () => saveImage(true));
  $("#savePrivacyButtonTop").addEventListener("click", () => saveImage(true));
  $("#resetPrivacyButton").addEventListener("click", () => {
    state.masks = [];
    updateControls();
    renderPerspective();
  });

  $$(".privacy-button[data-tool]").forEach((button) => {
    button.addEventListener("click", () => setActiveTool(button.dataset.tool));
  });
  $("#privacyTuneButton").addEventListener("click", () => refs.privacyDialog.showModal());
  $("#privacyHelpButton").addEventListener("click", () => refs.helpDialog.showModal());
  $("#helpButton").addEventListener("click", () => refs.helpDialog.showModal());
  $("#settingsButton").addEventListener("click", () => alert("Nella versione online non serve configurare visualizzatori esterni: apri, ritocca e scarica dal browser."));
  $("#fullscreenButton").addEventListener("click", () => refs.previewFrame.requestFullscreen?.());
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

bindEvents();
updateControls();
updateLabels();
