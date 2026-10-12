import { config } from './config.js';

export const normalizeOrderNumber = (v) => {
  const s = String(v || '').trim().replace(/^#/, '');
  return /^[A-Za-z0-9-]{1,20}$/.test(s) ? s : null;
};
const sameEmail = (a, b) => !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

export function shopifyEnabled() {
  return !!(config.shopify.store && config.shopify.token);
}

async function gql(query, variables) {
  const url = `https://${config.shopify.store}/admin/api/${config.shopify.version}/graphql.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': config.shopify.token },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Shopify HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error('Shopify: ' + JSON.stringify(json.errors).slice(0, 300));
  return json.data;
}

const ORDER_FIELDS = `
  id name email createdAt cancelledAt displayFinancialStatus displayFulfillmentStatus
  lineItems(first: 20) { nodes { title quantity } }
  fulfillments(first: 5) {
    status estimatedDeliveryAt
    trackingInfo(first: 3) { company number url }
  }
`;

export const ORDER_LOOKUP_QUERY = `query OrderLookup($q: String!) { orders(first: 3, query: $q) { nodes { ${ORDER_FIELDS} } } }`;

/**
 * Consulta um pedido. Só devolve dados se número E e-mail conferem.
 * Qualquer falha devolve o mesmo resultado (não revela se o pedido existe).
 */
export async function lookupOrder({ orderNumber, email }) {
  const num = normalizeOrderNumber(orderNumber);
  if (!num || !email || !shopifyEnabled()) return { ok: false };
  const data = await gql(ORDER_LOOKUP_QUERY, { q: `name:${num}` });
  const o = data.orders.nodes.find((n) => n.name.replace('#', '') === num);
  if (!o || !sameEmail(o.email, email)) return { ok: false };
  return {
    ok: true,
    order: {
      number: o.name,
      id: o.id,
      placed_at: o.createdAt,
      cancelled: !!o.cancelledAt,
      payment_status: o.displayFinancialStatus,
      fulfillment_status: o.displayFulfillmentStatus,
      items: o.lineItems.nodes.map((i) => `${i.quantity} x ${i.title}`),
      shipments: o.fulfillments.map((f) => ({
        status: f.status,
        estimated_delivery: f.estimatedDeliveryAt,
        tracking: f.trackingInfo.map((t) => ({ carrier: t.company, number: t.number, url: t.url })),
      })),
    },
  };
}

// ---- execução de ações (somente após aprovação humana) ----
const CANCEL = `mutation Cancel($id: ID!) {
  orderCancel(orderId: $id, reason: CUSTOMER, refundMethod: { originalPaymentMethodsRefund: true }, restock: true, notifyCustomer: true) {
    job { id } orderCancelUserErrors { field message code }
  }
}`;
const ADDRESS = `mutation Addr($input: OrderInput!) {
  orderUpdate(input: $input) { order { id name } userErrors { field message } }
}`;
export const ORDER_STATE_QUERY = `query OrderState($q: String!) { orders(first: 3, query: $q) { nodes { id name displayFulfillmentStatus cancelledAt } } }`;

export async function findOrderState(orderName) {
  const num = normalizeOrderNumber(orderName);
  const data = await gql(ORDER_STATE_QUERY, { q: `name:${num}` });
  return data.orders.nodes.find((n) => n.name.replace('#', '') === num) || null;
}

export async function executeAction(action) {
  if (!shopifyEnabled()) return { ok: false, message: 'Shopify não configurado.' };
  const payload = JSON.parse(action.payload || '{}');
  const state = await findOrderState(action.order_name);
  if (!state) return { ok: false, message: 'Pedido não encontrado no Shopify.' };
  if (state.cancelledAt) return { ok: false, message: 'Pedido já está cancelado.' };

  if (action.type === 'cancel_order') {
    if (state.displayFulfillmentStatus !== 'UNFULFILLED')
      return { ok: false, message: `Pedido não pode ser cancelado automaticamente (status: ${state.displayFulfillmentStatus}). Trate manualmente no Shopify.` };
    const d = await gql(CANCEL, { id: state.id });
    const errs = d.orderCancel.orderCancelUserErrors;
    return errs.length ? { ok: false, message: errs.map((e) => e.message).join('; ') } : { ok: true, message: 'Cancelamento enviado ao Shopify (com reembolso).' };
  }

  if (action.type === 'update_address') {
    if (state.displayFulfillmentStatus !== 'UNFULFILLED')
      return { ok: false, message: 'Pedido já enviado ou em preparo: confirme com a transportadora e altere manualmente.' };
    const a = payload.new_address || {};
    const d = await gql(ADDRESS, {
      input: {
        id: state.id,
        shippingAddress: {
          firstName: String(a.name || '').slice(0, 100),
          address1: String(a.address1 || '').slice(0, 200),
          address2: String(a.address2 || '').slice(0, 200),
          city: String(a.city || '').slice(0, 100),
          zip: String(a.postcode || '').slice(0, 20),
          countryCode: String(a.country || 'GB').slice(0, 2).toUpperCase(),
          phone: String(a.phone || '').slice(0, 30),
        },
      },
    });
    const errs = d.orderUpdate.userErrors;
    return errs.length ? { ok: false, message: errs.map((e) => e.message).join('; ') } : { ok: true, message: 'Endereço atualizado no Shopify.' };
  }

  // refund_order: por segurança, nunca movimenta dinheiro automaticamente.
  if (action.type === 'refund_order')
    return { ok: true, manual: true, message: `Aprovado. Faça o reembolso manualmente: https://${config.shopify.store}/admin/orders (pedido ${action.order_name}).` };

  return { ok: false, message: 'Tipo de ação desconhecido.' };
}
