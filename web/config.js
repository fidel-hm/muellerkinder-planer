// URL des Cloudflare Workers - nach "npm run deploy" im Ordner worker/ hier eintragen.
// Beispiel: "https://muellerkinder-planer.deinname.workers.dev"
// Lokal (python3 -m http.server) geht es automatisch an "wrangler dev".
window.PLANER_API = ['127.0.0.1', 'localhost'].includes(location.hostname)
  ? 'http://127.0.0.1:8787'
  : 'HIER_DIE_WORKER_URL_EINTRAGEN';
