// Real React -> real HTTP routes -> real Card/launch stores; terminal and native
// ports are deliberately simulated. This is NOT a real CLI execution test.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {chromium}=require(process.env.AMO_PLAYWRIGHT_MODULE||'C:/Users/Kangaroo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const {createPreview}=require('./task-launch-preview.cjs');
async function main(){
 const host=await createPreview();let browser;const evidence=[],errors=[];let page;
 try{
  browser=await chromium.launch({headless:true,channel:'msedge'});
  const context=await browser.newContext({viewport:{width:760,height:950}});
  await context.route('**/*',route=>new URL(route.request().url()).origin===host.origin?route.continue():route.abort());
  page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(host.origin);
  await page.getByRole('button',{name:'选择工程副本'}).click();await page.getByRole('button',{name:/Unity A/}).click();
  await page.getByRole('button',{name:'展开设置',exact:true}).click();
  const groups=await host.cardStore.listGroups();const groupId=groups.groups[0].groupId;
  await page.getByLabel('加入 Focus 分组').selectOption(groupId);await page.getByLabel('思考强度').selectOption('high');
  await page.getByLabel('启动模型').selectOption('openai-default');
  for(const width of [360,610,760]){await page.setViewportSize({width,height:950});await page.screenshot({path:path.join(host.info.root,`expanded-${width}.png`),fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'expanded horizontal overflow '+width);}
  await page.getByRole('button',{name:'收起设置',exact:true}).click();
  for(const width of [360,610,760]){await page.setViewportSize({width,height:950});await page.screenshot({path:path.join(host.info.root,`compact-${width}.png`),fullPage:true});}
  host.setScenario('early');await page.getByRole('button',{name:'打开 CLI',exact:true}).dblclick();await page.locator('.tl-receipt').waitFor();
  assert.equal(host.calls.length,1,'double click must not dispatch twice');let cards=(await host.cardStore.list()).cards;assert.equal(cards.length,1);assert(cards[0].components.some(c=>c.type==='amo.session'),'early owner claim bound existing Card');const originalId=cards[0].cardId;
  evidence.push('Empty prompt, double click, early SessionStart owner claim, single Card');
  await page.getByRole('button',{name:'再建一个任务'}).click();await page.getByLabel('启动模型').selectOption('dxx-gpt-6-astra');const prompt='请先讨论，不执行\n中文 "quote" `literal` $value; & end';await page.getByLabel('首个问题').fill(prompt);host.setScenario('normal');await page.getByRole('button',{name:'Run',exact:true}).click();await page.locator('.tl-receipt').waitFor();
  await page.waitForFunction(()=>document.querySelector('.tl-receipt')?.textContent?.includes('已接入'),{},{timeout:10000});
  assert.equal(host.calls.length,2);assert.equal(host.calls[1].args.at(-1),prompt,'prompt is one literal argument');cards=(await host.cardStore.list()).cards;assert.equal(cards.length,2);assert(cards.some(c=>c.cardId===originalId));
  for(const width of [360,610,760]){await page.setViewportSize({width,height:950});await page.screenshot({path:path.join(host.info.root,`receipt-${width}.png`),fullPage:true});}
  await page.getByRole('button',{name:'打开对应 CLI'}).click();assert.equal(await page.evaluate(()=>window.__nativeEvents.at(-1).name),'task-launch-open-session');evidence.push('Literal first prompt, delayed owner binding, receipt polling, native command simulated');
  await page.getByRole('button',{name:'查看 Focus',exact:true}).click();await page.getByTestId('focus-panel').waitFor();await page.getByTestId('focus-panel').getByText('请先讨论，不执行',{exact:true}).waitFor();await page.getByRole('button',{name:'返回启动入口',exact:true}).click();await page.locator('.tl-receipt').waitFor();assert.equal(host.calls.length,2);evidence.push('Actual FocusPanelApp displays persisted launched Card; return preserves receipt and does not spawn');
  // Lose a successful HTTP response after committing it: retry must reuse operation.
  await page.getByRole('button',{name:'再建一个任务'}).click();await page.getByLabel('首个问题').fill('lost response');host.setScenario('delayed');let lost=true;
  await page.route('**/api/task-launches',async route=>{if(lost){lost=false;await route.fetch();return route.abort('failed');}return route.continue();});
  await page.getByRole('button',{name:'Run',exact:true}).click();await page.getByRole('button',{name:'核对同一次启动'}).waitFor();await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='核对同一次启动')?.disabled);assert.equal(host.calls.length,3);
  await page.getByRole('button',{name:'核对同一次启动'}).click();await page.locator('.tl-receipt').waitFor();assert.equal(host.calls.length,3);await page.reload();await page.locator('.tl-receipt').waitFor();assert.equal(host.calls.length,3);evidence.push('Committed response loss, explicit retry and browser reload never re-execute');
  const payload={operationId:randomUUID(),workspacePath:host.workspaces[0].workspacePath,groupId,title:'Unknown launch',prompt:'do not retry',codexProvider:{presetId:'openai-default'},reasoningEffort:'medium',launchEnvironment:'windows-powershell',afterLaunch:'amo'};
  host.setScenario('failure');const first=await host.taskLauncher.launch(payload);assert(['unknown','failed'].includes(first.task.state));await host.taskLauncher.launch(payload);assert.equal(host.calls.length,4);evidence.push('Uncertain terminal result is retained and same operation cannot spawn again');
  host.setScenario('not-started');const safe=await host.taskLauncher.launch({...payload,operationId:randomUUID()});assert.equal(safe.task.state,'failed_retryable');host.setScenario('early');const retryId=randomUUID();const retried=await host.taskLauncher.retry(safe.task.cardId,{operationId:retryId});assert.equal(retried.task.cardId,safe.task.cardId);assert.equal(retried.task.state,'connected');await host.taskLauncher.retry(safe.task.cardId,{operationId:retryId});assert.equal(host.calls.length,6);evidence.push('Confirmed not-spawned retry reuses Card, duplicate retry never dispatches again');
  const bad=await fetch(host.origin+'/api/task-launches',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,operationId:randomUUID(),workspacePath:path.join(host.info.root,'missing')})});assert(bad.status>=400);assert.equal(host.calls.length,6);
  await host.cardStore.executeGroups({operationId:randomUUID(),expectedRevision:groups.revision,commands:groups.groups.map(g=>({type:'delete',groupId:g.groupId}))});
  const deleted=await fetch(host.origin+'/api/task-launches',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,operationId:randomUUID()})});assert.equal(deleted.status,409);assert.equal(host.calls.length,6);
  await context.clearCookies();await page.evaluate(()=>localStorage.clear());await page.reload();await page.getByText('还没有 Focus 分组。',{exact:false}).waitFor();assert(await page.getByRole('button',{name:'打开 CLI',exact:true}).isDisabled());evidence.push('Wrong workspace / deleted group prevent dispatch; empty group UI blocks creation');
  assert.deepEqual(errors,[]);assert(fs.existsSync(path.join(host.info.root,'cards.json')));fs.writeFileSync(path.join(host.info.root,'evidence.json'),JSON.stringify({evidence,terminalSimulation:true,nativeSimulation:true,errors},null,2));console.log(JSON.stringify({ok:true,...host.info,evidence},null,2));
 }catch(e){console.error("ARTIFACTS",host.info.root,"ERRORS",errors);console.error(await page?.locator("body").innerText());throw e;}finally{await browser?.close();await host.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1});
