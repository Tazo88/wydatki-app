'use strict';
// ---------- helpers ----------
const $=s=>document.querySelector(s);
const DEF_CATS=['Jedzenie','Zakupy/dom','Transport/paliwo','Rachunki','Zdrowie','Dzieci','Rozrywka','Ubrania','Inne'];
const pad=n=>String(n).padStart(2,'0');
const ymd=d=>d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
const parseYmd=s=>{const[a,b,c]=s.split('-').map(Number);return new Date(a,b-1,c)};
const fmtNum=n=>(n<-0.004?'−':'')+(Math.round(Math.abs(n)*100)/100).toFixed(2).replace('.',',').replace(/\B(?=(\d{3})+(?!\d))/g,' ');
const SYM={PLN:'zł',EUR:'€'};
const fmt=(n,c='PLN')=>fmtNum(n)+' '+SYM[c];
const parseAmt=s=>{s=String(s||'').replace(/\s/g,'').replace(',','.').replace(/[^\d.]/g,'');const v=parseFloat(s);return isFinite(v)?v:NaN};
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function toast(m){const t=$('#toast');t.textContent=m;t.hidden=false;clearTimeout(toast.h);toast.h=setTimeout(()=>t.hidden=true,2200)}
function status(m){const s=$('#status');if(!m){s.hidden=true;return}s.textContent=m;s.hidden=false}

// ---------- IndexedDB ----------
let dbp;
function db(){return dbp||(dbp=new Promise((res,rej)=>{const r=indexedDB.open('wydatki',1);r.onupgradeneeded=()=>r.result.createObjectStore('exp',{keyPath:'id'});r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)}))}
async function tx(mode,fn){const d=await db();return new Promise((res,rej)=>{const t=d.transaction('exp',mode);const st=t.objectStore('exp');const out=fn(st);t.oncomplete=()=>res(out&&out.result!==undefined?out.result:out);t.onerror=()=>rej(t.error)})}
const putExp=e=>tx('readwrite',s=>s.put(e));
const delExp=id=>tx('readwrite',s=>s.delete(id));
const allExp=()=>tx('readonly',s=>s.getAll());

// ---------- state ----------
const DEF_INC=['Wypłata','800+/świadczenia','Przelew od kogoś','Gotówka','Zwrot','Sprzedaż','Inne'];
let cats=JSON.parse(localStorage.getItem('cats')||'null')||DEF_CATS.slice();
let incCats=JSON.parse(localStorage.getItem('incCats')||'null')||DEF_INC.slice();
const saveCats=()=>{localStorage.setItem('cats',JSON.stringify(cats));localStorage.setItem('incCats',JSON.stringify(incCats))};
const getStart=()=>Object.assign({PLN:0,EUR:0},JSON.parse(localStorage.getItem('start')||'{}'));
const isInc=x=>x.type==='inc';
let selCat='Jedzenie', selInc='Wypłata', mode='exp', editId=null, photoData=null, expenses=[];
let period='m', anchor=new Date();

// ---------- tabs ----------
document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>showTab(b.dataset.t));
function showTab(t){document.querySelectorAll('.tabs button').forEach(x=>x.classList.toggle('on',x.dataset.t===t));document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x.id==='tab-'+t));if(t==='rep')renderReport();if(t==='set')renderCatList();window.scrollTo(0,0)}

// ---------- form ----------
function renderCats(){const el=$('#cats');el.innerHTML='';const inc=mode==='inc';(inc?incCats:cats).forEach(c=>{const b=document.createElement('button');b.type='button';b.textContent=c;if(c===(inc?selInc:selCat))b.classList.add('on');b.onclick=()=>{if(inc)selInc=c;else selCat=c;renderCats()};el.appendChild(b)})}
function setMode(m){mode=m;const inc=m==='inc';document.body.classList.toggle('mode-inc',inc);$('#modeInc').classList.toggle('on',inc);$('#modeExp').classList.toggle('on',!inc);
  $('#formTitle').textContent=(editId?'Edycja: ':'Nowy ')+(inc?'wpływ':'wydatek');$('#catLbl').textContent=inc?'Źródło':'Kategoria';$('#noteLbl').textContent=inc?'Od kogo / notatka (opcjonalnie)':'Notatka / sklep (opcjonalnie)';
  $('#note').placeholder=inc?'np. od mamy':'np. Biedronka';$('#photoBtn').hidden=inc;if(window.SpeechRecognition||window.webkitSpeechRecognition)$('#voiceInfo').textContent=inc?'Powiedz np. „wypłata 3500” albo „dostałam 200 od mamy”.':'Powiedz np. „Biedronka 45 złotych jedzenie”.';if(!editId)$('#saveBtn').textContent=inc?'Zapisz wpływ':'Zapisz wydatek';renderCats()}
$('#modeInc').onclick=()=>{if(editId)resetForm();setMode('inc');$('#amount').focus()};
$('#modeExp').onclick=()=>{if(editId)resetForm();setMode('exp');$('#amount').focus()};
function resetForm(){editId=null;photoData=null;$('#amount').value='';$('#note').value='';$('#date').value=ymd(new Date());$('#currency').value=localStorage.getItem('cur')||'PLN';$('#cancelEdit').hidden=true;$('#delBtn').hidden=true;showPhoto();status('');setMode(mode)}
function showPhoto(){$('#photoPrev').hidden=!photoData;if(photoData)$('#thumb').src=photoData}
$('#rmPhoto').onclick=()=>{photoData=null;showPhoto()};
$('#cancelEdit').onclick=()=>{resetForm()};
$('#delBtn').onclick=async()=>{if(editId&&confirm(mode==='inc'?'Usunąć ten wpływ?':'Usunąć ten wydatek?')){await delExp(editId);toast('Usunięto');resetForm();await refresh()}};
$('#form').onsubmit=async e=>{
  e.preventDefault();
  const amount=parseAmt($('#amount').value);
  if(!(amount>0)){toast('Podaj kwotę');$('#amount').focus();return}
  const old=editId?expenses.find(x=>x.id===editId):null;
  const inc=mode==='inc';
  const exp={id:editId||(Date.now().toString(36)+Math.random().toString(36).slice(2,7)),type:inc?'inc':'exp',amount:Math.round(amount*100)/100,currency:$('#currency').value,category:inc?selInc:selCat,note:$('#note').value.trim(),date:$('#date').value||ymd(new Date()),photo:inc?null:(photoData||null),created:old?old.created:Date.now()};
  localStorage.setItem('cur',exp.currency);
  await putExp(exp);
  toast(editId?'Zapisano zmiany':(inc?'Wpływ +':'Wydatek −')+fmt(exp.amount,exp.currency));
  resetForm();await refresh();
};
function editExpense(id){const x=expenses.find(e=>e.id===id);if(!x)return;showTab('add');editId=id;$('#amount').value=String(x.amount).replace('.',',');$('#currency').value=x.currency;const inc=isInc(x);const list=inc?incCats:cats;if(inc)selInc=x.category;else selCat=x.category;if(!list.includes(x.category)){list.push(x.category);saveCats()}$('#note').value=x.note||'';$('#date').value=x.date;photoData=x.photo||null;showPhoto();$('#saveBtn').textContent='Zapisz zmiany';setMode(inc?'inc':'exp');$('#cancelEdit').hidden=false;$('#delBtn').hidden=false}

function li(x){const inc=isInc(x);return `<li data-id="${x.id}" class="${inc?'inc':'exp'}">${x.photo?`<img src="${x.photo}" alt="">`:''}<div class="i"><b>${esc(x.category)}</b><small>${esc(x.date.split('-').reverse().join('.'))}${x.note?' · '+esc(x.note):''}</small></div><span class="a ${inc?'pos':'neg'}">${inc?'+':'−'}${fmt(x.amount,x.currency)}</span></li>`}
function bindList(el){el.querySelectorAll('li[data-id]').forEach(l=>l.onclick=()=>editExpense(l.dataset.id))}
const sortExp=a=>a.sort((p,q)=>q.date.localeCompare(p.date)||q.created-p.created);

async function refresh(){
  expenses=sortExp(await allExp());
  const r=$('#recent');r.innerHTML=expenses.slice(0,10).map(li).join('')||'<li class="empty">Brak wpisów — dodaj pierwszy 🙂</li>';bindList(r);
  const today=ymd(new Date());const t=expenses.filter(x=>x.date===today&&x.currency==='PLN'&&!isInc(x)).reduce((s,x)=>s+x.amount,0);
  $('#hdrTotal').textContent='Dziś wydane: '+fmt(t);
  renderBalance();
  if($('#tab-rep').classList.contains('active'))renderReport();
}

// ---------- saldo ----------
function sums(list){const o={inc:{},exp:{}};list.forEach(x=>{const k=isInc(x)?'inc':'exp';o[k][x.currency]=(o[k][x.currency]||0)+x.amount});return o}
function saldo(upTo){const st=getStart(),o=sums(upTo?expenses.filter(x=>x.date<=upTo):expenses),r={};['PLN','EUR'].forEach(c=>r[c]=(st[c]||0)+(o.inc[c]||0)-(o.exp[c]||0));return r}
const usesEUR=()=>getStart().EUR||expenses.some(x=>x.currency==='EUR');
function renderBalance(){const s=saldo();const m=$('#balMain');m.textContent=fmt(s.PLN);m.classList.toggle('minus',s.PLN<0);$('#balEur').textContent=usesEUR()?fmt(s.EUR,'EUR'):'';
  const d=new Date(),ms=ymd(new Date(d.getFullYear(),d.getMonth(),1)),me=ymd(new Date(d.getFullYear(),d.getMonth()+1,0));const o=sums(expenses.filter(x=>x.date>=ms&&x.date<=me));
  const both=(t)=>fmt(t.PLN||0)+(t.EUR?' + '+fmt(t.EUR,'EUR'):'');$('#mInc').textContent='+'+both(o.inc);$('#mExp').textContent='−'+both(o.exp);
  document.querySelectorAll('.mName').forEach(e=>e.textContent=MON[d.getMonth()])}

// ---------- voice ----------
const KW={
 'Jedzenie':['jedzenie','biedronka','biedronce','lidl','lidlu','żabka','żabce','kaufland','auchan','carrefour','netto','dino','lewiatan','stokrotka','spożywcze','obiad','kolacja','śniadanie','kawa','restauracja','pizza','piekarnia','mcdonald','kebab','lunch','jedzeniu'],
 'Zakupy/dom':['dom','rossmann','hebe','ikea','castorama','leroy','obi','pepco','action','chemia','środki','kosmetyki','zakupy','allegro'],
 'Transport/paliwo':['paliwo','benzyna','tankowanie','orlen','bp','shell','circle','moya','uber','bolt','bilet','taxi','taksówka','parking','autobus','pociąg','transport','myjnia'],
 'Rachunki':['rachunek','rachunki','prąd','gaz','czynsz','internet','telefon','abonament','woda','opłata','media'],
 'Zdrowie':['apteka','aptece','lekarz','leki','lek','zdrowie','dentysta','badania','okulary'],
 'Dzieci':['dzieci','dziecko','przedszkole','szkoła','zabawki','zabawka','pieluchy','żłobek'],
 'Rozrywka':['kino','rozrywka','netflix','spotify','koncert','teatr','bar','piwo','gry','książka','basen'],
 'Ubrania':['ubrania','ubranie','buty','zara','reserved','sinsay','h&m','hm','sukienka','kurtka','spodnie','koszulka','ccc']
};
const CUR_WORDS=/^(zł|zl|złoty|złote|złotych|złotego|pln|euro|eur|€|groszy|gr)$/i;
const INC_KW={'Wypłata':['wypłata','wypłatę','wypłaty','pensja','pensję','wynagrodzenie','pensji'],'800+/świadczenia':['800+','800plus','świadczenie','zasiłek','świadczenia','alimenty','becikowe'],'Zwrot':['zwrot','zwrotu','oddał','oddała','oddali'],'Sprzedaż':['sprzedałam','sprzedałem','sprzedaż','vinted','olx'],'Gotówka':['gotówka','gotówką','gotówki'],'Przelew od kogoś':['przelew','od','dostałam','dostałem','przelała','przelał']};
const INC_TRIG=/(wpływ|wpłynęło|wypłat|pensj|wynagrodzen|dostałam|dostałem|przychód|zarobiłam|zarobiłem|800\s*(\+|plus)|świadczen|zasiłek|alimenty|zwrot|sprzedałam|sprzedałem|przelał|\bod\s+(mamy|taty|babci|dziadka|męża|chłopaka|kamila|\w+))/;
function parseVoice(text){
  const raw=text.trim();let t=raw.toLowerCase().replace(/800\s*(\+|plus)/g,'800+');
  const res={};
  if(INC_TRIG.test(t)){res.type='inc';const ws=t.split(/\s+/);
    for(const[c,k] of Object.entries(INC_KW)){if(ws.some(w=>k.includes(w.replace(/[.,!?]/g,'')))&&incCats.includes(c)){res.category=c;break}}
    if(!res.category)for(const c of incCats){if(t.includes(c.toLowerCase())){res.category=c;break}}
    const tt=t.replace('800+','');let m=tt.match(/(\d+(?:[.,]\d{1,2})?)/);if(m)res.amount=parseFloat(m[1].replace(',','.'));
    if(/\b(euro|eur)\b|€/.test(t))res.currency='EUR';else if(/zł|złot|pln/.test(t))res.currency='PLN';
    m=raw.match(/\bod\s+(.+)$/i);if(m){const who=m[1].split(/\s+/).filter(w=>!/^\d/.test(w)&&!CUR_WORDS.test(w.replace(/[.,!?]/g,''))).join(' ');if(who)res.note='Od '+who}
    return res}
  if(/\b(euro|eur)\b|€/.test(t))res.currency='EUR';else if(/zł|złot|pln/.test(t))res.currency='PLN';
  // "45 złotych 50 groszy" / "45,50" / "45 i 50"
  let m=t.match(/(\d+)\s*(?:zł\w*|złot\w*)\s*(?:i\s*)?(\d{1,2})\s*(?:gr|grosz\w*)/);
  if(m)res.amount=parseFloat(m[1]+'.'+m[2].padStart(2,'0'));
  else{m=t.match(/(\d+(?:[.,]\d{1,2})?)/);if(m)res.amount=parseFloat(m[1].replace(',','.'))}
  // category
  const words=t.split(/\s+/);
  const lc=cats.map(c=>c.toLowerCase());
  for(const w of words){const i=lc.findIndex(c=>c===w||c.split('/').includes(w));if(i>=0){res.category=cats[i];break}}
  if(!res.category){outer:for(const[c,kws] of Object.entries(KW)){for(const w of words){if(kws.includes(w.replace(/[.,!?]/g,''))&&cats.includes(c)){res.category=c;break outer}}}}
  // shop/note: leftover words (not number, not currency, not category name)
  const catWords=new Set(lc.flatMap(c=>[c,...c.split('/')]));
  const left=raw.split(/\s+/).filter(w=>{const l=w.toLowerCase().replace(/[.,!?]/g,'');return l&&!/^\d+([.,]\d+)?$/.test(l)&&!CUR_WORDS.test(l)&&!catWords.has(l)&&!['i','za','w','na','kategoria'].includes(l)});
  if(left.length)res.note=left.map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(' ');
  return res;
}
const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
if(!SR){$('#micBtn').hidden=true;$('#voiceInfo').textContent='Ta przeglądarka nie obsługuje rozpoznawania mowy w aplikacji. Użyj 🎤 na klawiaturze (dyktowanie) w polu kwoty lub notatki.'}
else{
  $('#voiceInfo').textContent='Powiedz np. „Biedronka 45 złotych jedzenie”.';
  $('#micBtn').onclick=()=>{
    const r=new SR();r.lang='pl-PL';r.interimResults=false;r.maxAlternatives=1;
    status('🎤 Słucham…');
    r.onresult=e=>{const txt=e.results[0][0].transcript;const p=parseVoice(txt);
      if(p.type==='inc'){if(p.category)selInc=p.category;setMode('inc')}else if(p.category){selCat=p.category;setMode('exp')}
      if(p.amount)$('#amount').value=String(p.amount).replace('.',',');
      if(p.currency)$('#currency').value=p.currency;
      if(p.note)$('#note').value=p.note;
      status('Usłyszałam: „'+txt+'” — sprawdź i kliknij Zapisz.')};
    r.onerror=e=>status('Nie udało się rozpoznać mowy ('+e.error+'). Spróbuj ponownie lub wpisz ręcznie.');
    r.onend=()=>{if($('#status').textContent==='🎤 Słucham…')status('')};
    try{r.start()}catch(err){status('Mikrofon niedostępny: '+err.message)}
  };
}

// ---------- photo + OCR ----------
function loadImg(file){return new Promise((res,rej)=>{const u=URL.createObjectURL(file);const i=new Image();i.onload=()=>res(i);i.onerror=rej;i.src=u})}
function scaled(img,max,q){const s=Math.min(1,max/Math.max(img.width,img.height));const c=document.createElement('canvas');c.width=Math.round(img.width*s);c.height=Math.round(img.height*s);c.getContext('2d').drawImage(img,0,0,c.width,c.height);return q?c.toDataURL('image/jpeg',q):c}
function loadTesseract(){return window.Tesseract?Promise.resolve():new Promise((res,rej)=>{const s=document.createElement('script');s.src='https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';s.onload=res;s.onerror=()=>rej(new Error('brak internetu?'));document.head.appendChild(s)})}
const SHOP_CAT=[[/apteka|pharmac|apotheek|apotheke|\bdoz\b|gemini/i,'Zdrowie'],[/lidl|aldi|delhaize|colruyt|carrefour|biedronka|żabka|zabka|kaufland|auchan|netto|dino|spar|intermarch|albert\s*heijn|lewiatan|stokrotka/i,'Jedzenie'],[/orlen|shell|total\s*energies|totalenergies|\bq8\b|\bbp\b|circle\s*k|lukoil|esso|moya|dats\s*24|gabriels|paliw|benzin|diesel/i,'Transport/paliwo'],[/rossmann|hebe|kruidvat|ikea|pepco|brico|hubo|castorama|leroy/i,'Zakupy/dom']];
function ocrInfo(text){const r={};if(/€|\bEUR\b|euro/i.test(text))r.currency='EUR';else if(/zł|\bPLN\b/i.test(text))r.currency='PLN';
  for(const[re,c] of SHOP_CAT)if(re.test(text)&&cats.includes(c)){r.category=c;break}return r}
function findTotal(text){
  const lines=text.split(/\n/);const amtRe=/(\d{1,5})\s?[.,]\s?(\d{2})(?!\d)/g;
  const nums=l=>[...l.matchAll(amtRe)].map(m=>parseFloat(m[1]+'.'+m[2]));
  for(const key of [/SUMA\s*PLN/i,/SUMA/i,/RAZEM/i,/DO\s*ZAP[ŁL]ATY/i,/[ŁL]?[ĄA]CZNIE/i,/TE\s*BETALEN/i,/[AÀ]\s*PAYER/i,/TOTAAL/i,/TOTAL/i]){
    for(let i=0;i<lines.length;i++){if(key.test(lines[i])){const n=nums(lines[i]).concat(i+1<lines.length&&!nums(lines[i]).length?nums(lines[i+1]):[]);if(n.length)return Math.max(...n)}}
  }
  const all=nums(text).filter(v=>v<100000);return all.length?Math.max(...all):null;
}
$('#photo').onchange=async e=>{
  const f=e.target.files[0];e.target.value='';if(!f)return;
  try{
    const img=await loadImg(f);photoData=scaled(img,480,0.6);showPhoto();
    status('🔍 Czytam paragon… (pierwszy raz pobiera ~10 MB, chwilę to trwa)');
    await loadTesseract();
    const big=scaled(img,1800);
    const {data}=await Tesseract.recognize(big,'pol',{logger:m=>{if(m.status==='recognizing text')status('🔍 Czytam paragon… '+Math.round(m.progress*100)+'%')}});
    const tot=findTotal(data.text),info=ocrInfo(data.text);
    if(info.currency)$('#currency').value=info.currency;
    if(info.category){selCat=info.category;renderCats()}
    const cur=$('#currency').value;
    if(tot){$('#amount').value=String(tot).replace('.',',');status('Znaleziona suma: '+fmt(tot,cur)+(info.category?' · '+info.category:'')+' — sprawdź, popraw jeśli trzeba i kliknij Zapisz.')}
    else status('Nie znalazłam sumy na zdjęciu — wpisz kwotę ręcznie. Zdjęcie zostanie zapisane.');
  }catch(err){status('Zdjęcie dodane. Odczyt sumy się nie udał ('+err.message+') — wpisz kwotę ręcznie.')}
};

// ---------- reports ----------
document.querySelectorAll('#periodSeg button').forEach(b=>b.onclick=()=>{period=b.dataset.p;document.querySelectorAll('#periodSeg button').forEach(x=>x.classList.toggle('on',x===b));renderReport()});
$('#prev').onclick=()=>{shift(-1);renderReport()};$('#next').onclick=()=>{shift(1);renderReport()};
function shift(k){const d=new Date(anchor);if(period==='d')d.setDate(d.getDate()+k);else if(period==='w')d.setDate(d.getDate()+7*k);else{d.setDate(1);d.setMonth(d.getMonth()+k)}anchor=d}
const MON=['styczeń','luty','marzec','kwiecień','maj','czerwiec','lipiec','sierpień','wrzesień','październik','listopad','grudzień'];
function range(){const a=new Date(anchor.getFullYear(),anchor.getMonth(),anchor.getDate());let s,e,label;
  if(period==='d'){s=e=a;label=a.toLocaleDateString('pl-PL',{weekday:'long',day:'numeric',month:'long',year:'numeric'})}
  else if(period==='w'){s=new Date(a);s.setDate(a.getDate()-((a.getDay()+6)%7));e=new Date(s);e.setDate(s.getDate()+6);label=s.toLocaleDateString('pl-PL',{day:'numeric',month:'short'})+' – '+e.toLocaleDateString('pl-PL',{day:'numeric',month:'short',year:'numeric'})}
  else{s=new Date(a.getFullYear(),a.getMonth(),1);e=new Date(a.getFullYear(),a.getMonth()+1,0);label=MON[s.getMonth()]+' '+s.getFullYear()}
  return{s:ymd(s),e:ymd(e),label}}
function breakdown(list){const tot={},by={};list.forEach(x=>{tot[x.currency]=(tot[x.currency]||0)+x.amount;const k=x.category+'|'+x.currency;by[k]=(by[k]||0)+x.amount});
  return{tot,cats:Object.entries(by).map(([k,v])=>{const[c,cur]=k.split('|');return{c,cur,v}}).sort((a,b)=>b.v-a.v)}}
function periodData(){const r=range();const list=expenses.filter(x=>x.date>=r.s&&x.date<=r.e);
  const ex=breakdown(list.filter(x=>!isInc(x))),inc=breakdown(list.filter(isInc));const bil={};['PLN','EUR'].forEach(c=>{const v=(inc.tot[c]||0)-(ex.tot[c]||0);if(v||inc.tot[c]||ex.tot[c])bil[c]=v});
  return{...r,list,tot:ex.tot,cats:ex.cats,inc,bil,end:saldo(r.e)}}
const totStr=tot=>Object.keys(tot).length?Object.entries(tot).sort().reverse().map(([c,v])=>fmt(v,c)).join(' + '):fmt(0);
const sgn=v=>(v>0?'+':v<0?'−':'')+fmtNum(Math.abs(v));
const bilStr=b=>Object.keys(b).length?Object.entries(b).sort().reverse().map(([c,v])=>sgn(v)+' '+SYM[c]).join(' / '):fmt(0);
const bars=(cs,tot,cl)=>cs.map(x=>{const pct=tot[x.cur]?x.v/tot[x.cur]*100:0;return `<div class="bar"><div class="l"><span>${esc(x.c)}</span><span>${fmt(x.v,x.cur)} · ${Math.round(pct)}%</span></div><div class="t"><div class="${cl}" style="width:${pct.toFixed(1)}%"></div></div></div>`}).join('');
function renderReport(){const p=periodData();$('#periodLabel').textContent=p.label;
  const endS=fmt(p.end.PLN)+(usesEUR()?' / '+fmt(p.end.EUR,'EUR'):'');
  $('#repSum').innerHTML=`<div class="rs sum"><div><small>Bilans okresu</small><b class="${(p.bil.PLN||0)<0?'neg':'pos'}">${bilStr(p.bil)}</b></div><div><small>Saldo na koniec</small><b>${endS}</b></div></div>
  <div class="rs"><h3><span>💚 Wpływy</span><span class="pos">+${totStr(p.inc.tot)}</span></h3>${bars(p.inc.cats,p.inc.tot,'g')}</div>
  <div class="rs"><h3><span>💸 Wydatki</span><span class="neg">−${totStr(p.tot)}</span></h3>${bars(p.cats,p.tot,'r')}</div>`;
  const l=$('#repList');l.innerHTML=p.list.map(li).join('')||'<li class="empty">Brak wpisów w tym okresie</li>';bindList(l)}
function csv(list){const q=s=>{s=String(s??'');return /[;"\n\r]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s};
  const rows=[['Data','Typ','Kwota','Waluta','Kategoria','Notatka']].concat(sortExp(list.slice()).reverse().map(x=>[x.date,isInc(x)?'Wpływ':'Wydatek',x.amount.toFixed(2).replace('.',','),x.currency,x.category,x.note||'']));
  return '\uFEFF'+rows.map(r=>r.map(q).join(';')).join('\r\n')+'\r\n'}
function download(name,content,type){const b=new Blob([content],{type});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},1500)}
$('#csvBtn').onclick=()=>{const p=periodData();download('wydatki_'+p.s+'_'+p.e+'.csv',csv(p.list),'text/csv;charset=utf-8')};
$('#csvAll').onclick=()=>download('wydatki_wszystkie_'+ymd(new Date())+'.csv',csv(expenses),'text/csv;charset=utf-8');
function summary(){const p=periodData();return `Moje pieniądze – ${p.label}\nWpływy: +${totStr(p.inc.tot)}\nWydatki: −${totStr(p.tot)}\n`+p.cats.map(x=>`• ${x.c}: ${fmt(x.v,x.cur)}`).join('\n')+`\nBilans: ${bilStr(p.bil)}\nSaldo na koniec: ${fmt(p.end.PLN)}`+(usesEUR()?' / '+fmt(p.end.EUR,'EUR'):'')}
$('#shareBtn').onclick=async()=>{const t=summary();if(navigator.share){try{await navigator.share({title:'Wydatki',text:t})}catch(e){}}else{try{await navigator.clipboard.writeText(t);toast('Skopiowano podsumowanie')}catch(e){alert(t)}}};

// ---------- settings ----------
function renderIncList(){const l=$('#incList');l.innerHTML=incCats.map((c,i)=>`<li><div class="i">${esc(c)}</div>${DEF_INC.includes(c)?'':`<button class="btn small danger" data-i="${i}">Usuń</button>`}</li>`).join('');
  l.querySelectorAll('button[data-i]').forEach(b=>b.onclick=()=>{const c=incCats[b.dataset.i];if(confirm('Usunąć źródło „'+c+'”? (wpisy zostaną)')){incCats.splice(b.dataset.i,1);saveCats();if(selInc===c)selInc='Inne';renderIncList();renderCats()}})
  $('#defCur').value=localStorage.getItem('cur')||'PLN';const st=getStart();$('#startPLN').value=st.PLN?String(st.PLN).replace('.',','):'';$('#startEUR').value=st.EUR?String(st.EUR).replace('.',','):''}
$('#addInc').onclick=()=>{const v=$('#newInc').value.trim();if(!v)return;if(!incCats.some(c=>c.toLowerCase()===v.toLowerCase())){incCats.splice(incCats.length-1,0,v);saveCats()}$('#newInc').value='';renderIncList();renderCats();toast('Dodano źródło')};
$('#defCur').onchange=e=>{localStorage.setItem('cur',e.target.value);if(!editId)$('#currency').value=e.target.value;toast('Domyślna waluta: '+e.target.value)};
$('#saveStart').onclick=()=>{const v=s=>{const n=parseFloat(String(s).replace(/\s/g,'').replace(',','.').replace(/[^\d.-]/g,''));return isFinite(n)?Math.round(n*100)/100:0};localStorage.setItem('start',JSON.stringify({PLN:v($('#startPLN').value),EUR:v($('#startEUR').value)}));renderBalance();toast('Zapisano stan początkowy')};
function renderCatList(){renderIncList();const l=$('#catList');l.innerHTML=cats.map((c,i)=>`<li><div class="i">${esc(c)}</div>${DEF_CATS.includes(c)?'':`<button class="btn small danger" data-i="${i}">Usuń</button>`}</li>`).join('');
  l.querySelectorAll('button[data-i]').forEach(b=>b.onclick=()=>{const c=cats[b.dataset.i];if(confirm('Usunąć kategorię „'+c+'”? (wydatki zostaną)')){cats.splice(b.dataset.i,1);saveCats();if(selCat===c)selCat='Inne';renderCatList();renderCats()}})}
$('#addCat').onclick=()=>{const v=$('#newCat').value.trim();if(!v)return;if(!cats.some(c=>c.toLowerCase()===v.toLowerCase())){cats.splice(cats.length-1,0,v);saveCats()}$('#newCat').value='';renderCatList();renderCats();toast('Dodano kategorię')};
$('#backupBtn').onclick=()=>download('wydatki_kopia_'+ymd(new Date())+'.json',JSON.stringify({app:'wydatki',v:2,exported:new Date().toISOString(),cats,incCats,start:getStart(),expenses:expenses.filter(x=>!isInc(x)),incomes:expenses.filter(isInc)}),'application/json');
$('#restore').onchange=async e=>{const f=e.target.files[0];e.target.value='';if(!f)return;
  try{const d=JSON.parse(await f.text());if(!Array.isArray(d.expenses))throw new Error('zły plik');
    const inc=Array.isArray(d.incomes)?d.incomes:[];let n=0;
    for(const x of d.expenses)if(x&&x.id&&x.date&&isFinite(x.amount)){await putExp(x);n++}
    for(const x of inc)if(x&&x.id&&x.date&&isFinite(x.amount)){x.type='inc';await putExp(x);n++}
    (d.cats||[]).forEach(c=>{if(!cats.includes(c))cats.push(c)});(d.incCats||[]).forEach(c=>{if(!incCats.includes(c))incCats.push(c)});saveCats();
    if(d.start&&confirm('Wczytać też stan początkowy z kopii?'))localStorage.setItem('start',JSON.stringify(d.start));
    renderCats();await refresh();toast('Wczytano '+n+' wpisów')}
  catch(err){alert('Nie udało się wczytać kopii: '+err.message)}};

// ---------- init ----------
resetForm();renderCats();refresh();
if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('sw.js').catch(()=>{}));
window.__wydatki={parseVoice,findTotal,ocrInfo,csv,periodData,saldo};
