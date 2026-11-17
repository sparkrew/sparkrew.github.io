/**
 * SPARK consent endpoint and balanced allocation.
 *
 * Container-bound to the private allocation spreadsheet. Form IDs live in FormConfig.gs,
 * which is kept out of the public repository.
 */

const RESEARCHERS = ["alireza.nasirianfar@umontreal.ca", "madjda.fares@umontreal.ca"];
const VARIANTS = ["A1", "A2", "A3", "B1", "B2", "B3"];
const BLOCKS = 30;

const ALLOCATION_SHEET = "Allocation";
const META_SHEET = "Meta";
const CHECK_SHEET = "TokenCheck";
const HEADERS = ["slot", "block", "variant", "token", "status", "issued_at", "completed_at", "consent_version", "note"];
const COL = HEADERS.reduce((map, name, index) => ((map[name] = index), map), {});

const TOKEN_PREFIX = "SPK-";
const TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TOKEN_LENGTH = 8;
const TOKEN_PATTERN = "^SPK-[A-HJ-NP-Z2-9]{8}$";
const TOKEN_ITEM_PREFIX = "Assignment token";

const TIME_ZONE = "America/Toronto";
const MAX_PDF_BYTES = 5 * 1024 * 1024;
const BURST_LIMIT = 20;
const BURST_WINDOW_SECONDS = 600;
const ABANDON_AFTER_DAYS = 7;

/* ---------- One-time setup ---------- */

/**
 * Creates the allocation sequence: BLOCKS blocks, each a random permutation of the six variants.
 * Run once from the editor before launch. Refuses to overwrite an existing sequence.
 */
function setupAllocation() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(ALLOCATION_SHEET)) {
    throw new Error("Allocation sheet already exists. The sequence must not be regenerated after launch.");
  }

  const seed = randomUint32_();
  const random = mulberry32_(seed);
  const tokens = new Set();
  const rows = [];
  for (let block = 1; block <= BLOCKS; block++) {
    shuffle_(VARIANTS.slice(), random).forEach((variant) => {
      let token;
      do token = newToken_(); while (tokens.has(token));
      tokens.add(token);
      rows.push([rows.length + 1, block, variant, token, "", "", "", "", ""]);
    });
  }

  const sheet = ss.insertSheet(ALLOCATION_SHEET);
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight("bold");
  sheet.getRange(2, 1, rows.length, HEADERS.length).setValues(rows);
  sheet.setFrozenRows(1);

  const meta = ss.getSheetByName(META_SHEET) || ss.insertSheet(META_SHEET);
  meta.clear();
  meta.getRange(1, 1, 5, 2).setValues([
    ["generated_at", Utilities.formatDate(new Date(), TIME_ZONE, "yyyy-MM-dd HH:mm:ss z")],
    ["shuffle_seed", seed],
    ["blocks", BLOCKS],
    ["variants", VARIANTS.join(",")],
    ["sequence_sha256", sequenceHash_(rows)],
  ]);

  PropertiesService.getScriptProperties().setProperty("SPREADSHEET_ID", ss.getId());
}

/* ---------- Web app ---------- */

function doGet() {
  return json_({ ok: true, service: "SPARK consent endpoint" });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: "BAD_REQUEST", message: "The submission could not be read. Please try again." });
  }

  const pdfBytes = decodePdf_(body.pdfBase64);
  if (!pdfBytes) {
    return json_({ ok: false, error: "BAD_PDF", message: "The signed consent form was not valid. Please try again." });
  }
  if (!withinBurstLimit_()) {
    return json_({ ok: false, error: "BUSY", message: "Many submissions are arriving right now. Please try again in a few minutes." });
  }

  const consentVersion = String(body.consentVersion || "").slice(0, 40);
  const signedAt = String(body.signedAt || "").slice(0, 40);

  const slot = claimSlot_(consentVersion);
  if (!slot) {
    return json_({
      ok: false,
      error: "FULL",
      message: "The study is no longer accepting new participants. Thank you for your interest.",
    });
  }

  try {
    sendConsentEmail_(slot, pdfBytes, consentVersion, signedAt);
  } catch (err) {
    // No consent on file means no survey link; return the slot so the sequence stays balanced.
    releaseSlot_(slot);
    console.error(err);
    return json_({
      ok: false,
      error: "EMAIL_FAILED",
      message: "Your consent could not be delivered to the researchers. Please try again later.",
    });
  }

  return json_({ ok: true, token: slot.token, url: prefilledUrl_(slot.variant, slot.token) });
}

/* ---------- Allocation ---------- */

function claimSlot_(consentVersion) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = allocationSheet_();
    const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADERS.length).getValues();
    const index = values.findIndex((row) => row[COL.status] === "");
    if (index < 0) return null;

    const row = index + 2;
    const issuedAt = new Date();
    sheet.getRange(row, COL.status + 1, 1, 2).setValues([["issued", issuedAt]]);
    sheet.getRange(row, COL.consent_version + 1).setValue(consentVersion);
    SpreadsheetApp.flush();

    const record = values[index];
    return {
      row,
      slot: record[COL.slot],
      block: record[COL.block],
      variant: record[COL.variant],
      token: record[COL.token],
      issuedAt,
    };
  } finally {
    lock.releaseLock();
  }
}

function releaseSlot_(slot) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = allocationSheet_();
    sheet.getRange(slot.row, COL.status + 1, 1, 2).setValues([["", ""]]);
    sheet.getRange(slot.row, COL.consent_version + 1).setValue("");
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
}

function allocationSheet_() {
  const id = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
  const ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(ALLOCATION_SHEET);
  if (!sheet) throw new Error("Run setupAllocation() first.");
  return sheet;
}

function prefilledUrl_(variant, token) {
  const form = FORMS[variant];
  if (!form || !form.publishedId || !form.entryId) throw new Error(`FormConfig missing for ${variant}`);
  return `https://docs.google.com/forms/d/e/${form.publishedId}/viewform?usp=pp_url` +
    `&entry.${form.entryId}=${encodeURIComponent(token)}`;
}

/* ---------- Email ---------- */

function sendConsentEmail_(slot, pdfBytes, consentVersion, signedAt) {
  const issued = Utilities.formatDate(slot.issuedAt, TIME_ZONE, "yyyy-MM-dd HH:mm:ss z");
  const body = [
    "A participant signed the SPARK survey consent form on the consent website.",
    "",
    `Assignment token: ${slot.token}`,
    `Variant: ${slot.variant}`,
    `Slot: ${slot.slot} (block ${slot.block})`,
    `Issued at: ${issued}`,
    `Signed at (participant's browser, UTC): ${signedAt || "not provided"}`,
    `Consent version: ${consentVersion || "not provided"}`,
    "",
    "The signed consent PDF is attached. Please verify the name, signature, and date,",
    "store the PDF in the restricted UdeM OneDrive consent folder, and record the",
    "consent-to-token mapping in the restricted identity-linkage file.",
    "",
    "The participant was sent to the prefilled questionnaire for this variant.",
  ].join("\n");

  MailApp.sendEmail({
    to: RESEARCHERS.join(","),
    subject: `SPARK consent – ${slot.token}`,
    body,
    name: "SPARK consent website",
    attachments: [Utilities.newBlob(pdfBytes, "application/pdf", `SPARK_consent_${slot.token}.pdf`)],
  });
}

/* ---------- Token check (run manually or on a time trigger) ---------- */

/**
 * Reads responses from all six forms, marks completed slots, marks issued slots older than
 * ABANDON_AFTER_DAYS without a response as abandoned, and writes a per-response report
 * flagging unknown tokens, wrong-variant tokens, and later duplicates (protocol exclusions 5 and 7).
 */
function checkTokens() {
  const responses = [];
  for (const variant of VARIANTS) {
    const config = FORMS[variant];
    if (!config || !config.editId) throw new Error(`FormConfig editId missing for ${variant}`);
    const form = FormApp.openById(config.editId);
    form.getResponses().forEach((response) => {
      const answer = response.getItemResponses()
        .find((item) => item.getItem().getTitle().indexOf(TOKEN_ITEM_PREFIX) === 0);
      responses.push({
        variant,
        id: response.getId(),
        submittedAt: response.getTimestamp(),
        token: answer ? String(answer.getResponse()).trim().toUpperCase() : "",
      });
    });
  }
  responses.sort((a, b) => a.submittedAt - b.submittedAt);

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    writeTokenCheck_(responses);
  } finally {
    lock.releaseLock();
  }
}

function writeTokenCheck_(responses) {
  const sheet = allocationSheet_();
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADERS.length).getValues();
  const byToken = new Map(values.map((row) => [String(row[COL.token]), { row }]));

  const firstUse = new Map();
  const report = responses.map((response) => {
    const entry = byToken.get(response.token);
    let result;
    if (!entry) result = "INVALID: unknown token";
    else if (entry.row[COL.variant] !== response.variant) result = `MISMATCH: token issued for ${entry.row[COL.variant]}`;
    else if (firstUse.has(response.token)) result = "DUPLICATE: later submission of this token";
    else {
      result = "OK";
      firstUse.set(response.token, response.submittedAt);
    }
    return [response.submittedAt, response.variant, response.id, response.token, result];
  });

  const now = Date.now();
  const cutoff = ABANDON_AFTER_DAYS * 24 * 60 * 60 * 1000;
  const statusUpdates = values.map((row) => {
    const status = row[COL.status];
    const completedAt = firstUse.get(String(row[COL.token]));
    if (completedAt && (status === "issued" || status === "abandoned" || status === "completed")) {
      return ["completed", row[COL.issued_at], completedAt];
    }
    if (status === "issued" && row[COL.issued_at] && now - new Date(row[COL.issued_at]).getTime() > cutoff) {
      return ["abandoned", row[COL.issued_at], ""];
    }
    return [status, row[COL.issued_at], row[COL.completed_at]];
  });
  sheet.getRange(2, COL.status + 1, statusUpdates.length, 3).setValues(statusUpdates);

  const ss = sheet.getParent();
  const check = ss.getSheetByName(CHECK_SHEET) || ss.insertSheet(CHECK_SHEET);
  check.clear();
  const header = [["submitted_at", "form_variant", "response_id", "token_entered", "result"]];
  check.getRange(1, 1, 1, 5).setValues(header).setFontWeight("bold");
  if (report.length) check.getRange(2, 1, report.length, 5).setValues(report);
  check.getRange(report.length + 3, 1).setValue(
    `Checked ${Utilities.formatDate(new Date(), TIME_ZONE, "yyyy-MM-dd HH:mm:ss z")}`);
}

/* ---------- Helpers ---------- */

function decodePdf_(base64) {
  if (typeof base64 !== "string" || !base64 || base64.length > Math.ceil(MAX_PDF_BYTES / 3) * 4) return null;
  let bytes;
  try {
    bytes = Utilities.base64Decode(base64);
  } catch (err) {
    return null;
  }
  const header = String.fromCharCode.apply(null, bytes.slice(0, 5));
  return header === "%PDF-" ? bytes : null;
}

function withinBurstLimit_() {
  const cache = CacheService.getScriptCache();
  const bucket = `burst-${Math.floor(Date.now() / (BURST_WINDOW_SECONDS * 1000))}`;
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const count = Number(cache.get(bucket) || 0) + 1;
    cache.put(bucket, String(count), BURST_WINDOW_SECONDS);
    return count <= BURST_LIMIT;
  } finally {
    lock.releaseLock();
  }
}

function newToken_() {
  const bytes = Utilities.newBlob(Utilities.getUuid() + Utilities.getUuid()).getBytes();
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes);
  let token = TOKEN_PREFIX;
  for (let i = 0; i < TOKEN_LENGTH; i++) token += TOKEN_ALPHABET[(digest[i] + 256) % TOKEN_ALPHABET.length];
  return token;
}

function randomUint32_() {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid());
  return (((digest[0] & 255) << 24) | ((digest[1] & 255) << 16) | ((digest[2] & 255) << 8) | (digest[3] & 255)) >>> 0;
}

function mulberry32_(seed) {
  let state = seed >>> 0;
  return function () {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle_(items, random) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function sequenceHash_(rows) {
  const text = rows.map((row) => `${row[COL.slot]},${row[COL.block]},${row[COL.variant]},${row[COL.token]}`).join("\n");
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text)
    .map((byte) => ((byte + 256) % 256).toString(16).padStart(2, "0"))
    .join("");
}

function json_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
