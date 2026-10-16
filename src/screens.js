// 画面パネル（HTML）の切り替え。show(null) ですべて閉じる
const Screens = (() => {
  'use strict';
  function show(id) {
    for (const el of document.querySelectorAll('.screen')) el.classList.toggle('show', el.id === id);
  }
  return { show };
})();
