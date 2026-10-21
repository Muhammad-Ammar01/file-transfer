# File Transfer – System Design (v1: send + receive only)

Security is out of scope until transfer works end to end.

## Model
Store-and-forward relay. Sender and receiver each open one **WebSocket session** (a single TCP connection) to the server. The server stores chunks and streams them to the receiver, so the receiver doesn't need to be online while the sender uploads.

Browsers can't open raw TCP sockets, so WebSocket is the TCP session. A desktop client could use plain TCP with the same messages.

```
 SENDER (browser)                 SERVER (Node)                    RECEIVER (browser)
┌─────────────────┐       ┌───────────────────────────┐       ┌──────────────────┐
│ C1 File Picker  │       │ C4 WS Gateway             │       │ C12 Receive Page │
│ C2 Chunker      │◀─WS──▶│ C5 Session Manager        │◀─WS──▶│ C13 Session Recv │
│ C3 Session Send │       │ C6 Frame Receiver         │       │ C14 Verifier     │
└─────────────────┘       │ C7 Assembler + Verifier   │       └──────────────────┘
                          │ C8 Metadata DB            │
                          │ C9 File Storage           │
                          │ C11 Cleanup Job           │
                          └───────────────────────────┘
```

## Components
| ID | Name | Side | Job |
|---|---|---|---|
| C1 | File Picker / Drop Zone | Sender | Select files; read name, size, type |
| C2 | Chunker | Sender | Split into 5 MB chunks; SHA-256 per chunk, manifest hash per file (JS fallback when `crypto.subtle` is unavailable on plain http) |
| C3 | Session Sender | Sender | Open WS session, send `CHUNK` frames, handle `ACK`/`NACK`, auto-reconnect with `RESUME`, progress |
| C4 | WS Gateway | Server | Accepts WS connections, routes messages by type |
| C5 | Session Manager | Server | Creates `sessionId` + share code, pairs sender and receiver, pushes `PROGRESS`/`READY`, tracks liveness |
| C6 | Frame Receiver | Server | Reads `CHUNK` frames, checks chunk hash, writes to storage, replies `ACK`/`NACK` |
| C7 | Assembler + Verifier | Server | Joins chunks, checks full-file hash, marks file `READY` |
| C8 | Metadata DB | Server | Sessions, files, chunk status, expiry (SQLite first) |
| C9 | File Storage | Server | Chunk and file bytes (local disk first, S3 later) |
| C11 | Cleanup Job | Server | Every 10 min, deletes sessions older than 24 h (rows, files on disk, memory) |
| C12 | Receive Page | Receiver | Enter code or open the share link, see file list, live progress, download buttons |
| C13 | Session Receiver | Receiver | Join session by code, receive streamed chunks, auto-resume from the next chunk |
| C14 | Verifier | Receiver | Check every chunk hash, total size and manifest hash; only then finish the save |

(C10, the old Notifier, is merged into C5.)

## Protocol (over the WS session)
| Message | From → To | Meaning |
|---|---|---|
| `HELLO {files:[{fid,name,size,type,chunkSize,chunks}]}` | Sender → Server | Start a transfer (`chunks` must equal `ceil(size/chunkSize)`) |
| `SESSION {sessionId, code}` | Server → Sender | Session created |
| `JOIN {code}` | Receiver → Server | Receiver joins |
| `JOINED {sessionId, files}` | Server → Receiver | Join accepted; each file has a `status` (`PENDING`/`ASSEMBLING`/`READY`/`FAILED`) so late joiners see what's already done |
| `PEER_JOINED` / `PEER_LEFT {role}` | Server → Either | The other side connected / disconnected |
| `CHUNK` (binary: `[u32 header len][JSON {fid,n,hash}][bytes]`) | Sender → Server | One chunk |
| `ACK {fid, n}` / `NACK {fid, n, reason}` | Server → Sender | Chunk stored, or bad hash so resend |
| `PROGRESS {fid, done, total}` | Server → Receiver | Live upload progress (chunks stored so far) |
| `DONE {fid, sha256}` | Sender → Server | All chunks sent; `sha256` is the manifest hash |
| `READY {fid}` | Server → Sender | File assembled and verified |
| `READY {fid,name,size,mime}` | Server → Receiver | Same event, with file info |
| `GET {fid, from}` | Receiver → Server | Stream a READY file starting at chunk `from` |
| `CHUNK` (binary, same layout) | Server → Receiver | Chunk stream, one frame per chunk, sent with backpressure |
| `END {fid, sha256, chunks, size}` | Server → Receiver | Stream finished; receiver checks the manifest hash |
| `RESUME {sessionId}` | Sender → Server | Reconnect after a drop |
| `RESUMED {sessionId, code, files:[{fid,status,missing:[n]}]}` | Server → Sender | Which chunks the server still needs |
| `ERROR {code, msg}` | Server → Either | Failure |

Receiver resume needs no special message: reconnect, `JOIN` again, `GET {fid, from: <next chunk>}`.

## Flow
1. C1 → C2: pick files, chunk and hash.
2. C3 → C4/C5: `HELLO`, get `SESSION` with code.
3. C3 → C6: send chunks, wait for `ACK` (sliding window of ~4 in flight); C8 marks `RECEIVED`.
4. `DONE` → C7 assembles, verifies, `VERIFIED`, then C5 sends `READY` to receiver.
5. C12 enters code → `JOIN` → C13 sends `GET` → chunks stream → C14 verifies and saves.

## Integrity checkpoints
Whole-file SHA-256 needs an incremental hash, which browsers don't provide, so the file-level hash is a **manifest hash**: SHA-256 over the concatenated hex chunk hashes. It is sent in `DONE`, so the file is read once.

1. Chunk hash: C6 verifies each chunk.
2. File hash: C7 recomputes the manifest hash from stored chunks after assembly.
3. End to end: C14 verifies on the receiver.
4. Chunk states in C8: `PENDING → RECEIVED → VERIFIED`. File status: `PENDING → ASSEMBLING → READY | FAILED`.

C7 re-reads every stored chunk and re-hashes it before joining, so corruption on disk is caught too. Assembly writes `file.tmp` and renames it to `file` only after all checks pass; `.part` files are then deleted. Assembly errors: `MISSING_CHUNKS` (retryable), `CHUNK_CORRUPT`, `SIZE_MISMATCH`, `MANIFEST_MISMATCH` (the last three mark the file `FAILED`).

## Stack
React (Vite) frontend, Node.js 24 + `ws` server, SQLite (built-in `node:sqlite`), local disk storage.

## Layout
```
D:\File transfer
├─ server/   C4 index.js · C5 sessions.js · C6 (handleChunk in index.js) · C7 assembler.js
│            C8 db.js · C9 storage.js · C11 cleanup.js · static.js (serves client/dist)
├─ client/   C1 FilePicker · C2 chunker.js · C3 sessionSender.js
│            C12 ReceivePage · C13 sessionReceiver.js · C14 verifier.js
└─ package.json   setup / build / start / test
```
One port serves both the UI and the WebSocket.

## Build order (all done)
1. ✅ C4 + C5: session pairing.
2. ✅ C2 + C3 + C6 + C9: chunked upload with `ACK`/`NACK`.
3. ✅ C7 + C8: assemble, verify, track state.
4. ✅ C12–C14: receiver streams and verifies; live progress; UI.
5. ✅ `RESUME` (sender, receiver, server restart) and C11 cleanup.

## Folders and "Download all"
- C1 picks files, a folder (`webkitdirectory`), or dropped folders (walked with `webkitGetAsEntry`). The file's `name` in `HELLO` is its relative path, e.g. `Holiday/Day 1/IMG_0001.jpg` (up to 1024 chars, up to 10,000 files).
- C12 "Download all" streams every READY file through C13/C14 into one ZIP (`client/src/zipAll.js`, `fflate`, stored without compression). Paths are cleaned (`..` and leading `/` removed) so unzipping can't escape the folder. Plain ZIP, so 4 GB total max.

## Known limits
- "Choose folder" is not available in most mobile browsers.
- Without `showSaveFilePicker` (Firefox, Safari, or plain `http://` pages) a download is held in memory before saving, so multi-GB files can exhaust RAM.
- Anyone with the 6-digit code can receive the files (security phase).
- Chunks are sent over one connection with a window of 4, not in parallel.

## Revisit later
- Parallel connections for speed, since one TCP session is sequential.
- WebRTC peer-to-peer mode to skip the relay.
- Security phase: auth, TLS, encryption, expiring codes, scanning.
