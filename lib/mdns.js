'use strict';
// Answers "voteattawhid.local" on the local network (multicast DNS), so devices can
// open the app by name instead of an IP address, without internet or a DNS server.
const dgram = require('dgram');
const os = require('os');

const HOST = 'voteattawhid.local';
const GROUP = '224.0.0.251';
const PORT = 5353;
const TYPE_A = 1;
const TYPE_ANY = 255;
const CLASS_IN = 1;

function encodeName(name) {
  const parts = name.split('.').flatMap((label) => [Buffer.from([label.length]), Buffer.from(label)]);
  return Buffer.concat([...parts, Buffer.from([0])]);
}

// Reads a DNS name, which may be compressed. Returns null if the packet is malformed.
function readName(buf, start) {
  const labels = [];
  let pos = start;
  let next = -1;
  let jumps = 0;
  for (;;) {
    if (pos >= buf.length) return null;
    const len = buf[pos];
    if (len === 0) { pos++; break; }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length || ++jumps > 10) return null;
      if (next < 0) next = pos + 2;
      pos = ((len & 0x3f) << 8) | buf[pos + 1];
    } else {
      if (len > 63 || pos + 1 + len > buf.length) return null;
      labels.push(buf.toString('latin1', pos + 1, pos + 1 + len));
      pos += 1 + len;
    }
  }
  return { name: labels.join('.').toLowerCase(), next: next < 0 ? pos : next };
}

// True when this packet is a query asking for the address of this app's name.
function asksForHost(msg) {
  if (msg.length < 12 || msg.readUInt16BE(2) & 0x8000) return false; // answers are ignored
  let pos = 12;
  for (let i = msg.readUInt16BE(4); i > 0; i--) {
    const q = readName(msg, pos);
    if (!q || q.next + 4 > msg.length) return false;
    const type = msg.readUInt16BE(q.next);
    const cls = msg.readUInt16BE(q.next + 2) & 0x7fff;
    if (q.name === HOST && cls === CLASS_IN && (type === TYPE_A || type === TYPE_ANY)) return true;
    pos = q.next + 4;
  }
  return false;
}

// direct: the reply goes straight to a client that did not use the mDNS port.
function buildAnswer(ip, id = 0, direct = false) {
  const name = encodeName(HOST);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(direct ? id : 0, 0);
  header.writeUInt16BE(0x8400, 2); // response, authoritative
  header.writeUInt16BE(direct ? 1 : 0, 4);
  header.writeUInt16BE(1, 6);
  const question = Buffer.from([0, TYPE_A, 0, CLASS_IN]);
  const record = Buffer.alloc(10);
  record.writeUInt16BE(TYPE_A, 0);
  record.writeUInt16BE(direct ? CLASS_IN : 0x8001, 2); // 0x8001: replaces cached answers
  record.writeUInt32BE(direct ? 10 : 120, 4);
  record.writeUInt16BE(4, 8);
  return Buffer.concat([header, ...(direct ? [name, question] : []), name, record, Buffer.from(ip.split('.').map(Number))]);
}

const toInt = (ip) => ip.split('.').reduce((n, part) => (n * 256 + Number(part)) >>> 0, 0);
const sameNetwork = (a, b, mask) => ((toInt(a) & toInt(mask)) >>> 0) === ((toInt(b) & toInt(mask)) >>> 0);

function localAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/^(docker|br-|veth|virbr)/.test(name)) continue;
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a);
  }
  return out;
}

// A problem here must never stop the vote counting: the IP address keeps working.
function start(onError = () => {}) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const joined = new Set();

  // Run again regularly, because the laptop can join the Wi-Fi after the app started.
  const join = () => {
    const now = localAddresses().map((a) => a.address);
    for (const ip of [...joined]) if (!now.includes(ip)) joined.delete(ip);
    for (const ip of now) {
      if (joined.has(ip)) continue;
      try { socket.addMembership(GROUP, ip); joined.add(ip); } catch { joined.add(ip); }
    }
  };

  socket.on('error', onError);
  socket.on('message', (msg, from) => {
    try {
      if (!asksForHost(msg)) return;
      const local = localAddresses().find((a) => sameNetwork(a.address, from.address, a.netmask));
      if (!local) return;
      if (from.port === PORT) {
        socket.setMulticastInterface(local.address);
        socket.send(buildAnswer(local.address), PORT, GROUP);
      } else {
        socket.send(buildAnswer(local.address, msg.readUInt16BE(0), true), from.port, from.address);
      }
    } catch (e) { onError(e); }
  });
  socket.bind(PORT, () => {
    try { socket.setMulticastTTL(255); join(); } catch (e) { onError(e); }
    setInterval(join, 10000).unref();
  });
  return socket;
}

module.exports = { HOST, start, asksForHost, buildAnswer, encodeName };
