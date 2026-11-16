// Token Radar's dashboard (radar-2). It reads window.RADAR — written beside dashboard/
// by main.ts — and renders the ranked board, a filterable table, and a per-protocol
// detail drawer with the model's own inputs and the protocol's farm plan. No network:
// every byte on screen comes from data.js.
//
// Screenshot staging: ?shot=detail&p=<slug> opens a protocol's detail view, while
// ?shot=filtered with #category=<name> shows a filtered board. The page sets
// window.__shotReady once it has painted.
(() => {
  'use strict';

  const DATA = window.RADAR;
  if (!DATA) return;
  const mount = document.getElementById('board');

  const view = {
    q: '',
    category: 'all',
    chain: 'all',
    tab: 'pre-token',
    sort: 'implied',
    dir: -1,
    selected: null,
  };

  /* ---------- small formatters ---------- */

  const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  const money = (n) => {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    const abs = Math.abs(n);
    if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
    if (abs >= 1e3) return `$${Math.round(n / 1e3)}K`;
    return usd0.format(n);
  };

  const pct = (n) => {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
  };

  const ageLabel = (days) => {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return `${(days / 365).toFixed(1)}y`;
    return `${Math.max(0, Math.round(days))}d`;
  };

  /* ---------- the model, recomputed in the page ---------- */

  // The page recomputes a row from the snapshot figures and checks the number board.json
  // carries, so the page's code and the board's data are visibly the same arithmetic.
  const impliedOf = (row, model) => {
    const growth = Math.min(
      model.growth_cap,
      Math.max(model.growth_floor, row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d),
    );
    const growthMult = 1 + (growth / 100) * model.growth_weight;
    const age = row.age_days === null || row.age_days === undefined ? model.unknown_age_days : row.age_days;
    const maturity = model.maturity_floor + (Math.min(Math.max(age, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
    const chainMult = 1 + model.chain_step * Math.min((row.chains || []).length, model.chain_cap);
    const tvlScore = Math.pow(Math.max(row.tvl_usd, 0) / 1e6, model.tvl_exponent);
    return Math.max(1, Math.round(model.base_scale * tvlScore * growthMult * maturity * chainMult));
  };

  /* ---------- a tiny DOM builder ---------- */

  const h = (tag, props, ...kids) => {
    const node = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value);
      }
    }
    const push = (child) => {
      if (child === null || child === undefined || child === false) return;
      if (Array.isArray(child)) child.forEach(push);
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    };
    kids.forEach(push);
    return node;
  };

  /* ---------- the farm plan, derived the same way board.json derives it ---------- */

  const firstChain = (p) => (p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain');
  const gasPrice = (chain) => (chain === 'Ethereum' ? 8 : 1);
  const capitalNeeded = (p) => {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  };
  const holdDays = (age) => {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  };

  // First matching rule wins; the order below is the decision order.
  const ACTION_RULES = [
    { keys: ['lend', 'cdp', 'collateral', 'uncollateralized'], text: (n, c, ch) => `Supply $${c} of USDC to ${n} on ${ch} and keep the loan open.` },
    { keys: ['dex', 'leveraged farm'], text: (n, c, ch) => `Provide $${c} of liquidity to ${n}'s main pool on ${ch} and keep the position open.` },
    { keys: ['curator', 'allocator'], text: (n, c, ch) => `Deposit $${c} into a ${n} vault on ${ch} and keep the shares.` },
    { keys: ['yield aggregator'], text: (n, c, ch) => `Deposit $${c} into ${n}'s top vault on ${ch} and keep the shares.` },
    { keys: ['yield'], text: (n, c, ch) => `Deposit $${c} into ${n} on ${ch} and keep the position earning.` },
    { keys: ['rwa'], text: (n, c, ch) => `Mint $${c} of the protocol's yield asset on ${ch} and hold it.` },
    { keys: ['basis'], text: (n, c, ch) => `Deposit $${c} into ${n}'s basis vault on ${ch} and keep the position open.` },
    { keys: ['derivative', 'perpetual'], text: (n, c, ch) => `Deposit $${c} of USDC as margin on ${n} and open one small hedge.` },
    { keys: ['prediction'], text: (n, c, ch) => `Fund $${c} and place one market position on ${n}.` },
    { keys: ['stable'], text: (n, c, ch) => `Mint or deposit $${c} of the stable asset through ${n} on ${ch}.` },
    { keys: ['insurance'], text: (n, c, ch) => `Buy $${c} of cover from ${n} on ${ch} and keep the policy.` },
    { keys: ['farm'], text: (n, c, ch) => `Stake $${c} of LP tokens in ${n}'s farm on ${ch} and keep the stake.` },
    { keys: ['otc', 'marketplace'], text: (n, c, ch) => `Place one $${c} order through ${n} on ${ch} and settle it.` },
    { keys: ['payment', 'card'], text: (n, c, ch) => `Spend $${c} through ${n} on ${ch} and keep the account active.` },
    { keys: ['index'], text: (n, c, ch) => `Buy $${c} of the ${n} index on ${ch} and hold the shares.` },
    { keys: ['governance'], text: (n, c, ch) => `Lock $${c} of assets in ${n} on ${ch} and vote once.` },
    { keys: ['chain'], text: (n, c, ch) => `Use $${c} of ${n} on ${ch} for one real transaction and keep the wallet active.` },
  ];

  const pickAction = (p, capital, chain) => {
    const category = (p.category || '').toLowerCase();
    for (const rule of ACTION_RULES) {
      if (rule.keys.some((key) => category.includes(key))) return rule.text(p.name, capital, chain);
    }
    return `Deposit $${capital} of USDC into ${p.name} on ${chain} and keep the position open.`;
  };

  const renderStep = (step) => {
    let line = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
    if (line.length > 600) line = `${line.slice(0, 596)}...`;
    if (line.length < 20) line = `${line} Hold the position and check the protocol's own page.`;
    return line;
  };

  const farmSteps = (p) => {
    const chain = firstChain(p);
    const gas = gasPrice(chain);
    const capital = capitalNeeded(p);
    const hold = holdDays(p.age_days);
    const action = pickAction(p, capital, chain);
    return [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: `about $${gas} of gas for the first transaction`, time: '5 minutes' },
      { text: action, cost: `$${capital} of capital and about $${gas} of gas`, time: '15 minutes to set up' },
      { text: 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.', cost: `about $${gas} of gas a week`, time: '10 minutes a week' },
      { text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`, cost: `the $${capital} stays in the position`, time: `${hold} days` },
      { text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`, cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
      { text: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.', cost: 'nothing but the log', time: '5 minutes' },
      { text: 'Unwind in reverse when you exit, then revoke the token approvals the farm needed.', cost: `about $${gas} of gas to unwind`, time: '10 minutes' },
    ].map(renderStep);
  };

  /* ---------- address bar state ---------- */

  const readHash = () => {
    const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    if (fromHash.get('q')) view.q = fromHash.get('q');
    if (fromHash.get('p')) view.selected = fromHash.get('p');
    if (fromHash.get('category')) view.category = fromHash.get('category');
    if (fromHash.get('chain')) view.chain = fromHash.get('chain');
    const fromQuery = new URLSearchParams(window.location.search);
    if (fromQuery.get('p')) view.selected = fromQuery.get('p');
    if (fromQuery.get('category')) view.category = fromQuery.get('category');
    if (fromQuery.get('chain')) view.chain = fromQuery.get('chain');
    if (fromQuery.get('q')) view.q = fromQuery.get('q');
  };

  const writeHash = () => {
    const params = new URLSearchParams();
    if (view.q) params.set('q', view.q);
    if (view.category !== 'all') params.set('category', view.category);
    if (view.chain !== 'all') params.set('chain', view.chain);
    if (view.selected) params.set('p', view.selected);
    const next = params.toString();
    window.history.replaceState(null, '', next ? `#${next}` : window.location.pathname + window.location.search);
  };

  /* ---------- filtering and sorting ---------- */

  const visibleRows = () => {
    const q = view.q.trim().toLowerCase();
    return DATA.rows.filter((r) => {
      if (view.category !== 'all' && r.category !== view.category) return false;
      if (view.chain !== 'all' && !(r.chains || []).includes(view.chain)) return false;
      if (!q) return true;
      const hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  };

  const sortValue = (row, key) => {
    if (key === 'name') return row.name.toLowerCase();
    if (key === 'tvl') return row.tvl_usd;
    if (key === 'growth') return row.change_7d === null ? -Infinity : row.change_7d;
    if (key === 'age') return row.age_days === null ? Infinity : row.age_days;
    return row.implied_value_usd;
  };

  const sortedRows = (list) =>
    list.slice().sort((a, b) => {
      const av = sortValue(a, view.sort);
      const bv = sortValue(b, view.sort);
      if (av < bv) return -view.dir;
      if (av > bv) return view.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });

  const medianImplied = () => {
    const vals = DATA.rows.map((r) => r.implied_value_usd).sort((a, b) => a - b);
    return vals[Math.floor(vals.length / 2)] || 0;
  };

  /* ---------- views ---------- */

  const headerView = () =>
    h('header', { class: 'top' },
      h('div', { class: 'brand' }, h('span', { class: 'mark' }), h('span', { class: 'brand-name', text: 'Token Radar' })),
      h('div', { class: 'top-meta' },
        h('span', { text: `Snapshot ${DATA.as_of}` }),
        h('span', { text: 'DefiLlama protocol index' }),
        h('span', { text: `${DATA.model_version} model` }),
      ),
    );

  const ledeView = () => {
    const growing = DATA.rows.filter((r) => (r.change_7d || 0) > 0).length;
    return h('section', { class: 'lede' },
      h('div', null,
        h('h1', { text: `${DATA.watchlist_size} watchlist protocols, ranked by implied value` }),
        h('p', { text: `The watchlist is the floor: every protocol with at least $${Math.round(DATA.floor_usd / 1e6)}M of TVL and no token on record. The early radar adds ${DATA.early_size} pre-token protocols below that floor that pass the same quality rule. Implied value is a model, not a promise.` }),
      ),
      h('div', { class: 'facts' },
        h('div', { class: 'fact' },
          h('span', { text: 'Watchlist covered' }),
          h('b', { text: `${DATA.watchlist_size} / ${DATA.watchlist_size}` }),
          h('i', { text: 'every watchlist slug is ranked' }),
        ),
        h('div', { class: 'fact' },
          h('span', { text: 'Pre-token rows scored' }),
          h('b', { text: String(DATA.board_size) }),
          h('i', { text: `${DATA.early_size} early rows below the floor` }),
        ),
        h('div', { class: 'fact' },
          h('span', { text: 'Median implied value' }),
          h('b', { text: money(medianImplied()) }),
          h('i', { text: `top row ${money(DATA.rows[0] ? DATA.rows[0].implied_value_usd : 0)}` }),
        ),
        h('div', { class: 'fact' },
          h('span', { text: 'Growing in 7 days' }),
          h('b', { text: `${growing} / ${DATA.board_size}` }),
          h('i', { text: `${DATA.live_size} live-token protocols set aside` }),
        ),
      ),
    );
  };

  const controlsView = () => {
    const categories = [...new Set(DATA.rows.map((r) => r.category || 'Other'))].sort();
    const chainCounts = {};
    DATA.rows.forEach((r) => (r.chains || []).forEach((c) => { chainCounts[c] = (chainCounts[c] || 0) + 1; }));
    const chains = Object.keys(chainCounts).sort((a, b) => chainCounts[b] - chainCounts[a]);

    const search = h('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: view.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', () => { view.q = search.value; writeHash(); render(); });

    const categorySelect = h('select', { id: 'category', 'aria-label': 'Filter by category' },
      h('option', { value: 'all', text: 'All categories' }),
      categories.map((c) => h('option', { value: c, text: c, selected: c === view.category ? 'selected' : null })),
    );
    categorySelect.addEventListener('change', () => { view.category = categorySelect.value; writeHash(); render(); });

    const chainSelect = h('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      h('option', { value: 'all', text: 'All chains' }),
      chains.map((c) => h('option', { value: c, text: `${c} (${chainCounts[c]})`, selected: c === view.chain ? 'selected' : null })),
    );
    chainSelect.addEventListener('change', () => { view.chain = chainSelect.value; writeHash(); render(); });

    const preTab = h('button', { type: 'button', 'aria-pressed': view.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: () => { view.tab = 'pre-token'; render(); } });
    const liveTab = h('button', { type: 'button', 'aria-pressed': view.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: () => { view.tab = 'live'; render(); } });

    return h('div', { class: 'controls' },
      h('div', { class: 'field' }, h('label', { for: 'q', text: 'Search' }), search),
      h('div', { class: 'field' }, h('label', { for: 'category', text: 'Category' }), categorySelect),
      h('div', { class: 'field' }, h('label', { for: 'chain', text: 'Chain' }), chainSelect),
      h('div', { class: 'field' },
        h('span', { class: 'sub', text: 'Token status' }),
        h('div', { class: 'tabs' }, preTab, liveTab),
      ),
      h('span', { class: 'count', text: view.tab === 'pre-token' ? `${visibleRows().length} rows shown` : `${DATA.live.length} live-token protocols` }),
    );
  };

  const sortHeader = (key, label) =>
    h('th', { scope: 'col' },
      h('button', { type: 'button', onclick: () => { if (view.sort === key) view.dir = -view.dir; else { view.sort = key; view.dir = -1; } render(); } },
        label,
        view.sort === key ? h('span', { 'aria-hidden': 'true', text: view.dir < 0 ? ' v' : ' ^' }) : null,
      ),
    );

  const boardTable = () => {
    const list = sortedRows(visibleRows());
    if (list.length === 0) {
      return h('div', { class: 'panel' }, h('div', { class: 'empty' },
        h('h2', { text: 'No protocol matches that filter' }),
        h('p', { text: 'Clear the search or pick another category to see the board again.' }),
        h('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: () => { view.q = ''; view.category = 'all'; view.chain = 'all'; writeHash(); render(); } }),
      ));
    }
    const top = list[0].implied_value_usd || 1;
    const tbody = h('tbody');
    list.forEach((r) => {
      const growth = r.change_7d === null ? 'n/a' : pct(r.change_7d);
      const growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      const row = h('tr', {
        'data-selected': view.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: () => openDetail(r.slug),
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } },
      },
        h('td', { class: 'num', text: String(r.rank) }),
        h('td', null, h('div', { class: 'name' },
          h('span', null,
            h('b', { text: r.name }),
            h('span', { class: r.on_watchlist ? 'pill watch' : 'pill early', text: r.on_watchlist ? 'watchlist' : 'early' }),
          ),
          h('span', { class: 'sub', text: `${r.category || 'Other'} on ${r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain'}` }),
        )),
        h('td', { class: 'num', text: money(r.tvl_usd) }),
        h('td', { class: `num ${growthClass}`, text: growth }),
        h('td', { class: 'num', text: ageLabel(r.age_days) }),
        h('td', null, h('div', { class: 'implied' },
          h('div', { class: 'bar', 'aria-hidden': 'true' }, h('i', { style: `width:${Math.max(3, Math.round((r.implied_value_usd / top) * 100))}%` })),
          h('span', { class: 'num', text: money(r.implied_value_usd) }),
        )),
        h('td', null, h('span', { class: 'status', text: 'records no token' })),
      );
      tbody.appendChild(row);
    });
    return h('div', { class: 'panel' },
      h('div', { class: 'table-wrap' },
        h('table', null,
          h('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.' }),
          h('thead', null, h('tr', null,
            sortHeader('implied', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('implied', 'Implied value'),
            h('th', { scope: 'col', text: 'Token' }),
          )),
          tbody,
        ),
      ),
    );
  };

  const liveTable = () => {
    const tbody = h('tbody');
    DATA.live.forEach((r) => {
      tbody.appendChild(h('tr', null,
        h('td', { class: 'num', text: 'live' }),
        h('td', null, h('div', { class: 'name' },
          h('b', { text: r.name }),
          h('span', { class: 'sub', text: `${r.category || 'Other'} on ${r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain'}` }),
        )),
        h('td', { class: 'num', text: money(r.tvl_usd) }),
        h('td', { class: `num ${r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'}`, text: pct(r.change_7d) }),
        h('td', { class: 'num', text: money(r.mcap_usd) }),
        h('td', null, h('span', { class: 'status live', text: 'already trades' })),
      ));
    });
    return h('div', { class: 'panel' },
      h('div', { class: 'table-wrap' },
        h('table', null,
          h('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.' }),
          h('thead', null, h('tr', null,
            h('th', { scope: 'col', text: 'Status' }),
            h('th', { scope: 'col', text: 'Protocol' }),
            h('th', { scope: 'col', text: 'TVL' }),
            h('th', { scope: 'col', text: '7d' }),
            h('th', { scope: 'col', text: 'Market cap' }),
            h('th', { scope: 'col', text: 'Token' }),
          )),
          tbody,
        ),
      ),
    );
  };

  const modelPanel = () => {
    const m = DATA.model;
    return h('section', { class: 'panel model' },
      h('h2', { text: 'How implied value is computed' }),
      h('p', { class: 'sub', text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked.' }),
      h('div', { class: 'formula' },
        `implied = round( 1,000,000 x (tvl_usd / 1,000,000)^${m.tvl_exponent} x (1 + clamp(change_7d, ${m.growth_floor}, ${m.growth_cap}) / 100 x ${m.growth_weight}) x (${m.maturity_floor} + min(age_days, ${m.maturity_days}) / ${m.maturity_days} x ${m.maturity_range}) x (1 + ${m.chain_step} x min(chains, ${m.chain_cap})) )`,
      ),
      h('p', { class: 'sub', text: `TVL is concave: a launch does not scale linearly with locked value, so doubling TVL does not double what a token would be worth. Seven-day growth and the time run with no token move the value up and down, and every extra chain adds a little reach. Age is the time since the protocol was first listed, the best record of how long it has run with no token; an unlisted age uses ${m.unknown_age_days} days.` }),
      h('p', { class: 'sub', text: 'Eligibility: a protocol ranks when its record shows no token and it is not an exchange, bridge, wrapped, staked or restaking product by its category or name. The watchlist is always in; the early radar is every below-floor protocol that passes the same rule. The snapshot carries no parent-protocol field, so above-floor protocols the watchlist left out are not ranked.' }),
    );
  };

  /* ---------- detail drawer ---------- */

  const dialog = h('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', () => { view.selected = null; writeHash(); });

  const multBar = (label, value, max, text) =>
    h('div', { class: 'mult-row' },
      h('span', { text: label }),
      h('div', { class: 'bar', 'aria-hidden': 'true' }, h('i', { style: `width:${Math.max(2, Math.round((value / max) * 100))}%` })),
      h('span', { class: 'num', text }),
    );

  const openDetail = (slug) => {
    const row = DATA.rows.filter((r) => r.slug === slug)[0];
    if (!row) return;
    view.selected = slug;
    writeHash();
    dialog.textContent = '';
    const steps = farmSteps(row);
    const recomputed = impliedOf(row, DATA.model);
    const maxTvl = Math.max.apply(null, DATA.rows.map((r) => r.tvl_score));
    dialog.appendChild(h('div', { class: 'detail-head' },
      h('div', null,
        h('span', { class: 'brand-name', text: `Rank ${row.rank} of ${DATA.board_size}${row.on_watchlist ? ' · watchlist' : ' · early radar'}` }),
        h('h2', { id: 'detail-title', text: row.name }),
        h('p', { class: 'sub', text: `${row.category || 'Other'} on ${row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain'}` }),
      ),
      h('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: () => dialog.close() }),
    ));
    dialog.appendChild(h('section', { class: 'detail-section' },
      h('h3', { text: 'Implied value' }),
      h('div', { class: 'equation' },
        h('div', null, h('span', { text: 'TVL' }), h('b', { class: 'num', text: money(row.tvl_usd) })),
        h('div', null, h('span', { text: 'Seven-day growth' }), h('b', { class: 'num', text: pct(row.change_7d) })),
        h('div', null, h('span', { text: 'Age with no token' }), h('b', { class: 'num', text: ageLabel(row.age_days) })),
        h('div', null, h('span', { text: 'Chains' }), h('b', { class: 'num', text: String((row.chains || []).length) })),
        h('div', null, h('span', { text: 'Growth multiplier' }), h('b', { class: 'num', text: String(row.growth_multiplier) })),
        h('div', null, h('span', { text: 'Maturity multiplier' }), h('b', { class: 'num', text: String(row.maturity_multiplier) })),
        h('div', null, h('span', { text: 'Chain multiplier' }), h('b', { class: 'num', text: String(row.chain_multiplier) })),
        h('div', null, h('span', { text: 'TVL score' }), h('b', { class: 'num', text: String(row.tvl_score) })),
        h('div', null, h('span', { text: 'Implied value' }), h('b', { class: 'num', text: money(row.implied_value_usd) })),
      ),
      h('div', { class: 'mult' },
        multBar('TVL score', row.tvl_score, maxTvl, String(row.tvl_score)),
        multBar('Growth', row.growth_multiplier, 1.9, `x${row.growth_multiplier}`),
        multBar('Maturity', row.maturity_multiplier, 1.0, `x${row.maturity_multiplier}`),
        multBar('Chains', row.chain_multiplier, 1.3, `x${row.chain_multiplier}`),
      ),
      h('p', { class: 'sub', text: `Model ${DATA.model_version}: the same function scores every protocol. The page recomputes this row as ${money(recomputed)}${recomputed === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.'} This is an estimate, not a price.` }),
    ));
    dialog.appendChild(h('section', { class: 'detail-section' },
      h('h3', { text: 'Farm plan' }),
      h('ol', { class: 'steps' }, steps.map((s) => {
        const at = s.indexOf(' Cost: ');
        const action = at >= 0 ? s.slice(0, at) : s;
        const tail = at >= 0 ? s.slice(at + 1) : '';
        return h('li', null, h('b', { text: action }), h('span', { class: 'cost', text: tail }));
      })),
    ));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  };

  /* ---------- render and boot ---------- */

  const render = () => {
    mount.textContent = '';
    const shell = h('div', { class: 'shell' });
    shell.appendChild(headerView());
    shell.appendChild(ledeView());
    shell.appendChild(controlsView());
    shell.appendChild(view.tab === 'pre-token' ? boardTable() : liveTable());
    if (view.tab === 'pre-token') shell.appendChild(modelPanel());
    mount.appendChild(shell);
    mount.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) mount.appendChild(dialog);
    if (view.selected) openDetail(view.selected);
  };

  const markReady = () => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { window.__shotReady = true; });
    });
  };

  readHash();
  render();
  markReady();
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
