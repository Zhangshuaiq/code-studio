const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { JavaSyntaxIndex } = require('@codegen/code-intelligence/java-syntax-index.cjs');
const { springEndpoints, openApiEndpoints, discoverApis } = require('@codegen/code-intelligence/api-discovery.cjs');
test('Spring AST discovers composed class/method paths and parameters without running Java', async () => {
  const syntax = await JavaSyntaxIndex.create();
  try {
    const result = springEndpoints(syntax.parser, `import org.springframework.web.bind.annotation.*;
      @RestController @RequestMapping({"/api", "/v2"}) class Example {
        // @GetMapping("/fake")
        @GetMapping(path="/users/{id}") public String read(@PathVariable String id, @RequestParam(defaultValue="10") int size, @RequestHeader("X-Token") String token) { return "@PostMapping"; }
        @PostMapping("/users") public void create(@RequestBody User user) {}
        @GetMapping(PATH) public void dynamic() {}
      }`, 'Example.java');
    assert.equal(result.items.length, 4); assert.equal(result.unresolved, 1);
    const read = result.items.find(item => item.path === '/api/users/{id}');
    assert.equal(read.method, 'GET'); assert.equal(read.parameters.length, 3);
    assert.equal(read.parameters.find(p => p.name === 'size').value, '10');
    assert.equal(read.parameters.find(p => p.name === 'size').required, false);
    assert.equal(result.items.find(item => item.method === 'POST').body, '{}');
    assert.ok(read.line > 1);
    assert.equal(springEndpoints(syntax.parser, '@RestController class NotSpring { @GetMapping("/wrong") void f(){} }', 'Other.java').items.length, 0);
  } finally { syntax.close(); }
});
test('static Spring path discovery preserves significant trailing slashes', async () => {
  const syntax = await JavaSyntaxIndex.create();
  try {
    const result = springEndpoints(syntax.parser, 'import org.springframework.web.bind.annotation.*; @RestController @RequestMapping("/api/") class C { @GetMapping("/users/") void f(){} }', 'C.java');
    assert.equal(result.items[0].path, '/api/users/');
  } finally { syntax.close(); }
});
test('OpenAPI supports local parameter refs and operation overrides without fetching external refs', () => {
  const items = openApiEndpoints({ openapi: '3.0.3', components: { parameters: { page: { name: 'page', in: 'query', schema: { default: 1 } } } }, paths: {
    '/users/{id}': { parameters: [{ $ref: '#/components/parameters/page' }], get: { summary: 'Users', parameters: [{ name: 'page', in: 'query', example: 2 }, { $ref: 'https://example.invalid/secret' }] } },
    '/users': { post: { requestBody: { content: { 'application/json': { example: { name: 'test' } } } } } },
  } }, 'openapi.json');
  assert.equal(items.length, 2); assert.deepEqual(items[0].parameters.map(p => p.value), [2]);
  assert.deepEqual(JSON.parse(items[1].body), { name: 'test' });
});
test('worker scans an unstarted source-only project and ignores build outputs and symlinks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'api-discovery-test-'));
  try {
    await fs.mkdir(path.join(root, 'target'));
    const spec = JSON.stringify({ swagger: '2.0', paths: { '/ping': { get: { operationId: 'ping' } } } });
    await fs.writeFile(path.join(root, 'swagger.json'), spec);
    await fs.writeFile(path.join(root, 'target', 'swagger.json'), spec);
    await fs.symlink(path.join(root, 'target'), path.join(root, 'linked'));
    await fs.writeFile(path.join(root, 'Controller.java'), 'import org.springframework.web.bind.annotation.*; @RestController class C { @GetMapping("/hello") String hello() {return "ok";} }');
    const result = await discoverApis(root);
    assert.equal(result.items.length, 2); assert.equal(result.truncated, false);
    assert.ok(result.items.every(item => !item.file.includes('target')));
    assert.deepEqual(new Set(result.frameworks), new Set(['spring', 'openapi']));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
