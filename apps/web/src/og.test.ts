import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchOg, isPublicAddress, parseOg } from './og.ts';

test('parseOg extracts OpenGraph tags', () => {
  const html = `<html><head>
    <meta property="og:title" content="Hello &amp; World">
    <meta property="og:description" content="A test page">
    <meta property="og:image" content="https://cdn.example.com/img.png">
    <meta property="og:site_name" content="Example">
    <title>fallback title</title>
  </head></html>`;
  const og = parseOg(html, 'https://example.com/page');
  assert.equal(og.title, 'Hello & World');
  assert.equal(og.description, 'A test page');
  assert.equal(og.image, 'https://cdn.example.com/img.png');
  assert.equal(og.siteName, 'Example');
});

test('parseOg falls back to <title> and meta description', () => {
  const html = `<head><title>Just a title</title><meta name="description" content="desc here"></head>`;
  const og = parseOg(html, 'https://example.com/');
  assert.equal(og.title, 'Just a title');
  assert.equal(og.description, 'desc here');
  assert.equal(og.image, undefined);
});

test('parseOg resolves a relative og:image against the page URL', () => {
  const html = `<head><meta property="og:image" content="/static/cover.jpg"><title>t</title></head>`;
  const og = parseOg(html, 'https://news.example.com/article/5');
  assert.equal(og.image, 'https://news.example.com/static/cover.jpg');
});

test('parseOg handles reversed attribute order (content before property)', () => {
  const html = `<head><meta content="Reversed" property="og:title"><title>t</title></head>`;
  const og = parseOg(html, 'https://example.com/');
  assert.equal(og.title, 'Reversed');
});

test('only public addresses count as public', () => {
  for (const ip of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
    '::1', '::', 'fe80::1', 'fd00::1', '::ffff:7f00:1', '::ffff:192.168.0.1', 'not-an-ip']) assert.equal(isPublicAddress(ip), false, ip);
});

// Link URLs come from received messages; no request may reach this machine or its network.
const html = (title: string) => new Response(`<title>${title}</title>`, { headers: { 'content-type': 'text/html' } });
const publicDns = async (host: string) => host === 'lan.example' ? ['192.168.0.10'] : ['203.0.113.7'];

test('fetchOg refuses loopback and LAN targets in every spelling before any request', async () => {
  let requests = 0;
  const fetch = (async () => { requests++; return html('x'); }) as typeof globalThis.fetch;
  for (const url of ['http://localhost/', 'http://127.1/', 'http://2130706433/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
    'http://192.168.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://printer.local/', 'http://lan.example/', 'file:///etc/passwd']) {
    await assert.rejects(fetchOg(url, { lookup: publicDns, fetch }), /blocked host|unsupported scheme/, url);
  }
  assert.equal(requests, 0);
});

test('fetchOg re-checks every redirect hop and caps the chain', async () => {
  const requested: string[] = [];
  const redirectTo = (location: string) => new Response(null, { status: 302, headers: { location } });
  const fetch = (async (url: string) => {
    requested.push(url);
    if (url === 'https://public.example/to-lan') return redirectTo('http://192.168.0.1/admin');
    if (url === 'https://public.example/to-relative') return redirectTo('/page');
    if (url.startsWith('https://public.example/loop')) return redirectTo(`/loop${requested.length}`);
    return html('Public page');
  }) as typeof globalThis.fetch;
  await assert.rejects(fetchOg('https://public.example/to-lan', { lookup: publicDns, fetch }), /blocked host/);
  assert.deepEqual(requested, ['https://public.example/to-lan'], 'the LAN target was never requested');
  assert.equal((await fetchOg('https://public.example/to-relative', { lookup: publicDns, fetch })).title, 'Public page');
  await assert.rejects(fetchOg('https://public.example/loop', { lookup: publicDns, fetch }), /too many redirects/);
});
