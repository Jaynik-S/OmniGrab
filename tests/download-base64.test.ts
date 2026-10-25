import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidBase64 } from '../src/downloads/base64.ts';

test('base64 accepts literal padded and unpadded payloads, including unused pad bits', () => {
  for (const [data, bytes] of [['AA==', 1], ['/x==', 1], ['AAA=', 2], ['//9=', 2], ['AP+A', 3], ['+/09', 3]] as const) {
    assert.equal(isValidBase64(data, bytes), true, data);
  }
});

test('base64 rejects wrong declared sizes, whitespace, Unicode and misplaced padding', () => {
  for (const [data, bytes] of [['', 1], ['AA==', 2], ['AAA=', 1], ['AP+A', 1], ['AP+A', 2], ['AAAA', 4],
    ['A===', 1], ['=AAA', 3], ['AA=A', 3], ['AA==', 3], ['AP A', 3], ['AP\nA', 3], ['AP-A', 3],
    ['AP_A', 3], ['APéA', 3], ['APＡA', 3], ['AA==\n', 1], ['AA=\u00a0', 1]] as const) {
    assert.equal(isValidBase64(data, bytes), false, `${JSON.stringify(data)} / ${bytes}`);
  }
});

test('base64 checks every ASCII code at payload and padding positions', () => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (const data of ['AAAA', 'AAA=', 'AA==']) {
    const bytes = data === 'AAAA' ? 3 : data === 'AAA=' ? 2 : 1;
    for (let position = 0; position < 4; position++) for (let code = 0; code < 128; code++) {
      const char = String.fromCharCode(code);
      const mutated = data.slice(0, position) + char + data.slice(position + 1);
      assert.equal(isValidBase64(mutated, bytes), data[position] === '=' ? char === '=' : alphabet.includes(char), `${data} position ${position} code ${code}`);
    }
  }
});

test('base64 checks the entire maximum wire payload and exact tail', () => {
  const valid = 'A'.repeat(349526) + '==';
  assert.equal(isValidBase64(valid, 262144), true);
  for (const position of [0, 174764, 349525, 349526, 349527]) {
    const invalid = valid.slice(0, position) + (position < 349526 ? '=' : 'A') + valid.slice(position + 1);
    assert.equal(isValidBase64(invalid, 262144), false, `position ${position}`);
  }
  assert.equal(isValidBase64(valid, 262143), false);
  assert.equal(isValidBase64(valid, 262145), false);
});
