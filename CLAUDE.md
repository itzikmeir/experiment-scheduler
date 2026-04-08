# Experiment Scheduler — CLAUDE.md

## Project Overview
A Hebrew-language single-page web app for managing research experiment participants.
Built as a **single `index.html` file** (~3800 lines) with React (CDN, Babel in-browser),
backed by Google Apps Script + Google Sheets.

**GitHub**: https://github.com/itzikmeir/experiment-scheduler  
**Sheets**: https://docs.google.com/spreadsheets/d/1P5MUNE8ANNwS5UZh-dXT3jPhQzF6qpnWhsCPweClt9M/edit  
**Language**: Hebrew RTL UI, English code/comments  
**Version**: v1.8

---

## Architecture

```
Google Form  ──►  Form Responses 1 sheet
                         │
                   Apps Script (doGet/doPost)
                         │
                   Participants sheet  ◄──►  index.html (React SPA)
                   Locations sheet           (localStorage cache)
                   Settings sheet
```

### Files
| File | Purpose |
|------|---------|
| `index.html` | Entire frontend — React components, state, sync logic |
| `google-apps-script-v3.js` | Apps Script backend — must be deployed as Web App |

---

## Key Design Decisions

### Single File Architecture
Everything in `index.html`. No build step, no npm. React loaded from CDN via Babel transpiler.
**Consequence**: editing requires careful str_replace — no IDE refactoring.

### Sync Model — CRITICAL
**Sheets is the single source of truth.**

Flow on every sync (every 45s or manual ⇄):
1. `getAllData()` in Apps Script runs `mergeFormIntoParticipants()` **in memory** (no write)
2. Returns merged participant list to frontend
3. Frontend `mergeSheets(remote, local)` applies local scheduling overrides
4. `gsSaveAll()` writes everything back to Sheets

**`mergeSheets` rules:**
- Remote list defines **WHO EXISTS** — no "local-only" accumulation
- Local provides scheduling overrides: `expDate`, `startTime`, `assigned`, `notes`, `participantId`, `locPref`
- `participantId` set anywhere → status = "completed"
- Status rank: completed(3) > confirmed(2) > assigned(1) > pending(0)

### Known Recurring Issues
1. **Participant duplicates** — caused by `mergeSheets` accumulating stale local records. Fixed in v1.8 by making remote authoritative.
2. **Location duplicates** — `dedupeLocations()` deduplicates by name everywhere.
3. **expDate/startTime lost on sync** — fixed by using local overrides for scheduling fields.

---

## Data Model

### Participant object
```js
{
  id: Number,           // unique, assigned by Apps Script
  name: String,         // from Google Form
  email: String,
  phone: String,
  age: String,
  gender: String,       // "גבר" | "אישה" | "אחר"
  availability: {       // "א"-"ש" (Sun-Sat)
    "א": ["בוקר (08:00-12:00)", "צהריים (12:00-18:00)", "ערב (18:00-22:00)"],
    // ...
  },
  // Form data (from Google Form via importFromForm)
  surveyDate: Number,   // timestamp ms
  locPrefText: String,  // raw text from form
  eligible: String,     // גיל 18+
  licenseQ: String,     // רישיון נהיגה
  hebrewRead: String,   // קריאה בעברית
  visionNote: String,   // הצהרת ראייה
  // Scheduling (set by researchers)
  assigned: { day, slot, locationId, room } | null,
  startTime: String,    // "HH:MM"
  expDate: String,      // "YYYY-MM-DD"
  participantId: String,// "P001"-"P030" — unique, marks completed
  status: "pending" | "assigned" | "confirmed" | "completed" | "declined" | "irrelevant",
  notes: String,
  locPref: Number[],    // location IDs
  importedAt: Number,   // timestamp ms
}
```

### Location object
```js
{ id: Number, name: String, rooms: String[] }
```

---

## Permissions System
Three roles stored in `localStorage`:
- **admin** (👑): full access, approve deletes, save to Sheets
- **editor** (✏️): edit participants, request deletes
- **viewer** (👁): read-only

Passwords are SHA-256 hashed in `localStorage("exp_auth_pwds")`.

---

## Apps Script Functions
| Function | Trigger | Purpose |
|----------|---------|---------|
| `getAllData()` | GET `?action=getAll` | Read all data + run in-memory form import |
| `saveAll(body)` | POST `action=saveAll` | Write participants, locations, settings |
| `updateParticipant(body)` | POST `action=updateP` | Update single row by id/email/name |
| `importFromForm()` | Manual or via getAllData | Merge Form Responses → Participants (no overwrite of scheduling fields) |
| `mergeFormIntoParticipants()` | Called by getAllData | Pure function, no Sheets writes |

### Deploying Apps Script
1. Open Script Editor (Extensions → Apps Script)
2. Paste `google-apps-script-v3.js` content
3. Deploy → New deployment → Web App
4. Execute as: **Me**, Access: **Anyone**
5. Copy the `/exec` URL → paste into `const GS_URL` in `index.html`

---

## Frontend Components
| Component | Purpose |
|-----------|---------|
| `App` | Main component, all state, doSync, updP |
| `ParticipantModal` | Add/edit participant — includes survey card, participantId selector |
| `ModalShell` | Generic modal wrapper |
| `FreeMailModal` | Free-text email with AI rewrite |
| `EmailTab` | Email templates with recipient selection |
| `AuthPanel` | Login / role switching |

### State Flow
```
participants (useState) ←→ participantsRef (useRef, synced via useEffect)
           ↑                        ↓
     setParticipants          doSync reads ref
           ↑
     mergeSheets(remote, ref.current)
```

---

## Common Edit Patterns

### Adding a new field to participants
1. Add to `emptyP()` default object
2. Add to `parseRow()` return (CSV import)
3. Add to `mergeSheets()` merge logic
4. Add to `dedupeParticipants()` merge logic  
5. Add to `saveParticipant()` patch object
6. Add to Apps Script `P_HEADERS`, `writeParticipants`, `readParticipants`
7. Display in `ParticipantModal` survey card

### Adding a new status
1. Add to `STATUS_COLORS` constant
2. Add to LANG he/en strings
3. Add to `STATUS_META` and `statusMeta` useMemo
4. Add to `STATUS_RANK` in `dedupeParticipants` and `mergeSheets`

### Changing sync behavior
- `doSync` in App component (~line 754)
- `mergeSheets` function (~line 682)
- `getAllData` in Apps Script

---

## Debug / Troubleshooting

### Export Debug Log
Hamburger menu → "ייצוא לוג אבחון" → downloads JSON with:
- Duplicate participants/locations
- Status breakdown
- participantId assignments
- Last 20 changelog entries

### Common Issues
| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Participant missing after sync | Email mismatch between Form and Sheets | Check `mergeFormIntoParticipants` column mapping |
| Status reverts on sync | `mergeSheets` rank logic | Check `STATUS_RANK` and `participantId` detection |
| Location duplicates | Multiple sync clients added same location | `dedupeLocations` should catch — check localStorage |
| expDate disappears | Stale `participantsRef` in gsSaveAll | `finalParticipants` variable in doSync |

---

## Environment
- React 17.0.2 (CDN)
- Babel standalone 7.22.5 (in-browser)
- No build tools — edit `index.html` directly
- Apps Script runtime: V8
