const https = require('https');
const fs = require('fs');

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

function shopifyGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: STORE,
      path: `/admin/api/2024-01/${path}`,
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': TOKEN,
        'Content-Type': 'application/json'
      }
    };
    let data = '';
    const req = https.request(options, res => {
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchAll(resource, key) {
  let results = [];
  let page = `${resource}?limit=250`;
  while (page) {
    const data = await shopifyGet(page);
    results = results.concat(data[key] || []);
    page = null; // Shopify REST pagination via Link header not needed for small stores
  }
  return results;
}

function toAEST(dateStr) {
  const d = new Date(dateStr);
  // AEST = UTC+10, AEDT = UTC+11 (Australia/Sydney)
  const aest = new Date(d.getTime() + 10 * 60 * 60 * 1000);
  return aest;
}

function startOf(unit) {
  const now = toAEST(new Date().toISOString());
  if (unit === 'today') {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 10 * 3600000);
  }
  if (unit === 'week') {
    const day = now.getUTCDay();
    const diff = (day === 0 ? -6 : 1 - day);
    const mon = new Date(now);
    mon.setUTCDate(now.getUTCDate() + diff);
    return new Date(Date.UTC(mon.getUTCFullYear(), mon.getUTCMonth(), mon.getUTCDate()) - 10 * 3600000);
  }
  if (unit === 'month') {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 10 * 3600000);
  }
  if (unit === 'last30') {
    return new Date(Date.now() - 30 * 24 * 3600 * 1000);
  }
  if (unit === 'prevMonthStart') {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1) - 10 * 3600000);
  }
  if (unit === 'prevMonthEnd') {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 10 * 3600000);
  }
}

function trend(curr, prev) {
  if (prev === 0 && curr === 0) return '→';
  if (prev === 0) return '↑';
  const pct = ((curr - prev) / prev) * 100;
  if (pct > 2) return '↑';
  if (pct < -2) return '↓';
  return '→';
}

async function main() {
  console.log('Fetching Shopify data...');

  const [ordersData, customersData, productsData] = await Promise.all([
    shopifyGet('orders.json?status=any&limit=250'),
    shopifyGet('customers.json?limit=250'),
    shopifyGet('products.json?limit=250')
  ]);

  const orders    = ordersData.orders    || [];
  const customers = customersData.customers || [];
  const products  = productsData.products  || [];

  console.log(`Orders: ${orders.length}, Customers: ${customers.length}, Products: ${products.length}`);

  // ── Metrics ──────────────────────────────────────────────────────────────
  const paidOrders = orders.filter(o => o.financial_status !== 'voided' && o.financial_status !== 'refunded');
  const totalRevenue = paidOrders.reduce((s, o) => s + parseFloat(o.total_price || 0), 0);
  const totalOrders  = paidOrders.length;
  const aov          = totalOrders > 0 ? totalRevenue / totalOrders : 0;

  const activeSubscribers = customers.filter(c => c.email_marketing_consent?.state === 'subscribed').length;
  const notSubscribed     = customers.filter(c => !c.email_marketing_consent || c.email_marketing_consent.state === 'not_subscribed').length;
  const unsubscribed      = customers.filter(c => c.email_marketing_consent?.state === 'unsubscribed').length;

  const totalInventory = products.reduce((s, p) =>
    s + (p.variants || []).reduce((vs, v) => vs + (parseInt(v.inventory_quantity) || 0), 0), 0);

  // ── Sales Trend ───────────────────────────────────────────────────────────
  function sumPeriod(start, end) {
    const filtered = paidOrders.filter(o => {
      const t = new Date(o.created_at);
      return t >= start && (!end || t < end);
    });
    return {
      revenue: parseFloat(filtered.reduce((s, o) => s + parseFloat(o.total_price || 0), 0).toFixed(2)),
      orders:  filtered.length
    };
  }

  const todayData    = sumPeriod(startOf('today'));
  const weekData     = sumPeriod(startOf('week'));
  const monthData    = sumPeriod(startOf('month'));
  const last30Data   = sumPeriod(startOf('last30'));
  const prevMonthData = sumPeriod(startOf('prevMonthStart'), startOf('prevMonthEnd'));

  const salesTrend = {
    today:    { ...todayData,   trend: trend(todayData.revenue,   0) },
    thisWeek:  { ...weekData,   trend: trend(weekData.revenue,    0) },
    thisMonth: { ...monthData,  trend: trend(monthData.revenue,   prevMonthData.revenue) },
    last30Days: { ...last30Data, trend: trend(last30Data.revenue, prevMonthData.revenue) },
    prevMonth: { ...prevMonthData }
  };

  // ── Product Performance ───────────────────────────────────────────────────
  const productMap = {};
  for (const p of products) {
    const totalQty = (p.variants || []).reduce((s, v) => s + (parseInt(v.inventory_quantity) || 0), 0);
    productMap[p.id] = {
      name:      p.title,
      type:      p.product_type || 'Other',
      sku:       (p.variants && p.variants[0] && p.variants[0].sku) || '',
      price:     parseFloat((p.variants && p.variants[0] && p.variants[0].price) || 0),
      inventory: totalQty,
      unitsSold: 0,
      revenue:   0
    };
  }

  for (const o of paidOrders) {
    for (const item of (o.line_items || [])) {
      const pid = item.product_id;
      if (productMap[pid]) {
        productMap[pid].unitsSold += item.quantity;
        productMap[pid].revenue   += parseFloat(item.price) * item.quantity;
      }
    }
  }

  const productList = Object.values(productMap)
    .sort((a, b) => b.unitsSold - a.unitsSold || b.revenue - a.revenue)
    .map(p => ({ ...p, revenue: parseFloat(p.revenue.toFixed(2)) }));

  // ── Category Distribution ─────────────────────────────────────────────────
  const categoryDistribution = {};
  for (const p of productList) {
    const cat = p.type || 'Other';
    if (!categoryDistribution[cat]) categoryDistribution[cat] = { units: 0, revenue: 0 };
    categoryDistribution[cat].units   += p.inventory;
    categoryDistribution[cat].revenue += p.revenue;
  }

  // ── Recent Orders ─────────────────────────────────────────────────────────
  const recentOrders = paidOrders.slice(0, 10).map(o => ({
    id:       o.order_number,
    date:     o.created_at,
    customer: o.customer ? `${o.customer.first_name || ''} ${o.customer.last_name || ''}`.trim() : 'Guest',
    total:    parseFloat(o.total_price),
    status:   o.financial_status
  }));

  // ── Write data.json ───────────────────────────────────────────────────────
  const output = {
    lastUpdated: new Date().toISOString(),
    store:    'Kvore',
    domain:   'kvore.com.au',
    currency: 'AUD',
    metrics: {
      totalRevenue:      parseFloat(totalRevenue.toFixed(2)),
      totalOrders,
      aov:               parseFloat(aov.toFixed(2)),
      totalCustomers:    customers.length,
      activeSubscribers,
      notSubscribed,
      unsubscribed,
      totalProducts:     products.length,
      totalInventory
    },
    salesTrend,
    products: productList,
    categoryDistribution,
    recentOrders
  };

  fs.writeFileSync('data.json', JSON.stringify(output, null, 2));
  console.log('data.json updated successfully.');
  console.log(`Revenue: $${output.metrics.totalRevenue} | Orders: ${totalOrders} | Customers: ${customers.length}`);
}

main().catch(err => { console.error(err); process.exit(1); });
