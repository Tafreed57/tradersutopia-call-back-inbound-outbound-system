# Callback Dashboard — TradersUtopia

Affiliate callback queue and Twilio bridge dialer. Google Sheets is the hidden backend database. Affiliates only use the web app.

## Setup Runbook

### Step 1: Create a Google Cloud Service Account

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project (or use an existing one)
3. Enable the **Google Sheets API**: APIs & Services → Library → search "Google Sheets API" → Enable
4. Create a Service Account: IAM & Admin → Service Accounts → Create
   - Give it a name like `callback-dashboard`
   - Skip optional permissions
5. Create a key: click the service account → Keys → Add Key → Create New Key → **JSON**
6. Download the JSON file — you'll paste its contents into `GOOGLE_SERVICE_ACCOUNT_JSON`

### Step 2: Create & Share the Google Sheet

1. Create a new Google Sheet (any Google account)
2. Copy the spreadsheet ID from the URL: `https://docs.google.com/spreadsheets/d/<THIS_PART>/edit`
3. Share the sheet with the service account email (found in the JSON file, field `client_email`). Give it **Editor** access.
4. Do NOT share the sheet with affiliates.

### Step 3: Set Environment Variables

Copy `.env.example` to `.env.local` and fill in:

```
TWILIO_SID=AC...
TWILIO_AUTH=...
TWILIO_NUMBER=+18555077602
GOOGLE_SHEET_ID=your_spreadsheet_id
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account",...entire JSON...}
AFFILIATE_ACCESS_CODE=traders2026
```

**Important:** The `GOOGLE_SERVICE_ACCOUNT_JSON` must be the ENTIRE JSON file content on a single line.

### Step 4: Run Locally

```bash
npm install
npm run dev
```

Open http://localhost:3000 → redirects to /dashboard → enter access code → enter your phone → see leads.

### Step 5: Local Twilio Testing (ngrok)

Twilio needs a public URL to reach `/api/bridge`. For local dev:

```bash
ngrok http 3000
```

Copy the `https://...ngrok-free.app` URL and set it in `.env.local`:

```
PUBLIC_BASE_URL=https://xxxx-xx-xx.ngrok-free.app
```

Restart the dev server after changing `.env.local`.

### Step 6: Deploy to Vercel

1. **Initialize Git** (if not already):
   ```bash
   cd callback-dashboard
   git init
   git add .
   git commit -m "Initial commit"
   ```

2. **Push to GitHub:**
   - Create a new repo on GitHub (private is fine)
   - ```bash
     git remote add origin https://github.com/YOUR_USER/callback-dashboard.git
     git push -u origin main
     ```

3. **Import in Vercel:**
   - Go to [vercel.com/new](https://vercel.com/new)
   - Select your GitHub repo
   - Framework: **Next.js** (auto-detected)

4. **Set Environment Variables** in Vercel → Settings → Environment Variables:

   | Name | Value |
   |------|-------|
   | `TWILIO_SID` | `AC6fc4fffe...` (your Twilio SID) |
   | `TWILIO_AUTH` | `bfc718bf...` (your Twilio auth token) |
   | `TWILIO_NUMBER` | `+18555077602` |
   | `GOOGLE_SHEET_ID` | `1LI71rRt...` (your Sheet ID) |
   | `GOOGLE_SHEET_CALLBACKS_TAB` | `Callback Queue` |
   | `GOOGLE_SHEET_LOGS_TAB` | `CallLogs` |
   | `GOOGLE_SERVICE_ACCOUNT_JSON` | `{"type":"service_account",...}` (entire JSON, one line) |
   | `AFFILIATE_ACCESS_CODE` | `traders2026` |

   **Do NOT set `PUBLIC_BASE_URL`** — Vercel auto-detects from `VERCEL_URL`.

5. **Deploy** — click Deploy and wait ~1 min.

6. **Update Twilio (if needed):** If you were using ngrok for local dev, Twilio doesn't need any dashboard config changes — the bridge URL is generated dynamically per call.

### Step 7: Verify Production

1. Open your Vercel URL → `/dashboard`
2. Log in with access code
3. Enter your phone number
4. You should see your leads from Google Sheets
5. Click "Mark Called" on a lead → status updates instantly on dashboard AND in Google Sheets
6. Click "Call" on a lead → your phone rings → answer → you hear "Connecting you to your callback" → lead's phone rings
7. Check Google Sheets to confirm the status column updated

### Step 8: Custom Domain (Optional)

In Vercel → Settings → Domains → add your custom domain (e.g. `callbacks.tradersutopia.com`).

## Troubleshooting

- **"Invalid access code"** — Check `AFFILIATE_ACCESS_CODE` in env vars matches what you type
- **"Missing GOOGLE_SERVICE_ACCOUNT_JSON"** — The env var is not set or is malformed JSON
- **Google API 403** — Sheet not shared with the service account email
- **Google API 404** — Wrong `GOOGLE_SHEET_ID`
- **Google API "Quota exceeded"** — Too many reads/writes per minute. The app retries automatically; wait 60s
- **Twilio 20003 "Authentication Error"** — Wrong `TWILIO_SID` or `TWILIO_AUTH`
- **Twilio 21219 "Number not verified"** — Trial account; verify both phones at console.twilio.com
- **"HTTP retrieval failure"** — Twilio can't reach `/api/bridge`; check ngrok is running (local) or Vercel URL is correct (production)
- **Empty lead list** — Check the tab name matches `GOOGLE_SHEET_CALLBACKS_TAB` and the sheet has data rows
- **Mark Called not updating Google Sheets** — Check the server terminal for errors; the lead ID must match
