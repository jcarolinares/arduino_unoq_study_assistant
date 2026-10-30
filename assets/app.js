// SPDX-FileCopyrightText: Copyright (C) Arduino s.r.l. and/or its affiliated companies
//
// SPDX-License-Identifier: MPL-2.0

const $ = id => document.getElementById(id);
const LOCALE = 'en-GB';
const DAY_MS = 86400000;
const PHONE_IN_VIEW_TIMEOUT_MS = 3000;

let phoneEvents = []; // Epoch milliseconds of each phone detection, sent by the board
let lastPhoneSeen = 0;

// ---------- Storage helpers (per browser) ----------
function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}
const todayKey = () => new Date().toDateString();

// ---------- Time helpers ----------
function startOfDay(d = new Date()) {
  const s = new Date(d);
  s.setHours(0, 0, 0, 0);
  return s.getTime();
}
function formatDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - yearStart) / DAY_MS + 1) / 7);
}

// ---------- WebSocket ----------
const ui = new WebUI();
ui.on_connect(() => {
  $('connection').className = 'status online';
  $('connection-text').textContent = 'Board connected';
  ui.send_message('get_stats', {});
  ui.send_message('override_th', parseFloat($('confidenceSlider').value));
});
ui.on_disconnect(() => {
  $('connection').className = 'status offline';
  $('connection-text').textContent = 'Connection lost';
});
ui.on_message('stats', msg => {
  phoneEvents = (msg.events || []).map(t => t * 1000).sort((a, b) => a - b);
  renderPhoneStats();
});
ui.on_message('phone_event', () => {
  const el = $('today-count');
  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');
  showToast('📱 Phone detected — put it away and keep focusing!');
});
ui.on_message('detection', msg => {
  if (msg.content === 'cell phone') {
    lastPhoneSeen = Date.now();
    updatePhoneBadge();
  }
});

// ---------- Clock ----------
function greetingFor(h) {
  if (h < 5) return 'Late night study session 🌙';
  if (h < 12) return 'Good morning ☀️';
  if (h < 18) return 'Good afternoon 📖';
  return 'Good evening 🌆';
}
function renderClock() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  $('clock').innerHTML = `${hh}:${mm}<span class="seconds">:${ss}</span>`;
  $('weekday').textContent = now.toLocaleDateString(LOCALE, { weekday: 'long' });
  $('date').textContent = now.toLocaleDateString(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' });
  $('greeting').textContent = greetingFor(now.getHours());

  const sod = startOfDay(now);
  const pct = ((now - sod) / DAY_MS) * 100;
  $('day-progress-bar').style.width = pct.toFixed(2) + '%';
  $('day-progress-pct').textContent = Math.floor(pct) + '%';
  $('week-number').textContent = isoWeek(now);
  $('day-of-year').textContent = Math.floor((sod - new Date(now.getFullYear(), 0, 1)) / DAY_MS) + 1;
  const left = sod + DAY_MS - now;
  $('until-midnight').textContent = `${Math.floor(left / 3600000)}h ${String(Math.floor((left % 3600000) / 60000)).padStart(2, '0')}m`;
}

// ---------- Phone stats ----------
let lastRenderedDay = todayKey();

function updatePhoneBadge() {
  const badge = $('phone-badge');
  const inView = Date.now() - lastPhoneSeen < PHONE_IN_VIEW_TIMEOUT_MS;
  badge.classList.toggle('alert', inView);
  badge.textContent = inView ? 'Phone in view!' : 'No phone in view';
}

function renderPhoneStats() {
  const now = Date.now();
  const sod = startOfDay();
  const today = phoneEvents.filter(t => t >= sod);
  const yesterday = phoneEvents.filter(t => t >= sod - DAY_MS && t < sod).length;

  $('today-count').textContent = today.length;

  const cmp = $('compare-yesterday');
  const diff = today.length - yesterday;
  if (yesterday === 0 && today.length === 0) {
    cmp.textContent = 'No distractions so far — great job!';
    cmp.className = 'compare good';
  } else if (diff < 0) {
    cmp.textContent = `${-diff} fewer than yesterday (${yesterday})`;
    cmp.className = 'compare good';
  } else if (diff > 0) {
    cmp.textContent = `${diff} more than yesterday (${yesterday})`;
    cmp.className = 'compare bad';
  } else {
    cmp.textContent = `Same as yesterday (${yesterday})`;
    cmp.className = 'compare';
  }

  // Phone-free streaks: gaps between start of day, each detection, and now
  const last = today.length ? today[today.length - 1] : null;
  $('free-streak').textContent = formatDuration(now - (last ?? sod));
  let best = 0;
  let prev = sod;
  for (const t of today) {
    best = Math.max(best, t - prev);
    prev = t;
  }
  best = Math.max(best, now - prev);
  $('best-streak').textContent = formatDuration(best);
  $('last-detection').textContent = last
    ? new Date(last).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })
    : 'None today';

  // Focus score: fewer detections per focused hour is better
  const focusedMin = sessionsToday().reduce((a, x) => a + (x.minutes || 0), 0);
  let score;
  if (today.length === 0) score = 100;
  else {
    const hours = Math.max(1, focusedMin / 60);
    score = Math.max(0, Math.round(100 - (today.length / hours) * 15));
  }
  const emoji = score >= 80 ? '🟢' : score >= 50 ? '🟡' : '🔴';
  $('focus-score').textContent = `${emoji} ${score}/100`;

  renderHourChart(today);
  renderWeekChart();
}

function renderHourChart(today) {
  const counts = new Array(24).fill(0);
  today.forEach(t => counts[new Date(t).getHours()]++);
  const max = Math.max(1, ...counts);
  const currentHour = new Date().getHours();
  const chart = $('hour-chart');
  chart.innerHTML = '';
  counts.forEach((c, h) => {
    const bar = document.createElement('div');
    bar.className = 'hour-bar' + (c ? ' has' : '') + (h === currentHour ? ' now' : '');
    bar.style.height = (c / max) * 100 + '%';
    bar.title = `${String(h).padStart(2, '0')}:00 — ${c} detection${c === 1 ? '' : 's'}`;
    chart.appendChild(bar);
  });
  const peak = counts.indexOf(Math.max(...counts));
  $('peak-hour').textContent = today.length ? `Peak: ${String(peak).padStart(2, '0')}:00 (${counts[peak]})` : 'No detections yet';
}

function renderWeekChart() {
  const sod = startOfDay();
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const start = sod - i * DAY_MS;
    days.push({
      start,
      count: phoneEvents.filter(t => t >= start && t < start + DAY_MS).length,
      label: new Date(start).toLocaleDateString(LOCALE, { weekday: 'short' }),
    });
  }
  const max = Math.max(1, ...days.map(d => d.count));
  const chart = $('week-chart');
  chart.innerHTML = '';
  days.forEach((d, i) => {
    const col = document.createElement('div');
    col.className = 'week-col' + (i === 6 ? ' today' : '');
    col.innerHTML = `<span class="week-val">${d.count}</span>
      <div class="week-bar" style="height:${(d.count / max) * 75}%"></div>
      <span class="week-day">${d.label}</span>`;
    chart.appendChild(col);
  });
  $('week-total').textContent = `${days.reduce((a, d) => a + d.count, 0)} total`;
}

// ---------- Focus timer (runs on the board, the page only shows it and sends commands) ----------
const MODE_LABELS = { focus: 'Focus time', short: 'Short break', long: 'Long break' };
const RING = 2 * Math.PI * 52;
let timerState = { mode: 'focus', duration: 1500, remaining: 1500, running: false, phone_paused: false, sessions: [] };
let timerReceivedAt = Date.now();
let appStarted = null; // When the board app started; a change means it restarted with new code

$('timer-ring').style.strokeDasharray = RING;

function sessionsToday() {
  const sod = startOfDay() / 1000;
  return (timerState.sessions || []).filter(s => s.t >= sod);
}

function currentRemaining() {
  const r = timerState.running ? timerState.remaining - (Date.now() - timerReceivedAt) / 1000 : timerState.remaining;
  return Math.max(0, Math.ceil(r));
}

function renderTimer() {
  const { mode, duration, running, phone_paused: phonePaused } = timerState;
  const remaining = currentRemaining();
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  $('timer-time').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  $('timer-ring').style.strokeDashoffset = RING * (1 - remaining / duration);
  const card = document.querySelector('.timer-card');
  card.classList.toggle('phone-paused', phonePaused);
  card.classList.toggle('break', mode !== 'focus');
  const fresh = remaining >= duration;
  $('timer-label').textContent = phonePaused
    ? '📱 Phone detected'
    : running ? MODE_LABELS[mode] : fresh ? (mode === 'focus' ? 'Ready to focus' : 'Ready for a break') : 'Paused';
  $('timer-start').textContent = running ? 'Pause' : fresh && !phonePaused ? 'Start' : 'Resume';
  document.querySelectorAll('#timer-modes button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  const today = sessionsToday();
  $('sessions-today').textContent = today.length;
  $('focus-minutes').textContent = today.reduce((a, x) => a + (x.minutes || 0), 0) + ' min';
}

ui.on_message('timer', msg => {
  if (appStarted !== null && msg.app_started !== appStarted) {
    location.reload();
    return;
  }
  appStarted = msg.app_started;
  const prev = timerState;
  timerState = msg;
  timerReceivedAt = Date.now();
  if (prev.phone_paused && !msg.phone_paused && msg.running) {
    showToast('👍 Phone gone — focus timer resumed', 'info');
  } else if (prev.mode === 'focus' && msg.mode !== 'focus' && (msg.sessions || []).length > (prev.sessions || []).length) {
    showToast('🎉 Focus session complete — time for a break!', 'info');
    renderPhoneStats();
  } else if (prev.mode !== 'focus' && prev.running && msg.mode === 'focus' && !msg.running) {
    showToast('⏰ Break is over — back to work!', 'info');
  }
  renderTimer();
});

const timerCmd = (action, extra = {}) => ui.send_message('timer_cmd', { action, ...extra });
$('timer-start').addEventListener('click', () => timerCmd(timerState.running ? 'pause' : 'start'));
$('timer-reset').addEventListener('click', () => timerCmd('reset'));
document.querySelectorAll('#timer-modes button').forEach(b => b.addEventListener('click', () => timerCmd('mode', { mode: b.dataset.mode })));
setInterval(renderTimer, 250);

// ---------- Goals ----------
function getTasks() {
  return load('tasks', []);
}
function renderTasks() {
  const tasks = getTasks();
  const list = $('task-list');
  list.innerHTML = '';
  if (!tasks.length) {
    list.innerHTML = '<li class="task-empty">No goals yet. What do you want to get done today?</li>';
  }
  tasks.forEach((t, i) => {
    const li = document.createElement('li');
    li.className = t.done ? 'done' : '';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = t.done;
    cb.addEventListener('change', () => {
      const all = getTasks();
      all[i].done = cb.checked;
      save('tasks', all);
      renderTasks();
    });
    const span = document.createElement('span');
    span.textContent = t.text;
    const rm = document.createElement('button');
    rm.className = 'remove';
    rm.title = 'Remove';
    rm.textContent = '×';
    rm.addEventListener('click', () => {
      const all = getTasks();
      all.splice(i, 1);
      save('tasks', all);
      renderTasks();
    });
    li.append(cb, span, rm);
    list.appendChild(li);
  });
  const done = tasks.filter(t => t.done).length;
  $('tasks-progress').textContent = tasks.length ? `${done}/${tasks.length} done` : '';
}
$('task-form').addEventListener('submit', e => {
  e.preventDefault();
  const text = $('task-input').value.trim();
  if (!text) return;
  save('tasks', [...getTasks(), { text, done: false }]);
  $('task-input').value = '';
  renderTasks();
});

// ---------- Tips ----------
const TIPS = [
  'Put your phone in another room — out of sight really is out of mind.',
  'Use the 25/5 rhythm: 25 minutes of deep focus, then a 5 minute break away from screens.',
  'Explain what you just learned in your own words. If you can teach it, you know it.',
  'Test yourself instead of re-reading. Active recall beats highlighting every time.',
  'Space out your reviews: revisit a topic after 1 day, 3 days and 1 week.',
  'Drink a glass of water — even mild dehydration affects concentration.',
  'Start with the hardest task while your energy is highest.',
  'Break big goals into tasks you can finish in a single focus session.',
  'Mix different subjects or problem types in one session to learn them more deeply.',
  'Sleep is part of studying: your brain consolidates memories while you rest.',
  'During breaks, stand up and stretch or walk — your brain needs movement too.',
  'Keep a "distraction list" next to you: write down stray thoughts and come back to them later.',
];
let tipIndex = Math.floor(Math.random() * TIPS.length);
function showTip() {
  $('tip-text').textContent = TIPS[tipIndex];
}
$('next-tip').addEventListener('click', () => {
  tipIndex = (tipIndex + 1) % TIPS.length;
  showTip();
});

// ---------- Sensitivity ----------
const slider = $('confidenceSlider');
slider.value = load('confidence', 0.5);
$('confidenceValue').textContent = parseFloat(slider.value).toFixed(2);
slider.addEventListener('input', () => {
  const v = parseFloat(slider.value);
  $('confidenceValue').textContent = v.toFixed(2);
  save('confidence', v);
  ui.send_message('override_th', v);
});

// ---------- Toast ----------
let toastTimer;
function showToast(text, kind = '') {
  const t = $('toast');
  t.textContent = text;
  t.className = 'toast show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast ' + kind), 3500);
}

// ---------- Main loop ----------
function everySecond() {
  renderClock();
  updatePhoneBadge();
  if (todayKey() !== lastRenderedDay) {
    lastRenderedDay = todayKey();
    renderTimer();
  }
  renderPhoneStats();
}

renderClock();
renderTimer();
renderTasks();
showTip();
renderPhoneStats();
setInterval(everySecond, 1000);
setInterval(() => {
  tipIndex = (tipIndex + 1) % TIPS.length;
  showTip();
}, 60000);
