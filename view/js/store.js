/* CONNECT store · localStorage techstack — single source of truth */
(function(g){
const KEY='connect_db_v1';
const $=g.jQuery;
function uid(p){ try{ if(window.crypto&&crypto.randomUUID) return (p||'id')+'_'+crypto.randomUUID().slice(0,8);}catch(e){} return (p||'id')+'_'+Math.random().toString(36).slice(2,8)+Date.now().toString(36).slice(-4); }
function vnNow(){return new Date().toISOString();}
function vnDisplay(iso){ try{ return new Date(iso).toLocaleString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});}catch(e){return iso;} }
function seed(){
  if(localStorage.getItem(KEY)) return load();
  const db={
    users:[
      {id:'u_platform',email:'platform@sapawoo.vn',pass:'admin123',name:'Platform Admin',roles:['platform_admin'],active:true},
      {id:'u_tenant',email:'tenant@sapawoo.vn',pass:'admin123',name:'Tenant Admin',roles:['tenant_admin'],active:true},
      {id:'u_mgr',email:'manager@number160.vn',pass:'staff123',name:'Number160 Manager',roles:['manager160'],active:true},
      {id:'u_staff',email:'staff@number160.vn',pass:'staff123',name:'Number160 Staff',roles:['staff160'],active:true},
      {id:'u_partner',email:'partner@company.vn',pass:'partner123',name:'Partner Admin (Saigon Eats)',roles:['partner_admin'],partnerId:'p_saigon',active:true},
      {id:'u_ref',email:'referrer@company.vn',pass:'ref123',name:'An Nguyen (Referrer)',roles:['referrer'],referrerId:'r_an',active:true}
    ],
    invites:[], resets:[], attempts:{}, session:null,
    partners:[
      {id:'p_saigon',kind:'company',name:'Saigon Eats Co.',ptype:'Hotel',owner:'u_tenant',contact:'Linh Tran',email:'hello@saigoneats.vn',phone:'0901234567',status:'active',approver:'u_tenant',approvedAt:vnNow(),validFrom:'2026-01-01',validTo:'2027-01-01',note:'Pilot partner'},
      {id:'p_ind1',kind:'individual',name:'Independent: Minh Chau',ptype:'independent',owner:'u_tenant',contact:'Minh Chau',email:'',phone:'0912345678',status:'active',approver:'u_tenant',approvedAt:vnNow(),validFrom:'2026-02-01',validTo:'',note:''}
    ],
    locations:[{id:'l_1',partnerId:'p_saigon',name:'Saigon Eats D1',address:'160 Dong Khoi',ward:'Ben Nghe, D1',referrerId:'r_an'}],
    referrers:[
      {id:'r_an',kind:'affiliated',name:'An Nguyen',rtype:'Concierge',affiliation:'employed',partnerId:'p_saigon',locationId:'l_1',owner:'u_tenant',email:'',phone:'0909998888',position:'Concierge (role, not location)',status:'approved',note:''},
      {id:'r_ind1',kind:'independent',name:'Minh Chau',rtype:'KOL',affiliation:'independent',partnerId:'p_ind1',owner:'u_tenant',status:'approved',phone:'0912345678'}
    ],
    budgets:[{id:'b_1',scopeId:'p_saigon',total:20,discount:10,companyComm:10,indivShare:4,companyNet:6,by:'u_tenant',at:vnNow(),futureOnly:true},
             {id:'b_2',scopeId:'p_ind1',total:20,discount:10,indivComm:10,by:'u_tenant',at:vnNow(),futureOnly:true}],
    media:[
      {id:'m_co',kind:'company',partnerId:'p_saigon',code:'SAPAWO-CO-SAIGON',active:true,revoked:false},
      {id:'m_loc',kind:'location',partnerId:'p_saigon',locationId:'l_1',code:'SAPAWO-LOC-D1',active:true,revoked:false},
      {id:'m_an',kind:'personal',partnerId:'p_saigon',referrerId:'r_an',code:'SAPAWO-AN-88',active:true,revoked:false}
    ],
    cards:[{id:'c_1',partnerId:'p_saigon',referrerId:'r_an',status:'delivered',funding:'free',requester:'u_partner',approver:'u_tenant',history:[{s:'requested',at:vnNow(),by:'u_partner'},{s:'approved',at:vnNow(),by:'u_tenant'},{s:'delivered',at:vnNow(),by:'u_tenant'}]}],
    services:[
      {id:'s1',en:'Signature Body Massage 60m',vi:'Massage body đặc trưng 60p',dur:60,price:850000,img:'',hl:true},
      {id:'s2',en:'Deep Tissue 90m',vi:'Massage sâu 90p',dur:90,price:1200000,img:'',hl:true},
      {id:'s3',en:'Facial Glow 60m',vi:'Chăm sóc da 60p',dur:60,price:950000,img:'',hl:true},
      {id:'s4',en:'Foot Ritual 45m',vi:'Liệu trình chân 45p',dur:45,price:550000,img:'',hl:true},
      {id:'s5',en:'Hot Stone 75m',vi:'Đá nóng 75p',dur:75,price:1100000,img:'',hl:false}
    ],
    site:{logo:'',zalo:'0901600160',whatsapp:'+84901600160',trust_en:'Licensed therapists · Hygienic · Since 2016',trust_vi:'KTV chuyên nghiệp · Vệ sinh · Từ 2016',loc_en:'160 Dong Khoi, D1, HCMC',loc_vi:'160 Đồng Khởi, Q1, TP.HCM',published:true,
      hero_en:'Exclusive member benefit via our partner',hero_vi:'Ưu đãi độc quyền qua đối tác'},
    vouchers:[], redemptions:[], payouts:[
      {id:'po_co',ownerType:'company',ownerId:'p_saigon',bank:'Vietcombank',account:'0071001234567',beneficiary:'SAIGON EATS CO',qr:'',verified:'verified',by:'u_tenant',at:vnNow()},
      {id:'po_an',ownerType:'affiliated',ownerId:'r_an',bank:'Techcombank',account:'19012345678',beneficiary:'NGUYEN VAN AN',qr:'',verified:'verified',by:'u_partner',at:vnNow()}
    ],
    settlements:[], audits:[{id:uid('a'),ts:vnNow(),actor:'system',action:'seed',prev:'',next:'db init',scope:'tenant',internal:true}],
    events:[], settings:{vat:8,lang:'en',supportReason:''}
  };
  save(db); return db;
}
function load(){ try{return JSON.parse(localStorage.getItem(KEY));}catch(e){return null;} }
function save(db){ localStorage.setItem(KEY,JSON.stringify(db)); }
function audit(db,actor,action,prev,next,scope,internal,note){
  db.audits.push({id:uid('a'),ts:vnNow(),actor,action,prev:String(prev==null?'':(typeof prev==='string'?prev:JSON.stringify(prev))).slice(0,800),next:String(next==null?'':(typeof next==='string'?next:JSON.stringify(next))).slice(0,800),scope:scope||'tenant',internal:internal!==false,note:note||''});
  if(db.audits.length>2000) db.audits=db.audits.slice(-2000); // cap, never mutate past entries
}
/* auto-end: partners past validTo → ended (history preserved) */
function autoEnd(db){
  const today=new Date().toISOString().slice(0,10); let changed=false;
  (db.partners||[]).forEach(p=>{ if(p.validTo&&p.validTo<today&&['active','paused'].includes(p.status)){ const prev=p.status; p.status='ended'; audit(db,'system','partner_auto_end',prev,'ended',p.id,true,'validTo '+p.validTo); changed=true; }});
  return changed;
}
/* finance: order discount -> payable -> VAT removal -> netNet -> commissions
   All VND integers; reconciliation: payable = netNet + vatAmt; discount = gross - payable */
function calc(db,gross,snap){
  gross=Math.round(+gross||0); const vat=+db.settings.vat||0; const d=+snap.discountPct||0;
  const discount=Math.round(gross*d/100);
  const payable=gross-discount;
  const netNet=Math.round(payable*100/(100+vat));
  const vatAmt=payable-netNet; // reconciles by construction
  const coComm=Math.round(netNet*(+snap.companyComm||0)/100);
  const indComm=Math.round(netNet*((snap.indivComm!=null?snap.indivComm:snap.indivShare)||0)/100);
  return {gross,discount,payable,vat,vatAmt,netNet,coComm,indComm};
}
g.ConnectStore={KEY,seed,load,save,audit,uid,vnNow,vnDisplay,calc,autoEnd};
})(window);
