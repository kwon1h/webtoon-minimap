import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const popup = read('popup.js');
const userscript = read('webtoon-minimap.user.js');
const manifest = JSON.parse(read('manifest.json'));

assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
assert(!manifest.content_scripts, '사이트를 켜기 전에 자동 실행하면 안 됩니다');

async function testPopup(url, granted = true) {
  const events = [];
  const scripts = new Map();
  const elements = Object.fromEntries(['site', 'status', 'toggle'].map(id => [id, {
    textContent: '', hidden: true, disabled: false,
    classList: {toggle() {}},
    addEventListener(type, callback) { if (type === 'click') this.click = callback; }
  }]));
  const context = {
    document: {getElementById: id => elements[id]}, URL, TextEncoder,
    chrome: {
      tabs: {
        query: async () => [{id: 3, url}],
        reload: async id => events.push(['reload', id])
      },
      permissions: {
        request: async arg => {events.push(['request', arg]); return granted;},
        remove: async arg => {events.push(['remove', arg]); return true;}
      },
      scripting: {
        getRegisteredContentScripts: async ({ids}) => [...scripts.values()].filter(s => ids.includes(s.id)),
        registerContentScripts: async ([script]) => {scripts.set(script.id, script); events.push(['register', script]);},
        unregisterContentScripts: async ({ids}) => {ids.forEach(id => scripts.delete(id)); events.push(['unregister', ids]);},
        insertCSS: async arg => events.push(['css', arg]),
        executeScript: async arg => events.push(['js', arg])
      }
    }
  };
  vm.runInNewContext(popup, context);
  await new Promise(resolve => setImmediate(resolve));
  return {elements, events, scripts};
}

{
  const {elements, events, scripts} = await testPopup('https://reader.example.net/chapter/2');
  assert.equal(elements.toggle.textContent, '이 사이트에서 켜기');
  await elements.toggle.click();
  assert.equal(events[0][0], 'request');
  assert.deepEqual([...events[0][1].origins], ['https://reader.example.net/*']);
  assert.deepEqual([...scripts.values()][0].matches[0], 'https://reader.example.net/*');
  assert.deepEqual([...scripts.values()][0].css[0], 'content.css');
  assert.equal(events[2][0], 'css');
  assert.equal(events[3][0], 'js');
  assert.equal(elements.toggle.textContent, '이 사이트에서 끄기');
  await elements.toggle.click();
  assert.equal(scripts.size, 0);
  assert.equal(events.at(-1)[0], 'reload');
  assert.equal(events.find(x => x[0] === 'remove')[1].origins[0], 'https://reader.example.net/*');
}

{
  const {elements, events} = await testPopup('https://reader.example.net/', false);
  await elements.toggle.click();
  assert.deepEqual(events.map(x => x[0]), ['request']);
  assert.match(elements.status.textContent, /승인되지/);
}

{
  const {elements} = await testPopup('chrome://extensions');
  assert.match(elements.status.textContent, /일반 웹페이지/);
  assert.equal(elements.toggle.hidden, true);
}

{
  const saved = new Map();
  const menu = [];
  let reloaded = false;
  const window = {};
  window.top = window;
  const context = {
    window,
    location: {protocol: 'https:', hostname: 'reader.example.net', reload: () => {reloaded = true;}},
    GM_getValue: (key, fallback) => saved.get(key) ?? fallback,
    GM_setValue: (key, value) => saved.set(key, value),
    GM_registerMenuCommand: (label, callback) => menu.push({label, callback})
  };
  vm.runInNewContext(userscript, context);
  assert.match(menu[0].label, /이 사이트에서 켜기/);
  assert.equal(saved.size, 0);
  menu[0].callback();
  assert.equal(saved.get('webtoon_minimap_enabled:https://reader.example.net'), true);
  assert.equal(reloaded, true);
}

assert(!read('README.md').includes('사용자가 제공한'));
console.log('Manifest, 사이트별 권한 켜기/끄기, 승인 거부, 비지원 탭, 사용자 스크립트 기본 꺼짐: 통과');
