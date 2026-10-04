'use strict';
// Zakładka „Plan”: wspólne terminy, zadania i zakupy + AI (tekst/głos) + „Gdzie kupić?” + przypomnienia (.ics)
(function(){
const $p=s=>document.querySelector(s);
const sec=$p('#tab-plan');
let filter='all', editing=null;
const KIND={event:['📅','Termin'],task:['✅','Zadanie'],shop:['🛒','Zakupy']};
const REM=[['-1','Bez przypomnienia'],['0','W momencie (lub o 9:00 w dniu)'],['15','15 min przed'],['60','1 godz. przed'],['180','3 godz. przed'],['1440','1 dzień przed']];
sec.innerHTML=`<div class="plan-ai">
  <div class="row"><input id="pq" type="text" maxlength="1000" placeholder="np. jutro 15:00 dentysta, kup mleko i chleb" enterkeyhint="send"><button id="pmic" class="btn" aria-label="Powiedz">🎤</button></div>
  <button id="padd" class="btn big primary">✨ Dodaj</button>
  <p class="hint" id="pinfo">Napisz albo powiedz, AI samo rozpozna: termin, zadanie, zakupy (a nawet wydatek).</p></div>
  <div class="seg" id="pseg"><button data-f="all" class="on">Wszystko</button><button data-f="event">📅</button><button data-f="task">✅</button><button data-f="shop">🛒</button></div>
  <div id="plist"></div>
  <details id="pform" class="acc-d"><summary id="pformT">➕ Dodaj ręcznie</summary>
   <label class="lbl">Rodzaj</label><select id="pkind"><option value="event">📅 Termin</option><option value="task">✅ Zadanie</option><option value="shop">🛒 Zakupy</option></select>
   <label class="lbl" for="ptitle">Co?</label><input id="ptitle" type="text" maxlength="200" placeholder="np. Dentysta / Zapłacić za prąd / Mleko">
   <div class="row"><div><label class="lbl" for="pdate">Dzień</label><input id="pdate" type="date"></div><div><label class="lbl" for="ptime">Godzina</label><input id="ptime" type="time"></div></div>
   <label class="lbl" for="prem">Przypomnienie</label><select id="prem">${REM.map(([v,t])=>`<option value="${v}">${t}</option>`).join('')}</select>
   <label class="lbl" for="pnotes">Notatka</label><input id="pnotes" type="text" maxlength="1000">
   <button id="psave" class="btn big primary">Zapisz</button><button id="pcancel" class="btn big ghost" hidden>Anuluj</button><button id="pdel" class="btn big danger" hidden>Usuń</button>
  </details>
  <div id="pwhere" hidden></div>`;

const newId=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,8);
const pad2=n=>String(n).padStart(2,'0');
function remindAt(due,min){if(!due||min<0)return null;const [d,t]=due.split('T');const [y,m,dd]=d.split('-').map(Number);const [h,mi]=(t||'09:00').split(':').map(Number);return new Date(y,m-1,dd,h,mi).getTime()-min*60000}
function remMin(it){if(!it.remind_at||!it.due)return -1;const base=remindAt(it.due,0);const m=Math.round((base-it.remind_at)/60000);return REM.some(([v])=>+v===m)?m:60}
function when(due){if(!due)return'';const [d,t]=due.split('T');const today=ymd(new Date()),tm=new Date();tm.setDate(tm.getDate()+1);
  const dd=d===today?'dziś':d===ymd(tm)?'jutro':new Date(d+'T12:00').toLocaleDateString('pl-PL',{weekday:'short',day:'numeric',month:'short'});return dd+(t?' '+t:'')}
const who=id=>{if(!id||!WY.loggedIn())return'';const me=WY.me();if(me&&id===me.id)return'';const m=WY.members().find(x=>x.id===id);return m?m.name:''};

function render(){
  const items=WY.plan.all().filter(x=>filter==='all'||x.kind===filter);
  const today=ymd(new Date()), weekAgo=ymd(new Date(Date.now()-7*864e5));
  const groups=[['event','📅 Terminy'],['task','✅ Zadania'],['shop','🛒 Zakupy']].filter(([k])=>filter==='all'||filter===k);
  let html='';
  for(const [k,label] of groups){
    let list=items.filter(x=>x.kind===k);
    if(k==='event')list=list.filter(x=>!x.due||x.due.slice(0,10)>=weekAgo).sort((a,b)=>(a.due||'9').localeCompare(b.due||'9'));
    else list.sort((a,b)=>(a.done-b.done)||((a.due||'9').localeCompare(b.due||'9'))||(b.updated-a.updated));
    const done=list.filter(x=>x.done).length;
    html+=`<h2 class="sub">${label}${k==='shop'?' <button class="btn small ghost" data-act="whereAll">🔎 Gdzie kupić?</button>':''}${k==='shop'&&done?' <button class="btn small ghost" data-act="clearShop">Usuń kupione</button>':''}</h2><ul class="list plan">`;
    html+=list.map(x=>{const past=x.kind==='event'&&x.due&&x.due.slice(0,10)<today;const w=who(x.by);
      return `<li class="pi${x.done?' done':''}${past?' past':''}" data-id="${esc(x.id)}"><input type="checkbox" class="pchk" ${x.done?'checked':''} aria-label="Zrobione"><div class="i"><b>${esc(x.title)}</b><small>${[x.due?'🕑 '+esc(when(x.due)):'',x.remind_at?'🔔':'',x.notes?esc(x.notes):'',w?'od: '+esc(w):''].filter(Boolean).join(' · ')}</small></div>
      ${x.kind==='event'&&x.due?'<button class="btn small ghost" data-act="ics" aria-label="Do kalendarza">📆</button>':''}${x.kind==='shop'?'<button class="btn small ghost" data-act="where" aria-label="Gdzie kupić">🔎</button>':''}</li>`}).join('')||'<li class="empty">Pusto</li>';
    html+='</ul>';
  }
  if(!WY.loggedIn())html=`<p class="hint">💡 Załóż konto w Ustawieniach, żeby dzielić Plan z drugą osobą i dostawać przypomnienia. Na razie Plan jest tylko na tym telefonie.</p>`+html;
  $p('#plist').innerHTML=html;
}
$p('#plist').addEventListener('click',e=>{
  const act=e.target.dataset.act, li=e.target.closest('li[data-id]'), it=li&&WY.plan.all().find(x=>x.id===li.dataset.id);
  if(act==='whereAll')return where(WY.plan.all().filter(x=>x.kind==='shop'&&!x.done).map(x=>x.title).slice(0,8).join(', '));
  if(act==='clearShop'){if(confirm('Usunąć kupione z listy?'))WY.plan.all().filter(x=>x.kind==='shop'&&x.done).forEach(x=>WY.plan.del(x.id));return}
  if(!it)return;
  if(e.target.classList.contains('pchk')){it.done=e.target.checked;WY.plan.put(it);return}
  if(act==='ics')return ics(it);
  if(act==='where')return where(it.title);
  edit(it);
});
document.querySelectorAll('#pseg button').forEach(b=>b.onclick=()=>{filter=b.dataset.f;document.querySelectorAll('#pseg button').forEach(x=>x.classList.toggle('on',x===b));render()});

// ---------- formularz ----------
function edit(it){editing=it;$p('#pform').open=true;$p('#pformT').textContent='✏️ Edycja';$p('#pkind').value=it.kind;$p('#ptitle').value=it.title;const [d,t]=(it.due||'').split('T');$p('#pdate').value=d||'';$p('#ptime').value=t||'';$p('#prem').value=String(remMin(it));$p('#pnotes').value=it.notes||'';$p('#pcancel').hidden=false;$p('#pdel').hidden=false;$p('#pform').scrollIntoView({behavior:'smooth'})}
function resetP(){editing=null;$p('#pformT').textContent='➕ Dodaj ręcznie';['#ptitle','#pdate','#ptime','#pnotes'].forEach(s=>$p(s).value='');$p('#prem').value='60';$p('#pcancel').hidden=true;$p('#pdel').hidden=true;$p('#pform').open=false}
$p('#psave').onclick=()=>{const title=$p('#ptitle').value.trim();if(!title){toast('Wpisz, co to jest');return}
  const d=$p('#pdate').value,t=$p('#ptime').value,due=d?(t?d+'T'+t:d):'';const min=+$p('#prem').value;
  const it=Object.assign(editing||{id:newId(),done:false,by:WY.me()&&WY.me().id},{kind:$p('#pkind').value,title,notes:$p('#pnotes').value.trim(),due,remind_at:remindAt(due,min)});
  if(it.remind_at&&it.remind_at<Date.now()-60000&&!editing)it.remind_at=null;
  WY.plan.put(it);toast(editing?'Zapisano':'Dodano');resetP();if(it.remind_at)askPush()};
$p('#pcancel').onclick=resetP;
$p('#pdel').onclick=()=>{if(editing&&confirm('Usunąć?')){WY.plan.del(editing.id);resetP()}};

// ---------- AI: tekst / głos ----------
async function addText(text){
  text=text.trim();if(!text)return;
  const info=$p('#pinfo');
  if(!WY.loggedIn()||!navigator.onLine){ // bez AI: zwykłe dodanie
    const kind=filter==='all'?(/^(kup|kupić)\b/i.test(text)?'shop':'task'):filter;
    text.split(/\s*,\s*|\s+i\s+(?=\S)/).filter(Boolean).slice(0,kind==='shop'?20:1).forEach((t,i,a)=>WY.plan.put({id:newId(),kind,title:(kind==='shop'?t.replace(/^(kup|kupić)\s+/i,''):(a.length>1?text:t)).replace(/^./,c=>c.toUpperCase()),notes:'',due:'',done:false,remind_at:null}));
    info.textContent=WY.loggedIn()?'📴 Offline – dodane bez AI.':'Dodane. (Z kontem AI samo rozpozna daty i godziny.)';$p('#pq').value='';return}
  info.textContent='✨ Rozumiem…';
  try{
    const items=await WY.aiParse(text);const done=[];let remind=false;
    for(const x of items){
      if(x.kind==='expense'||x.kind==='income'){await putExp({id:newId(),type:x.kind==='income'?'inc':'exp',amount:x.amount,currency:x.currency,category:x.category,note:x.note||'',date:x.date,photo:null,created:Date.now()});done.push((x.kind==='income'?'💚 +':'💸 −')+fmt(x.amount,x.currency));continue}
      const ra=remindAt(x.due,x.remind_min>=0?x.remind_min:-1);
      WY.plan.put({id:newId(),kind:x.kind,title:x.title,notes:'',due:x.due||'',done:false,remind_at:ra&&ra>Date.now()?ra:null,by:WY.me().id});
      if(ra&&ra>Date.now())remind=true;done.push(KIND[x.kind][0]+' '+x.title+(x.due?' ('+when(x.due)+')':''));
    }
    info.textContent=done.length?'Dodano: '+done.join(' · '):'Nie zrozumiałam – spróbuj inaczej albo dodaj ręcznie.';
    if(done.length){$p('#pq').value='';try{await refresh()}catch(e){}}
    if(remind)askPush();
  }catch(e){info.textContent='⚠️ '+WY.errMsg(e)}
}
$p('#padd').onclick=()=>addText($p('#pq').value);
$p('#pq').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();addText($p('#pq').value)}});
const SRc=window.SpeechRecognition||window.webkitSpeechRecognition;
if(!SRc)$p('#pmic').hidden=true;
else $p('#pmic').onclick=()=>{const r=new SRc();r.lang='pl-PL';r.interimResults=false;$p('#pinfo').textContent='🎤 Słucham…';
  r.onresult=e=>{const t=e.results[0][0].transcript;$p('#pq').value=t;addText(t)};r.onerror=e=>$p('#pinfo').textContent='Nie usłyszałam ('+e.error+').';try{r.start()}catch(e){}};
function askPush(){if(WY.loggedIn()&&!localStorage.getItem('pushOn')&&!localStorage.getItem('pushAsked')){localStorage.setItem('pushAsked','1');toast('🔔 Włącz powiadomienia w Ustawieniach, żeby dostać przypomnienie')}}

// ---------- Gdzie kupić? ----------
async function where(q){
  const w=$p('#pwhere');if(!q){toast('Lista zakupów jest pusta');return}
  if(!WY.loggedIn()){toast('„Gdzie kupić?” działa z kontem (Ustawienia)');return}
  w.hidden=false;w.innerHTML=`<div class="where-in"><h3>🔎 Gdzie kupić: ${esc(q)}</h3><div class="row"><input id="wplace" type="text" maxlength="80" placeholder="Miasto (opcjonalnie)" value="${esc(localStorage.getItem('place')||'')}"><button id="wgo" class="btn primary">Szukaj</button></div><div id="wout"><p class="hint">Szukam…</p></div><button id="wclose" class="btn big ghost">Zamknij</button></div>`;
  w.querySelector('#wclose').onclick=()=>{w.hidden=true;w.innerHTML=''};
  const go=async()=>{const place=w.querySelector('#wplace').value.trim();localStorage.setItem('place',place);const out=w.querySelector('#wout');out.innerHTML='<p class="hint">Szukam…</p>';
    try{const r=await WY.api('POST','/api/where',{q,place,country:(localStorage.getItem('cur')==='EUR'?'BE':'PL')});
      const links=(r.links||[]).filter(l=>/^https:\/\//.test(l.url));
      out.innerHTML=`<div class="where-t">${esc(r.text).replace(/\n/g,'<br>')}</div>${r.grounded?'':'<p class="hint">Podpowiedź AI – sprawdź w linkach poniżej.</p>'}<ul class="list">${links.map(l=>`<li><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.title)}</a></li>`).join('')}</ul>`}
    catch(e){out.innerHTML='<p class="hint">⚠️ '+esc(WY.errMsg(e))+'</p>'}};
  w.querySelector('#wgo').onclick=go;go();
}

// ---------- .ics (kalendarz telefonu) ----------
function ics(it){
  const e=s=>String(s||'').replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\r?\n/g,'\\n');
  const [d,t]=it.due.split('T');const D=d.replace(/-/g,'');let start,end;
  if(t){const s=new Date(d+'T'+t),f=x=>ymd(x).replace(/-/g,'')+'T'+pad2(x.getHours())+pad2(x.getMinutes())+'00';start='DTSTART:'+f(s);end='DTEND:'+f(new Date(s.getTime()+3600e3))}
  else{const n=new Date(d+'T12:00');n.setDate(n.getDate()+1);start='DTSTART;VALUE=DATE:'+D;end='DTEND;VALUE=DATE:'+ymd(n).replace(/-/g,'')}
  const min=remMin(it);const stamp=new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d+/,'');
  const body=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Wydatki//Plan//PL','BEGIN:VEVENT','UID:'+it.id+'@wydatki-app',`DTSTAMP:${stamp}`,start,end,'SUMMARY:'+e(it.title),it.notes?'DESCRIPTION:'+e(it.notes):'',
    ...(min>=0?['BEGIN:VALARM','ACTION:DISPLAY','DESCRIPTION:'+e(it.title),'TRIGGER:-PT'+min+'M','END:VALARM']:[]),'END:VEVENT','END:VCALENDAR'].filter(Boolean).join('\r\n')+'\r\n';
  const name=(it.title.replace(/[^\wąćęłńóśźż -]/gi,'').slice(0,40)||'termin')+'.ics';
  const file=new File([body],name,{type:'text/calendar'});
  if(navigator.canShare&&navigator.canShare({files:[file]}))navigator.share({files:[file]}).catch(()=>{});
  else{const a=document.createElement('a');a.href=URL.createObjectURL(file);a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},1500)}
  return body;
}

addEventListener('wy-plan',()=>{if(sec.classList.contains('active'))render()});
document.querySelector('.tabs button[data-t="plan"]').addEventListener('click',()=>{render();if(WY.loggedIn())WY.sync()});
render();
if(/[?&]t=plan/.test(location.search)){showTab('plan');render()}
window.__plan={ics,remindAt,render,addText};
})();
