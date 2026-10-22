# Lending Desk

Staff tool for the Housing lending library: inventory, loans, borrowers with no-show strikes and bans,
reminders 30 and 15 minutes before each pickup and return, and logs that mirror the Teams spreadsheets.

- `index.html`, `app.js`, `styles.css`: the website (plain HTML/JS, no build step)
- `config.js`: Firebase settings (empty = demo mode with sample data)
- `firestore.rules`: who may read and write what
- `apps-script/`: the Google Apps Script that sends reminders (email + Teams), escalations and the morning summary
- `SETUP.md`: step-by-step setup

To change the site, edit the files on GitHub; GitHub Pages republishes within a minute or two.
