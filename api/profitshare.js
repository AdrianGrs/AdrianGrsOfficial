const crypto = require('crypto');

const PS_BASE = 'https://api.profitshare.ro';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

function buildAuthHeaders(method, endpoint, queryString) {
  const apiUser = process.env.PS_API_USER;
  const apiKey  = process.env.PS_API_KEY;

  if (!apiUser || !apiKey) {
    throw new Error('PS_API_USER sau PS_API_KEY lipsesc din Environment Variables!');
  }

  const date = new Date().toUTCString();
  const qs = queryString || '';
  const signatureString = `${method.toUpperCase()}${endpoint}?${qs}/${apiUser}${date}`;
  const auth = crypto.createHmac('sha1', apiKey).update(signatureString).digest('hex');

  return {
    'Date': date,
    'X-PS-Client': apiUser,
    'X-PS-Accept': 'json',
    'X-PS-Auth': auth,
  };
}

async function psGet(endpoint, queryString = '') {
  const headers = buildAuthHeaders('GET', endpoint, queryString);
  const url = queryString
    ? `${PS_BASE}/${endpoint}?${queryString}`
    : `${PS_BASE}/${endpoint}`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Profitshare error ${res.status}: ${text}`);
  }
  return res.json();
}

async function supabaseInsert(rows) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('SUPABASE_URL sau SUPABASE_SERVICE_KEY lipsesc!');
  }

  const res = await fetch(`${supabaseUrl}/rest/v1/produse`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Prefer': 'resolution=ignore-duplicates',
    },
    body: JSON.stringify(rows),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase insert error: ${text}`);
  }
  return res.status;
}

async function getExistingLinks() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  const res = await fetch(`${supabaseUrl}/rest/v1/produse?select=link_afiliat`, {
    headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` },
  });
  const data = await res.json();
  return new Set((data || []).map(p => p.link_afiliat));
}

async function aiCategorize(productName) {
  const CATEGORIES = ['SmartTech','Gaming','Gadgets','Fashion','Jucarii','Gradina','Bucatarie','Sport','Health And Beauty','Auto','Carti','Animale'];
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 20,
        messages: [{ role: 'user', content: `Clasifică produsul. Răspunde DOAR cu numele categoriei.\nProdus: "${productName}"\nCategorii: SmartTech, Gaming, Gadgets, Fashion, Jucarii, Gradina, Bucatarie, Sport, Health And Beauty, Auto, Carti, Animale` }]
      })
    });
    const data = await res.json();
    const detected = data.content?.[0]?.text?.trim();
    return CATEGORIES.includes(detected) ? detected : null;
  } catch { return null; }
}

function mapProduct(p) {
  let link = p.link || '';
  if (link.startsWith('//')) link = 'https:' + link;
  let img = p.image || '';
  if (img.startsWith('//')) img = 'https:' + img;
  const priceVat = p.price_vat ? `${parseFloat(p.price_vat).toFixed(0)} lei` : null;
  return { nume: p.name || null, link_afiliat: link || null, imagine_url: img || null, pret: priceVat, pret_vechi: null, categorie: null };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(200).end();
  }
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  const { action, page = '1', advertiser = '', status = '', date_from = '', date_to = '', limit = '20' } = req.query;

  try {
    if (action === 'categorize') {
      const { name = '' } = req.query;
      if (!name) return res.status(400).json({ ok: false, error: 'Lipseste parametrul name.' });
      const category = await aiCategorize(name);
      return res.status(200).json({ ok: true, category });
    }

    if (action === 'advertisers') {
      const data = await psGet('affiliate-advertisers/', '');
      return res.status(200).json({ ok: true, data: data.result || [] });
    }

    if (action === 'products') {
      let qs = `page=${page}`;
      if (advertiser) qs += `&filters[advertiser]=${advertiser}`;
      const data = await psGet('affiliate-products/', qs);
      return res.status(200).json({ ok: true, data: data.result || {} });
    }

    if (action === 'campaigns') {
      const data = await psGet('affiliate-campaigns/', `page=${page}`);
      return res.status(200).json({ ok: true, data: data.result || {} });
    }

    if (action === 'commissions') {
      let qs = `page=${page}`;
      if (status)    qs += `&filters[status]=${status}`;
      if (date_from) qs += `&filters[date_from]=${date_from}`;
      if (date_to)   qs += `&filters[date_to]=${date_to}`;
      const data = await psGet('affiliate-commissions/', qs);
      return res.status(200).json({ ok: true, data: data.result || {} });
    }

    if (action === 'sync') {
      if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'Folosește POST.' });
      }

      const maxProducts = Math.min(parseInt(limit) || 20, 50);
      const advertiserFilter = advertiser || '';

      let qs = 'page=1';
      if (advertiserFilter) qs += `&filters[advertiser]=${advertiserFilter}`;

      const data = await psGet('affiliate-products/', qs);
      const result = data.result || {};
      const psList = (result.products || []).slice(0, maxProducts);

      const existingLinks = await getExistingLinks();

      const newProducts = psList.filter(p => {
        let link = p.link || '';
        if (link.startsWith('//')) link = 'https:' + link;
        return link && !existingLinks.has(link);
      });

      let added = 0, skipped = psList.length - newProducts.length, errors = 0;
      const results = [];

      for (const p of newProducts) {
        const mapped = mapProduct(p);
        if (!mapped.nume || !mapped.link_afiliat) { errors++; continue; }
        mapped.categorie = await aiCategorize(mapped.nume);
        try {
          await supabaseInsert([mapped]);
          added++;
          results.push({ name: mapped.nume, category: mapped.categorie, status: 'added' });
        } catch (err) {
          errors++;
          results.push({ name: mapped.nume, error: err.message, status: 'error' });
        }
        await sleep(500);
      }

      return res.status(200).json({
        ok: true,
        summary: { total_from_api: psList.length, processed: psList.length, added, skipped, errors },
        results,
      });
    }

    return res.status(400).json({ ok: false, error: 'Action necunoscut.' });

  } catch (err) {
    console.error('[Profitshare API Error]', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
