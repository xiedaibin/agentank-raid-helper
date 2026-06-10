document.addEventListener('DOMContentLoaded', () => {
  // ── Elements ──────────────────────────────────────────────
  const masterSwitch = document.getElementById('master-switch');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const statusCard = document.getElementById('status-card');
  const rapidReloadMaxInput = document.getElementById('cfg-rapid-reload-max');
  const dragPriorityList = document.getElementById('drag-priority-list');
  let localEnhancePriority = ['自动护盾', '宝物磁场', '技能冷却', '开局推进'];

  const currentState = document.getElementById('current-state');
  const currentLayer = document.getElementById('current-layer');
  const currentStars = document.getElementById('current-stars');
  const currentDust = document.getElementById('current-dust');
  const lastAction = document.getElementById('last-action');
  const enhanceList = document.getElementById('enhance-list');

  const statRuns = document.getElementById('stat-runs');
  const statWins = document.getElementById('stat-wins');
  const statEvacuations = document.getElementById('stat-evacuations');
  const statLosses = document.getElementById('stat-losses');
  const statClicks = document.getElementById('stat-clicks');
  const statTime = document.getElementById('stat-time');

  const logContainer = document.getElementById('log-container');

  // ── State name mapping ────────────────────────────────────
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

  // ── Load saved settings ───────────────────────────────────
  chrome.storage.local.get(['masterActive', 'rapidReloadMax', 'enhancePriority'], (result) => {
    const active = result.masterActive !== false;
    masterSwitch.checked = active;
    updateStatusUI(active);

    const maxVal = result.rapidReloadMax !== undefined ? result.rapidReloadMax : 2;
    rapidReloadMaxInput.value = maxVal;

    if (result.enhancePriority) {
      localEnhancePriority = result.enhancePriority;
    }
    renderPriorityList();
  });

  // ── Load and display all data ─────────────────────────────
  function refreshAll() {
    chrome.storage.local.get([
      'masterActive',
      'raidState', 'raidLayer', 'raidEnhancements',
      'raidStars', 'raidDust',
      'raidTotalRuns', 'raidTotalWins', 'raidTotalEvacuations', 'raidTotalLosses',
      'raidLastAction', 'raidBestDepth',
      'statClicks', 'statStartTime', 'statElapsedTime',
      'raidLog',
      'rapidReloadMax',
      'enhancePriority',
    ], (data) => {
      // Game state
      currentState.textContent = stateNames[data.raidState] || '—';
      currentLayer.textContent = data.raidLayer || 0;
      currentStars.textContent = data.raidStars ?? 0;
      currentDust.textContent = data.raidDust ?? 0;
      lastAction.textContent = data.raidLastAction || '—';

      // Enhancements
      const enhancements = data.raidEnhancements || {};
      const keys = Object.keys(enhancements).filter(k => enhancements[k] > 0);
      if (keys.length > 0) {
        enhanceList.innerHTML = keys.map(k =>
          `<span class="enhance-chip">${k} <b>×${enhancements[k]}</b></span>`
        ).join('');
      } else {
        enhanceList.innerHTML = '<span class="enhance-empty">暂无强化</span>';
      }

      // Stats
      statRuns.textContent = data.raidTotalRuns || 0;
      statWins.textContent = data.raidTotalWins || 0;
      statEvacuations.textContent = data.raidTotalEvacuations || 0;
      statLosses.textContent = data.raidTotalLosses || 0;
      if (data.statClicks !== undefined) {
        statClicks.textContent = data.statClicks;
      }

      // Timer
      const isMasterActive = data.masterActive !== false;
      updateTimerDisplay(data.statStartTime, data.statElapsedTime, isMasterActive);

      // Settings
      if (data.rapidReloadMax !== undefined && document.activeElement !== rapidReloadMaxInput) {
        rapidReloadMaxInput.value = data.rapidReloadMax;
      }

      if (data.enhancePriority) {
        localEnhancePriority = data.enhancePriority;
        renderPriorityList();
      }

      // Log
      renderLog(data.raidLog);
    });
  }

  refreshAll();

  // ── Update Status visual state ────────────────────────────
  function updateStatusUI(isActive) {
    if (isActive) {
      statusDot.className = 'pulse-dot active';
      statusText.textContent = '正在出击';
      statusCard.classList.add('active-state');
    } else {
      statusDot.className = 'pulse-dot idle';
      statusText.textContent = '未运行';
      statusCard.classList.remove('active-state');
    }
  }

  // ── Handle master switch ──────────────────────────────────
  masterSwitch.addEventListener('change', () => {
    const val = masterSwitch.checked;
    updateStatusUI(val);

    const updateObj = { masterActive: val };

    if (val) {
      const now = Date.now();
      updateObj.statStartTime = now;
    } else {
      chrome.storage.local.get(['statStartTime', 'statElapsedTime'], (res) => {
        const start = res.statStartTime || Date.now();
        const prevElapsed = res.statElapsedTime || 0;
        const newElapsed = prevElapsed + (Date.now() - start);
        chrome.storage.local.set({ statElapsedTime: newElapsed, statStartTime: null });
      });
    }

    chrome.storage.local.set(updateObj, () => {
      notifyContentScript();
    });
  });

  // ── Handle rapid reload limit ─────────────────────────────
  rapidReloadMaxInput.addEventListener('change', () => {
    let val = parseInt(rapidReloadMaxInput.value, 10);
    if (isNaN(val) || val < 0) val = 0;
    if (val > 3) val = 3;
    rapidReloadMaxInput.value = val;

    chrome.storage.local.set({ rapidReloadMax: val }, () => {
      notifyContentScript();
    });
  });

  // ── Handle priority drag sorting ──────────────────────────
  function renderPriorityList() {
    if (dragPriorityList.querySelector('.drag-item.dragging')) return;
    dragPriorityList.innerHTML = localEnhancePriority.map(name => `
      <div class="drag-item" draggable="true" data-name="${name}">
        <span class="drag-handle">☰</span>
        <span>${name}</span>
      </div>
    `).join('');
    bindDragEvents(dragPriorityList);
  }

  function bindDragEvents(container) {
    let dragEl = null;
    container.addEventListener('dragstart', (e) => {
      const item = e.target.closest('.drag-item');
      if (item) {
        dragEl = item;
        item.classList.add('dragging');
      }
    });

    container.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!dragEl) return;
      const afterElement = getDragAfterElement(container, e.clientY);
      if (afterElement == null) {
        container.appendChild(dragEl);
      } else {
        container.insertBefore(dragEl, afterElement);
      }
    });

    container.addEventListener('dragend', (e) => {
      const item = e.target.closest('.drag-item');
      if (item) {
        item.classList.remove('dragging');
      }
      dragEl = null;
      savePriorityConfig();
    });
  }

  function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('.drag-item:not(.dragging)')];
    return draggableElements.reduce((closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) {
        return { offset: offset, element: child };
      } else {
        return closest;
      }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
  }

  function savePriorityConfig() {
    const items = [...dragPriorityList.querySelectorAll('.drag-item')];
    const newPriority = items.map(item => item.getAttribute('data-name'));
    localEnhancePriority = newPriority;
    chrome.storage.local.set({ enhancePriority: newPriority }, () => {
      notifyContentScript();
    });
  }

  function notifyContentScript() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'config_updated' }, () => {
          if (chrome.runtime.lastError) { /* ignore */ }
        });
      }
    });
  }

  // ── Timer display ─────────────────────────────────────────
  let timerInterval;

  function updateTimerDisplay(startTime, elapsed = 0, isRunning = false) {
    if (timerInterval) clearInterval(timerInterval);

    const formatMs = (ms) => {
      let sec = Math.floor(ms / 1000);
      let min = Math.floor(sec / 60);
      sec = sec % 60;
      let hr = Math.floor(min / 60);
      min = min % 60;
      return `${String(hr).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    };

    const displayCurrent = () => {
      let currentElapsed = elapsed || 0;
      if (isRunning && startTime) {
        currentElapsed += (Date.now() - startTime);
      }
      statTime.textContent = formatMs(currentElapsed);
    };

    displayCurrent();

    if (isRunning && startTime) {
      timerInterval = setInterval(displayCurrent, 1000);
    }
  }

  // ── Render log entries ────────────────────────────────────
  function renderLog(entries) {
    if (!entries || entries.length === 0) {
      logContainer.innerHTML = '<div class="log-empty">等待启动...</div>';
      return;
    }

    const levelColors = {
      info: 'log-info',
      warn: 'log-warn',
      error: 'log-error',
      action: 'log-action',
      state: 'log-state',
    };

    logContainer.innerHTML = entries.slice().reverse().map(entry => {
      const cls = levelColors[entry.level] || 'log-info';
      return `<div class="log-entry ${cls}"><span class="log-ts">${entry.ts}</span> ${entry.msg}</div>`;
    }).join('');
  }

  // ── Live update via storage listener ──────────────────────
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local') {
      refreshAll();
    }
  });

  // Auto refresh every 2 seconds for live data
  setInterval(refreshAll, 2000);
});
