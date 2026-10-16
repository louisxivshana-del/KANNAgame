// オフラインランキング（端末内の localStorage に上位10件を保存）
const Ranking = (() => {
  'use strict';

  const KEY = 'kanna.ranking';
  const NAME_KEY = 'kanna.lastName';
  const SIZE = 10;

  function load() {
    try {
      const list = JSON.parse(localStorage.getItem(KEY) || '[]');
      return Array.isArray(list) ? list.filter(e => e && typeof e.score === 'number') : [];
    } catch { return []; }
  }

  function save(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* 保存できない環境では無視 */ }
  }

  // 登録したら何位になるか（ランク外なら -1）。同点は既存の記録を上位にする
  function rankOf(score) {
    if (score <= 0) return -1;
    const list = load();
    let i = 0;
    while (i < list.length && list[i].score >= score) i++;
    return i < SIZE ? i : -1;
  }

  function add(entry) {
    const list = load();
    const i = rankOf(entry.score);
    if (i < 0) return -1;
    list.splice(i, 0, entry);
    save(list.slice(0, SIZE));
    try { localStorage.setItem(NAME_KEY, entry.name); } catch { /* ignore */ }
    return i;
  }

  function best() {
    const list = load();
    return list.length ? list[0].score : 0;
  }

  function lastName() {
    try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; }
  }

  return { load, rankOf, add, best, lastName, SIZE };
})();
