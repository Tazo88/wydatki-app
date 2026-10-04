const C='wydatki-v7';
const FILES=['./','index.html','style.css?v=7','app.js?v=7','help.js?v=7','receipt.js?v=7','sync.js?v=7','plan.js?v=7','manifest.webmanifest','icons/icon-192.png','icons/icon-512.png','icons/apple-touch-icon.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.origin!==location.origin)return; // CDN (OCR) idzie bezpośrednio
  // network-first (świeże wersje), fallback do cache offline
  e.respondWith(fetch(e.request.url,{cache:'no-cache',credentials:'same-origin'}).then(r=>{const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp));return r}).catch(()=>caches.match(e.request,{ignoreSearch:true}).then(r=>r||caches.match('index.html'))));
});
// przypomnienia (Web Push, treść zaszyfrowana end-to-end przez przeglądarkę)
self.addEventListener('push',e=>{let d={};try{d=e.data?e.data.json():{}}catch(x){}
  const title=typeof d.title==='string'?d.title.slice(0,120):'Wydatki';const body=typeof d.body==='string'?d.body.slice(0,300):'';
  e.waitUntil(self.registration.showNotification(title,{body,tag:typeof d.tag==='string'?d.tag.slice(0,80):undefined,icon:'icons/icon-192.png',badge:'icons/icon-192.png',data:{url:'./?t=plan'}}))});
self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>{for(const c of cs){if('focus' in c){c.navigate&&c.navigate('./?t=plan').catch(()=>{});return c.focus()}}return self.clients.openWindow('./?t=plan')}))});
