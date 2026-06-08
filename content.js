// ============================================================
// Agentank Raid Helper — 状态机自动化引擎 v2.2.8
// ============================================================

// 控制台常规日志开关：true 允许输出调试日志，false 统一关闭常规调试日志（console.log / console.warn）
const ENABLE_LOG = false;

if (!ENABLE_LOG) {
  console.log = () => { };
  console.warn = () => { };
}

console.log('%c[Raid Helper] v2.0 — 状态机引擎已加载。', 'color: #00f2fe; font-weight: bold;');

// ── 注入扩展 ID 到 DOM 中，方便自动化测试工具读取 ──────────────
(function () {
  if (typeof document !== 'undefined') {
    const testDiv = document.createElement('div');
    testDiv.id = 'agentank-helper-extension-id';
    testDiv.setAttribute('data-extension-id', isContextValid() ? chrome.runtime.id : '');
    testDiv.style.display = 'none';
    document.body.appendChild(testDiv);
  }
})();

// ── 常量定义 ────────────────────────────────────────────────
const POLL_FAST = 1500;   // 1.5秒 — 菜单和模态框的检测频率
const POLL_BATTLE = 4000;   // 4秒   — 战斗进行中的检测频率（降低频率以减少资源占用）
const POLL_SLOW = 3000;   // 3秒   — 兜底/未知状态的检测频率
const CLICK_COOLDOWN = 1800; // 点击冷却时间（毫秒），防止按钮被快速重复点击

// 战术撤离层数配置默认值
const defaultEvacConfig = {
  stage1Layer: 3,  // 阶段一结算关卡（核心不足1个时撤离）
  stage2Layer: 5,  // 阶段二结算关卡（核心不足2个时撤离）
  maxLayer: 7      // 强制撤离关卡（无条件撤离）
};
let evacConfig = { ...defaultEvacConfig };

// 强化技能选择优先级（数组下标越小，优先级越高）
// “备用核心”具有绝对最高优先级，在代码中进行了特殊判断和处理，不在此列表中
const ENHANCE_PRIORITY = ['自动护盾', '宝物磁场', '技能冷却', '开局推进'];

// ── 侧边栏及运行时长统计全局变量 ─────────────────────────────────
let sidebarCollapsed = false;
let statClicksCount = 0;
let statStartTime = null;
let statElapsedTime = 0;
let isLastStateUnknown = false; // 标记上一次探测是否是未知状态，防止诊断 Warn 刷屏

// ── 游戏运行状态数据 ───────────────────────────────────────────────
const gameState = {
  currentLayer: 0,       // 当前挑战的关卡层数
  enhancements: {},      // 已获得的强化技能记录，格式如：{ '强化名称': 获得次数 }
  stars: 0,              // 当前持有的星星数量
  dust: 0,               // 当前持有的星屑数量
  totalRuns: 0,          // 本次运行总出击次数
  // totalWins 已废弃，改用 bestDepth 记录最高层数
  totalEvacuations: 0,   // 本次运行总撤离次数
  totalLosses: 0,        // 本次运行总失败次数
  bestDepth: 0,          // 历史最高挑战关卡层数
  lastAction: '',        // 上一次执行的动作名称
  lastActionTime: 0,     // 上一次动作的时间戳（毫秒）
  initialDust: null,     // 首次出击时记录的初始星屑数量（用于计算盈亏）
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
        const newClicks = (r.statClicks || 0) + 1;
        chrome.storage.local.set({ statClicks: newClicks });

        // 原地更新侧边栏 UI，消除延迟
        statClicksCount = newClicks;
        const clicksEl = document.getElementById('sb-stat-clicks');
        if (clicksEl) clicksEl.textContent = newClicks;
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
  // 0) 核心守卫：如果当前页面不存在出击主容器 .raid-shell，说明未处于出击页面，直接静默退出
  const shell = document.querySelector('.raid-shell');
  if (!shell) {
    return { state: 'UNKNOWN' };
  }

  const shellClasses = Array.from(shell.classList).join(', ');

  // 1) 优先检测模态弹框（它们层级最高，会覆盖在基础容器之上）
  // 检查唯一真实的胜利/失败结算弹框 raidRewardModal
  const rewardModal = $('raidRewardModal');
  let rewardShowing = isModalShowing(rewardModal);

  // 兜底一：如果页面上已经显示了可见的三选一强化按钮，强行认为 rewardModal 处于显示状态
  const firstChoice = document.querySelector('.raid-choice');
  if (!rewardShowing && firstChoice && isVisible(firstChoice)) {
    rewardShowing = true;
  }

  // 兜底二：如果页面上显示了失败确认按钮，强行认为 rewardModal 处于显示状态
  const fallbackLossBtn = $('raidLossConfirmBtn');
  if (!rewardShowing && fallbackLossBtn && isVisible(fallbackLossBtn)) {
    rewardShowing = true;
  }

  if (rewardShowing) {
    const modal = rewardModal || (firstChoice && firstChoice.closest('.raid-modal')) || (fallbackLossBtn && fallbackLossBtn.closest('.raid-modal')) || document.body;
    return detectRewardModalState(modal);
  }

  // 检查开始游戏选择坦克的弹框
  const startModal = $('raidStartModal') || document.querySelector('#raidStartModal');
  const startShowing = isModalShowing(startModal);
  if (startShowing) {
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
  // 引入极强的串行可见性筛选，防止隐藏元素导致短路
  let startBtn = $('raidStartBtn');
  if (!startBtn || !isVisible(startBtn)) {
    startBtn = document.querySelector('.raid-home-start');
  }
  if (!startBtn || !isVisible(startBtn)) {
    startBtn = findButtonByText('开始游戏');
  }
  if (!startBtn || !isVisible(startBtn)) {
    startBtn = document.querySelector('.raid-home-view button.raid-primary');
  }

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

  // 输出调试诊断信息，帮助一步到位排查选择器问题
  const visibleButtons = [];
  document.querySelectorAll('button').forEach(btn => {
    if (isVisible(btn)) {
      visibleButtons.push(`${btn.textContent.trim()}(class: ${btn.className})`);
    }
  });

  // 只有在第一次进入未知态时，才输出警告，防控制台刷爆
  if (!isLastStateUnknown) {
    console.warn(`[Raid Helper Debug] detectState无法匹配任何已知状态。诊断信息：
    - shell classList: [${shellClasses}]
    - rewardModal显示: ${rewardShowing}
    - 页面可见按钮: ${JSON.stringify(visibleButtons)}`);
    isLastStateUnknown = true;
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
 * - 层数 < stage1Layer：必定不撤离（前置关卡绝对安全且用于堆战力，选择强化继续挑战）
 * - 阶段一结算（[stage1Layer, stage2Layer)）：如果预期备用核心累计数量 == 0（无复活核心且本次也选不到），立即撤离并保存
 * - 阶段二结算（[stage2Layer, maxLayer)）：如果预期备用核心累计数量 < 2（核心命数少于2且本次也选不到以满级），立即撤离并保存
 * - 达到或超过 maxLayer 层：无条件选择撤离并保存（稳健保分锁收益）
 * @param {number} layer 当前胜利的关卡层数
 * @param {array} enhancements 当前可选的强化列表
 * @returns {boolean} 是否应该撤离并保存
 */
function shouldEvacuate(layer, enhancements = []) {
  // 获取当前局拥有的备用核心数量
  const coreCount = gameState.enhancements['备用核心'] || 0;
  // 检查当前三选一强化技能中是否包含尚未满级的“备用核心”
  const hasCoreInChoices = enhancements.some(e => e.name.includes('备用核心') && e.currentLv < e.maxLv);
  // 计算加上本次可能选到的核心后的预期核心数
  const potentialCoreCount = coreCount + (hasCoreInChoices ? 1 : 0);

  // 1. 低于阶段一设定的层数总是继续
  if (layer < evacConfig.stage1Layer) {
    log(`第${layer}层: 继续挑战 (<${evacConfig.stage1Layer}层总是继续)`, 'state');
    return false;
  }

  // 2. 第一阶段结算层数判定范围内
  if (layer >= evacConfig.stage1Layer && layer < evacConfig.stage2Layer) {
    if (potentialCoreCount === 0) {
      log(`第${layer}层胜利结算: 撤离 (无备用核心且当前无可选择核心, 风险较高)`, 'warn');
      return true;
    }
    log(`第${layer}层胜利结算: 继续 (预期拥有 ${potentialCoreCount} 个备用核心，继续挑战高层)`, 'state');
    return false;
  }

  // 3. 第二阶段结算层数判定范围内
  if (layer >= evacConfig.stage2Layer && layer < evacConfig.maxLayer) {
    if (potentialCoreCount < 2) {
      log(`第${layer}层胜利结算: 撤离 (预期备用核心数 ${potentialCoreCount} < 2, 保守落袋)`, 'warn');
      return true;
    }
    log(`第${layer}层胜利结算: 继续 (预期备用核心数已满级 ${potentialCoreCount} >= 2, 挑战终极层)`, 'state');
    return false;
  }

  // 4. 达到或超过最大强制撤离层数
  log(`第${layer}层胜利结算: 撤离 (已达成或超过${evacConfig.maxLayer}层, 强制撤离保收益)`, 'warn');
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
  // 默认开启：只有当显式设置为 false 时才不运行
  const masterActive = config.masterActive !== false;

  // 打印调试心跳日志
  console.log(`[Raid Helper Debug] processAutomation心跳检测 | masterActive: ${masterActive}`);

  if (!masterActive) return POLL_SLOW;

  // 探测当前所在页面状态
  const detected = detectState();

  // 将最新状态数据同步存储，以便 popup 控制面板刷新展示
  syncStateToStorage(detected);

  switch (detected.state) {

    // ─── 出击主页面大厅 ─────────────────────────────────
    case 'MAIN_PAGE': {
      isLastStateUnknown = false;
      log(`出击大厅 | 星星: ${detected.stars} | 星屑: ${detected.dust} | canStart: ${detected.canStart}`, 'state');

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
        let startBtn = $('raidStartBtn');
        if (!startBtn || !isVisible(startBtn)) {
          startBtn = document.querySelector('.raid-home-start');
        }
        if (!startBtn || !isVisible(startBtn)) {
          startBtn = findButtonByText('开始游戏');
        }
        if (!startBtn || !isVisible(startBtn)) {
          startBtn = document.querySelector('.raid-home-view button.raid-primary');
        }
        if (startBtn && safeClick(startBtn, '开始游戏(主页)')) {
          lastStartClickTime = Date.now();
          gameState.currentLayer = 0;       // 新出击局，重置层数计数
          gameState.enhancements = {};      // 重置已获得强化列表
          gameState.totalRuns++;            // 出击局数累加
          // 首次出击时记录初始星屑，用于计算盈亏
          if (gameState.initialDust === null) {
            gameState.initialDust = detected.dust;
            log('记录初始星屑: ' + detected.dust, 'info');
          }
          return POLL_FAST;
        }
      }

      // 星星归零，打开仓库自动变现/兑换
      if (detected.stars <= 0) {
        let warehouseBtn = document.querySelector('.raid-secondary');
        if (!warehouseBtn || !isVisible(warehouseBtn)) {
          warehouseBtn = findButtonByText('打开仓库');
        }
        if (warehouseBtn && isEnabled(warehouseBtn) && isVisible(warehouseBtn)) {
          log('星星不足, 打开仓库变现/兑换', 'warn');
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
      isLastStateUnknown = false;
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
      isLastStateUnknown = false;
      log('处于战斗中，等待关卡挑战结果...', 'state');

      // 诊断用局部变量：查询当前页面上的奖励弹框和强化选项元素
      const rModal = $('raidRewardModal');
      const firstChoice = document.querySelector('.raid-choice');

      console.log(`[Raid Helper Debug] Battle状态诊断:
        - raidRewardModal存在: ${!!rModal}
        - raidRewardModal可见性(isModalShowing): ${rModal ? isModalShowing(rModal) : 'N/A'}
        - raidRewardModal.offsetWidth: ${rModal ? rModal.offsetWidth : 'N/A'}
        - 页面中.raid-choice选项存在: ${!!firstChoice}
        - .raid-choice选项可见性(isVisible): ${firstChoice ? isVisible(firstChoice) : 'N/A'}
      `);  // 注意：rModal 和 firstChoice 为本 case 分支内的局部变量

      // 战斗是自动进行的，插件保持观察，延长轮询周期以降低资源占用
      return POLL_BATTLE;
    }

    // ─── 第N层获胜：技能强化与战术撤离决策 ──────────────────────
    case 'VICTORY_CHOICE': {
      isLastStateUnknown = false;
      const layer = detected.layer;
      gameState.currentLayer = Math.max(gameState.currentLayer, layer);
      gameState.bestDepth = Math.max(gameState.bestDepth, layer);

      log(`第${layer}层胜利! 可选强化: ${detected.enhancements.map(e => e.name).join(', ')}`, 'info');

      // 智能评估当前层数和命数是否满足撤退策略，若满则执行撤退落袋为安
      if (detected.canEscape && shouldEvacuate(layer, detected.enhancements)) {
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
      isLastStateUnknown = false;
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
      isLastStateUnknown = false;
      log('仓库界面', 'state');
      return handleWarehouse();
    }

    // ─── 过渡加载态 ───────────────────────────────────────────
    case 'LOADING': {
      isLastStateUnknown = false;
      log('页面正在加载中，等待加载完成...', 'state');
      return POLL_BATTLE;
    }

    // ─── 未知态兜底 ───────────────────────────────────────────
    default: {
      log('无法识别当前页面状态，已输出诊断日志，等待重新检测...', 'warn');
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

  // 如果既没有星星也没有星屑（无资源可用），留在仓库等待挂机产出宝物，避免与大厅频繁循环跳转
  if (stars <= 0 && dust <= 0) {
    log('无可用星星与星屑，留在仓库等待挂机宝物产出...', 'state');
    return POLL_SLOW;
  }

  return POLL_FAST;
}

// ── 插件状态共享与保存 ────────────────────────────────────

/**
 * 将最新的状态数据刷新同步至侧边栏 DOM 和 chrome.storage.local
 * @param {object} detected 识别出的当前状态详情对象
 */
function syncStateToStorage(detected) {
  // 1. 同步更新网页内的悬浮侧边栏 UI，实现零通信延迟
  updateSidebarUI(detected);

  // 2. 同步存储至 local 作为持久化备份
  if (!isContextValid()) return;
  try {
    chrome.storage.local.set({
      raidState: detected.state,
      raidLayer: gameState.currentLayer,
      raidEnhancements: gameState.enhancements,
      raidStars: gameState.stars,
      raidDust: gameState.dust,
      raidTotalRuns: gameState.totalRuns,
      raidTotalEvacuations: gameState.totalEvacuations,
      raidTotalLosses: gameState.totalLosses,
      raidBestDepth: gameState.bestDepth,
      raidLastAction: gameState.lastAction,
    });
  } catch (e) {
    console.warn('[Raid Helper] Failed to sync state to storage:', e.message);
  }
}

// ── 侧边栏 DOM 初始化与渲染 ──────────────────────────────────────────

const stateNames = {
  'MAIN_PAGE': '🏠 出击大厅',
  'START_CONFIRM': '🎯 选择坦克',
  'BATTLE': '⚔️ 战斗中',
  'VICTORY_CHOICE': '🏆 胜利选技能',
  'DEFEAT': '💀 战斗失败',
  'WAREHOUSE': '📦 仓库管理',
  'LOADING': '⏳ 加载中',
  'UNKNOWN': '❓ 未知',
};

/**
 * 在游戏页面中动态创建并注入固定浮动的控制面板侧边栏
 */
function initSidebar() {
  if (typeof document === 'undefined') return;

  // 1. 检查是否已存在侧边栏，防止重复注入
  if (document.getElementById('agentankSidebar')) return;

  // 2. 创建侧边栏根容器
  const sidebar = document.createElement('div');
  sidebar.className = 'agentank-sidebar';
  sidebar.id = 'agentankSidebar';

  // 3. 初始同步默认状态（主开关默认开启，侧边栏不折叠）
  sidebarCollapsed = false;
  statStartTime = Date.now(); // 默认开启时立即开始计时
  statElapsedTime = 0;
  statClicksCount = 0;

  // 每次重新进入页面时，清零 storage 中的运行时长记录，确保计时器从零开始
  if (isContextValid()) {
    try {
      chrome.storage.local.set({ statStartTime: statStartTime, statElapsedTime: 0, statClicks: 0 });
    } catch (e) { /* 静默忽略 */ }
  }

  const isMasterActive = true; // 默认开启，等待异步补丁加载

  // 4. 构建侧边栏内部 HTML 骨架
  sidebar.innerHTML = `
    <div class="agentank-sidebar-toggle" id="agentankSidebarToggle">
      <span id="agentankSidebarToggleArrow">${sidebarCollapsed ? '‹' : '›'}</span>
    </div>
    <header class="app-header">
      <div class="logo-area">
        <span class="logo-glow"></span>
        <h1 class="logo-text">Agentank <span>Raid</span></h1>
      </div>
      <div class="version-tag">v2.2.8</div>
    </header>
    <div class="status-card ${isMasterActive ? 'active-state' : ''}" id="sb-status-card">
      <div class="status-indicator">
        <span class="pulse-dot ${isMasterActive ? 'active' : 'idle'}" id="sb-status-dot"></span>
        <span class="status-text" id="sb-status-text">${isMasterActive ? '正在出击' : '未运行'}</span>
      </div>
      <div class="master-switch-container">
        <span class="switch-label">主开关</span>
        <label class="switch">
          <input type="checkbox" id="sb-master-switch" ${isMasterActive ? 'checked' : ''}>
          <span class="slider"></span>
        </label>
      </div>
    </div>
    <section class="section">
      <h2 class="section-title">实时状态</h2>
      <div class="state-card">
        <div class="state-row">
          <span class="state-label">当前阶段</span>
          <span class="state-value" id="sb-current-state">—</span>
        </div>
        <div class="state-row">
          <span class="state-label">当前层数</span>
          <span class="state-value highlight" id="sb-current-layer">0</span>
        </div>
        <div class="state-row">
          <span class="state-label">⭐ 星星</span>
          <span class="state-value" id="sb-current-stars">0</span>
        </div>
        <div class="state-row">
          <span class="state-label">✨ 星屑</span>
          <span class="state-value" id="sb-current-dust">0</span>
        </div>
        <div class="state-row">
          <span class="state-label">📊 星屑盈亏</span>
          <span class="state-value" id="sb-dust-profit">—</span>
        </div>
        <div class="state-row">
          <span class="state-label">最近操作</span>
          <span class="state-value small" id="sb-last-action">—</span>
        </div>
      </div>
    </section>
    <section class="section">
      <h2 class="section-title">撤离设置</h2>
      <div class="state-card">
        <div class="state-row">
          <span class="state-label">阶段一结算层数</span>
          <input type="number" id="sb-cfg-stage1-layer" class="sb-input-num" min="1" max="15" value="${evacConfig.stage1Layer}">
        </div>
        <div class="state-row" style="margin-top: -2px; margin-bottom: 4px;">
          <span class="sb-tip-text">ℹ️ 备用核心要求固定默认：&lt; 1 个</span>
        </div>
        <div class="state-row">
          <span class="state-label">阶段二结算层数</span>
          <input type="number" id="sb-cfg-stage2-layer" class="sb-input-num" min="1" max="15" value="${evacConfig.stage2Layer}">
        </div>
        <div class="state-row" style="margin-top: -2px; margin-bottom: 4px;">
          <span class="sb-tip-text">ℹ️ 备用核心要求固定默认：&lt; 2 个</span>
        </div>
        <div class="state-row">
          <span class="state-label">强制撤离层数</span>
          <input type="number" id="sb-cfg-max-layer" class="sb-input-num" min="1" max="20" value="${evacConfig.maxLayer}">
        </div>
      </div>
    </section>
    <section class="section">
      <h2 class="section-title">当前强化</h2>
      <div class="enhance-list" id="sb-enhance-list">
        <span class="enhance-empty">暂无强化</span>
      </div>
    </section>
    <section class="section">
      <h2 class="section-title">战绩统计</h2>
      <div class="stats-container">
        <div class="stat-box">
          <span class="stat-val" id="sb-stat-runs">0</span>
          <span class="stat-lbl">总出击</span>
        </div>
        <div class="stat-box">
          <span class="stat-val" id="sb-stat-best-depth">0</span>
          <span class="stat-lbl">最高层</span>
        </div>
        <div class="stat-box">
          <span class="stat-val" id="sb-stat-evacuations">0</span>
          <span class="stat-lbl">撤离次</span>
        </div>
        <div class="stat-box">
          <span class="stat-val" id="sb-stat-losses">0</span>
          <span class="stat-lbl">失败次</span>
        </div>
      </div>
      <div class="stats-container" style="margin-top: 4px;">
        <div class="stat-box">
          <span class="stat-val" id="sb-stat-clicks">0</span>
          <span class="stat-lbl">点击次数</span>
        </div>
        <div class="stat-box">
          <span class="stat-val" id="sb-stat-time">00:00:00</span>
          <span class="stat-lbl">运行时长</span>
        </div>
      </div>
    </section>
    <section class="section">
      <h2 class="section-title">操作日志</h2>
      <div class="log-container" id="sb-log-container">
        <div class="log-empty">等待启动...</div>
      </div>
    </section>
    <footer class="app-footer">
      <p>🎯 目标: 赢取更多星屑</p>
    </footer>
  `;

  document.body.appendChild(sidebar);

  // 5. 后台异步拉取真实配置并更新 UI，不阻塞挂载与主循环流程
  if (isContextValid()) {
    chrome.storage.local.get([
      'sidebarCollapsed', 'masterActive',
      'statStartTime', 'statElapsedTime', 'statClicks',
      'raidEvacConfig'
    ], r => {
      if (!r) return;

      // 刷新折叠状态
      if (r.sidebarCollapsed) {
        sidebarCollapsed = true;
        sidebar.classList.add('is-collapsed');
        const arrowSpan = document.getElementById('agentankSidebarToggleArrow');
        if (arrowSpan) arrowSpan.textContent = '‹';
      }

      // 刷新主开关勾选状态（只有显式为 false 时才关闭）
      if (r.masterActive === false) {
        const masterSwitch = document.getElementById('sb-master-switch');
        if (masterSwitch) masterSwitch.checked = false;
        const statusDot = document.getElementById('sb-status-dot');
        if (statusDot) statusDot.className = 'pulse-dot idle';
        const statusText = document.getElementById('sb-status-text');
        if (statusText) statusText.textContent = '未运行';
        const statusCard = document.getElementById('sb-status-card');
        if (statusCard) statusCard.classList.remove('active-state');
      }

      // 同步内存统计变量
      statStartTime = r.statStartTime || null;
      statElapsedTime = r.statElapsedTime || 0;
      statClicksCount = r.statClicks || 0;

      // 同步撤离设置变量并回填 UI
      if (r.raidEvacConfig) {
        evacConfig = { ...evacConfig, ...r.raidEvacConfig };
        const inStage1 = document.getElementById('sb-cfg-stage1-layer');
        if (inStage1) inStage1.value = evacConfig.stage1Layer;
        const inStage2 = document.getElementById('sb-cfg-stage2-layer');
        if (inStage2) inStage2.value = evacConfig.stage2Layer;
        const inMax = document.getElementById('sb-cfg-max-layer');
        if (inMax) inMax.value = evacConfig.maxLayer;
      }
    });
  }

  // 6. 绑定展开/收起拉手的点击事件
  const toggleBtn = document.getElementById('agentankSidebarToggle');
  const arrowSpan = document.getElementById('agentankSidebarToggleArrow');
  toggleBtn.addEventListener('click', () => {
    sidebarCollapsed = !sidebarCollapsed;
    if (sidebarCollapsed) {
      sidebar.classList.add('is-collapsed');
      arrowSpan.textContent = '‹';
    } else {
      sidebar.classList.remove('is-collapsed');
      arrowSpan.textContent = '›';
    }
    if (isContextValid()) {
      chrome.storage.local.set({ sidebarCollapsed });
    }
  });

  // 7. 绑定撤离设置输入框的 change 监听与持久化
  const inStage1 = document.getElementById('sb-cfg-stage1-layer');
  const inStage2 = document.getElementById('sb-cfg-stage2-layer');
  const inMax = document.getElementById('sb-cfg-max-layer');

  const saveEvacConfig = () => {
    const stage1 = parseInt(inStage1.value, 10) || defaultEvacConfig.stage1Layer;
    const stage2 = parseInt(inStage2.value, 10) || defaultEvacConfig.stage2Layer;
    const maxL = parseInt(inMax.value, 10) || defaultEvacConfig.maxLayer;
    evacConfig = {
      stage1Layer: stage1,
      stage2Layer: stage2,
      maxLayer: maxL
    };
    if (isContextValid()) {
      chrome.storage.local.set({ raidEvacConfig: evacConfig });
    }
    log(`撤离层数配置更新: 阶段一 ${stage1}层(核心<1), 阶段二 ${stage2}层(核心<2), 强撤 ${maxL}层`, 'info');
  };

  if (inStage1) inStage1.addEventListener('change', saveEvacConfig);
  if (inStage2) inStage2.addEventListener('change', saveEvacConfig);
  if (inMax) inMax.addEventListener('change', saveEvacConfig);

  // 6. 绑定控制台主开关的勾选改变事件
  const masterSwitch = document.getElementById('sb-master-switch');
  const statusDot = document.getElementById('sb-status-dot');
  const statusText = document.getElementById('sb-status-text');
  const statusCard = document.getElementById('sb-status-card');

  masterSwitch.addEventListener('change', () => {
    const val = masterSwitch.checked;
    if (val) {
      statusDot.className = 'pulse-dot active';
      statusText.textContent = '正在出击';
      statusCard.classList.add('active-state');
      statStartTime = Date.now();
      if (isContextValid()) {
        chrome.storage.local.set({ masterActive: true, statStartTime });
      }
    } else {
      statusDot.className = 'pulse-dot idle';
      statusText.textContent = '未运行';
      statusCard.classList.remove('active-state');
      const elapsed = Date.now() - (statStartTime || Date.now());
      statElapsedTime += elapsed;
      statStartTime = null;
      if (isContextValid()) {
        chrome.storage.local.set({ masterActive: false, statStartTime: null, statElapsedTime });
      }
    }
  });

  // 7. 开启运行时长每秒时钟刷新
  setInterval(updateTimeDisplay, 1000);
}

/**
 * 格式化并每秒刷新侧边栏上展示的运行时长
 */
function updateTimeDisplay() {
  const timeVal = document.getElementById('sb-stat-time');
  if (!timeVal) return;

  const formatMs = (ms) => {
    let sec = Math.floor(ms / 1000);
    let min = Math.floor(sec / 60);
    sec = sec % 60;
    let hr = Math.floor(min / 60);
    min = min % 60;
    return `${String(hr).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  };

  let currentElapsed = statElapsedTime || 0;
  if (statStartTime) {
    currentElapsed += (Date.now() - statStartTime);
  }
  timeVal.textContent = formatMs(currentElapsed);
}

/**
 * 原地渲染更新侧边栏各数据看板
 * @param {object} detected 识别出的当前状态详情对象
 */
function updateSidebarUI(detected) {
  // 当前阶段
  const stateEl = document.getElementById('sb-current-state');
  if (stateEl) stateEl.textContent = stateNames[detected.state] || '—';

  // 当前层数
  const layerEl = document.getElementById('sb-current-layer');
  if (layerEl) layerEl.textContent = gameState.currentLayer;

  // 星星与星屑
  const starsEl = document.getElementById('sb-current-stars');
  if (starsEl) starsEl.textContent = gameState.stars;
  const dustEl = document.getElementById('sb-current-dust');
  if (dustEl) dustEl.textContent = gameState.dust;

  // 星屑盈亏计算与渲染
  const dustProfitEl = document.getElementById('sb-dust-profit');
  if (dustProfitEl) {
    if (gameState.initialDust !== null) {
      const diff = gameState.dust - gameState.initialDust;
      const sign = diff > 0 ? '+' : '';
      dustProfitEl.textContent = sign + diff;
      // 盈利绿色、亏损红色、平衡默认色
      if (diff > 0) {
        dustProfitEl.style.color = '#10b981';
        dustProfitEl.style.textShadow = '0 0 8px rgba(16, 185, 129, 0.3)';
      } else if (diff < 0) {
        dustProfitEl.style.color = '#ef4444';
        dustProfitEl.style.textShadow = '0 0 8px rgba(239, 68, 68, 0.3)';
      } else {
        dustProfitEl.style.color = '#9ca3af';
        dustProfitEl.style.textShadow = 'none';
      }
    } else {
      dustProfitEl.textContent = '等待出击';
      dustProfitEl.style.color = '#9ca3af';
      dustProfitEl.style.textShadow = 'none';
    }
  }

  // 最近操作
  const actionEl = document.getElementById('sb-last-action');
  if (actionEl) actionEl.textContent = gameState.lastAction || '—';

  // 强化卡片渲染
  const enhanceList = document.getElementById('sb-enhance-list');
  if (enhanceList) {
    const keys = Object.keys(gameState.enhancements).filter(k => gameState.enhancements[k] > 0);
    if (keys.length > 0) {
      enhanceList.innerHTML = keys.map(k =>
        `<span class="enhance-chip">${k} <b>×${gameState.enhancements[k]}</b></span>`
      ).join('');
    } else {
      enhanceList.innerHTML = '<span class="enhance-empty">暂无强化</span>';
    }
  }

  // 战绩数据统计
  const runsEl = document.getElementById('sb-stat-runs');
  if (runsEl) runsEl.textContent = gameState.totalRuns;
  const bestDepthEl = document.getElementById('sb-stat-best-depth');
  if (bestDepthEl) bestDepthEl.textContent = gameState.bestDepth;
  const evacsEl = document.getElementById('sb-stat-evacuations');
  if (evacsEl) evacsEl.textContent = gameState.totalEvacuations;
  const lossesEl = document.getElementById('sb-stat-losses');
  if (lossesEl) lossesEl.textContent = gameState.totalLosses;

  // 累计点击次数
  const clicksEl = document.getElementById('sb-stat-clicks');
  if (clicksEl) clicksEl.textContent = statClicksCount;

  // 渲染操作日志
  const logContainer = document.getElementById('sb-log-container');
  if (logContainer) {
    if (logEntries.length === 0) {
      logContainer.innerHTML = '<div class="log-empty">等待启动...</div>';
    } else {
      const levelColors = {
        info: 'log-info',
        warn: 'log-warn',
        error: 'log-error',
        action: 'log-action',
        state: 'log-state',
      };
      logContainer.innerHTML = logEntries.slice().reverse().map(entry => {
        const cls = levelColors[entry.level] || 'log-info';
        return `<div class="log-entry ${cls}"><span class="log-ts">${entry.ts}</span> ${entry.msg}</div>`;
      }).join('');
    }
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

// ── 插件生命周期初始化 ─────────────────────────────────────────────
// URL 路径守卫：仅在 /raid 页面注入侧边栏和启动自动化循环
if (window.location.pathname.startsWith('/raid')) {
  initSidebar();
  startLoop(POLL_FAST); // 以快速轮询探测状态拉起运行
} else {
  console.log('%c[Raid Helper] 非出击页面，侧边栏不注入。', 'color: #9ca3af;');
}

// 监听通信消息（保留向后兼容）
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

