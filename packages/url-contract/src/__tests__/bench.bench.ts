/**
 * Benchmark tests for url-contract generators and URL helpers (#331).
 *
 * Run with: pnpm bench
 * Uses vitest's bench API.
 */

import { bench, describe } from 'vitest';
import {
  generateRoomCode,
  generateOpaqueRoomId,
  generateShortId,
  generateShortLinkAlias,
  messengerSafeBase64Url16,
} from '../generators.js';
import { parseRoomCode } from '../parse.js';
import { verifyChecksum } from '../checksum.js';
import { asRoomId } from '../brands.js';
import {
  buildCall1to1Url,
  buildGroupCallUrl,
  buildBurnerChatUrl,
  parseRoomUrl,
} from '../url.js';

const ORIGIN = 'https://app.oxpulse.chat';

// Pre-generate IDs for parse benchmarks (don't include gen time in parse bench)
const opaqueId = generateOpaqueRoomId();
const groupCode = generateRoomCode('group');
const opaqueRoomId = asRoomId(opaqueId);
const groupRoomId = asRoomId(groupCode);
const callUrl = buildCall1to1Url(ORIGIN, opaqueRoomId, {
  fragment: { joinSecret: 'secretB64', expectedHostPubkey: 'pubkeyHex' },
});
const groupUrl = buildGroupCallUrl(ORIGIN, groupRoomId);
const burnerUrl = buildBurnerChatUrl(ORIGIN, opaqueRoomId, 'keyB64');

// ── Generator benchmarks ─────────────────────────────────────────────────────

describe('generators', () => {
  bench('generateOpaqueRoomId', () => {
    generateOpaqueRoomId();
  });

  bench('generateRoomCode("group")', () => {
    generateRoomCode('group');
  });

  bench('messengerSafeBase64Url16', () => {
    messengerSafeBase64Url16();
  });

  bench('generateShortId(12)', () => {
    generateShortId(12);
  });

  bench('generateShortLinkAlias(5)', () => {
    generateShortLinkAlias(5);
  });
});

// ── Parser benchmarks ────────────────────────────────────────────────────────

describe('parsers', () => {
  bench('parseRoomCode(opaqueId)', () => {
    parseRoomCode(opaqueId);
  });

  bench('parseRoomCode(groupCode)', () => {
    parseRoomCode(groupCode);
  });

  bench('verifyChecksum(groupCode)', () => {
    verifyChecksum(groupRoomId);
  });
});

// ── URL builder benchmarks ───────────────────────────────────────────────────

describe('URL builders', () => {
  bench('buildCall1to1Url (no fragment)', () => {
    buildCall1to1Url(ORIGIN, opaqueRoomId);
  });

  bench('buildCall1to1Url (with fragment)', () => {
    buildCall1to1Url(ORIGIN, opaqueRoomId, {
      fragment: { joinSecret: 'secretB64', expectedHostPubkey: 'pubkeyHex' },
    });
  });

  bench('buildGroupCallUrl', () => {
    buildGroupCallUrl(ORIGIN, groupRoomId);
  });

  bench('buildBurnerChatUrl', () => {
    buildBurnerChatUrl(ORIGIN, opaqueRoomId, 'keyB64');
  });
});

// ── URL parser benchmarks ────────────────────────────────────────────────────

describe('URL parsers', () => {
  bench('parseRoomUrl (1:1 call with fragment)', () => {
    parseRoomUrl(callUrl);
  });

  bench('parseRoomUrl (group call)', () => {
    parseRoomUrl(groupUrl);
  });

  bench('parseRoomUrl (burner chat)', () => {
    parseRoomUrl(burnerUrl);
  });
});
