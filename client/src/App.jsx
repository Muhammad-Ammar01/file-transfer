import { useEffect, useState } from 'react';
import Send from './components/Send.jsx';
import ReceivePage from './components/ReceivePage.jsx';

// A link like http://host:8080/#123456 opens the Receive tab and joins that code.
const codeFromHash = () => (location.hash.match(/^#(\d{6})$/) ?? [])[1] ?? '';

export default function App() {
  const [linkCode, setLinkCode] = useState(codeFromHash);
  const [tab, setTab] = useState(linkCode ? 'receive' : 'send');

  // Opening a share link in a tab that is already loaded only changes the hash, not the page.
  useEffect(() => {
    const onHash = () => {
      const code = codeFromHash();
      if (!code) return;
      setLinkCode(code);
      setTab('receive');
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return (
    <main>
      <h1>File Transfer</h1>
      <nav>
        <button className={tab === 'send' ? 'active' : ''} onClick={() => setTab('send')}>Send</button>
        <button className={tab === 'receive' ? 'active' : ''} onClick={() => setTab('receive')}>Receive</button>
      </nav>
      {/* Both stay mounted so switching tabs does not drop an upload or download in progress. */}
      <div hidden={tab !== 'send'}><Send /></div>
      <div hidden={tab !== 'receive'}><ReceivePage key={linkCode} initialCode={linkCode} /></div>
    </main>
  );
}
