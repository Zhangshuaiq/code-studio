#!/usr/bin/env node
// Offline CLI fixture: never invokes a real provider or reads user credentials.
const fs = require('node:fs'); const crypto = require('node:crypto');
const args = process.argv.slice(2), codex = args[0] === 'exec';
let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const file = '.fixture-agent-sessions.json';
  const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {sessions:{},runs:[]};
  state.runs.push({args,input});
  const index = args.indexOf(codex ? 'resume' : '--resume'), resumed = index >= 0 ? args[index+1] : null;
  if (resumed && !state.sessions[resumed]) { fs.writeFileSync(file, JSON.stringify(state)); console.log(JSON.stringify({type:'error',message:'session unavailable'})); process.exitCode=2; return; }
  const id = resumed || crypto.randomUUID();
  const token = /Remember token ([\w-]+)/.exec(input)?.[1] || state.sessions[id] || 'none'; state.sessions[id] = token;
  fs.writeFileSync(file, JSON.stringify(state));
  console.log(JSON.stringify(codex ? {type:'thread.started',thread_id:id} : {type:'system',subtype:'init',session_id:id}));
  const text = `remembered:${token}`;
  console.log(JSON.stringify(codex ? {type:'item.completed',item:{type:'agent_message',text}} : {type:'assistant',message:{content:[{type:'text',text}]}}));
  if(!codex) console.log(JSON.stringify({type:'result',session_id:id,result:text}));
});
