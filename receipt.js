'use strict';
// Odczyt paragonu przez AI (proxy Cloudflare Worker -> Gemini) + ekran sprawdzenia.
// Gdy proxy nie działa / brak internetu -> stary odczyt Tesseract (app.js).
(function(){
const PROXY='https://wydatki-receipt.tazo88.workers.dev';
const photo=document.getElementById('photo');
const ocrFallback=photo.onchange;
let shots=[],R=null,items=[];

const css=`#rcpt{position:fixed;inset:0;z-index:40;background:var(--bg);overflow-y:auto;-webkit-overflow-scrolling:touch;padding:calc(env(safe-area-inset-top) + 12px) 14px calc(env(safe-area-inset-bottom) + 24px)}
#rcpt .in{max-width:600px;margin:0 auto}#rcpt h2{margin:4px 0 10px;font-size:24px}
#rcpt .card{background:#fff;border-radius:16px;padding:12px;margin-bottom:10px}
#rcpt .g2{display:flex;gap:8px;margin-bottom:8px}#rcpt .g2>*{flex:1;min-width:0}
#rcpt label{font-size:12px;color:var(--m);display:block;margin-bottom:2px}
#rcpt input,#rcpt select{min-height:44px;padding:9px;font-size:16px}
#rcpt .it{display:grid;grid-template-columns:1fr 92px 34px;gap:6px;padding:8px 0;border-bottom:1px solid #eee}
#rcpt .it select{grid-column:1/3}#rcpt .it .x{grid-row:1/3;grid-column:3;border:0;background:none;font-size:20px;color:#dc2626}
#rcpt .it input.p{text-align:right;font-weight:700}
#rcpt .warn{background:#fffbeb;border:2px solid #f59e0b;border-radius:12px;padding:10px;margin-bottom:10px;font-size:15px}
#rcpt .okm{background:#ecfdf5;border:1px solid #a7f3d0;border-radius:12px;padding:8px 10px;margin-bottom:10px;font-size:14px}
#rcpt .ct{display:flex;justify-content:space-between;padding:4px 0;font-size:16px}
#rcpt .thumbs{display:flex;gap:6px;flex-wrap:wrap}#rcpt .thumbs img{width:54px;height:54px;object-fit:cover;border-radius:8px}`;
const st=document.createElement('style');st.textContent=css;document.head.appendChild(st);
const el=document.createElement('div');el.id='rcpt';el.hidden=true;document.body.appendChild(el);
const more=document.createElement('input');more.type='file';more.accept='image/*';more.hidden=true;document.body.appendChild(more);

// 🧾 przy wydatkach z jednego paragonu
const _li=li;li=function(x){let h=_li(x);if(x.receipt)h=h.replace('<b>','<b>🧾 ');return h};

function b64(img){return scaled(img,1600).toDataURL('image/jpeg',0.72).split(',')[1]}
async function addFiles(files){for(const f of files){const img=await loadImg(f);shots.push({data:b64(img),thumb:scaled(img,480,0.6)})}}
async function callProxy(){
  const ctl=new AbortController();const t=setTimeout(()=>ctl.abort(),60000);
  try{const r=await fetch(PROXY,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+(window.WY&&WY.token()||'')},signal:ctl.signal,
      body:JSON.stringify({images:shots.slice(0,4).map(s=>({mime:'image/jpeg',data:s.data})),categories:cats.filter(c=>!DEF_CATS.includes(c))})});
    const j=await r.json();if(!r.ok||j.error)throw new Error(j.error||('HTTP '+r.status));return j}
  finally{clearTimeout(t)}
}

photo.onchange=async e=>{
  const files=[...e.target.files];
  if(!files.length)return;
  // AI tylko z kontem; bez konta – lokalny odczyt na telefonie
  if(editId||!navigator.onLine||!(window.WY&&WY.loggedIn()))return ocrFallback.call(photo,{target:{files,value:''}});
  photo.value='';shots=[];
  try{
    await addFiles(files);photoData=shots[0].thumb;showPhoto();
    status('🤖 Czytam paragon (AI)… to zwykle 5–15 sekund');
    R=await callProxy();status('');open();
  }catch(err){
    shots=[];status('Odczyt AI niedostępny ('+err.message+') – używam prostego odczytu…');
    ocrFallback.call(photo,{target:{files,value:''}});
  }
};
more.onchange=async()=>{const files=[...more.files];more.value='';if(!files.length)return;
  const keep=collect();try{el.querySelector('#rMore').textContent='⏳ Czytam…';await addFiles(files);R=await callProxy();open()}
  catch(err){alert('Nie udało się odczytać dodatkowego zdjęcia ('+err.message+')');Object.assign(R,keep);open()}};

const r2=n=>Math.round(n*100)/100;
function collect(){return{shop:el.querySelector('#rShop').value,date:el.querySelector('#rDate').value,currency:el.querySelector('#rCur').value,total:parseAmt(el.querySelector('#rTot').value)||0}}
function open(){
  const cur=R.currency==='PLN'?'PLN':(R.currency==='EUR'?'EUR':(R.currency?'EUR':($('#currency').value)));
  items=(R.items||[]).map(i=>({...i,category:cats.includes(i.category)?i.category:'Inne'}));
  const date=/^\d{4}-\d{2}-\d{2}$/.test(R.date||'')?R.date:ymd(new Date());
  const opt=(list,sel)=>list.map(c=>`<option${c===sel?' selected':''}>${esc(c)}</option>`).join('');
  el.innerHTML=`<div class="in"><h2>🧾 Sprawdź paragon</h2>
  <div class="card"><div class="thumbs">${shots.map(s=>`<img src="${s.thumb}">`).join('')}</div>
   <div class="g2" style="margin-top:8px"><div><label>Sklep</label><input id="rShop" value="${esc(R.shop||'')}"></div><div><label>Data</label><input id="rDate" type="date" value="${date}"></div></div>
   <div class="g2"><div><label>Waluta</label><select id="rCur">${opt(['PLN','EUR'],cur)}</select></div><div><label>Suma z paragonu</label><input id="rTot" inputmode="decimal" value="${String(R.total||0).replace('.',',')}"></div></div>
   ${R.currency&&!['PLN','EUR'].includes(R.currency)?`<div class="warn">Waluta na paragonie: ${esc(R.currency)} – aplikacja liczy tylko PLN/EUR, sprawdź.</div>`:''}
  </div>
  <div id="rChk"></div>
  <div class="card"><b>Produkty</b> <small style="color:var(--m)">(możesz zmienić kategorię, nazwę i cenę)</small><div id="rItems"></div>
   <button class="btn small ghost" id="rAdd" style="margin-top:8px">➕ Dodaj pozycję</button></div>
  <div class="card"><b>Razem wg kategorii</b><div id="rCats"></div></div>
  <button class="btn big primary" id="rSaveCat">✅ Zapisz wg kategorii</button>
  <button class="btn big ghost" id="rSaveOne">Zapisz jako jeden wydatek</button>
  <button class="btn big ghost" id="rMore">📷 Dodaj kolejne zdjęcie (długi paragon)</button>
  <button class="btn big ghost" id="rCancel">Anuluj</button></div>`;
  el.hidden=false;el.scrollTop=0;
  renderItems();
  el.querySelector('#rTot').oninput=recalc;el.querySelector('#rCur').onchange=recalc;
  el.querySelector('#rAdd').onclick=()=>{items.push({name:'',qty:1,price:0,category:'Inne'});renderItems()};
  el.querySelector('#rCancel').onclick=()=>{el.hidden=true;status('Zdjęcie dodane – wpisz kwotę ręcznie albo zrób zdjęcie ponownie.')};
  el.querySelector('#rMore').onclick=()=>more.click();
  el.querySelector('#rSaveCat').onclick=()=>save(false);
  el.querySelector('#rSaveOne').onclick=()=>save(true);
}
function renderItems(){
  const box=el.querySelector('#rItems');
  box.innerHTML=items.map((it,i)=>`<div class="it" data-i="${i}"><input class="n" value="${esc(it.name)}" placeholder="nazwa"><input class="p" inputmode="decimal" value="${String(it.price).replace('.',',')}"><button class="x" aria-label="usuń">✕</button><select class="c">${cats.map(c=>`<option${c===it.category?' selected':''}>${esc(c)}</option>`).join('')}</select></div>`).join('')||'<p class="hint">Brak pozycji – dodaj ręcznie albo zapisz jako jeden.</p>';
  box.querySelectorAll('.it').forEach(row=>{const it=items[row.dataset.i];
    row.querySelector('.n').oninput=e=>it.name=e.target.value;
    row.querySelector('.p').oninput=e=>{it.price=parseFloat(e.target.value.replace(/\s/g,'').replace(',','.'))||0;recalc()};
    row.querySelector('.c').onchange=e=>{it.category=e.target.value;recalc()};
    row.querySelector('.x').onclick=()=>{items.splice(row.dataset.i,1);renderItems()}});
  recalc();
}
function groups(){const g={};items.forEach(it=>{g[it.category]=r2((g[it.category]||0)+it.price)});return g}
function recalc(){
  const cur=el.querySelector('#rCur').value,tot=parseAmt(el.querySelector('#rTot').value)||0,sum=r2(items.reduce((s,i)=>s+i.price,0)),g=groups();
  el.querySelector('#rChk').innerHTML=Math.abs(tot-sum)<=0.05?`<div class="okm">✅ Produkty sumują się do ${fmt(tot,cur)}</div>`:`<div class="warn">⚠️ Produkty: <b>${fmt(sum,cur)}</b>, suma paragonu: <b>${fmt(tot,cur)}</b> (różnica ${fmt(r2(tot-sum),cur)}). Popraw ceny albo zapisz jako jeden wydatek.</div>`;
  el.querySelector('#rCats').innerHTML=Object.entries(g).sort((a,b)=>b[1]-a[1]).map(([c,v])=>`<div class="ct"><span>${esc(c)}</span><b>${fmt(v,cur)}</b></div>`).join('');
  el.querySelector('#rSaveCat').textContent=`✅ Zapisz wg kategorii (${Object.values(g).filter(v=>v>0).length})`;
}
async function save(one){
  const h=collect();const g=groups();const rid='r'+Date.now().toString(36);const base=Date.now();const ph=shots[0]?shots[0].thumb:null;
  const shop=h.shop.trim()||'Paragon';const list=[];
  if(one||!items.length){
    if(!(h.total>0)){alert('Podaj sumę paragonu');return}
    const top=Object.entries(g).sort((a,b)=>b[1]-a[1])[0];
    list.push({category:top?top[0]:selCat,amount:h.total,note:shop});
  }else{
    const ents=Object.entries(g).filter(([,v])=>v>0);
    if(!ents.length){alert('Brak kwot do zapisania');return}
    ents.forEach(([c,v])=>{const names=items.filter(i=>i.category===c).map(i=>i.name).filter(Boolean).join(', ');list.push({category:c,amount:v,note:(shop+': '+names).slice(0,160)})});
  }
  for(let i=0;i<list.length;i++){const x=list[i];
    await putExp({id:rid+'_'+i,type:'exp',amount:r2(x.amount),currency:h.currency,category:x.category,note:x.note,date:h.date||ymd(new Date()),photo:ph,receipt:rid,created:base-i})}
  localStorage.setItem('cur',h.currency);
  el.hidden=true;shots=[];R=null;resetForm();await refresh();
  toast(list.length>1?`Zapisano ${list.length} wydatki z paragonu`:'Zapisano wydatek z paragonu');
}
window.__rcpt={open:j=>{R=j;shots=[];open()},save};
})();
