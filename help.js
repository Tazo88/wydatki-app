'use strict';
// Ekran "Jak używać" – pokazywany przy pierwszym uruchomieniu i z przycisku ❓
(function(){
const ua=navigator.userAgent;
const isIOS=/iPad|iPhone|iPod/.test(ua)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
const iosOther=isIOS&&/CriOS|FxiOS|EdgiOS|OPiOS|GSA\/|Instagram|FBAN|FBAV|Line\/|Messenger|WhatsApp/i.test(ua);
const isAndroid=/Android/i.test(ua);
const standalone=navigator.standalone===true||matchMedia('(display-mode: standalone)').matches;

let install='';
if(!standalone){
  if(iosOther) install=`<div class="h-card h-warn"><h3>⚠️ Otwórz w Safari</h3><p>Ta przeglądarka nie zainstaluje aplikacji. Skopiuj link i otwórz go w <b>Safari</b> 🧭, potem wykonaj kroki poniżej.</p><button class="btn small ghost" id="h-copy">📋 Kopiuj link</button></div>`;
  if(isIOS) install+=`<div class="h-card h-hi"><h3>📲 Najpierw zainstaluj (raz)</h3><ol><li>Otwórz tę stronę w <b>Safari</b> 🧭</li><li>Stuknij <b>Udostępnij</b> ⬆️ (na dole ekranu)</li><li>Wybierz <b>„Do ekranu początkowego”</b> ➕</li><li>Stuknij <b>Dodaj</b> ✅</li></ol><p>👉 Potem <b>zawsze</b> otwieraj Wydatki z ikonki <b>zł</b> na ekranie. Dane w ikonce są osobne od Safari.</p></div>`;
  else if(isAndroid) install=`<div class="h-card h-hi"><h3>📲 Najpierw zainstaluj (raz)</h3><ol><li>W Chrome stuknij menu <b>⋮</b></li><li>Wybierz <b>„Zainstaluj aplikację”</b> lub <b>„Dodaj do ekranu głównego”</b></li></ol><p>👉 Potem otwieraj Wydatki z ikonki <b>zł</b>.</p></div>`;
}

const steps=[
 ['💰','Moje pieniądze','Zielona karta na górze pokazuje, <b>ile Ci zostało</b> (wszystkie wpływy − wszystkie wydatki) oraz wpływy i wydatki w tym miesiącu. Na start wpisz, ile masz teraz: Ustawienia → <b>Stan początkowy</b>.'],
 ['💚','Wpływ (dostałaś pieniądze)','Stuknij zielone <b>+ Wpływ</b>, wpisz kwotę, wybierz źródło (np. Wypłata, Przelew od kogoś), w notatce od kogo. <b>Zapisz wpływ</b>.'],
 ['❤️','Wydatek','Stuknij czerwone <b>− Wydatek</b>, wpisz kwotę, stuknij kategorię i <b>Zapisz wydatek</b>. Data to dziś (możesz zmienić).'],
 ['🎤','Głosem','Stuknij <b>🎤 Powiedz</b> albo 🎤 na klawiaturze iPhone’a i powiedz np. <i>„Biedronka 45 złotych jedzenie”</i> albo <i>„wypłata 3500”</i>, <i>„dostałam 200 od mamy”</i>. Sprawdź i zapisz.'],
 ['📷','Paragon','Stuknij <b>📷 Paragon</b>, zrób zdjęcie. Aplikacja podpowie sumę – <b>sprawdź ją</b> i popraw, jeśli trzeba.'],
 ['✏️','Popraw lub usuń','Stuknij wpis na liście → zmień i <b>Zapisz zmiany</b> albo <b>Usuń wydatek</b>.'],
 ['📊','Raporty','Zakładka <b>Raporty</b>: Dzień / Tydzień / Miesiąc – wpływy, wydatki, bilans i saldo. Strzałki ‹ › zmieniają okres. <b>CSV</b> do Excela, <b>Udostępnij</b> wysyła podsumowanie.'],
 ['💾','Kopia zapasowa','Dane są <b>tylko na tym telefonie</b>. Co jakiś czas: Ustawienia → <b>Zapisz kopię</b> i zachowaj plik (np. w mailu lub iCloud).']
];

const css=`#help{position:fixed;inset:0;z-index:50;background:var(--bg);overflow-y:auto;-webkit-overflow-scrolling:touch;padding:calc(env(safe-area-inset-top) + 14px) 16px calc(env(safe-area-inset-bottom) + 20px)}
#help .h-in{max-width:560px;margin:0 auto}
#help h2{margin:4px 0 12px;font-size:26px}
.h-card{background:#fff;border-radius:16px;padding:14px 16px;margin-bottom:12px;box-shadow:0 1px 3px #0001}
.h-card h3{margin:0 0 6px;font-size:18px}.h-card p{margin:6px 0;font-size:16px}
.h-card ol{margin:6px 0;padding-left:22px;font-size:17px;line-height:1.7}
.h-hi{border:2px solid var(--g)}.h-warn{border:2px solid #f59e0b;background:#fffbeb}
.h-step{display:flex;gap:12px;align-items:flex-start}.h-step .e{font-size:30px;line-height:1}
.h-step b,.h-step i{white-space:normal}
header .hbtn{background:#ffffff33;border:0;color:#fff;font-size:20px;width:40px;height:40px;border-radius:50%;margin-left:10px}`;
const st=document.createElement('style');st.textContent=css;document.head.appendChild(st);

const el=document.createElement('div');el.id='help';el.hidden=true;
el.innerHTML=`<div class="h-in"><h2>❓ Jak używać</h2>${install}
${steps.map(([e,t,d])=>`<div class="h-card h-step"><span class="e">${e}</span><div><h3>${t}</h3><p>${d}</p></div></div>`).join('')}
<button class="btn big primary" id="h-ok">Rozumiem, zaczynamy 👍</button></div>`;
document.body.appendChild(el);

function open(){el.hidden=false;el.scrollTop=0}
function close(){el.hidden=true;localStorage.setItem('helpSeen','1')}
el.querySelector('#h-ok').onclick=close;
const cp=el.querySelector('#h-copy');
if(cp)cp.onclick=async()=>{try{await navigator.clipboard.writeText(location.href);cp.textContent='✅ Skopiowano'}catch(e){prompt('Skopiuj link:',location.href)}};

// przycisk ❓ w nagłówku
const hdr=document.querySelector('header');const wrap=document.createElement('div');wrap.style.display='flex';wrap.style.alignItems='center';
const tot=document.getElementById('hdrTotal');hdr.appendChild(wrap);wrap.appendChild(tot);
const b=document.createElement('button');b.className='hbtn';b.textContent='❓';b.setAttribute('aria-label','Jak używać');b.onclick=open;wrap.appendChild(b);

if(!localStorage.getItem('helpSeen'))open();
window.__help={open,close};
})();
