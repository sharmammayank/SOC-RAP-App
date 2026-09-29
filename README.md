# SOC-RAP: SLA & Service Review Reporting (local app)

Runs on your own computer. Your data never leaves it: files are read in the browser, and nothing is sent to any server, including the local one.

## Start it

**Mac:** double-click `start.command`. A Terminal window opens and your browser goes to **http://localhost:8731**.
- If macOS says it can't verify the file, right-click `start.command` → **Open** → **Open**. You only need to do this once.
- You can also open Terminal in this folder and run `python3 server.py`.

**Windows:** double-click `start.bat`, then open **http://localhost:8731**.

Keep the Terminal window open while you use the app. To stop it, press **Ctrl+C** in that window or close it.

Python 3 is required. It comes with most Macs that have the developer tools. If it's missing, the start script tells you how to get it.

## Using it

1. Pick **+ New client** at the top right, or upload a file and name the client when asked.
2. On the **Data** tab, upload the month's case export (`.xlsx` or `.csv`). Upload the next month later and it is added and compared automatically.
3. Review any flagged items, then use **Download Excel** or **Download PowerPoint**.

Each client's months, settings, rules and review fixes are saved in this browser, for the address `http://localhost:8731`. If you use a different browser or a different port, you'll see an empty app. To move or remove data, use the client panel on the Data tab.

## What's in this folder

| File | Purpose |
|---|---|
| `index.html`, `app.js` | The application |
| `vendor/pptxgen.bundle.js` | PowerPoint library (PptxGenJS 4.0.1, MIT licence), checked by an integrity hash before it runs |
| `server.py` | Local web server: this computer only, app files only, strict security headers |
| `start.command` / `start.bat` | One-click start for Mac / Windows |
| `SECURITY_REVIEW.md` | Security review notes and test results |

To use a different port, set `SOC_RAP_PORT` before starting, for example `SOC_RAP_PORT=9000 python3 server.py`. Data saved under one port isn't visible under another.
