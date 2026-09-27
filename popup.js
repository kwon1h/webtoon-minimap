'use strict';

const site = document.getElementById('site');
const status = document.getElementById('status');
const toggle = document.getElementById('toggle');
let activeTab;
let originPattern;
let scriptId;
let enabled = false;

// Stable, reversible identifier for each exact scheme + hostname.
function idFor(origin) {
  return `site-${Array.from(new TextEncoder().encode(origin), byte =>
    byte.toString(16).padStart(2, '0')).join('')}`;
}

function render() {
  toggle.hidden = false;
  toggle.textContent = enabled ? '이 사이트에서 끄기' : '이 사이트에서 켜기';
  toggle.classList.toggle('off', enabled);
  status.textContent = enabled ? '사용 중' : '사용 안 함';
}

async function init() {
  try {
    [activeTab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (!activeTab?.url) throw new Error('현재 탭의 주소를 확인할 수 없습니다.');
    const url = new URL(activeTab.url);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('일반 웹페이지에서만 사용할 수 있습니다.');
    }
    site.textContent = url.host;
    // Match patterns omit ports; Chrome grants origin permissions per scheme/host.
    originPattern = `${url.protocol}//${url.hostname}/*`;
    scriptId = idFor(`${url.protocol}//${url.hostname}`);
    const scripts = await chrome.scripting.getRegisteredContentScripts({ids: [scriptId]});
    enabled = scripts.length > 0;
    render();
  } catch (error) {
    status.textContent = error.message;
  }
}

async function onToggle() {
  toggle.disabled = true;
  try {
    if (enabled) {
      await chrome.scripting.unregisterContentScripts({ids: [scriptId]});
      await chrome.permissions.remove({origins: [originPattern]});
      enabled = false;
      // Unregistering only affects future documents; refresh the current tab.
      await chrome.tabs.reload(activeTab.id);
    } else {
      // The permission prompt must start directly from this click.
      const granted = await chrome.permissions.request({origins: [originPattern]});
      if (!granted) {
        status.textContent = '사이트 접근 권한이 승인되지 않았습니다.';
        return;
      }
      await chrome.scripting.registerContentScripts([{
        id: scriptId,
        js: ['content.js'],
        css: ['content.css'],
        matches: [originPattern],
        allFrames: true,
        runAt: 'document_idle',
        persistAcrossSessions: true
      }]);
      enabled = true;
      // Registration applies on navigation; inject now into the current tab.
      await chrome.scripting.insertCSS({target: {tabId: activeTab.id}, files: ['content.css']});
      await chrome.scripting.executeScript({target: {tabId: activeTab.id, allFrames: true}, files: ['content.js']});
    }
    render();
  } catch (error) {
    status.textContent = `적용하지 못했습니다: ${error.message}`;
  } finally {
    toggle.disabled = false;
  }
}

toggle.addEventListener('click', onToggle);
init();
