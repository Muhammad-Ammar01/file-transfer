// C1 File Picker / Drop Zone: pick files, pick a whole folder, or drag either onto the page.
import { useRef, useState } from 'react';

// Junk files operating systems put in folders.
const IGNORED = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const keep = (file) => !IGNORED.has(file.name);

// Reads dropped items, walking into folders. Each file gets `relativePath`, e.g. "Trip/Day 1/a.jpg".
// The entries must be taken from the event synchronously, before the first await.
async function filesFromDrop(dataTransfer) {
  const entries = [...dataTransfer.items].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length === 0) return [...dataTransfer.files];

  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      file.relativePath = prefix + file.name;
      out.push(file);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      // readEntries returns folders in batches (about 100 at a time) until it returns none.
      for (;;) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (batch.length === 0) break;
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      }
    }
  };
  for (const entry of entries) await walk(entry, '');
  return out;
}

export default function FilePicker({ onFiles, disabled }) {
  const filesInput = useRef(null);
  const folderInput = useRef(null);
  const [over, setOver] = useState(false);
  const [reading, setReading] = useState(false);

  const pick = (list) => {
    const files = Array.from(list ?? []).filter(keep);
    if (files.length) onFiles(files);
  };

  const onInput = (e) => {
    pick(e.target.files);
    e.target.value = ''; // allow picking the same files again
  };

  return (
    <div
      className={`dropzone${over ? ' over' : ''}${disabled ? ' disabled' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (disabled) return;
        setReading(true);
        filesFromDrop(e.dataTransfer)
          .then(pick)
          .finally(() => setReading(false));
      }}
    >
      <input ref={filesInput} id="file-input" type="file" multiple hidden onChange={onInput} />
      <input ref={folderInput} id="folder-input" type="file" webkitdirectory="" multiple hidden onChange={onInput} />
      <strong>{reading ? 'Reading folder…' : 'Drop files or folders here'}</strong>
      <div className="pick-buttons">
        <button type="button" disabled={disabled} onClick={() => filesInput.current.click()}>Choose files</button>
        <button type="button" disabled={disabled} onClick={() => folderInput.current.click()}>Choose folder</button>
      </div>
      <span>Photos, videos, documents. A folder keeps its subfolders.</span>
    </div>
  );
}
