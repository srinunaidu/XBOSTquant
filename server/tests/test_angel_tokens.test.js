'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveSymbol, SYMBOL_TOKENS, isValidToken } = require('../../server/utils/angel_tokens');

test('angelTokens: NIFTY resolves to 99926000', () => {
  assert.equal(resolveSymbol('NIFTY'), '99926000');
});

test('angelTokens: BANKNIFTY case-insensitive', () => {
  assert.equal(resolveSymbol('banknifty'), '99926009');
  assert.equal(resolveSymbol('  NIFTY  '), '99926000');
});

test('angelTokens: SENSEX resolves', () => {
  assert.equal(resolveSymbol('SENSEX'), '99919000');
});

test('angelTokens: custom numeric passthrough 4-10 digits', () => {
  assert.equal(resolveSymbol('99926000'), '99926000');
  assert.equal(resolveSymbol('1234'), '1234');
  assert.equal(resolveSymbol('1234567890'), '1234567890');
});

test('angelTokens: unknown symbol throws', () => {
  assert.throws(() => resolveSymbol('UNKNOWN'), /unknown_symbol/);
  assert.throws(() => resolveSymbol(''), /unknown_symbol/);
  assert.throws(() => resolveSymbol('123'), /unknown_symbol/); // too short
  assert.throws(() => resolveSymbol('12345678901'), /unknown_symbol/); // too long 11
});

test('angelTokens: isValidToken', () => {
  assert.equal(isValidToken('99926000'), true);
  assert.equal(isValidToken('123'), false);
  assert.equal(isValidToken('abc'), false);
});
