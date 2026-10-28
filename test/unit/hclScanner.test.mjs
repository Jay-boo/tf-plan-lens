import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scanBlocks } = require('../../out-test/model/hclScanner.js');
const tricky = readFileSync(new URL('../fixtures/tf/tricky.tf', import.meta.url), 'utf8');
const brief = (bs) => bs.map((b) => [b.kind, b.type ?? null, b.name, b.startLine, b.endLine]);

test('finds three kinds', () => {
  const src = 'resource "a" "b" {\n  x = 1\n}\n\ndata "c" "d" {\n}\nmodule "m" {\n  source = "./m"\n}\n';
  assert.deepEqual(brief(scanBlocks(src)), [
    ['resource', 'a', 'b', 0, 2],
    ['data', 'c', 'd', 4, 5],
    ['module', null, 'm', 6, 8],
  ]);
  assert.equal(scanBlocks(src)[0].headerEnd, 18);
});

test('tricky.tf', () => {
  assert.deepEqual(brief(scanBlocks(tricky)), [
    ['resource', 'azurerm_storage_account', 'this', 4, 13],
    ['data', 'azurerm_client_config', 'current', 26, 26],
    ['module', null, 'lakebase', 28, 32],
  ]);
});

test('CRLF', () => {
  assert.deepEqual(brief(scanBlocks(tricky.replace(/\n/g, '\r\n'))), brief(scanBlocks(tricky)));
});

test('unterminated block', () => {
  assert.deepEqual(brief(scanBlocks('resource "a" "b" {\n  x = {\n')), [['resource', 'a', 'b', 0, 2]]);
});

test('indented header inside another block is ignored', () => {
  const src = 'locals {\n  resource "a" "b" {\n  }\n}\n  resource "c" "d" {\n  }\n';
  assert.deepEqual(brief(scanBlocks(src)), [['resource', 'c', 'd', 4, 5]]);
});

test('indented closing marker of a plain heredoc', () => {
  const src = 'resource "x" "a" {\n  v = <<EOT\n  }\n  EOT\n}\nresource "y" "b" {}\n';
  assert.deepEqual(brief(scanBlocks(src)), [['resource', 'x', 'a', 0, 4], ['resource', 'y', 'b', 5, 5]]);
});

test('heredoc marker inside a comment is ignored', () => {
  const src = '# usage: <<EOF\nresource "x" "a" {\n  v = 1 // see <<EOT\n}\nresource "y" "b" {}\n';
  assert.deepEqual(brief(scanBlocks(src)), [['resource', 'x', 'a', 1, 3], ['resource', 'y', 'b', 4, 4]]);
});
