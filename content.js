// ============================================================
// Agentank Raid Helper — State-Machine Automation Engine v2.0
// ============================================================
console.log('%c[Raid Helper] v2.0 — State-machine engine loaded.', 'color: #00f2fe; font-weight: bold;');

// ── Constants ────────────────────────────────────────────────
const POLL_FAST   = 1500;   // 1.5s — for menus / modals
const POLL_BATTLE = 4000;   // 4s   — while battle runs
const POLL_SLOW   = 3000;   // 3s   — fallback / unknown
const CLICK_COOLDOWN = 1800;

// Enhancement priority (higher index = lower priority)
// 备用核心 always takes absolute priority and is handled separately
const ENHANCE_PRIORITY = ['自动护盾', '宝物磁场', '技能冷却', '开局推进'];

// ── Game State ───────────────────────────────────────────────
const gameState = {
  currentLayer: 0,
  enhancements: {},      // { name: count }
  stars: 0,
  dust: 0,
  totalRuns: 0,
  totalWins: 0,
  totalEvacuations: 0,
  totalLosses: 0,
  bestDepth: 0,
  lastAction: '',
  lastActionTime: 0,
};

// ── Logging ──────────────────────────────────────────────────
const MAX_LOG_ENTRIES = 60;
const logEntries = [];

function log(msg, level = 'info') {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const entry = { ts, msg, level };
  logEntries.push(entry);
  if (logEntries.length > MAX_LOG_ENTRIES) logEntries.shift();

  const colors = {
    info:    'color: #10b981; font-weight: bold;',
    warn:    'color: #f59e0b; font-weight: bold;',
    error:   'color: #ef4444; font-weight: bold;',
    action:  'color: #6366f1; font-weight: bold;',
    state:   'color: #06b6d4; font-weight: bold;',
  };
  console.log(`%c[Raid Helper][${ts}] ${msg}`, colors[level] || colors.info);

  // Persist log to storage for popup
  chrome.storage.local.set({ raidLog: logEntries.slice(-20) });
}

// ── Click cooldown tracker ───────────────────────────────────
const clickTimestamps = new Map();

function safeClick(element, label) {
  if (!element) return false;
  const now = Date.now();
  if (clickTimestamps.has(label) && (now - clickTimestamps.get(label) < CLICK_COOLDOWN)) {
    return false;
  }
  clickTimestamps.set(label, now);

  element.scrollIntoView({ block: 'center', behavior: 'instant' });

  // Dispatch full mouse event sequence
  for (const type of ['mouseover', 'mousedown', 'mouseup', 'click']) {
    element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
  }

  log(`点击: "${label}"`, 'action');
  gameState.lastAction = label;
  gameState.lastActionTime = now;

  // Bump click counter
  chrome.storage.local.get('statClicks', (r) => {
    chrome.storage.local.set({ statClicks: (r.statClicks || 0) + 1 });
  });

  return true;
}

// ── DOM helpers (using real element IDs) ─────────────────────

function $(id) { return document.getElementById(id); }

function isVisible(el) {
  if (!el) return false;
  if (el.hidden) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isEnabled(el) {
  return el && !el.disabled && !el.classList.contains('is-loading');
}

/** Read numeric value from an element's textContent */
function readNumber(el) {
  if (!el) return 0;
  const text = el.textContent.trim().replace(/,/g, '');
  return parseInt(text, 10) || 0;
}

/** Find a visible button whose textContent contains the given text */
function findButtonByText(text, container) {
  const root = container || document;
  const buttons = root.querySelectorAll('button');
  for (const btn of buttons) {
    if (isVisible(btn) && btn.textContent.trim().includes(text)) {
      return btn;
    }
  }
  return null;
}

// ── State Detection ──────────────────────────────────────────

function detectState() {
  const shell = document.querySelector('.raid-shell');
  if (!shell) return { state: 'UNKNOWN' };

  // 1) Check modals first (they overlay everything)
  const rewardModal = $('raidRewardModal');
  if (rewardModal && isVisible(rewardModal)) {
    return detectRewardModalState(rewardModal);
  }

  const startModal = $('raidStartModal');
  if (startModal && isVisible(startModal)) {
    return { state: 'START_CONFIRM' };
  }

  // 2) Check shell class for current phase
  if (shell.classList.contains('is-warehouse')) {
    return { state: 'WAREHOUSE' };
  }

  if (shell.classList.contains('is-run')) {
    return { state: 'BATTLE' };
  }

  // 3) Check for home/lobby view
  const startBtn = $('raidStartBtn');
  if (startBtn && isVisible(startBtn)) {
    const stars = readNumber($('raidHeaderStarBalance'));
    const dust  = readNumber($('raidHeaderDustBalance'));
    gameState.stars = stars;
    gameState.dust  = dust;
    return { state: 'MAIN_PAGE', stars, dust, canStart: isEnabled(startBtn) };
  }

  // 4) Loading state
  const loading = shell.querySelector('.raid-loading');
  if (loading && isVisible(loading)) {
    return { state: 'LOADING' };
  }

  return { state: 'UNKNOWN' };
}

function detectRewardModalState(modal) {
  const resultText = $('raidResultText');
  const text = resultText ? resultText.textContent.trim() : '';

  // Parse layer number from text like "第 1 层胜利" or "第1层胜利"
  const layerMatch = text.match(/第\s*(\d+)\s*层/);
  const layer = layerMatch ? parseInt(layerMatch[1], 10) : gameState.currentLayer;

  // Check for loss state
  const lossActions = $('raidLossActions');
  if (lossActions && isVisible(lossActions)) {
    return { state: 'DEFEAT', layer, resultText: text };
  }

  // It's a victory / reward choice
  const choices = $('raidRewardChoices');
  const choiceButtons = choices ? choices.querySelectorAll('.raid-choice') : [];
  const escapeBtn = $('raidEscapeBtn');
  const afterRewardActions = $('raidAfterRewardActions');

  // Parse available enhancement choices
  const enhancements = [];
  for (const btn of choiceButtons) {
    if (!isVisible(btn)) continue;
    const strong = btn.querySelector('strong');
    const span   = btn.querySelector('span');
    if (strong) {
      const name = strong.textContent.trim();
      const desc = span ? span.textContent.trim() : '';
      // Parse level from desc, e.g. "Lv.0/2" or "Lv.1/4"
      const lvMatch = desc.match(/Lv\.(\d+)\/(\d+)/);
      enhancements.push({
        element: btn,
        name,
        desc,
        currentLv: lvMatch ? parseInt(lvMatch[1], 10) : 0,
        maxLv:     lvMatch ? parseInt(lvMatch[2], 10) : 0,
      });
    }
  }

  return {
    state: 'VICTORY_CHOICE',
    layer,
    resultText: text,
    enhancements,
    canEscape: escapeBtn && isVisible(escapeBtn) && afterRewardActions && isVisible(afterRewardActions),
    escapeBtn,
  };
}

// ── Decision Engines ─────────────────────────────────────────

/**
 * Evacuation strategy based on remark.md:
 * - Layers ≤ 3: always continue (pick skill)
 * - After layer 3: if 备用核心 == 0 → evacuate; else continue to layer 5
 * - After layer 5: if 备用核心 < 2 → evacuate; else continue to layer 7
 * - After layer 7: always evacuate
 */
function shouldEvacuate(layer) {
  const coreCount = gameState.enhancements['备用核心'] || 0;

  if (layer <= 3) {
    log(`第${layer}层: 继续挑战 (≤3层总是继续)`, 'state');
    return false;
  }
  if (layer <= 5) {
    if (coreCount === 0) {
      log(`第${layer}层: 撤离 (无备用核心, 超过3层风险太大)`, 'warn');
      return true;
    }
    log(`第${layer}层: 继续 (有${coreCount}个备用核心)`, 'state');
    return false;
  }
  if (layer <= 7) {
    if (coreCount < 2) {
      log(`第${layer}层: 撤离 (备用核心${coreCount}<2, 超过5层风险太大)`, 'warn');
      return true;
    }
    log(`第${layer}层: 继续 (有${coreCount}个备用核心)`, 'state');
    return false;
  }

  // Layer > 7: always evacuate
  log(`第${layer}层: 撤离 (已超过7层, 保守策略)`, 'warn');
  return true;
}

/**
 * Enhancement selection strategy from remark.md:
 * 1. 备用核心 — absolute first choice (always pick if available, up to max)
 * 2. For others, pick any that haven't been chosen yet (first time priority)
 * 3. If all have been chosen once, pick by importance:
 *    自动护盾 > 宝物磁场 > 技能冷却 > 开局推进
 */
function selectEnhancement(enhancements) {
  if (!enhancements || enhancements.length === 0) return null;

  // 1. Always prefer 备用核心
  const core = enhancements.find(e => e.name.includes('备用核心') && e.currentLv < e.maxLv);
  if (core) {
    log(`选择强化: 备用核心 (优先级最高)`, 'action');
    return core;
  }

  // 2. Find skills that haven't been picked yet (currentLv == 0 means not yet picked)
  const unpicked = enhancements.filter(e => {
    const ownedCount = gameState.enhancements[e.name] || 0;
    return ownedCount === 0 && e.currentLv < e.maxLv;
  });

  if (unpicked.length > 0) {
    // Pick by priority order
    for (const priorityName of ENHANCE_PRIORITY) {
      const match = unpicked.find(e => e.name.includes(priorityName));
      if (match) {
        log(`选择强化: ${match.name} (首次选择)`, 'action');
        return match;
      }
    }
    // If none of the priority names match, pick first unpicked
    log(`选择强化: ${unpicked[0].name} (首次选择)`, 'action');
    return unpicked[0];
  }

  // 3. All have been picked at least once; pick by priority order
  for (const priorityName of ENHANCE_PRIORITY) {
    const match = enhancements.find(e => e.name.includes(priorityName) && e.currentLv < e.maxLv);
    if (match) {
      log(`选择强化: ${match.name} (优先级选择)`, 'action');
      return match;
    }
  }

  // Fallback: pick any available enhancement
  const any = enhancements.find(e => e.currentLv < e.maxLv);
  if (any) {
    log(`选择强化: ${any.name} (兜底选择)`, 'action');
    return any;
  }

  // All maxed out: pick first one anyway
  if (enhancements.length > 0) {
    log(`选择强化: ${enhancements[0].name} (全部满级，随意选择)`, 'action');
    return enhancements[0];
  }

  return null;
}

// ── Main Automation Loop ─────────────────────────────────────

async function processAutomation() {
  // Check master switch
  const config = await new Promise(resolve => {
    chrome.storage.local.get(['masterActive'], resolve);
  });
  if (!config.masterActive) return POLL_SLOW;

  const detected = detectState();

  // Sync state to storage for popup
  syncStateToStorage(detected);

  switch (detected.state) {

    // ─── MAIN PAGE (lobby) ─────────────────────────────────
    case 'MAIN_PAGE': {
      log(`出击大厅 | 星星: ${detected.stars} | 星屑: ${detected.dust}`, 'state');

      // Stars > 0 and button enabled → start game
      if (detected.canStart) {
        const startBtn = $('raidStartBtn');
        if (safeClick(startBtn, '开始游戏')) {
          gameState.currentLayer = 0;
          gameState.enhancements = {};
          gameState.totalRuns++;
          return POLL_FAST;
        }
      }

      // Stars == 0 → open warehouse to exchange
      if (detected.stars <= 0) {
        // Check if warehouse button is available
        const warehouseBtn = $('raidWarehouseBtn');
        if (warehouseBtn && isEnabled(warehouseBtn) && isVisible(warehouseBtn)) {
          log('星星不足, 打开仓库兑换', 'warn');
          safeClick(warehouseBtn, '打开仓库');
          return POLL_FAST;
        } else {
          log('星星不足且仓库按钮不可用, 等待中...', 'warn');
          return POLL_SLOW;
        }
      }

      return POLL_FAST;
    }

    // ─── START CONFIRMATION MODAL ──────────────────────────
    case 'START_CONFIRM': {
      log('选择坦克确认框', 'state');
      // Click the first tank card to select it if none selected
      const tankGrid = $('raidTankCards');
      if (tankGrid) {
        const selected = tankGrid.querySelector('.raid-tank-card.is-selected');
        if (!selected) {
          const firstCard = tankGrid.querySelector('.raid-tank-card');
          if (firstCard) {
            safeClick(firstCard, '选择坦克');
            return POLL_FAST;
          }
        }
      }

      // Click confirm button "进入地图"
      const confirmBtn = $('raidStartConfirmBtn');
      if (confirmBtn && isEnabled(confirmBtn)) {
        safeClick(confirmBtn, '进入地图');
        return POLL_FAST;
      }

      return POLL_FAST;
    }

    // ─── BATTLE IN PROGRESS ────────────────────────────────
    case 'BATTLE': {
      // Just wait — AI handles the fight automatically
      return POLL_BATTLE;
    }

    // ─── VICTORY — CHOOSE ENHANCEMENT ──────────────────────
    case 'VICTORY_CHOICE': {
      const layer = detected.layer;
      gameState.currentLayer = Math.max(gameState.currentLayer, layer);
      gameState.bestDepth = Math.max(gameState.bestDepth, layer);
      gameState.totalWins++;

      log(`第${layer}层胜利! 可选强化: ${detected.enhancements.map(e => e.name).join(', ')}`, 'info');

      // Check if we should evacuate
      if (detected.canEscape && shouldEvacuate(layer)) {
        safeClick(detected.escapeBtn, '撤离并保存');
        gameState.totalEvacuations++;
        log(`第${layer}层撤离! 总撤离次数: ${gameState.totalEvacuations}`, 'warn');
        return POLL_FAST;
      }

      // Select the best enhancement
      const choice = selectEnhancement(detected.enhancements);
      if (choice) {
        // Track chosen enhancement
        gameState.enhancements[choice.name] = (gameState.enhancements[choice.name] || 0) + 1;
        safeClick(choice.element, `强化: ${choice.name}`);
        return POLL_FAST;
      }

      // No enhancement choosable — fallback: escape if possible
      if (detected.canEscape) {
        log('无可选强化, 选择撤离', 'warn');
        safeClick(detected.escapeBtn, '撤离并保存');
        gameState.totalEvacuations++;
        return POLL_FAST;
      }

      return POLL_FAST;
    }

    // ─── DEFEAT ────────────────────────────────────────────
    case 'DEFEAT': {
      log(`失败: ${detected.resultText}`, 'error');
      gameState.totalLosses++;
      gameState.currentLayer = 0;
      gameState.enhancements = {};

      const lossBtn = $('raidLossConfirmBtn');
      if (lossBtn && isEnabled(lossBtn)) {
        safeClick(lossBtn, '确定(失败)');
      }
      return POLL_FAST;
    }

    // ─── WAREHOUSE ─────────────────────────────────────────
    case 'WAREHOUSE': {
      log('仓库界面', 'state');
      return handleWarehouse();
    }

    // ─── LOADING ───────────────────────────────────────────
    case 'LOADING': {
      return POLL_BATTLE;
    }

    // ─── UNKNOWN ───────────────────────────────────────────
    default: {
      return POLL_SLOW;
    }
  }
}

// ── Warehouse Flow ───────────────────────────────────────────

function handleWarehouse() {
  // 1. Sell all items if any "全部出售" buttons are visible
  const sellButtons = document.querySelectorAll('.raid-warehouse-actions button');
  for (const btn of sellButtons) {
    if (isVisible(btn) && btn.textContent.trim().includes('全部出售')) {
      log('出售仓库宝物', 'action');
      safeClick(btn, '全部出售');
      return POLL_FAST;
    }
  }

  // Also try individual "出售" buttons
  for (const btn of sellButtons) {
    if (isVisible(btn) && btn.textContent.trim().startsWith('出售')) {
      log('出售单个宝物', 'action');
      safeClick(btn, '出售宝物');
      return POLL_FAST;
    }
  }

  // 2. Check if stars are 0 and we have dust to exchange
  const stars = readNumber($('raidHeaderStarBalance'));
  const dust  = readNumber($('raidHeaderDustBalance'));
  gameState.stars = stars;
  gameState.dust  = dust;

  if (stars <= 0 && dust > 0) {
    // Find the exchange button "兑换星星"
    const exchangeBtn = findButtonByText('兑换星星');
    if (exchangeBtn && isEnabled(exchangeBtn)) {
      // Set exchange amount to 1 (just enough to start one game)
      const exchangeInput = document.querySelector('.raid-exchange-box input');
      if (exchangeInput) {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        ).set;
        nativeInputValueSetter.call(exchangeInput, '1');
        exchangeInput.dispatchEvent(new Event('input', { bubbles: true }));
        exchangeInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      log('兑换1颗星星', 'action');
      safeClick(exchangeBtn, '兑换星星');
      return POLL_FAST;
    }
  }

  // 3. Have stars → return to raid
  if (stars > 0) {
    // Find "返回出击" button
    const backBtn = findButtonByText('返回出击');
    if (backBtn && isEnabled(backBtn)) {
      log('返回出击', 'action');
      safeClick(backBtn, '返回出击');
      return POLL_FAST;
    }
  }

  // If we have no stars and no dust, still try to go back
  if (stars <= 0 && dust <= 0) {
    const backBtn = findButtonByText('返回出击');
    if (backBtn && isEnabled(backBtn)) {
      log('无资源，返回出击等待', 'warn');
      safeClick(backBtn, '返回出击');
      return POLL_FAST;
    }
  }

  return POLL_FAST;
}

// ── Sync State to Storage ────────────────────────────────────

function syncStateToStorage(detected) {
  chrome.storage.local.set({
    raidState: detected.state,
    raidLayer: gameState.currentLayer,
    raidEnhancements: gameState.enhancements,
    raidStars: gameState.stars,
    raidDust: gameState.dust,
    raidTotalRuns: gameState.totalRuns,
    raidTotalWins: gameState.totalWins,
    raidTotalEvacuations: gameState.totalEvacuations,
    raidTotalLosses: gameState.totalLosses,
    raidBestDepth: gameState.bestDepth,
    raidLastAction: gameState.lastAction,
  });
}

// ── Adaptive Loop Runner ─────────────────────────────────────

let loopTimer = null;

function startLoop(delayMs) {
  if (loopTimer) clearTimeout(loopTimer);

  const jitter = Math.floor(Math.random() * 600) - 300; // ±300ms jitter
  const actualDelay = Math.max(500, (delayMs || POLL_FAST) + jitter);

  loopTimer = setTimeout(async () => {
    try {
      const nextDelay = await processAutomation();
      startLoop(nextDelay);
    } catch (err) {
      console.error('[Raid Helper] Error:', err);
      log(`错误: ${err.message}`, 'error');
      startLoop(POLL_SLOW);
    }
  }, actualDelay);
}

// ── Initialize ───────────────────────────────────────────────
startLoop(POLL_FAST);

// Listen for config changes from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'config_updated') {
    log('配置已更新', 'info');
    sendResponse({ status: 'ok' });
  }
  if (request.action === 'get_state') {
    sendResponse({
      gameState,
      log: logEntries.slice(-20),
    });
  }
});

log('引擎已启动, 等待主开关激活...', 'info');
