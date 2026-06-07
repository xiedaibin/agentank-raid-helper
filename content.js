// ============================================================
// Agentank Raid Helper — 状态机自动化引擎 v2.0.2
// ============================================================
console.log('%c[Raid Helper] v2.0 — 状态机引擎已加载。', 'color: #00f2fe; font-weight: bold;');

// ── 常量定义 ────────────────────────────────────────────────
const POLL_FAST = 1500;   // 1.5秒 — 菜单和模态框的检测频率
const POLL_BATTLE = 4000;   // 4秒   — 战斗进行中的检测频率（降低频率以减少资源占用）
const POLL_SLOW = 3000;   // 3秒   — 兜底/未知状态的检测频率
const CLICK_COOLDOWN = 1800; // 点击冷却时间（毫秒），防止按钮被快速重复点击

// 强化技能选择优先级（数组下标越小，优先级越高）
// “备用核心”具有绝对最高优先级，在代码中进行了特殊判断和处理，不在此列表中
const ENHANCE_PRIORITY = ['自动护盾', '宝物磁场', '技能冷却', '开局推进'];

// ── 游戏运行状态数据 ───────────────────────────────────────────────
const gameState = {
  currentLayer: 0,       // 当前挑战的关卡层数
  enhancements: {},      // 已获得的强化技能记录，格式如：{ '强化名称': 获得次数 }
  stars: 0,              // 当前持有的星星数量
  dust: 0,               // 当前持有的星屑数量
  totalRuns: 0,          // 本次运行总出击次数
  totalWins: 0,          // 本次运行总胜利层数
  totalEvacuations: 0,   // 本次运行总撤离次数
  totalLosses: 0,        // 本次运行总失败次数
  bestDepth: 0,          // 历史最高挑战关卡层数
  lastAction: '',        // 上一次执行的动作名称
  lastActionTime: 0,     // 上一次动作的时间戳（毫秒）
};

/**
 * 检查当前的 Chrome 插件上下文是否有效
 * 在插件后台重载或更新后，旧的 content.js 仍然存活但上下文会失效，调用 Chrome API 会报错。
 * 本函数用于防范 "Extension context invalidated" 异常。
 */
function isContextValid() {
  return typeof chrome !== 'undefined' && chrome.runtime && !!chrome.runtime.id;
}

// ── 日志管理系统 ──────────────────────────────────────────────────
const MAX_LOG_ENTRIES = 60; // 内存中保留的最大日志条数
const logEntries = [];      // 内存日志队列

/**
 * 记录格式化日志，并向 Chrome 存储写入日志快照以供 Popup 面板展示
 * @param {string} msg 日志内容
 * @param {string} level 日志级别：'info' | 'warn' | 'error' | 'action' | 'state'
 */
function log(msg, level = 'info') {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const entry = { ts, msg, level };
  logEntries.push(entry);
  if (logEntries.length > MAX_LOG_ENTRIES) logEntries.shift();

  // 控制台彩色输出配置
  const colors = {
    info: 'color: #10b981; font-weight: bold;', // 绿色：正常信息
    warn: 'color: #f59e0b; font-weight: bold;', // 黄色：警告/撤离决策
    error: 'color: #ef4444; font-weight: bold;', // 红色：失败/错误
    action: 'color: #6366f1; font-weight: bold;', // 紫色：执行点击动作
    state: 'color: #06b6d4; font-weight: bold;', // 青色：状态机状态流转
  };
  console.log(`%c[Raid Helper][${ts}] ${msg}`, colors[level] || colors.info);

  // 持久化保存最近20条日志快照至 storage 以供 popup 页面读取展示
  if (isContextValid()) {
    try {
      chrome.storage.local.set({ raidLog: logEntries.slice(-20) });
    } catch (e) {
      console.warn('[Raid Helper] Failed to save logs to storage:', e.message);
    }
  }
}

// ── 安全点击与冷却机制 ───────────────────────────────────
// 用于记录每个动作标签对应的上一次点击时间戳，做去抖冷却限制
const clickTimestamps = new Map();

/**
 * 触发一个安全且防连击的点击事件，并分发完整的鼠标事件流以模拟真人操作
 * @param {HTMLElement} element 目标 DOM 节点
 * @param {string} label 该动作的描述标签（用于防连击校验和日志记录）
 * @returns {boolean} 是否成功触发点击
 */
function safeClick(element, label) {
  if (!element) return false;
  const now = Date.now();
  // 冷却防连击校验
  if (clickTimestamps.has(label) && (now - clickTimestamps.get(label) < CLICK_COOLDOWN)) {
    return false;
  }
  clickTimestamps.set(label, now);

  // 滚动元素到可视区域中央以确保可被点击
  element.scrollIntoView({ block: 'center', behavior: 'instant' });

  // 触发完整的鼠标交互事件流，应对虚拟 DOM 绑定的事件监听
  for (const type of ['mouseover', 'mousedown', 'mouseup', 'click']) {
    element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
  }

  log(`点击: "${label}"`, 'action');
  gameState.lastAction = label;
  gameState.lastActionTime = now;

  // 累加本地点击统计计数器
  if (isContextValid()) {
    try {
      chrome.storage.local.get('statClicks', (r) => {
        if (!isContextValid()) return;
        chrome.storage.local.set({ statClicks: (r.statClicks || 0) + 1 });
      });
    } catch (e) {
      console.warn('[Raid Helper] Failed to update click statistics:', e.message);
    }
  }

  return true;
}

// ── DOM 辅助工具函数 ─────────────────────

/** 快捷获取 DOM 元素对象 */
function $(id) { return document.getElementById(id); }

/** 
 * 校验元素是否在页面上可见
 * @param {HTMLElement} el DOM元素
 * @returns {boolean} 
 */
function isVisible(el) {
  if (!el) return false;
  if (el.hidden) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/** 
 * 检测模态框弹框是否显现 — 采用 物理尺寸 + hidden 属性 + 样式 display 的三重检查以确保高可靠性
 * @param {HTMLElement} el 模态框 DOM 元素
 * @returns {boolean} 
 */
function isModalShowing(el) {
  if (!el) return false;
  // 检查是否设置了 hidden 属性
  if (el.hidden || el.hasAttribute('hidden')) return false;
  // 核心校验：如果元素的渲染宽度和高度都为 0，说明被隐藏（常驻 DOM 隐藏元素的核心特征）
  if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;
  // 检查 CSS 计算样式的 display 和 visibility
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  return true;
}

// 防连击保护：记录上一次点击主页“开始游戏”的时间戳，防止弹框未出现前连点
let lastStartClickTime = 0;
const START_CLICK_GUARD_MS = 5000; // 点击主页出击后，设立 5 秒的保护期

/**
 * 校验按钮是否为可用状态（无 disabled 属性且未处于 loading 加载状态）
 * @param {HTMLElement} el 按钮元素
 * @returns {boolean}
 */
function isEnabled(el) {
  return el && !el.disabled && !el.classList.contains('is-loading');
}

/** 
 * 从元素的 textContent 中读取数值并格式化解析（剥离千分位逗号）
 * @param {HTMLElement} el 包含数字 of 元素
 * @returns {number} 
 */
function readNumber(el) {
  if (!el) return 0;
  const text = el.textContent.trim().replace(/,/g, '');
  return parseInt(text, 10) || 0;
}

/** 
 * 在指定的容器范围内，查找文本内容包含指定关键字的可见按钮
 * @param {string} text 关键字
 * @param {HTMLElement} [container] 查找容器范围，默认是全局 document
 * @returns {HTMLButtonElement|null} 
 */
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

// ── 页面状态机检测引擎 ──────────────────────────────────────────

/**
 * 核心状态检测函数：通过页面的 DOM 节点特征，精确分析并返回当前的游戏阶段
 * @returns {object} 包含 state 及必要附属状态（如星星数、是否可以出击等）的对象
 */
function detectState() {
  const shell = document.querySelector('.raid-shell');
  if (!shell) return { state: 'UNKNOWN' }; // 未检测到 Raid 容器界面

  // 1) 优先检测模态弹框（它们层级最高，会覆盖在基础容器之上）
  // 检查胜利/失败结算弹框
  const settlementModal = $('raidSettlementModal');
  if (isModalShowing(settlementModal)) {
    return detectRewardModalState(settlementModal);
  }

  // 检查选择奖励强化弹框
  const choiceModal = $('raidChoiceModal');
  if (isModalShowing(choiceModal)) {
    return detectRewardModalState(choiceModal);
  }

  // 检查开始游戏选择坦克的弹框
  const startModal = $('raidStartModal') || document.querySelector('#raidStartModal');
  if (isModalShowing(startModal)) {
    return { state: 'START_CONFIRM' };
  }

  // 2) 检测基础容器 class 样式特征识别运行阶段
  // 检测是否处于仓库视图
  if (shell.classList.contains('is-warehouse')) {
    return { state: 'WAREHOUSE' };
  }

  // 检测是否处于出击进行中战斗状态
  if (shell.classList.contains('is-run')) {
    return { state: 'BATTLE' };
  }

  // 3) 检测出击大厅主页面
  const startBtn = $('raidStartBtn') || document.querySelector('.raid-home-start');
  if (startBtn && isVisible(startBtn)) {
    // 读取头部面板展示的当前星星和星屑余额
    const stars = readNumber($('raidHeaderStarBalance'));
    const dust = readNumber($('raidHeaderDustBalance'));
    gameState.stars = stars;
    gameState.dust = dust;
    return { state: 'MAIN_PAGE', stars, dust, canStart: isEnabled(startBtn) };
  }

  // 4) 加载中过渡态
  const loading = shell.querySelector('.raid-loading');
  if (loading && isVisible(loading)) {
    return { state: 'LOADING' };
  }

  return { state: 'UNKNOWN' }; // 未知态
}

/**
 * 细化检测奖励/结算弹框状态（用以区分胜利技能选择、智能撤离判断还是战斗失败结算）
 * @param {HTMLElement} modal 模态弹框节点
 * @returns {object} 细化状态对象
 */
function detectRewardModalState(modal) {
  const resultText = $('raidResultText') || modal.querySelector('p') || modal.querySelector('.raid-result-text');
  const text = resultText ? resultText.textContent.trim() : '';

  // 从文本中解析当前胜利或失败的关卡层数，例如 “第 1 层胜利”
  const layerMatch = text.match(/第\s*(\d+)\s*层/);
  const layer = layerMatch ? parseInt(layerMatch[1], 10) : gameState.currentLayer;

  // 识别是否是失败结算状态
  const lossActions = $('raidLossActions') || modal.querySelector('.raid-loss-actions') || findButtonByText('确定');
  const hasLossButton = findButtonByText('确定', modal) || $('raidLossConfirmBtn');
  const isLoss = (lossActions && isVisible(lossActions)) || text.includes('失败') || (hasLossButton && isVisible(hasLossButton) && !modal.querySelector('.raid-choice'));

  if (isLoss) {
    return { state: 'DEFEAT', layer, resultText: text };
  }

  // 属于胜利三选一强化技能或撤离决策界面
  const choices = $('raidRewardChoices') || modal.querySelector('.raid-reward-choices');
  const choiceButtons = choices ? choices.querySelectorAll('.raid-choice') : modal.querySelectorAll('.raid-choice');
  const escapeBtn = $('raidEscapeBtn') || findButtonByText('撤离并保存', modal);
  const afterRewardActions = $('raidAfterRewardActions') || modal.querySelector('.raid-after-reward-actions');

  // 解析并缓存可选的三个强化技能名称、等级信息，构建成强化备选池
  const enhancements = [];
  for (const btn of choiceButtons) {
    if (!isVisible(btn)) continue;
    const strong = btn.querySelector('strong');
    const span = btn.querySelector('span');
    if (strong) {
      const name = strong.textContent.trim();
      const desc = span ? span.textContent.trim() : '';
      // 正则解析出当前的技能等级与最大等级限制，例如 "Lv.0/2"
      const lvMatch = desc.match(/Lv\.(\d+)\/(\d+)/);
      enhancements.push({
        element: btn,
        name,
        desc,
        currentLv: lvMatch ? parseInt(lvMatch[1], 10) : 0,
        maxLv: lvMatch ? parseInt(lvMatch[2], 10) : 0,
      });
    }
  }

  return {
    state: 'VICTORY_CHOICE',
    layer,
    resultText: text,
    enhancements,
    // 判断当前是否被允许执行撤离动作（撤离按钮必须可见，且撤离前的校验区域可见）
    canEscape: escapeBtn && isVisible(escapeBtn) && afterRewardActions && isVisible(afterRewardActions),
    escapeBtn,
  };
}

// ── 智能挂机决策模块 ─────────────────────────────────────────

/**
 * 战术撤离逻辑评估（依据 remark.md 约定的低风险收益最大化模型设计）：
 * - 层数 <= 3：必定不撤离（前3关绝对安全且用于堆战力，选择强化继续挑战）
 * - 第 3 层挑战胜利：如果备用核心累计数量 == 0（无复活核心），立即撤离并保存；若 >= 1，尝试挑战到第 5 层
 * - 第 5 层挑战胜利：如果备用核心累计数量 < 2（核心命数少于2），立即撤离并保存；若 >= 2，尝试挑战到第 7 层
 * - 第 7 层挑战胜利：无条件选择撤离并保存（稳健保分锁收益）
 * @param {number} layer 当前胜利的关卡层数
 * @returns {boolean} 是否应该撤离并保存
 */
function shouldEvacuate(layer) {
  // 获取当前局拥有的备用核心数量
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

  // 大于7层：无条件进行撤离
  log(`第${layer}层: 撤离 (已超过7层, 保守策略)`, 'warn');
  return true;
}

/**
 * 强化技能选择器（依据 remark.md 中规定的重要度等级）：
 * 1. 首要选：只要出现“备用核心”，必选之（直到满级 Lv.2），复活命数最为关键。
 * 2. 补漏选：确保“自动护盾”、“宝物磁场”、“技能冷却”、“开局推进”这四种辅助芯片至少已经选择过一次（激活基础效果）。
 * 3. 优选升：若所有辅助技能都已持有一级以上，则按照升级重要度排序进行升级：
 *    自动护盾 (防暴毙) > 宝物磁场 (吸钱增收益) > 技能冷却 (提高输出效率) > 开局推进 (速通拉怪)
 * @param {array} enhancements 可选的强化列表
 * @returns {object|null} 选择的技能对象
 */
function selectEnhancement(enhancements) {
  if (!enhancements || enhancements.length === 0) return null;

  // 1. 优先筛选“备用核心”
  const core = enhancements.find(e => e.name.includes('备用核心') && e.currentLv < e.maxLv);
  if (core) {
    log(`选择强化: 备用核心 (优先级最高)`, 'action');
    return core;
  }

  // 2. 筛选未曾选择过的技能（即当前局累计选择次数为 0 且未满级的技能）
  const unpicked = enhancements.filter(e => {
    const ownedCount = gameState.enhancements[e.name] || 0;
    return ownedCount === 0 && e.currentLv < e.maxLv;
  });

  if (unpicked.length > 0) {
    // 按照指定的核心技能优先级顺序依次查漏补缺
    for (const priorityName of ENHANCE_PRIORITY) {
      const match = unpicked.find(e => e.name.includes(priorityName));
      if (match) {
        log(`选择强化: ${match.name} (首次选择)`, 'action');
        return match;
      }
    }
    // 如有其它非主要辅助技能，选择其中第一个
    log(`选择强化: ${unpicked[0].name} (首次选择)`, 'action');
    return unpicked[0];
  }

  // 3. 所有可选辅助技能都至少有了一级，按照优先级重要度由高到低选择升级
  for (const priorityName of ENHANCE_PRIORITY) {
    const match = enhancements.find(e => e.name.includes(priorityName) && e.currentLv < e.maxLv);
    if (match) {
      log(`选择强化: ${match.name} (优先级选择)`, 'action');
      return match;
    }
  }

  // 4. 兜底策略：选择任意一个未满级的强化
  const any = enhancements.find(e => e.currentLv < e.maxLv);
  if (any) {
    log(`选择强化: ${any.name} (兜底选择)`, 'action');
    return any;
  }

  // 5. 极端情况（所有推荐都已经满级）：选择可选列表中的第一个
  if (enhancements.length > 0) {
    log(`选择强化: ${enhancements[0].name} (全部满级，随意选择)`, 'action');
    return enhancements[0];
  }

  return null;
}

// ── 核心自动化决策与逻辑循环 ─────────────────────────────────────

/**
 * 每次轮询的核心调度模块，根据检测到的当前页面状态，决策并触发具体的交互动作
 * @returns {Promise<number>} 返回下一次轮询的推荐等待延迟时间（毫秒）
 */
async function processAutomation() {
  if (!isContextValid()) return POLL_SLOW;
  // 从本地存储读取当前插件主开关的激活状态
  const config = await new Promise(resolve => {
    try {
      chrome.storage.local.get(['masterActive'], items => {
        if (!isContextValid()) {
          resolve({ masterActive: false });
        } else if (chrome.runtime.lastError) {
          resolve({ masterActive: false });
        } else {
          resolve(items || {});
        }
      });
    } catch (e) {
      resolve({ masterActive: false });
    }
  });
  // 如果主开关未激活，退出轮询，进入低频检测态
  if (!config.masterActive) return POLL_SLOW;

  // 探测当前所在页面状态
  const detected = detectState();

  // 将最新状态数据同步存储，以便 popup 控制面板刷新展示
  syncStateToStorage(detected);

  switch (detected.state) {

    // ─── 出击主页面大厅 ─────────────────────────────────
    case 'MAIN_PAGE': {
      log(`出击大厅 | 星星: ${detected.stars} | 星屑: ${detected.dust}`, 'state');

      // 守卫一：如果此时开始游戏选择坦克的弹框已经被点出来并显现，跳转执行弹框确认逻辑
      const modalCheck = $('raidStartModal');
      if (isModalShowing(modalCheck)) {
        log('检测到开始游戏弹框已显示，跳转至确认流程...', 'state');
        return POLL_FAST;
      }

      // 守卫二：防双击，距离上一次主出击按钮点击不足 5 秒则等待，防止高延迟导致连点
      if (Date.now() - lastStartClickTime < START_CLICK_GUARD_MS) {
        log('等待开始游戏弹框出现...', 'state');
        return POLL_FAST;
      }

      // 如果有星星可用且出击按钮允许点击，点击开始游戏出击
      if (detected.canStart) {
        const startBtn = $('raidStartBtn') || document.querySelector('.raid-home-start');
        if (safeClick(startBtn, '开始游戏(主页)')) {
          lastStartClickTime = Date.now();
          gameState.currentLayer = 0;       // 新出击局，重置层数计数
          gameState.enhancements = {};      // 重置已获得强化列表
          gameState.totalRuns++;            // 出击局数累加
          return POLL_FAST;
        }
      }

      // 星星归零且有星屑，打开仓库自动兑换
      if (detected.stars <= 0) {
        const warehouseBtn = $('raidWarehouseBtn') || document.querySelector('.raid-home-view button.raid-secondary') || findButtonByText('打开仓库');
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

    // ─── 坦克选择与出击确认弹框 ──────────────────────────
    case 'START_CONFIRM': {
      log('选择坦克确认框', 'state');
      // 如果没有选择任何坦克，默认点击选择第一个坦克（通常是默认坦克）
      const tankGrid = $('raidTankCards') || document.querySelector('.raid-tank-cards') || document.querySelector('.raid-start-card .grid');
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

      // 点击确认框中红色的出击按钮“开始游戏”
      const confirmBtn = $('raidStartConfirmBtn') || findButtonByText('开始游戏') || findButtonByText('进入地图');
      if (confirmBtn && isEnabled(confirmBtn)) {
        const btnText = confirmBtn.textContent.trim() || '确认开始';
        safeClick(confirmBtn, `${btnText}(确认框)`);
        lastStartClickTime = 0; // 重置点击冷却锁
        return POLL_FAST;
      }

      log('等待确认按钮可用...', 'state');
      return POLL_FAST;
    }

    // ─── 战斗进行中 ────────────────────────────────
    case 'BATTLE': {
      // 战斗是自动进行的，插件保持观察，延长轮询周期以降低资源占用
      return POLL_BATTLE;
    }

    // ─── 第N层获胜：技能强化与战术撤离决策 ──────────────────────
    case 'VICTORY_CHOICE': {
      const layer = detected.layer;
      gameState.currentLayer = Math.max(gameState.currentLayer, layer);
      gameState.bestDepth = Math.max(gameState.bestDepth, layer);
      gameState.totalWins++;

      log(`第${layer}层胜利! 可选强化: ${detected.enhancements.map(e => e.name).join(', ')}`, 'info');

      // 智能评估当前层数和命数是否满足撤退策略，若满则执行撤退落袋为安
      if (detected.canEscape && shouldEvacuate(layer)) {
        safeClick(detected.escapeBtn, '撤离并保存');
        gameState.totalEvacuations++;
        log(`第${layer}层撤离! 总撤离次数: ${gameState.totalEvacuations}`, 'warn');
        return POLL_FAST;
      }

      // 否则挑选最佳的强化技能继续向上挑战
      const choice = selectEnhancement(detected.enhancements);
      if (choice) {
        // 更新记录当前持有的技能及其升级等级
        gameState.enhancements[choice.name] = (gameState.enhancements[choice.name] || 0) + 1;
        safeClick(choice.element, `强化: ${choice.name}`);
        return POLL_FAST;
      }

      // 兜底情况：无可点技能时，如果支持撤退则强制撤退
      if (detected.canEscape) {
        log('无可选强化, 选择撤离', 'warn');
        safeClick(detected.escapeBtn, '撤离并保存');
        gameState.totalEvacuations++;
        return POLL_FAST;
      }

      return POLL_FAST;
    }

    // ─── 关卡遭遇战失败结算 ────────────────────────────────────────────
    case 'DEFEAT': {
      log(`失败: ${detected.resultText}`, 'error');
      gameState.totalLosses++;
      gameState.currentLayer = 0;   // 战败后当前局层数重置
      gameState.enhancements = {};  // 重置强化累计记录

      // 点击确认退出战局弹窗
      const lossBtn = $('raidLossConfirmBtn') || findButtonByText('确定') || findButtonByText('OK');
      if (lossBtn && isEnabled(lossBtn)) {
        safeClick(lossBtn, '确定(失败)');
      }
      return POLL_FAST;
    }

    // ─── 仓库物资界面 ─────────────────────────────────────────
    case 'WAREHOUSE': {
      log('仓库界面', 'state');
      return handleWarehouse();
    }

    // ─── 过渡加载态 ───────────────────────────────────────────
    case 'LOADING': {
      return POLL_BATTLE;
    }

    // ─── 未知态兜底 ───────────────────────────────────────────
    default: {
      return POLL_SLOW;
    }
  }
}

// ── 仓库物资出售与兑换逻辑 ───────────────────────────────────────────

/**
 * 仓库控制工作流：出售宝物、安全适度兑换星星、最终返回出击
 * @returns {number} 下一次轮询的延迟（毫秒）
 */
function handleWarehouse() {
  // 1. 扫描页面中所有的可见按钮，自动将带有“全部出售”字样的宝物依次卖完
  const buttons = document.querySelectorAll('button');
  for (const btn of buttons) {
    if (isVisible(btn) && btn.textContent.trim().includes('全部出售')) {
      log('出售仓库宝物(全部)', 'action');
      safeClick(btn, '全部出售');
      return POLL_FAST; // 每次执行一次点击并快速进入下一次轮询，确保依次售出
    }
  }

  // 兜底支持点击单个“出售”按钮
  for (const btn of buttons) {
    if (isVisible(btn) && btn.textContent.trim().startsWith('出售')) {
      log('出售单个宝物', 'action');
      safeClick(btn, '出售宝物');
      return POLL_FAST;
    }
  }

  // 2. 刷新当前的资产余额（星星数、星屑数）
  const stars = readNumber($('raidHeaderStarBalance'));
  const dust = readNumber($('raidHeaderDustBalance'));
  gameState.stars = stars;
  gameState.dust = dust;

  // 如果没有星星但是还有星屑，在仓库中向星星兑换器写入 "1" 并点击兑换一星，控制星屑投资的浪费
  if (stars <= 0 && dust > 0) {
    const exchangeBtn = findButtonByText('兑换星星') || document.querySelector('.raid-warehouse-view button.raid-primary');
    if (exchangeBtn && isEnabled(exchangeBtn)) {
      // 强设兑换输入框的值为 "1"，绕过原生 React/Vue 等框架受控输入框的限制
      const exchangeInput = $('raidExchangeStarsInput') || document.querySelector('.raid-warehouse-view input') || document.querySelector('.raid-exchange-box input');
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

  // 3. 拥有星星时，点击“返回出击”按钮切回出击大厅
  if (stars > 0) {
    const backBtn = findButtonByText('返回出击') || document.querySelector('.raid-warehouse-back');
    if (backBtn && isEnabled(backBtn)) {
      log('返回出击', 'action');
      safeClick(backBtn, '返回出击');
      return POLL_FAST;
    }
  }

  // 如果既没有星星也没有星屑（无资源可用），依然尝试点击“返回出击”回到出击大厅静待变化
  if (stars <= 0 && dust <= 0) {
    const backBtn = findButtonByText('返回出击') || document.querySelector('.raid-warehouse-back');
    if (backBtn && isEnabled(backBtn)) {
      log('无资源，返回出击等待', 'warn');
      safeClick(backBtn, '返回出击');
      return POLL_FAST;
    }
  }

  return POLL_FAST;
}

// ── 插件状态共享与保存 ────────────────────────────────────

/**
 * 将最新的状态数据刷新同步至 chrome.storage.local，以便 popup 界面读取并渲染
 * @param {object} detected 识别出的当前状态详情对象
 */
function syncStateToStorage(detected) {
  if (!isContextValid()) return;
  try {
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
  } catch (e) {
    console.warn('[Raid Helper] Failed to sync state to storage:', e.message);
  }
}

// ── 自适应微抖动循环执行器 ─────────────────────────────────────

let loopTimer = null; // 用于存储 setTimeout 的定时器对象

/**
 * 启动并运行自适应间隔的自动化轮询循环，带有抖动偏差以防止被后台反挂机机制检测
 * @param {number} delayMs 此次轮询延迟推荐值（毫秒）
 */
function startLoop(delayMs) {
  if (loopTimer) clearTimeout(loopTimer);

  // 引入 ±300毫秒 的随机微抖动，模拟真人的动作延迟变化
  const jitter = Math.floor(Math.random() * 600) - 300;
  const actualDelay = Math.max(500, (delayMs || POLL_FAST) + jitter);

  loopTimer = setTimeout(async () => {
    // 每次执行前安全拦截校验：如扩展已更新或被重载，立即终止并退出循环以防止抛错
    if (!isContextValid()) {
      console.log('%c[Raid Helper] Extension context invalidated. Stopping loop.', 'color: #ef4444; font-weight: bold;');
      return;
    }
    try {
      const nextDelay = await processAutomation();
      if (!isContextValid()) return; // 动作完毕后再次安全检查
      startLoop(nextDelay);          // 递补执行下一次循环
    } catch (err) {
      console.error('[Raid Helper] Error in loop:', err);
      if (isContextValid()) {
        log(`错误: ${err.message}`, 'error');
        startLoop(POLL_SLOW);        // 遭遇错误时退避至慢频率重试
      }
    }
  }, actualDelay);
}

// ── 插件生命周期初始化 ───────────────────────────────────────────────
startLoop(POLL_FAST); // 以快速轮询探测状态拉起运行

// 监听控制面板 Popup 发送的通信消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'config_updated') {
    log('配置已更新', 'info');
    sendResponse({ status: 'ok' });
  }
  if (request.action === 'get_state') {
    sendResponse({
      gameState,
      log: logEntries.slice(-20), // 返回最近20条日志快照
    });
  }
});

log('引擎已启动, 等待主开关激活...', 'info');
