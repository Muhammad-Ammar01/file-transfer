// C5 Session Manager: creates sessions, pairs sender and receiver, relays events.
// Sessions stay in memory (restored from the DB on startup) until C11 expires them, so a
// receiver can join after the sender has left, and a sender can resume after a dropped connection.
import { randomUUID, randomInt } from 'node:crypto';

const sessions = new Map(); // sessionId -> session
const byCode = new Map(); // share code -> session

function newCode() {
  let code;
  do {
    code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  } while (byCode.has(code));
  return code;
}

function add(session) {
  sessions.set(session.sessionId, session);
  byCode.set(session.code, session);
  return session;
}

export function send(ws, type, data = {}) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ...data }));
}

export function createSession(senderWs) {
  return add({ sessionId: randomUUID(), code: newCode(), sender: senderWs, receiver: null, createdAt: Date.now() });
}

// Rebuilds a session from the DB after a restart; nobody is connected yet.
export function restoreSession({ sessionId, code, createdAt }) {
  return add({ sessionId, code, sender: null, receiver: null, createdAt });
}

export function joinSession(code, receiverWs) {
  const session = byCode.get(code);
  if (!session) return null;
  session.receiver = receiverWs;
  return session;
}

// Rebinds the sender socket after a reconnect.
export function resumeSession(sessionId, senderWs) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (session.sender && session.sender !== senderWs) session.sender.terminate();
  session.sender = senderWs;
  return session;
}

function findBy(role, ws) {
  for (const session of sessions.values()) if (session[role] === ws) return session;
  return null;
}
export const findBySender = (ws) => findBy('sender', ws);
export const findByReceiver = (ws) => findBy('receiver', ws);

export function removeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  byCode.delete(session.code);
}

// Called when a socket closes; tells the other side. The session itself stays for resume.
export function handleDisconnect(ws) {
  for (const session of sessions.values()) {
    if (session.sender === ws) {
      session.sender = null;
      send(session.receiver, 'PEER_LEFT', { role: 'sender' });
    } else if (session.receiver === ws) {
      session.receiver = null;
      send(session.sender, 'PEER_LEFT', { role: 'receiver' });
    }
  }
}

export function sessionCount() {
  return sessions.size;
}
