const { app, BrowserWindow } = require("electron");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  http = require("node:http"),
  assert = require("node:assert/strict");
const { createLocalApi } = require("../src/local-api.cjs");
let api, window, echo;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-tools-"));
fs.mkdirSync(path.join(directory, "electron"));
app.setPath("userData", path.join(directory, "electron"));
app.on("window-all-closed", () => {});
const deadline = setTimeout(() => {
  console.error("Workspace tools timed out");
  app.exit(1);
}, 90000);
const evaluate = async (expression) => {
  try {
    return await window.webContents.executeJavaScript(expression);
  } catch (error) {
    console.error("Failed expression:", expression);
    throw error;
  }
};
async function waitFor(expression) {
  for (let i = 0; i < 200; i++) {
    if (
      await evaluate(`(()=>{try{return (${expression})}catch{return false}})()`)
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error(expression);
}
async function clickText(text) {
  await evaluate(
    `[...document.querySelectorAll('button')].find(node=>node.textContent.trim()===${JSON.stringify(text)}).click()`,
  );
}
async function input(label, value) {
  await evaluate(
    `(()=>{const node=document.querySelector('[aria-label="${label}"]');Object.getOwnPropertyDescriptor(${label === "HTTP 请求体" ? "HTMLTextAreaElement" : "HTMLInputElement"}.prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('input',{bubbles:true}))})()`,
  );
}
app.whenReady().then(async () => {
  let code = 0;
  try {
    const root = path.join(directory, "Tools fixture");
    fs.mkdirSync(path.join(root, "src/deep/a/b"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/deep/a/b/leaf.json"), "{}");
    const json = '{"a":1,"nested":{"x":2}}';
    fs.writeFileSync(path.join(root, "data.json"), json);
    fs.writeFileSync(
      path.join(root, "config.xml"),
      '<root a="1"     b="2" ><item/></root>',
    );
    echo = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ method: req.method, body }));
    });
    await new Promise((resolve) => echo.listen(0, "127.0.0.1", resolve));
    api = await createLocalApi({
      staticDir: path.join(__dirname, "../renderer"),
      storePath: path.join(directory, "store.sqlite3"),
    });
    const project = api.registerWorkspace(root);
    window = new BrowserWindow({
      show: false,
      width: 1440,
      height: 950,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    await window.loadURL(api.origin);
    await waitFor(
      `[...document.querySelectorAll('button h2')].some(node=>node.textContent==='Tools fixture')`,
    );
    await evaluate(
      `[...document.querySelectorAll('button h2')].find(node=>node.textContent==='Tools fixture').closest('button').click()`,
    );
    for (const folder of ["deep", "a", "b"]) {
      await waitFor(
        `[...document.querySelectorAll('li > button')].some(node=>node.textContent.trim()==='${folder}')`,
      );
      await evaluate(
        `[...document.querySelectorAll('li > button')].find(node=>node.textContent.trim()==='${folder}').click()`,
      );
    }
    await waitFor(
      `[...document.querySelectorAll('li > button')].some(node=>node.textContent.trim()==='leaf.json')`,
    );
    await evaluate(
      `[...document.querySelectorAll('li > button')].find(node=>node.textContent.trim()==='src').click()`,
    );
    await waitFor(
      `![...document.querySelectorAll('li > button')].some(node=>node.textContent.trim()==='leaf.json')`,
    );
    await evaluate(
      `[...document.querySelectorAll('li > button')].find(node=>node.textContent.trim()==='src').click()`,
    );
    await waitFor(
      `[...document.querySelectorAll('li > button')].some(node=>node.textContent.trim()==='leaf.json')`,
    );
    await clickText("data.json");
    await waitFor(
      `document.querySelector('.monaco-editor .view-lines')?.textContent.includes('nested')`,
    );
    await evaluate(
      `new Promise(resolve=>window.require(['vs/editor/editor.main'],m=>{window.__monaco=window.monaco||m;window.__editor=()=>window.__monaco.editor.getEditors().find(e=>e.getDomNode()?.isConnected&&e.getModel()?.uri.scheme==='codegen');resolve()}))`,
    );
    await evaluate(
      `document.querySelector('[aria-label="格式化当前文件"]').click()`,
    );
    await waitFor(`window.__editor().getValue().includes(String.fromCharCode(10))`);
    assert.deepEqual(
      JSON.parse(await evaluate(`window.__editor().getValue()`)),
      JSON.parse(json),
    );
    assert.equal(fs.readFileSync(path.join(root, "data.json"), "utf8"), json);
    await evaluate(`window.__editor().trigger('test','undo',{})`);
    await waitFor(`window.__editor().getValue()===${JSON.stringify(json)}`);
    await clickText("config.xml");
    await waitFor(
      `window.__editor().getModel()?.uri.path.endsWith('config.xml')`,
    );
    await evaluate(
      `document.querySelector('[aria-label="格式化当前文件"]').click()`,
    );
    await waitFor(`window.__editor().getValue().includes('<item />')`);
    await clickText("API 调试");
    await waitFor(`!!document.querySelector('[data-rest-client]')`);
    await input("HTTP 请求地址", "http://127.0.0.1:" + echo.address().port);
    await evaluate(
      `document.querySelector('[aria-label="HTTP 请求方法"]').click()`,
    );
    await waitFor(`!!document.querySelector('[role="option"]')`);
    await evaluate(
      `[...document.querySelectorAll('[role="option"]')].find(node=>node.textContent.trim()==='POST').click()`,
    );
    await input("HTTP 请求体", '{"message":"hello"}');
    await evaluate(`[...document.querySelectorAll('[data-rest-client] button')].find(node=>node.textContent.trim()==='发送').click()`);
    await waitFor(
      `document.querySelector('[data-rest-client]').textContent.includes('200')||!!document.querySelector('[data-rest-client] [role="alert"]')`,
    );
    assert.ok(await evaluate(`document.querySelector('[data-rest-client]').textContent.includes('hello')`), await evaluate(`document.querySelector('[data-rest-client]').textContent`));
    await clickText("代码");
    await clickText("API 调试");
    assert.equal(
      await evaluate(
        `document.querySelector('[aria-label="HTTP 请求体"]').value`,
      ),
      '{"message":"hello"}',
    );
    await clickText("代码");
    await evaluate(
      `window.__confirmCalls=0;window.confirm=()=>{window.__confirmCalls++;return true};document.querySelector('button[title="终端"]').click()`,
    );
    await waitFor(
      `document.querySelectorAll('[data-terminal-tab]').length===1`,
    );
    assert.equal(await evaluate(`window.__confirmCalls`), 0);
    await evaluate(`document.querySelector('[aria-label="新建终端"]').click()`);
    await waitFor(
      `document.querySelectorAll('[data-terminal-tab]').length===2`,
    );
    const ids = await evaluate(
      `[...document.querySelectorAll('[data-terminal-tab]')].map(node=>node.getAttribute('data-terminal-tab'))`,
    );
    assert.notEqual(ids[0], ids[1]);
    assert.equal(await evaluate(`window.__confirmCalls`), 0);
    const headers = {
      Authorization: "Bearer " + api.token,
      "Content-Type": "application/json",
    };
    for (let i = 0; i < 2; i++)
      await fetch(api.origin + "/api/local/terminal/" + ids[i] + "/input", {
        method: "POST",
        headers,
        body: JSON.stringify({ data: "echo WORKSPACE_TERMINAL_" + i + "\r" }),
      });
    for (let i = 0; i < 2; i++) {
      let found = false;
      for (let n = 0; n < 100; n++) {
        const r = await fetch(
          api.origin + "/api/local/terminal/" + ids[i] + "?after=0",
          { headers },
        );
        const body = await r.json();
        if (
          body.chunks?.some((chunk) =>
            chunk.data.includes("WORKSPACE_TERMINAL_" + i),
          )
        ) {
          found = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(found);
    }
    console.log(
      "Workspace tools passed: deep folder state, JSON/XML formatting with undo/no disk writes, REST POST/response/draft preservation, direct terminal opening and two independent shell sessions.",
    );
  } catch (error) {
    code = 1;
    console.error(await window.webContents.executeJavaScript(`document.querySelector('[data-rest-client]')?.textContent?.slice(-2000)`).catch(()=>''));
    console.error(error.stack);
  } finally {
    clearTimeout(deadline);
    window?.destroy();
    await api?.close();
    if (echo) {
      echo.closeAllConnections();
      await new Promise((resolve) => echo.close(resolve));
    }
    fs.rmSync(directory, { recursive: true, force: true });
    app.exit(code);
  }
});
