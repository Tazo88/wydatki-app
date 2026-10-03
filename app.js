'use strict';
// ---------- helpers ----------
const $=s=>document.querySelector(s);
const DEF_CATS=['Jedzenie','Zakupy/dom','Transport/paliwo','Rachunki','Zdrowie','Dzieci','Rozrywka','Ubrania','Inne'];
const pad=n=>String(n).padStart(2,'0');
const ymd=d=>d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
const parseYmd=s=>{const[a,b,c]=s.split('-').map(Number);return new Date(a,b-1,c)};
const fmtNum=n=>(Math.round(n*100)/100).toFixed(2).replace('.',',').replace(/\B(?=(\d{3})+(?!\d))/g,' ');
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
let cats=JSON.parse(localStorage.getItem('cats')||'null')||DEF_CATS.slice();
const saveCats=()=>localStorage.setItem('cats',JSON.stringify(cats));
let selCat='Jedzenie', editId=null, photoData=null, expenses=[];
let period='m', anchor=new Date();

// ---------- tabs ----------
document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>showTab(b.dataset.t));
function showTab(t){document.querySelectorAll('.tabs button').forEach(x=>x.classList.toggle('on',x.dataset.t===t));document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x.id==='tab-'+t));if(t==='rep')renderReport();if(t==='set')renderCatList();window.scrollTo(0,0)}

// ---------- form ----------
function renderCats(){const el=$('#cats');el.innerHTML='';cats.forEach(c=>{const b=document.createElement('button');b.type='button';b.textContent=c;if(c===selCat)b.classList.add('on');b.onclick=()=>{selCat=c;renderCats()};el.appendChild(b)})}
function resetForm(){editId=null;photoData=null;$('#amount').value='';$('#note').value='';$('#date').value=ymd(new Date());$('#currency').value=localStorage.getItem('cur')||'PLN';$('#saveBtn').textContent='Zapisz wydatek';$('#cancelEdit').hidden=true;$('#delBtn').hidden=true;showPhoto();status('')}
function showPhoto(){$('#photoPrev').hidden=!photoData;if(photoData)$('#thumb').src=photoData}
$('#rmPhoto').onclick=()=>{photoData=null;showPhoto()};
$('#cancelEdit').onclick=()=>{resetForm();renderCats()};
$('#delBtn').onclick=async()=>{if(editId&&confirm('Usunąć ten wydatek?')){await delExp(editId);toast('Usunięto');resetForm();await refresh()}};
$('#form').onsubmit=async e=>{
  e.preventDefault();
  const amount=parseAmt($('#amount').value);
  if(!(amount>0)){toast('Podaj kwotę');$('#amount').focus();return}
  const old=editId?expenses.find(x=>x.id===editId):null;
  const exp={id:editId||(Date.now().toString(36)+Math.random().toString(36).slice(2,7)),amount:Math.round(amount*100)/100,currency:$('#currency').value,category:selCat,note:$('#note').value.trim(),date:$('#date').value||ymd(new Date()),photo:photoData||null,created:old?old.created:Date.now()};
  localStorage.setItem('cur',exp.currency);
  await putExp(exp);
  toast(editId?'Zapisano zmiany':'Dodano '+fmt(exp.amount,exp.currency));
  resetForm();renderCats();await refresh();
};
function editExpense(id){const x=expenses.find(e=>e.id===id);if(!x)return;showTab('add');editId=id;$('#amount').value=String(x.amount).replace('.',',');$('#currency').value=x.currency;selCat=x.category;if(!cats.includes(selCat)){cats.push(selCat);saveCats()}$('#note').value=x.note||'';$('#date').value=x.date;photoData=x.photo||null;showPhoto();renderCats();$('#saveBtn').textContent='Zapisz zmiany';$('#cancelEdit').hidden=false;$('#delBtn').hidden=false}

function li(x){return `<li data-id="${x.id}">${x.photo?`<img src="${x.photo}" alt="">`:''}<div class="i"><b>${esc(x.category)}</b><small>${esc(x.date.split('-').reverse().join('.'))}${x.note?' · '+esc(x.note):''}</small></div><span class="a">${fmt(x.amount,x.currency)}</span></li>`}
function bindList(el){el.querySelectorAll('li[data-id]').forEach(l=>l.onclick=()=>editExpense(l.dataset.id))}
const sortExp=a=>a.sort((p,q)=>q.date.localeCompare(p.date)||q.created-p.created);

async function refresh(){
  expenses=sortExp(await allExp());
  const r=$('#recent');r.innerHTML=expenses.slice(0,10).map(li).join('')||'<li class="empty">Brak wydatków — dodaj pierwszy 🙂</li>';bindList(r);
  const today=ymd(new Date());const t=expenses.filter(x=>x.date===today&&x.currency==='PLN').reduce((s,x)=>s+x.amount,0);
  $('#hdrTotal').textContent='Dziś: '+fmt(t);
  if($('#tab-rep').classList.contains('active'))renderReport();
}

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
function parseVoice(text){
  const raw=text.trim();let t=raw.toLowerCase();
  const res={};
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
      if(p.amount)$('#amount').value=String(p.amount).replace('.',',');
      if(p.currency)$('#currency').value=p.currency;
      if(p.category){selCat=p.category;renderCats()}
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
function findTotal(text){
  const lines=text.split(/\n/);const amtRe=/(\d{1,5})\s?[.,]\s?(\d{2})(?!\d)/g;
  const nums=l=>[...l.matchAll(amtRe)].map(m=>parseFloat(m[1]+'.'+m[2]));
  for(const key of [/SUMA\s*PLN/i,/SUMA/i,/RAZEM/i,/DO\s*ZAP[ŁL]ATY/i,/[ŁL]?[ĄA]CZNIE/i]){
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
    const tot=findTotal(data.text);
    if(tot){$('#amount').value=String(tot).replace('.',',');status('Znaleziona suma: '+fmt(tot)+' — sprawdź, popraw jeśli trzeba i kliknij Zapisz.')}
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
function periodData(){const r=range();const list=expenses.filter(x=>x.date>=r.s&&x.date<=r.e);
  const tot={},byCat={};list.forEach(x=>{tot[x.currency]=(tot[x.currency]||0)+x.amount;const k=x.category+'|'+x.currency;byCat[k]=(byCat[k]||0)+x.amount});
  const cats_=Object.entries(byCat).map(([k,v])=>{const[c,cur]=k.split('|');return{c,cur,v}}).sort((a,b)=>b.v-a.v);
  return{...r,list,tot,cats:cats_}}
const totStr=tot=>Object.keys(tot).length?Object.entries(tot).sort().reverse().map(([c,v])=>fmt(v,c)).join(' + '):fmt(0);
function renderReport(){const p=periodData();$('#periodLabel').textContent=p.label;$('#repTotal').textContent=totStr(p.tot);
  $('#bars').innerHTML=p.cats.map(x=>{const pct=p.tot[x.cur]?x.v/p.tot[x.cur]*100:0;return `<div class="bar"><div class="l"><span>${esc(x.c)}</span><span>${fmt(x.v,x.cur)} · ${Math.round(pct)}%</span></div><div class="t"><div style="width:${pct.toFixed(1)}%"></div></div></div>`}).join('');
  const l=$('#repList');l.innerHTML=p.list.map(li).join('')||'<li class="empty">Brak wydatków w tym okresie</li>';bindList(l)}
function csv(list){const q=s=>{s=String(s??'');return /[;"\n\r]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s};
  const rows=[['Data','Kwota','Waluta','Kategoria','Notatka']].concat(sortExp(list.slice()).reverse().map(x=>[x.date,x.amount.toFixed(2).replace('.',','),x.currency,x.category,x.note||'']));
  return '\uFEFF'+rows.map(r=>r.map(q).join(';')).join('\r\n')+'\r\n'}
function download(name,content,type){const b=new Blob([content],{type});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},1500)}
$('#csvBtn').onclick=()=>{const p=periodData();download('wydatki_'+p.s+'_'+p.e+'.csv',csv(p.list),'text/csv;charset=utf-8')};
$('#csvAll').onclick=()=>download('wydatki_wszystkie_'+ymd(new Date())+'.csv',csv(expenses),'text/csv;charset=utf-8');
function summary(){const p=periodData();return `Wydatki – ${p.label}\nRazem: ${totStr(p.tot)}\n`+p.cats.map(x=>`• ${x.c}: ${fmt(x.v,x.cur)}`).join('\n')}
$('#shareBtn').onclick=async()=>{const t=summary();if(navigator.share){try{await navigator.share({title:'Wydatki',text:t})}catch(e){}}else{try{await navigator.clipboard.writeText(t);toast('Skopiowano podsumowanie')}catch(e){alert(t)}}};

// ---------- settings ----------
function renderCatList(){const l=$('#catList');l.innerHTML=cats.map((c,i)=>`<li><div class="i">${esc(c)}</div>${DEF_CATS.includes(c)?'':`<button class="btn small danger" data-i="${i}">Usuń</button>`}</li>`).join('');
  l.querySelectorAll('button[data-i]').forEach(b=>b.onclick=()=>{const c=cats[b.dataset.i];if(confirm('Usunąć kategorię „'+c+'”? (wydatki zostaną)')){cats.splice(b.dataset.i,1);saveCats();if(selCat===c)selCat='Inne';renderCatList();renderCats()}})}
$('#addCat').onclick=()=>{const v=$('#newCat').value.trim();if(!v)return;if(!cats.some(c=>c.toLowerCase()===v.toLowerCase())){cats.splice(cats.length-1,0,v);saveCats()}$('#newCat').value='';renderCatList();renderCats();toast('Dodano kategorię')};
$('#backupBtn').onclick=()=>download('wydatki_kopia_'+ymd(new Date())+'.json',JSON.stringify({app:'wydatki',v:1,exported:new Date().toISOString(),cats,expenses}),'application/json');
$('#restore').onchange=async e=>{const f=e.target.files[0];e.target.value='';if(!f)return;
  try{const d=JSON.parse(await f.text());if(!Array.isArray(d.expenses))throw new Error('zły plik');
    for(const x of d.expenses)if(x&&x.id&&x.date&&isFinite(x.amount))await putExp(x);
    (d.cats||[]).forEach(c=>{if(!cats.includes(c))cats.push(c)});saveCats();renderCats();await refresh();toast('Wczytano '+d.expenses.length+' wydatków')}
  catch(err){alert('Nie udało się wczytać kopii: '+err.message)}};

// ---------- init ----------
resetForm();renderCats();refresh();
if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('sw.js').catch(()=>{}));
window.__wydatki={parseVoice,findTotal,csv,periodData};
