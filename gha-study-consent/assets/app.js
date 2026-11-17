import * as pdfjsLib from "./vendor/pdf.min.mjs";

const CONFIG = {
  // Apps Script web app URL ("Deploy > New deployment > Web app"), ending in /exec.
  endpoint: "",
  consentVersion: "B-2026-11-12",
  consentUrl: "assets/consent.pdf",
  timeZone: "America/Toronto",
  requestTimeoutMs: 90_000,
};

const STORAGE_KEY = "spark-consent-assignment-v1";
const INK = "#0a2a6b";
const NAME_FONT_SIZE = 11;
const SIG_MAX = { width: 250, height: 22 };
const MIN_INK_LENGTH = 40;
// Lifts stamped text off the printed underline (PDF points).
const TEXT_LIFT = 4;

// Label end and baseline (PDF points) used when the labels cannot be found in the text layer.
const FIELD_FALLBACK = {
  name: { pageIndex: 1, x: 161.6, y: 191.7 },
  signature: { pageIndex: 1, x: 159, y: 168 },
  date: { pageIndex: 1, x: 101.9, y: 144.4 },
};
const FIELD_LABELS = { name: "Participant name:", signature: "Digital signature:", date: "Date:" };

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdf.worker.min.mjs", import.meta.url).href;

const $ = (selector, root = document) => root.querySelector(selector);

const state = {
  pdfBytes: null,
  pageSizes: [],
  pageElements: [],
  fields: { ...FIELD_FALLBACK },
  overlays: {},
  dateText: formatDate(new Date()),
  submitting: false,
};

function init() {
  const saved = readSavedAssignment();
  if (saved) {
    showAssignment($("#returning"), saved);
    $("#returning").hidden = false;
    return;
  }
  $("#consent-flow").hidden = false;
  $("[data-date]").textContent = state.dateText;
  setupSignaturePad();
  setupForm();
  loadConsent().catch((error) => {
    console.error(error);
    $("[data-viewer-status]").textContent =
      "The consent form could not be loaded. Please reload the page or contact the researchers.";
  });
}

/* ---------- Consent viewer ---------- */

async function loadConsent() {
  const response = await fetch(CONFIG.consentUrl, { cache: "no-cache" });
  if (!response.ok) throw new Error(`Consent PDF request failed: ${response.status}`);
  state.pdfBytes = new Uint8Array(await response.arrayBuffer());

  const pdf = await pdfjsLib.getDocument({ data: state.pdfBytes.slice() }).promise;
  const viewer = $("#viewer");
  viewer.textContent = "";

  const cssWidth = Math.min(viewer.clientWidth || 800, 820);
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2.5);

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: (cssWidth / base.width) * pixelRatio });

    const wrapper = document.createElement("div");
    wrapper.className = "pdf-page";
    wrapper.style.maxWidth = `${cssWidth}px`;
    wrapper.style.aspectRatio = `${base.width} / ${base.height}`;
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.setAttribute("aria-label", `Consent form page ${pageNumber} of ${pdf.numPages}`);
    wrapper.appendChild(canvas);
    viewer.appendChild(wrapper);

    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    state.pageSizes.push({ width: base.width, height: base.height });
    state.pageElements.push(wrapper);

    const textContent = await page.getTextContent();
    for (const [key, label] of Object.entries(FIELD_LABELS)) {
      const found = findLabel(textContent.items, label);
      if (found) state.fields[key] = { pageIndex: pageNumber - 1, x: found.x + 4, y: found.y };
    }
  }

  createOverlays();
  observeScale();
  gateSigningUntilRead();
}

function findLabel(items, label) {
  const target = label.replace(/\s+/g, "");
  for (let i = 0; i < items.length; i++) {
    const first = (items[i].str || "").replace(/\s+/g, "");
    if (!first || !target.startsWith(first)) continue;
    let joined = "";
    for (let j = i; j < Math.min(i + 4, items.length); j++) {
      joined += (items[j].str || "").replace(/\s+/g, "");
      if (joined === target) {
        return { x: items[j].transform[4] + items[j].width, y: items[i].transform[5] };
      }
      if (!target.startsWith(joined)) break;
    }
  }
  return null;
}

function createOverlays() {
  const make = (key, tag, className, bottom) => {
    const field = state.fields[key];
    const size = state.pageSizes[field.pageIndex];
    const element = document.createElement(tag);
    element.className = `overlay ${className}`;
    element.style.left = `${(field.x / size.width) * 100}%`;
    element.style.top = `${((size.height - bottom) / size.height) * 100}%`;
    state.pageElements[field.pageIndex].appendChild(element);
    return element;
  };
  // Text overlays are positioned by their bottom edge, so subtract a descender's worth.
  const textBottom = (key) => state.fields[key].y + TEXT_LIFT - NAME_FONT_SIZE * 0.25;
  state.overlays.name = make("name", "div", "overlay-text", textBottom("name"));
  state.overlays.signature = make("signature", "img", "overlay-img", state.fields.signature.y - 1);
  state.overlays.signature.alt = "";
  state.overlays.signature.hidden = true;
  state.overlays.date = make("date", "div", "overlay-text", textBottom("date"));
  updatePreview();
}

function observeScale() {
  const apply = () => {
    state.pageElements.forEach((element, index) => {
      element.style.setProperty("--scale", element.clientWidth / state.pageSizes[index].width);
    });
    for (const key of ["name", "date"]) {
      const overlay = state.overlays[key];
      overlay.style.fontSize = `calc(var(--scale) * ${NAME_FONT_SIZE}px)`;
    }
    state.overlays.signature.style.height = `calc(var(--scale) * ${SIG_MAX.height}px)`;
  };
  apply();
  new ResizeObserver(apply).observe($("#viewer"));
}

function gateSigningUntilRead() {
  const fields = $("[data-sign-fields]");
  const hint = $("[data-gate-hint]");
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) {
      fields.disabled = false;
      hint.hidden = true;
      signaturePad.resize();
      observer.disconnect();
    }
  });
  observer.observe($("#end-of-consent"));
}

function updatePreview() {
  if (!state.overlays.name) return;
  state.overlays.name.textContent = $("#sign-form").elements.name.value.trim();
  state.overlays.date.textContent = state.dateText;
  const image = state.overlays.signature;
  if (signaturePad.hasInk()) {
    image.src = signaturePad.toTrimmedDataUrl();
    image.hidden = false;
  } else {
    image.hidden = true;
    image.removeAttribute("src");
  }
}

/* ---------- Signature pad ---------- */

const signaturePad = createSignaturePad($("#sig-pad"));

function createSignaturePad(canvas) {
  const strokes = [];
  let current = null;
  let inkLength = 0;

  const context = () => canvas.getContext("2d");

  function resize() {
    const ratio = window.devicePixelRatio || 1;
    const { width, height } = canvas.getBoundingClientRect();
    if (!width || !height) return;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = context();
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    redraw();
  }

  function styleStroke(ctx, lineWidth) {
    ctx.strokeStyle = INK;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  }

  function drawStrokes(ctx, scale, offsetX, offsetY) {
    styleStroke(ctx, 2.2 * scale);
    for (const stroke of strokes) {
      ctx.beginPath();
      stroke.forEach(([x, y], index) => {
        const px = (x - offsetX) * scale;
        const py = (y - offsetY) * scale;
        if (index === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      if (stroke.length === 1) ctx.lineTo((stroke[0][0] - offsetX) * scale + 0.1, (stroke[0][1] - offsetY) * scale);
      ctx.stroke();
    }
  }

  function redraw() {
    const ctx = context();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawStrokes(ctx, 1, 0, 0);
  }

  function point(event) {
    const rect = canvas.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (canvas.closest("fieldset")?.disabled) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    current = [point(event)];
    strokes.push(current);
    redraw();
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!current) return;
    const next = point(event);
    const last = current[current.length - 1];
    inkLength += Math.hypot(next[0] - last[0], next[1] - last[1]);
    current.push(next);
    const ctx = context();
    styleStroke(ctx, 2.2);
    ctx.beginPath();
    ctx.moveTo(last[0], last[1]);
    ctx.lineTo(next[0], next[1]);
    ctx.stroke();
  });

  const finish = () => {
    if (!current) return;
    current = null;
    updatePreview();
  };
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", finish);

  window.addEventListener("resize", resize);

  return {
    resize,
    clear() {
      strokes.length = 0;
      inkLength = 0;
      redraw();
      updatePreview();
    },
    hasInk: () => inkLength >= MIN_INK_LENGTH,
    toTrimmedDataUrl() {
      const all = strokes.flat();
      const pad = 4;
      const minX = Math.min(...all.map((p) => p[0])) - pad;
      const minY = Math.min(...all.map((p) => p[1])) - pad;
      const maxX = Math.max(...all.map((p) => p[0])) + pad;
      const maxY = Math.max(...all.map((p) => p[1])) + pad;
      const scale = 3;
      const out = document.createElement("canvas");
      out.width = Math.max(1, Math.ceil((maxX - minX) * scale));
      out.height = Math.max(1, Math.ceil((maxY - minY) * scale));
      drawStrokes(out.getContext("2d"), scale, minX, minY);
      return out.toDataURL("image/png");
    },
  };
}

/* ---------- Form ---------- */

function setupSignaturePad() {
  $("[data-sig-clear]").addEventListener("click", () => signaturePad.clear());
}

function setupForm() {
  const form = $("#sign-form");
  form.elements.name.addEventListener("input", updatePreview);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.submitting) return;

    const error = validate(form);
    showFormError(error);
    if (error) return;
    if (form.elements.website.value) return;

    state.submitting = true;
    const button = $("[data-submit]");
    button.disabled = true;
    button.textContent = "Submitting…";
    try {
      const signedAt = new Date();
      const signedPdf = await buildSignedPdf(form.elements.name.value.trim(), signedAt);
      const assignment = await submitConsent(signedPdf, signedAt);
      saveAssignment(assignment);
      showResult(assignment, signedPdf);
    } catch (err) {
      console.error(err);
      showFormError(err.userMessage ||
        "Your consent could not be submitted. Please check your connection and try again. " +
        "If the problem continues, email alireza.nasirianfar@umontreal.ca or madjda.fares@umontreal.ca.");
      state.submitting = false;
      button.disabled = false;
      button.textContent = "Sign and submit consent";
    }
  });
}

function validate(form) {
  if (!state.pdfBytes) return "The consent form has not finished loading yet.";
  if (form.elements.name.value.trim().length < 2) return "Please enter your full name.";
  if (!signaturePad.hasInk()) return "Please draw your signature in the box.";
  if (!form.elements.agree.checked) return "Please confirm that you agree to participate.";
  if (!CONFIG.endpoint) return "This site is not configured yet (missing submission endpoint).";
  return "";
}

function showFormError(message) {
  const box = $("[data-form-error]");
  box.textContent = message || "";
  box.hidden = !message;
}

/* ---------- PDF stamping ---------- */

async function buildSignedPdf(name, signedAt) {
  const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
  const doc = await PDFDocument.load(state.pdfBytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  const ink = rgb(0.04, 0.16, 0.42);

  await drawName(doc, pages, font, ink, name);

  const signatureField = state.fields.signature;
  const signatureImage = await doc.embedPng(signaturePad.toTrimmedDataUrl());
  const fit = signatureImage.scaleToFit(SIG_MAX.width, SIG_MAX.height);
  pages[signatureField.pageIndex].drawImage(signatureImage, {
    x: signatureField.x,
    y: signatureField.y - 1,
    width: fit.width,
    height: fit.height,
  });

  const dateField = state.fields.date;
  pages[dateField.pageIndex].drawText(state.dateText, {
    x: dateField.x, y: dateField.y + TEXT_LIFT, size: NAME_FONT_SIZE, font, color: ink,
  });

  const lastPage = pages[pages.length - 1];
  lastPage.drawText(
    `Electronically signed via the SPARK consent website on ${signedAt.toISOString()} ` +
    `(consent version ${CONFIG.consentVersion}).`,
    { x: 72, y: 28, size: 7, font, color: rgb(0.35, 0.35, 0.35) },
  );

  doc.setModificationDate(signedAt);
  return doc.save();
}

async function drawName(doc, pages, font, ink, name) {
  const field = state.fields.name;
  const page = pages[field.pageIndex];
  try {
    font.encodeText(name);
    page.drawText(name, { x: field.x, y: field.y + TEXT_LIFT, size: NAME_FONT_SIZE, font, color: ink });
  } catch {
    // Standard PDF fonts only cover Latin-1; render other scripts through the browser instead.
    const image = await doc.embedPng(renderTextToPng(name));
    const height = NAME_FONT_SIZE * 1.4;
    page.drawImage(image, { x: field.x, y: field.y, width: (image.width / image.height) * height, height });
  }
}

function renderTextToPng(text) {
  const scale = 4;
  const fontSpec = `${NAME_FONT_SIZE * scale}px Helvetica, Arial, sans-serif`;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  ctx.font = fontSpec;
  canvas.width = Math.ceil(ctx.measureText(text).width) + 8;
  canvas.height = Math.ceil(NAME_FONT_SIZE * scale * 1.4);
  ctx.font = fontSpec;
  ctx.fillStyle = INK;
  ctx.textBaseline = "middle";
  ctx.fillText(text, 4, canvas.height / 2);
  return canvas.toDataURL("image/png");
}

/* ---------- Submission ---------- */

async function submitConsent(pdfBytes, signedAt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);
  try {
    const response = await fetch(CONFIG.endpoint, {
      method: "POST",
      // text/plain keeps this a "simple" request, so Apps Script needs no CORS preflight.
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        pdfBase64: await toBase64(pdfBytes),
        consentVersion: CONFIG.consentVersion,
        signedAt: signedAt.toISOString(),
      }),
      signal: controller.signal,
    });
    const result = await response.json();
    if (!result.ok) {
      const error = new Error(result.error || "Submission rejected");
      error.userMessage = result.message;
      throw error;
    }
    return { token: result.token, url: result.url };
  } finally {
    clearTimeout(timer);
  }
}

function toBase64(bytes) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([bytes], { type: "application/pdf" }));
  });
}

/* ---------- Result ---------- */

function showResult(assignment, signedPdf) {
  const section = $("#result");
  showAssignment(section, assignment);
  const download = $("[data-download]", section);
  download.href = URL.createObjectURL(new Blob([signedPdf], { type: "application/pdf" }));
  $("#consent-flow").hidden = true;
  section.hidden = false;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function showAssignment(section, assignment) {
  $("[data-token]", section).textContent = assignment.token;
  $("[data-survey-link]", section).href = assignment.url;
  const copy = $("[data-copy]", section);
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(assignment.token);
      copy.textContent = "Copied";
    } catch {
      const range = document.createRange();
      range.selectNodeContents($("[data-token]", section));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }
  });
}

function readSavedAssignment() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    return saved && saved.token && saved.url ? saved : null;
  } catch {
    return null;
  }
}

function saveAssignment(assignment) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: assignment.token, url: assignment.url }));
  } catch {
    // Private browsing can block storage; the participant still sees the token on screen.
  }
}

/* ---------- Helpers ---------- */

function formatDate(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CONFIG.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

init();
