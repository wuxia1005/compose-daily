// ==UserScript==
// @name        COMPOSE AutoPOS
// @description 在 AutoPOS 讀取指定營業日的報表數字，帶回 COMPOSE 門市日報；只讀畫面文字，不讀取帳密。
// @version     1.0.0
// @match       https://autopos.cloud/*
// @run-at      document-start
// @inject-into page
// @noframes
// ==/UserScript==
(()=>{
"use strict";
function validateAutoPosPacket(raw) {
  if (!raw || raw.v !== 1 || raw.source !== 'autopos') throw new Error('AutoPOS 帶入資料格式不支援。');
  const validDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0,10) === s;
  if (!validDate(raw.date)) throw new Error('AutoPOS 營業日期不正確。');
  const time = s => { if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|\+08:00)$/.test(s) || !Number.isFinite(Date.parse(s))) throw new Error('缺少有效的查詢時間，請重新查詢。'); return s; };
  const number = (n,key) => { if (!Number.isSafeInteger(n) || n < 0 || n > 999999999) throw new Error(`${key}數字不正確，請重新查詢。`); return n; };
  const part = (p,kind) => {
    if (!p || p.date !== raw.date || p.store !== '高雄篤敬店' || p.storeCode !== '10001') throw new Error('兩份報表必須是同一天的高雄篤敬店（10001）。');
    const r={date:p.date,store:p.store,storeCode:p.storeCode,queriedAt:time(p.queriedAt)};
    for(const key of kind==='summary'?['revenue','cups']:['cash','linepay','credit']) r[key]=number(p[key],key);
    if(kind==='receipt'){if(p.accountType!=='營收')throw new Error('收款資料必須是「營收」，不能使用退款資料。');r.accountType='營收';}
    return r;
  };
  const summary=part(raw.summary,'summary'),receipt=part(raw.receipt,'receipt'),capturedAt=time(raw.capturedAt);
  if(summary.revenue!==receipt.cash+receipt.linepay+receipt.credit)throw new Error('兩份報表收款合計不一致，可能仍有交易進行，請重新查詢。');
  const times=[summary.queriedAt,receipt.queriedAt].map(Date.parse);
  if(Math.abs(times[0]-times[1])>120000)throw new Error('兩份報表查詢時間相差超過 2 分鐘，請重新查詢。');
  if(times.some(t=>t>Date.parse(capturedAt)+300000 || Date.parse(capturedAt)-t>300000))throw new Error('報表不是本次的新查詢結果，請確認手機時間並重新查詢。');
  const packet={v:1,source:'autopos',date:raw.date,summary,receipt,capturedAt};
  if(raw.method==='mobile-bi')packet.method='mobile-bi';
  return packet;
}
function encodeAutoPosPacket(raw) {
  const bytes=new TextEncoder().encode(JSON.stringify(validateAutoPosPacket(raw)));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}
function readAutoPosTables(doc) {
  const clean=n=>String(n??'').replace(/\s+/g,' ').trim();
  return Array.from(doc.querySelectorAll('vaadin-grid')).map(grid=>{
    const rows=Array.from(grid.shadowRoot?.querySelectorAll('tr')||[]).filter(r=>!r.hidden);
    return rows.map(row=>Array.from(row.querySelectorAll('th,td')).map(cell=>{
      const slots=Array.from(cell.querySelectorAll('slot'));
      return clean(slots.length?slots.flatMap(s=>s.assignedNodes({flatten:true})).map(n=>n.textContent).join(' '):cell.textContent);
    }));
  });
}
function parseAutoPosTables(tables,kind,date) {
  const names=kind==='summary'?{revenue:'營業收入',cups:'商品件數'}:{cash:'現金',linepay:'LINE Pay',credit:'聯合信用卡'};
  const normalize=s=>String(s).replace(/\s/g,'').toLowerCase();
  const required=['營業日期','門市編號','門市名稱',...Object.values(names),...(kind==='receipt'?['帳務類型']:[])];
  const candidates=tables.filter(t=>t[0]&&required.every(k=>t[0].filter(h=>normalize(h)===normalize(k)).length===1));
  if(candidates.length!==1)throw new Error('找不到唯一的完整報表欄位，可能尚未登入或畫面已變更。');
  const [header,...body]=candidates[0],idx=k=>header.findIndex(h=>normalize(h)===normalize(k));
  // Fail closed on other dates/stores, pagination, duplicate/unsupported accounting rows.
  const rows=body.filter(r=>/^\d{4}-\d{2}-\d{2}$/.test(r[idx('營業日期')]||''));
  if(rows.length!==1)throw new Error('必須只有一天、一間門市的一筆資料；空白、多筆或退款列不會自動加總。');
  const row=rows[0];
  if(row.length!==header.length||row[idx('營業日期')]!==date||row[idx('門市編號')]!=='10001'||row[idx('門市名稱')]!=='高雄篤敬店')throw new Error('報表日期或門市不相符，停止帶入。');
  const r={date,store:'高雄篤敬店',storeCode:'10001'};
  for(const [key,label] of Object.entries(names)){
    const s=row[idx(label)];
    if(typeof s!=='string'||! /^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(s))throw new Error(`${label}缺值或不是整數，停止帶入。`);
    r[key]=Number(s.replaceAll(',',''));
    if(!Number.isSafeInteger(r[key])||r[key]>999999999)throw new Error(`${label}超出範圍。`);
  }
  if(kind==='receipt'){r.accountType=row[idx('帳務類型')];if(r.accountType!=='營收')throw new Error('只能使用營收資料。');}
  const metadata=tables.flat(2);
  const ranges=metadata.filter(s=>s.startsWith('營業日期：'));
  if(ranges.length!==1||ranges[0]!==`營業日期：${date} ~ ${date}`)throw new Error('查詢日期範圍不相符。');
  const times=metadata.filter(s=>s.startsWith('查詢時間：'));
  if(times.length!==1||!/^查詢時間：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(times[0]))throw new Error('找不到報表查詢時間。');
  r.queriedAt=times[0].slice(5).replace(' ','T')+'+08:00';
  return r;
}
function pickAutoPosDate(values, now = Date.now()) {
  const date = values.length === 2 && values[0] && values[0] === values[1] ? values[0] : new Date(now + 8 * 3600000).toISOString().slice(0, 10);
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('請選擇有效營業日期。');
  return date;
}
async function runAutoPosShortcut(targetUrl, opts={}) {
  const frames=[];let completed=false;
  const finish=(url,login)=>{if(completed)return;completed=true;clearTimeout(deadline);for(const f of frames)f.remove();if(opts.done)opts.done(url,login===true);else completion(url);};
  const fail=(message,login)=>finish(targetUrl+'#autopos-error='+encodeURIComponent(message),login);
  // Lets the caller stop early; the hidden frames are removed at once.
  opts.cancel=()=>fail('已取消，未帶入任何資料。');
  const deadline=setTimeout(()=>fail('查詢逾時。請確認 AutoPOS 已登入、網路正常，再重試；不會使用舊資料。',true),opts.timeoutMs||22000);
  const wait=async read=>{
    while(!completed){const result=read();if(result)return result;await new Promise(resolve=>setTimeout(resolve,150));}
    throw new Error('查詢已結束。');
  };
  try{
    if(location.origin!=='https://autopos.cloud'||(!opts.date&&!['/beui/report/summary','/beui/report/receiptdetail'].includes(location.pathname)))throw new Error('請先在 Safari 登入 AutoPOS，開啟「門市營業匯總」再執行捷徑。');
    const date=pickAutoPosDate(opts.date?[opts.date,opts.date]:Array.from(document.querySelectorAll('vaadin-date-picker'),p=>p.value));
    const query=async(kind)=>{
      if(completed)throw new Error('查詢已取消。');
      // Same-origin frames share the existing Safari session, with no credential copying.
      const frame=document.createElement('iframe');frames.push(frame);
      frame.title=kind==='summary'?'COMPOSE 查詢營業匯總':'COMPOSE 查詢收款統計';
      Object.assign(frame.style,{position:'fixed',left:'-2000px',top:'0',width:'1100px',height:'850px',opacity:'0',pointerEvents:'none'});
      frame.src='https://autopos.cloud/beui/report/'+(kind==='summary'?'summary':'receiptdetail');
      document.body.append(frame);
      const d=await wait(()=>{try{
        const doc=frame.contentDocument;
        if(!doc)return null;
        // Signed out: AutoPOS shows a sign-in form, or bounces the report page back to its portal with a meta refresh.
        const at=frame.contentWindow&&frame.contentWindow.location;
        if(doc.querySelector('input[type=password]')||doc.querySelector('meta[http-equiv="refresh" i]')||(at&&at.origin==='https://autopos.cloud'&&!at.pathname.startsWith('/beui/report/')))throw Object.assign(new Error('AutoPOS 尚未登入商戶後台，請以「商戶後台」版本登入後再試一次。'),{login:true});
        const ds=doc.querySelectorAll('vaadin-date-picker');
        return ds.length===2&&ds[0].shadowRoot&&readAutoPosTables(doc).flat(2).some(s=>s.startsWith('查詢時間：'))?doc:null;
      }catch(e){if(e.name==='SecurityError')throw new Error('AutoPOS 不允許讀取查詢畫面，請改用貼上表格，並回報此訊息。');throw e;}});
      const ds=Array.from(d.querySelectorAll('vaadin-date-picker'));
      for(const picker of ds){picker.value=date;picker.dispatchEvent(new frame.contentWindow.Event('change',{bubbles:true,composed:true}));}
      const buttons=Array.from(d.querySelectorAll('vaadin-button')).filter(b=>b.textContent.trim()==='查詢');
      if(buttons.length!==1)throw new Error('找不到唯一查詢按鈕，停止帶入。');
      const before=readAutoPosTables(d).flat(2).find(s=>s.startsWith('查詢時間：'));
      // AutoPOS stamps queries to seconds. Ensure the response cannot reuse the same stamp.
      await new Promise(resolve=>setTimeout(resolve,1100));
      if(completed)throw new Error('查詢已取消。');
      buttons[0].click();
      await wait(()=>readAutoPosTables(d).flat(2).some(s=>s.startsWith('查詢時間：')&&s!==before));
      // Let all cells finish the same server DOM update before reading the row.
      let previous='',stableAt=Date.now();
      const tables=await wait(()=>{
        const t=readAutoPosTables(d),snapshot=JSON.stringify(t);
        if(snapshot!==previous){previous=snapshot;stableAt=Date.now();return null;}
        return Date.now()-stableAt>=450?t:null;
      });
      const pagination=(d.body.textContent||'').match(/共\s*(\d+)\s*條/);
      if(!pagination||Number(pagination[1])!==1)throw new Error('查詢結果不是唯一一筆，請確認日期與門市。');
      const part=parseAutoPosTables(tables,kind,date);frame.remove();return part;
    };
    // Query sequentially to avoid concurrent writes to server-side Vaadin views.
    const summary=await query('summary'),receipt=await query('receipt');
    const packet=validateAutoPosPacket({v:1,source:'autopos',date,summary,receipt,capturedAt:new Date().toISOString()});
    finish(targetUrl+'#autopos='+encodeAutoPosPacket(packet));
  }catch(e){fail(e.message||'查詢失敗，未帶入任何資料。',e.login);}
}
function runAutoPosUserscript(targetUrl) {
  if(window.top!==window||location.origin!=='https://autopos.cloud')return;
  // The only stored value: the requested day, kept for this tab for 10 minutes so the import can continue
  // after AutoPOS navigates for sign-in. No AutoPOS data, cookie or credential is read.
  const KEY='compose-daily-pending',HOLD=600000;
  const recall=()=>{try{const m=/^(\d{4}-\d{2}-\d{2})\|(\d{13})$/.exec(sessionStorage.getItem(KEY)||''),until=m?Number(m[2]):0;return until>Date.now()&&until<=Date.now()+HOLD?m[1]:null;}catch(e){return null;}};
  const remember=day=>{try{sessionStorage.setItem(KEY,day+'|'+(Date.now()+HOLD));}catch(e){}};
  const forget=()=>{try{sessionStorage.removeItem(KEY);}catch(e){}};
  const params=new URLSearchParams(location.search),viaHash=/^#compose-daily=(\d{4}-\d{2}-\d{2})$/.exec(location.hash);
  const requested=viaHash?viaHash[1]:/^\d{4}-\d{2}-\d{2}$/.test(params.get('compose-daily')||'')?params.get('compose-daily'):null;
  const date=requested||recall();
  if(!date)return;
  if(requested){
    remember(date);
    // Drop the trigger so a reload or Back cannot start a second import.
    params.delete('compose-daily');const rest=params.toString();
    history.replaceState(history.state,'',location.pathname+(rest?'?'+rest:'')+(viaHash?'':location.hash));
  }
  let cancelled=false,running=false,timer=0,job=null;
  const el=(tag,style,text)=>{const e=document.createElement(tag);Object.assign(e.style,style);if(text)e.textContent=text;return e;};
  const box=el('div',{position:'fixed',left:'12px',right:'12px',bottom:'calc(12px + env(safe-area-inset-bottom))',zIndex:'2147483647',padding:'14px 16px',borderRadius:'12px',borderLeft:'6px solid #ffd400',background:'#202020',color:'#fff',font:'15px/1.6 system-ui,sans-serif',boxShadow:'0 6px 24px rgba(0,0,0,.35)'});
  box.setAttribute('role','status');
  const text=el('div',{}),actions=el('div',{display:'none',flexWrap:'wrap',gap:'8px',marginTop:'10px'});
  box.append(text,actions);
  // Attached to <html>, not <body>, so AutoPOS re-rendering its page cannot remove the notice.
  const mount=()=>{if(!cancelled&&!box.isConnected&&document.documentElement)document.documentElement.append(box);};
  const show=(message,buttons)=>{
    text.textContent='COMPOSE 日報｜'+message;actions.textContent='';actions.style.display=buttons.length?'flex':'none';
    for(const [label,action] of buttons){const b=el('button',{minHeight:'40px',padding:'8px 14px',border:'0',borderRadius:'8px',background:'#ffd400',color:'#202020',font:'inherit'},label);b.type='button';b.addEventListener('click',action);actions.append(b);}
    mount();
  };
  const stop=()=>{cancelled=true;clearInterval(timer);forget();box.remove();if(job)job.cancel();};
  const cancel=['取消',stop];
  const back=url=>['回到日報',()=>{stop();location.replace(url);}];
  const needsLogin=()=>!!document.querySelector('input[type=password]');
  // The sign-in portal offers "Mobile BI" or the merchant backend; the two reports live in the backend.
  const preferBackend=()=>{const s=document.querySelectorAll('select.select-version');if(s.length===1&&s[0].value!=='desktop'&&Array.from(s[0].options).some(o=>o.value==='desktop')){s[0].value='desktop';s[0].dispatchEvent(new Event('change',{bubbles:true}));}};
  const waitForLogin=()=>{
    // "Hide" only removes the notice (it may cover the sign-in button); the request stays armed.
    show('請登入 AutoPOS（版本選「商戶後台」），登入後會自動繼續讀取。',[back(targetUrl),cancel,['隱藏提示',()=>box.remove()]]);
    clearInterval(timer);preferBackend();
    timer=setInterval(()=>{
      if(!recall()){clearInterval(timer);show('等待登入超過 10 分鐘，已停止。請回到日報再按一次。',[back(targetUrl),cancel]);}
      else if(needsLogin())preferBackend();
      else start();
    },1000);
  };
  const start=()=>{
    if(cancelled||running)return;
    running=true;clearInterval(timer);
    show(`正在讀取 ${date} 的報表，請稍候，先不用操作此頁…`,[cancel]);
    job={date,timeoutMs:40000,done:(url,login)=>{
      running=false;if(cancelled)return;
      if(url.startsWith(targetUrl+'#autopos=')){forget();show('讀取完成，正在回到日報…',[]);location.replace(url);return;}
      let message='';try{message=decodeURIComponent(url.split('#autopos-error=')[1]||'');}catch(e){}
      // Not signed in yet: keep the request so it resumes once the sign-in form is gone or AutoPOS reloads.
      if(login&&needsLogin()){waitForLogin();return;}
      // The sign-in form may appear a moment after the report frames noticed the expired session.
      if(login)timer=setInterval(()=>{if(!recall())clearInterval(timer);else if(needsLogin())waitForLogin();},1000);
      else forget();
      show(message||'讀取失敗，未帶入任何資料。',[['重試',()=>{remember(date);start();}],back(url),cancel]);
    }};
    runAutoPosShortcut(targetUrl,job);
  };
  show(`準備讀取 ${date} 的 AutoPOS 報表…`,[cancel]);
  document.addEventListener('DOMContentLoaded',mount,{once:true});
  // Always try first: the portal shows its sign-in form even while the backend session is still valid.
  let begun=false;
  const begin=()=>{if(begun)return;begun=true;start();};
  if(document.readyState==='complete')begin();else{window.addEventListener('load',begin,{once:true});setTimeout(begin,8000);}
}
runAutoPosUserscript("https://wuxia1005.github.io/compose-daily/");
})();
