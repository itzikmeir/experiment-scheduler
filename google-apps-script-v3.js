// ═══════════════════════════════════════════════════════════════════════════
//  Experiment Scheduler — Google Apps Script Backend v1.2
//  Added: importFromForm action — reads directly from Form Responses sheet
//  Added: LockService around every write path — prevents concurrent requests
//  (e.g. a bulk auto-assign firing many updateP calls, or a sync landing mid-
//  write) from interleaving and losing/reverting each other's changes.
// ═══════════════════════════════════════════════════════════════════════════

const SS = SpreadsheetApp.getActiveSpreadsheet();

const SHEETS = {
  PARTICIPANTS: "Participants",
  LOCATIONS:   "Locations",
  SETTINGS:    "Settings",
  LOG:         "Log",
};

const P_HEADERS = [
  "id","name","email","phone","age","gender",
  "avail_א","avail_ב","avail_ג","avail_ד","avail_ה","avail_ו","avail_ש",
  "assigned_day","assigned_slot","assigned_locId","assigned_room",
  "startTime","expDate","participantId","status","notes","locPref","locPrefText","eligible","licenseQ","hebrewRead","visionNote","surveyDate","importedAt","updatedAt","updatedBy"
];

// ─── Lock helper ──────────────────────────────────────────────────────────────
// Serializes every write against the Participants/Locations/Settings sheets.
// Apps Script Web Apps process concurrent requests independently — without
// this, two overlapping writes (e.g. a bulk action firing many updateP calls
// while a sync's full saveAll is also running) can interleave and whichever
// finishes last silently wins, reverting the other's changes.
function withLock(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error("Sheet is busy, please try again in a moment");
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ─── CORS helper ──────────────────────────────────────────────────────────────
function cors(data) {
  const out = ContentService.createTextOutput(JSON.stringify(data));
  out.setMimeType(ContentService.MimeType.JSON);
  return out;
}

// ─── Router ───────────────────────────────────────────────────────────────────
function doGet(e) {
  try {
    const action = e.parameter.action;
    if (action === "ping")           return cors({ ok: true, time: new Date().toISOString() });
    if (action === "getAll")         return cors(getAllData());
    if (action === "getLogs")        return cors({ logs: getLogs() });
    if (action === "importFromForm") return cors(importFromForm());
    if (action === "getLock")        return cors(getLock());
    if (action === "setLock")        return cors(setLock(body));
    if (action === "releaseLock")    return cors(releaseLock(body));
    if (action === "saveLocations")  return cors(saveLocationsAction(body));
    if (action === "getFormRows")    return cors(getFormRowsAction());
    return cors({ error: "Unknown action: " + action });
  } catch(err) {
    return cors({ error: err.toString() });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    if (action === "saveAll")  return cors(saveAll(body));
    if (action === "updateP")  return cors(updateParticipant(body));
    if (action === "addParticipant") return cors(addParticipant(body));
    return cors({ error: "Unknown action: " + action });
  } catch(err) {
    return cors({ error: err.toString() });
  }
}

// ─── getAllData ────────────────────────────────────────────────────────────────
function getAllData() {
  // Read existing participants
  const existing = readParticipants();

  // Merge form responses IN MEMORY only (no write) — fast
  let merged = existing;
  try {
    const formRows = readFormRows(); // read-only
    merged = mergeFormIntoParticipants(existing, formRows);
  } catch(e) {
    Logger.log("Form merge skipped: " + e);
  }

  return {
    participants: merged,
    locations:    readLocations(),
    settings:     readSettings(),
    researchers:  readResearchers(),
    lastUpdated:  new Date().toISOString(),
  };
}

// ─── readFormRows: read Form Responses without writing anything ───────────────
function readFormRows() {
  const allSheets = SS.getSheets();
  const formSheet = allSheets.find(s => {
    const n = s.getName();
    return n.includes("Form Responses") || n.includes("תגובות") || n.includes("Responses");
  });
  if (!formSheet) return [];
  return formSheet.getDataRange().getValues();
}

// ─── mergeFormIntoParticipants: pure function, no Sheets writes ───────────────
function mergeFormIntoParticipants(existing, formData) {
  if (!formData || formData.length < 2) return existing;

  const headers   = formData[0].map(h => h.toString().trim());
  const norm      = s => s.replace(/\s+/g,"").replace(/[\[\]'״׳]/g,"").toLowerCase();
  const findCol   = search => headers.findIndex(h => norm(h).includes(norm(search)));

  const nameCol   = findCol("שם מלא");
  const emailCol  = findCol("אימייל");
  const phoneCol  = findCol("טלפון");
  const ageCol    = findCol("גיל");
  const genderCol = findCol("מגדר");
  const visionCol = findCol("ראייה");
  const locPrefFormCol = findCol("מיקום");
  const eligibleCol    = findCol("גיל18");
  const licenseCol     = findCol("רישיון");
  const hebrewCol      = findCol("עברית");
  const DAY_COLS = {
    "א":findCol("יוםא"),"ב":findCol("יוםב"),"ג":findCol("יוםג"),
    "ד":findCol("יוםד"),"ה":findCol("יוםה"),"ו":findCol("יוםו"),"ש":findCol("יוםש"),
  };

  // Work on a mutable copy
  const result = existing.map(p => Object.assign({}, p));
  const byEmail = new Map(result.filter(p=>p.email).map(p=>[norm(p.email), p]));
  const byName  = new Map(result.map(p=>[norm(p.name), p]));
  const maxId   = result.reduce((m,p)=>Math.max(m,parseInt(p.id)||0),0);
  let nextId    = maxId + 1;

  formData.slice(1).forEach(row => {
    const name  = nameCol  >= 0 ? (row[nameCol]  || "").toString().trim() : "";
    const email = emailCol >= 0 ? (row[emailCol] || "").toString().trim() : "";
    if (!name && !email) return;

    const phone  = phoneCol  >= 0 ? (row[phoneCol]  || "").toString().trim() : "";
    const age    = ageCol    >= 0 ? (row[ageCol]    || "").toString().trim() : "";
    const gender = genderCol >= 0 ? (row[genderCol] || "").toString().trim() : "";
    const vision = visionCol >= 0 ? (row[visionCol] || "").toString().trim() : "";
    const locPrefForm = locPrefFormCol >= 0 ? (row[locPrefFormCol] || "").toString().trim() : "";
    const eligible    = eligibleCol    >= 0 ? (row[eligibleCol]    || "").toString().trim() : "";
    const licenseQ    = licenseCol     >= 0 ? (row[licenseCol]     || "").toString().trim() : "";
    const hebrewRead  = hebrewCol      >= 0 ? (row[hebrewCol]      || "").toString().trim() : "";
    const visionNote  = vision && !vision.includes("תקין") ? vision.substring(0,80) : "";
    const tsVal       = row[0];
    const surveyDate  = tsVal ? (tsVal instanceof Date ? tsVal.getTime() : new Date(tsVal).getTime() || null) : null;

    const avail = {};
    ["א","ב","ג","ד","ה","ו"].forEach(d => {
      const col = DAY_COLS[d];
      const raw = col >= 0 ? (row[col] || "").toString().trim() : "";
      avail[d] = raw ? raw.split(",").map(x=>x.trim()).filter(x=>
        x==="בוקר (08:00-12:00)" || x==="צהריים (12:00-18:00)" || x==="ערב (18:00-22:00)"
      ) : [];
    });

    const ep = (email ? byEmail.get(norm(email)) : null) || (name ? byName.get(norm(name)) : null);

    if (ep) {
      // Enrich only — never overwrite scheduling fields
      if (!ep.email && email)             ep.email       = email;
      if (!ep.phone && phone)             ep.phone       = phone;
      if (!ep.age   && age)               ep.age         = age;
      if (!ep.gender&& gender)            ep.gender      = gender;
      if (!ep.locPrefText && locPrefForm) ep.locPrefText = locPrefForm;
      if (!ep.eligible    && eligible)    ep.eligible    = eligible;
      if (!ep.licenseQ    && licenseQ)    ep.licenseQ    = licenseQ;
      if (!ep.hebrewRead  && hebrewRead)  ep.hebrewRead  = hebrewRead;
      if (!ep.visionNote  && visionNote)  ep.visionNote  = visionNote;
      if (!ep.surveyDate || (surveyDate && surveyDate > ep.surveyDate)) {
        ep.availability = avail;
        ep.surveyDate   = surveyDate;
      }
    } else {
      // New participant
      const np = {
        id: nextId++, name, email, phone, age, gender,
        availability: avail, locPrefText: locPrefForm,
        eligible, licenseQ, hebrewRead, visionNote, locPref: [],
        assigned: null, startTime: "", expDate: "", participantId: "",
        status: "pending", notes: "",
        surveyDate: surveyDate || null, importedAt: Date.now(),
      };
      result.push(np);
      if (email) byEmail.set(norm(email), np);
      if (name)  byName.set(norm(name), np);
    }
  });

  return result;
}

// ─── saveAll ──────────────────────────────────────────────────────────────────
function saveAll(body) {
  return withLock(() => {
    const { participants, locations, settings, researchers, user } = body;
    if (participants) writeParticipants(participants, user || "unknown");
    if (locations)    writeLocations(locations);
    if (settings)     writeSettings(settings);
    if (researchers)  writeResearchers(researchers);
    addLog(user || "unknown", "saveAll", "נשמרו " + (participants||[]).length + " משתתפים");
    return { ok: true, savedAt: new Date().toISOString() };
  });
}

// ─── updateParticipant ────────────────────────────────────────────────────────
function updateParticipant(body) {
  return withLock(() => {
    const { id, patch, user } = body;
    const sheet = SS.getSheetByName(SHEETS.PARTICIPANTS);
    if (!sheet) return { error: "Participants sheet not found" };

    const data    = sheet.getDataRange().getValues();
    const headers = data[0];
    const idCol   = headers.indexOf("id");

    const nameCol  = headers.indexOf("name");
    const emailCol = headers.indexOf("email");
    let rowIdx = -1;

    // Try match by id first, then by email, then by name
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][idCol]) === String(id)) { rowIdx = i; break; }
    }
    if (rowIdx < 0 && patch.email) {
      const pEmail = patch.email.toLowerCase().trim();
      for (let i = 1; i < data.length; i++) {
        if (emailCol>=0 && String(data[i][emailCol]).toLowerCase().trim()===pEmail) { rowIdx=i; break; }
      }
    }
    if (rowIdx < 0 && patch.name) {
      const pName = patch.name.trim();
      for (let i = 1; i < data.length; i++) {
        if (nameCol>=0 && String(data[i][nameCol]).trim()===pName) { rowIdx=i; break; }
      }
    }

    if (rowIdx >= 0) {
      Object.entries(patch).forEach(([key, val]) => {
        const col = headers.indexOf(key);
        if (col >= 0) sheet.getRange(rowIdx + 1, col + 1).setValue(val !== null && val !== undefined ? val : "");
      });
      const utCol = headers.indexOf("updatedAt");
      const ubCol = headers.indexOf("updatedBy");
      if (utCol >= 0) sheet.getRange(rowIdx + 1, utCol + 1).setValue(new Date().toISOString());
      if (ubCol >= 0) sheet.getRange(rowIdx + 1, ubCol + 1).setValue(user || "");
      addLog(user || "unknown", "updateP", "עדכון ID=" + id);
      return { ok: true };
    }
    return { error: "Participant not found: id=" + id };
  });
}

// ─── addParticipant ───────────────────────────────────────────────────────────
// Appends exactly ONE new row — never touches any other row. Unlike saveAll
// (which clearContents()s and rewrites the whole sheet from whatever list the
// client sends), this is safe even if the calling client's local cache is
// stale relative to Sheets: it can only add, never overwrite/erase existing
// data. The new id is computed here, inside the lock, from the sheet's own
// current contents — not from the client's (possibly stale) copy — so two
// concurrent adds from different clients can never collide on the same id.
function addParticipant(body) {
  return withLock(() => {
    const sheet = getOrCreate(SHEETS.PARTICIPANTS);
    if (sheet.getLastRow() === 0) sheet.appendRow(P_HEADERS);
    const data  = sheet.getDataRange().getValues();
    const idCol = P_HEADERS.indexOf("id");
    let maxId = 0;
    for (let i = 1; i < data.length; i++) {
      const v = parseInt(data[i][idCol]);
      if (!isNaN(v) && v > maxId) maxId = v;
    }
    const newIdVal = maxId + 1;
    const patch = body.patch || {};
    const row = P_HEADERS.map(h => {
      if (h === "id") return newIdVal;
      if (h === "updatedAt") return new Date().toISOString();
      if (h === "updatedBy") return body.user || "";
      const v = patch[h];
      return v !== null && v !== undefined ? v : "";
    });
    sheet.appendRow(row);
    addLog(body.user || "unknown", "addParticipant", "נוסף משתתף חדש: " + (patch.name||"") + " id=" + newIdVal);
    return { ok: true, id: newIdVal };
  });
}

// ─── importFromForm ───────────────────────────────────────────────────────────
// Called explicitly (e.g. from trigger). Uses shared helpers.
function importFromForm() {
  return withLock(() => {
    let formData;
    try { formData = readFormRows(); } catch(e) { return { error: "Form sheet not found" }; }
    if (!formData || formData.length < 2) return { error: "Form Responses sheet not found" };

    const existing = readParticipants();
    const before    = existing.length;
    const merged    = mergeFormIntoParticipants(existing, formData);
    writeParticipants(merged, "form-import");
    const addedCount = merged.length - before;
    addLog("form-import", "importFromForm", "נוספו " + addedCount);
    return { ok: true, added: addedCount, total: merged.length };
  });
}

// ─── syncFromForm: smart merge Form Responses → Participants ─────────────────
// Reads Form Responses, merges with existing Participants via the same shared
// mergeFormIntoParticipants used by getAllData (enrich-only, never touches
// status/assigned/startTime/expDate/notes/locPref/participantId), then writes.
function syncFromForm(body) {
  return withLock(() => {
    let formData;
    try { formData = readFormRows(); } catch(e) { return { error: "Form sheet not found" }; }
    if (!formData || formData.length < 2) return { error: "No form data" };

    const existing = readParticipants();
    const before    = existing.length;
    const merged    = mergeFormIntoParticipants(existing, formData);
    writeParticipants(merged, (body && body.user) || "sync");
    return { ok: true, added: merged.length - before, total: merged.length };
  });
}

// ─── doSaveLocations ─────────────────────────────────────────────────────────
function doSaveLocations(body) {
  return withLock(() => {
    if (body?.locations) writeLocations(body.locations);
    return { ok: true };
  });
}

// ─── doSetSetting / doGetSetting ─────────────────────────────────────────────
function doSetSetting(body) {
  return withLock(() => {
    const sheet = getOrCreate(SHEETS.SETTINGS);
    const data  = sheet.getDataRange().getValues();
    for (let i = 0; i < data.length; i++) {
      if (String(data[i][0]) === body.key) {
        sheet.getRange(i+1, 2).setValue(body.value||"");
        return { ok: true };
      }
    }
    sheet.appendRow([body.key, body.value||""]);
    return { ok: true };
  });
}

function doGetSetting(key) {
  const sheet = SS.getSheetByName(SHEETS.SETTINGS);
  if (!sheet) return { value: "" };
  const data = sheet.getDataRange().getValues();
  for (const row of data) {
    if (String(row[0]) === key) return { value: String(row[1]||"") };
  }
  return { value: "" };
}

// ─── Participants read/write ──────────────────────────────────────────────────
function readParticipants() {
  const sheet = SS.getSheetByName(SHEETS.PARTICIPANTS);
  if (!sheet || sheet.getLastRow() < 2) return [];

  const data    = sheet.getDataRange().getValues();
  const headers = data[0];

  return data.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = row[i]);

    obj.availability = {
      "א": obj["avail_א"] ? String(obj["avail_א"]).split("|").filter(Boolean) : [],
      "ב": obj["avail_ב"] ? String(obj["avail_ב"]).split("|").filter(Boolean) : [],
      "ג": obj["avail_ג"] ? String(obj["avail_ג"]).split("|").filter(Boolean) : [],
      "ד": obj["avail_ד"] ? String(obj["avail_ד"]).split("|").filter(Boolean) : [],
      "ה": obj["avail_ה"] ? String(obj["avail_ה"]).split("|").filter(Boolean) : [],
      "ו": obj["avail_ו"] ? String(obj["avail_ו"]).split("|").filter(Boolean) : [],
      "ש": obj["avail_ש"] ? String(obj["avail_ש"]).split("|").filter(Boolean) : [],
    };

    obj.assigned = obj["assigned_day"] ? {
      day:        String(obj["assigned_day"]),
      slot:       String(obj["assigned_slot"]),
      locationId: parseInt(obj["assigned_locId"]) || null,
      room:       String(obj["assigned_room"] || ""),
    } : null;

    ["avail_א","avail_ב","avail_ג","avail_ד","avail_ה","avail_ו","avail_ש",
     "assigned_day","assigned_slot","assigned_locId","assigned_room"
    ].forEach(k => delete obj[k]);

    obj.locPref = obj["locPref"] ? String(obj["locPref"]).split("|").filter(Boolean).map(Number) : [];
    obj.startTime     = obj["startTime"]     ? String(obj["startTime"])     : "";
    obj.expDate = (function(v) {
      if (!v) return "";
      var s = String(v).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
      var d = new Date(v);
      if (isNaN(d.getTime())) return "";
      return d.toISOString().slice(0,10);
    })(obj["expDate"]);
    obj.participantId = obj["participantId"] ? String(obj["participantId"]) : "";
    obj.locPrefText = obj["locPrefText"] ? String(obj["locPrefText"]) : "";
    obj.eligible    = obj["eligible"]    ? String(obj["eligible"])    : "";
    obj.licenseQ    = obj["licenseQ"]    ? String(obj["licenseQ"])    : "";
    obj.hebrewRead  = obj["hebrewRead"]  ? String(obj["hebrewRead"])  : "";
    obj.visionNote  = obj["visionNote"]  ? String(obj["visionNote"])  : "";
    // (fields already parsed above)
    obj.surveyDate = obj["surveyDate"] ? (typeof obj["surveyDate"]==="number" ? obj["surveyDate"] : new Date(obj["surveyDate"]).getTime() || null) : null;
    obj.id = parseInt(obj.id) || obj.id;
    return obj;
  }).filter(p => p.name);
}

function writeParticipants(participants, user) {
  const sheet = getOrCreate(SHEETS.PARTICIPANTS);
  // Dedup: same id = merge; same email = merge
  const seenIds    = new Map();
  const seenEmails = new Map();
  const deduped    = [];
  const STATUS_RANK = {pending:0,assigned:1,confirmed:2,completed:3,declined:1,irrelevant:0};

  (participants||[]).forEach(p => {
    if (!p || (!p.name && !p.email)) return;
    const idKey    = String(p.id);
    const emailKey = (p.email||"").toLowerCase().trim();
    const existIdx = seenIds.has(idKey) ? seenIds.get(idKey)
                   : (emailKey && seenEmails.has(emailKey)) ? seenEmails.get(emailKey)
                   : -1;
    if (existIdx >= 0) {
      // Merge: keep richer values
      const ex = deduped[existIdx];
      const exRank = STATUS_RANK[ex.participantId?"completed":ex.status]??0;
      const pRank  = STATUS_RANK[p.participantId?"completed":p.status]??0;
      deduped[existIdx] = {
        ...ex,
        participantId: ex.participantId || p.participantId || "",
        status: (ex.participantId||p.participantId)?"completed": exRank>=pRank?ex.status:p.status,
        notes: ex.notes || p.notes || "",
        expDate: ex.expDate || p.expDate || "",
        startTime: ex.startTime || p.startTime || "",
        assigned: ex.assigned || p.assigned || null,
        assigned_day: ex.assigned_day || p.assigned_day || "",
        assigned_slot: ex.assigned_slot || p.assigned_slot || "",
        assigned_locId: ex.assigned_locId || p.assigned_locId || "",
        assigned_room: ex.assigned_room || p.assigned_room || "",
      };
    } else {
      const idx = deduped.length;
      seenIds.set(idKey, idx);
      if (emailKey) seenEmails.set(emailKey, idx);
      deduped.push({...p, status: p.participantId?"completed":p.status});
    }
  });

  sheet.clearContents();
  sheet.appendRow(P_HEADERS);

  deduped.forEach(p => {
    sheet.appendRow([
      p.id,
      p.name        || "",
      p.email       || "",
      p.phone       || "",
      p.age         || "",
      p.gender      || "",
      (p.availability?.["א"] || []).join("|"),
      (p.availability?.["ב"] || []).join("|"),
      (p.availability?.["ג"] || []).join("|"),
      (p.availability?.["ד"] || []).join("|"),
      (p.availability?.["ה"] || []).join("|"),
      (p.availability?.["ו"] || []).join("|"),
      (p.availability?.["ש"] || []).join("|"),
      p.assigned?.day        || "",
      p.assigned?.slot       || "",
      p.assigned?.locationId || "",
      p.assigned?.room       || "",
      p.startTime   || "",
      p.expDate     || "",
      p.participantId || "",
      p.status      || "pending",
      p.notes       || "",
      (p.locPref || []).join("|"),
      p.locPrefText || "",
      p.eligible    || "",
      p.licenseQ    || "",
      p.hebrewRead  || "",
      p.visionNote  || "",
      p.surveyDate  || "",
      p.importedAt  || "",
      new Date().toISOString(),
      user          || "",
    ]);
  });

  try {
    sheet.getRange(1, 1, 1, P_HEADERS.length)
         .setFontWeight("bold")
         .setBackground("#E8EAED");
    sheet.setFrozenRows(1);
  } catch(e) {}
}

// ─── Locations ────────────────────────────────────────────────────────────────
function readLocations() {
  const sheet = SS.getSheetByName(SHEETS.LOCATIONS);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getDataRange().getValues().slice(1).map(row => ({
    id:    parseInt(row[0]) || row[0],
    name:  String(row[1]),
    rooms: row[2] ? String(row[2]).split("|").filter(Boolean) : [],
  })).filter(l => l.name);
}

function writeLocations(locations) {
  const sheet = getOrCreate(SHEETS.LOCATIONS);
  // Dedup by name AND id — assign new ids to collisions
  const seenNames = new Map();
  const seenIds   = new Set();
  const existing  = readLocations(); // get current max id
  let maxId = existing.reduce((m,l)=>Math.max(m,parseInt(l.id)||0),0);

  const deduped = [];
  locations.forEach(l => {
    if (!l?.name) return;
    const nameKey = l.name.trim().toLowerCase();
    if (seenNames.has(nameKey)) return; // skip duplicate name
    let lid = parseInt(l.id) || 0;
    if (seenIds.has(lid)) {
      lid = ++maxId; // assign new unique id to collision
    }
    seenNames.set(nameKey, true);
    seenIds.add(lid);
    deduped.push({...l, id: lid});
  });

  sheet.clearContents();
  sheet.appendRow(["id", "name", "rooms"]);
  deduped.forEach(l => sheet.appendRow([l.id, l.name, (l.rooms || []).join("|")]));
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function readSettings() {
  const sheet = SS.getSheetByName(SHEETS.SETTINGS);
  if (!sheet || sheet.getLastRow() < 1) return {};
  const obj = {};
  sheet.getDataRange().getValues().forEach(row => { if (row[0]) obj[row[0]] = row[1]; });
  return obj;
}

function writeSettings(settings) {
  const sheet = getOrCreate(SHEETS.SETTINGS);
  sheet.clearContents();
  Object.entries(settings).forEach(([k, v]) => sheet.appendRow([k, v]));
}

// ─── Researchers ──────────────────────────────────────────────────────────────
function readResearchers() {
  const sheet = SS.getSheetByName("Researchers");
  if (!sheet || sheet.getLastRow() < 1) return ["חוקר 1"];
  return sheet.getDataRange().getValues().flat().filter(Boolean);
}

function writeResearchers(list) {
  const sheet = getOrCreate("Researchers");
  sheet.clearContents();
  list.forEach(r => sheet.appendRow([r]));
}

// ─── Log ──────────────────────────────────────────────────────────────────────
function addLog(user, action, details) {
  const sheet = getOrCreate(SHEETS.LOG);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(["timestamp", "user", "action", "details"]);
    try { sheet.getRange(1,1,1,4).setFontWeight("bold").setBackground("#E8EAED"); sheet.setFrozenRows(1); } catch(e) {}
  }
  sheet.appendRow([new Date().toISOString(), user, action, details]);
}

function getLogs() {
  const sheet = SS.getSheetByName(SHEETS.LOG);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const data    = sheet.getDataRange().getValues();
  const headers = data[0];
  return data.slice(1).reverse().slice(0, 300).map(row => {
    const obj = {}; headers.forEach((h, i) => obj[h] = row[i]); return obj;
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getOrCreate(name) {
  return SS.getSheetByName(name) || SS.insertSheet(name);
}

function setupSheets() {
  Object.values(SHEETS).forEach(name => getOrCreate(name));
  getOrCreate("Researchers");
  Logger.log("All sheets created successfully!");
}

// ─── Test ─────────────────────────────────────────────────────────────────────
function testImportFromForm() {
  const result = importFromForm();
  Logger.log("Result: " + JSON.stringify(result));
}

// ─── getFormRowsAction ────────────────────────────────────────────────────────
function getFormRowsAction() {
  try {
    var rows = readFormRows();
    return {ok:true, rows: rows};
  } catch(e) {
    return {error: String(e)};
  }
}

// ─── Editor lock ──────────────────────────────────────────────────────────────
var LOCK_SETTING_KEY = "editLock";

function getLock() {
  var sheet = SS.getSheetByName(SHEETS.SETTINGS);
  if (!sheet) return {lock:null};
  var data = sheet.getDataRange().getValues();
  for (var i=0; i<data.length; i++) {
    if (String(data[i][0]) === LOCK_SETTING_KEY) {
      try { return {lock: JSON.parse(String(data[i][1]))}; } catch(e) { return {lock:null}; }
    }
  }
  return {lock:null};
}

function setLock(body) {
  return withLock(() => {
    var lockData = JSON.stringify({user: body.user||"unknown", since: body.since||Date.now()});
    var sheet = getOrCreate(SHEETS.SETTINGS);
    var data = sheet.getDataRange().getValues();
    for (var i=0; i<data.length; i++) {
      if (String(data[i][0]) === LOCK_SETTING_KEY) {
        sheet.getRange(i+1, 2).setValue(lockData);
        return {ok:true};
      }
    }
    sheet.appendRow([LOCK_SETTING_KEY, lockData]);
    return {ok:true};
  });
}

function releaseLock(body) {
  return withLock(() => {
    var sheet = SS.getSheetByName(SHEETS.SETTINGS);
    if (!sheet) return {ok:true};
    var data = sheet.getDataRange().getValues();
    for (var i=0; i<data.length; i++) {
      if (String(data[i][0]) === LOCK_SETTING_KEY) {
        var current;
        try { current = JSON.parse(String(data[i][1])); } catch(e) { current = null; }
        // Only release if it's the same user
        if (!current || current.user === body.user) {
          sheet.getRange(i+1, 2).setValue("");
        }
        return {ok:true};
      }
    }
    return {ok:true};
  });
}

// ─── saveLocationsAction ──────────────────────────────────────────────────────
function saveLocationsAction(body) {
  return withLock(() => {
    if (body.locations) writeLocations(body.locations);
    return {ok:true};
  });
}
