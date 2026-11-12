# Document photos & AI scanning

Two independent, optional features:

| Feature | Enabled by | What users get |
|---|---|---|
| **Digital copies** | `FILE_ENCRYPTION_KEY` | Up to 4 photos per item (front, back, other), encrypted at rest, viewable only by their owner |
| **Scan a photo** | `GROQ_API_KEY` | The add/edit form fills itself in from a photo: title, category, masked reference, expiry date, validity cycle |

## How scanning works

1. The user picks or takes a photo in the item dialog.
2. **In the browser** (`public/js/photos.js`): the photo is decoded, its rotation fixed, scaled to at most 2000 px and re-encoded as JPEG. This drops EXIF metadata such as GPS location; typical uploads are 0.3–1.5 MB.
3. **Consent:** before a user's first scan, a dialog explains that the photo goes to Groq (an AI provider in the USA) and offers to skip. Declining keeps the photo but sends nothing.
4. **On the server** (`src/lib/jpeg.js`): the file must be a well-formed JPEG. EXIF/XMP, IPTC and comment segments are stripped again.
5. `src/services/scan.js` sends the image to Groq's chat-completions API in **JSON mode**, with a prompt that asks for the document type, a generic title, the expiry and issue dates, the last 4 characters of the document number, and the licence plate for vehicle discs. It explicitly asks for **no names, ID numbers or addresses**, and says that text in the image is data, not instructions.
6. **The reply is untrusted input:**
   - It's parsed out of any `<think>` blocks or code fences, then validated with zod. Unknown fields are dropped.
   - Category must be a known value (otherwise "Other").
   - Dates are normalised: `YYYY-MM-DD`, `DD/MM/YYYY`, and bank-card `MM/YY` becomes the last day of that month. Implausible dates are discarded.
   - Any run of 5+ digits is masked to its last 4.
7. The result **pre-fills** the form, with filled fields highlighted. **Nothing is saved until the user presses Save.**
   - New item with no expiry found: the placeholder date is cleared and the form asks for one.
   - Scan while editing: only the expiry date and reference change, which suits a renewed card.

Nothing from the scan endpoint is stored. Logs record model, latency, token count and outcome, never the image or the extracted values.

## Digital copies

- **Encryption:** AES-256-GCM (`src/lib/crypto-box.js`). The key (`FILE_ENCRYPTION_KEY`) lives only in the environment, so database dumps and backups alone don't expose photos. Each row's ID is bound as additional authenticated data.
- **Access:** owner only, enforced in SQL. Other users and admins get 404. Responses use `Cache-Control: private, no-store`, and the service worker never caches photos.
- **Limits:** 4 photos per item, 4 MB each after compression, 100 MB per user. The dialog says when an item is full.
- **Lifecycle:** deleting an item hides its photos immediately, Undo restores them within 60 minutes, and then the maintenance job removes them permanently. Deleting the account removes everything at once.
- **Export:** the JSON export lists photo metadata and URLs, not the image bytes.

## Consent and POPIA

- Consent is recorded per user (`users.ai_scan_consent_at`) and can be withdrawn in **Settings → Document photos**.
- **Operator to-do:** in the Groq console, turn on **Zero Data Retention** (Data Controls). By default Groq doesn't keep inference data, but it may hold requests for up to 30 days to prevent abuse. If you enable ZDR, update the consent text in `public/index.html` (`#consent-dialog`) to match.
- Review the cross-border transfer (South Africa → USA) against your own POPIA obligations. That's a legal judgement the code can't make for you.

## Model choice

- **Default model:** `GROQ_MODEL` defaults to `qwen/qwen3.8-27b`, the vision model Groq listed when this was built. The earlier Llama 4 Scout model was retired in July 2026.
- **Preview status:** Groq marks vision models as preview, and they can be discontinued at short notice. Check [Groq's vision docs](https://console.groq.com/docs/vision) periodically. Changing the model is a variable change, not a code change.
- **Testing:** all automated tests use a mock Groq server. **Validate the live model on real documents** (licence card, licence disc, firearm licence, bank cards, passport) before relying on it, and adjust the prompt in `buildPrompt()` if needed.

## Rate limits and costs

Each user can run 30 scans per hour. Groq bills per token; each image counts as roughly 1,000–2,000 input tokens, depending on the model.

## Limitations

- One photo per scan (the front). The back can be attached but isn't read.
- HEIC photos only open in browsers that can decode them (Safari). Other browsers ask for JPEG or PNG.
- Encryption-key rotation isn't implemented yet (`key_version` is stored, ready for it).
