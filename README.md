# File Transfer

Send photos, videos and documents from one device to another through a small relay server.
The sender gets a 6-digit code (and a link); the receiver opens the link or types the code and downloads.
Every chunk and the whole file are hash-checked on the way up and on the way down.

Security (login, encryption, expiring links) is not built yet. Anyone who has the code can download the files, so only run this on a network you trust.

## Features

- Send files **or whole folders** (subfolders kept), up to 10,000 files at once
- 6-digit code or share link to receive; the receiver can join before, during or after the upload
- **Download all as ZIP** on the receiver side
- Every 5 MB chunk and every whole file is **SHA-256 checked** on upload and again on download
- **Resumes** after a dropped connection; files survive a server restart
- Works across devices on the same Wi-Fi; files are deleted after 24 hours

## Run it

Needs [Node.js](https://nodejs.org) 24 or newer.
On Windows PowerShell, if `npm` is blocked, type `npm.cmd` instead.

```bash
npm run setup     # installs dependencies and builds the web page (first time only)
npm start         # starts the app
```

Open the address it prints:

- `http://localhost:8080` on the same computer
- the `http://192.168.x.x:8080` address on any other device on the same network

**To send:** open the page, click *Choose files* or *Choose folder* (or drag files or folders in), click *Send*, give the code or link to the receiver.
**To receive:** open the link, or choose *Receive* and type the code. Click *Download all as ZIP*, or *Download* on single files.

- Up to 10,000 files per send. A picked folder keeps its subfolders, and so does the ZIP.
- The receiver can join before, during or after the upload. Files are kept for 24 hours.
- *Download all* is limited to 4 GB in total; bigger sets have to be downloaded file by file.
- *Choose folder* works in desktop browsers. Most phones only allow picking files, so on a phone use *Choose files* and select all.

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Port to listen on |
| `STORAGE_DIR` | `server/storage` | Where files and the database are kept |

## Tests

```bash
npm test          # 24 tests: pairing, upload, verification, download, resume, restart, cleanup, folders + ZIP
```

## How it works

See [DESIGN.md](DESIGN.md) for the components, the message protocol and the integrity checks.
