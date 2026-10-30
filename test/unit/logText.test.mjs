import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { crlf, LogBuffer } = require('../../out-test/model/logText.js');

test('crlf: terminals need \\r\\n, colors pass through', () => {
  assert.equal(crlf('a\nb\r\nc'), 'a\r\nb\r\nc');
  assert.equal(crlf('\x1b[32m+ create\x1b[0m\n'), '\x1b[32m+ create\x1b[0m\r\n');
});

test('LogBuffer keeps the end, cut at a line start', () => {
  const b = new LogBuffer(12);
  b.push('line one\r\n');
  b.push('line two\r\n');
  assert.equal(b.text(), 'line two\r\n');
  b.push('x');
  assert.equal(b.text(), 'line two\r\nx');
  const big = new LogBuffer(5);
  big.push('0123456789');
  assert.equal(big.text(), '56789');
});

test('tailLines: last lines, plain, \\r rewrites resolved', () => {
  const { tailLines } = require('../../out-test/model/logText.js');
  assert.deepEqual(tailLines('a\r\n\r\n\x1b[1mb\x1b[0m\r\n50%\r100%\r\nc  \r\n', 3), ['b', '100%', 'c']);
  assert.deepEqual(tailLines('', 3), []);
});
