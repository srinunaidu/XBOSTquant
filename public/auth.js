/* XBOST client auth guard — include on every protected page. */
(function () {
  'use strict';
  function badge(user) {
    let el = document.getElementById('authArea');
    if (!el) return;
    const isAdmin = user.role === 'admin';
    el.innerHTML =
      '<span class="px-2.5 py-1 rounded-full bg-zinc-800 border border-zinc-700 text-zinc-300 num text-xs">👤 ' +
      user.username + (isAdmin ? ' · admin' : '') + '</span>' +
      (isAdmin ? '<a href="/users.html" class="btn-ghost btn !py-1.5 !px-3 !text-xs" style="text-decoration:none">👥 Users</a>' : '') +
      '<button id="btnLogout" class="btn-ghost btn !py-1.5 !px-3 !text-xs">⏻ Logout</button>';
    document.getElementById('btnLogout').onclick = async () => {
      await fetch('/api/logout', { method: 'POST' });
      location.href = '/login.html';
    };
  }
  fetch('/api/me').then(r => {
    if (!r.ok) { location.href = '/login.html'; return null; }
    return r.json();
  }).then(j => { if (j && j.user) badge(j.user); })
    .catch(() => location.href = '/login.html');
})();
