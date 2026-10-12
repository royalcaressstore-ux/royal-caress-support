import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { shopifyEnabled, lookupOrder, resetShopifyTokenCache } from '../src/shopify.js';

test('Shopify: obtém token por client credentials, reutiliza e renova após 401', async () => {
  Object.assign(config.shopify, { store: 'loja.myshopify.com', token: '', clientId: 'id', clientSecret: 'sec' });
  resetShopifyTokenCache();
  assert.equal(shopifyEnabled(), true);
  const real = globalThis.fetch; const calls = []; let issued = 0;
  globalThis.fetch = async (url, opts) => {
    calls.push(String(url));
    if (String(url).endsWith('/admin/oauth/access_token')) {
      const b = JSON.parse(opts.body);
      assert.equal(b.grant_type, 'client_credentials'); assert.equal(b.client_id, 'id');
      issued += 1;
      return new Response(JSON.stringify({ access_token: 'tok' + issued, expires_in: 86399 }), { status: 200 });
    }
    const tok = opts.headers['X-Shopify-Access-Token'];
    if (tok === 'tok1' && calls.filter((c) => c.includes('graphql')).length === 3) return new Response('{}', { status: 401 });
    return new Response(JSON.stringify({ data: { orders: { nodes: [] } } }), { status: 200 });
  };
  try {
    await lookupOrder({ orderNumber: '1001', email: 'a@b.com' });
    await lookupOrder({ orderNumber: '1001', email: 'a@b.com' }); // reutiliza tok1 (sem novo pedido de token)
    assert.equal(issued, 1);
    await lookupOrder({ orderNumber: '1001', email: 'a@b.com' }); // 401 com tok1 → renova → tok2
    assert.equal(issued, 2);
  } finally { globalThis.fetch = real; Object.assign(config.shopify, { store: '', clientId: '', clientSecret: '' }); resetShopifyTokenCache(); }
});

test('Shopify: SHOPIFY_ADMIN_TOKEN fixo tem prioridade e não chama o endpoint de token', async () => {
  Object.assign(config.shopify, { store: 'loja.myshopify.com', token: 'fixo', clientId: 'id', clientSecret: 'sec' });
  const real = globalThis.fetch; const urls = [];
  globalThis.fetch = async (url, opts) => { urls.push(String(url)); assert.equal(opts.headers['X-Shopify-Access-Token'], 'fixo'); return new Response(JSON.stringify({ data: { orders: { nodes: [] } } }), { status: 200 }); };
  try { await lookupOrder({ orderNumber: '1', email: 'a@b.com' }); assert.ok(urls.every((u) => !u.includes('oauth'))); }
  finally { globalThis.fetch = real; Object.assign(config.shopify, { store: '', token: '', clientId: '', clientSecret: '' }); }
});
