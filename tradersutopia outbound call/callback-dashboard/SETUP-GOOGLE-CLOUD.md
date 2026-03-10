# Step-by-Step: Google Cloud Service Account + Env Setup

You already have a Google Sheet. Follow these steps in order.

---

## Part 1: Get Your Spreadsheet ID

1. Open your Google Sheet in the browser.
2. Look at the URL. It looks like:
   ```
   https://docs.google.com/spreadsheets/d/1ABC123xyz...long_string.../edit
   ```
3. **Copy the part between `/d/` and `/edit`**. That is your `GOOGLE_SHEET_ID`.
   - Example: if the URL is `https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit`
   - Then `GOOGLE_SHEET_ID` = `1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms`

Put this in `.env.local` as:
```
GOOGLE_SHEET_ID=1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms
```
(use YOUR id, not this example)

---

## Part 2: Create a Google Cloud Project (if you don’t have one)

1. Go to **https://console.cloud.google.com**
2. Sign in with the same Google account you use for the sheet (or any Google account).
3. At the top, click the project dropdown (it might say “Select a project” or your project name).
4. Click **“New Project”**.
5. Name it something like **Callback Dashboard**.
6. Click **Create**. Wait a few seconds.

---

## Part 3: Enable Google Sheets API

1. In the top search bar, type **“Google Sheets API”** and open it.
2. Click **“Enable”**.
3. Wait until it says the API is enabled.

---

## Part 4: Create a Service Account

1. In the left menu, go to **“IAM & Admin”** → **“Service Accounts**.
   - Or search for “Service Accounts” in the top search bar.
2. Click **“+ Create Service Account”**.
3. **Service account name:** e.g. `callback-dashboard`.
4. **Service account ID:** leave default (it fills in from the name).
5. Click **“Create and Continue”**.
6. **Grant access (optional):** skip — click **“Continue”**.
7. **Grant users access (optional):** skip — click **“Done”**.

You’ll see your new service account in the list. Note the **email** (e.g. `callback-dashboard@your-project.iam.gserviceaccount.com`). You’ll use this to share the sheet.

---

## Part 5: Create a JSON Key

1. Click on the service account you just created (the email).
2. Open the **“Keys”** tab.
3. Click **“Add Key”** → **“Create new key”**.
4. Choose **JSON**.
5. Click **“Create”**. A JSON file will download.

**Important:** Keep this file private. Don’t commit it to git or share it. You’ll only paste its contents into `.env.local` on your machine.

---

## Part 6: Share Your Google Sheet With the Service Account

1. Open your **Google Sheet** (the one you already have).
2. Click **“Share”** (top right).
3. In “Add people and groups”, paste the **service account email** (e.g. `callback-dashboard@your-project.iam.gserviceaccount.com`).
4. Set the role to **Editor**.
5. **Uncheck** “Notify people” (the service account doesn’t read email).
6. Click **Share**.

Only your account and this service account should have access. Do **not** share the sheet with affiliates.

---

## Part 7: Put the JSON Into `.env.local`

The JSON file you downloaded looks like this (with real long values):

```json
{
  "type": "service_account",
  "project_id": "your-project-123",
  "private_key_id": "abc123...",
  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n",
  "client_email": "callback-dashboard@your-project.iam.gserviceaccount.com",
  "client_id": "123456789",
  ...
}
```

You need to put the **entire** JSON on **one line** (no line breaks) for `GOOGLE_SERVICE_ACCOUNT_JSON`.

**Option A — Use the helper script (easiest):**

1. Put your downloaded JSON file in the project folder and rename it to `service-account.json` (or leave the original name).
2. In the project folder run:
   ```bash
   node scripts/format-service-account.js
   ```
   It will print a single line. Copy that and set it in `.env.local` as:
   ```
   GOOGLE_SERVICE_ACCOUNT_JSON=<paste the one line here>
   ```

**Option B — Do it manually:**

1. Open the downloaded JSON file in a text editor.
2. Remove all line breaks so the whole thing is one line (e.g. use Find & Replace: replace newline with nothing).
3. Copy that single line.
4. In `.env.local` set:
   ```
   GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"...
   ```
   Paste so the value is the entire JSON in quotes. In some setups you may need to escape internal quotes; if you get JSON errors, use Option A.

---

## Part 8: Your Final `.env.local`

Your `.env.local` should have at least:

```
# Twilio (you already have these)
TWILIO_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH=your_auth_token_here
TWILIO_NUMBER=+18555077602

# Google Sheet (from Part 1)
GOOGLE_SHEET_ID=<your spreadsheet id from the URL>

# Optional — only if you want different tab names
GOOGLE_SHEET_CALLBACKS_TAB=Callbacks
GOOGLE_SHEET_LOGS_TAB=CallLogs

# Service account (from Part 7 — one line!)
GOOGLE_SERVICE_ACCOUNT_JSON=<paste the single-line JSON here>

# Access code affiliates use to log in
AFFILIATE_ACCESS_CODE=traders2026

# Only for local dev with ngrok
# PUBLIC_BASE_URL=https://xxxx.ngrok-free.app
```

Then run `npm run dev` and open http://localhost:3000/dashboard.

---

## Quick Checklist

- [ ] Spreadsheet ID copied from sheet URL into `GOOGLE_SHEET_ID`
- [ ] Google Cloud project created
- [ ] Google Sheets API enabled
- [ ] Service account created
- [ ] JSON key downloaded
- [ ] Sheet shared with service account email (Editor)
- [ ] JSON pasted as one line into `GOOGLE_SERVICE_ACCOUNT_JSON`
- [ ] `.env.local` saved and dev server restarted
