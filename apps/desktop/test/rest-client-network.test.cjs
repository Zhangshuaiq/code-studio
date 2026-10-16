const test = require('node:test'); const assert = require('node:assert/strict'); const http = require('node:http');
const { validateRequest, sendRequest } = require('../src/local-rest-client.cjs');
const { parseNetworkEnvironment, initializeUserNetworkEnvironment } = require('../src/user-network-environment.cjs');
test('REST validation rejects unsafe schemes, credentials, protocol headers and oversized payloads', () => {
  for (const input of [{url:'file:///etc/passwd'},{url:'http://user:secret@localhost'},{url:'http://localhost',headers:{Host:'other'}},{url:'http://localhost',headers:{Authorization:'a\r\nX: b'}},{url:'http://localhost',method:'GET',body:'data'},{url:'http://localhost',method:'POST',body:'x'.repeat(256*1024+1)}]) assert.throws(()=>validateRequest(input));
  assert.equal(validateRequest({url:'http://localhost',headers:{Authorization:'Bearer test'}}).headers.Authorization,'Bearer test');
});
test('REST sends real method/body, captures errors, never follows redirects and bounds response', async t => {
  let redirectTarget=0;
  const server=http.createServer(async(req,res)=>{
    if(req.url==='/redirect'){res.writeHead(302,{Location:'/target'});res.end();return;}
    if(req.url==='/target'){redirectTarget++;res.end();return;}
    if(req.url==='/large'){res.setHeader('Content-Type','text/plain');res.end('x'.repeat(2*1024*1024+10));return;}
    let body='';for await(const chunk of req)body+=chunk;res.writeHead(418,{'Content-Type':'application/json'});res.end(JSON.stringify({method:req.method,body,auth:req.headers.authorization||''}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}));const url='http://127.0.0.1:'+server.address().port;
  const result=await sendRequest({url,method:'POST',headers:{Authorization:'Bearer test'},body:'{"a":1}'});assert.equal(result.status,418);assert.equal(JSON.parse(result.body).body,'{"a":1}');assert.equal(JSON.parse(result.body).auth,'Bearer test');
  assert.equal((await sendRequest({url:url+'/redirect'})).status,302);assert.equal(redirectTarget,0);
  const large=await sendRequest({url:url+'/large'});assert.equal(large.truncated,true);assert.equal(large.bytes,2*1024*1024);
  const abort=new AbortController();abort.abort();await assert.rejects(sendRequest({url},abort.signal));
});
test('native user network import drops injected proxies but preserves user-configured proxy/certificate without logging secrets', async()=>{
  const output='banner\0CODE_STUDIO_NETWORK_ENV\0HTTPS_PROXY=http://user:secret@localhost:8888\0GIT_SSL_CAINFO=/cert\0OPENAI_API_KEY=not-imported\0';
  assert.deepEqual(parseNetworkEnvironment(output),{HTTPS_PROXY:'http://user:secret@localhost:8888',GIT_SSL_CAINFO:'/cert'});
  const target={HTTP_PROXY:'injected',KEEP:'yes'};let initial;
  const result=await initializeUserNetworkEnvironment({platform:'linux',target,execFile(_command,_args,options,callback){initial=options.env;callback(null,output)}});
  assert.equal(result.refreshed,true);assert.equal(initial.HTTP_PROXY,undefined);assert.equal(target.HTTP_PROXY,undefined);assert.equal(target.HTTPS_PROXY,'http://user:secret@localhost:8888');assert.equal(target.KEEP,'yes');assert.equal(target.OPENAI_API_KEY,undefined);
  const failed={HTTPS_PROXY:'existing'};await initializeUserNetworkEnvironment({platform:'linux',target:failed,execFile(_command,_args,_options,callback){callback(Error('failure'))}});assert.equal(failed.HTTPS_PROXY,'existing');
});
