const { app, BrowserWindow } = require('electron'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const assert = require('node:assert/strict');
let server, window, revoked = false; const reads = []; const root = path.resolve(__dirname, '../../web/dist');
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('Web Redis smoke timed out'); app.exit(1); }, 60000);
const evaluate = expression => window.webContents.executeJavaScript(expression);
async function waitFor(expression) { for (let i = 0; i < 150; i++) { if (await evaluate(`(() => { try { return (${expression}); } catch { return false; } })()`)) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('UI condition not reached: ' + expression); }
app.whenReady().then(async () => {
  let code = 0;
  try {
    server = http.createServer(async (request, response) => {
      try {
        const url = new URL(request.url,'http://localhost'); const json = (body,status=200) => { response.writeHead(status,{'Content-Type':'application/json'}); response.end(JSON.stringify(body)); };
        if (url.pathname === '/bootstrap') { response.writeHead(200,{'Content-Type':'text/html'}); response.end('<script>localStorage.setItem("token","redis-web-fixture");localStorage.setItem("username","WebOwner");location.replace("/db-query/redis-fixture");</script>'); return; }
        if (url.pathname.startsWith('/api/')) {
          assert.equal(request.headers.authorization,'Bearer redis-web-fixture'); assert.ok(!url.pathname.startsWith('/api/local/'));
          if (url.pathname === '/api/auth/me') return json({id:'owner',username:'WebOwner',roles:[],permissions:['project:read']});
          if (url.pathname === '/api/admin/datasources/redis-fixture') return json({id:'redis-fixture',name:'Web Redis fixture',type:'redis',category:'nosql',teamId:'team',config:{host:'localhost',port:6379,db:0},updatedAt:'fixture'});
          if (url.pathname === '/api/db-query/transfers/mine') return json({items:[]});
          if (url.pathname === '/api/db-query/redis-fixture/execute') {
            let raw='';for await(const chunk of request)raw+=chunk; const payload=JSON.parse(raw); reads.push(payload); assert.ok(payload.redisBrowse,'browser must use structured read operations');
            if(revoked)return json({message:'数据源无权访问'},403);
            const input=payload.redisBrowse;
            if(input.action==='scan') return json({cursor:input.cursor==='0'?'4':'0',items:(input.cursor==='0'?['first-key','set-key','list-key']:['second-key']).map(key=>({key,keyEncoding:'utf8',bytes:key.length})),partial:false});
            if(input.key==='list-key') return json({type:'list',ttlMs:-1,exists:true,size:1,supported:true,pageKind:'collection',items:[{index:0,value:{value:'read-only-list',encoding:'utf8',bytes:14},valueBytes:14,version:'a'.repeat(64),truncated:false}],offset:0,nextOffset:1,count:25,hasMore:false,partial:false});
            if(input.key==='set-key') return json({type:'set',ttlMs:-1,exists:true,size:30,supported:true,pageKind:'collection',items:[{name:{value:input.scanOffset?'later-member':'first-member',encoding:'utf8',bytes:12},nameBytes:12}],offset:0,nextOffset:0,cursor:'0',pageCursor:'0',scanOffset:input.scanOffset||0,nextScanOffset:25,count:25,hasMore:!input.scanOffset,partial:false});
            return json({type:'string',ttlMs:-1,exists:true,size:5,supported:true,value:input.key==='first-key'?'first':'later',encoding:'utf8',bytes:5,offset:0,nextOffset:5,hasMore:false,truncated:false});
          }
          return json([]);
        }
        const file = url.pathname.startsWith('/assets/') ? path.resolve(root,'.'+url.pathname) : path.join(root,'index.html');
        if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){response.writeHead(404);response.end();return;}
        response.writeHead(200,{'Content-Type':file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html'});fs.createReadStream(file).pipe(response);
      } catch(error) { console.error(error); response.writeHead(500);response.end(); }
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    window=new BrowserWindow({show:false,width:1440,height:950,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,partition:`web-redis-${Date.now()}`}});
    await window.loadURL(`http://127.0.0.1:${server.address().port}/bootstrap`);
    await waitFor(`document.querySelector('[data-redis-key]')?.textContent === 'first-key'`);
    assert.equal(await evaluate(`document.body.textContent.includes('仅支持只读命令')`),true);
    await evaluate(`document.querySelector('[data-redis-key]').click()`); await waitFor(`document.querySelector('[data-redis-value]')?.textContent === 'first'`);
    await evaluate(`[...document.querySelectorAll('[data-redis-key]')].find(node=>node.textContent==='set-key').click()`);
    await waitFor(`document.querySelector('[data-redis-collection-row]')?.textContent.includes('first-member')`);
    await evaluate(`[...document.querySelectorAll('[data-redis-browser] button')].find(button=>button.textContent.trim()==='下一页').click()`);
    await waitFor(`document.querySelector('[data-redis-collection-row]')?.textContent.includes('later-member')`);
    assert.equal(await evaluate(`!!document.querySelector('[data-redis-mutations]') || !!document.querySelector('[data-redis-value-editor]') || [...document.querySelectorAll('[data-redis-browser] button')].some(node=>['新增键','新增成员','编辑分数','删除成员'].includes(node.textContent.trim()))`), false);
    assert.ok(reads.some(payload=>payload.redisBrowse.key==='set-key'&&payload.redisBrowse.scanOffset===25));
    await evaluate(`[...document.querySelectorAll('[data-redis-key]')].find(node=>node.textContent==='list-key').click()`);
    await waitFor(`document.querySelector('[data-redis-collection-row]')?.textContent.includes('read-only-list')`);
    assert.equal(await evaluate(`!!document.querySelector('[data-redis-mutations]') || [...document.querySelectorAll('[data-redis-browser] button')].some(node=>['新增列表项','编辑列表项','删除列表项'].includes(node.textContent.trim()))`), false);
    await evaluate(`[...document.querySelectorAll('[data-redis-browser] button')].find(button=>button.textContent.trim()==='继续扫描').click()`);
    await waitFor(`document.querySelector('[data-redis-key]')?.textContent === 'second-key'`);
    assert.equal(await evaluate(`!!document.querySelector('[data-redis-value]')`),false);
    assert.equal(await evaluate(`[...document.querySelectorAll('[data-redis-browser] button')].find(button=>button.textContent.trim()==='继续扫描').disabled`),true);
    await evaluate(`document.querySelector('[data-redis-key]').click()`); await waitFor(`document.querySelector('[data-redis-value]')?.textContent === 'later'`);
    revoked=true; await evaluate(`[...document.querySelectorAll('[data-redis-browser] button')].find(button=>button.textContent.trim()==='刷新值').click()`);
    await waitFor(`document.querySelector('[data-redis-browser]')?.textContent.includes('数据源无权访问')`);
    assert.equal(await evaluate(`!!document.querySelector('[data-redis-value]') || !!document.querySelector('[data-redis-key]')`),false);
    assert.ok(reads.some(payload=>payload.redisBrowse.cursor==='4'));
    console.log('Web Redis UI passed: authenticated remote read protocol, shared browser, cursor paging, TTL/value preview and revoked-access cache clearing.');
  } catch(error){code=1;console.error(error);if(window)console.error(await evaluate('document.body.innerText.slice(-2000)').catch(()=>''));}
  finally{clearTimeout(deadline);window?.destroy();if(server)await new Promise(resolve=>server.close(resolve));app.exit(code);}
});
