// Sender screen: C1 (file picker) + C3 (session sender).
import { useRef, useState } from 'react';
import FilePicker from './FilePicker.jsx';
import { SessionSender } from '../sessionSender.js';
import { CHUNK_SIZE, chunkCount } from '../chunker.js';
import { wsUrl } from '../wsUrl.js';
import { formatBytes, fileLabel } from '../format.js';

const SHOWN = 50; // longer lists are cut short; the overall bar shows the rest

export default function Send() {
  const [files, setFiles] = useState([]);
  const [phase, setPhase] = useState('pick'); // pick | uploading | done | error
  const [code, setCode] = useState('');
  const [progress, setProgress] = useState({});
  const [peer, setPeer] = useState(false);
  const [error, setError] = useState('');
  const sender = useRef(null);

  const addFiles = (list) => setFiles((prev) => [...prev, ...list]);
  const removeFile = (i) => setFiles((prev) => prev.filter((_, j) => j !== i));

  async function start() {
    setError('');
    setPhase('uploading');
    const s = new SessionSender(wsUrl(), {
      onProgress: (p) => setProgress((prev) => ({ ...prev, [p.fid]: p })),
      onEvent: (e) => {
        if (e.type === 'PEER_JOINED') setPeer(true);
        if (e.type === 'PEER_LEFT') setPeer(false);
      },
    });
    sender.current = s;
    try {
      await s.connect();
      const session = await s.createSession(files);
      setCode(session.code);
      await s.upload();
      setPhase('done');
    } catch (err) {
      setError(err.message);
      setPhase('error');
    }
  }

  function reset() {
    sender.current?.close();
    sender.current = null;
    setFiles([]);
    setProgress({});
    setCode('');
    setPeer(false);
    setError('');
    setPhase('pick');
  }

  const link = code ? `${location.origin}/#${code}` : '';
  const locked = phase !== 'pick';
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  const totalChunks = files.reduce((sum, f) => sum + chunkCount(f.size, CHUNK_SIZE), 0);
  const doneChunks = Object.values(progress).reduce((sum, p) => sum + p.done, 0);
  const overall = phase === 'done' ? 100 : totalChunks ? Math.round((doneChunks / totalChunks) * 100) : 0;

  return (
    <section>
      {!locked && <FilePicker onFiles={addFiles} />}

      {code && (
        <div className="code-card">
          <span className="label">Share this code with the receiver</span>
          <div className="code" id="share-code">{code}</div>
          <span className="hint">or send them this link: <a href={link}>{link}</a></span>
          <span className={`pill ${peer ? 'ok' : ''}`}>{peer ? 'Receiver connected' : 'Waiting for receiver'}</span>
        </div>
      )}

      {files.length > 0 && (
        <div className="summary">
          <div className="row">
            <strong>{files.length} file{files.length > 1 ? 's' : ''}</strong>
            <span className="meta">{formatBytes(totalBytes)}</span>
            {locked && <span className="meta">{overall}%</span>}
            {!locked && <button className="link" onClick={() => setFiles([])}>clear</button>}
          </div>
          {locked && <div className="bar"><div style={{ width: `${overall}%` }} /></div>}
        </div>
      )}

      {files.length > 0 && (
        <ul className="files">
          {files.slice(0, SHOWN).map((file, i) => {
            const p = progress[`f${i}`];
            const finished = phase === 'done' || (p && p.total > 0 && p.done === p.total);
            const pct = finished ? 100 : p && p.total ? Math.round((p.done / p.total) * 100) : 0;
            return (
              <li key={`${fileLabel(file)}-${i}`}>
                <div className="row">
                  <span className="name" title={fileLabel(file)}>{fileLabel(file)}</span>
                  <span className="meta">{formatBytes(file.size)}</span>
                  {!locked && <button className="link" onClick={() => removeFile(i)}>remove</button>}
                </div>
                {locked && <div className="bar"><div style={{ width: `${pct}%` }} /></div>}
              </li>
            );
          })}
          {files.length > SHOWN && <li className="more">…and {files.length - SHOWN} more</li>}
        </ul>
      )}

      {phase === 'pick' && files.length > 0 && (
        <button className="primary" onClick={start}>Send {files.length} file{files.length > 1 ? 's' : ''}</button>
      )}
      {phase === 'uploading' && <p className="status">Uploading… keep this page open.</p>}
      {phase === 'done' && <p className="status ok" id="send-done">All files uploaded and verified. The receiver can download them now.</p>}
      {phase === 'error' && <p className="status err">{error}</p>}
      {(phase === 'done' || phase === 'error') && <button onClick={reset}>Send more files</button>}
    </section>
  );
}
