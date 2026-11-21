'use strict';
// Tests for the local name (lib/mdns.js). IDs match docs/TEST_PLAN.md.
const test = require('node:test');
const assert = require('node:assert');
const { HOST, asksForHost, buildAnswer, encodeName } = require('../lib/mdns');

function query(name, type = 1, cls = 1, flags = 0) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x1234, 0);
  header.writeUInt16BE(flags, 2);
  header.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(cls, 2);
  return Buffer.concat([header, encodeName(name), tail]);
}

test('D01 answers a question for the app name, in any letter case', () => {
  assert.equal(asksForHost(query(HOST)), true);
  assert.equal(asksForHost(query('VoteAttawhid.LOCAL')), true);
  assert.equal(asksForHost(query(HOST, 255)), true, 'any type');
  assert.equal(asksForHost(query(HOST, 1, 0x8001)), true, 'asks for a direct reply');
});

test('D02 ignores other names, other record types and answers', () => {
  assert.equal(asksForHost(query('printer.local')), false);
  assert.equal(asksForHost(query(HOST, 28)), false, 'IPv6 question');
  assert.equal(asksForHost(query(HOST, 1, 1, 0x8400)), false, 'an answer, not a question');
});

test('D03 malformed packets are ignored without an error', () => {
  const loop = Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]), Buffer.from([0xc0, 12, 0, 1, 0, 1])]);
  const cut = query(HOST).subarray(0, 20);
  for (const packet of [Buffer.alloc(0), Buffer.alloc(5), loop, cut, Buffer.alloc(64, 0xff)]) {
    assert.equal(asksForHost(packet), false);
  }
});

test('D04 the answer carries the address, and a direct reply repeats the question', () => {
  const name = encodeName(HOST);
  const multicast = buildAnswer('192.168.1.8');
  assert.deepEqual([multicast.readUInt16BE(0), multicast.readUInt16BE(2), multicast.readUInt16BE(4), multicast.readUInt16BE(6)], [0, 0x8400, 0, 1]);
  assert.deepEqual([...multicast.subarray(-4)], [192, 168, 1, 8]);
  assert.equal(multicast.indexOf(name), 12);
  const direct = buildAnswer('10.0.0.5', 0x1234, true);
  assert.deepEqual([direct.readUInt16BE(0), direct.readUInt16BE(4), direct.readUInt16BE(6)], [0x1234, 1, 1]);
  assert.deepEqual([...direct.subarray(-4)], [10, 0, 0, 5]);
  assert.equal(direct.indexOf(name, 12 + name.length), 12 + name.length + 4);
});
