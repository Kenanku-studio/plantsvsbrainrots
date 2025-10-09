;(function(){
  const cfg = window.PVBR_CONFIG || {}
  const $ = (sel) => document.querySelector(sel)
  const $$ = (sel) => Array.from(document.querySelectorAll(sel))

  const els = {
    list: $('#list'),
    seedsList: $('#seedsList'),
    gearList: $('#gearList'),
    seedsSection: $('#seedsSection'),
    gearSection: $('#gearSection'),
    status: $('#status'),
    countdownTime: $('#countdownTime'),
    liveStockBtn: $('#liveStockBtn'),
    lastSeenTable: $('#lastSeenTable'),
    seedsLastSeenTable: $('#seedsLastSeenTable'),
    gearLastSeenTable: $('#gearLastSeenTable'),
    seedsLastSeenSection: $('#seedsLastSeenSection'),
    gearLastSeenSection: $('#gearLastSeenSection'),
    alertsSelect: $('#alertsSelect'),
    addAlertBtn: $('#addAlertBtn'),
    alertsList: $('#alertsList'),
  }

  let data = null
  let ascending = true // kept for potential future use

  let lastUpdatedAt = 0
  let countdownInterval = null
  let countdownSeconds = 300 // 5 minutes
  const COUNTDOWN_KEY = 'pvbr_last_update'
  const LAST_SEEN_KEY = 'pvbr_last_seen_v1'
  const ALERTS_WATCH_KEY = 'pvbr_alerts_watchlist_v1'
  const ALERTS_STATE_KEY = 'pvbr_alerts_last_state_v1'

  // Last-seen persistence
  let lastSeenMap = {}
  
  function loadLastSeen(){
    try {
      const raw = localStorage.getItem(LAST_SEEN_KEY)
      lastSeenMap = raw ? JSON.parse(raw) || {} : {}
    } catch(e){
      console.warn('[PVBR] Failed to load last-seen map', e)
      lastSeenMap = {}
    }
  }
  
  function saveLastSeen(){
    try {
      localStorage.setItem(LAST_SEEN_KEY, JSON.stringify(lastSeenMap))
    } catch(e){
      console.warn('[PVBR] Failed to save last-seen map', e)
    }
  }
  function stableIdForName(name){
    const base = (name || '').toLowerCase().trim()
    if (!base) return ''
    
    // Determine category based on name
    let category = 'seed'
    let cleanName = base
    
    // Check if it's a gear item (no "seed" suffix)
    if (!base.endsWith(' seed')) {
      // Check if it's a known gear item (only true gear items)
      const gearItems = ['banana gun', 'frost grenade', 'water bucket', 'frost blower', 'carrot launcher']
      if (gearItems.some(gear => base.includes(gear))) {
        category = 'gear'
        cleanName = base
      } else {
        // Assume it's a seed and add suffix
        cleanName = base + ' seed'
      }
    } else {
      // Remove "seed" suffix for ID generation
      cleanName = base.replace(/\s+seed$/, '')
    }
    
    return `${category}-${cleanName.replace(/\s+/g,'-')}`
  }
  function titleCaseWords(s){
    return (s||'').split(' ').map(w=> w ? (w[0].toUpperCase()+w.slice(1)) : '').join(' ')
  }
  function migrateLastSeenKeys(){
    const migrated = {}
    for (const [k, v] of Object.entries(lastSeenMap)){
      const obj = typeof v === 'number' ? { ts: v, name: undefined } : v
      const guessedName = obj.name || k.replace(/^seed-/, '').replace(/-/g,' ')
      const stId = stableIdForName(guessedName)
      if (!stId) continue
      if (!migrated[stId] || (obj.ts || 0) > (migrated[stId]?.ts || 0)){
        migrated[stId] = { ts: obj.ts || 0, name: obj.name || titleCaseWords(guessedName) }
      }
    }
    lastSeenMap = migrated
    saveLastSeen()
  }
  function updateLastSeen(itemId, whenMs, displayName){
    const stableId = itemId || stableIdForName(displayName)
    if(!stableId) return
    const ts = typeof whenMs === 'number' ? whenMs : Date.now()
    const prev = lastSeenMap[stableId]
    const prevTs = typeof prev === 'number' ? prev : (prev?.ts ?? 0)
    if (!prev || ts > prevTs){
      lastSeenMap[stableId] = { ts, name: displayName }
      saveLastSeen()
    }
  }

  // Alerts: watchlist and last-known availability state
  let alertsWatch = {} // { [itemId]: { id, name } }
  let alertsLastState = {} // { [itemId]: boolean }

  function loadAlerts(){
    try {
      const w = localStorage.getItem(ALERTS_WATCH_KEY)
      alertsWatch = w ? (JSON.parse(w) || {}) : {}
    } catch(e){ alertsWatch = {} }
    try {
      const s = localStorage.getItem(ALERTS_STATE_KEY)
      alertsLastState = s ? (JSON.parse(s) || {}) : {}
    } catch(e){ alertsLastState = {} }
  }
  function saveAlerts(){
    try { localStorage.setItem(ALERTS_WATCH_KEY, JSON.stringify(alertsWatch)) } catch(e){}
  }
  function saveAlertsState(){
    try { localStorage.setItem(ALERTS_STATE_KEY, JSON.stringify(alertsLastState)) } catch(e){}
  }

  function addWatched(item){
    if(!item || !item.id) return
    alertsWatch[item.id] = { id: item.id, name: item.name }
    saveAlerts()
    // Initialize last state to current availability to avoid immediate alarm on add
    alertsLastState[item.id] = isInStock(item)
    saveAlertsState()
  }
  function removeWatched(itemId){
    if(!itemId) return
    delete alertsWatch[itemId]
    saveAlerts()
    delete alertsLastState[itemId]
    saveAlertsState()
  }

  function updateAlertsDropdown(items){
    if(!els.alertsSelect) return
    const select = els.alertsSelect
    const currentValue = select.value
    // Build options from current items, grouped by category label
    const groups = { seed: [], gear: [] }
    for(const it of items){
      groups[it.category === 'gear' ? 'gear' : 'seed'].push(it)
    }
    select.innerHTML = ''
    const placeholder = document.createElement('option')
    placeholder.value = ''
    placeholder.textContent = 'Select item to watch…'
    select.appendChild(placeholder)
    for(const cat of ['seed','gear']){
      if(groups[cat].length === 0) continue
      const optgroup = document.createElement('optgroup')
      optgroup.label = cat === 'seed' ? 'Seeds' : 'Gear'
      groups[cat].forEach(it => {
        const opt = document.createElement('option')
        opt.value = it.id
        opt.textContent = it.name
        select.appendChild(opt)
      })
    }
    // Restore selection if still present
    if(currentValue && Array.from(select.options).some(o=>o.value===currentValue)){
      select.value = currentValue
    }
  }

  function renderAlertsList(items){
    if(!els.alertsList) return
    const container = els.alertsList
    const byId = {}
    for(const it of items){ byId[it.id] = it }
    const watched = Object.values(alertsWatch)
    if(watched.length === 0){
      container.innerHTML = '<div class="muted">No watched items yet.</div>'
      return
    }
    container.innerHTML = ''
    const ul = document.createElement('ul')
    ul.style.listStyle = 'none'
    ul.style.padding = '0'
    for(const w of watched){
      const li = document.createElement('li')
      li.style.display = 'flex'
      li.style.justifyContent = 'space-between'
      li.style.alignItems = 'center'
      li.style.margin = '4px 0'
      const name = document.createElement('span')
      name.textContent = w.name || w.id
      const btn = document.createElement('button')
      btn.textContent = 'Remove'
      btn.addEventListener('click', ()=>{
        removeWatched(w.id)
        renderAlertsList(items)
      })
      li.appendChild(name)
      li.appendChild(btn)
      ul.appendChild(li)
    }
    container.appendChild(ul)
  }

  async function playAlarmNTimes(times){
    const maxTimes = Math.max(1, Math.min(10, times|0))
    let count = 0
    return new Promise((resolve)=>{
      const audio = new Audio('./alarm.mp3')
      audio.volume = 1.0
      const playNext = ()=>{
        if(count >= maxTimes){ resolve(); return }
        count++
        // Safety stop after 6s in case metadata/duration issues
        let guard = setTimeout(()=>{ try{ audio.pause() }catch(e){} }, 6000)
        audio.currentTime = 0
        audio.play().catch(()=>{ /* ignore play errors (autoplay policies) */ }).finally(()=>{
          audio.onended = ()=>{
            clearTimeout(guard)
            playNext()
          }
        })
      }
      playNext()
    })
  }

  function checkAlerts(items){
    const watchedIds = Object.keys(alertsWatch)
    if(watchedIds.length === 0) return
    // Map items by id for quick lookup
    const byId = {}
    for(const it of items){ byId[it.id] = it }
    for(const id of watchedIds){
      const it = byId[id]
      if(!it) continue
      const nowAvail = isInStock(it)
      const prev = !!alertsLastState[id]
      if(!prev && nowAvail){
        // Flip: became available
        playAlarmNTimes(5)
      }
      alertsLastState[id] = nowAvail
    }
    saveAlertsState()
  }
  function isInStock(item){
    const stock = typeof item.currentStock === 'number' ? item.currentStock : (item.stock ?? 0)
    const available = typeof item.available === 'boolean' ? item.available : (stock > 0)
    return available || stock > 0
  }
  function formatAgo(fromMs){
    const now = Date.now()
    const diffSec = Math.max(0, Math.floor((now - fromMs)/1000))
    if(diffSec < 60) return diffSec === 0 ? 'a moment ago' : `${diffSec}s ago`
    const diffMin = Math.floor(diffSec/60)
    if(diffMin < 60) return diffMin === 1 ? '1 min ago' : `${diffMin} min ago`
    const diffH = Math.floor(diffMin/60)
    if(diffH < 24) return diffH === 1 ? '1h ago' : `${diffH}h ago`
    const diffD = Math.floor(diffH/24)
    return diffD === 1 ? '1 day ago' : `${diffD} days ago`
  }

  // No more static items - all data comes from Discord bot

  // Canonical pricing/rarity map (USD and Robux)
  const PRICING_MAP = {
    'tomatrio seed': { price: 125_000_000, robux: 749, rarity: 'secret' },
    'mango seed': { price: 357_000_000, robux: 949, rarity: 'secret' },
    'mr carrot seed': { price: 50_000_000, robux: 699, rarity: 'secret' },
    'carnivorous plant seed': { price: 25_000_000, robux: 549, rarity: 'godly' },
    'cocotank seed': { price: 5_000_000, robux: 349, rarity: 'godly' },
    'watermelon seed': { price: 1_000_000, robux: 179, rarity: 'mythic' },
    'eggplant seed': { price: 250_000, robux: 99, rarity: 'rare' },
    'dragon fruit seed': { price: 100_000, robux: 49, rarity: 'rare' },
    'sunflower seed': { price: 25_000, robux: 29, rarity: 'epic' },
    'pumpkin seed': { price: 5_000, robux: 17, rarity: 'epic' },
    'strawberry seed': { price: 1_250, robux: 10, rarity: 'rare' },
    'cactus seed': { price: 200, robux: 5, rarity: 'rare' },
  }

  // Format price for display
  function formatPrice(price) {
    if (price >= 1_000_000) {
      return `${(price / 1_000_000).toFixed(0)}m`;
    } else if (price >= 100_000) {
      return `${(price / 1_000).toFixed(0)}k`;
    } else {
      return price.toLocaleString();
    }
  }

  // Estimate price based on seed name
  function estimatePrice(name) {
    const nameLower = name.toLowerCase();
    if (nameLower.includes('pumpkin')) return 5000;
    if (nameLower.includes('eggplant')) return 3000;
    if (nameLower.includes('sunflower')) return 1000;
    return 500; // Default price
  }

  // Get rarity from seed name
  function getRarityFromName(name) {
    const nameLower = name.toLowerCase();
    
    // Check PRICING_MAP first
    const pricing = PRICING_MAP[nameLower];
    if (pricing) {
      return pricing.rarity;
    }
    
    // Gear items
    if (nameLower.includes('carrot launcher')) return 'godly';
    if (nameLower.includes('frost blower')) return 'legendary';
    if (nameLower.includes('banana gun')) return 'epic';
    if (nameLower.includes('frost grenade')) return 'epic';
    if (nameLower.includes('water bucket')) return 'epic';
    
    // Seed items
    if (nameLower.includes('pumpkin')) return 'epic';
    if (nameLower.includes('eggplant')) return 'rare';
    if (nameLower.includes('sunflower')) return 'epic';
    if (nameLower.includes('strawberry')) return 'rare';
    if (nameLower.includes('cactus')) return 'rare';
    if (nameLower.includes('dragon fruit')) return 'rare';
    return 'common'; // Default rarity
  }

  // Get price from seed name
  function getPriceFromName(name) {
    const nameLower = name.toLowerCase();
    
    // Check PRICING_MAP first
    const pricing = PRICING_MAP[nameLower];
    if (pricing) {
      return pricing.price;
    }
    
    // Gear items
    if (nameLower.includes('water bucket')) return 7500;
    if (nameLower.includes('frost grenade')) return 12500;
    if (nameLower.includes('banana gun')) return 25000;
    if (nameLower.includes('frost blower')) return 125000;
    if (nameLower.includes('carrot launcher')) return 500000;
    
    // Seed items
    if (nameLower.includes('pumpkin')) return 5000;
    if (nameLower.includes('eggplant')) return 3000;
    if (nameLower.includes('sunflower')) return 25000;
    if (nameLower.includes('strawberry')) return 1250;
    if (nameLower.includes('cactus')) return 200;
    if (nameLower.includes('dragon fruit')) return 100000;
    return 500; // Default price
  }

  // Get Robux price from item name
  function getRobuxFromName(name) {
    const nameLower = name.toLowerCase();
    
    // Gear items
    if (nameLower.includes('water bucket')) return 34;
    if (nameLower.includes('frost grenade')) return 54;
    if (nameLower.includes('banana gun')) return 84;
    if (nameLower.includes('frost blower')) return 189;
    if (nameLower.includes('carrot launcher')) return 399;
    
    // For other items, calculate based on price
    const price = getPriceFromName(name);
    return Math.max(1, Math.round(price / 125));
  }

  // Normalize item name and category to avoid duplicate "Seed" suffixes and misclassified gear
  function normalizeName(name, category){
    const raw = String(name || '')
      .replace(/^\s*[•\-]+\s*/, '')
      .replace(/^(<:[^:]+:\d+>|[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji}\u200d\ufe0f])+\s*/gu, '')
      .trim()
    // Detect gear by keywords if not explicitly marked
    const isGearLike = /\b(gun|grenade|bucket|blower|launcher)\b/i.test(raw)
    let cat = category || (isGearLike ? 'gear' : 'seed')
    let display = raw
    if (cat === 'gear') {
      // Remove accidental Seed suffix on gear
      display = display.replace(/\s+seed$/i, '')
    } else {
      // Standardize single Seed suffix for seeds
      display = display.replace(/\s+seed\s+seed$/i, ' Seed')
      display = display.replace(/\s+seed$/i, ' Seed')
      if (!/\bseed\b$/i.test(display)) {
        display = display + ' Seed'
      }
      // Ensure canonical capitalization
      display = display.replace(/\s+seed$/i, ' Seed')
    }
    return { name: display, category: cat }
  }

  // Parse new Vulcan text format (Seeds/Gear lines with emojis and xN)
  function parseVulcanTextFormat(rawText){
    try {
      const lines = String(rawText || '').split(/\r?\n/).map(l=>l.trim()).filter(l=>l.length>0)
      let section = null // 'seed' | 'gear'
      /** @type {Array<any>} */
      const items = []
      const itemLineRe = /^:([^:]+):\s*(.+?)\s*x(\d+)$/i
      for(const line of lines){
        const upper = line.toUpperCase()
        if(upper === 'SEEDS'){ section = 'seed'; continue }
        if(upper === 'GEAR'){ section = 'gear'; continue }
        if(!section) continue
        const m = line.match(itemLineRe)
        if(!m) continue
        const rawName = m[2].replace(/\s+/g,' ').trim()
        const qty = Math.max(0, parseInt(m[3], 10) || 0)
        let displayName = rawName
        if(section === 'seed' && !/\bseed\b/i.test(displayName)){
          displayName = displayName + ' Seed'
        }
        const category = section
        const id = `${category}-${displayName.toLowerCase().replace(/\s+/g,'-')}`
        items.push({
          id,
          name: displayName,
          rarity: getRarityFromName(displayName),
          category,
          currentPrice: getPriceFromName(displayName),
          currentRobux: getRobuxFromName(displayName),
          currentStock: qty,
          available: qty > 0,
        })
      }
      return { items, updatedAt: Date.now() }
    } catch(e){
      console.warn('[PVBR] parseVulcanTextFormat error', e)
      return { items: [], updatedAt: Date.now() }
    }
  }

  // WebSocket connection for real-time updates
  let websocket = null;
  let reconnectAttempts = 0;
  const maxReconnectAttempts = 5;

  function connectWebSocket() {
    if (!cfg.WEBSOCKET_URL || cfg.WEBSOCKET_URL.trim().length === 0) {
      console.log('[PVBR] WebSocket disabled, using polling only');
      return;
    }

    // console.log('[PVBR] Connecting to WebSocket:', cfg.WEBSOCKET_URL);
    
    try {
      // console.log('[PVBR] Attempting WebSocket connection to:', cfg.WEBSOCKET_URL);
      websocket = new WebSocket(cfg.WEBSOCKET_URL);
      
      websocket.onopen = function() {
        // console.log('[PVBR] WebSocket connected successfully');
        reconnectAttempts = 0;
      };
      
      websocket.onmessage = function(event) {
        try {
          const data = JSON.parse(event.data);
          // console.log('[PVBR][WS] message parsed', { keys: Object.keys(data||{}), isArray: Array.isArray(data) })
          // Handle PVBR updates specifically (JSON payload)
          if (data.type === 'pvbr_update' && data.data) {
            // console.log('[PVBR][WS] pvbr_update received', { count: Array.isArray(data.data) ? data.data.length : 0 })
            const mappedItems = data.data.map(item => {
              const norm = normalizeName(item.name, item.type || 'seed')
              const itemId = `${norm.category}-${norm.name.toLowerCase().replace(/\s+/g, '-')}`
              return {
                id: itemId,
                name: norm.name,
                rarity: getRarityFromName(norm.name),
                category: norm.category,
                currentPrice: getPriceFromName(norm.name),
                currentRobux: getRobuxFromName(norm.name),
                currentStock: item.stock,
                available: item.available,
                emoji: item.emoji || (norm.category === 'seed' ? '🌱' : '⚙️'),
                lastUpdated: item.lastUpdated
              };
            });
            
            
            // Only overwrite if we have items; avoid clearing UI on empty payloads
            if (Array.isArray(mappedItems) && mappedItems.length > 0) {
              // console.log('[PVBR][WS] applying mappedItems', { count: mappedItems.length })
              window.pvbrItems = mappedItems;
              // Render the items
              render();
            } else {
              // console.log('[PVBR][WS] skip apply (empty mappedItems) – keeping current items')
            }
            lastUpdatedAt = Date.now();
            
            // Reset countdown when new data arrives
            resetCountdown();
          }
          // Handle general stock updates (treat payload as items list)
          else if (data.type === 'stock_update' && data.data) {
            const raw = Array.isArray(data.data) ? data.data : []
            // console.log('[PVBR][WS] stock_update received', { count: raw.length })
            const mapped = raw.map((item)=>{
              const norm = normalizeName(item.name, item.type || item.category || 'seed')
              return {
                id: `${norm.category}-${norm.name.toLowerCase().replace(/\s+/g,'-')}`,
                name: norm.name,
                rarity: getRarityFromName(norm.name),
                category: norm.category,
                currentPrice: getPriceFromName(norm.name),
                currentRobux: getRobuxFromName(norm.name),
                currentStock: Number(item.stock || item.quantity || 0),
                available: Boolean(item.available ?? (Number(item.stock||0) > 0)),
                lastUpdated: item.lastUpdated
              }
            })
            if (mapped.length > 0){
              console.log('[PVBR][WS] applying stock_update mapped', { count: mapped.length })
              window.pvbrItems = mapped
              render()
              lastUpdatedAt = Date.now()
              resetCountdown()
            } else {
              // console.log('[PVBR][WS] skip stock_update apply (empty) – keeping current items')
            }
          }
          // Handle direct array from bot (no wrapper object)
          else if (Array.isArray(data)) {
            // console.log('[PVBR][WS] array payload received', { count: data.length })
            const mapped = data.map((item)=>{
              const norm = normalizeName(item.name, item.type || item.category || 'seed')
              return {
                id: `${norm.category}-${norm.name.toLowerCase().replace(/\s+/g,'-')}`,
                name: norm.name,
                rarity: getRarityFromName(norm.name),
                category: norm.category,
                currentPrice: getPriceFromName(norm.name),
                currentRobux: getRobuxFromName(norm.name),
                currentStock: Number(item.stock || item.quantity || 0),
                available: Boolean(item.available ?? (Number(item.stock||0) > 0)),
                lastUpdated: item.lastUpdated
              }
            })
            if (mapped.length > 0){
              console.log('[PVBR][WS] applying array payload', { count: mapped.length })
              window.pvbrItems = mapped
              render()
              lastUpdatedAt = Date.now()
              resetCountdown()
            } else {
              // console.log('[PVBR][WS] skip array apply (empty) – keeping current items')
            }
          }
        } catch (error) {
          // Try parsing as plain-text Vulcan format
          try {
            const txt = String(event.data || '')
            if(/\bSeeds\b/i.test(txt) && /\bGear\b/i.test(txt)){
              const parsed = parseVulcanTextFormat(txt)
              // console.log('[PVBR][WS] text payload parsed', { count: parsed.items.length })
              if (Array.isArray(parsed.items) && parsed.items.length > 0) {
                // console.log('[PVBR][WS] applying text payload', { count: parsed.items.length })
                window.pvbrItems = parsed.items
                render()
              } else {
                // console.log('[PVBR][WS] skip text apply (empty) – keeping current items')
              }
              lastUpdatedAt = parsed.updatedAt
              resetCountdown()
              return
            }
          } catch(e2){ /* swallow */ }
          console.error('[PVBR] WebSocket message parse error:', error);
        }
      };
      
      websocket.onclose = function(event) {
        // console.log('[PVBR] WebSocket closed:', event.code, event.reason, 'clean:', event.wasClean);
        websocket = null;
        
        // Auto-reconnect with exponential backoff
        if (reconnectAttempts < maxReconnectAttempts) {
          const delay = Math.pow(2, reconnectAttempts) * 1000; // 1s, 2s, 4s, 8s, 16s
          // console.log(`[PVBR] Reconnecting in ${delay}ms (attempt ${reconnectAttempts + 1}/${maxReconnectAttempts})`);
          setTimeout(connectWebSocket, delay);
          reconnectAttempts++;
        } else {
          // console.log('[PVBR] Max reconnection attempts reached, falling back to polling');
          // Start polling as fallback
          setInterval(fetchStock, 10000); // Poll every 10 seconds
        }
      };
      
      websocket.onerror = function(error) {
        console.error('[PVBR] WebSocket error:', error);
        // console.log('[PVBR] WebSocket state:', websocket?.readyState, 'URL:', cfg.WEBSOCKET_URL);
      };
      
    } catch (error) {
      console.error('[PVBR] WebSocket connection error:', error);
      // console.log('[PVBR] WebSocket failed, falling back to polling');
      // Start polling as fallback
      setInterval(fetchStock, 10000); // Poll every 10 seconds
    }
  }

  // Fallback polling if WebSocket fails
  async function fetchStock(){
    const baseUrl = cfg.STOCK_URL && cfg.STOCK_URL.trim().length > 0 ? cfg.STOCK_URL : cfg.FALLBACK_JSON
    const url = baseUrl + (baseUrl.includes('?') ? `&` : `?`) + `since=${lastUpdatedAt}`
    try {
      const res = await fetch(url, { 
        cache: 'no-store',
        headers: {
          'User-Agent': 'PlantsVsBrainrotsTracker/1.0 (Browser)',
          'Referer': window.location.origin
        }
      })
      if(res.status === 204){
        // no changes
        return
      }
      if(!res.ok) throw new Error('HTTP '+res.status)
      let json
      let textFallback = null
      try {
        json = await res.json()
      } catch(e){
        // Not JSON; try text and parse Vulcan format
        textFallback = await res.text()
      }
      // console.log('[PVBR] Raw API response:', json)
      
      // normalize format: support multiple formats
      let items = []
      let updatedAt = Date.now()
      
      if (json && Array.isArray(json?.items)) {
        // Format: {items: [], updatedAt: ...}
        items = json.items
        updatedAt = json.updatedAt || Date.now()
      } else if (json && Array.isArray(json?.payload?.items)) {
        // Format: {payload: {items: []}, updatedAt: ...}
        items = json.payload.items
        updatedAt = json.updatedAt || Date.now()
      } else if (json && Array.isArray(json?.data)) {
        // Format: {data: [], timestamp: ...} - Discord bot format
        // console.log('[PVBR][API] Parsing Discord bot format', { count: json.data.length, ts: json.timestamp })
        items = json.data.map(item => {
          // Smart detection: override type based on item name
          let category = item.type || 'seed'
          
          // Known gear items (always gear regardless of type)
          const gearItems = ['banana gun', 'frost grenade', 'water bucket', 'frost blower', 'carrot launcher']
          const isGearItem = gearItems.some(gear => 
            item.name.toLowerCase().includes(gear.toLowerCase())
          )
          
          if (isGearItem) {
            category = 'gear'
            console.log(`🔧 Frontend override: ${item.name} detected as GEAR item`)
          }
          
          let displayName = String(item.name)
            .replace(/^\s*[•\-]+\s*/, '')
            .replace(/^(<:[^:]+:\d+>|[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji}\u200d\ufe0f])+\s*/gu, '')
            .trim()
          
          // For seeds, add suffix only if missing (case-insensitive)
          if (category === 'seed' && !/\bseed\b$/i.test(displayName)) {
            displayName = `${displayName} Seed`
          }
          // For gear, keep original name (no suffix)
          
          return {
            id: `${category}-${item.name.toLowerCase().replace(/\s+/g, '-')}`,
            name: displayName,
            rarity: getRarityFromName(displayName),
            category: category,
            currentPrice: getPriceFromName(displayName),
            currentRobux: getRobuxFromName(displayName),
            currentStock: item.stock,
            available: item.available,
            emoji: item.emoji || (category === 'seed' ? '🌱' : '⚙️'),
            lastUpdated: item.lastUpdated
          }
        })
        updatedAt = new Date(json.timestamp).getTime() || Date.now()
        // console.log('[PVBR][API] Mapped items count', items.length)
      } else if (json && (json?.seeds || json?.gear)) {
        // New Discord bot format with separate sections
        items = []
        
        // Parse Seeds section
        if (json.seeds && Array.isArray(json.seeds)) {
          const seedItems = json.seeds.map(seed => {
            const baseName = String(seed.name)
              .replace(/^\s*[•\-]+\s*/, '')
              .replace(/^(<:[^:]+:\d+>|[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji}\u200d\ufe0f])+\s*/gu, '')
              .trim()
            const hasSeedSuffix = /\bseed\b$/i.test(baseName)
            const displayName = hasSeedSuffix ? baseName.replace(/\s+seed$/i, ' Seed') : `${baseName} Seed`
            return {
              id: `seed-${displayName.toLowerCase().replace(/\s+/g, '-')}`,
              name: displayName,
              rarity: getRarityFromName(displayName),
              category: 'seed',
              currentPrice: getPriceFromName(displayName),
              currentStock: seed.stock || seed.quantity || 0,
              available: true
            }
          })
          items.push(...seedItems)
        }
        
        // Parse Gear section
        if (json.gear && Array.isArray(json.gear)) {
          const gearItems = json.gear.map(gear => ({
            id: `gear-${gear.name.toLowerCase().replace(/\s+/g, '-')}`,
            name: String(gear.name).replace(/^\s*[•\-]+\s*/, '').replace(/^(<:[^:]+:\d+>|[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji}\u200d\ufe0f])+\s*/gu, '').trim(),
            rarity: 'common', // Default for gear
            category: 'gear',
            currentPrice: estimatePrice(gear.name),
            currentStock: gear.stock || gear.quantity || 0,
            available: true
          }))
          items.push(...gearItems)
        }
        // If upstream payload already includes a combined list in json.items, prefer it only if non-empty
        if (Array.isArray(json.items) && json.items.length > 0) {
          items = json.items
        }
        updatedAt = Date.now()
      } else if (textFallback) {
        // Plain text from Vulcan Live Stock Bot
        const parsed = parseVulcanTextFormat(textFallback)
        // Normalize names once again defensively
        items = parsed.items.map(it=>{
          const norm = normalizeName(it.name, it.category)
          return { ...it, name: norm.name, category: norm.category, id: `${norm.category}-${norm.name.toLowerCase().replace(/\s+/g,'-')}` }
        })
        updatedAt = parsed.updatedAt
      } else {
        // Fallback: try to extract items from any array property
        // console.warn('[PVBR][API] Unknown data format; available keys:', Object.keys(json || {}))
        items = []
      }
      
      // Enrich with canonical pricing if available
      const enriched = items.map((it) => {
        const key = (it.name || '').toLowerCase()
        const pricing = PRICING_MAP[key]
        if (pricing) {
          return {
            ...it,
            rarity: (pricing.rarity || it.rarity || 'common').toLowerCase(),
            currentPrice: pricing.price,
            currentRobux: pricing.robux,
          }
        }
        return { ...it, currentRobux: it.currentRobux || Math.max(1, Math.round((it.currentPrice || estimatePrice(it.name))/125)) }
      })

      // No more static items injection

      const normalized = { updatedAt, items: enriched }
      
      // console.log('[PVBR] fetchStock ok', { 
      //   url, 
      //   count: normalized.items.length, 
      //   updatedAt: normalized.updatedAt,
      //   items: normalized.items,
      //   rawJson: json,
      //   itemsType: typeof normalized.items,
      //   isArray: Array.isArray(normalized.items)
      // })
      
      // Only replace data when items are present; otherwise keep current and just update timestamps
      if (Array.isArray(normalized.items) && normalized.items.length > 0) {
        data = normalized
        lastUpdatedAt = normalized.updatedAt
        // console.log('[PVBR][API] applying normalized items', { count: normalized.items.length })
        render()
      } else {
        // No items in update; keep existing 'data' but refresh timestamp display if any
        // console.log('[PVBR][API] empty normalized items – keeping current data')
        lastUpdatedAt = normalized.updatedAt
      }
      els.status.textContent = 'Last update: ' + new Date(updatedAt).toLocaleTimeString()
    } catch(err){
      console.error('[PVBR] fetchStock error', { url, err })
      els.status.textContent = 'Error fetching data. Checking local copy...'
      if(url !== cfg.FALLBACK_JSON){
        try {
          const res = await fetch(cfg.FALLBACK_JSON)
          data = await res.json()
          console.log('[PVBR] fallback loaded', { count: data.items?.length })
          render()
        } catch(e){ console.error('[PVBR] fallback error', e) }
      }
    }
  }

function filtered(){
  // Prefer WebSocket data only if it has items; else fallback to API data
  if (window.pvbrItems && Array.isArray(window.pvbrItems) && window.pvbrItems.length > 0) {
    // console.log('[PVBR][FILTERED] using WS data', { count: window.pvbrItems.length })
    return window.pvbrItems
  }
  
  if(!data) {
    // console.log('[PVBR][FILTERED] no data available')
    return []
  }
  // console.log('[PVBR] filtered() - data:', data)
  // console.log('[PVBR] filtered() - data.items:', data.items, 'type:', typeof data.items, 'isArray:', Array.isArray(data.items))
  
  let list = data.items
  
  if (!Array.isArray(list)) {
    console.error('[PVBR] data.items is not an array:', list)
    return []
  }
  
  // console.log('[PVBR][FILTERED] using API data', { count: list.length })
  // API data comes from Discord bot
  return list
}

  function el(tag, cls, children){
    const e = document.createElement(tag)
    if(cls) e.className = cls
    if(children) children.forEach(c => e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c))
    return e
  }

  function render(){
    const items = filtered()
    // console.log('[PVBR][RENDER] filtered() returned', { count: items.length, wsItems: window.pvbrItems?.length, apiData: data?.items?.length })
    
    // Safety check
    if (!Array.isArray(items)) {
      console.error('[PVBR] Items is not an array:', items)
      els.seedsList.innerHTML = '<div class="muted">Error: Invalid data format</div>'
      els.gearList.innerHTML = '<div class="muted">Error: Invalid data format</div>'
      return
    }
    
    // Separate seeds and gear (handle both case variations)
    const seeds = items.filter(item => 
      item.category === 'seed' || 
      item.category === 'SEEDS' || 
      item.type === 'seed'
    )
    const gear = items.filter(item => 
      item.category === 'gear' || 
      item.category === 'GEAR' || 
      item.type === 'gear'
    )
    // console.log('[PVBR][RENDER] after filtering', { seeds: seeds.length, gear: gear.length })
    
    // console.log('[PVBR] Rendering items:', items.length, 'seeds:', seeds.length, 'gear:', gear.length)
    // console.log('[PVBR] Sample items:', items.slice(0, 3).map(item => ({
    //   name: item.name,
    //   category: item.category,
    //   type: item.type
    // })))
    
    // Clear both sections
    els.seedsList.innerHTML = ''
    els.gearList.innerHTML = ''
    
    // Render Seeds section
    if (seeds.length > 0) {
      els.seedsSection.style.display = 'block'
      for(const item of seeds){
        // console.log('[PVBR] Rendering seed:', item.name, item.currentStock)
        const card = createItemCard(item)
        els.seedsList.appendChild(card)
      }
    } else {
      els.seedsSection.style.display = 'none'
    }
    
    // Render Gear section
    if (gear.length > 0) {
      els.gearSection.style.display = 'block'
      for(const item of gear){
        // console.log('[PVBR] Rendering gear:', item.name, item.currentStock)
        const card = createItemCard(item)
        els.gearList.appendChild(card)
      }
    } else {
      els.gearSection.style.display = 'none'
    }
    
    if(items.length === 0){
      els.seedsList.innerHTML = '<div class="muted">Brak wyników.</div>'
      els.gearList.innerHTML = '<div class="muted">Brak wyników.</div>'
    }
    // Refresh last-seen table on each render
    renderLastSeenTable()
    // Alerts UI and detection
    updateAlertsDropdown(items)
    renderAlertsList(items)
    checkAlerts(items)
    // console.log('[PVBR][RENDER] completed render cycle')
  }
  
  function createItemCard(item) {
    // Format price to short version (e.g., $50M instead of $50,000,000)
    function formatPriceShort(price) {
      if (price >= 1_000_000) {
        return `$${(price / 1_000_000).toFixed(0)}M`;
      } else if (price >= 1_000) {
        return `$${(price / 1_000).toFixed(0)}K`;
      } else {
        return `$${price}`;
      }
    }

    // Create card with new modern structure
    const card = el('div', 'item-card', [])
    
    // Create and append image
    const img = document.createElement('img')
    img.className = 'item-image'
    img.src = `./images/${item.name.toLowerCase().replace(/\s+/g, '-')}.webp`
    img.alt = item.name
    img.onerror = function() { this.style.display = 'none' }
    card.appendChild(img)
    
    // Create and append item name
    const nameDiv = document.createElement('div')
    nameDiv.className = 'item-name'
    nameDiv.textContent = item.name
    card.appendChild(nameDiv)
    
    // Create and append rarity badge
    const raritySpan = document.createElement('span')
    raritySpan.className = `item-rarity rarity-${item.rarity.toLowerCase()}`
    raritySpan.textContent = item.rarity.charAt(0).toUpperCase() + item.rarity.slice(1)
    card.appendChild(raritySpan)
    
    // Create item info container (price and stock)
    const itemInfo = document.createElement('div')
    itemInfo.className = 'item-info'
    
    // Price row
    const priceRow = document.createElement('div')
    priceRow.className = 'item-price-row'
    
    const priceLabel = document.createElement('span')
    priceLabel.className = 'price-label'
    priceLabel.textContent = 'Price'
    
    const priceValue = document.createElement('span')
    priceValue.className = 'price-value'
    priceValue.textContent = formatPriceShort(item.currentPrice)
    
    priceRow.appendChild(priceLabel)
    priceRow.appendChild(priceValue)
    itemInfo.appendChild(priceRow)
    
    // Stock row
    const stockRow = document.createElement('div')
    stockRow.className = 'item-stock-row'
    
    const stockLabel = document.createElement('span')
    stockLabel.className = 'stock-label'
    stockLabel.textContent = 'Stock'
    
    const stockValue = document.createElement('span')
    stockValue.className = 'stock-value'
    stockValue.textContent = item.currentStock
    
    stockRow.appendChild(stockLabel)
    stockRow.appendChild(stockValue)
    itemInfo.appendChild(stockRow)
    
    card.appendChild(itemInfo)
    
    // Last seen storage update
    const itemId = stableIdForName(item.name)
    if (isInStock(item)) updateLastSeen(itemId, Date.now(), item.name)
    
    return card
  }

  function attachEvents(){
    // Alerts: add button handler
    if(els.addAlertBtn && els.alertsSelect){
      els.addAlertBtn.addEventListener('click', ()=>{
        const id = els.alertsSelect.value
        if(!id) return
        const items = filtered()
        const item = items.find(it=>it.id===id)
        if(item){
          addWatched(item)
          renderAlertsList(items)
        }
      })
    }
  }

  function start(){
    attachEvents()
    loadLastSeen()
    migrateLastSeenKeys()
    loadAlerts()
    
    // Try WebSocket first, fallback to polling
    // console.log('[PVBR] Attempting WebSocket connection...')
    connectWebSocket()
    
    // Initial data fetch
    fetchStock()
    
    // Start countdown timer
    startCountdown()
    // Last-seen table updates only on data renders
    
    // Live Stock button click handler
    if (els.liveStockBtn) {
      els.liveStockBtn.addEventListener('click', () => {
        fetchStock()
        resetCountdown()
      })
    }
  }

  // Countdown timer functions
  function startCountdown() {
    if (countdownInterval) {
      clearInterval(countdownInterval)
    }
    
    // Check if we have a saved update time
    const savedUpdateTime = localStorage.getItem(COUNTDOWN_KEY)
    if (savedUpdateTime) {
      const lastUpdate = parseInt(savedUpdateTime)
      const now = Date.now()
      const timeSinceUpdate = Math.floor((now - lastUpdate) / 1000)
      
      if (timeSinceUpdate < 300) {
        // Continue countdown from where we left off
        countdownSeconds = 300 - timeSinceUpdate
      } else {
        // More than 5 minutes has passed, reset
        countdownSeconds = 300
        localStorage.setItem(COUNTDOWN_KEY, now.toString())
      }
    } else {
      // No saved time, start fresh
      countdownSeconds = 300
      localStorage.setItem(COUNTDOWN_KEY, Date.now().toString())
    }
    
    countdownInterval = setInterval(() => {
      countdownSeconds--
      updateCountdownDisplay()
      
      if (countdownSeconds <= 0) {
        countdownSeconds = 300 // Reset to 5:00
        localStorage.setItem(COUNTDOWN_KEY, Date.now().toString())
      }
    }, 1000)
    
    updateCountdownDisplay()
  }
  
  function resetCountdown() {
    countdownSeconds = 300 // Reset to 5 minutes
    localStorage.setItem(COUNTDOWN_KEY, Date.now().toString())
    updateCountdownDisplay()
  }
  
  function updateCountdownDisplay() {
    if (!els.countdownTime) return
    
    const minutes = Math.floor(countdownSeconds / 60)
    const seconds = countdownSeconds % 60
    const timeString = `${minutes}:${seconds.toString().padStart(2, '0')}`
    
    els.countdownTime.textContent = timeString
    
    // Change color when under 1 minute
    if (countdownSeconds <= 60) {
      els.countdownTime.style.color = '#ff0000'
    } else {
      els.countdownTime.style.color = 'white'
    }
  }

  function renderLastSeenTable(){
    const items = filtered()
    const currentById = {}
    const seedsRows = []
    const gearRows = []
    
    // Process current items
    for (const item of items){
      const itemId = stableIdForName(item.name)
      currentById[itemId] = true
      const inStock = isInStock(item)
      const saved = lastSeenMap[itemId]
      const lastTs = typeof saved === 'number' ? saved : (saved?.ts)
      const status = inStock ? '<span class="lastseen-badge in">Right now in stock!</span>' : (lastTs ? `Last seen ${formatAgo(lastTs)}` : 'Not seen yet')
      
      const row = { name: item.name, status, sortTs: inStock ? Infinity : (lastTs || 0) }
      
      if (item.category === 'seed') {
        seedsRows.push(row)
      } else if (item.category === 'gear') {
        gearRows.push(row)
      }
    }
    
    // Create a set of current item names for duplicate checking
    const currentItemNames = new Set()
    for (const item of items) {
      currentItemNames.add(item.name)
    }
    
    // Also create a set of current item IDs for better duplicate checking
    const currentItemIds = new Set()
    for (const item of items) {
      const itemId = stableIdForName(item.name)
      currentItemIds.add(itemId)
    }
    
    // Include remembered items not in current stock list
    for (const [rawId, saved] of Object.entries(lastSeenMap)){
      const savedObj = typeof saved === 'number' ? { ts: saved, name: undefined } : saved
      const guessedName = savedObj.name || rawId.replace(/^seed-/, '').replace(/-/g,' ')
      const stId = stableIdForName(guessedName)
      if (currentById[stId]) continue
      
      let displayName = savedObj.name || titleCaseWords(guessedName)
      
      // Determine category based on item name - check if it's gear
      const isGear = rawId.startsWith('gear-') || 
                    displayName.toLowerCase().includes('gun') ||
                    displayName.toLowerCase().includes('grenade') ||
                    displayName.toLowerCase().includes('bucket') ||
                    displayName.toLowerCase().includes('blower') ||
                    displayName.toLowerCase().includes('launcher')
      
      // For gear items, remove "Seed" suffix if present
      if (isGear && displayName.endsWith(' Seed')) {
        displayName = displayName.replace(' Seed', '')
      }
      
      // Skip if this item is currently in stock (to avoid duplicates)
      if (currentItemNames.has(displayName) || currentItemIds.has(stId)) continue
      
      const status = savedObj.ts ? `Last seen ${formatAgo(savedObj.ts)}` : 'Not seen yet'
      const row = { name: displayName, status, sortTs: savedObj.ts || 0 }
      
      // Check for duplicates before adding
      if (isGear) {
        const alreadyExists = gearRows.some(existing => existing.name === displayName)
        if (!alreadyExists) {
          gearRows.push(row)
        }
      } else {
        const alreadyExists = seedsRows.some(existing => existing.name === displayName)
        if (!alreadyExists) {
          seedsRows.push(row)
        }
      }
    }
    
    // Sort both arrays: in-stock first, then by last seen desc
    seedsRows.sort((a,b)=> (b.sortTs - a.sortTs))
    gearRows.sort((a,b)=> (b.sortTs - a.sortTs))
    
    // Render Seeds table
    if (seedsRows.length > 0) {
      els.seedsLastSeenSection.style.display = 'block'
      els.seedsLastSeenTable.innerHTML = `<table class="lastseen-table"><thead><tr><th>Seed</th><th>Rarity</th><th>Price</th><th>Status</th></tr></thead><tbody>${seedsRows.map(r=>{
        const price = getPriceFromName(r.name)
        const rarity = getRarityFromName(r.name)
        return `<tr><td>${r.name}</td><td class="rarity-${rarity}">${rarity.charAt(0).toUpperCase() + rarity.slice(1)}</td><td>$${formatPrice(price)}</td><td>${r.status}</td></tr>`
      }).join('')}</tbody></table>`
    } else {
      els.seedsLastSeenSection.style.display = 'none'
    }
    
    // Render Gear table
    if (gearRows.length > 0) {
      els.gearLastSeenSection.style.display = 'block'
      els.gearLastSeenTable.innerHTML = `<table class="lastseen-table"><thead><tr><th>Gear</th><th>Rarity</th><th>Price</th><th>Status</th></tr></thead><tbody>${gearRows.map(r=>{
        const price = getPriceFromName(r.name)
        const rarity = getRarityFromName(r.name)
        return `<tr><td>${r.name}</td><td class="rarity-${rarity}">${rarity.charAt(0).toUpperCase() + rarity.slice(1)}</td><td>$${formatPrice(price)}</td><td>${r.status}</td></tr>`
      }).join('')}</tbody></table>`
    } else {
      els.gearLastSeenSection.style.display = 'none'
    }
  }

  document.addEventListener('DOMContentLoaded', start)
})();


