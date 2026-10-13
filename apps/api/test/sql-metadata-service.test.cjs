require('reflect-metadata'); const test=require('node:test');const assert=require('node:assert/strict');
const {DbQueryService}=require('../dist/db-query/db-query.service.js');
function fixture(mode='normal') { let reads=0;const service=new DbQueryService({datasource:{findFirst:async args=>{assert.equal(args.where.members.some.userId,'owner');reads++;if(mode==='revoked'&&reads===2)return null;return{type:mode==='redis'?'redis':'postgresql',encryptedConfig:JSON.stringify({host:'localhost',database:mode==='changed'&&reads===2?'changed':'original'})};}}},{decrypt:value=>value},{get:(_key,fallback)=>fallback});const calls=[];service.listTables=async(id,user,database)=>{calls.push({id,user,database});return Array.from({length:501},(_,i)=>'table_'+i);};service.describeTable=async(id,user,table,database)=>{calls.push({id,user,table,database});return[{column_name:'name',data_type:'text'}];};return{service,calls};}
test('SQL metadata is bounded, scoped and readonly without executing arbitrary query payloads',async()=>{
 const {service,calls}=fixture();const tables=await service.sqlMetadata('source','owner',{action:'tables',database:'db'});assert.equal(tables.items.length,500);assert.equal(tables.truncated,true);assert.equal(calls[0].database,'db');
 const columns=await service.sqlMetadata('source','owner',{action:'columns',database:'db',table:'table_0'});assert.equal(columns.items[0].column_name,'name');assert.equal(calls[1].table,'table_0');
 await assert.rejects(service.sqlMetadata('source','owner',{action:'execute'}),/操作无效/);
});
test('SQL metadata rechecks source membership and configuration after reading',async()=>{
 await assert.rejects(fixture('revoked').service.sqlMetadata('source','owner',{action:'tables'}),/无权访问/);
 await assert.rejects(fixture('changed').service.sqlMetadata('source','owner',{action:'tables'}),error=>error.getStatus()===409);
 const {service,calls}=fixture('redis');await assert.rejects(service.sqlMetadata('source','owner',{action:'tables'}),/关系型/);assert.equal(calls.length,0);
});
