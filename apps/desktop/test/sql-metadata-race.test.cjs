const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const {createLocalApi}=require('../src/local-api.cjs');
test('local SQL metadata does not publish results from an edited connection',{timeout:10000},async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'code-studio-sql-meta-'));let release,notify;const gate=new Promise(resolve=>release=resolve);const started=new Promise(resolve=>notify=resolve);
 const api=await createLocalApi({token:'metadata-fixture',storePath:path.join(directory,'store.sqlite3'),connectorRuntime:{async metadata(){notify();await gate;return{items:[{name:'old_private_table'}],truncated:false};}}});
 t.after(async()=>{release();await api.close();fs.rmSync(directory,{recursive:true,force:true});});const headers={Authorization:'Bearer metadata-fixture','Content-Type':'application/json'};
 const created=await fetch(api.origin+'/api/local/connectors',{method:'POST',headers,body:JSON.stringify({name:'DB',type:'postgres',settings:{host:'localhost',database:'before'}})});const row=await created.json();assert.equal(created.status,201);
 const pending=fetch(api.origin+'/api/local/connectors/'+row.id+'/metadata',{method:'POST',headers,body:JSON.stringify({action:'tables'})});await started;
 const updated=await fetch(api.origin+'/api/local/connectors/'+row.id,{method:'PUT',headers,body:JSON.stringify({settings:{database:'after'}})});assert.equal(updated.status,200);release();
 const result=await pending;assert.equal(result.status,409);assert.equal(JSON.stringify(await result.json()).includes('old_private_table'),false);
});
