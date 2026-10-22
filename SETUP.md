# Lending Library — setup guide

This turns the files in this folder into a real website with shared data, sign-in and reminders.
Everything is free. Allow about an hour the first time; it can be split over several days.

**What you'll end up with**

| Piece | What it's for | Who controls it |
|---|---|---|
| Shared Google account | Owns the database and sends the reminder emails | You + one co-owner (shared login) |
| Firebase project | Stores the data and handles sign-in | Owners of the Firebase project |
| GitHub organisation | Holds the website code and publishes the site | Owners of the GitHub organisation |
| Google Apps Script | Sends reminders, escalations and the morning summary | The shared Google account |
| Staff list (inside the site) | Who can sign in | Supervisors |

**Try it first.** Open the demo link from the chat, or run `python3 -m http.server` in this folder and go to <http://localhost:8000>. While `config.js` is empty, the site uses made-up sample data and saves nothing.

---

## Step 1 — Shared Google account (10 min)

1. Go to <https://accounts.google.com/signup> and create e.g. `housing.lendinglibrary@gmail.com`.
2. Use a strong password and turn on 2-step verification.
3. Share the login with the co-owner, and keep it somewhere a supervisor can reach too.
4. Be signed in as this account for steps 2, 5 and 6.

---

## Step 2 — Firebase project (15 min)

1. <https://console.firebase.google.com> → **Create a project** → name `lending-library` (Firebase may add a suffix like `lending-library-2a993`; that full name is your **project ID**).
2. Turn **off** Google Analytics → create. It stays on the free **Spark** plan; never add a card.

**Database**

3. Left menu **Build → Firestore Database → Create database**.
4. Location **`europe-west3 (Frankfurt)`**, so student data stays in the EU. *This can't be changed later.*
5. **Production mode** → Create.
6. **Rules** tab → delete everything → paste all of `firestore.rules` from this folder → **Publish**.

**Sign-in**

7. **Build → Authentication → Get started → Sign-in method → Email/Password → Enable** (leave "Email link" off) → **Save**.
8. **Authentication → Templates**: optionally change the sender name to "Lending Library" so the confirmation emails are recognisable.

**Website settings**

9. Project overview → the **`</>`** (Web) icon → nickname `lending-library-web` → **Register app** (no Firebase Hosting).
10. Copy the values from the `firebaseConfig` block into `config.js`:

```js
firebase: {
  apiKey: "AIza…",
  authDomain: "lending-library-2a993.firebaseapp.com",
  projectId: "lending-library-2a993",
  storageBucket: "lending-library-2a993.firebasestorage.app",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abc123",
},
```

These aren't secret: they only say which project to talk to. The rules from step 6 decide who can read anything.

**First supervisor (you)**

11. **Firestore Database → Data → Start collection** → ID `staff`.
12. Document ID: **your university email, all lowercase**.
13. Fields: `email` (string, same email) · `name` (string) · `role` (string) `supervisor` · `active` (boolean) `true` → **Save**.

Everyone else is added from the website later (**Settings → Staff with access**).

**Co-owner access**

14. Gear icon → **Users and permissions → Add member** → the co-owner's Google account → role **Owner**.

---

## Step 3 — GitHub (15 min)

1. Make a GitHub account if needed: <https://github.com/signup>.
2. Create a free organisation: <https://github.com/organizations/plan> → **Free** → e.g. `housing-lending-library`.
3. **New repository** → `Lending-Library` → **Public** → Create. (Public is fine: the code has no passwords or student data.)
4. **Add file → Upload files** → drag in everything from this folder (with your filled-in `config.js`) → **Commit changes**.
5. Repository **Settings → Pages** → Source **Deploy from a branch** → branch `main`, folder `/ (root)` → **Save**.
6. A minute later the page shows the site address, e.g. `https://housing-lending-library.github.io/Lending-Library/`.
7. Back in Firebase: **Authentication → Settings → Authorized domains → Add domain** → `housing-lending-library.github.io` (no `https://`, no path).
8. Organisation **People → Invite member** → the co-owner (and other IT people) as **Owner**. Anyone with access can edit the code on GitHub; the live site updates a minute or two after each change.

---

## Step 4 — First sign-in (5 min)

1. Open the site → **First time? Create an account** → your university email + a new password (just for this site).
2. Open the confirmation email (check **Junk**), click the link, then press **I've confirmed it** on the site.
3. **Settings**:
   - Check the PUDO points. Krupp E–F (Basement 28) is switched off until it opens.
   - Check the lending rules (2 items, 2-day loans, 3 no-shows = 90-day suspension, €5/day).
   - **Housing mailbox**: the shared Housing address for reminders. **Housing Team**: where escalations and suspensions go (leave empty to use the Housing mailbox).
   - **Staff with access**: add every SA and supervisor with their university email. Each of them then does steps 4.1–4.2 themselves.
4. **Inventory → Add item** for each item, with its PUDO point and (when you know it) its replacement value.

---

## Step 5 — Prepare Google Cloud for the script (10 min)

The reminder script needs permission to read the database. That permission comes from the Firebase project's Google Cloud settings.

1. <https://console.cloud.google.com> (as the shared account) → choose your Firebase project at the top.
2. **APIs & Services → OAuth consent screen → Get started** (if it says it's already configured, go to step 3):
   app name `Lending Library`, support email = shared account, audience **External**, contact email = shared account → **Create**.
3. **Audience → Publish app → Confirm**, so it shows *In production*. (In *Testing*, Google stops the script every 7 days.) No verification by Google is needed.
4. **Dashboard / Home**: copy the **Project number** (digits only).

---

## Step 6 — Reminder script (15 min)

1. <https://script.google.com> (as the shared account) → **New project** → rename it `Lending Library reminders`.
2. Replace the code in `Code.gs` with all of `apps-script/Code.gs` from this folder.
3. **Project Settings** (gear icon):
   - Tick **Show "appsscript.json" manifest file in editor**.
   - **Google Cloud Platform (GCP) Project → Change project** → paste the project number → **Set project**.
   - **Script properties → Add script property**:
     - `FIREBASE_PROJECT_ID` = your project ID (e.g. `lending-library-2a993`)
     - `TEAMS_WEBHOOK_URL` = the Teams link from step 7 (add it later if you don't have it yet)
4. **Editor** → open `appsscript.json` → replace it with `apps-script/appsscript.json` → save.
5. Pick **`sendTest`** in the function menu → **Run**. Allow the permissions (if Google says the app isn't verified: **Advanced → Go to Lending Library**; it's your own script).
   The log should say "Database OK" and a test email should reach the Housing mailbox.
6. Pick **`installTriggers`** → **Run**. From now on:
   - every 5 minutes: reminders about 30 and 15 minutes before each pickup and return, plus any escalations or suspensions;
   - around 7:00: the morning summary;
   - around 2:00: old closed loans are deleted (after the months set in Settings).
7. **Share** (top right) → add the co-owner as **Editor**.

---

## Step 7 — Teams channel (optional, 5 min)

1. In Teams, open the channel where reminders should appear → **⋯ → Workflows**.
2. Choose **"Send webhook alerts to a channel"** (it may be called "Post to a channel when a webhook request is received") → name it `Lending Library` → pick the team and channel → **Add workflow**.
3. Copy the long link it shows. Add it in the script as `TEAMS_WEBHOOK_URL` (step 6.3), then run **`sendTest`** again: a test post should appear in the channel.
4. Make sure everyone has notifications on for that channel (channel **⋯ → Channel notifications → All activity**).

If Workflows isn't available in your Teams, skip this: reminders still go by email. The link works like a password for posting into that channel, so only keep it in the script properties.

---

## When you'd need university IT

Probably never. Only if:
- emails from the shared Gmail address land in quarantine (ask IT to allow that sender), or
- Teams doesn't let you create a Workflows webhook (ask IT whether it can be enabled), or
- you later want sign-in with university Microsoft accounts (needs an app registration by IT).

---

## Daily use, in one paragraph

Reserve at the TSO with **New reservation** (it checks the contract amendment, ban list, 2-item limit and the 24-hour rule). At the PUDO point press **Hand over** (campus card, condition, briefing). If the student doesn't come within 15 minutes, press **No-show**; the third one suspends them for 3 months and tells the Housing Team. On return press **Returned** and tick clean/complete/undamaged; problems and lateness are escalated automatically. For overdue items, **Log contact** each attempt; after 4, **Escalate to Housing**. Tick the small **eRezLife** chips once each step is logged there. **Logs → Copy for Excel** gives rows to paste into the Teams spreadsheets.

## Free limits

- Firebase Spark: 50,000 reads and 20,000 writes a day; up to 1,000 confirmation emails and 150 password-reset emails a day.
- Apps Script with a Gmail account: about 100 emails a day. A typical loan sends 4 reminders. If you go over, switch email reminders off in Settings and rely on Teams.

## Troubleshooting

- **"No access yet"**: that email isn't on the staff list, or was typed differently. A supervisor adds it in Settings.
- **No confirmation email**: check Junk; use "Send the email again". University filters can delay it a few minutes.
- **Sign-in fails with a domain error**: step 3.7 was skipped.
- **No reminders**: open the script → **Executions**. Usually the triggers aren't installed (run `installTriggers`) or the Housing mailbox isn't set in Settings.
- **"Cloud Firestore API has not been used in project …"**: step 6.3 (linking the project number) was skipped.
