// ================================================================
// AutoTool Pro — app.js (Kiến trúc "Server Parsed / Client Download")
//
// LUỒNG MỚI (Bóc Link Hộ):
//   1. Người dùng dán Cookie vào ô cookieInput
//   2. Người dùng dán Links vào linksInput
//   3. Bấm "Bóc Link & Tải" → tạo job pending
//   4. Gửi Cookie lên start-with-auth → server bóc link ngầm
//   5. Poll job status → khi completed, hiển thị nút để tải (không click ngầm)
//   6. Người dùng tự bấm nút tải để mở trang với session hiện tại
//
// ĐÃ XÓA:
//   - handleDownload() (Extension flow cũ)
//   - window.postMessage AUTOTOOL_HARVEST_COOKIE_CMD
//   - submitManualCookie() trong resultActions (thay bằng flow mới)
//   - Nút "Tải ZIP về máy"
// ================================================================

const $ = (q) => document.querySelector(q);
const $$ = (q) => [...document.querySelectorAll(q)];

let me = null;
let pollTimer = null;
let activeJobId = null;
let paymentInfo = null;
let adminNavButton = null;
let adminUsersCache = [];
let plansCache = [];
let progressStartTime = null;
let lastProgressPct = 0;
let jobsCache = [];
let jobsStatusFilter = 'all';
const jobResultsCache = new Map();
const jobStatusCache = new Map();
let notificationItems = [];
let serverNotificationsInitialized = false;
let notificationSyncInFlight = false;
const STORAGE = {
  theme: 'autotool.theme',
  linkDraft: 'autotool.linkDraft',
  resultName: 'autotool.resultName',
  outputMode: 'autotool.outputMode',
  targetFolder: 'autotool.targetFolder',
  activeJob: 'autotool.activeJob',
  notifications: 'autotool.notifications.v1',
  notificationPermissionAsked: 'autotool.notificationPermissionAsked',
  dailySignals: 'autotool.dailySignals',
};

// ================================================================
// UTILITY FUNCTIONS
// ================================================================
function getCookieValue() {
  const el = $('#cookieInput');
  return el ? el.value.trim() : '';
}
function ensureAdminNav(){
  const nav = $('.nav');
  if(!nav) return null;
  if(adminNavButton) return adminNavButton;
  adminNavButton = document.createElement('button');
  adminNavButton.type = 'button';
  adminNavButton.className = 'nav-link admin-only';
  adminNavButton.dataset.page = 'admin';
  adminNavButton.textContent = 'Admin';
  adminNavButton.addEventListener('click', () => showPage('admin'));
  nav.appendChild(adminNavButton);
  return adminNavButton;
}
function removeAdminNav(){
  if(adminNavButton){
    adminNavButton.remove();
    adminNavButton = null;
  }
}
function toast(msg, type = 'info') {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.className = 'toast';
    document.body.appendChild(t);
  }
  
  // Create a new toast item
  const item = document.createElement('div');
  item.className = `toast-item ${type}`;
  
  let icon = 'ℹ️';
  if(type === 'success') icon = '✅';
  if(type === 'error') icon = '❌';
  if(type === 'warning') icon = '⚠️';
  
  // Check if msg contains an icon already (like '❌ Lỗi...') to avoid double icons
  if(typeof msg === 'string' && (msg.startsWith('✅') || msg.startsWith('❌') || msg.startsWith('⚠️') || msg.startsWith('ℹ️'))) {
    icon = '';
  }

  item.innerHTML = `<span>${icon}</span> <span class="toast-msg">${esc(msg)}</span>`;
  
  t.appendChild(item);
  t.hidden = false;
  
  // Trigger reflow to animate
  item.getBoundingClientRect();
  item.classList.add('show');
  
  setTimeout(() => {
    item.classList.remove('show');
    item.addEventListener('transitionend', () => {
      item.remove();
      if(t.childNodes.length === 0) t.hidden = true;
    });
  }, 3600);
}
function setLoading(btn, isLoading) {
  if(!btn) return;
  if(isLoading) {
    btn.classList.add('loading');
    btn.disabled = true;
  } else {
    btn.classList.remove('loading');
    btn.disabled = false;
  }
}
function fmtMoney(v){ return (Number(v || 0)).toLocaleString('vi-VN') + 'đ'; }
function esc(s){ return String(s ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
// parseUTC: dam bao chuoi tu server (UTC, khong co Z) duoc parse dung
function parseUTC(s){
  if(!s) return null;
  if(typeof s === 'string' && !/[Zz+]\d*$/.test(s.trim())) s = s.trim() + 'Z';
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}
function shortDate(s){
  if(!s) return '-';
  try{
    const d = parseUTC(s);
    if(!d) return s;
    return d.toLocaleString('vi-VN', {timeZone:'Asia/Ho_Chi_Minh'});
  }catch{ return s; }
}
function toDateTimeLocal(s){
  if(!s) return '';
  const d = new Date(s);
  if(Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function apiErrorMessage(data){
  const d = data?.detail ?? data;
  if(typeof d === 'string') return d;
  if(d?.message) return d.message;
  if(d?.need_vnd) return `Không đủ số dư, cần thêm ${fmtMoney(d.need_vnd)}`;
  try{return JSON.stringify(d);}catch{return 'Có lỗi xảy ra';}
}
async function api(path, opts={}){
  const controller = new AbortController();
  const timeoutMs = Number(opts.timeout || 45000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const requestOpts = {...opts};
  delete requestOpts.timeout;
  try{
    const res = await fetch(path, {
      credentials: 'include',
      headers: {'Content-Type':'application/json', ...(requestOpts.headers || {})},
      signal: requestOpts.signal || controller.signal,
      ...requestOpts,
    });
    if(!res.ok){
      let data;
      const resClone = res.clone();
      try{ data = await res.json(); }catch{ data = {detail: await resClone.text()}; }
      throw new Error(apiErrorMessage(data));
    }
    if(res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }catch(error){
    if(error?.name === 'AbortError') throw new Error('Yêu cầu mất quá nhiều thời gian. Vui lòng thử lại.');
    throw error;
  }finally{
    clearTimeout(timeout);
  }
}

function safeStorageGet(key, fallback=''){
  try{return localStorage.getItem(key) ?? fallback;}catch{return fallback;}
}
function safeStorageSet(key, value){
  try{localStorage.setItem(key, value);}catch{}
}
function safeStorageJSON(key, fallback){
  try{
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    return value ?? fallback;
  }catch{return fallback;}
}
function saveNotifications(){
  notificationItems = notificationItems.slice(0, 100);
  safeStorageSet(STORAGE.notifications, JSON.stringify(notificationItems.filter(item => !item.server_id).slice(0, 40)));
}
function notificationTypeIcon(type){
  return {success:'✓', error:'!', warning:'△', info:'i'}[type] || 'i';
}
function relativeTime(value){
  const d = parseUTC(value);
  const time = d ? d.getTime() : NaN;
  if(!Number.isFinite(time)) return 'vừa xong';
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if(seconds < 45) return 'vừa xong';
  if(seconds < 3600) return `${Math.floor(seconds / 60)} phút trước`;
  if(seconds < 86400) return `${Math.floor(seconds / 3600)} giờ trước`;
  if(seconds < 604800) return `${Math.floor(seconds / 86400)} ngày trước`;
  return shortDate(value);
}
function renderNotifications(){
  const list = $('#notificationList');
  const badge = $('#notificationBadge');
  if(!list || !badge) return;
  const unread = notificationItems.filter(item => !item.read).length;
  badge.textContent = unread > 99 ? '99+' : String(unread);
  badge.hidden = unread === 0;
  list.innerHTML = notificationItems.length ? notificationItems.map(item => `
    <button class="notification-item ${item.read ? '' : 'unread'}" type="button" data-notification-id="${esc(item.id)}" data-page="${esc(item.page || '')}">
      <span class="notification-type ${esc(item.type || 'info')}">${notificationTypeIcon(item.type)}</span>
      <span class="notification-copy"><b>${esc(item.title)}</b><span>${esc(item.message)}</span><small>${relativeTime(item.created_at)}</small></span>
      ${item.read ? '' : '<i aria-label="Chưa đọc"></i>'}
    </button>`).join('') : `
      <div class="notification-empty"><span>✓</span><b>Bạn đã xem hết</b><p>Job, giao dịch và cảnh báo quan trọng sẽ xuất hiện tại đây.</p></div>`;
  $$('.notification-item').forEach(button => button.onclick = async () => {
    const item = notificationItems.find(row => row.id === button.dataset.notificationId);
    if(item) item.read = true;
    saveNotifications();
    renderNotifications();
    closeNotificationPanel();
    if(item?.server_id){
      try{ await api(`/api/notifications/${item.server_id}/read`, {method:'POST', body:'{}'}); }catch{}
    }
    navigateToNotification(item);
  });
  const permissionBox = $('#notificationPermission');
  if(permissionBox){
    const granted = 'Notification' in window && Notification.permission === 'granted';
    permissionBox.classList.toggle('enabled', granted);
    const button = $('#enableBrowserNotifyBtn');
    if(button){ button.textContent = granted ? 'Đã bật' : ('Notification' in window && Notification.permission === 'denied' ? 'Đã chặn' : 'Bật'); button.disabled = granted || ('Notification' in window && Notification.permission === 'denied'); }
  }
}
function navigateToNotification(item){
  if(!item) return;
  const page = item.action_page || item.page || '';
  const jobId = item.metadata?.job_id;
  if(page) showPage(page);
  if(jobId && page === 'tool'){
    activeJobId = jobId;
    safeStorageSet(STORAGE.activeJob, jobId);
    pollJob(jobId);
  }
  if(item.action_target){
    window.setTimeout(() => {
      const target = document.getElementById(item.action_target);
      if(!target) return;
      target.scrollIntoView({behavior:'smooth', block:'center'});
      target.classList.add('notification-target-flash');
      window.setTimeout(() => target.classList.remove('notification-target-flash'), 2200);
    }, 180);
  }
}
async function syncServerNotifications({announce=true}={}){
  if(!me || notificationSyncInFlight) return;
  notificationSyncInFlight = true;
  try{
    const previousIds = new Set(notificationItems.filter(item => item.server_id).map(item => item.server_id));
    const data = await api('/api/notifications?limit=80', {timeout:12000});
    const serverItems = (data?.items || []).map(row => ({
      id:`server-${row.id}`,
      server_id:row.id,
      event_key:row.event_key || '',
      category:row.category || 'system',
      title:row.title,
      message:row.message,
      type:row.type || 'info',
      action_page:row.action_page || 'home',
      page:row.action_page || 'home',
      action_target:row.action_target || '',
      metadata:row.metadata || {},
      read:Boolean(row.is_read),
      created_at:row.created_at,
    }));
    const serverAliases = new Set();
    serverItems.forEach(item => {
      const jobMatch = item.event_key.match(/^job:(.+):(completed|error|cancelled)$/);
      if(jobMatch) serverAliases.add(`job-${jobMatch[1]}-${jobMatch[2]}`);
      const paymentMatch = item.event_key.match(/^manual-payment-approved:(\d+)$/);
      if(paymentMatch) serverAliases.add(`payment-${paymentMatch[1]}-approved`);
    });
    const localItems = notificationItems.filter(item => !item.server_id && !serverAliases.has(item.fingerprint));
    notificationItems = [...serverItems, ...localItems]
      .sort((a,b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 100);
    saveNotifications();
    renderNotifications();

    const fresh = serverNotificationsInitialized
      ? serverItems.filter(item => !item.read && !previousIds.has(item.server_id))
      : [];
    serverNotificationsInitialized = true;
    if(announce && fresh.length){
      const newest = fresh[0];
      toast(newest.title, newest.type);
      if(document.hidden && 'Notification' in window && Notification.permission === 'granted'){
        try{
          const nativeNotification = new Notification(`AutoTool Pro · ${newest.title}`, {body:newest.message, tag:newest.event_key || undefined});
          nativeNotification.onclick = () => { window.focus(); navigateToNotification(newest); nativeNotification.close(); };
        }catch{}
      }
      if(fresh.some(item => ['payment','free_usage','plan','account'].includes(item.category))){
        await loadMe();
      }
    }
  }catch(error){
    if(!serverNotificationsInitialized) serverNotificationsInitialized = true;
  }finally{
    notificationSyncInFlight = false;
  }
}
function addNotification(title, message, type='info', options={}){
  const fingerprint = options.fingerprint || '';
  const existing = fingerprint ? notificationItems.find(item => item.fingerprint === fingerprint) : null;
  if(existing && !options.refresh){ return existing; }
  if(existing){
    existing.title = title;
    existing.message = message;
    existing.type = type;
    existing.page = options.page || existing.page || '';
    existing.created_at = new Date().toISOString();
    existing.read = false;
    notificationItems = [existing, ...notificationItems.filter(item => item !== existing)];
  }else{
    notificationItems.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
      title,
      message,
      type,
      page: options.page || '',
      fingerprint,
      read: false,
      created_at: new Date().toISOString(),
    });
  }
  saveNotifications();
  renderNotifications();
  if(options.native !== false && document.hidden && 'Notification' in window && Notification.permission === 'granted'){
    try{
      const nativeNotification = new Notification(`AutoTool Pro · ${title}`, {body:message, tag:fingerprint || undefined});
      nativeNotification.onclick = () => { window.focus(); if(options.page) showPage(options.page); nativeNotification.close(); };
    }catch{}
  }
  return notificationItems[0];
}
function openNotificationPanel(){
  const panel = $('#notificationPanel');
  if(!panel) return;
  panel.hidden = false;
  $('#notificationBtn')?.setAttribute('aria-expanded','true');
  renderNotifications();
}
function closeNotificationPanel(){
  const panel = $('#notificationPanel');
  if(!panel) return;
  panel.hidden = true;
  $('#notificationBtn')?.setAttribute('aria-expanded','false');
}
function toggleNotificationPanel(){
  if($('#notificationPanel')?.hidden) openNotificationPanel(); else closeNotificationPanel();
}
async function markAllNotificationsRead(){
  notificationItems.forEach(item => { item.read = true; });
  saveNotifications();
  renderNotifications();
  if(me){ try{ await api('/api/notifications/read-all', {method:'POST', body:'{}'}); }catch{} }
}
async function enableBrowserNotifications(){
  if(!('Notification' in window)){ toast('Trình duyệt này chưa hỗ trợ thông báo hệ thống', 'warning'); return; }
  if(Notification.permission === 'denied'){
    toast('Thông báo đang bị chặn. Hãy cho phép lại trong cài đặt của trình duyệt.', 'warning');
    return;
  }
  try{
    const permission = await Notification.requestPermission();
    safeStorageSet(STORAGE.notificationPermissionAsked, '1');
    renderNotifications();
    if(permission === 'granted'){
      toast('Đã bật thông báo trình duyệt', 'success');
      addNotification('Thông báo đã sẵn sàng', 'Bạn sẽ được báo khi job hoàn tất hoặc cần chú ý.', 'success', {fingerprint:'browser-notifications-enabled', native:false});
    }else toast('Bạn chưa cho phép thông báo', 'warning');
  }catch(error){ toast(error.message || 'Không thể bật thông báo', 'error'); }
}
function inspectDriveLinks(raw){
  const lines = String(raw || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const seen = new Set();
  const valid = [];
  const invalid = [];
  let duplicates = 0;
  for(const line of lines){
    let url;
    try{ url = new URL(line); }catch{ invalid.push(line); continue; }
    const host = url.hostname.toLowerCase();
    const allowed = host === 'drive.google.com' || host === 'docs.google.com' || host.endsWith('.drive.google.com');
    if(url.protocol !== 'https:' || !allowed){ invalid.push(line); continue; }
    const normalized = url.href.replace(/\/$/, '');
    if(seen.has(normalized)){ duplicates += 1; continue; }
    seen.add(normalized);
    valid.push(normalized);
  }
  return {valid, invalid, duplicates, total: lines.length};
}
function updateLinkInspector(){
  const input = $('#linksInput');
  const status = $('#linkInputStatus');
  if(!input || !status) return {valid:[], invalid:[], duplicates:0, total:0};
  const report = inspectDriveLinks(input.value);
  const chips = [`<span class="${report.valid.length ? 'valid' : ''}">${report.valid.length} hợp lệ</span>`];
  if(report.duplicates) chips.push(`<span class="duplicate">${report.duplicates} trùng</span>`);
  if(report.invalid.length) chips.push(`<span class="invalid">${report.invalid.length} không hợp lệ</span>`);
  status.innerHTML = chips.join('');
  safeStorageSet(STORAGE.linkDraft, input.value);
  return report;
}
function applyTheme(theme){
  const resolved = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = resolved;
  safeStorageSet(STORAGE.theme, resolved);
  const icon = $('#themeToggle span');
  if(icon) icon.textContent = resolved === 'light' ? '☀' : '☾';
  const quickIcon = $('#notifyThemeQuick span');
  if(quickIcon) quickIcon.textContent = resolved === 'light' ? '☀' : '☾';
  const meta = document.querySelector('meta[name="theme-color"]');
  if(meta) meta.content = resolved === 'light' ? '#f4f7fc' : '#07101f';
}
async function checkSystemHealth(){
  const chip = $('#systemChip');
  const text = $('#systemChipText');
  if(!chip || !text) return;
  try{
    await api('/api/health', {timeout:8000});
    chip.classList.remove('offline');
    chip.classList.add('online');
    // text.textContent = 'Hệ thống ổn định';
  }catch{
    chip.classList.remove('online');
    chip.classList.add('offline');
    text.textContent = 'Mất kết nối';
  }
}
function setReadinessItem(selector, ready, detail){
  const item = $(selector);
  if(!item) return;
  item.classList.toggle('ready', Boolean(ready));
  const icon = item.querySelector('.readiness-icon');
  const small = item.querySelector('small');
  if(icon) icon.textContent = ready ? '✓' : icon.dataset.step || icon.textContent;
  if(small) small.textContent = detail;
}
function updateReadiness(){
  const signedIn = Boolean(me);
  const hasPlan = Boolean(me?.is_admin || me?.access?.full_access || me?.free_usages > 0);
  const hasDrive = Boolean(me?.connections?.source?.connected);
  const count = [signedIn, hasPlan, hasDrive].filter(Boolean).length;
  const pct = Math.round(count / 3 * 100);
  const score = $('#readinessScore');
  if(score) score.style.setProperty('--ready', `${pct}%`);
  if($('#readinessPct')) $('#readinessPct').textContent = `${pct}%`;
  setReadinessItem('#readyAccount', signedIn, signedIn ? (me.name || me.email) : 'Chưa xác minh');
  setReadinessItem('#readyPlan', hasPlan, hasPlan ? (me.is_admin ? 'Quyền admin' : (me.access?.full_access ? `Gói ${me.plan_code}` : 'Ưu đãi miễn phí')) : 'Chưa kích hoạt');
  setReadinessItem('#readyDrive', hasDrive, hasDrive ? me.connections.source.email : 'Chưa kết nối');
  const missing = [];
  if(!signedIn) missing.push('đăng nhập');
  if(signedIn && !hasPlan) missing.push('mua gói');
  if(signedIn && !hasDrive) missing.push('kết nối Drive');
  if($('#readinessTitle')) $('#readinessTitle').textContent = count === 3 ? 'Workspace đã sẵn sàng' : `Còn ${3 - count} bước để bắt đầu`;
  if($('#readinessHint')) $('#readinessHint').textContent = count === 3 ? 'Bạn có thể chọn chế độ, dán link và tạo job ngay.' : `Tiếp theo: ${missing[0] || 'hoàn tất thiết lập'}.`;
  $('#readinessBoard')?.classList.toggle('complete', count === 3);
  
  // Show/hide free usage banner
  const banner = $('#freeUsageAlertBanner');
  const bannerText = $('#freeUsageBannerText');
  if(banner && bannerText){
    if(me && me.free_usages > 0){
      banner.style.display = 'flex';
      bannerText.textContent = `Bạn còn ${me.free_usages} lượt miễn phí. Chế độ miễn phí chỉ áp dụng cho chế độ "Tải từng file" (không áp dụng cho ZIP hoặc Drive đích).`;
    } else {
      banner.style.display = 'none';
    }
  }

  const startButton = $('#startJobBtn');
  if(startButton) startButton.title = count === 3 ? 'Bắt đầu xử lý (Ctrl/⌘ + Enter)' : `Cần ${missing.join(', ')}`;
}
function addDailyAccountSignals(){
  if(!me) return;
  const dateKey = new Date().toISOString().slice(0,10);
  if(!me.access?.full_access){
    addNotification('Tài khoản chưa có gói', 'Nạp tiền và chọn gói để mở quyền tạo job.', 'warning', {page:'plans', fingerprint:`no-plan-${me.id}-${dateKey}`, native:false});
  }
  if(!me.connections?.source?.connected){
    addNotification('Drive nguồn chưa kết nối', 'Kết nối tài khoản có quyền xem file trước khi chạy tool.', 'warning', {page:'tool', fingerprint:`no-drive-${me.id}-${dateKey}`, native:false});
  }
  if(me.plan_expires_at){
    const remainingDays = Math.ceil((new Date(me.plan_expires_at).getTime() - Date.now()) / 86400000);
    if(remainingDays >= 0 && remainingDays <= 7){
      addNotification('Gói sắp hết hạn', `Gói hiện tại còn khoảng ${remainingDays} ngày sử dụng.`, remainingDays <= 2 ? 'error' : 'warning', {page:'plans', fingerprint:`plan-expiry-${me.id}-${dateKey}`, native:false});
    }
  }
}
function updateModeGuidance(mode){
  const data = {
    zip:{icon:'↓', title:'Tải từng file', text:'Phù hợp khi bạn muốn chọn và kiểm soát từng file tải về thiết bị.'},
    server_zip:{icon:'◫', title:'Nén ZIP siêu tốc', text:'Gom toàn bộ kết quả thành một file ZIP duy nhất để lưu trữ gọn hơn.'},
    drive:{icon:'⇄', title:'Chuyển thẳng sang Drive đích', text:'Không tải qua máy; hãy kết nối Drive đích và chọn thư mục nhận kết quả.'},
  }[mode] || null;
  const box = $('#modeGuidance');
  if(!data || !box) return;
  const icon = box.querySelector('.mode-guidance-icon');
  const title = box.querySelector('b');
  const text = box.querySelector('p');
  if(icon) icon.textContent = data.icon;
  if(title) title.textContent = data.title;
  if(text) text.textContent = data.text;
  box.dataset.mode = mode;
}
function scrollToGuideTarget(target){
  if(!target) return;
  showPage('guide');
  requestAnimationFrame(() => {
    const section = document.getElementById(target);
    if(section) section.scrollIntoView({behavior:'smooth', block:'start'});
  });
}
function filterGuideModules(){
  const input = $('#guideSearch');
  if(!input) return;
  const query = input.value.trim().toLowerCase();
  const modules = $$('.guide-module');
  let visible = 0;
  modules.forEach(module => {
    const adminHidden = module.closest('.guide-admin-section')?.hidden;
    const haystack = `${module.dataset.guideKeywords || ''} ${module.textContent || ''}`.toLowerCase();
    const show = !adminHidden && (!query || haystack.includes(query));
    module.hidden = !show;
    if(show) visible += 1;
  });
  $$('.guide-category-head').forEach(head => {
    const nextModules = [];
    let node = head.nextElementSibling;
    while(node && !node.classList.contains('guide-category-head')){
      if(node.classList?.contains('guide-module')) nextModules.push(node);
      if(node.classList?.contains('guide-admin-section')) break;
      node = node.nextElementSibling;
    }
    if(nextModules.length) head.hidden = nextModules.every(module => module.hidden);
  });
  if($('#guideSearchStatus')) $('#guideSearchStatus').textContent = query ? `${visible} mục phù hợp với “${input.value.trim()}”` : `${me?.is_admin ? '13' : '10'} hướng dẫn ${me?.is_admin ? 'bao gồm mục admin' : 'dành cho người dùng'}`;
  if($('#guideEmpty')) $('#guideEmpty').hidden = visible !== 0;
}
function updateGuideAccess(){
  const isAdmin = Boolean(me?.is_admin);
  if($('#guide-admin')) $('#guide-admin').hidden = !isAdmin;
  if($('#guideAdminToc')) $('#guideAdminToc').hidden = !isAdmin;
  filterGuideModules();
}

// ================================================================
// AUTH MODAL
// ================================================================
function openAuth(mode='login'){
if($('#authModal')) $('#authModal').hidden = false;
  const isRegister = mode === 'register';
if($('#loginForm')) $('#loginForm').hidden = isRegister || mode === 'forgot';
if($('#registerForm')) $('#registerForm').hidden = isRegister ? false : true;
  if($('#forgotPassForm')) $('#forgotPassForm').hidden = mode === 'forgot' ? false : true;
  $('#authTitle').textContent = isRegister ? 'Đăng ký tài khoản' : (mode === 'forgot' ? 'Quên mật khẩu' : 'Đăng nhập');
}
function closeAuth(){ $('#authModal').hidden = true; }
async function performLogout(){
  try{ await api('/api/auth/logout', {method:'POST', body:'{}'}); }
  finally{ location.reload(); }
}
function openChangePass(){
if($('#changePassModal')) $('#changePassModal').hidden = false;
  $('#oldPass').value = '';
  $('#newPass').value = '';
  $('#newPass2').value = '';
}
function closeChangePass(){ $('#changePassModal').hidden = true; }

// ================================================================
// PAGE NAVIGATION
// ================================================================
function showPage(name){
  name = String(name || 'home').split('?')[0];
  const allowedPages = ['home','guide','tool','jobs','plans','topup','admin','login'];
  if(!allowedPages.includes(name)) name = 'home';
  if(name === 'login'){
    openAuth('login');
    name = 'home';
  }
  if(name === 'admin' && (!me || !me.is_admin)){
    toast('Không có quyền admin');
    name = 'home';
  }
  const isSamePage = $('#page-' + name)?.classList.contains('active');
  $$('.page').forEach(p => p.classList.remove('active'));
  $('#page-' + name)?.classList.add('active');
  $$('.nav-link').forEach(b => b.classList.toggle('active', b.dataset.page === name));
  location.hash = name;
  if (!isSamePage) {
    window.scrollTo({top:0, behavior:'smooth'});
  }
  $('#mainNav')?.classList.remove('open');
  $('#mobileMenuBtn')?.classList.remove('open');
  $('#mobileMenuBtn')?.setAttribute('aria-expanded', 'false');
  closeNotificationPanel();
  if(name === 'jobs') loadJobs();
  if(name === 'plans') loadPlans();
  if(name === 'topup') loadPayments();
  if(name === 'admin') loadAdmin();
}

// ================================================================
// LOAD ME
// ================================================================
async function loadMe(){
  try{
    me = await api('/api/me');
    const balanceKey = `autotool.balance.${me.id}`;
    const previousBalanceRaw = safeStorageGet(balanceKey, null);
    const previousBalance = previousBalanceRaw === null ? null : Number(previousBalanceRaw);
    if(!serverNotificationsInitialized && previousBalance !== null && Number.isFinite(previousBalance) && previousBalance >= 0 && me.balance_vnd > previousBalance){
      addNotification('Số dư đã được cập nhật', `Tài khoản vừa tăng ${fmtMoney(me.balance_vnd - previousBalance)}. Số dư mới: ${me.balance_label}.`, 'success', {page:'plans', fingerprint:`balance-${me.id}-${me.balance_vnd}`});
    }
    safeStorageSet(balanceKey, String(me.balance_vnd));
    const role = me.is_admin ? 'Admin' : (me.access?.full_access ? 'Đã có gói' : 'Chưa có gói');
    $('#userText').textContent = `${me.name || me.email} · ${role} · ${me.balance_label}`;
    if($('#userSummary')) $('#userSummary').hidden = false;
if($('#loginBtn')) $('#loginBtn').hidden = true;
if($('#logoutBtn')) $('#logoutBtn').hidden = false;
if($('#changePassBtn')) $('#changePassBtn').hidden = false;
if($('#telegramBtn')) $('#telegramBtn').hidden = false;
    if($('#mobileAccountMenu')) $('#mobileAccountMenu').hidden = false;
    if($('#notificationQuickActions')) $('#notificationQuickActions').hidden = false;
    if(me.telegram_id) {
        $('#telegramBtn').textContent = '✦';
        $('#telegramBtn').title = 'Telegram đã bật';
        $('#telegramBtn').setAttribute('aria-label', 'Telegram đã bật');
        $('#telegramBtn').style.color = 'var(--ok)';
    } else {
        $('#telegramBtn').textContent = '✦';
        $('#telegramBtn').title = 'Thiết lập Telegram';
        $('#telegramBtn').setAttribute('aria-label', 'Thiết lập Telegram');
        $('#telegramBtn').style.color = 'var(--muted)';
    }
    if($('#sourceStatus')) $('#sourceStatus').textContent = me.connections?.source?.connected ? `${me.connections.source.email}` : 'Chưa kết nối';
    if($('#destStatus')) $('#destStatus').textContent = me.connections?.destination?.connected ? `${me.connections.destination.email}` : 'Chưa kết nối';
    $('.connection-card')?.classList.toggle('connected', Boolean(me.connections?.source?.connected));
    $('#accessText').textContent = me.is_admin ? 'Admin có toàn quyền.' : (me.access?.full_access ? `Gói ${me.plan_code}: toàn quyền đang hoạt động.` : (me.free_usages > 0 ? `Đang sử dụng lượt miễn phí (Còn ${me.free_usages} lượt).` : 'Tài khoản chưa có gói hoạt động. Mua gói để chạy tool.'));
    if(me.is_admin){ ensureAdminNav(); } else { removeAdminNav(); }
    if($('#balanceText')) $('#balanceText').textContent = me.balance_label;
    updateCookieStatus();
    // Tải thống kê Dashboard
    try {
      const stats = await api('/api/me/stats');
      if($('#statsDashboard')) {
        $('#statsDashboard').style.display = 'block';
        $('#statFiles').textContent = stats.total_files.toLocaleString('vi-VN');
        $('#statSize').textContent = stats.total_size_label;
        if($('#statJobs')) $('#statJobs').textContent = Number(stats.total_jobs || 0).toLocaleString('vi-VN');
        if($('#statSuccess')) $('#statSuccess').textContent = `${Number(stats.success_rate || 0)}%`;
      }
    } catch(e) {}
    updateReadiness();
    updateGuideAccess();
    addDailyAccountSignals();
    
  }catch(e){
    me = null;
    $('#userText').textContent = '';
    if($('#userSummary')) $('#userSummary').hidden = true;
if($('#loginBtn')) $('#loginBtn').hidden = false;
if($('#logoutBtn')) $('#logoutBtn').hidden = true;
if($('#changePassBtn')) $('#changePassBtn').hidden = true;
    if($('#telegramBtn')) $('#telegramBtn').hidden = true;
    if($('#mobileAccountMenu')) $('#mobileAccountMenu').hidden = true;
    if($('#notificationQuickActions')) $('#notificationQuickActions').hidden = true;
    if($('#sourceStatus')) $('#sourceStatus').textContent = 'Chưa kết nối';
    if($('#destStatus')) $('#destStatus').textContent = 'Chưa kết nối';
    if($('#accessText')) $('#accessText').textContent = 'Đăng nhập để kiểm tra quyền.';
    removeAdminNav();
    if($('#statsDashboard')) $('#statsDashboard').style.display = 'none';
    updateReadiness();
    updateGuideAccess();
  }
}

// ================================================================
// COOKIE VALIDATOR
// ================================================================
function updateCookieStatus() {
  const status = $('#cookieStatus');
  const input = $('#cookieInput');
  if(!status || !input) return;

  const hasSourceDrive = me?.connections?.source?.connected;
  if (hasSourceDrive) {
    status.innerHTML = `<span style="color:#00b894; font-weight:bold;">✅ Đã liên kết Google Drive! Hệ thống sẽ tự động bóc link mà không cần Cookie.</span>`;
    input.style.display = 'none';
    if($('#clearCookieBtn')) $('#clearCookieBtn').style.display = 'none';
    return;
  } else {
    input.style.display = 'block';
    if($('#clearCookieBtn')) $('#clearCookieBtn').style.display = 'block';
  }

  const cookie = getCookieValue();
  if (!cookie) {
    status.innerHTML = '';
    return;
  }

  // Đếm số cookie trong chuỗi
  let count = 0;
  const lines = cookie.split('\n');
  const isNetscape = lines.some(l => l.trim() && !l.startsWith('#') && l.split('\t').length >= 7);

  if (isNetscape) {
    count = lines.filter(l => l.trim() && !l.startsWith('#') && l.split('\t').length >= 7).length;
    status.innerHTML = `<span class="cookie-ok">✅ Netscape format — ${count} cookie đã nhận dạng</span>`;
  } else {
    count = cookie.split(';').filter(p => p.includes('=')).length;
    if (count > 0) {
      // Kiểm tra có chứa cookie Google Drive quan trọng không
      const important = ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID'];
      const found = important.filter(k => cookie.includes(k + '='));
      const hasKey = found.length > 0;
      status.innerHTML = hasKey
        ? `<span class="cookie-ok">✅ ${count} cookie — Tìm thấy: ${found.join(', ')}</span>`
        : `<span class="cookie-warn">⚠️ ${count} cookie — Không thấy cookie quan trọng (SID, HSID...). Kiểm tra lại nguồn.</span>`;
    } else {
      status.innerHTML = `<span class="cookie-err">❌ Không nhận ra định dạng cookie. Hãy copy lại từ DevTools.</span>`;
    }
  }
}

// ================================================================
// PLANS
// ================================================================
async function loadPlans(){
  const box = $('#plansGrid');
  box.innerHTML = '<div class="panel">Đang tải gói...</div>';
  try{
    plansCache = await api('/api/plans');
    box.innerHTML = plansCache.map((p) => {
      const unit = p.code === 'lifetime' ? 'một lần' : (p.duration_days ? `${p.duration_days} ngày` : '');
      const recommended = p.code === 'one_year' ? 'recommended' : '';
      const ribbon = p.code === 'one_year' ? '<span class="ribbon">HOT</span>' : (p.code === 'one_week' ? '<span class="ribbon soft">Dễ test</span>' : '');
      const features = (p.features || []).slice(0, 3).map(f => `<li>${esc(f)}</li>`).join('');
      return `<article class="plan-card ${recommended}">
        ${ribbon}
        <div class="plan-top">
          <div><div class="plan-name">${esc(p.name)}</div><p class="plan-desc">${esc(p.description)}</p></div>
          <span class="badge active">Full</span>
        </div>
        <div class="plan-price">${esc(p.price_label)} <small>${unit}</small></div>
        <ul class="plan-features">${features}</ul>
        <div class="plan-meta"><span class="badge">${p.max_links_per_job} link/job</span><span class="badge">${p.max_concurrent_jobs} job</span></div>
        <button class="btn primary buy-plan" data-code="${esc(p.code)}">Mua gói</button>
      </article>`;
    }).join('') || '<div class="panel">Chưa có gói trả phí</div>';
    $$('.buy-plan').forEach(b => b.onclick = async () => {
      if(!me){ openAuth('login'); toast('Bạn cần đăng nhập để mua gói'); return; }
      try{
        await api(`/api/plans/${b.dataset.code}/buy`, {method:'POST', body:'{}'});
        toast('Đã cập nhật gói', 'success');
        const selectedPlan = plansCache.find(plan => plan.code === b.dataset.code);
        addNotification('Mua gói thành công', `${selectedPlan?.name || 'Gói sử dụng'} đã được kích hoạt.`, 'success', {page:'tool', fingerprint:`plan-purchased-${b.dataset.code}-${Date.now()}`});
        await loadMe();
        await loadPlans();
      }catch(e) { toast(e.message, 'error'); }
    });
  }catch(e){
    box.innerHTML = `<div class="panel">${esc(e.message)}</div>`;
  }
}

// ================================================================
// PAYMENTS
// ================================================================
async function loadPayments(){
  if(!me){
    $('#paymentsList').innerHTML = '<div class="item">Cần đăng nhập để nạp tiền</div>';
    return;
  }
  try{
    const rows = await api('/api/payments/mine');
    $('#paymentsList').innerHTML = rows.map(r => `<div class="item"><b>${fmtMoney(r.amount_vnd)}</b><p>${esc(r.transfer_note)}</p><span class="badge ${esc(r.status)}">${esc(r.status)}</span><small>${shortDate(r.created_at)}</small></div>`).join('') || '<div class="item">Chưa có yêu cầu nạp</div>';
    rows.filter(row => ['approved','completed'].includes(row.status)).slice(0,3).forEach(row => addNotification('Giao dịch đã được ghi nhận', `${fmtMoney(row.amount_vnd)} đã được xử lý thành công.`, 'success', {page:'topup', fingerprint:`payment-${row.id}-${row.status}`, native:false}));
  }catch(e){
    $('#paymentsList').innerHTML = `<div class="item">${esc(e.message)}</div>`;
  }
  await loadTopupInfo();
  }


let lastTopupInfo = null;
async function loadTopupInfo(){
  if(!me) return;
  try{
    if(!lastTopupInfo) {
      lastTopupInfo = await api('/api/me/deposit-info');
    }
    const info = lastTopupInfo;
    if($('#topupNote')) $('#topupNote').value = info.deposit_code;
    
    const bank = info.bank_name || "MB";
    const acc = info.bank_account || "";
    const amount = Number($('#topupAmount')?.value || 0); 
    const msg = info.deposit_code || "";
    
    let qrUrl = `https://qr.sepay.vn/img?acc=${acc}&bank=${bank}&amount=${amount}&des=${msg}`;
    if(!acc) qrUrl = ''; // fallback will be handled by renderPayment
    
    renderPayment({
      amount_vnd: amount,
      transfer_note: msg,
      configured: !!acc,
      auto_enabled: true,
      qr_url: qrUrl
    });
  }catch(e){
    console.error(e);
  }
}

  function renderPayment(info){
  paymentInfo = info || {};
  $('#payAmount').textContent = paymentInfo.amount_vnd ? fmtMoney(paymentInfo.amount_vnd) : 'Tuỳ chọn';
  $('#payNote').textContent = paymentInfo.transfer_note || '-';
  $('#paymentHint').textContent = paymentInfo.configured ? (paymentInfo.auto_enabled ? (paymentInfo.note || 'Quét QR và chuyển đúng mã nạp.') : 'QR đã có. Muốn tự cộng ngay cần cấu hình webhook ngân hàng.') : 'Chưa cấu hình QR trong .env.';
  const wrap = $('#qrWrap');
  if(paymentInfo.qr_url){
    wrap.innerHTML = `<img alt="QR nạp tiền" src="${paymentInfo.qr_url}&_=${Date.now()}">`;
  }else{
    wrap.innerHTML = '<div class="qr-placeholder">Chưa có QR</div>';
  }
}
async function previewTopup(silent=false){
  if(!me) return;
  try{
    const payload = {amount_vnd: 0, transfer_note: $('#topupNote').value};
    const info = await api('/api/payments/preview', {method:'POST', body: JSON.stringify(payload)});
    renderPayment(info);
    if(!silent) toast('Đã cập nhật QR');
  }catch(e){ if(!silent) toast(e.message); }
}

// ================================================================
// [MỚI] TẠO JOB: GỬI COOKIE + LINKS → KÍCH HOẠT BÓC LINK NGẦM
// ================================================================
async function startJob(customLinks = null){
  const btn = document.getElementById('startJobBtn');
  if(!me){ openAuth('login'); toast('Cần đăng nhập trước', 'error'); return; }

  const hasSourceDrive = me?.connections?.source?.connected;
  if(!hasSourceDrive){
    toast('⚠️ Chưa Liên kết Drive! Vui lòng kết nối tài khoản Google Drive trước.', 'warning');
    return;
  }
  const cookieStr = "";

  let links;
  if (customLinks && !(customLinks instanceof Event)) {
    links = customLinks; // JSON string
  } else {
    const report = updateLinkInspector();
    if(report.invalid.length){
      toast(`Có ${report.invalid.length} dòng không phải liên kết Google Drive hợp lệ. Hãy kiểm tra lại.`, 'warning');
      $('#linksInput').focus();
      return;
    }
    links = report.valid;
    if(!links.length){ toast('Chưa có liên kết Google Drive hợp lệ', 'warning'); $('#linksInput').focus(); return; }
  }

  setLoading(btn, true);

  // Lấy output mode từ UI selector
  const outputMode = $('#selectedOutputMode')?.value || 'zip';
  const targetFolderId = ($('#targetFolderId')?.value || '').trim();

  const payload = {
    links,
    result_name: ($('#resultName')?.value || 'ket_qua').trim(),
    output_mode: outputMode,
    target_folder_id: targetFolderId,
  };

  if(!payload.result_name){
    payload.result_name = 'ket_qua';
    if($('#resultName')) $('#resultName').value = payload.result_name;
  }

  try{
    const job = await api('/api/jobs', {method:'POST', body: JSON.stringify(payload)});
    activeJobId = job.id;
      safeStorageSet(STORAGE.activeJob, job.id);
      $('#logBox').textContent = `Đã tạo job ${job.id}\n`;
      setProgress(job);
      pollJob(job.id);
      showPage('tool');
      
      // Cuộn xuống khu vực hiển thị tiến độ & kết quả
      setTimeout(() => {
        $('.result-panel')?.scrollIntoView({behavior:'smooth', block:'start'});
      }, 50);

    // Ngay lập tức gửi Cookie lên để server bóc link (không cần chờ người dùng bấm thêm)
    await sendCookieToJob(job.id, cookieStr);

  }catch(e) { toast(e.message, 'error'); }
  finally { setLoading(btn, false); }
}

// Gửi tín hiệu để server bắt đầu bóc link
async function sendCookieToJob(jobId, cookieStr) {
  try {
    await api(`/api/jobs/${jobId}/start-with-auth`, {
      method: 'POST',
      body: JSON.stringify({ auth_payload: cookieStr || "" })
    });
  } catch(e) {
    toast('Lỗi khi bắt đầu Job: ' + e.message);
  }
}

// ================================================================
// SERVER ZIP DOWNLOAD TRIGGER
// ================================================================
function safeDownloadPart(value, fallback='file'){
  const cleaned = String(value || '').replace(/[\\/*?"<>|\u0000-\u001f]+/g, '_').trim().replace(/^\.+|\.+$/g, '');
  return (cleaned && cleaned !== '..' ? cleaned : fallback).slice(0, 180);
}
async function triggerServerZipDownload(directLinks, archiveName='AutoTool_Downloads') {
  if (!directLinks || directLinks.length === 0) return;
  const validLinks = directLinks.filter(l => l.ok && l.url);
  if (!validLinks.length) return;

  toast('Đang nén ZIP và tải về...');
  
  try {
    const payloadStr = JSON.stringify({
      archive_name: safeDownloadPart(archiveName, 'AutoTool_Downloads'),
      items: validLinks.map(l => ({
        url: l.url,
        filename: l.filename || l.name || 'video.mp4',
        path: Array.isArray(l.path) ? l.path : [],
      }))
    });

    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/api/proxy/stream-zip-form';
    form.target = '_blank';
    
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'payload';
    input.value = payloadStr;
    
    form.appendChild(input);
    document.body.appendChild(form);
    form.submit();
    setTimeout(() => form.remove(), 1000);
    
  } catch (e) {
    toast(`❌ Lỗi nén ZIP: ${e.message}`);
  }
}

// ================================================================
// CLIENT DOWNLOAD TRIGGER
// ================================================================
async function triggerClientDownloads(directLinks, jobId='', archiveName='AutoTool_Downloads') {
  if (!directLinks || directLinks.length === 0) return;
  const validLinks = directLinks.filter(link => link.ok && link.url);
  if(!validLinks.length) return;

  // File System Access API cho phép tạo lại đúng cây thư mục trên Chromium desktop.
  // Trình duyệt không hỗ trợ sẽ tự chuyển sang ZIP để cấu trúc không bị làm phẳng.
  if(typeof window.showDirectoryPicker !== 'function'){
    toast('Thiết bị này không hỗ trợ chọn thư mục. Đang chuyển sang ZIP để giữ nguyên cấu trúc.', 'warning');
    await triggerServerZipDownload(validLinks, archiveName);
    return {downloadedCount:0, failedCount:0, fallback:'zip'};
  }

  let downloadedCount = 0;
  let failedCount = 0;
  let rootHandle;
  try{
    rootHandle = await window.showDirectoryPicker({mode:'readwrite', id:'autotool-downloads'});
  }catch(error){
    if(error?.name !== 'AbortError') toast(`Không thể mở thư mục lưu: ${error.message}`, 'error');
    return {downloadedCount:0, failedCount:0, cancelled:true};
  }

  toast(`Đang tải ${validLinks.length} file và dựng lại cây thư mục...`, 'info');
  const batchNames = new Set();
  for (let index = 0; index < validLinks.length; index += 1) {
    const link = validLinks[index];
    try {
      let directoryHandle = rootHandle;
      const safePath = (Array.isArray(link.path) ? link.path : []).map(part => safeDownloadPart(part, 'folder'));
      for(const part of safePath){
        directoryHandle = await directoryHandle.getDirectoryHandle(part, {create:true});
      }

      const originalName = safeDownloadPart(link.filename || link.name || `download_${index + 1}`, `download_${index + 1}`);
      const dot = originalName.lastIndexOf('.');
      const base = dot > 0 ? originalName.slice(0, dot) : originalName;
      const ext = dot > 0 ? originalName.slice(dot) : '';
      let filename = originalName;
      let suffix = 1;
      const parentKey = safePath.join('/').toLowerCase();
      while(true){
        const batchConflict = batchNames.has(`${parentKey}/${filename.toLowerCase()}`);
        let diskConflict = false;
        if(!batchConflict){
          try{
            await directoryHandle.getFileHandle(filename);
            diskConflict = true;
          }catch(error){
            if(error?.name !== 'NotFoundError') throw error;
          }
        }
        if(!batchConflict && !diskConflict) break;
        filename = `${base} (${suffix++})${ext}`;
      }
      batchNames.add(`${parentKey}/${filename.toLowerCase()}`);

      const url = link.url.startsWith('/api/proxy/') ? window.location.origin + link.url : link.url;
      const response = await fetch(url, {credentials:'include'});
      if(!response.ok) throw new Error(`HTTP ${response.status}`);
      const fileHandle = await directoryHandle.getFileHandle(filename, {create:true});
      const writable = await fileHandle.createWritable();
      if(response.body){
        await response.body.pipeTo(writable);
      }else{
        await writable.write(await response.blob());
        await writable.close();
      }
      downloadedCount += 1;
    } catch (e) {
      failedCount += 1;
      toast(`Lỗi tải ${link.filename || index + 1}: ${e.message}`, 'error');
    }
  }
  toast(
    failedCount ? `Đã lưu ${downloadedCount} file, ${failedCount} file lỗi.` : `Đã lưu đủ ${downloadedCount} file đúng cấu trúc thư mục.`,
    failedCount ? 'warning' : 'success'
  );
  if(jobId){
    try{
      await api(`/api/jobs/${jobId}/complete-client-download`, {
        method:'POST',
        body:JSON.stringify({downloaded_count:downloadedCount, failed_count:failedCount, note:'Đã tải vào thư mục người dùng chọn và giữ cấu trúc'})
      });
    }catch{}
  }
  return {downloadedCount, failedCount};
}

// ================================================================
// PROGRESS UI
// ================================================================
function setProgress(job){
  const pct = job.progress || 0;
  $('#jobPct').textContent = pct + '%';
  $('#jobBar').style.width = pct + '%';
  $('#jobStage').textContent = `${job.status} · ${job.stage || ''}`;
  const ring = $('#progressRing');
  if(ring) ring.style.setProperty('--progress', `${Math.max(0, Math.min(100, pct))}%`);
  const terminal = ['completed','error','cancelled'].includes(job.status);
  document.title = job.status === 'running' ? `(${pct}%) ${job.stage || 'Đang xử lý'} · AutoTool Pro` : 'AutoTool Pro | Xử lý Google Drive nhanh, gọn, có kiểm soát';

  const stages = [
    {name:'received', reached:Boolean(job.id)},
    {name:'resolving', reached:pct >= 10 || ['running','completed'].includes(job.status)},
    {name:'preparing', reached:pct >= 60 || job.status === 'completed'},
    {name:'ready', reached:job.status === 'completed'},
  ];
  stages.forEach((stage, index) => {
    const node = $(`[data-stage-step="${stage.name}"]`);
    if(!node) return;
    const nextReached = stages[index + 1]?.reached;
    node.classList.toggle('done', stage.reached && (nextReached || stage.name === 'ready'));
    node.classList.toggle('active', stage.reached && !nextReached && job.status !== 'error' && job.status !== 'cancelled');
    node.classList.toggle('failed', terminal && job.status !== 'completed' && stage.reached && !nextReached);
    const connector = node.nextElementSibling;
    if(connector?.tagName === 'I') connector.classList.toggle('done', Boolean(nextReached));
  });
  const liveState = $('#jobLiveState');
  if(liveState){
    liveState.className = `job-live-state ${esc(job.status || '')}`;
    const liveTitle = {pending:'Đang xếp hàng',queued:'Đang xếp hàng',running:'Đang xử lý',completed:'Đã hoàn tất',error:'Cần kiểm tra',cancelled:'Đã dừng'}[job.status] || 'Chờ job mới';
    const liveHint = {pending:'Sẽ tự bắt đầu',queued:'Chờ worker trống',running:'Cập nhật tự động',completed:'Kết quả sẵn sàng',error:'Mở nhật ký bên dưới',cancelled:'Có thể dùng lại link'}[job.status] || 'Cập nhật tự động';
    liveState.querySelector('b').textContent = liveTitle;
    liveState.querySelector('small').textContent = liveHint;
  }
  const previousStatus = jobStatusCache.get(job.id);
  jobStatusCache.set(job.id, job.status);
  if(job.status === 'completed' && previousStatus !== 'completed'){
    addNotification('Job đã hoàn tất', `${job.result_name || 'Kết quả'} đã sẵn sàng để nhận.`, 'success', {page:'tool', fingerprint:`job-${job.id}-completed`});
  }
  if(job.status === 'error' && previousStatus !== 'error'){
    addNotification('Job cần kiểm tra', job.error_message || `${job.result_name || 'Job'} xử lý chưa thành công.`, 'error', {page:'tool', fingerprint:`job-${job.id}-error`});
  }
  if(job.status === 'cancelled' && previousStatus !== 'cancelled'){
    addNotification('Job đã dừng', `${job.result_name || 'Job'} đã được hủy theo yêu cầu.`, 'warning', {page:'jobs', fingerprint:`job-${job.id}-cancelled`});
  }

  // Speed & ETA tracking
  const metaEl = $('#progressMeta');
  if (metaEl) {
    if (job.status === 'running' && pct > 0) {
      metaEl.style.display = 'flex';
      
      let elapsed = 0;
      if (job.started_at) {
        let ts = job.started_at;
        if (!ts.endsWith('Z') && !ts.includes('+')) ts += 'Z';
        elapsed = (Date.now() - new Date(ts).getTime()) / 1000;
        if (elapsed < 0) elapsed = 0;
      } else {
        if (!progressStartTime) progressStartTime = Date.now();
        elapsed = (Date.now() - progressStartTime) / 1000;
      }
      
      const elapsedStr = elapsed < 60 ? `${Math.round(elapsed)}s` : `${Math.floor(elapsed/60)}m ${Math.round(elapsed%60)}s`;
      $('#progressElapsed').textContent = `Đã chạy: ${elapsedStr}`;
      
      if (pct > 3 && elapsed > 2 && pct < 100) {
        const speed = pct / elapsed;
        const remaining = (100 - pct) / speed;
        const etaStr = remaining < 60 ? `${Math.round(remaining)}s` : `${Math.floor(remaining/60)}m ${Math.round(remaining%60)}s`;
        $('#progressETA').textContent = `Còn khoảng: ${etaStr}`;
      } else {
        $('#progressETA').textContent = `Đang tính thời gian còn lại...`;
      }
    } else {
      if (job.status === 'completed' || job.status === 'error') {
        if (job.status === 'completed') {
          metaEl.style.display = 'flex';
          $('#progressETA').textContent = 'Hoàn tất!';
        } else {
          metaEl.style.display = 'none';
        }
        progressStartTime = null;
      }
      if (job.status === 'pending' || job.status === 'queued') {
        progressStartTime = null;
        metaEl.style.display = 'none';
      }
    }
  }
  const box = $('#resultActions');
  box.innerHTML = '';

  const isUpDrive = job.output_mode === 'drive';
  if(job.direct_links?.length) jobResultsCache.set(job.id, job.direct_links);

  if (job.status === 'pending' || job.status === 'queued') {
    box.insertAdjacentHTML('beforeend', `
      <div class="result-notice warning">
        <div>◷</div><div><strong>Job đang xếp hàng</strong><span>Hệ thống sẽ tự bắt đầu ngay khi có worker trống.</span></div>
      </div>`);
  }

  if (job.status === 'running') {
    const stageIcon = isUpDrive ? '⇄' : '◎';
    const stageMsg  = isUpDrive ? 'Đang chuyển sang Drive đích' : 'Đang chuẩn bị liên kết tải';
    box.insertAdjacentHTML('beforeend', `
      <div class="result-notice warning">
        <div>${stageIcon}</div><div><strong>${stageMsg}</strong><span>Bạn có thể rời trang; job vẫn tiếp tục chạy trên server.</span></div>
      </div>`);
    box.insertAdjacentHTML('beforeend',
      `<button class="btn danger small" id="cancelJobBtn">Dừng job</button>`);
  }

  if (job.status === 'completed') {
    if (isUpDrive) {
      // UpDrive mode — hiện link Drive đích
      const count = job.direct_links_count || 0;
      box.insertAdjacentHTML('beforeend', `
        <div class="result-notice success">
          <div>✓</div><div><strong>Đã chuyển ${count} file</strong><span>Kết quả đã xuất hiện trong tài khoản Drive đích.</span></div>
        </div>`);
      if (job.drive_view_link) {
        box.insertAdjacentHTML('beforeend',
          `<a class="btn primary" target="_blank" rel="noopener" href="${esc(job.drive_view_link)}">Mở trên Drive ↗</a>`);
      }
    } else {
      const count = job.direct_links_count || 0;
      if (count > 0) {
        box.insertAdjacentHTML('beforeend', `
            <div class="result-notice success">
              <div>✓</div><div><strong>${count} file đã sẵn sàng</strong><span>Chế độ tải từng file sẽ cho bạn chọn thư mục lưu và dựng lại cây thư mục; thiết bị không hỗ trợ sẽ nhận ZIP giữ nguyên cấu trúc.</span></div>
          </div>
          <div class="download-actions">
            ${job.output_mode === 'server_zip'
              ? '<button class="btn primary" id="downloadZipBtn">Tải một file ZIP</button>'
              : `<button class="btn primary" id="downloadFilesBtn">Tải ${count} file</button>`}
            <button class="btn ghost" id="copyResultLinksBtn">Copy liên kết kết quả</button>
          </div>`);
        const links = job.direct_links || [];
        if($('#downloadZipBtn')) $('#downloadZipBtn').onclick = () => triggerServerZipDownload(links, job.result_name);
        if($('#downloadFilesBtn')) $('#downloadFilesBtn').onclick = () => triggerClientDownloads(links, job.id, job.result_name);
        if($('#copyResultLinksBtn')) $('#copyResultLinksBtn').onclick = async () => {
          const text = links.filter(x => x.ok && x.url).map(x => x.url).join('\n');
          try{ await navigator.clipboard.writeText(text); toast('Đã copy liên kết kết quả', 'success'); }
          catch{ toast('Trình duyệt không cho phép copy tự động', 'warning'); }
        };
      } else {
        box.insertAdjacentHTML('beforeend', `
          <div class="result-notice error">
            <div>!</div><div><strong>Chưa có file nào sẵn sàng</strong><span>Kiểm tra lại quyền xem file của tài khoản Drive nguồn.</span></div>
          </div>`);
      }
    }
  }

  if (job.status === 'error') {
    box.insertAdjacentHTML('beforeend', `
      <div class="result-notice error">
        <div>!</div><div><strong>Job xử lý không thành công</strong><span>${esc(job.error_message || 'Mở nhật ký kỹ thuật để xem chi tiết.')}</span></div>
      </div>
      <button class="btn ghost" id="restoreFailedJobBtn">Dùng lại danh sách liên kết</button>`);
    if($('#restoreFailedJobBtn')) $('#restoreFailedJobBtn').onclick = () => restoreJobLinks(job);
  }

  if (job.status === 'cancelled') {
    box.insertAdjacentHTML('beforeend', `<div class="result-notice"><div>■</div><div><strong>Job đã dừng</strong><span>Danh sách liên kết vẫn có thể dùng lại để tạo job mới.</span></div></div><button class="btn ghost" id="restoreCancelledJobBtn">Dùng lại liên kết</button>`);
    if($('#restoreCancelledJobBtn')) $('#restoreCancelledJobBtn').onclick = () => restoreJobLinks(job);
  }

  if (['pending','running','queued'].includes(job.status)) {
    if ($('#cancelJobBtn')) {
if($('#cancelJobBtn')) $('#cancelJobBtn').onclick = async () => {
        await api(`/api/jobs/${job.id}/cancel`, { method: 'POST', body: '{}' });
        toast('Đã gửi yêu cầu hủy');
      };
    }
  }
}

function restoreJobLinks(job) {
  const links = Array.isArray(job?.links) ? job.links : [];
  const plainLinks = links.filter(x => typeof x === 'string' && x.startsWith('http'));
  if(!plainLinks.length){ toast('Job này không có danh sách liên kết có thể khôi phục', 'warning'); return; }
  $('#linksInput').value = plainLinks.join('\n');
  if(job.result_name) $('#resultName').value = `${job.result_name}_retry`.slice(0, 120);
  updateLinkInspector();
  showPage('tool');
  toast(`Đã khôi phục ${plainLinks.length} liên kết`, 'success');
}

// ================================================================
// JOB POLLING
// ================================================================
async function pollJob(id){
  clearTimeout(pollTimer);
  activeJobId = id;
  safeStorageSet(STORAGE.activeJob, id);
  const tick = async () => {
    try{
      const job = await api(`/api/jobs/${id}`);
      setProgress(job);
      const logs = await api(`/api/jobs/${id}/logs`);
      $('#logBox').textContent = logs.map(l => `[${l.level}] ${l.message}`).join('\n');
      $('#logBox').scrollTop = $('#logBox').scrollHeight;
      if(['completed','error','cancelled'].includes(job.status)){
        clearTimeout(pollTimer);
        pollTimer = null;
        safeStorageSet(STORAGE.activeJob, '');
        loadJobs();
      }else{
        pollTimer = setTimeout(tick, document.hidden ? 5000 : 2000);
      }
    }catch(e){
      clearTimeout(pollTimer);
      pollTimer = null;
      toast(e.message);
    }
  };
  await tick();
}

// ================================================================
// JOBS LIST
// ================================================================
async function loadJobs(){
  const box = $('#jobsList');
  box.innerHTML = '<div class="item">Đang tải...</div>';
  try{
    jobsCache = await api('/api/jobs');
    renderJobsList();
  }catch(e){
    box.innerHTML = `<div class="item">${esc(e.message)}</div>`;
  }
}

function renderJobsList(){
  const box = $('#jobsList');
  if(!box) return;
  const q = ($('#jobsSearch')?.value || '').trim().toLowerCase();
  const runningStatuses = new Set(['pending','queued','running']);
  const rows = jobsCache.filter(j => {
    const matchesStatus = jobsStatusFilter === 'all'
      || (jobsStatusFilter === 'running' && runningStatuses.has(j.status))
      || j.status === jobsStatusFilter;
    const haystack = `${j.result_name || ''} ${j.status || ''} ${j.stage || ''}`.toLowerCase();
    return matchesStatus && (!q || haystack.includes(q));
  });
  const statusLabel = {pending:'Đang chờ', queued:'Trong hàng đợi', running:'Đang chạy', completed:'Hoàn tất', error:'Có lỗi', cancelled:'Đã dừng'};
  const modeLabel = {zip:'Từng file', server_zip:'ZIP', drive:'Drive đích'};
  box.innerHTML = rows.map(j => {
    const primaryAction = j.status === 'completed' && (j.direct_links_count || j.drive_view_link)
      ? `<button class="btn small primary view-job" data-id="${esc(j.id)}">Mở kết quả</button>`
      : runningStatuses.has(j.status)
        ? `<button class="btn small primary view-job" data-id="${esc(j.id)}">Theo dõi</button>`
        : `<button class="btn small ghost reuse-job" data-id="${esc(j.id)}">Dùng lại link</button>`;
    return `<div class="item job-item">
        <div class="item-head">
          <div>
            <b>${esc(j.result_name)}</b>
            <p>${esc(j.stage || 'Chưa có mô tả')}</p>
            <small>${shortDate(j.created_at)}</small>
          </div>
          <span class="badge ${esc(j.status)}">${statusLabel[j.status] || esc(j.status)} · ${j.progress}%</span>
        </div>
        <div class="plan-meta"><span class="badge">${modeLabel[j.output_mode] || esc(j.output_mode)}</span><span class="badge">${j.links?.length || 0} đầu vào</span>${j.direct_links_count ? `<span class="badge completed">${j.direct_links_count} kết quả</span>` : ''}</div>
        <div class="actions">
          ${primaryAction}
          <button class="btn small ghost view-job" data-id="${esc(j.id)}">Xem chi tiết</button>
        </div>
        ${j.error_message ? `<p class="hint error-text">${esc(j.error_message)}</p>` : ''}
      </div>`;
  }).join('') || '<div class="item empty-state"><b>Không tìm thấy job phù hợp</b><p>Thử đổi bộ lọc hoặc tạo một job mới trong Workspace.</p></div>';
  $$('.view-job').forEach(b => b.onclick = () => { activeJobId = b.dataset.id; showPage('tool'); pollJob(activeJobId); });
  $$('.reuse-job').forEach(b => b.onclick = () => {
    const job = jobsCache.find(j => j.id === b.dataset.id);
    if(job) restoreJobLinks(job);
  });
}

// ================================================================
// ADMIN FUNCTIONS (giữ nguyên 100%)
// ================================================================
async function createDestFolder(){
  try{
    const r = await api('/api/drive/destination/folder', {method:'POST', body: JSON.stringify({name:'AutoTool Results', parent_id:''})});
    if($('#targetFolderId')) $('#targetFolderId').value = r.folder_id;
    toast('Đã tạo/lấy folder Drive đích', 'success');
    addNotification('Drive đích đã sẵn sàng', 'Thư mục AutoTool Results đã được chọn làm nơi nhận file.', 'success', {page:'tool', fingerprint:`destination-folder-${r.folder_id}`, native:false});
  }catch(e) { toast(e.message, 'error'); }
}

async function ensurePlansCache(){
  if(!plansCache.length) plansCache = await api('/api/plans');
  return plansCache;
}
function findAdminUser(id){ return adminUsersCache.find(u => Number(u.id) === Number(id)); }
function openAdminUserModal(id){
  const u = findAdminUser(id);
  if(!u){ toast('Không tìm thấy user'); return; }
if($('#adminUserModal')) $('#adminUserModal').hidden = false;
  $('#adminEditUserId').value = u.id;
  $('#adminEditEmail').textContent = u.email;
  $('#adminEditSub').textContent = `#${u.id} · ${u.name || 'Không tên'} · tạo lúc ${shortDate(u.created_at)}`;
  $('#adminEditBalanceNow').textContent = u.balance_label || fmtMoney(u.balance_vnd);
  $('#adminEditFreeUsagesNow').textContent = (u.free_usages || 0) + ' lượt';
  $('#adminEditBalanceExact').value = u.balance_vnd || 0;
  $('#adminEditBalanceDelta').value = '';
  $('#adminEditPlanNow').textContent = `${u.plan_code || 'none'} · hết hạn ${shortDate(u.plan_expires_at)}`;
  $('#adminEditExpiresAt').value = toDateTimeLocal(u.plan_expires_at);
  $('#adminEditNewPassword').value = '';
  $('#adminToggleActiveBtn').textContent = u.is_active ? 'Khóa tài khoản' : 'Mở tài khoản';
  $('#adminToggleAdminBtn').textContent = u.is_admin ? 'Gỡ quyền admin' : 'Cấp quyền admin';
  $('#adminToggleAdminBtn').disabled = !u.can_edit_admin_flag;

  ensurePlansCache().then(plans => {
    $('#adminEditPlanSelect').innerHTML = plans.map(p => `<option value="${esc(p.code)}">${esc(p.name)} · ${esc(p.price_label)}</option>`).join('');
    const current = plans.find(p => p.code === u.plan_code);
    $('#adminEditPlanSelect').value = current ? current.code : (plans[0]?.code || '');
  }).catch(e => toast(e.message));
}
function closeAdminUserModal(){ $('#adminUserModal').hidden = true; }
async function refreshAdminAfterEdit(){
  await loadAdminUsers();
  await loadAdminOverview();
  await loadMe();
  const id = $('#adminEditUserId').value;
  if(id && !$('#adminUserModal').hidden) openAdminUserModal(id);
}
async function loadAdminOverview(){
  const ov = await api('/api/admin/overview');
  const labels = {
    users: 'Users',
    admins: 'Admins',
    paid_users: 'Có gói',
    total_balance_label: 'Tổng số dư',
    jobs: 'Jobs',
    running_jobs: 'Đang chạy',
    payments_pending: 'Nạp chờ',
    pending_value_label: 'Tiền chờ',
    approved_revenue_label: 'Đã duyệt',
  };
  $('#adminOverview').innerHTML = Object.entries(ov).map(([k,v]) => `<article class="stat-card"><span>${labels[k] || k}</span><b>${esc(v)}</b></article>`).join('');
}
function renderAdminUsers(){
  const q = ($('#adminUserSearch')?.value || '').trim().toLowerCase();
  const rows = adminUsersCache.filter(u => !q || [u.email,u.name,u.plan_code,u.access_reason,String(u.balance_vnd),u.total_paid_label].some(x => String(x || '').toLowerCase().includes(q)));
  $('#adminUsersBody').innerHTML = rows.map(u => {
    const state = u.is_active ? '<span class="badge active">active</span>' : '<span class="badge locked">locked</span>';
    const role = u.is_super_admin ? '<span class="badge admin">owner</span>' : (u.is_admin ? '<span class="badge admin">admin</span>' : '<span class="badge">user</span>');
    const full = u.full_access ? '<span class="badge active">full</span>' : '<span class="badge pending">no plan</span>';
    return `<tr>
      <td><div class="user-main"><b>${esc(u.email)}</b><small>#${u.id} · ${esc(u.name || '')} · ${shortDate(u.created_at)}</small></div></td>
      <td>${role} ${full}<div class="hint">${esc(u.plan_code)} · hết hạn: ${shortDate(u.plan_expires_at)}</div></td>
      <td><b>${esc(u.balance_label || fmtMoney(u.balance_vnd))}</b><div class="hint">Đã nạp duyệt: ${esc(u.total_paid_label || '0đ')}</div></td>
      <td>${state}<div class="hint">Job: ${u.job_count || 0} · gần nhất: ${shortDate(u.last_job_at)}</div></td>
      <td><button class="btn small primary manage-user" data-id="${u.id}">Quản lý</button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="5">Không có user phù hợp</td></tr>';
  $$('.manage-user').forEach(b => b.onclick = () => openAdminUserModal(b.dataset.id));
}
async function loadAdminUsers(){
  adminUsersCache = await api('/api/admin/users');
  renderAdminUsers();
}
async function loadAdminPayments(){
  const pays = await api('/api/admin/payments');
  $('#adminPayments').innerHTML = pays.map(p => `<div class="item"><b>#${p.id} · ${esc(p.amount_label || fmtMoney(p.amount_vnd))}</b><p>User ${p.user_id} · ${esc(p.transfer_note)}</p><span class="badge ${esc(p.status)}">${esc(p.status)}</span><div class="actions"><button class="btn small primary approve-pay" data-id="${p.id}">Duyệt</button><button class="btn small ghost reject-pay" data-id="${p.id}">Từ chối</button></div></div>`).join('') || '<div class="item">Không có yêu cầu nạp</div>';
  $$('.approve-pay').forEach(b => b.onclick = async () => { await api(`/api/admin/payments/${b.dataset.id}/approve`, {method:'POST', body:'{}'}); await loadAdminPayments(); await loadAdminUsers(); await loadAdminOverview(); });
  $$('.reject-pay').forEach(b => b.onclick = async () => { await api(`/api/admin/payments/${b.dataset.id}/reject`, {method:'POST', body:'{}'}); await loadAdminPayments(); await loadAdminOverview(); });
}
async function loadAdminJobs(){
  const jobs = await api('/api/admin/jobs');
  $('#adminJobs').innerHTML = jobs.map(j => `<div class="item"><b>${esc(j.result_name || j.id)}</b><p>User ${j.user_id} · ${esc(j.stage || '')}</p><span class="badge ${esc(j.status)}">${esc(j.status)} · ${j.progress}%</span>${j.error_message ? `<p class="hint">${esc(j.error_message)}</p>` : ''}</div>`).join('') || '<div class="item">Chưa có job</div>';
}
async function loadAdmin(){
  if(!me || !me.is_admin){
    removeAdminNav();
    showPage('home');
    return;
  }
  try{
    await ensurePlansCache();
    await Promise.all([loadAdminOverview(), loadAdminUsers(), loadAdminPayments(), loadAdminJobs()]);
  }catch(e) { toast(e.message, 'error'); }
}

// ================================================================
// BIND EVENT LISTENERS
// ================================================================
function bind(){
  $$('.nav-link').forEach(b => b.addEventListener('click', () => b.dataset.page && showPage(b.dataset.page)));
  $('#notificationBtn')?.addEventListener('click', async (event) => { event.stopPropagation(); await syncServerNotifications({announce:false}); toggleNotificationPanel(); });
  $('#notificationPanel')?.addEventListener('click', event => event.stopPropagation());
  $('#markAllReadBtn')?.addEventListener('click', markAllNotificationsRead);
  $('#enableBrowserNotifyBtn')?.addEventListener('click', enableBrowserNotifications);
  $('#notifyTelegramQuick')?.addEventListener('click', () => { closeNotificationPanel(); $('#telegramBtn')?.click(); });
  $('#notifyThemeQuick')?.addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'));
  $('#notifyPasswordQuick')?.addEventListener('click', () => { closeNotificationPanel(); openChangePass(); });
  $('#notifyLogoutQuick')?.addEventListener('click', () => { closeNotificationPanel(); $('#logoutBtn')?.click(); });
  document.addEventListener('click', closeNotificationPanel);
  $('#guideSearch')?.addEventListener('input', filterGuideModules);
  $$('[data-guide-target]').forEach(button => button.addEventListener('click', () => scrollToGuideTarget(button.dataset.guideTarget)));
  $$('.guide-toc button').forEach(button => button.addEventListener('click', () => {
    $$('.guide-toc button').forEach(item => item.classList.toggle('active', item === button));
  }));
  $$('.readiness-item').forEach(button => button.addEventListener('click', () => {
    const action = button.dataset.readyAction;
    if(action === 'login' && !me) openAuth('login');
    else if(action === 'plans') showPage('plans');
    else if(action === 'drive'){
      showPage('tool');
      requestAnimationFrame(() => $('.auth-panel')?.scrollIntoView({behavior:'smooth', block:'center'}));
    }
  }));
  $('#systemChip')?.addEventListener('click', () => { checkSystemHealth(); toast('Đang kiểm tra trạng thái hệ thống...'); });
  $('#mobileMenuBtn')?.addEventListener('click', () => {
    const open = $('#mainNav')?.classList.toggle('open');
    $('#mobileMenuBtn').classList.toggle('open', Boolean(open));
    $('#mobileMenuBtn').setAttribute('aria-expanded', String(Boolean(open)));
  });
  $('#themeToggle')?.addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'));
if($('#logoutBtn')) $('#logoutBtn').onclick = performLogout;
if($('#mobileLogoutBtn')) $('#mobileLogoutBtn').onclick = performLogout;
if($('#mobileChangePassBtn')) $('#mobileChangePassBtn').onclick = () => { $('#mainNav')?.classList.remove('open'); openChangePass(); };
if($('#refreshBtn')) $('#refreshBtn').onclick = loadMe;
if($('#reloadJobsBtn')) $('#reloadJobsBtn').onclick = loadJobs;
if($('#reloadAdminBtn')) $('#reloadAdminBtn').onclick = loadAdmin;
if($('#reloadAdminPaymentsBtn')) $('#reloadAdminPaymentsBtn').onclick = loadAdminPayments;
if($('#reloadAdminJobsBtn')) $('#reloadAdminJobsBtn').onclick = loadAdminJobs;
if($('#adminUserSearch')) $('#adminUserSearch').addEventListener('input', renderAdminUsers);
  $('#jobsSearch')?.addEventListener('input', renderJobsList);
  $$('#jobFilters button').forEach(button => button.addEventListener('click', () => {
    jobsStatusFilter = button.dataset.status || 'all';
    $$('#jobFilters button').forEach(x => x.classList.toggle('active', x === button));
    renderJobsList();
  }));

  if($('#linksInput')){
    // $('#linksInput').value = safeStorageGet(STORAGE.linkDraft, ''); // user disliked autosave
if($('#linksInput')) $('#linksInput').addEventListener('input', updateLinkInspector);
    updateLinkInspector();
  }
  if($('#resultName')){
    $('#resultName').value = safeStorageGet(STORAGE.resultName, $('#resultName').value || 'ket_qua');
if($('#resultName')) $('#resultName').addEventListener('input', () => safeStorageSet(STORAGE.resultName, $('#resultName').value));
  }
  if($('#targetFolderId')){
    $('#targetFolderId').value = safeStorageGet(STORAGE.targetFolder, '');
if($('#targetFolderId')) $('#targetFolderId').addEventListener('input', () => safeStorageSet(STORAGE.targetFolder, $('#targetFolderId').value));
  }
  $('#pasteLinksBtn')?.addEventListener('click', async () => {
    try{
      const value = await navigator.clipboard.readText();
      if(!value.trim()) throw new Error('Clipboard đang trống');
      const current = $('#linksInput').value.trim();
      $('#linksInput').value = current ? `${current}\n${value.trim()}` : value.trim();
      const report = updateLinkInspector();
      toast(`Đã nhận ${report.valid.length} liên kết hợp lệ`, 'success');
    }catch(error){ toast(error.message || 'Không đọc được clipboard', 'warning'); }
  });

  // [MỚI] Cookie Input
  $('#cookieInput')?.addEventListener('input', updateCookieStatus);
  $('#clearCookieBtn')?.addEventListener('click', () => {
    if($('#cookieInput')) $('#cookieInput').value = '';
    updateCookieStatus();
    toast('Đã xóa Cookie');
  });

  // [MỚI] Mode Selector Logic
  if($('#modeClientBtn') && $('#modeUpDriveBtn')) {
    const btnClient = $('#modeClientBtn');
    const btnServerZip = $('#modeServerZipBtn');
    const btnUpDrive = $('#modeUpDriveBtn');
    const panelUpDrive = $('#upDrivePanel');
    const inputMode = $('#selectedOutputMode');

    const updateMode = (mode) => {
      inputMode.value = mode;
      safeStorageSet(STORAGE.outputMode, mode);
      btnClient.classList.toggle('active', mode === 'zip');
      if (btnServerZip) btnServerZip.classList.toggle('active', mode === 'server_zip');
      btnUpDrive.classList.toggle('active', mode === 'drive');
      if (panelUpDrive) {
        panelUpDrive.style.display = (mode === 'drive') ? 'block' : 'none';
      }
      updateModeGuidance(mode);
    };

    btnClient.addEventListener('click', () => updateMode('zip'));
    if (btnServerZip) btnServerZip.addEventListener('click', () => updateMode('server_zip'));
    btnUpDrive.addEventListener('click', () => updateMode('drive'));
    const savedMode = safeStorageGet(STORAGE.outputMode, 'zip');
    updateMode(['zip','server_zip','drive'].includes(savedMode) ? savedMode : 'zip');
  }

  // [MỚI] Scan Folder Logic
  if($('#openScanModalBtn')) {
if($('#openScanModalBtn')) $('#openScanModalBtn').onclick = () => {
      if(!me){ toast('Bạn cần đăng nhập và kết nối Drive Nguồn!'); return; }
if($('#scanFolderModal')) $('#scanFolderModal').hidden = false;
      $('#scanFolderInput').value = '';
      $('#scanFolderResult').style.display = 'none';
      $('#folderTreeView').innerHTML = '';
    };

    let scannedItems = [];
if($('#doScanFolderBtn')) $('#doScanFolderBtn').onclick = async () => {
      const link = $('#scanFolderInput').value.trim();
      if(!link){ toast('Vui lòng nhập link thư mục'); return; }
      
      const btn = $('#doScanFolderBtn');
      const oldText = btn.textContent;
      btn.disabled = true;
      
      let seconds = 0;
      btn.textContent = `Đang quét... (${seconds}s)`;
      const timerId = setInterval(() => {
        seconds++;
        btn.textContent = `Đang quét... (${seconds}s)`;
      }, 1000);
      
      try {
        const res = await api('/api/jobs/scan-folder', {
          method: 'POST',
          body: JSON.stringify({link})
        });
        
        scannedItems = res.items || [];
        if(scannedItems.length === 0) {
          toast('Thư mục trống hoặc không có quyền truy cập');
          return;
        }
        
        // Build Tree UI
        $('#scanFolderResult').style.display = 'block';
        const treeBox = $('#folderTreeView');
        
        let html = '';
        scannedItems.forEach((item, idx) => {
          const depth = item.path.length;
          const indent = '<span class="tree-indent"></span>'.repeat(depth);
          const icon = item.mimeType === 'application/vnd.google-apps.folder' ? '📂' : '📄';
          const sizeStr = item.size ? `(${(item.size/1024/1024).toFixed(1)}MB)` : '';
          
          html += `
            <div class="tree-item ${item.mimeType === 'application/vnd.google-apps.folder' ? 'folder' : 'file'}">
              ${indent}
              <input type="checkbox" id="scan_chk_${idx}" value="${esc(item.link || '')}" checked />
              <label for="scan_chk_${idx}" style="cursor:pointer">${icon} ${esc(item.name)} <small style="opacity:0.6">${sizeStr}</small></label>
            </div>
          `;
        });
        treeBox.innerHTML = html;
        toast(`Đã tìm thấy ${scannedItems.length} mục`);
        
      } catch(e) {
        toast(e.message);
      } finally {
        clearInterval(timerId);
        btn.textContent = oldText;
        btn.disabled = false;
      }
    };
if($('#scanSelectAllBtn')) $('#scanSelectAllBtn').onclick = () => $$('#folderTreeView input[type="checkbox"]').forEach(c => c.checked = true);
if($('#scanDeselectAllBtn')) $('#scanDeselectAllBtn').onclick = () => $$('#folderTreeView input[type="checkbox"]').forEach(c => c.checked = false);
if($('#addSelectedScannedBtn')) $('#addSelectedScannedBtn').onclick = () => {
      const checked = $$('#folderTreeView input[type="checkbox"]:checked');
      if(checked.length === 0) {
        toast('Chưa chọn mục nào'); return;
      }
      
      let linkObjects = Array.from(checked).map(c => {
         const idx = c.id.replace('scan_chk_', '');
         return scannedItems[idx];
      });
      
      // Lọc bỏ các thư mục (vì job runner chỉ tải file)
      linkObjects = linkObjects.filter(obj => obj.mimeType !== 'application/vnd.google-apps.folder');
      
      if(linkObjects.length === 0) {
        toast('Chỉ có thư mục rỗng, không có File nào để tải!');
        return;
      }
      
      const jsonStr = JSON.stringify(linkObjects);
if($('#scanFolderModal')) $('#scanFolderModal').hidden = true;
      toast(`Đang khởi tạo Job với ${linkObjects.length} File...`);
      startJob(jsonStr);
    };
  }
if($('#startJobBtn')) $('#startJobBtn').onclick = startJob;
if($('#clearBtn')) $('#clearBtn').onclick = () => {
    if($('#linksInput').value.trim() && !window.confirm('Xóa toàn bộ danh sách liên kết đang nhập?')) return;
    $('#linksInput').value = '';
    safeStorageSet(STORAGE.linkDraft, '');
    updateLinkInspector();
    $('#logBox').textContent = 'Nhật ký sẽ xuất hiện khi job bắt đầu...';
    if($('#cookieStatus')) $('#cookieStatus').innerHTML = '';
  };

  document.addEventListener('keydown', (event) => {
    if((event.ctrlKey || event.metaKey) && event.key === 'Enter' && $('#page-tool')?.classList.contains('active')){
      event.preventDefault();
      startJob();
    }
    if(event.key === 'Escape'){
      ['authModal','changePassModal','adminUserModal','scanFolderModal'].forEach(id => { const el = $('#' + id); if(el) el.hidden = true; });
    }
  });

  if($('#createDestFolderBtn')) $('#createDestFolderBtn').onclick = createDestFolder;
        
  if($('#topupAmount')) $('#topupAmount').addEventListener('input', loadTopupInfo);
  $$('.amount-preset').forEach(btn => {
    btn.onclick = () => {
      if($('#topupAmount')) {
        $('#topupAmount').value = btn.dataset.amount;
        loadTopupInfo();
      }
    };
  });

  $$('.copy-pay').forEach(b => b.onclick = async () => { const text = $('#' + b.dataset.copy).textContent; try{ await navigator.clipboard.writeText(text); toast('Đã copy'); }catch{ toast('Không copy được'); } });
if($('#topupBtn')) $('#topupBtn').onclick = async () => {
    const btn = $('#topupBtn');
    setLoading(btn, true);
    try{
      const r = await api('/api/payments/topup', {method:'POST', body: JSON.stringify({amount_vnd: Number($('#topupAmount').value), transfer_note: $('#topupNote').value})});
      renderPayment(r);
      toast('Đã tạo QR nạp.', 'success');
      addNotification('QR nạp tiền đã tạo', 'Chuyển đúng số tiền và giữ nguyên mã nạp để được cộng tự động.', 'info', {page:'topup', fingerprint:`topup-qr-${r.transfer_note || $('#topupNote').value}-${r.amount_vnd || $('#topupAmount').value}`, native:false});
      loadPayments();
    }catch(e) { toast(e.message, 'error'); }
    finally { setLoading(btn, false); }
  };
if($('#loginBtn')) $('#loginBtn').onclick = () => openAuth('login');
if($('#closeAuthBtn')) $('#closeAuthBtn').onclick = closeAuth;
if($('#authModal')) $('#authModal').addEventListener('click', (e) => { if(e.target.id === 'authModal') closeAuth(); });
if($('#showRegister')) $('#showRegister').onclick = (e) => { e.preventDefault(); openAuth('register'); };
if($('#showLogin')) $('#showLogin').onclick = (e) => { e.preventDefault(); openAuth('login'); };
  if($('#showForgotPass')) $('#showForgotPass').onclick = (e) => { e.preventDefault(); openAuth('forgot'); };
  if($('#backToLogin')) $('#backToLogin').onclick = (e) => { e.preventDefault(); openAuth('login'); };
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    setLoading(btn, true);
    try{
      await api('/api/auth/login', {method:'POST', body: JSON.stringify({email: $('#loginEmail').value, password: $('#loginPass').value})});
      location.reload();
    }catch(err) { toast(err.message, 'error'); }
    finally { setLoading(btn, false); }
  };
  $('#registerForm').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    setLoading(btn, true);
    try{
      await api('/api/auth/register', {method:'POST', body: JSON.stringify({name: $('#regName').value, email: $('#regEmail').value, password: $('#regPass').value})});
      location.reload();
    }catch(err) { toast(err.message, 'error'); }
    finally { setLoading(btn, false); }
  };
if($('#changePassBtn')) $('#changePassBtn').onclick = openChangePass;
if($('#closeChangePassBtn')) $('#closeChangePassBtn').onclick = closeChangePass;
if($('#changePassModal')) $('#changePassModal').addEventListener('click', (e) => { if(e.target.id === 'changePassModal') closeChangePass(); });
  $('#changePassForm').onsubmit = async (e) => {
    e.preventDefault();
    const old_password = $('#oldPass').value;
    const new_password = $('#newPass').value;
    const new_password2 = $('#newPass2').value;
    if(new_password !== new_password2){ toast('Mật khẩu mới nhập lại không khớp'); return; }
    try{
      await api('/api/auth/change-password', {method:'POST', body: JSON.stringify({old_password, new_password})});
      closeChangePass();
      toast('Đã đổi mật khẩu');
    }catch(err) { toast(err.message, 'error'); }
  };
if($('#closeAdminUserBtn')) $('#closeAdminUserBtn').onclick = closeAdminUserModal;
if($('#adminUserModal')) $('#adminUserModal').addEventListener('click', (e) => { if(e.target.id === 'adminUserModal') closeAdminUserModal(); });
if($('#adminSetBalanceBtn')) $('#adminSetBalanceBtn').onclick = async () => {
    const id = $('#adminEditUserId').value;
    try{
      await api(`/api/admin/users/${id}/balance/set`, {method:'POST', body: JSON.stringify({balance_vnd: Number($('#adminEditBalanceExact').value || 0), reason:'admin set exact balance'})});
      toast('Đã đặt số dư');
      await refreshAdminAfterEdit();
    }catch(e) { toast(e.message, 'error'); }
  };
if($('#adminDeltaBalanceBtn')) $('#adminDeltaBalanceBtn').onclick = async () => {
    const id = $('#adminEditUserId').value;
    const amount = Number($('#adminEditBalanceDelta').value || 0);
    if(!amount){ toast('Nhập số tiền cần cộng/trừ'); return; }
    try{
      await api(`/api/admin/users/${id}/balance`, {method:'POST', body: JSON.stringify({amount_vnd: amount, reason:'admin delta balance'})});
      toast('Đã cập nhật số dư');
      await refreshAdminAfterEdit();
    }catch(e) { toast(e.message, 'error'); }
  };
if($('#adminSetFreeUsageBtn')) $('#adminSetFreeUsageBtn').onclick = async () => {
    const id = $('#adminEditUserId').value;
    const amount = Number($('#adminEditFreeUsageExact').value || 0);
    const reason = $('#adminEditFreeUsageReason').value.trim();
    if(isNaN(amount) || amount < 0){ toast('Nhập số lượt miễn phí hợp lệ'); return; }
    if(!reason){ toast('Bắt buộc nhập lý do'); return; }
    try{
      await api(`/api/admin/users/${id}/free-usages`, {method:'POST', body: JSON.stringify({action: 'set', amount: amount, reason: reason})});
      toast('Đã đặt lượt miễn phí');
      await refreshAdminAfterEdit();
    }catch(e) { toast(e.message, 'error'); }
  };
if($('#adminSetPlanBtn')) $('#adminSetPlanBtn').onclick = async () => {
    const id = $('#adminEditUserId').value;
    const plan_code = $('#adminEditPlanSelect').value;
    const expiresValue = $('#adminEditExpiresAt').value;
    const payload = {plan_code};
    if(expiresValue) payload.expires_at = new Date(expiresValue).toISOString();
    try{
      await api(`/api/admin/users/${id}/plan`, {method:'POST', body: JSON.stringify(payload)});
      toast('Đã cấp gói');
      await refreshAdminAfterEdit();
    }catch(e) { toast(e.message, 'error'); }
  };
if($('#adminClearPlanBtn')) $('#adminClearPlanBtn').onclick = async () => {
    const id = $('#adminEditUserId').value;
    try{
      await api(`/api/admin/users/${id}/clear-plan`, {method:'POST', body:'{}'});
      toast('Đã gỡ gói');
      await refreshAdminAfterEdit();
    }catch(e) { toast(e.message, 'error'); }
  };
if($('#adminResetPassBtn')) $('#adminResetPassBtn').onclick = async () => {
    const id = $('#adminEditUserId').value;
    const password = $('#adminEditNewPassword').value;
    if(!password || password.length < 6){ toast('Mật khẩu phải từ 6 ký tự'); return; }
    try{
      await api(`/api/admin/users/${id}/password`, {method:'POST', body: JSON.stringify({password})});
      $('#adminEditNewPassword').value = '';
      toast('Đã đổi mật khẩu user');
    }catch(e) { toast(e.message, 'error'); }
  };
if($('#adminToggleActiveBtn')) $('#adminToggleActiveBtn').onclick = async () => {
    const id = $('#adminEditUserId').value;
    try{
      await api(`/api/admin/users/${id}/toggle-active`, {method:'POST', body:'{}'});
      toast('Đã đổi trạng thái tài khoản');
      await refreshAdminAfterEdit();
    }catch(e) { toast(e.message, 'error'); }
  };
if($('#adminToggleAdminBtn')) $('#adminToggleAdminBtn').onclick = async () => {
    const id = $('#adminEditUserId').value;
    const u = findAdminUser(id);
    if(!u){ toast('Không tìm thấy user'); return; }
    try{
      await api(`/api/admin/users/${id}/admin-flag`, {method:'POST', body: JSON.stringify({is_admin: !u.is_admin})});
      toast('Đã đổi quyền admin');
      await refreshAdminAfterEdit();
    }catch(e){ toast(e.message); }
  };
if($('#telegramBtn')) $('#telegramBtn').onclick = async () => {
    const tid = prompt("Nhập Chat ID Telegram của bạn:\n(Để lấy Chat ID, hãy chat với bot @aututoolpro_bot trên Telegram)");
    if(tid !== null) {
      try {
        await api('/api/me/telegram', {method:'POST', body: JSON.stringify({telegram_id: tid})});
        toast('Đã cập nhật Telegram ID', 'success');
        addNotification('Telegram đã được liên kết', 'Job mới có thể gửi cập nhật tới Chat ID bạn vừa lưu.', 'success', {page:'guide', fingerprint:`telegram-${me?.id || 'user'}-${tid}`, native:false});
        await loadMe();
      } catch(e) {
        toast(e.message);
      }
    }
  };
}

// ================================================================
// INIT
// ================================================================
(async function init(){
  notificationItems = safeStorageJSON(STORAGE.notifications, []);
  if(!Array.isArray(notificationItems)) notificationItems = [];
  if(!notificationItems.length){
    addNotification('Chào mừng đến AutoTool Pro', 'Hoàn tất ba mục trong bảng Sẵn sàng để bắt đầu job đầu tiên.', 'info', {page:'tool', fingerprint:'welcome-v14', native:false});
  }
  const preferredTheme = safeStorageGet(STORAGE.theme, window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  applyTheme(preferredTheme);
  const rawHash = (location.hash || '#home').slice(1);
  const [hashPage, hashQuery=''] = rawHash.split('?');
  bind();
  renderNotifications();
  checkSystemHealth();
  await loadMe();
  await syncServerNotifications({announce:false});
  showPage(hashPage || 'home');
  const hashParams = new URLSearchParams(hashQuery);
  if(hashParams.get('success') === 'Connected'){
    toast('Đã kết nối Google Drive thành công', 'success');
    addNotification('Google Drive đã kết nối', 'Workspace đã cập nhật tài khoản Drive của bạn.', 'success', {page:'tool', fingerprint:`drive-connected-${me?.id || 'user'}-${Date.now()}`, native:false});
  }
  if(hashParams.get('error')){
    toast('Kết nối Google chưa hoàn tất. Vui lòng thử lại.', 'error');
    addNotification('Kết nối Drive chưa hoàn tất', 'Hãy thử lại và chọn đúng tài khoản có quyền xem file.', 'error', {page:'tool', fingerprint:`drive-connect-error-${new Date().toISOString().slice(0,10)}`, native:false});
  }
  loadPlans();
  const savedJob = safeStorageGet(STORAGE.activeJob, '');
  if(me && savedJob && hashPage === 'tool') pollJob(savedJob);
  window.setInterval(checkSystemHealth, 120000);
  window.setInterval(() => syncServerNotifications({announce:true}), 15000);
})();
