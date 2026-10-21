// C12 Receive Page: enter the code, see the files, download one or all (C13 + C14 do the work).
import { useEffect, useRef, useState } from 'react';
import { SessionReceiver } from '../sessionReceiver.js';
import { createSink, saveBlob } from '../sinks.js';
import { ZipWriter, MAX_ZIP_BYTES } from '../zipAll.js';
import { wsUrl } from '../wsUrl.js';
import { formatBytes, baseName } from '../format.js';

const SHOWN = 50;

// "Trip.zip" when everything came from one folder, otherwise "files-123456.zip".
function zipNameFor(files, code) {
  const tops = new Set(files.map((f) => (f.name.includes('/') ? f.name.split('/')[0] : '')));
  const [top] = tops;
  return tops.size === 1 && top ? `${top}.zip` : `files-${code}.zip`;
}

export default function ReceivePage({ initialCode = '' }) {
  const [code, setCode] = useState(initialCode);
  const [files, setFiles] = useState(null); // null until joined
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(null); // "Download all" state
  const [showAll, setShowAll] = useState(false);
  const receiver = useRef(null);

  const update = (fid, patch) =>
    setFiles((prev) => prev && prev.map((f) => (f.fid === fid ? { ...f, ...patch } : f)));

  async function join(codeToJoin = code) {
    setError('');
    setBusy(true);
    receiver.current?.close();
    const r = new SessionReceiver(wsUrl(), {
      onEvent: (e) => {
        if (e.type === 'PROGRESS') update(e.fid, { uploaded: e.done });
        if (e.type === 'READY') update(e.fid, { status: 'READY', name: e.name, size: e.size, type: e.mime });
      },
    });
    receiver.current = r;
    try {
      await r.connect();
      const joined = await r.join(codeToJoin.trim());
      setFiles(joined.files.map((f) => ({ ...f, uploaded: f.status === 'READY' ? f.chunks : 0 })));
    } catch (err) {
      setError(err.message.replace(/^NO_SUCH_CODE: /, 'No transfer with that code. '));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (/^\d{6}$/.test(initialCode)) join(initialCode);
    return () => receiver.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Asks where to save (when the browser can), or falls back to memory. Null if the user cancelled.
  async function openSink(name) {
    try {
      return await createSink(name); // must run straight from the click
    } catch (err) {
      if (err.name === 'AbortError') return null;
      throw err;
    }
  }

  async function download(file) {
    const name = baseName(file.name);
    let sink;
    try {
      sink = await openSink(name);
      if (!sink) return;
      update(file.fid, { dl: { state: 'downloading', done: 0, total: file.chunks } });
      await receiver.current.download(file, sink, {
        onProgress: (p) => update(file.fid, { dl: { state: 'downloading', done: p.done, total: p.total } }),
      });
      if (sink.kind === 'memory') saveBlob(sink.blob(file.type || undefined), name);
      update(file.fid, { dl: { state: 'done' } });
    } catch (err) {
      update(file.fid, { dl: { state: 'error', msg: err.message } });
    }
  }

  async function downloadAll() {
    const ready = files.filter((f) => f.status === 'READY');
    const bytes = ready.reduce((sum, f) => sum + f.size, 0);
    if (bytes > MAX_ZIP_BYTES) {
      setAll({ state: 'error', msg: 'More than 4 GB in total is too big for one ZIP. Download the files one by one.' });
      return;
    }
    const zipName = zipNameFor(ready, code);
    try {
      const sink = await openSink(zipName);
      if (!sink) return;
      const zip = new ZipWriter(sink);
      setAll({ state: 'downloading', done: 0, total: ready.length });
      for (const [i, file] of ready.entries()) {
        update(file.fid, { dl: { state: 'downloading', done: 0, total: file.chunks } });
        await receiver.current.download(file, zip.entry(file.name), {
          onProgress: (p) => update(file.fid, { dl: { state: 'downloading', done: p.done, total: p.total } }),
        });
        update(file.fid, { dl: { state: 'done', zip: true } });
        setAll({ state: 'downloading', done: i + 1, total: ready.length });
      }
      await zip.finish();
      if (sink.kind === 'memory') saveBlob(sink.blob('application/zip'), zipName);
      setAll({ state: 'done', name: zipName, count: ready.length });
    } catch (err) {
      setAll({ state: 'error', msg: err.message });
    }
  }

  if (!files) {
    return (
      <section>
        <form className="join" onSubmit={(e) => { e.preventDefault(); join(); }}>
          <input
            id="code-input"
            inputMode="numeric"
            maxLength={6}
            placeholder="6-digit code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
          <button className="primary" disabled={busy || code.length !== 6}>{busy ? 'Joining…' : 'Receive'}</button>
        </form>
        {error && <p className="status err">{error}</p>}
      </section>
    );
  }

  const readyCount = files.filter((f) => f.status === 'READY').length;
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  const allBusy = all?.state === 'downloading';
  const visible = showAll ? files : files.slice(0, SHOWN);

  return (
    <section>
      <div className="summary">
        <div className="row">
          <strong>{files.length} file{files.length > 1 ? 's' : ''}</strong>
          <span className="meta">{formatBytes(totalBytes)}</span>
          <span className="meta">{readyCount} of {files.length} ready</span>
        </div>
        {files.length > 1 && (
          <button className="primary all" id="download-all" disabled={readyCount === 0 || allBusy} onClick={downloadAll}>
            {allBusy
              ? `Downloading ${all.done} of ${all.total}…`
              : `Download all${readyCount < files.length ? ` ${readyCount} ready` : ''} as ZIP`}
          </button>
        )}
        {allBusy && <div className="bar"><div style={{ width: `${Math.round((all.done / all.total) * 100)}%` }} /></div>}
        {all?.state === 'done' && (
          <p className="status ok" id="all-done">Saved {all.count} files in {all.name}, every file verified ✓</p>
        )}
        {all?.state === 'error' && <p className="status err">{all.msg}</p>}
      </div>

      <ul className="files">
        {visible.map((f) => {
          const waiting = f.status !== 'READY';
          const pct = f.dl?.total ? Math.round((f.dl.done / f.dl.total) * 100)
            : f.chunks ? Math.round((f.uploaded / f.chunks) * 100) : 0;
          return (
            <li key={f.fid}>
              <div className="row">
                <span className="name" title={f.name}>{f.name}</span>
                <span className="meta">{formatBytes(f.size)}</span>
                {f.status === 'FAILED' && <span className="pill err">failed</span>}
                {waiting && f.status !== 'FAILED' && <span className="pill">sender uploading…</span>}
                {!waiting && f.dl?.state !== 'done' && (
                  <button
                    className="primary small"
                    disabled={f.dl?.state === 'downloading' || allBusy}
                    onClick={() => download(f)}
                  >
                    {f.dl?.state === 'downloading' ? 'Downloading…' : 'Download'}
                  </button>
                )}
                {f.dl?.state === 'done' && (
                  <span className="pill ok" data-testid="verified">{f.dl.zip ? 'In ZIP, verified ✓' : 'Saved & verified ✓'}</span>
                )}
              </div>
              {(waiting || f.dl?.state === 'downloading') && f.status !== 'FAILED' && (
                <div className="bar"><div style={{ width: `${pct}%` }} /></div>
              )}
              {f.dl?.state === 'error' && <p className="status err">{f.dl.msg}</p>}
            </li>
          );
        })}
        {!showAll && files.length > SHOWN && (
          <li className="more">
            …and {files.length - SHOWN} more <button className="link" onClick={() => setShowAll(true)}>show all</button>
          </li>
        )}
      </ul>
    </section>
  );
}
