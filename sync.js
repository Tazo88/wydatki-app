'use strict';
// Konto + synchronizacja (pieniądze prywatne, Plan wspólny dla domu) + powiadomienia push.
(function(){
const API='https://wydatki-receipt.tazo88.workers.dev';
const LS=localStorage, J=(k,d)=>{try{const v=JSON.parse(LS.getItem(k));return v??d}catch(e){return d}}, S=(k,v)=>LS.setItem(k,JSON.stringify(v));
let acct=J('acct',null), members=J('members',[]), syncing=false, again=false;
const PLAN_KEY='plan';

async function api(method,path,body){
  const h={};if(body!==undefined)h['Content-Type']='application/json';if(acct&&acct.token)h.Authorization='Bearer '+acct.token;
  let r;try{r=await fetch(API+path,{method,headers:h,body:body===undefined?undefined:JSON.stringify(body)})}catch(e){const er=new Error('offline');er.code='offline';throw er}
  let j=null;try{j=await r.json()}catch(e){}
  if(r.status===401&&acct&&!/^\/api\/(login|register)/.test(path))dropAcct();
  if(!r.ok){const er=new Error((j&&j.error)||('http_'+r.status));er.code=(j&&j.error)||r.status;er.status=r.status;throw er}
  return j}
const ERR={rate_limited:'Za dużo prób – odczekaj chwilę i spróbuj ponownie.',bad_code:'Zły albo wygasły kod.',bad_key:'Zły klucz.',offline:'Brak internetu.',same_household:'Już jesteście w tym samym domu 🙂',full:'Ten dom jest pełny.',name:'Wpisz imię.',invite_required:'Konto zakłada się tylko z kodem zaproszenia od osoby, która ma już konto.',not_shared:'Ta osoba nie udostępnia pieniędzy.'};
const errMsg=e=>ERR[e.code]||('Błąd: '+e.message);

// ---------- Plan (lokalnie + sync) ----------
const plan={
  all(){return Object.values(J(PLAN_KEY,{})).filter(x=>!x.deleted)},
  put(it){const m=J(PLAN_KEY,{});it.updated=Date.now();it.dirty=true;m[it.id]=it;S(PLAN_KEY,m);changed();soon()},
  del(id){const m=J(PLAN_KEY,{});if(m[id]){m[id]={id,deleted:true,updated:Date.now(),dirty:true};S(PLAN_KEY,m);changed();soon()}},
};
const changed=()=>dispatchEvent(new Event('wy-plan'));

// ---------- synchronizacja ----------
const okStrList=a=>Array.isArray(a)&&a.length<=80&&a.every(c=>typeof c==='string'&&c.trim()&&c.length<=40);
const KV={cats:v=>okStrList(v),incCats:v=>okStrList(v),start:v=>v&&typeof v==='object'&&isFinite(+v.PLN)&&isFinite(+v.EUR)};
function slim(e){const d=Object.assign({},e);delete d.updated;if(d.photo&&!(typeof safePhoto==='function'&&safePhoto(d.photo)&&d.photo.length<250000))d.photo=null;return d}
async function sync(){
  if(!acct||!navigator.onLine)return;
  if(syncing){again=true;return}
  syncing=true;setSyncInfo('🔄 Synchronizuję…');
  try{
    const t0=Date.now(), pushedAt=+LS.getItem('pushedAt')||0, tomb=J('tomb',{});
    const local=await allExp(), byId=new Map(local.map(e=>[e.id,e]));
    const ents=local.filter(e=>(e.updated||e.created||1)>pushedAt).map(e=>({id:e.id,updated:e.updated||e.created||1,data:slim(e)}))
      .concat(Object.entries(tomb).filter(([,t])=>t>pushedAt).map(([id,t])=>({id,updated:t,deleted:true})));
    const snap=J('kvSnap',{}), kv=[];
    for(const k of Object.keys(KV)){const cur=LS.getItem(k);if(cur!==null&&cur!==snap[k]){try{kv.push({k,v:JSON.parse(cur),updated:Date.now()})}catch(e){}}}
    const pm=J(PLAN_KEY,{}), dirty=Object.values(pm).filter(x=>x.dirty);
    const sentPlan=new Map(dirty.map(x=>[x.id,x.updated]));
    let since=LS.getItem('syncSince')||'0:', planSince=LS.getItem('planSince')||'0:', moneyChanged=false, i=0, first=true, more=true;
    while(first||i<ents.length||more){
      const chunk=ents.slice(i,i+20);i+=20;
      const r=await api('POST','/api/sync',{since,planSince,entries:chunk,kv:first?kv:[],plan:first?dirty.map(({dirty,by,...x})=>x):[]});
      first=false;more=r.more;
      // pieniądze (tylko moje)
      const tb=J('tomb',{});
      for(const e of r.entries){
        const l=byId.get(e.id);
        if(e.deleted){if(l&&(l.updated||l.created||0)<=e.updated){await delExp(e.id,true);byId.delete(e.id);moneyChanged=true}continue}
        if(tb[e.id]&&tb[e.id]>=e.updated)continue;
        const c=typeof clean==='function'?clean(e.data,e.data&&e.data.type==='inc'?'inc':'exp'):null;if(!c)continue;
        c.updated=e.updated;if(!l||(l.updated||l.created||0)<e.updated){await putExp(c,true);byId.set(c.id,c);moneyChanged=true}
      }
      // ustawienia
      for(const x of r.kv){if(!KV[x.k]||!KV[x.k](x.v))continue;const s=JSON.stringify(x.v);const cur=LS.getItem(x.k);
        if(cur===null||cur===snap[x.k]||kv.some(y=>y.k===x.k)){LS.setItem(x.k,s);snap[x.k]=s;if(x.k==='cats'){cats=x.v.slice()}if(x.k==='incCats'){incCats=x.v.slice()}moneyChanged=true}}
      // plan (wspólny)
      const m=J(PLAN_KEY,{});
      for(const p of r.plan){const l=m[p.id];if(l&&l.dirty&&l.updated>p.updated&&!sentPlan.has(p.id))continue;
        if(p.deleted)delete m[p.id];else m[p.id]={id:p.id,kind:p.kind,title:String(p.title||''),notes:String(p.notes||''),due:String(p.due||''),done:!!p.done,remind_at:p.remind_at||null,by:p.by||null,updated:p.updated}}
      for(const[id,u] of sentPlan){if(m[id]&&m[id].updated===u){if(m[id].deleted)delete m[id];else m[id].dirty=false}}
      S(PLAN_KEY,m);
      since=r.since;planSince=r.planSince;LS.setItem('syncSince',since);LS.setItem('planSince',planSince);
    }
    for(const x of kv)snap[x.k]=JSON.stringify(x.v);S('kvSnap',snap);
    LS.setItem('pushedAt',String(t0));
    const tb=J('tomb',{});for(const id in tb)if(tb[id]<=t0)delete tb[id];S('tomb',tb);
    LS.setItem('lastSync',String(Date.now()));
    if(moneyChanged){try{renderCats();await refresh()}catch(e){}}
    changed();setSyncInfo('');dispatchEvent(new Event('wy-synced'));
  }catch(e){setSyncInfo(e.code==='offline'?'📴 Offline – zsynchronizuję później':'⚠️ Synchronizacja: '+errMsg(e))}
  finally{syncing=false;if(again){again=false;setTimeout(sync,300)}}
}
let tm;function soon(){clearTimeout(tm);tm=setTimeout(sync,1500)}
addEventListener('wy-change',soon);addEventListener('online',sync);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)sync()});
setInterval(()=>{if(!document.hidden)sync()},60000);
async function refreshMe(){if(!acct)return;try{const r=await api('GET','/api/me');members=r.household.members;S('members',members);acct.user=r.user;acct.share=!!r.share;acct.owner=!!r.owner;S('acct',acct);renderAcct();changed();who()}catch(e){}}
const who=()=>{if(typeof renderWho==='function')renderWho()};
function dropAcct(){acct=null;LS.removeItem('acct');members=[];S('members',[]);resetSync();flash='';renderAcct();who()}
// pieniądze partnera: tylko podgląd, pobierane na żądanie (nie zapisywane na telefonie)
async function partnerMoney(owner){let since='0:',more=true,entries=[],start=null;
  for(let i=0;more&&i<50;i++){const r=await api('POST','/api/partner/money',{owner,since});entries=entries.concat(r.entries.map(e=>e.data&&typeof e.data==='object'?Object.assign({},e.data,{id:e.id}):null).filter(Boolean));start=r.start;since=r.since;more=r.more}
  return{entries,start}}
function resetSync(){['syncSince','planSince','pushedAt','kvSnap'].forEach(k=>LS.removeItem(k))}
function setAcct(r){acct={token:r.token,user:r.user};S('acct',acct);resetSync();LS.removeItem(PLAN_KEY+'Old')}

// ---------- AI ----------
const nowLocal=()=>{const d=new Date();return ymd(d)+'T'+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')};
async function aiParse(text,mode){return (await api('POST','/api/parse',{text,mode,now:nowLocal(),cats,incCats,cur:LS.getItem('cur')||'PLN'})).items}
async function aiMoney(text){if(!acct||!navigator.onLine)return null;const it=(await aiParse(text,'money'))[0];if(!it)return null;
  return{type:it.kind==='income'?'inc':'exp',amount:it.amount,currency:it.currency,category:it.category,note:it.note,date:it.date}}

// ---------- push ----------
const pushOK=()=>'serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window;
const u8=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')+'==='.slice((s.length+3)%4)),c=>c.charCodeAt(0));
async function enablePush(){
  if(!pushOK())throw new Error(isIOS()?'Na iPhonie: najpierw dodaj aplikację do ekranu początkowego (iOS 16.4+) i otwórz ją z ikonki.':'Ta przeglądarka nie obsługuje powiadomień.');
  const perm=await Notification.requestPermission();if(perm!=='granted')throw new Error('Nie zezwolono na powiadomienia (zmień w ustawieniach telefonu).');
  const reg=await navigator.serviceWorker.ready;const {key}=await api('GET','/api/push/key');
  let sub=await reg.pushManager.getSubscription();
  if(sub&&sub.options&&sub.options.applicationServerKey){const a=new Uint8Array(sub.options.applicationServerKey);if(btoa(String.fromCharCode(...a)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')!==key){await sub.unsubscribe();sub=null}}
  if(!sub)sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:u8(key)});
  const j=sub.toJSON();await api('POST','/api/push/subscribe',{endpoint:j.endpoint,keys:j.keys,tz:Intl.DateTimeFormat().resolvedOptions().timeZone});
  LS.setItem('pushOn','1');}
const isIOS=()=>/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);

// ---------- UI konta (Ustawienia) ----------
const box=document.createElement('div');box.id='acct';
const set=document.getElementById('tab-set');set.insertBefore(box,set.firstChild);
let flash='';
function setSyncInfo(t){const e=document.getElementById('syncInfo');if(e)e.textContent=t||(LS.getItem('lastSync')?'✅ Zsynchronizowano '+new Date(+LS.getItem('lastSync')).toLocaleTimeString('pl-PL',{hour:'2-digit',minute:'2-digit'}):'')}
function renderAcct(){
  const keep={};box.querySelectorAll('input[id]').forEach(i=>{if(i.value)keep[i.id]=i.value});
  _render();
  for(const id in keep){const i=box.querySelector('#'+id);if(i)i.value=keep[id]}
}
function _render(){
  if(!acct){box.innerHTML=`<h2 class="sub">👤 Konto i wspólny Plan</h2>
  <p class="hint">Konto (opcjonalne) pozwala: mieć dane na kilku telefonach (kopia w chmurze), dzielić <b>Plan</b> (terminy, zadania, zakupy) z drugą osobą i dostawać przypomnienia. <b>Pieniądze zostają prywatne</b>. Bez konta aplikacja działa dalej tylko na tym telefonie.</p>
  <p class="hint">🔒 Konto tylko z <b>kodem zaproszenia</b> – dostaniesz go od osoby, która ma już konto (Ustawienia → „➕ Zaproś”). Z takim kodem od razu macie wspólny Plan.</p>
  ${flash}
  <input id="aName" type="text" maxlength="40" placeholder="Twoje imię">
  <div class="row"><input id="aInv" type="text" autocapitalize="characters" placeholder="Kod zaproszenia"><button id="aReg" class="btn primary">Załóż konto</button></div>
  <details class="acc-d"><summary>Mam już konto (inny telefon)</summary>
  <p class="hint">Na starym telefonie: Ustawienia → „📱 Dodaj moje drugie urządzenie” → wpisz kod tutaj.</p>
  <div class="row"><input id="aCode" type="text" autocapitalize="characters" placeholder="Kod, np. ABCDE-FGHJK"><button id="aRedeem" class="btn primary">Zaloguj</button></div>
  <p class="hint">Albo klucz odzyskiwania (zapisany przy zakładaniu konta):</p>
  <div class="row"><input id="aKey" type="text" autocapitalize="characters" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"><button id="aRecover" class="btn ghost">Odzyskaj</button></div></details>`;
    box.querySelector('#aReg').onclick=()=>run(async()=>{const name=box.querySelector('#aName').value.trim();if(!name)throw Object.assign(new Error(''),{code:'name'});
      const r=await api('POST','/api/register',{name,code:box.querySelector('#aInv').value});setAcct(r);box.querySelector('#aInv').value='';
      flash=`<div class="acc-key"><b>🔑 Twój klucz odzyskiwania</b><code>${esc(r.recovery)}</code><p>Zapisz go (zrzut ekranu / notatka). Pozwala wrócić do konta, gdy zgubisz telefon. Nikomu go nie podawaj. Pokazujemy go tylko raz.</p><button class="btn small ghost" id="aCopyKey">📋 Kopiuj</button></div>`;
      await refreshMe();await sync()});
    box.querySelector('#aRedeem').onclick=()=>run(async()=>{const r=await api('POST','/api/login/redeem',{code:box.querySelector('#aCode').value});setAcct(r);flash='';await refreshMe();await sync();toast('Zalogowano ✅')});
    box.querySelector('#aRecover').onclick=()=>run(async()=>{const r=await api('POST','/api/login/recover',{key:box.querySelector('#aKey').value});setAcct(r);flash='';await refreshMe();await sync();toast('Zalogowano ✅')});
    return}
  const others=members.filter(m=>m.id!==acct.user.id);
  box.innerHTML=`<h2 class="sub">👤 Konto</h2>${flash}
  <div class="acc-card"><div><b>${esc(acct.user.name)}</b>${acct.owner?' 👑':''}<small id="syncInfo"></small></div><button id="aSync" class="btn small ghost">🔄</button></div>
  <h2 class="sub">👫 Wspólny dom</h2>
  <p class="hint">${others.length?'Dzielisz Plan z: <b>'+others.map(m=>esc(m.name)).join(', ')+'</b>. Pieniądze każdy ma swoje (prywatne).':'Połącz się z partnerką/partnerem, żeby mieć wspólne terminy, zadania i zakupy. Pieniądze zostają prywatne.'}</p>
  <div id="invOut"></div>
  <button id="aInvite" class="btn big ghost">➕ Zaproś (pokaż kod)</button>
  <div class="row"><input id="aJoin" type="text" autocapitalize="characters" placeholder="Mam kod, np. ABCD-EFGH"><button id="aJoinBtn" class="btn primary">Dołącz</button></div>
  ${others.length?'<button id="aLeave" class="btn small ghost">Opuść wspólny dom</button>':''}
  <label class="acc-share"><span><b>Pokaż moje pieniądze partnerowi</b><small>${acct.share?'✅ Włączone – osoby z Twojego domu widzą Twoje saldo, wpływy, wydatki i raporty (tylko podgląd, nie mogą nic zmienić).':'Wyłączone – Twoje pieniądze widzisz tylko Ty.'} Możesz to zmienić w każdej chwili.</small></span><input type="checkbox" id="aShare" ${acct.share?'checked':''}></label>
  <h2 class="sub">🔔 Przypomnienia</h2>
  <p class="hint">Powiadomienie przychodzi na telefony wszystkich w domu.${isIOS()?' iPhone: działa tylko w aplikacji dodanej do ekranu początkowego (iOS 16.4+).':''}</p>
  <div class="row"><button id="aPush" class="btn primary">${LS.getItem('pushOn')?'✅ Włączone (odśwież)':'Włącz powiadomienia'}</button><button id="aPushTest" class="btn ghost">Wyślij test</button></div>
  <h2 class="sub">📱 Inne urządzenia</h2>
  <div id="codeOut"></div>
  <button id="aCodeBtn" class="btn big ghost">📱 Dodaj moje drugie urządzenie</button>
  <div class="row"><button id="aLogout" class="btn ghost">Wyloguj</button><button id="aDel" class="btn danger">Usuń konto</button></div>`;
  setSyncInfo();
  const q=s=>box.querySelector(s);
  q('#aSync').onclick=()=>{refreshMe();sync()};
  q('#aInvite').onclick=()=>run(async()=>{const r=await api('POST','/api/household/invite');q('#invOut').innerHTML=`<div class="acc-key"><b>Kod dla drugiej osoby:</b><code>${esc(r.code)}</code><p>Druga osoba w swojej aplikacji: Ustawienia → wpisuje imię i ten kod w „Kod zaproszenia” → <b>Załóż konto</b> (konto + wspólny dom w jednym kroku). Jeśli ma już konto: „Mam kod” → Dołącz. Kod działa raz, przez 15 minut.</p></div>`});
  q('#aJoinBtn').onclick=()=>run(async()=>{const code=q('#aJoin').value;if(!confirm('Dołączyć do domu tej osoby? Zobaczycie wspólny Plan. Pieniądze zostają prywatne.'))return;
    await api('POST','/api/household/join',{code});LS.removeItem('planSince');const m=J(PLAN_KEY,{});for(const id in m)if(!m[id].dirty)delete m[id];S(PLAN_KEY,m);await refreshMe();await sync();toast('Połączono 👫')});
  if(q('#aLeave'))q('#aLeave').onclick=()=>run(async()=>{if(!confirm('Opuścić wspólny dom? Wspólny Plan zostanie u drugiej osoby.'))return;await api('POST','/api/household/leave');LS.removeItem('planSince');S(PLAN_KEY,{});await refreshMe();await sync()});
  q('#aShare').onchange=e=>run(async()=>{const on=e.target.checked;if(on&&!confirm('Pokazać Twoje pieniądze (saldo, wpływy, wydatki, raporty) osobom z Twojego domu? Będą mogły tylko oglądać.')){e.target.checked=false;return}
    try{const r=await api('POST','/api/share',{on});acct.share=r.share;S('acct',acct);renderAcct();toast(r.share?'Udostępniono 👀':'Udostępnianie wyłączone')}catch(err){e.target.checked=!on;throw err}});
  q('#aPush').onclick=()=>run(async()=>{await enablePush();renderAcct();toast('Powiadomienia włączone 🔔')});
  q('#aPushTest').onclick=()=>run(async()=>{const r=await api('POST','/api/push/test');toast(r.sent.length?'Wysłano test 🔔':'Najpierw włącz powiadomienia')});
  q('#aCodeBtn').onclick=()=>run(async()=>{const r=await api('POST','/api/login/code');q('#codeOut').innerHTML=`<div class="acc-key"><b>Kod logowania:</b><code>${esc(r.code)}</code><p>Na drugim urządzeniu: Ustawienia → „Mam już konto” → wpisz kod. Działa raz, przez 10 minut. Nie podawaj go nikomu innemu.</p></div>`});
  q('#aLogout').onclick=()=>run(async()=>{if(!confirm('Wylogować? Dane na tym telefonie zostaną.'))return;try{await api('POST','/api/logout')}catch(e){}dropAcct()});
  q('#aDel').onclick=()=>run(async()=>{if(!confirm('Usunąć konto i WSZYSTKIE Twoje dane z serwera (kopia w chmurze, przypomnienia)? Dane na tym telefonie zostaną.'))return;if(!confirm('Na pewno? Tego nie da się cofnąć.'))return;
    await api('DELETE','/api/account');dropAcct();toast('Konto usunięte')});
}
box.addEventListener('click',async e=>{if(e.target.id==='aCopyKey'){const c=box.querySelector('.acc-key code');try{await navigator.clipboard.writeText(c.textContent);toast('Skopiowano')}catch(err){}}});
async function run(fn){try{await fn()}catch(e){alert(!e.code&&e.message?e.message:errMsg(e))}}

window.WY={api,sync,plan,aiParse,aiMoney,partnerMoney,refreshMe,token:()=>acct&&acct.token,loggedIn:()=>!!acct,me:()=>acct&&acct.user,members:()=>members,errMsg};
renderAcct();who();
if(acct){setTimeout(()=>{refreshMe();sync()},800)}
})();
