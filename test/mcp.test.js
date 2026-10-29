import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  signToken, verifyToken, tokenSecret, sha256b64url, safeEqual, handleRpc, runTool, summarize,
} from '../supabase/functions/adversus-mcp/lib.js';

const lead = (id, status, company, over = {}) => ({
  id, status, active: true, contactAttempts: 3,
  lastModifiedTime: '2026-10-20T10:00:00Z', nextContactTime: '2026-10-22T08:00:00Z',
  masterData: [
    { label: 'Företagsnamn', value: company },
    { label: 'Organisationsnr', value: '556280-2115' },
    { label: 'Kontaktperson', value: 'Linda Hammar' },
    { label: 'Email', value: 'linda@rusta.com' },
  ],
  resultData: status === 'success'
    ? [{ label: 'Beskrivning', value: 'Vill se demo' }, { label: 'Email sent to consultant', value: 'robin@indivd.com' }]
    : [{ label: 'Anledning - Inte intresserad', value: 'Nöjd med befintlig lösning' }],
  ...over,
});
const leads = [
  lead(1, 'success', 'Rusta'),
  lead(2, 'notInterested', 'Jupiter', { lastModifiedTime: '2026-09-01T10:00:00Z' }),
  lead(3, 'automaticRedial', 'TEST101'),
];

test('token: signeras, verifieras och avvisas när den manipulerats eller gått ut', async () => {
  const secret = await tokenSecret('hemligt');
  const t = await signToken({ typ: 'access' }, secret, 60);
  assert.ok(await verifyToken(t, secret, 'access'));
  assert.equal(await verifyToken(t, secret, 'refresh'), null);
  assert.equal(await verifyToken(t, await tokenSecret('annat'), 'access'), null);
  assert.equal(await verifyToken(t.slice(0, -2) + 'xx', secret, 'access'), null);
  const old = await signToken({ typ: 'access' }, secret, 60, Date.now() - 120_000);
  assert.equal(await verifyToken(old, secret, 'access'), null);
});

test('PKCE S256 stämmer med Nodes egen sha256/base64url', async () => {
  const { createHash } = await import('node:crypto');
  const v = 'a-random-verifier_ÅÄÖ~123';
  assert.equal(await sha256b64url(v), createHash('sha256').update(v).digest('base64url'));
});

test('lösenordsjämförelse', () => {
  assert.ok(safeEqual('abc', 'abc'));
  assert.ok(!safeEqual('abc', 'abd'));
  assert.ok(!safeEqual('abc', 'abcd'));
});

test('sok_leads filtrerar på fritext, status och datum och hoppar över testleads', () => {
  assert.equal(runTool('sok_leads', {}, leads).antal_traffar, 2);
  assert.equal(runTool('sok_leads', { fritext: 'rusta' }, leads).leads[0].bolag, 'Rusta');
  assert.equal(runTool('sok_leads', { fritext: '5562802115' }, leads).antal_traffar, 2);
  assert.equal(runTool('sok_leads', { status: 'success' }, leads).antal_traffar, 1);
  assert.equal(runTool('sok_leads', { sedan: '2026-10-01' }, leads).antal_traffar, 1);
});

test('statistik och hamta_lead', () => {
  const s = runTool('statistik', {}, leads);
  assert.equal(s.antal_leads, 2);
  assert.equal(s.antal_samtal_totalt, 6);
  assert.deepEqual(s.bokade_moten.map((m) => m.skickat_till), ['robin@indivd.com']);
  assert.equal(runTool('hamta_lead', { lead_id: 1 }, leads).moteanteckning, 'Vill se demo');
  assert.equal(summarize(leads[1]).anledning, 'Nöjd med befintlig lösning');
});

test('MCP: initialize, tools/list, tools/call och notifikationer', async () => {
  const get = async () => leads;
  const init = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, get);
  assert.equal(init.result.serverInfo.name, 'adversus');
  assert.equal(await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, get), null);
  const list = await handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, get);
  assert.deepEqual(list.result.tools.map((t) => t.name), ['sok_leads', 'hamta_lead', 'statistik']);
  const call = await handleRpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'statistik', arguments: {} } }, get);
  assert.equal(call.result.structuredContent.antal_leads, 2);
  const bad = await handleRpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } }, get);
  assert.ok(bad.result.isError);
});
