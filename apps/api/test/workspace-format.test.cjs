const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const file=path.resolve(__dirname,'../../web/src/lib/format.ts'),loaded=new Module(file,module);loaded.filename=file;loaded.paths=Module._nodeModulePaths(path.dirname(file));loaded._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,file);
const {formatCode,formatDocument}=loaded.exports;
test('JSON XML SQL formatting preserves data and only changes draft text',async()=>{
  const json='{"a":1,"nested":{"x":"你好"}}';assert.deepEqual(JSON.parse(await formatCode(json,'a.json')),JSON.parse(json));
  const xml=await formatCode('<root text="a &amp; b"><item> preserve text </item></root>','pom.xml');assert.ok(xml.includes(' preserve text '));assert.ok(xml.includes('a &amp; b'));
  assert.match(await formatCode('select a,b from users where id=1','query.sql'),/\n/);
  await assert.rejects(formatCode('{invalid','a.json'));
});
test('language formatting applies validated edits and rejects overlaps/out of bounds',async()=>{
  const code='class Main{}';const range={start:{line:0,character:0},end:{line:0,character:12}};
  assert.equal(await formatDocument(code,'Main.java',async()=>({result:[{range,newText:'class Main {\n}'}]})),'class Main {\n}');
  await assert.rejects(formatDocument(code,'Main.java',async()=>({result:[{range,newText:'a'},{range,newText:'b'}]})),/范围无效/);
  await assert.rejects(formatDocument(code,'Main.java',async()=>({result:[{range:{start:{line:100,character:0},end:{line:100,character:1}},newText:'a'}]})),/位置无效/);
});
