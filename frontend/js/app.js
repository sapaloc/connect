/* CONNECT app · optimized V1 demo (jQuery + Bootstrap + localStorage)
   Spec coverage: auth+RBAC, console, partners, locations, referrers, budget,
   media, cards, microsite+i18n, anonymous vouchers, counter, finance Net/Net,
   voids, payout+VietQR, settlements, reports/CSV, audit. See gap-notes inline. */
$(function(){
const S=window.ConnectStore, T=window.ConnectI18N;
const API=window.ConnectAPI; // backend link (Express /api/*), localStorage fallback when offline
let DB=S.seed();
if(S.autoEnd(DB)) S.save(DB);
function updateApiBadge(){ try{ $('#api-badge').text(API&&API.reachable()?'API ● connected':'API ○ local'); }catch(e){} }
setTimeout(updateApiBadge,800); setInterval(updateApiBadge,5000);
async function pullSnapshot(){
  // after backend login: replace local DB with scoped server snapshot (keeps users/session shape)
  if(!API||!API.reachable()||!API.token()) return false;
  try{
    const snap=await API.snapshot();
    const sess=DB.session;
    DB=Object.assign({}, snap, { session: sess });
    S.save(DB); return true;
  }catch(e){ return false; }
}
let VIEW='home'; let FILTER='';
const qs=new URLSearchParams(location.search);
const deviceId=(()=>{let d=localStorage.getItem('connect_device');if(!d){d='dev_'+Math.random().toString(36).slice(2,9);localStorage.setItem('connect_device',d);}return d;})();

/* ---------- helpers ---------- */
function save(){S.save(DB);}
function me(){return DB.users.find(u=>u.id===(DB.session&&DB.session.userId));}
function role(){return DB.session&&DB.session.role;}
function can(...r){return DB.session&&r.includes(DB.session.role);}
function esc(s){return String(s==null?'':s).replace(/[&<>"'`/=]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','`':'&#96;','/':'&#47;','=':'&#61;'}[c]));}
function t(k){return T.t(DB,k);}
// RBAC enforcement map (UI hiding alone is not enforcement — every mutating action calls require())
const POLICY={
  partner_create:['tenant_admin','platform_admin'], partner_approve:['tenant_admin','platform_admin'],
  location_write:['tenant_admin','platform_admin','partner_admin'],
  referrer_approve:['tenant_admin','platform_admin'], referrer_submit:['partner_admin','tenant_admin','platform_admin'],
  referrer_end:['partner_admin','tenant_admin','platform_admin'],
  budget_write:['tenant_admin'], media_write:['tenant_admin','platform_admin'],
  card_approve:['tenant_admin','platform_admin'], card_request:['partner_admin','referrer','tenant_admin'],
  content_write:['tenant_admin'], counter_redeem:['staff160','manager160','tenant_admin'],
  void:['manager160','tenant_admin'], payout_verify_company:['tenant_admin'], payout_verify_affil:['partner_admin','tenant_admin'],
  settle:['tenant_admin','partner_admin'], settings:['tenant_admin','platform_admin']
};
function require(roleKey){
  const ok=(POLICY[roleKey]||[]).includes(role());
  if(!ok){alert('Not permitted for role '+role()+' (requires: '+(POLICY[roleKey]||[]).join(', ')+')');}
  return ok;
}
function sessionValid(){
  if(!DB.session) return false;
  if(Date.now()-new Date(DB.session.ts).getTime()>8*3600*1000){DB.session=null;save();return false;} // 8h expiry
  return true;
}
function myScopePartnerIds(){
  if(role()==='partner_admin'&&DB.session.scope) return [DB.session.scope];
  if(role()==='referrer'){const r=DB.referrers.find(x=>x.id===DB.session.scope);return r?[r.partnerId]:[];}
  return null; // tenant-wide
}
function partnerName(id){const p=DB.partners.find(x=>x.id===id);return p?p.name:id||'—';}
function remainingText(iso){const ms=new Date(iso)-new Date();if(ms<=0)return t('expired');const d=Math.floor(ms/864e5),h=Math.floor(ms%864e5/36e5);return d>0?d+'d '+h+'h '+t('remaining'):h+'h '+Math.floor(ms%36e5/6e4)+'m '+t('remaining');}

/* ---------- auth ---------- */
function rateKey(e){return 'rl_'+e;}
function checkRate(email){
  let a={n:0,t:Date.now()}; try{a=JSON.parse(localStorage.getItem(rateKey(email))||'{"n":0,"t":0}');}catch(e){}
  if(Date.now()-a.t>5*60*1000){a={n:0,t:Date.now()};localStorage.setItem(rateKey(email),JSON.stringify(a));}
  return a.n<5;
}
function hitRate(email){
  let a={n:0,t:Date.now()}; try{a=JSON.parse(localStorage.getItem(rateKey(email))||'{"n":0,"t":0}');}catch(e){}
  if(Date.now()-a.t>5*60*1000)a={n:0,t:Date.now()};
  a.n++;a.t=a.t||Date.now();localStorage.setItem(rateKey(email),JSON.stringify(a));
}
function doLogin(){
  const email=$('#li-email').val().trim().toLowerCase(), pw=$('#li-pass').val();
  const r=$('#li-role').val()||'tenant_admin', supportReason=$('#li-support').val().trim();
  // 1) try backend API first (total solution)
  if(API&&API.reachable()){
    API.login(email,pw,r,supportReason).then(async d=>{
      API.setToken(d.token);
      DB.session={userId:d.user.id,role:d.role,scope:d.scope,ts:S.vnNow(),support:d.role==='platform_admin',supportReason};
      await pullSnapshot();
      // re-attach session after snapshot replace
      DB.session={userId:d.user.id,role:d.role,scope:d.scope,ts:S.vnNow(),support:d.role==='platform_admin',supportReason};
      S.save(DB); updateApiBadge(); render();
    }).catch(err=>{ $('#li-err').text(err.message||'Login failed').show(); });
    return;
  }
  if(!checkRate(email)){$('#li-err').text('Rate limited — try in 5 min').show();return;}
  const u=DB.users.find(x=>x.email===email&&x.active);
  if(!u||u.pass!==pw){hitRate(email);S.audit(DB,email,'signin_failed','','','tenant',true);save();$('#li-err').text('Invalid credentials').show();return;}
  localStorage.setItem(rateKey(email),JSON.stringify({n:0,t:Date.now()}));
  const r2=$('#li-role').val()||u.roles[0];
  if(!u.roles.includes(r2)){$('#li-err').text('Role not assigned to this user — explicit selection required').show();return;}
  let scope='tenant'; if(r2==='partner_admin')scope=u.partnerId||DB.partners[0].id; if(r2==='referrer')scope=u.referrerId||'';
  if(r2==='platform_admin'){const reason=$('#li-support').val().trim();if(!reason){$('#li-err').text('Support reason required').show();return;}
    DB.session={userId:u.id,role:r2,scope:'tenant',support:true,supportReason:reason,ts:S.vnNow()};
    S.audit(DB,u.id,'support_access','','tenant (reason: '+reason+')','tenant',true); }
  else DB.session={userId:u.id,role:r2,scope,ts:S.vnNow()};
  S.audit(DB,u.id,'signin','',r2+'/'+scope,'tenant',true); save(); render();
}
function logout(){ if(API&&API.token()){ API.logout().catch(()=>{}); } if(DB.session)S.audit(DB,DB.session.userId,'signout','','','tenant',true); DB.session=null; save(); render();}

/* ---------- shared ---------- */
function permGate(){ const r=role(); $('[data-require]').each(function(){$(this).toggle($(this).data('require').split(',').includes(r));}); }
function csv(name,rows){ const c=rows.map(r=>r.map(x=>'"'+String(x==null?'':x).replace(/"/g,'""')+'"').join(',')).join('\n');
  const b=new Blob(["\ufeff"+c],{type:'text/csv;charset=utf-8'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=name;document.body.appendChild(a);a.click();a.remove();}

/* ---------- views ---------- */
function vHome(){
  const pendP=DB.partners.filter(p=>p.status==='onboarding').length;
  const pendR=DB.referrers.filter(r=>r.status==='pending').length;
  const pendC=DB.cards.filter(c=>c.status==='requested').length;
  const pendPo=DB.payouts.filter(p=>p.verified==='pending').length;
  const openTx=DB.redemptions.filter(r=>!r.voided&&!r.settlementId);
  const unpaid=openTx.reduce((s,r)=>s+(r.coComm+r.indComm),0);
  return `<div class="card-sw mb-3"><h4>${t('attention')}</h4>
  <div class="grid-kpi mt-3">
   <div class="card-sw"><div class="mono kpi">${pendP}</div><div>Partners onboarding</div><button class="btn btn-sm btn-outline-dark mt-2" data-go="partners">Review</button></div>
   <div class="card-sw"><div class="mono kpi">${pendR}</div><div>Referrers pending</div><button class="btn btn-sm btn-outline-dark mt-2" data-go="referrers">Review</button></div>
   <div class="card-sw"><div class="mono kpi">${pendC}</div><div>Cards requested</div><button class="btn btn-sm btn-outline-dark mt-2" data-go="cards">Review</button></div>
   <div class="card-sw"><div class="mono kpi">${pendPo}</div><div>Payouts to verify</div><button class="btn btn-sm btn-outline-dark mt-2" data-go="payout">Review</button></div>
   <div class="card-sw"><div class="mono kpi">${openTx.length}</div><div>Open commissions · ${unpaid.toLocaleString()} VND</div><button class="btn btn-sm btn-outline-dark mt-2" data-go="settle">Settle</button></div>
  </div></div>
  <div class="card-sw"><h6>Funnel (event language — opens / activations / redemptions)</h6><div id="funnel" class="mono small"></div></div>`;
}
function funnelText(){
  const o=DB.events.filter(e=>e.k==='open').length, a=DB.vouchers.length, r=DB.redemptions.filter(x=>!x.voided).length;
  const rev=DB.redemptions.filter(x=>!x.voided).reduce((s,x)=>s+x.gross,0);
  const com=DB.redemptions.filter(x=>!x.voided).reduce((s,x)=>s+x.coComm+x.indComm,0);
  const paid=DB.settlements.reduce((s,x)=>s+x.amount,0);
  return `opens ${o} → activations ${a} → redemptions ${r} → revenue ${rev.toLocaleString()} VND → commission ${com.toLocaleString()} → paid ${paid.toLocaleString()}`;
}
function vPartners(){
  let list=DB.partners;
  const sc=myScopePartnerIds(); if(sc) list=list.filter(p=>sc.includes(p.id));
  if(FILTER) list=list.filter(p=>p.name.toLowerCase().includes(FILTER.toLowerCase()));
  let rows=list.map(p=>`<tr>
   <td><b>${esc(p.name)}</b><br><small class="text-muted">${p.kind} · ${esc(p.ptype||'')} · ${p.status} · ${esc(p.validFrom||'')}→${esc(p.validTo||'∞')}</small></td>
   <td class="mono small">${esc(p.contact||'')} ${esc(p.email||p.phone||'')}</td>
   <td><span class="pill ${p.status==='active'?'p-act':p.status==='onboarding'?'p-on':'p-info'}">${p.status}</span></td>
   <td><button class="btn btn-sm btn-outline-dark" data-dossier="${p.id}">Dossier</button>
   ${p.status==='onboarding'?`<button class="btn btn-sm btn-success" data-pact="${p.id}" data-s="active">Approve</button>`:''}
   ${p.status==='active'?`<button class="btn btn-sm btn-outline-secondary" data-pact="${p.id}" data-s="paused">Pause</button> <button class="btn btn-sm btn-outline-danger" data-pact="${p.id}" data-s="ended">End</button>`:''}
   ${p.status==='paused'?`<button class="btn btn-sm btn-success" data-pact="${p.id}" data-s="active">Resume</button>`:''}</td></tr>`).join('');
  return `<div class="card-sw"><div class="d-flex gap-2 mb-2 flex-wrap"><h4 class="flex-grow-1">${t('partners')}</h4>
   <input id="q" class="form-control w-auto" placeholder="${t('search')}" value="${esc(FILTER)}">
   <button class="btn btn-dark" data-require="tenant_admin,platform_admin" data-new="company">+ Company</button>
   <button class="btn btn-outline-dark" data-require="tenant_admin,platform_admin" data-new="individual">+ Individual</button></div>
   <table class="tbl"><tr><th>Partner</th><th>Contact (name + email|phone required)</th><th>Status</th><th></th></tr>${rows||'<tr><td colspan=4>none in scope</td></tr>'}</table>
   <small class="text-muted">Lifecycle: onboarding→active→paused→active(resumed)→ended. End preserves history; media status separate. Auto-end runs on load via validTo.</small></div>`;
}
function vLocations(){
  const sc=myScopePartnerIds();
  let locs=DB.locations; if(sc) locs=locs.filter(l=>sc.includes(l.partnerId));
  const rows=locs.map(l=>{return `<tr><td>${esc(l.name)}<br><small>${esc(l.address)} · ${esc(l.ward)} · VN/Saigon fixed</small></td><td>${esc(partnerName(l.partnerId))}</td><td>${esc(l.referrerId||'—')}</td><td><button class="btn btn-sm btn-outline-danger" data-locdel="${l.id}" data-require="tenant_admin,platform_admin,partner_admin">Del</button></td></tr>`;}).join('');
  const opts=DB.partners.filter(p=>p.kind==='company'&&(!sc||sc.includes(p.id))).map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('');
  const refOpts=DB.referrers.filter(r=>r.kind==='affiliated'&&(!sc||sc.includes(r.partnerId))).map(r=>`<option value="${r.id}">${esc(r.name)} (${esc(r.partnerId)})</option>`).join('');
  return `<div class="card-sw"><h4>${t('locations')}</h4>
  <table class="tbl"><tr><th>Location (name+address+ward)</th><th>Company</th><th>Affiliated referrer (max 1 current)</th><th></th></tr>${rows||'<tr><td colspan=4>none</td></tr>'}</table>
  <div class="row g-2 mt-2" data-require="tenant_admin,platform_admin,partner_admin"><div class="col-md-2"><select id="nl-p" class="form-select">${opts}</select></div><div class="col-md-2"><input id="nl-n" class="form-control" placeholder="Name"></div><div class="col-md-2"><input id="nl-a" class="form-control" placeholder="Street"></div><div class="col-md-2"><input id="nl-w" class="form-control" placeholder="Ward/District"></div><div class="col-md-2"><select id="nl-r" class="form-select"><option value="">— referrer —</option>${refOpts}</select></div><div class="col-auto"><button class="btn btn-dark" id="nl-add">Add</button></div></div>
  <small class="text-muted">Position (e.g. Concierge) ≠ physical location. Referrer must belong to selected company.</small></div>`;
}
function vReferrers(){
  const sc=myScopePartnerIds();
  let list=DB.referrers; if(sc) list=list.filter(r=>sc.includes(r.partnerId));
  const rows=list.map(r=>`<tr><td><b>${esc(r.name)}</b><br><small>${r.kind} · ${esc(r.rtype||'')} · ${r.status}${r.rejectReason?' · reason: '+esc(r.rejectReason):''}</small></td>
  <td>${esc(partnerName(r.partnerId))}</td><td><span class="pill ${r.status==='approved'?'p-act':r.status==='pending'?'p-on':'p-info'}">${r.status}</span></td>
  <td>${r.status==='pending'?`<button class="btn btn-sm btn-success" data-ract="${r.id}" data-s="approved">Approve</button> <button class="btn btn-sm btn-danger" data-ract="${r.id}" data-s="rejected">Reject</button>`:''}
  ${r.status==='approved'?`<button class="btn btn-sm btn-outline-danger" data-ract="${r.id}" data-s="ended">End (keep history)</button>`:''}</td></tr>`).join('');
  return `<div class="card-sw"><h4>${t('referrers')}</h4><table class="tbl"><tr><th>Referrer</th><th>Company</th><th>Status</th><th></th></tr>${rows||'<tr><td colspan=4>none</td></tr>'}</table>
  <div class="mt-2" data-require="partner_admin,tenant_admin,platform_admin"><button class="btn btn-dark" id="nr-aff">+ Submit affiliated (→ Pending, no referral before approval)</button></div></div>`;
}
function vBudget(){
  const rows=DB.budgets.map(b=>`<tr><td class="mono">${esc(b.scopeId)}<br><small>${esc(partnerName(b.scopeId))}</small></td><td class="mono">T${b.total} D${b.discount} C${b.companyComm||'-'} S${b.indivShare||b.indivComm||'-'} N${b.companyNet||'-'}</td><td class="small">${esc(b.by)} ${S.vnDisplay(b.at)}</td></tr>`).join('');
  return `<div class="card-sw"><h4>${t('budget')} — Total = Discount + Commission; CompanyComm = IndivShare + Net; min 5% discount; uniform share; future activations only</h4>
  <table class="tbl"><tr><th>Scope</th><th>Allocation</th><th>Version (actor·time)</th></tr>${rows}</table>
  <div class="row g-2 mt-2" data-require="tenant_admin"><div class="col"><input id="nb-scope" class="form-control" placeholder="scopeId (partnerId)"></div><div class="col"><input id="nb-t" type="number" class="form-control" placeholder="Total %" value="20"></div><div class="col"><input id="nb-d" type="number" class="form-control" placeholder="Discount % (≥5)" value="10"></div><div class="col"><input id="nb-s" type="number" class="form-control" placeholder="Indiv share %" value="4"></div><div class="col-auto"><button class="btn btn-dark" id="nb-save">Save version</button></div></div></div>`;
}
function vMedia(){
  const sc=myScopePartnerIds(); let list=DB.media; if(sc) list=list.filter(m=>sc.includes(m.partnerId));
  const rows=list.map(m=>{const loc=m.locationId?(DB.locations.find(l=>l.id===m.locationId)||{}).name:'';return `<tr><td class="mono">${esc(m.code)}</td><td>${m.kind} ${esc(m.referrerId||loc||m.partnerId||'')}</td><td>${m.active&&!m.revoked?'active':'blocked'}</td>
  <td><a href="?view=microsite&r=${encodeURIComponent(m.code)}" target="_blank" rel="noopener" class="btn btn-sm btn-outline-dark">Open</a> <button class="btn btn-sm btn-outline-danger" data-mrev="${m.id}">Revoke/Replace</button> ${m.active?`<button class="btn btn-sm btn-outline-secondary" data-mblock="${m.id}">Block</button>`:''}</td></tr>`;}).join('');
  const locOpts=DB.locations.filter(l=>!sc||sc.includes(l.partnerId)).map(l=>`<option value="${l.id}">${esc(l.name)} (${esc(partnerName(l.partnerId))})</option>`).join('');
  return `<div class="card-sw"><h4>${t('media')} — persistent links + per-medium revocable id; personal QR ≠ NFC card; blocked stops new referrals, history kept</h4>
  <table class="tbl"><tr><th>Code</th><th>Attribution (company/location/affiliated/independent/medium)</th><th>Status</th><th></th></tr>${rows}</table>
  <div class="row g-2 mt-2" data-require="tenant_admin,platform_admin"><div class="col"><select id="nm-loc" class="form-select"><option value="">Company link (Saigon)</option>${locOpts}</select></div><div class="col-auto"><button class="btn btn-dark" id="nm-add">+ New link (real locations only)</button></div></div></div>`;
}
function vCards(){
  const sc=myScopePartnerIds(); let list=DB.cards; if(sc) list=list.filter(c=>sc.includes(c.partnerId));
  const rows=list.map(c=>`<tr><td class="mono">${c.id.slice(0,10)}</td><td>${esc(c.referrerId||'')}</td><td><span class="pill p-info">${c.status}</span> · ${esc(c.funding)}</td><td class="small">${(c.history||[]).map(h=>h.s+'@'+S.vnDisplay(h.at)).join(' → ')}</td>
  <td>${c.status==='requested'?`<button class="btn btn-sm btn-success" data-cact="approved" data-id="${c.id}">Approve</button> <button class="btn btn-sm btn-danger" data-cact="rejected" data-id="${c.id}">Reject</button>`:''}
  ${c.status==='approved'?`<button class="btn btn-sm btn-dark" data-cact="in_production" data-id="${c.id}">To production</button>`:''}
  ${c.status==='in_production'?`<button class="btn btn-sm btn-dark" data-cact="delivered" data-id="${c.id}">Delivered/Active</button>`:''}
  ${['delivered'].includes(c.status)?`<button class="btn btn-sm btn-outline-danger" data-cact="blocked" data-id="${c.id}">Block</button> <button class="btn btn-sm btn-outline-secondary" data-cact="replaced" data-id="${c.id}">Replaced</button>`:''}
  ${['blocked'].includes(c.status)?`<button class="btn btn-sm btn-outline-secondary" data-cact="replaced" data-id="${c.id}">Replaced</button>`:''}</td></tr>`).join('');
  return `<div class="card-sw"><h4>${t('cards')} — requested→approved→in_production→delivered/active (+rejected/blocked/replaced). Approval ≠ production. Funding: free/defect/charge_loss/charge_extra. No billing amounts in V1.</h4>
  <table class="tbl"><tr><th>Card</th><th>Referrer</th><th>Status</th><th>History (requester/approver/dates)</th><th></th></tr>${rows||'<tr><td colspan=5>none</td></tr>'}</table>
  <div class="row g-2 mt-2"><div class="col-md-3"><select id="nc-fund" class="form-select"><option value="free">Free standard</option><option value="defect">Free defect replacement</option><option value="charge_loss">Chargeable loss/damage</option><option value="charge_extra">Chargeable extra</option></select></div><div class="col-auto"><button class="btn btn-dark" id="nc-req">Request card (partner/referrer eligible)</button></div></div>
  <small class="text-muted">Card block never touches the personal digital QR (independent status). Referrer end blocks cards + stops personal media for new referrals; history + open obligations preserved.</small></div>`;
}
function latestSnap(m){
  const pid=m?m.partnerId:null; const b=[...DB.budgets].reverse().find(x=>x.scopeId===pid)||{discount:10,companyComm:10,indivShare:4,total:20};
  return {discountPct:b.discount,companyComm:b.companyComm||0,indivShare:b.indivShare||b.indivComm||0,indivComm:b.indivComm,total:b.total,budgetId:b.id};
}
function vSite(){
  const r=qs.get('r')||(DB.media[0]&&DB.media[0].code);
  const m=DB.media.find(x=>x.code===r)||DB.media[0];
  if(m&&!DB.events.find(e=>e.k==='open'&&e.code===m.code&&e.dev===deviceId)){DB.events.push({k:'open',code:m.code,at:S.vnNow(),dev:deviceId});save();}
  const lang=T.lang(DB); const hl=DB.services.filter(s=>s.hl).slice(0,6);
  const rest=DB.services.filter(s=>!s.hl);
  const coName=m?partnerName(m.partnerId):''; const locName=m&&m.locationId?((DB.locations.find(l=>l.id===m.locationId)||{}).name||''):'';
  const svcCard=s=>{const disc=Math.round(s.price*(latestSnap(m).discountPct||10)/100);
    return `<div class="col-md-4 mb-2"><div class="card-sw"><div class="svc-img" aria-label="service image">img</div><b>${esc(lang==='vi'?s.vi:s.en)}</b><div class="small">${s.dur} min · <s>${s.price.toLocaleString()}đ</s> → <b>${(s.price-disc).toLocaleString()}đ</b> (save ${disc.toLocaleString()}đ)</div></div></div>`;};
  return `<div class="ms-hero mb-3"><h3>Number160 ${lang==='vi'?'· Ưu đãi đối tác':'· Partner benefit'}</h3>
  <div>${esc(lang==='vi'?DB.site.hero_vi:DB.site.hero_en)} — ${esc(coName)}${locName?' · '+esc(locName):''}</div>
  <div class="small mt-1">${esc(lang==='vi'?DB.site.loc_vi:DB.site.loc_en)} · ${esc(lang==='vi'?DB.site.trust_vi:DB.site.trust_en)}</div>
  <div class="mt-2 d-flex gap-2 align-items-center flex-wrap"><button class="btn btn-light btn-sm" id="ms-lang">EN/VI</button> <span class="small">Voucher 7 days · must stay Active at booking + treatment · general discount, no service required · no stacking · ref ${esc(m?m.code:'')}</span>${DB.site.logo?`<img src="${esc(DB.site.logo)}" alt="partner logo" style="height:28px">`:''}</div></div>
  <div class="row">${hl.map(svcCard).join('')}</div>
  ${rest.length?`<details class="card-sw mt-2"><summary>All services &amp; prices (${rest.length} more)</summary><div class="row mt-2">${rest.map(svcCard).join('')}</div></details>`:''}
  <div class="card-sw mt-2"><h5>${lang==='vi'?'Kích hoạt voucher ẩn danh':'Activate anonymous voucher'}</h5>
  <p class="small">No name/email/phone/app. 7 days = activation + 7d (VN time). Stored in this browser; rescan same QR redisplays.</p>
  <button class="btn btn-dark" id="ms-activate">Activate voucher (${esc(m?m.code:'')})</button> ${DB.site.zalo?`<span class="small">Zalo ${esc(DB.site.zalo)}</span>`:''} ${DB.site.whatsapp?`<span class="small">WhatsApp ${esc(DB.site.whatsapp)}</span>`:''}
  <div class="mt-1 small">Prefill on booking: voucher ref · discount · expiry. No personal data auto-sent.</div>
  <div id="ms-out" class="mt-2"></div></div>`;
}
function vContent(){
  const rows=DB.services.map(s=>`<tr><td>${esc(s.en)} / ${esc(s.vi)}</td><td>${s.dur}m ${s.price.toLocaleString()}đ ${s.hl?'★':''}</td>
  <td><button class="btn btn-sm btn-outline-dark" data-hl="${s.id}">Toggle highlight</button> <button class="btn btn-sm btn-outline-danger" data-sdel="${s.id}">Del</button></td></tr>`).join('');
  return `<div class="card-sw" data-require="tenant_admin"><h4>${t('content')} — EN+VI required before publish; priority: stored → browser → EN; anonymous lang</h4>
  <table class="tbl"><tr><th>Service (EN/VI, image, benefit, duration, prices)</th><th>Meta</th><th></th></tr>${rows}</table>
  <div class="row g-2 mt-2"><div class="col"><input id="cs-en" class="form-control" placeholder="EN"></div><div class="col"><input id="cs-vi" class="form-control" placeholder="VI"></div><div class="col"><input id="cs-p" type="number" class="form-control" placeholder="price"></div><div class="col"><input id="cs-dur" type="number" class="form-control" placeholder="mins" value="60"></div><div class="col-auto"><button class="btn btn-dark" id="cs-add">Add</button></div></div>
  <div class="row g-2 mt-2"><div class="col"><input id="cs-zalo" class="form-control" placeholder="Zalo" value="${esc(DB.site.zalo||'')}"></div><div class="col"><input id="cs-wa" class="form-control" placeholder="WhatsApp" value="${esc(DB.site.whatsapp||'')}"></div><div class="col"><input id="cs-logo" class="form-control" placeholder="Logo URL (tenant-approved)" value="${esc(DB.site.logo||'')}"></div><div class="col-auto"><button class="btn btn-outline-dark" id="cs-contacts">Save contacts</button></div></div>
  <div class="mt-2">Published: <b>${DB.site.published}</b> <button class="btn btn-sm btn-dark" id="cs-pub">Toggle publish (blocks if incomplete)</button></div></div>`;
}
function vVouchers(){
  const sc=myScopePartnerIds();
  let list=DB.vouchers; if(sc) list=list.filter(v=>sc.includes(v.attribution&&v.attribution.company));
  const rows=list.slice(-30).reverse().map(v=>`<tr><td class="mono">${esc(v.ref)}<br><small>${esc(v.code)}</small></td><td>${v.status}<br><small>${remainingText(v.expiresAt)}</small></td><td class="mono small">exp ${S.vnDisplay(v.expiresAt)}</td><td class="small">${esc(v.contactPrefill||'')}</td></tr>`).join('');
  return `<div class="card-sw"><h4>${t('vouchers')} — unique QR + short ref; single-use; multi active allowed; immutable snapshot</h4>
  <table class="tbl"><tr><th>Voucher</th><th>Status</th><th>Expiry (VN)</th><th>Prefill</th></tr>${rows||'<tr><td colspan=4>none</td></tr>'}</table></div>`;
}
function vCounter(){
  return `<div class="card-sw"><h4>${t('counter')} — staff/manager only, online, browser scan never redeems, idempotent</h4>
  ${navigator.onLine?'':'<div class="alert alert-danger">'+t('offline')+'</div>'}
  <div class="row g-2"><div class="col"><input id="ct-code" class="form-control mono" placeholder="Voucher ref or code" autocomplete="off"></div><div class="col"><input id="ct-inv" type="number" class="form-control" placeholder="Invoice gross VND" min="0"></div><div class="col-auto"><button class="btn btn-dark" id="ct-check">${t('validate')}</button> <button class="btn btn-success" id="ct-redeem">${t('confirm_redeem')}</button></div></div>
  <div id="ct-out" class="mt-2"></div><small class="text-muted">Staff sees organization only — no referrer identity, no commission. Explicit confirmation required. Retries idempotent. No offline queue.</small></div>`;
}
function vTxns(){
  const sc=myScopePartnerIds();
  let list=DB.redemptions.slice().reverse();
  if(sc) list=list.filter(r=>{const v=DB.vouchers.find(x=>x.id===r.voucherId);return v&&sc.includes(v.attribution.company);});
  const rows=list.map(r=>{const v=DB.vouchers.find(x=>x.id===r.voucherId)||{};return `<tr><td class="mono small">${esc(v.ref||'')}<br>${r.id.slice(0,10)}</td><td class="mono">gross ${r.gross.toLocaleString()} → pay ${r.payable.toLocaleString()} (disc ${r.discount.toLocaleString()})<br><small>VAT ${r.vatAmt.toLocaleString()} net ${r.netNet.toLocaleString()} co ${r.coComm.toLocaleString()} ind ${r.indComm.toLocaleString()}</small></td><td>${r.voided?'<span class="pill p-pend">voided'+(r.voidReason?' · '+esc(r.voidReason):'')+'</span>':r.settlementId?'settled':'<span class="pill p-act">confirmed</span>'} ${esc(r.staff||'')}</td><td>${!r.voided&&can('manager160','tenant_admin')?`<button class="btn btn-sm btn-outline-danger" data-void="${r.id}">Void (reason)</button>`:''}</td></tr>`;}).join('');
  return `<div class="card-sw"><h4>${t('txns')} — manager void only w/ reason; reversal preserved; back to Active unless expired; blocked after Paid settlement</h4>
  <table class="tbl"><tr><th>Voucher/txn</th><th>Calc (inputs+outputs, VND ints)</th><th>State</th><th></th></tr>${rows||'<tr><td colspan=4>none</td></tr>'}</table>
  <button class="btn btn-outline-dark mt-2" id="tx-csv">CSV</button></div>`;
}
function vPayout(){
  const sc=myScopePartnerIds(); let list=DB.payouts; if(sc) list=list.filter(p=>sc.includes(p.ownerId)||(DB.referrers.find(r=>r.id===p.ownerId)||{}).partnerId&&sc.includes((DB.referrers.find(r=>r.id===p.ownerId)||{}).partnerId));
  const rows=list.map(p=>`<tr><td>${p.ownerType} ${esc(p.ownerId)}<br><b>${esc(p.beneficiary)}</b> ${esc(p.bank)} ${esc(p.account)}<br><small>changed ${esc(p.by||'')} ${p.at?S.vnDisplay(p.at):''}</small>${p.qr?`<br><img src="${esc(p.qr)}" alt="VietQR" style="height:64px">`:''}</td><td>${p.verified}</td>
  <td><button class="btn btn-sm btn-success" data-po="${p.id}">Verify</button> <button class="btn btn-sm btn-outline-dark" data-poedit="${p.id}">Change (resets to pending)</button></td></tr>`).join('');
  return `<div class="card-sw"><h4>${t('payout')} + VietQR — tenant verifies companies+independents, partner verifies affiliated; blocked until verified; manual pay w/ QR+amount+beneficiary; no money moves through Connect</h4>
  <table class="tbl"><tr><th>Profile (QR/beneficiary/bank/acct/changed/verif)</th><th>Status</th><th></th></tr>${rows||'<tr><td colspan=3>none</td></tr>'}</table>
  <div class="row g-2 mt-2"><div class="col"><input id="po-qr" class="form-control" placeholder="VietQR image URL (optional)"></div><div class="col"><input id="po-ben" class="form-control" placeholder="Beneficiary"></div><div class="col"><input id="po-bank" class="form-control" placeholder="Bank"></div><div class="col"><input id="po-acct" class="form-control" placeholder="Account"></div><div class="col-auto"><button class="btn btn-dark" id="po-add">Add profile</button></div></div></div>`;
}
function vSettle(){
  const open=DB.redemptions.filter(r=>!r.voided&&!r.settlementId);
  const rows=DB.settlements.map(s=>`<tr><td class="mono">${s.id.slice(0,10)} → ${esc(partnerName(s.recipientId))}</td><td class="mono">${s.amount.toLocaleString()} ${s.evidence==='with'?'with evidence':'WITHOUT evidence'}</td><td class="small">${S.vnDisplay(s.date)} by ${esc(s.payer)} ${esc(s.ref||'')} ${esc(s.note||'')}</td></tr>`).join('');
  const opts=open.map(r=>{const v=DB.vouchers.find(x=>x.id===r.voucherId)||{};return `<label class="d-block"><input type="checkbox" class="st-item" value="${r.id}"> ${r.id.slice(0,10)} · ${(r.coComm+r.indComm).toLocaleString()} VND · ${esc(v.ref||'')}</label>`;}).join('')||'no open items';
  return `<div class="card-sw"><h4>${t('settle')} — open item per confirmed txn; running balance; on-demand; immutable paid; partner may pay affiliated</h4>
  <div class="row"><div class="col"><b>${t('select_items')}</b>${opts}</div><div class="col"><input id="st-amt" type="number" class="form-control mb-1" placeholder="Paid amount (0 = auto-sum)"><input id="st-ref" class="form-control mb-1" placeholder="bank ref (opt)"><input id="st-note" class="form-control mb-1" placeholder="internal note (opt)"><select id="st-ev" class="form-select mb-1"><option value="with">Paid with evidence</option><option value="without">Paid without evidence</option></select><label class="d-block small mb-1"><input type="checkbox" id="st-conf"> Transfer completed — I confirm money moved manually (required)</label><button class="btn btn-dark" id="st-pay">${t('record_payment')}</button><div id="st-warn" class="small text-danger mt-1"></div></div></div>
  <table class="tbl mt-2"><tr><th>Settlement</th><th>Amount</th><th>Meta (payer/recipient/date)</th></tr>${rows||'<tr><td colspan=3>none</td></tr>'}</table></div>`;
}
function vReports(){
  return `<div class="card-sw"><h4>${t('reports')} — funnel + financials + drill-down; role CSV</h4>
  <div class="mono small mb-2">${funnelText()}</div>
  <div class="row g-2"><div class="col"><input id="rp-from" type="date" class="form-control"></div><div class="col"><input id="rp-to" type="date" class="form-control"></div><div class="col"><input id="rp-q" class="form-control" placeholder="partner / ref contains"></div><div class="col-auto"><button class="btn btn-dark" id="rp-run">Filter</button> <button class="btn btn-outline-dark" id="rp-csv">Export CSV</button></div></div>
  <div id="rp-out" class="mt-2 small"></div></div>`;
}
function vAudit(){
  const r=role();
  const sc=myScopePartnerIds();
  let list=[...DB.audits].reverse();
  if(r==='partner_admin'||r==='referrer'){ list=list.filter(a=>!a.internal); if(sc) list=list.filter(a=>!a.scope||a.scope==='tenant'||sc.includes(a.scope)); }
  const rows=list.slice(0,100).map(a=>`<tr><td class="mono small">${S.vnDisplay(a.ts)}</td><td>${esc(a.actor)} ${esc(a.action)}</td><td class="small">${esc(a.prev)} → ${esc(a.next)}</td><td>${esc(a.scope)}</td></tr>`).join('');
  return `<div class="card-sw"><h4>${t('audit')} — immutable; actor/ts/prev/next; ${(r==='partner_admin'||r==='referrer')?'partner sees only tenant decisions in scope':'internal sees all incl. notes/support/security'}. Preserved after end/block/paid.</h4>
  <table class="tbl"><tr><th>Time</th><th>Actor/action</th><th>Transition</th><th>Scope</th></tr>${rows}</table></div>`;
}
function vSettings(){
  const deps=[['Accounting sign-off (VAT/rounding/Net-Net)','open'],['Session/invite/reset/rate-limit/support design','partial — demo localStorage'],['Microsite URL/DNS/sync','open'],['Approved treatments/photos source','partial'],['VI editorial review','open'],['Counter device+connectivity test','partial'],['Named pilot users assigned','open']];
  return `<div class="card-sw"><h4>${t('settings')}</h4>
  <div class="row g-2"><div class="col"><label>VAT % (central, Net/Net calc)</label><input id="se-vat" type="number" class="form-control" value="${DB.settings.vat}"></div>
  <div class="col"><label>${t('lang')}</label><select id="se-lang" class="form-select"><option value="en">EN</option><option value="vi">VI</option></select></div>
  <div class="col-auto align-self-end"><button class="btn btn-dark" id="se-save">Save</button> <button class="btn btn-outline-danger" id="se-wipe">Reset demo DB</button></div></div>
  <hr><h6>Invite / reset (rate-limited, audited)</h6>
  <div class="row g-2"><div class="col"><input id="se-inv" class="form-control" placeholder="email to invite"></div><div class="col-auto"><button class="btn btn-outline-dark" id="se-invite">Invite</button> <button class="btn btn-outline-dark" id="se-reset">Reset link</button></div></div>
  <hr><h6>Production launch dependencies</h6><table class="tbl">${deps.map(d=>`<tr><td>${d[0]}</td><td>${d[1]}</td></tr>`).join('')}</table></div>`;
}

/* ---------- dossier ---------- */
function dossier(id){
  const p=DB.partners.find(x=>x.id===id); if(!p)return;
  const locs=DB.locations.filter(l=>l.partnerId===id), refs=DB.referrers.filter(r=>r.partnerId===id);
  const med=DB.media.filter(m=>m.partnerId===id);
  const vIds=DB.vouchers.filter(v=>med.map(m=>m.id).includes(v.mediaId)).map(v=>v.id);
  const reds=DB.redemptions.filter(r=>vIds.includes(r.voucherId)&&!r.voided);
  const paid=reds.filter(r=>r.settlementId).reduce((s,r)=>s+r.coComm+r.indComm,0);
  const open=reds.filter(r=>!r.settlementId).reduce((s,r)=>s+r.coComm+r.indComm,0);
  const hist=DB.audits.filter(a=>JSON.stringify(a).includes(id)).slice(-10);
  const html=`<b>${esc(p.name)}</b> · ${p.status} · ${esc(p.validFrom||'')}→${esc(p.validTo||'∞')}<br>
  <b>Relationship:</b> ${p.kind}/${esc(p.ptype||'')} owner ${esc(p.owner||'')} approver ${esc(p.approver||'')}<br>
  <b>Money:</b> co ${(reds.reduce((s,r)=>s+r.coComm,0)).toLocaleString()} VND · open ${open.toLocaleString()} · paid ${paid.toLocaleString()}<br>
  <b>People:</b> ${refs.map(r=>esc(r.name)+'('+r.status+')').join(', ')||'—'}<br>
  <b>Media:</b> ${med.map(m=>esc(m.code)+(m.active?'':' (blocked)')).join(', ')}<br>
  <b>Results:</b> ${vIds.length} activations · ${reds.length} redemptions<br>
  <b>History:</b> ${hist.map(h=>esc(h.action)).join(', ')||'—'}`;
  $('#dossierBody').html(html); new bootstrap.Modal('#dossierModal').show();
}

/* ---------- render ---------- */
function render(){
  const anonView=qs.get('view');
  if(anonView==='microsite'){renderShell(true);$('#view').html(vSite());bind();return;}
  if(!sessionValid()){renderLogin();return;}
  renderShell(false); permGate();
  const V={home:vHome,partners:vPartners,locations:vLocations,referrers:vReferrers,budget:vBudget,media:vMedia,cards:vCards,site:vSite,content:vContent,vouchers:vVouchers,counter:vCounter,txns:vTxns,payout:vPayout,settle:vSettle,reports:vReports,audit:vAudit,settings:vSettings};
  $('#view').html((V[VIEW]||vHome)());
  try{$('#funnel').text(funnelText());}catch(e){}
  try{$('#se-lang').val(localStorage.getItem('connect_lang')||DB.settings.lang||'en');}catch(e){}
  $('#supportBar').toggleClass('show',!!(DB.session&&DB.session.support));
  if(DB.session&&DB.session.support)$('#supportBar').text('SUPPORT ACCESS: '+DB.session.supportReason+' · '+DB.session.userId+' · audited');
  bind(); permGate();
}
function renderShell(anon){
  const u=me();
  document.getElementById('appShell').style.display='block';
  $('#sb-nav').html(anon?'':`
   <div class="nav-sec">Internal</div>
   <button class="ni ${VIEW==='home'?'active':''}" data-v="home">◉ ${t('home')}</button>
   <button class="ni ${VIEW==='txns'?'active':''}" data-v="txns">◉ ${t('txns')}</button>
   <button class="ni ${VIEW==='reports'?'active':''}" data-v="reports">◉ ${t('reports')}</button>
   <button class="ni ${VIEW==='audit'?'active':''}" data-v="audit">◉ ${t('audit')}</button>
   <div class="nav-sec">Partner</div>
   <button class="ni" data-v="partners">◉ ${t('partners')}</button>
   <button class="ni" data-v="locations">◉ ${t('locations')}</button>
   <button class="ni" data-v="referrers">◉ ${t('referrers')}</button>
   <button class="ni" data-v="budget">◉ ${t('budget')}</button>
   <button class="ni" data-v="media">◉ ${t('media')}</button>
   <button class="ni" data-v="cards">◉ ${t('cards')}</button>
   <div class="nav-sec">Customer</div>
   <button class="ni" data-v="site">◉ ${t('site')}</button>
   <button class="ni" data-v="vouchers">◉ ${t('vouchers')}</button>
   <button class="ni" data-v="counter">◉ ${t('counter')}</button>
   <div class="nav-sec">Money</div>
   <button class="ni" data-v="payout">◉ ${t('payout')}</button>
   <button class="ni" data-v="settle">◉ ${t('settle')}</button>
   <button class="ni" data-v="content">◉ ${t('content')}</button>
   <button class="ni" data-v="settings">◉ ${t('settings')}</button>`);
  $('#tb-user').html(anon?`<a class="btn btn-sm btn-dark" href="?">Staff login</a>`:`<span class="small mono">${esc(u?u.email:'')} · ${esc(role()||'')} · ${esc(DB.session.scope||'')}</span> <button class="btn btn-sm btn-outline-dark" id="btn-out">${t('signout')}</button> <button class="btn btn-sm btn-outline-dark" id="btn-lang">${T.lang(DB).toUpperCase()}</button> <button class="btn btn-sm btn-dark" id="btn-dark" aria-label="theme">◐</button>`);
}
function renderLogin(){
  const roles=['platform_admin','tenant_admin','manager160','staff160','partner_admin','referrer'];
  $('#appShell').show();
  $('#sb-nav').html(''); $('#tb-user').html(''); $('#supportBar').removeClass('show');
  $('#view').html(`<div class="row justify-content-center"><div class="col-md-5"><div class="card-sw">
   <h3>${t('signin')} · Connect</h3><p class="small text-muted">platform@sapawoo.vn / tenant@sapawoo.vn / manager@number160.vn / staff@number160.vn / partner@company.vn / referrer@company.vn</p>
   <label>${t('email')}</label><input id="li-email" class="form-control mb-2" value="tenant@sapawoo.vn" autocomplete="username">
   <label>${t('password')}</label><input id="li-pass" type="password" class="form-control mb-2" value="admin123" autocomplete="current-password">
   <label>${t('role')} (explicit — never inferred)</label><select id="li-role" class="form-select mb-2">${roles.map(r=>`<option>${r}</option>`).join('')}</select>
   <label>${t('support')}</label><input id="li-support" class="form-control mb-2" placeholder="${t('supportPh')}">
   <div id="li-err" class="alert alert-danger" style="display:none"></div>
   <button class="btn btn-dark w-100" id="li-go">${t('go')}</button>
   <div class="mt-2 small"><a href="?view=microsite&r=SAPAWO-AN-88">Open anonymous microsite →</a></div>
  </div></div></div>`);
  $('#li-go').off('click').on('click',doLogin);
  $('#li-pass').off('keydown').on('keydown',e=>{if(e.key==='Enter')doLogin();});
}

/* ---------- actions (all delegated with off→on to avoid double-binding) ---------- */
function bind(){
  const D=$(document);
  D.off('click','[data-v]').on('click','[data-v]',function(){VIEW=$(this).data('v');FILTER='';render();});
  D.off('click','[data-go]').on('click','[data-go]',function(){VIEW=$(this).data('go');render();});
  $('#btn-out').off('click').on('click',logout);
  $('#btn-lang').off('click').on('click',()=>{const n=T.lang(DB)==='en'?'vi':'en';T.setLang(n);DB.settings.lang=n;save();render();});
  $('#ms-lang').off('click').on('click',()=>{const n=T.lang(DB)==='en'?'vi':'en';T.setLang(n);DB.settings.lang=n;save();render();});
  $('#btn-dark').off('click').on('click',()=>document.body.classList.toggle('forest-dark'));
  D.off('input','#q').on('input','#q',function(){FILTER=$(this).val();const pos=this.selectionStart;vRefreshTableOnly();});
  function vRefreshTableOnly(){ if(VIEW!=='partners')return; const v=$('#view'); const keep=FILTER; renderKeepFocus(keep); }
  function renderKeepFocus(keep){ const html=vPartners(); $('#view').html(html); bind(); permGate(); const q=$('#q'); q.val(keep); q.focus(); try{q[0].setSelectionRange(q.val().length,q.val().length);}catch(e){} }
  // partners
  D.off('click','[data-new]').on('click','[data-new]',function(){
    if(!require('partner_create'))return;
    const kind=$(this).data('new'); const name=prompt(kind+' name?'); if(!name)return;
    const contact=prompt('Contact name (required)?'); if(!contact)return;
    const em=prompt('Email (or leave blank if phone):')||''; const ph=em?prompt('Phone (optional)')||'':prompt('Phone (required if no email):')||'';
    if(!em&&!ph){alert('Require email or telephone before activation');return;}
    const p={id:S.uid('p'),kind:kind==='company'?'company':'individual',name,ptype:kind==='company'?'Hotel':'independent',owner:DB.session.userId,contact,email:em,phone:ph,status:'onboarding',validFrom:new Date().toISOString().slice(0,10),validTo:'',note:''};
    DB.partners.push(p);S.audit(DB,DB.session.userId,'partner_create','',p.id+':'+name,'tenant',true);save();render();
  });
  D.off('click','[data-pact]').on('click','[data-pact]',function(){
    if(!require('partner_approve'))return;
    const p=DB.partners.find(x=>x.id===$(this).data('pact')); if(!p)return; const prev=p.status; const ns=$(this).data('s');
    if(ns==='active'&&p.kind==='company'){
      const locs=DB.locations.filter(l=>l.partnerId===p.id);
      const needsLoc=['Hotel','Restaurant','Spa'].includes(p.ptype||'Hotel');
      if(needsLoc&&!locs.length){alert('Require at least one physical location before activating this partner type');return;}
    }
    p.status=ns;
    if(ns==='active'){p.approver=DB.session.userId;p.approvedAt=S.vnNow();}
    S.audit(DB,DB.session.userId,'partner_'+ns,prev,ns,p.id,true);save();render();
  });
  D.off('click','[data-dossier]').on('click','[data-dossier]',function(){dossier($(this).data('dossier'));});
  $('#nl-add').off('click').on('click',()=>{
    if(!require('location_write'))return;
    const pid=$('#nl-p').val(); if(!pid){alert('Select company');return;}
    const ref=$('#nl-r').val()||'';
    if(ref){const r=DB.referrers.find(x=>x.id===ref); if(!r||r.partnerId!==pid){alert('Referrer must belong to selected company');return;}
      if(DB.locations.some(l=>l.referrerId===ref)){alert('Referrer already assigned to a current location');return;}}
    const l={id:S.uid('l'),partnerId:pid,name:$('#nl-n').val().trim()||'New site',address:$('#nl-a').val().trim(),ward:$('#nl-w').val().trim(),referrerId:ref||''};
    if(!l.name||!l.address||!l.ward){alert('Name + street + ward required (VN/Saigon context)');return;}
    DB.locations.push(l);S.audit(DB,DB.session.userId,'location_create','',l.id,pid,true);save();render();});
  D.off('click','[data-locdel]').on('click','[data-locdel]',function(){if(!require('location_write'))return;DB.locations=DB.locations.filter(x=>x.id!==$(this).data('locdel'));S.audit(DB,DB.session.userId,'location_delete',$(this).data('locdel'),'','tenant',true);save();render();});
  D.off('click','[data-ract]').on('click','[data-ract]',function(){
    const r=DB.referrers.find(x=>x.id===$(this).data('ract')); if(!r)return; const prev=r.status;const ns=$(this).data('s');
    if(ns==='approved'||ns==='rejected'){ if(!require('referrer_approve'))return; }
    if(ns==='rejected'){const reason=prompt('Partner-facing rejection reason (required):');if(!reason)return;const note=prompt('Internal note (optional):')||'';r.rejectReason=reason;r.rejectNoteInternal=note;}
    if(ns==='approved'&&r.kind==='affiliated'){
      const co=DB.partners.find(p=>p.id===r.partnerId); if(co)r.owner=co.owner;
      if(!DB.media.find(mm=>mm.referrerId===r.id&&mm.kind==='personal'))DB.media.push({id:S.uid('m'),kind:'personal',partnerId:r.partnerId,referrerId:r.id,code:'SAPAWO-'+r.name.slice(0,2).toUpperCase()+'-'+Math.random().toString(36).slice(2,6).toUpperCase(),active:true,revoked:false});
    }
    if(ns==='ended'){ if(!require('referrer_end'))return;
      DB.media.filter(mm=>mm.referrerId===r.id).forEach(mm=>{mm.active=false;}); // stop NEW personal referrals; history kept
      DB.cards.filter(c=>c.referrerId===r.id&&!['blocked','replaced'].includes(c.status)).forEach(c=>{c.status='blocked';c.history.push({s:'blocked',at:S.vnNow(),by:DB.session.userId});});
    }
    r.status=ns;S.audit(DB,DB.session.userId,'referrer_'+ns,prev,ns,r.partnerId,ns==='rejected'?false:true,ns==='rejected'?('reason: '+(r.rejectReason||'')): '');save();render();
  });
  $('#nr-aff').off('click').on('click',()=>{
    if(!require('referrer_submit'))return;
    const name=prompt('Affiliated name?');if(!name)return;
    const pid=(DB.session.scope&&DB.session.scope.startsWith('p_'))?DB.session.scope:'p_saigon';
    const co=DB.partners.find(p=>p.id===pid);
    DB.referrers.push({id:S.uid('r'),kind:'affiliated',name,rtype:'Staff',affiliation:'employed',partnerId:pid,owner:co?co.owner:DB.session.userId,status:'pending',phone:'',position:''});
    S.audit(DB,DB.session.userId,'referrer_submit','',name,pid,true);save();render();});
  $('#nb-save').off('click').on('click',()=>{
    if(!require('budget_write'))return;
    const scope=$('#nb-scope').val().trim()||'p_saigon';const tot=+$('#nb-t').val(),d=+$('#nb-d').val(),s=+$('#nb-s').val();
    if(!(tot>0)||d<5){alert('min 5% discount, total>0');return;}
    if(d>=tot){alert('Discount must be < Total');return;}
    const isInd=(DB.partners.find(p=>p.id===scope)||{}).kind==='individual';
    let rec;
    if(isInd){ if(d+s!==tot){alert('Independent: Discount + IndividualCommission must = Total, no remainder');return;} rec={id:S.uid('b'),scopeId:scope,total:tot,discount:d,indivComm:s,by:DB.session.userId,at:S.vnNow(),futureOnly:true};}
    else{ const net=tot-d-s; if(net<0){alert('Company: Discount + IndivShare exceeds Total');return;} rec={id:S.uid('b'),scopeId:scope,total:tot,discount:d,companyComm:tot-d,indivShare:s,companyNet:net,by:DB.session.userId,at:S.vnNow(),futureOnly:true};}
    DB.budgets.push(rec);S.audit(DB,DB.session.userId,'budget_version','',rec,scope,true);save();render();});
  $('#nm-add').off('click').on('click',()=>{
    if(!require('media_write'))return;
    const locId=$('#nm-loc').val()||'';
    if(locId&&!DB.locations.find(l=>l.id===locId)){alert('Location must be real/existing');return;}
    const code='SAPAWO-'+Math.random().toString(36).slice(2,7).toUpperCase();
    const loc=locId?DB.locations.find(l=>l.id===locId):null;
    DB.media.push({id:S.uid('m'),kind:loc?'location':'company',partnerId:loc?loc.partnerId:'p_saigon',locationId:locId||undefined,code,active:true,revoked:false});
    S.audit(DB,DB.session.userId,'media_create','',code,loc?loc.partnerId:'p_saigon',true);save();render();});
  D.off('click','[data-mrev]').on('click','[data-mrev]',function(){if(!require('media_write'))return;const m=DB.media.find(x=>x.id===$(this).data('mrev'));if(!m)return;m.revoked=true;m.active=false;const nm={id:S.uid('m'),kind:m.kind,partnerId:m.partnerId,referrerId:m.referrerId,locationId:m.locationId,code:m.code+'-R2',active:true,revoked:false};DB.media.push(nm);S.audit(DB,DB.session.userId,'media_replace',m.code,nm.code,m.partnerId,true);save();render();});
  D.off('click','[data-mblock]').on('click','[data-mblock]',function(){if(!require('media_write'))return;const m=DB.media.find(x=>x.id===$(this).data('mblock'));if(!m)return;m.active=false;S.audit(DB,DB.session.userId,'media_block',m.code,'blocked',m.partnerId,true);save();render();});
  $('#nc-req').off('click').on('click',()=>{
    if(!require('card_request'))return;
    const funding=$('#nc-fund').val()||'free';
    const c={id:S.uid('c'),partnerId:(DB.session.scope&&DB.session.scope.startsWith('p_'))?DB.session.scope:'p_saigon',referrerId:role()==='referrer'?DB.session.scope:'r_an',status:'requested',funding,requester:DB.session.userId,history:[{s:'requested',at:S.vnNow(),by:DB.session.userId}]};DB.cards.push(c);S.audit(DB,DB.session.userId,'card_request','',c.id,c.partnerId,true);save();render();});
  D.off('click','[data-cact]').on('click','[data-cact]',function(){
    const c=DB.cards.find(x=>x.id===$(this).data('id')); if(!c)return; const prev=c.status; const ns=$(this).data('cact');
    const order={requested:['approved','rejected'],approved:['in_production'],in_production:['delivered'],delivered:['blocked','replaced'],blocked:['replaced']};
    if(!(order[prev]||[]).includes(ns)){alert('Illegal transition '+prev+' → '+ns);return;}
    if(['approved','in_production','delivered','blocked','replaced'].includes(ns)&&!require('card_approve'))return;
    c.status=ns;c.history.push({s:ns,at:S.vnNow(),by:DB.session.userId});if(ns==='approved')c.approver=DB.session.userId;
    S.audit(DB,DB.session.userId,'card_'+ns,prev,ns,c.partnerId,true);save();render();});
  // microsite activate (backend-first, local fallback)
  $('#ms-activate').off('click').on('click',()=>{
    const code=(qs.get('r')||(DB.media[0]&&DB.media[0].code));
    if(API&&API.reachable()){
      API.activateVoucher(code,deviceId,false).then(v=>{ save(); showVoucher(v,!!v.existing); pullSnapshot().catch(()=>{}); })
      .catch(err=>{ $('#ms-out').html('<div class="alert alert-danger">'+esc(err.message)+'</div>'); });
      return;
    }
    const m=DB.media.find(x=>x.code===code);
    if(!m||!m.active||m.revoked){$('#ms-out').html('<div class="alert alert-danger">Referral blocked — no new vouchers. History preserved.</div>');return;}
    const rq=m.referrerId?DB.referrers.find(r=>r.id===m.referrerId):null; if(rq&&rq.status!=='approved'){$('#ms-out').html('<div class="alert alert-danger">Referrer not approved — referral pending.</div>');return;}
    const p=m.partnerId?DB.partners.find(x=>x.id===m.partnerId):null; if(p&&p.status!=='active'){$('#ms-out').html('<div class="alert alert-danger">Partner inactive.</div>');return;}
    if(p&&p.validTo&&p.validTo<new Date().toISOString().slice(0,10)){$('#ms-out').html('<div class="alert alert-danger">Partner relationship ended.</div>');return;}
    createVoucher(m,false);
  });
  D.off('click','#ms-new').on('click','#ms-new',()=>{const code=(qs.get('r')||DB.media[0].code);
    if(API&&API.reachable()){ API.activateVoucher(code,deviceId,true).then(v=>showVoucher(v,false)).catch(e=>alert(e.message)); return; }
    const m=DB.media.find(x=>x.code===code);if(m)createVoucher(m,true);});
  function createVoucher(m,force){
    if(!force){
      const prior=DB.vouchers.find(v=>v.mediaId===m.id&&v.deviceId===deviceId&&v.status==='active'&&new Date(v.expiresAt)>new Date());
      if(prior){showVoucher(prior,true);return;}
    }
    const snap=latestSnap(m); const ref=Math.random().toString(36).slice(2,7).toUpperCase();
    const at=new Date(); const exp=new Date(at.getTime()+7*24*3600*1000);
    const v={id:S.uid('v'),code:'V-'+ref,ref,mediaId:m.id,attribution:{company:m.partnerId,location:m.locationId||null,affiliated:m.kind==='personal'?m.referrerId:null,independent:m.partnerId&&((DB.partners.find(p=>p.id===m.partnerId)||{}).kind==='individual')?m.partnerId:null,medium:m.id},snapshot:snap,status:'active',activatedAt:at.toISOString(),expiresAt:exp.toISOString(),deviceId,contactPrefill:`Voucher ${ref} · ${snap.discountPct}% · exp ${S.vnDisplay(exp.toISOString())}`};
    DB.vouchers.push(v);S.audit(DB,'anonymous','voucher_activate','',ref,m.partnerId,false);save();showVoucher(v,false);
  }
  function showVoucher(v,existing){
    const holder=$('#ms-out');
    holder.html(`<div class="voucher-print"><h5>Number160 · ${v.status==='active'?'Active':'Used/Expired'} voucher ${existing?'(already on this device)':''}</h5><div class="d-flex gap-3 flex-wrap"><div class="qrbox">${esc(v.code)}<br>${esc(v.ref)}</div><div>Discount ${v.snapshot.discountPct}%<br>Exp ${S.vnDisplay(v.expiresAt)} (VN)<br><span class="badge bg-success">${esc(remainingText(v.expiresAt))}</span><br><span class="small">Save screenshot — stored in this browser only. Single-use, no stacking. Must be Active at booking + treatment. Expired vouchers cannot be used.</span><div class="mt-2 d-flex gap-1 flex-wrap"><button class="btn btn-sm btn-dark" id="v-save">Save Voucher</button> <button class="btn btn-sm btn-outline-dark" id="v-dl">Download image</button> <button class="btn btn-sm btn-outline-dark" id="v-share">Share</button> <button class="btn btn-sm btn-outline-secondary" id="ms-new">${t('new_voucher')}</button> <a class="btn btn-sm btn-success" href="?">Continue to Voucher</a></div></div></div></div>`);
    $('#v-save').off('click').on('click',()=>{try{localStorage.setItem('connect_saved_'+v.ref,JSON.stringify(v));alert('Voucher saved in this browser');}catch(e){alert(v.ref);}});
    $('#v-dl').off('click').on('click',()=>{const c=document.createElement('canvas');c.width=360;c.height=220;const x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,360,220);x.fillStyle='#000';x.font='28px monospace';x.fillText(v.code,40,90);x.fillText(v.ref,40,130);x.font='16px monospace';x.fillText('exp '+S.vnDisplay(v.expiresAt),40,165);const a=document.createElement('a');a.download=v.ref+'.png';a.href=c.toDataURL();a.click();});
    $('#v-share').off('click').on('click',()=>{if(navigator.share)navigator.share({title:'Voucher '+v.ref,text:v.contactPrefill}).catch(()=>{});else if(navigator.clipboard)navigator.clipboard.writeText(v.contactPrefill);else alert('Copy: '+v.ref);});
  }
  // content
  $('#cs-add').off('click').on('click',()=>{if(!require('content_write'))return;DB.services.push({id:S.uid('s'),en:$('#cs-en').val().trim()||'New',vi:$('#cs-vi').val().trim()||'Mới',dur:+$('#cs-dur').val()||60,price:+$('#cs-p').val()||500000,img:'',hl:false});S.audit(DB,DB.session.userId,'content_add','',DB.services[DB.services.length-1].id,'tenant',true);save();render();});
  D.off('click','[data-hl]').on('click','[data-hl]',function(){if(!require('content_write'))return;const s=DB.services.find(x=>x.id===$(this).data('hl'));if(s)s.hl=!s.hl;save();render();});
  D.off('click','[data-sdel]').on('click','[data-sdel]',function(){if(!require('content_write'))return;DB.services=DB.services.filter(x=>x.id!==$(this).data('sdel'));save();render();});
  $('#cs-contacts').off('click').on('click',()=>{if(!require('content_write'))return;DB.site.zalo=$('#cs-zalo').val().trim();DB.site.whatsapp=$('#cs-wa').val().trim();DB.site.logo=$('#cs-logo').val().trim();DB.site.published=false;S.audit(DB,DB.session.userId,'content_contacts','','saved','tenant',true);save();render();});
  $('#cs-pub').off('click').on('click',()=>{if(!require('content_write'))return;const bad=DB.services.filter(s=>!s.en||!s.vi);if(bad.length||!DB.site.hero_en||!DB.site.hero_vi||!DB.site.trust_en||!DB.site.trust_vi||!DB.site.zalo){alert('Complete EN+VI (services, hero, trust, contacts) before publish');return;}DB.site.published=!DB.site.published;S.audit(DB,DB.session.userId,'content_publish','',String(DB.site.published),'tenant',true);save();render();});
  // counter
  function counterVerdict(html){$('#ct-out').html(html);}
  $('#ct-check').off('click').on('click',()=>{
    if(!DB.session){counterVerdict('<div class="alert alert-danger">Staff/Manager login required.</div>');return;}
    if(!navigator.onLine){counterVerdict('<div class="alert alert-danger">'+t('offline')+'</div>');return;}
    const code=$('#ct-code').val().trim(); if(!code){counterVerdict('<div class="alert alert-danger">'+t('invalid')+'</div>');return;}
    if(API&&API.reachable()&&API.token()){
      API.validate(code).then(d=>{
        if(d.verdict==='valid') counterVerdict(`<div class="alert alert-success">${t('valid')} ✓ ${esc(d.partner||'')} · discount ${d.discountPct}% · exp ${S.vnDisplay(d.expiresAt)}. Staff sees org only. (server)</div>`);
        else counterVerdict(`<div class="alert alert-warning">${esc(d.verdict)}</div>`);
      }).catch(e=>counterVerdict('<div class="alert alert-danger">'+esc(e.message)+'</div>'));
      return;
    }
    const v=DB.vouchers.find(x=>x.ref===code||x.code===code);
    if(!v){counterVerdict('<div class="alert alert-danger">'+t('invalid')+'</div>');return;}
    if(v.status==='used'){counterVerdict('<div class="alert alert-warning">'+t('used')+'</div>');return;}
    if(new Date(v.expiresAt)<new Date()||v.status==='expired'){counterVerdict('<div class="alert alert-warning">'+t('expired')+' — cannot be used</div>');return;}
    counterVerdict(`<div class="alert alert-success">${t('valid')} ✓ ${esc(partnerName(v.attribution.company))} · discount ${v.snapshot.discountPct}% · exp ${S.vnDisplay(v.expiresAt)} · ${esc(remainingText(v.expiresAt))}. Staff sees org only.</div>`);
  });
  $('#ct-redeem').off('click').on('click',()=>{
    if(!require('counter_redeem')){counterVerdict('<div class="alert alert-danger">Staff/Manager login required, online only. No offline queue.</div>');return;}
    if(!navigator.onLine){counterVerdict('<div class="alert alert-danger">'+t('offline')+'</div>');return;}
    const code=$('#ct-code').val().trim();const gross=Math.round(+$('#ct-inv').val()||0);
    if(API&&API.reachable()&&API.token()){
      API.redeem(code,gross).then(r=>{
        counterVerdict(`<div class="alert alert-success">Redeemed (server): gross ${r.gross.toLocaleString()} − disc ${r.discount.toLocaleString()} = pay ${r.payable.toLocaleString()} · VAT ${r.vatAmt.toLocaleString()} · net ${r.netNet.toLocaleString()}</div>`);
        pullSnapshot().catch(()=>{});
      }).catch(e=>counterVerdict('<div class="alert alert-danger">'+esc(e.message)+'</div>'));
      return;
    }
    if(gross<=0){counterVerdict('<div class="alert alert-danger">Enter invoice gross &gt; 0</div>');return;}
    const v=DB.vouchers.find(x=>x.ref===code||x.code===code); if(!v||v.status!=='active'){counterVerdict('<div class="alert alert-danger">Not redeemable (idempotent — no double spend)</div>');return;}
    if(new Date(v.expiresAt)<new Date()){v.status='expired';save();counterVerdict('<div class="alert alert-warning">'+t('expired')+'</div>');return;}
    if(DB.redemptions.find(r=>r.voucherId===v.id&&!r.voided)){counterVerdict('<div class="alert alert-warning">Already redeemed (idempotent)</div>');return;}
    const c=S.calc(DB,gross,v.snapshot);
    const r={id:S.uid('r'),voucherId:v.id,...c,staff:DB.session.userId,ts:S.vnNow(),voided:false};
    DB.redemptions.push(r);v.status='used';S.audit(DB,DB.session.userId,'redeem',v.ref,{gross:c.gross,pay:c.payable,net:c.netNet},v.attribution.company,false);save();
    counterVerdict(`<div class="alert alert-success">Redeemed: gross ${c.gross.toLocaleString()} − disc ${c.discount.toLocaleString()} = pay ${c.payable.toLocaleString()} · VAT ${c.vatAmt.toLocaleString()} · net ${c.netNet.toLocaleString()}</div>`);
  });
  D.off('click','[data-void]').on('click','[data-void]',function(){
    if(!require('void'))return;
    const r=DB.redemptions.find(x=>x.id===$(this).data('void')); if(!r)return;
    if(r.settlementId){alert('In Paid settlement — corrections outside standard V1');return;}
    const reason=prompt('Void reason (required):'); if(!reason)return;
    const prev={voided:false};
    r.voided=true;r.voidReason=reason;r.voidBy=DB.session.userId;r.voidAt=S.vnNow();
    r.reversal={ts:r.voidAt,by:r.voidBy,reason}; // preserve original + reversal, never overwrite
    const v=DB.vouchers.find(x=>x.id===r.voucherId);
    if(v){ v.status=new Date(v.expiresAt)<new Date()?'expired':'active'; }
    S.audit(DB,DB.session.userId,'void',r.id,reason,'tenant',true);save();render();
  });
  $('#tx-csv').off('click').on('click',()=>{
    const sc=myScopePartnerIds();
    let list=DB.redemptions; if(sc) list=list.filter(r=>{const v=DB.vouchers.find(x=>x.id===r.voucherId);return v&&sc.includes(v.attribution.company);});
    csv('transactions.csv',[['id','voucher','gross','discount','payable','vat','netNet','coComm','indComm','staff','voided','settlement'],...list.map(r=>{const v=DB.vouchers.find(x=>x.id===r.voucherId)||{};[r.id,v.ref,r.gross,r.discount,r.payable,r.vatAmt,r.netNet,r.coComm,r.indComm,r.staff,r.voided,r.settlementId||''];})]);});
  D.off('click','[data-po]').on('click','[data-po]',function(){
    const p=DB.payouts.find(x=>x.id===$(this).data('po')); if(!p)return;
    const isAffil=p.ownerType==='affiliated';
    if(isAffil){ if(!require('payout_verify_affil'))return; if(!(role()==='partner_admin'||role()==='tenant_admin'))return; }
    else if(!require('payout_verify_company'))return;
    p.verified='verified';p.by=DB.session.userId;p.at=S.vnNow();S.audit(DB,DB.session.userId,'payout_verify','pending','verified',p.ownerId,true);save();render();});
  D.off('click','[data-poedit]').on('click','[data-poedit]',function(){const p=DB.payouts.find(x=>x.id===$(this).data('poedit'));if(!p)return;const b=prompt('New account?',p.account);if(!b)return;p.account=b;p.verified='pending';p.by=DB.session.userId;p.at=S.vnNow();S.audit(DB,DB.session.userId,'payout_change','verified','pending',p.ownerId,true);save();render();});
  $('#po-add').off('click').on('click',()=>{
    const ben=$('#po-ben').val().trim(),bank=$('#po-bank').val().trim(),acct=$('#po-acct').val().trim();
    if(!ben||!bank||!acct){alert('Beneficiary + bank + account required');return;}
    DB.payouts.push({id:S.uid('po'),ownerType:'company',ownerId:'p_saigon',bank,account:acct,beneficiary:ben,qr:$('#po-qr').val().trim(),verified:'pending',by:DB.session.userId,at:S.vnNow()});
    S.audit(DB,DB.session.userId,'payout_create','',acct,'tenant',true);save();render();});
  $('#st-pay').off('click').on('click',()=>{
    if(!can('tenant_admin','partner_admin')){alert('Tenant or Partner admin required');return;}
    const ids=$('.st-item:checked').map(function(){return $(this).val();}).get();
    if(!ids.length){alert('select items');return;}
    if(!$('#st-conf').is(':checked')){$('#st-warn').text('Transfer-completed confirmation required');return;}
    const firstR=DB.redemptions.find(r=>r.id===ids[0]); const firstV=DB.vouchers.find(v=>v.id===firstR.voucherId);
    const comp=firstV?firstV.attribution.company:'';
    if(!ids.every(id=>{const r=DB.redemptions.find(x=>x.id===id);const v=DB.vouchers.find(x=>x.id===r.voucherId);return v&&v.attribution.company===comp;})){alert('Settle one recipient at a time');return;}
    const prof=DB.payouts.find(p=>p.ownerId===comp||ids.some(id=>{const r=DB.redemptions.find(x=>x.id===id);const v=DB.vouchers.find(x=>x.id===r.voucherId);return p.ownerId===(v.attribution.affiliated||v.attribution.independent||'');}));
    if(prof&&prof.verified!=='verified'){$('#st-warn').text('Blocked: payout profile '+prof.ownerId+' is '+prof.verified);return;}
    const coProf=DB.payouts.find(p=>p.ownerId===comp); if(coProf&&coProf.verified!=='verified'){$('#st-warn').text('Blocked: company payout profile unverified');return;}
    const sum=ids.reduce((s,id)=>{const r=DB.redemptions.find(x=>x.id===id);return s+r.coComm+r.indComm;},0);
    const amt=Math.round(+$('#st-amt').val()||sum);
    const s={id:S.uid('st'),items:ids,amount:amt,date:S.vnNow(),payer:DB.session.userId,recipientId:comp,ref:$('#st-ref').val().trim()||'',note:$('#st-note').val().trim()||'',evidence:$('#st-ev').val()==='with'?'with':'without'};
    Object.freeze(s.items);
    DB.settlements.push(s); ids.forEach(id=>{DB.redemptions.find(r=>r.id===id).settlementId=s.id;});
    S.audit(DB,DB.session.userId,'settlement_paid','',s.id+':'+amt,comp,true);save();render();
  });
  function voucherCompany(redId){const r=DB.redemptions.find(x=>x.id===redId);const v=r&&DB.vouchers.find(x=>x.id===r.voucherId);return v?v.attribution.company:'';}
  function filteredRedemptions(){
    const sc=myScopePartnerIds();
    let list=DB.redemptions.filter(r=>!r.voided);
    if(sc) list=list.filter(r=>{const v=DB.vouchers.find(x=>x.id===r.voucherId);return v&&sc.includes(v.attribution.company);});
    const q=($('#rp-q').val()||'').toLowerCase(), f=$('#rp-from').val(), tt=$('#rp-to').val();
    if(f) list=list.filter(r=>r.ts&&r.ts.slice(0,10)>=f);
    if(tt) list=list.filter(r=>r.ts&&r.ts.slice(0,10)<=tt);
    if(q) list=list.filter(r=>{const v=DB.vouchers.find(x=>x.id===r.voucherId)||{};return (voucherCompany(r.id)+' '+(v.ref||'')).toLowerCase().includes(q);});
    return list;
  }
  $('#rp-run').off('click').on('click',()=>{
    const list=filteredRedemptions();
    const rev=list.reduce((s,r)=>s+r.gross,0),disc=list.reduce((s,r)=>s+r.discount,0),pay=list.reduce((s,r)=>s+r.payable,0),vat=list.reduce((s,r)=>s+r.vatAmt,0),net=list.reduce((s,r)=>s+r.netNet,0),com=list.reduce((s,r)=>s+r.coComm+r.indComm,0);
    $('#rp-out').html(`events: ${list.length} redemptions · gross ${rev.toLocaleString()} · discount ${disc.toLocaleString()} · payable ${pay.toLocaleString()} · VAT ${vat.toLocaleString()} · net ${net.toLocaleString()} · commission ${com.toLocaleString()}`);});
  $('#rp-csv').off('click').on('click',()=>{
    const list=filteredRedemptions();
    csv('report.csv',[['id','voucher','gross','discount','payable','vat','netNet','coComm','indComm','open/paid','ts'],...list.map(r=>{const v=DB.vouchers.find(x=>x.id===r.voucherId)||{};[r.id,v.ref,r.gross,r.discount,r.payable,r.vatAmt,r.netNet,r.coComm,r.indComm,r.settlementId?'paid':'open',r.ts];})]);
    $('#rp-out').text('exported (role + scope + date filtered)');});
  $('#se-save').off('click').on('click',()=>{if(!require('settings'))return;DB.settings.vat=Math.round(+$('#se-vat').val()||8);const l=$('#se-lang').val();T.setLang(l);DB.settings.lang=l;S.audit(DB,DB.session.userId,'settings','','vat '+DB.settings.vat,'tenant',true);save();render();});
  $('#se-wipe').off('click').on('click',()=>{if(!require('settings'))return;if(!confirm('Reset demo DB?'))return;localStorage.removeItem(S.KEY);DB=S.seed();save();render();});
  $('#se-invite').off('click').on('click',()=>{const e=$('#se-inv').val().trim();if(!e)return;DB.invites.push({email:e,by:DB.session.userId,at:S.vnNow(),token:S.uid('tok')});S.audit(DB,DB.session.userId,'invite','',e,'tenant',true);save();alert('invite recorded (token issued, acceptance flow is out-of-scope for local demo)');});
  $('#se-reset').off('click').on('click',()=>{const e=$('#se-inv').val().trim();if(!e)return;DB.resets.push({email:e,at:S.vnNow(),token:S.uid('rst'),exp:new Date(Date.now()+3600e3).toISOString()});S.audit(DB,DB.session.userId,'reset','',e,'tenant',true);save();alert('reset link recorded (1h expiry, single-use in production)');});
}
render();
});
